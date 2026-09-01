/**
 * Automatic login recovery — one gated, unattended attempt to replace a dead credential.
 *
 * ## What was missing
 *
 * Every signal already existed and not one of them acted. `session-health.json` records refusals,
 * `status` computes `main.health: "failing"` and `webSession.rejected`, and a 401 becomes a good
 * error message at the call site. All three are REPORTS. When the session died mid-task the user
 * still had to notice, read, and re-run the login themselves — twice in one session.
 *
 * The recipe this implements was confirmed on the wire: when the API token is dead but the BROWSER
 * session is still alive, a forced login harvests a working credential out of the profile that is
 * already signed in, in about three seconds, with nobody typing anything.
 *
 * ## A harvest is not silent, and the brief's wording hides that
 *
 * "No browser interaction" is true. "No browser window" is not. `captureViaBrowserLogin` always
 * calls `launchDebuggableBrowser`; `CaptureOptions` has no headless option, and headless is measured
 * to be blanked by Cloudflare on stockbit.com. A window opens, does its work and closes. So the
 * "never open a browser window silently" rule governs THIS path, not merely the escalation — which
 * is the whole reason the gates below exist rather than a single liveness check.
 *
 * ## Three gates, every one required, all default to off
 *
 * 1. **Armed.** Only `bin/stockbit-mcp.ts` calls `armAutoRelogin()`. This is how "never auto-relogin
 *    inside `stockbit-batch`" is enforced: batch reaches `forceRefresh` through the same
 *    `src/http/client.ts` as everything else, and there is no run-mode marker anywhere in this repo,
 *    so the only version of "off in batch" that cannot be got wrong later is a switch the batch
 *    process never touches. A nine-hour unattended backfill must fail fast, which it already does.
 * 2. **Opted in.** `STOCKBIT_AUTO_RELOGIN`, parsed truthily.
 * 3. **Not suppressed.** `STOCKBIT_NO_BROWSER` still wins over everything here.
 *
 * On the env var, honestly: `settings.ts` argues that no environment variable should RAISE a
 * permission — `STOCKBIT_TRADING` can only lower the trading mode, on the reasoning that "a variable
 * is the easiest thing in a process tree to set by accident, and an accident that disables trading is
 * harmless while the reverse is not." This is the first that raises one, and ADR-0011 records the
 * trade. What keeps it defensible is that it grants nothing on its own: the process must also be
 * armed, unsuppressed, holding a provably live web session, asking for the `main` slot, and on its
 * first attempt. The value is parsed the way `browserSuppressed` parses its own — accept-set, never
 * `=== "1"` — because Claude Desktop substitutes a ticked boolean setting as the string `"true"`.
 *
 * Elicitation is deliberately not the gate. It lives on the `Definer`, in the tool layer; a 401
 * raised inside `getBars` has no definer in scope. A switch is what is available at this depth.
 *
 * ## Exactly one attempt, and the reason it is mechanical rather than a policy
 *
 * Refresh tokens rotate and are single-use. Worse, the PROOF that a harvested credential works is
 * itself a refresh, and rotation stales the browser web session the harvest reads. So attempt *n+1*
 * is guaranteed to start from a worse state than attempt *n*: looping does not merely spend tokens,
 * it destroys the thing recovery depends on. The latch is per process and per domain, and it is set
 * BEFORE the attempt runs, so a throw consumes it too.
 */
import { browserSuppressed } from "../desktop/browser.js";
import { redact } from "../redact.js";
import { acquireDirLock } from "../util/dirlock.js";
import { stockbitPath } from "../paths.js";
import type { TokenDomain } from "../http/transport.js";
import { getStore, type StoreSlot } from "./store.js";
import { webSessionHealth } from "./websession.js";

/**
 * Budget for the unattended CAPTURE — not for the whole operation, and the difference matters.
 *
 * `captureViaBrowserLogin` arms this timer only once the browser is up, and the launch has its own
 * 30 s ceiling before that, with a flush-and-close after. So the real worst case a blocked tool call
 * can see is roughly `30 s launch + this + ~14 s teardown`, and `login.lock` is held for all of it.
 * Calling this a ceiling on the operation — as an earlier version of this comment did — understated
 * the wait by a factor of two.
 *
 * 30 s, then, not the 900 s a person gets: nobody is typing. This either reads the cookie out of an
 * already-signed-in profile within seconds, or it is the case a human has to handle, and waiting
 * longer only makes a failed recovery more expensive than the failure it was trying to repair.
 */
export const UNATTENDED_TIMEOUT_MS = 30_000;

/**
 * Staleness budget for `login.lock`, matching the one `src/tools/system.ts` uses on the same file.
 *
 * Deliberately duplicated rather than imported: nothing under `src/auth/` may depend on
 * `src/tools/`, and the value belongs to the LOCK, which both paths now take.
 */
const LOGIN_LOCK_STALE_MS = 20 * 60_000;

export type ReloginOutcome =
  /** This process never armed recovery — the CLI, the batch backfill, a test. */
  | "disarmed"
  /** `STOCKBIT_AUTO_RELOGIN` is unset, or set to something in the off-set. */
  | "not-opted-in"
  /** `STOCKBIT_NO_BROWSER` is set. */
  | "browser-suppressed"
  /** Only the market-data slot may be filled by a harvest. */
  | "wrong-domain"
  /** The one attempt was made, and it did NOT work. */
  | "already-attempted"
  /** The one attempt was made and it WORKED. Nothing here is a diagnosis of a broken session. */
  | "already-recovered"
  /** An attempt is in flight in this process. Nothing is known yet, so nothing is claimed. */
  | "recovery-in-flight"
  /** The browser session is not PROVABLY alive, so a harvest has nothing to read. */
  | "no-web-session"
  /** A login already holds the profile lock. Recovery stands aside rather than racing it. */
  | "login-in-progress"
  /** A window opened and came back with nothing usable. A human is needed. */
  | "harvest-failed"
  /** A new credential is in the store. It is NOT yet proven — the caller's retry proves it. */
  | "harvested";

export interface ReloginAttempt {
  /** Whether a browser was actually opened. False for every gate refusal. */
  attempted: boolean;
  outcome: ReloginOutcome;
  /** One sentence for a human or a model. Never carries a token or a command line. */
  detail: string;
}

/**
 * Injected for tests.
 *
 * `capture` defaults to a dynamic import of `login.ts`, because `login.ts` imports `session.ts` at
 * module scope and `session.ts` is what calls into here — a static import would close the cycle.
 * `session.ts` already uses exactly this workaround for `recoverFromStoredWebSession`, and it is
 * paid only on a 401. `websession.ts` has no such problem and is imported normally.
 */
export interface ReloginDeps {
  /** Is the stored browser session provably alive? */
  webSessionLikelyValid?: () => boolean;
  /** Run the capture. Resolves with whether a credential was stored. */
  capture?: () => Promise<{ captured: boolean; method?: string }>;
  /** The refresh token currently in the slot, to prove the store actually moved. */
  storedRefresh?: (slot: StoreSlot) => string | null;
}

/** Armed only by the MCP server entrypoint. Everything else — batch, CLI, tests — stays disarmed. */
let armed = false;

/**
 * One attempt per domain per process. Never a budget, never a backoff.
 *
 * A Map, not a Set, and the value is load-bearing. "An attempt was made" and "an attempt failed" are
 * different facts, and conflating them made a later failure say `did not fix it` about a recovery
 * that HAD fixed it hours earlier — and then recommend signing the user out of Stockbit on the
 * strength of a website-session reading taken before the harvest that replaced it.
 */
const spent = new Map<TokenDomain, "harvested" | "failed">();

export function armAutoRelogin(): void {
  armed = true;
}

export function autoReloginArmed(): boolean {
  return armed;
}

/**
 * Truthy in the same shape `browserSuppressed` accepts, and for the same measured reason: a client
 * that substitutes a ticked checkbox as `"true"` must not be read as "off" by an `=== "1"` test.
 */
export function autoReloginOptedIn(): boolean {
  const raw = process.env.STOCKBIT_AUTO_RELOGIN?.trim().toLowerCase();
  if (raw === undefined || raw === "") return false;
  return !["0", "false", "no", "off"].includes(raw);
}

/** Whether recovery COULD run, ignoring the per-domain latch. For `status` to report. */
export function autoReloginAvailable(): boolean {
  return armed && autoReloginOptedIn() && !browserSuppressed();
}

/**
 * Whether a recovery is opening a window RIGHT NOW.
 *
 * Separate from `loginStatus().inProgress`, which cannot say who started the login. `login` needs
 * the difference: telling someone to go and type into a window that closes itself in thirty seconds
 * is worse advice than none.
 */
let running = false;

export function autoReloginRunning(): boolean {
  return running;
}

/**
 * The caller's proof refused the harvested credential after all — record the attempt as a FAILURE.
 *
 * `attemptAutoRelogin` can only report what the HARVEST did. Whether the credential actually works
 * is settled one frame up, by the caller's retry, and that is deliberate: nothing here may claim a
 * credential is good, because nothing here has asked Stockbit.
 *
 * Without this the latch would remember a harvest that was then refused as `harvested`, and the next
 * failure in the process would be told recovery "worked" — the same false-history defect as before,
 * arriving through the other door.
 */
export function recordAutoReloginRefused(domain: TokenDomain): void {
  // Only ever downgrades, and only for a domain that actually made an attempt. It must never CREATE
  // a latch entry: that would let a proof failure spend an attempt recovery never made.
  if (spent.has(domain)) spent.set(domain, "failed");
}

/** Whether this domain has already spent its one attempt in this process. */
export function autoReloginSpent(domain: TokenDomain): boolean {
  return spent.has(domain);
}

/** Test seam, in the shape `resetSession` already established for module-level auth state. */
export function resetAutoReloginForTests(): void {
  armed = false;
  running = false;
  spent.clear();
}

/**
 * Try once to replace a dead credential from the live browser session.
 *
 * Returns a verdict rather than throwing: every caller is already on a failure path, and a recovery
 * that can raise would replace the 401 the user needs to see with an error about recovery.
 *
 * A `"harvested"` result means a new credential is in the store — NOT that it works. Nothing logged
 * in, so its expiry says nothing about whether Stockbit will accept it; four harvested credentials
 * in a row were rejected on first use while login, doctor and status all reported healthy. Proving
 * it is the caller's job, and the caller's retry is the proof.
 */
export async function attemptAutoRelogin(
  domain: TokenDomain,
  deps: ReloginDeps = {},
): Promise<ReloginAttempt> {
  if (!armed) {
    return {
      attempted: false,
      outcome: "disarmed",
      detail:
        "Automatic login recovery is not armed in this process. Only the MCP server arms it; the " +
        "batch backfill and the terminal commands deliberately fail fast instead.",
    };
  }
  if (!autoReloginOptedIn()) {
    return {
      attempted: false,
      outcome: "not-opted-in",
      detail:
        "Automatic login recovery is off. Set STOCKBIT_AUTO_RELOGIN=1 in this server's environment " +
        "to let it re-open the browser by itself when the session dies.",
    };
  }
  if (browserSuppressed()) {
    return {
      attempted: false,
      outcome: "browser-suppressed",
      detail:
        `STOCKBIT_NO_BROWSER=${process.env.STOCKBIT_NO_BROWSER} is set, so no window may be opened — ` +
        "including this one.",
    };
  }
  if (domain !== "main") {
    return {
      attempted: false,
      outcome: "wrong-domain",
      detail:
        `Only the market-data session can be recovered from the browser; \`${domain}\` cannot. A ` +
        "harvest that filled another slot once stored a market-data token as a trading credential " +
        "and reported success.",
    };
  }
  // An attempt is in flight RIGHT NOW, and this is not a narrow race.
  //
  // A dead session 401s every request that is already on the wire, and the client runs three at a
  // time, so the second and third failures of one session death land inside this window by
  // construction — a window as long as the whole capture. The latch alone cannot tell them apart
  // from a finished failure: it is set to `failed` provisionally the moment an attempt starts.
  // Reading it without this check told a concurrent caller that recovery "already ran and did not
  // fix it", and recommended signing the user out of Stockbit, while the recovery it was describing
  // went on to succeed.
  //
  // Nothing is claimed here, because nothing is known yet.
  if (running) {
    return {
      attempted: false,
      outcome: "recovery-in-flight",
      detail:
        "Automatic recovery is running right now in this process and has not finished. Nothing is " +
        "known about whether it worked yet — retry in a moment.",
    };
  }

  const previous = spent.get(domain);
  if (previous !== undefined) {
    // WHY it does not try again is the same either way. WHAT it is reporting is not: a recovery that
    // WORKED and one that failed are different facts, and the caller turns this into advice.
    const because =
      "It does not try again: the proof rotates the token, and rotation stales the browser session " +
      "the next attempt would read from, so a second try starts from a worse position than the first.";
    return previous === "harvested"
      ? {
          attempted: false,
          outcome: "already-recovered",
          detail: `Automatic recovery already ran once in this process and it worked. ${because}`,
        }
      : {
          attempted: false,
          outcome: "already-attempted",
          detail: `Automatic recovery already ran once in this process and did not fix it. ${because}`,
        };
  }

  // Require the POSITIVE verdict. Never `!expired` and never `!likelyValid`: those are not
  // complements — `!likelyValid` is also true for "unknown", where the credential simply could not
  // be read — and gating on the negative is what made an earlier check demand a fresh login every
  // day on a session with six days left.
  //
  // This is a GATE, and gates run BEFORE the latch. Nothing has been opened, nothing rotated,
  // nothing written, so there is no attempt to have spent. Burning it here would disable recovery
  // for the rest of the process on the strength of one unreadable read — and `status` would then
  // report "already used its one attempt" for a process that never made one.
  const alive = deps.webSessionLikelyValid ?? (() => webSessionHealth().likelyValid === true);
  if (!alive()) {
    return {
      attempted: false,
      outcome: "no-web-session",
      detail:
        "The browser session is not provably alive either, so there is nothing to harvest a new " +
        "token from. This one needs a person.",
    };
  }

  const slot: StoreSlot = "main";
  const readRefresh = deps.storedRefresh ?? ((s: StoreSlot) => getStore(s).get());

  // Resolved BEFORE the lock is taken, deliberately. Everything between acquiring the lock and
  // entering the `try` that releases it is a chance to leak the lock for the full twenty-minute
  // staleness window — blocking every `login` and every later recovery — and a dynamic import can
  // reject. Nothing may sit in that gap.
  //
  // Dynamic at all because `status.ts` imports the gate readers from this module; a static edge back
  // would close the cycle.
  const { loginStarted, loginFinished } = await import("../status.js");

  // The same lock `login` takes, and the last gate before the latch.
  //
  // Without it the two paths drive one browser profile blind to each other. Someone signing in has a
  // window open and fifteen minutes to type; a background 401 would launch into that same profile,
  // hand off to their window and exit — and in the other direction a `login` during a recovery opens
  // a SECOND browser on one profile, which is the condition that produces the orphaned processes
  // this phase also has to clean up.
  //
  // `timeoutMs: 0` — never queue. A recovery that waits is a tool call that hangs, and by the time a
  // person has finished signing in there is nothing left to recover.
  const release = deps.capture
    ? () => {}
    : await acquireDirLock(stockbitPath("login.lock"), { staleMs: LOGIN_LOCK_STALE_MS, timeoutMs: 0 });
  if (!release) {
    return {
      attempted: false,
      outcome: "login-in-progress",
      detail:
        "A login is already running — a lock is held on the browser profile. Automatic recovery " +
        "stood aside rather than opening a second window on the same profile.",
    };
  }

  // Here: past every gate, immediately before the first thing that can change the world. A throw
  // below must still consume the attempt — otherwise a browser that consistently fails to start
  // becomes the loop this whole module exists to prevent.
  // Provisionally a FAILURE. The real outcome is written in the `finally`, and starting from
  // `failed` is the safe direction: if anything below escapes without settling, the next caller is
  // told an attempt failed rather than told one succeeded.
  spent.set(domain, "failed");

  // Recovery is a login, so it must show up as one. Without this, `status` reported no login in
  // progress while a window was open on the user's screen, and `login`'s own lock refusal blamed
  // "probably a terminal or a second client" for a lock this very server was holding. A status that
  // is confidently wrong about what the machine is doing is worse than one that says nothing.
  loginStarted();
  running = true;

  // Recorded so the `finally` can close the login it opened with the outcome that actually
  // happened, rather than a guess. Assigned on every exit from the block below.
  let settled: ReloginAttempt | null = null;
  const settle = (a: ReloginAttempt): ReloginAttempt => {
    settled = a;
    return a;
  };

  try {
    const before = readRefresh(slot);

    const capture =
      deps.capture ??
      (async () => {
        const { captureViaBrowserLogin } = await import("./login.js");
        return captureViaBrowserLogin({
          quiet: true,
          slot,
          timeoutMs: UNATTENDED_TIMEOUT_MS,
          // NEVER here, and the reason is worth spelling out because the opposite looks reasonable.
          //
          // Reaping was going to be on: nobody is present to close a stuck window. But the failure
          // it keys on — "the browser exited immediately without opening a debugging port" — does
          // NOT mean the holder is dead. Each launch picks a fresh random debugging port and polls
          // only that one, so a perfectly healthy browser answering its OWN port still causes the
          // new child to hand off and exit. That is exactly what the Chartbit driver leaves running
          // between calls, on this very profile, by design.
          //
          // So an unattended reap here would SIGKILL the chart the user is looking at, 1.5 seconds
          // after asking it politely, with no human in the loop and nothing having gone wrong. This
          // server does not get to end a browser session nobody asked it to touch. Clearing orphans
          // stays an explicit request — `login { reap_orphans: true }` — where a person has read
          // what it does and decided.
          reapOrphans: false,
          // Never `switchAccount` here. It clears the Stockbit session before the first navigation,
          // which destroys the very `credentialStorage` cookie this harvest is trying to read — and
          // signs the user out of that profile. It is the ESCALATION, and escalation is a person's
          // decision.
          switchAccount: false,
        });
      });

    const result = await capture();
    if (!result.captured) {
      return settle({
        attempted: true,
        outcome: "harvest-failed",
        detail: "A browser opened but no usable credential came back from it.",
      });
    }

    // Confirm the store actually moved. "Captured" with an unchanged store is issue #3 in a new
    // place — success reported for a credential nothing wrote — and it would send the retry
    // straight back into the same dead token.
    const after = readRefresh(slot);
    if (after === null || after === before) {
      return settle({
        attempted: true,
        outcome: "harvest-failed",
        detail: "A browser opened and reported a capture, but the stored credential did not change.",
      });
    }

    return settle({
      attempted: true,
      outcome: "harvested",
      detail:
        "Harvested a fresh credential from the browser session. It has not been proven yet — the " +
        "retry that follows is the proof.",
    });
  } catch (err) {
    // Redacted at the boundary: a capture failure can quote a URL, and a URL here can carry a token.
    return settle({
      attempted: true,
      outcome: "harvest-failed",
      detail: `Automatic recovery failed: ${String(redact(err instanceof Error ? err.message : String(err)))}`,
    });
  } finally {
    // Close the login this opened, whatever happened. `harvested` is deliberately NOT reported as
    // `captured`: nothing has proven it yet, and `captured` is the word this project reserves for a
    // credential Stockbit has accepted.
    const outcome = (settled as ReloginAttempt | null)?.outcome ?? "error";
    // The history the NEXT failure is told about. Only a harvest counts as having worked — and even
    // that says `harvested`, not `captured`: the proof is the caller's retry, not anything here.
    spent.set(domain, outcome === "harvested" ? "harvested" : "failed");
    running = false;
    loginFinished(`auto-recovery: ${outcome}`);
    // Unconditionally. A lock held past a failure blocks every later login, including the human's,
    // for the whole twenty-minute staleness window — which is a worse outage than the one recovery
    // was trying to repair.
    release();
  }
}
