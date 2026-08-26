/**
 * A cross-process lock around token refresh.
 *
 * ## Why this is necessary and not defensive padding
 *
 * The refresh token **rotates**: every successful refresh mints a new one and invalidates the one
 * that was presented. That is fine for a single process — `session.ts` coalesces concurrent
 * refreshes into one in-flight promise — but the store is a file on disk shared by every process
 * that runs this server, and there is normally more than one:
 *
 *   - Claude Code and Claude Desktop each spawn their own `stockbit-mcp`;
 *   - a watch daemon would be a third;
 *   - any CLI invocation is a fourth.
 *
 * Two of them refreshing at once produces a lockout, not a retry. The server issues token2 to the
 * first and token3 to the second, invalidating token2 in the process. Whichever write lands last
 * wins the file — and if that is token2, the store now holds a token the server has already
 * superseded. Every subsequent refresh 401s and the user must log in again by hand.
 *
 * This was observed, not theorised: a stored token issued three minutes earlier, with seven days
 * left on its expiry, was rejected outright.
 *
 * ## Approach
 *
 * The lock mechanism lives in `src/util/dirlock.ts`, shared with the chart-layout and order write
 * paths. What stays here is the policy: **one lock directory per token domain**, and best-effort
 * acquisition — a stale lock from a crashed process is broken rather than wedging the server
 * forever, and failing to acquire is not fatal, because a possible clobber is better than a
 * guaranteed outage.
 *
 * Per domain matters now that there are three (main, securities, e-IPO): a securities refresh
 * queued behind an exodus refresh would serialise two operations that cannot interfere, and
 * `trading-login` would appear to hang for no reason.
 *
 * The lock alone is not the whole fix. `session.ts` also re-reads the store after a failed refresh,
 * since another process may legitimately have rotated the token while this one was waiting.
 */
import { join } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { acquireDirLock } from "../util/dirlock.js";
import { fileDir, getStore, KEYCHAIN_WORST_CASE_MS, type StoreBackend } from "./store.js";
import { RATE } from "../config.js";

/**
 * The longest a holder can legitimately hold this lock — and it depends on the backend.
 *
 * The network part is the same everywhere. `refreshOnce` issues one request bounded by
 * `RATE.requestTimeoutMs`, and a 401 makes it re-read the store and issue a second, inside the same
 * lock, because that retry exists precisely to handle "another process rotated while we were
 * queued". Two full request timeouts.
 *
 * The credential part is not. On the **file** backend a read is a decrypt and a write is an
 * fsync-and-rename: microseconds, and no cushion buys anything. On the **Keychain** backend every
 * one of those is a `security` subprocess that can raise a dialog nobody answers, and there are
 * several under one lock — the pre-check read, the read inside `refreshOnce`, the 401 re-read, the
 * retry's read, and `persistRotated`'s write, which is itself up to three invocations and retries
 * once. Sizing against `persistRotated` alone was still short: a traced 401-retry path reaches
 * about ninety seconds of *legitimate* work, and the first attempt at this allowed eighty.
 *
 * So the allowance is per backend, and the file backend goes back to exactly what it had. That
 * matters beyond tidiness: the staleness threshold is also how long a caller waits before it may
 * break the lock a SIGKILLed process left behind, and making Linux and Windows wait out a
 * macOS-only hazard is a real cost for no benefit.
 *
 * **The size of the Keychain allowance is a judgement between two bad outcomes, and it is worth
 * being explicit that it cannot be made to satisfy both.** Too small and a healthy holder whose
 * Keychain is prompting gets broken as stale, and two processes rotate — a forced re-login. Too
 * large and the first caller after a process is SIGKILLed mid-refresh waits that long before it may
 * break the lock. Four writes' worth is the compromise: it covers the realistic path (a handful of
 * reads and one write with its retry) rather than the pathological one where every single `security`
 * invocation hangs for its full timeout. What it replaces is not a shorter wait — it is a lock that
 * could never be broken at all, because the old acquisition timeout was shorter than the old
 * staleness threshold.
 *
 * `test/reflock.test.ts` asserts these against literals, not against the same expression — a test
 * that recomputes the formula agrees with the constant rather than with what the lock holds.
 */
const KEYCHAIN_ALLOWANCE_MS = 4 * KEYCHAIN_WORST_CASE_MS;

/**
 * Split from `worstCaseHoldMs` so the Keychain figures can be ASSERTED.
 *
 * They were not. Every test in this repo sets `STOCKBIT_FORCE_FILE_STORE=1` before its imports —
 * it has to, the suite is offline — so `getStore(...).backend` is never `"keychain"` under test and
 * the whole Keychain branch was dead code as far as the suite was concerned. The allowance could be
 * doubled, or deleted, and 1291 tests stayed green. A comment claiming the numbers were pinned is
 * not the same as pinning them, and this is the second time that distinction has cost something in
 * this file.
 *
 * Taking the backend as an argument rather than reading it makes both branches reachable from an
 * offline test, against literals.
 */
export function worstCaseHoldMsFor(backend: StoreBackend): number {
  const network = 2 * RATE.requestTimeoutMs;
  return backend === "keychain" ? network + KEYCHAIN_ALLOWANCE_MS : network;
}

/** As `staleMsFor`, by backend rather than by domain. */
export function staleMsForBackend(backend: StoreBackend): number {
  return worstCaseHoldMsFor(backend) + 10_000;
}

/** As `refreshLockTimeoutMsFor`, by backend rather than by domain. */
export function refreshLockTimeoutMsForBackend(backend: StoreBackend): number {
  return staleMsForBackend(backend) + 5_000;
}

function worstCaseHoldMs(domain: LockDomain): number {
  return worstCaseHoldMsFor(getStore(domain).backend);
}

/**
 * A lock older than this belongs to a process that died holding it.
 *
 * It must exceed the worst legitimate hold. It was 30_000 against a 40_000 worst case — the wrong
 * side of that line — so a slow but entirely healthy holder had its lock broken out from under it
 * and the double rotation this module exists to prevent happened anyway. Raising the acquisition
 * timeout without raising this one fixes half the bug and looks like it fixed all of it.
 */
export function staleMsFor(domain: LockDomain): number {
  return worstCaseHoldMs(domain) + 10_000;
}

/**
 * How long a caller waits for the lock before giving up.
 *
 * It must exceed the staleness threshold, not merely the worst hold. `acquireDirLock` only breaks a
 * stale lock *while it is still waiting*, so a waiter whose timeout is shorter than `staleMs` can
 * never break one — it gives up first, and so does the next caller, and the lock a crashed process
 * left behind wedges every refresh until someone deletes it by hand. The old pair (wait 10 s, stale
 * at 30 s) had exactly that hole.
 */
export function refreshLockTimeoutMsFor(domain: LockDomain): number {
  return staleMsFor(domain) + 5_000;
}

/** The file-backend figures, which is what every test and every non-macOS install sees. */
export const STALE_MS = 2 * RATE.requestTimeoutMs + 10_000;
export const REFRESH_LOCK_TIMEOUT_MS = STALE_MS + 5_000;

const POLL_MS = 120;

/** Lock names by token domain. `main` keeps its historical name so an in-flight lock survives an upgrade. */
const LOCK_NAMES = {
  main: "refresh.lock",
  securities: "securities-refresh.lock",
  eipo: "eipo-refresh.lock",
} as const;

/** The token domains that hold their own refresh lock. Mirrors `TokenDomain` in `session.ts`. */
export type LockDomain = keyof typeof LOCK_NAMES;

/**
 * Where a domain's lock directory lives — which depends on the backend, and has to.
 *
 * **File backend:** beside the credential it guards, as before. Both move with `STOCKBIT_STORE_DIR`,
 * so two clients pointed at different store dirs hold *different credentials* and correctly take
 * different locks. Every `STOCKBIT_FORCE_FILE_STORE=1` test is on this path and is unaffected by
 * anything below.
 *
 * **Keychain backend:** the macOS login Keychain is per-user and machine-global. It does not move
 * with `STOCKBIT_STORE_DIR` at all. A lock resolved under the store dir therefore let two clients
 * configured with different store dirs take DIFFERENT locks over the SAME credential — which is no
 * lock, and the failure it allows is the one this module exists to prevent.
 *
 * The known limit, stated rather than hidden: this resolves through `os.tmpdir()`, so two processes
 * that disagree about `$TMPDIR` still take different locks. Every client that matters inherits the
 * user's — Claude Code, Claude Desktop, a daemon, a terminal — and it is strictly narrower than the
 * hole it replaces. A path under `~` was considered and rejected: a lock directory there can be
 * mirrored by a file-sync client, and `mkdir` atomicity on a synced or network home directory is
 * not something anyone has promised.
 */
function lockPath(domain: LockDomain): string {
  if (getStore(domain).backend !== "keychain") return join(fileDir(), LOCK_NAMES[domain]);
  // Sanitised because a username reaches a path here. On darwin it will not contain a separator,
  // but this is not the place to depend on that.
  const user = userInfo().username.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(tmpdir(), `stockbit-mcp-locks-${user}`, LOCK_NAMES[domain]);
}

/**
 * Try to take a domain's refresh lock, waiting up to `timeoutMs`.
 *
 * Returns a release function, or null if the lock could not be taken. A null return is not an
 * error: the caller refreshes anyway, accepting the small clobber risk rather than failing.
 */
export async function acquireRefreshLock(
  timeoutMs?: number,
  domain: LockDomain = "main",
): Promise<(() => void) | null> {
  return acquireDirLock(lockPath(domain), {
    staleMs: staleMsFor(domain),
    timeoutMs: timeoutMs ?? refreshLockTimeoutMsFor(domain),
    pollMs: POLL_MS,
  });
}

/**
 * Run `fn` holding a slot's credential lock.
 *
 * The refresh path was never the only writer. `bootstrap`, `trading-login`, the e-IPO mint and
 * every `logout` also write or clear a credential, and none of them took the lock — so a
 * `bootstrap` landing while another process was mid-refresh could be overwritten by that rotation,
 * or overwrite it. The consequence is identical to the one the lock was built for: whichever write
 * lands last wins the file, and if it is the older token, every later refresh 401s.
 *
 * The failure policy is `doRefresh`'s, deliberately: **a null lock proceeds anyway.** For every
 * caller of this helper the alternative is refusing to do the thing the user just asked for —
 * refusing to store a token they pasted, refusing to log out — and a possible clobber is better
 * than that.
 *
 * Two writers are deliberately NOT on this helper, and both are load-bearing:
 *
 *   - the login capture in `login.ts` — an interactive re-login intentionally supersedes whatever
 *     was stored, and making that path async would let the capture promise settle before the write
 *     landed;
 *   - `syncStoreFromBrowser`, whose alternative *is* safe — the browser still holds a working token
 *     — so it takes the lock itself and treats a null as a no-op rather than as permission.
 */
export async function withCredentialLock<T>(
  slot: LockDomain,
  fn: () => T | Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const release = await acquireRefreshLock(timeoutMs, slot);
  try {
    return await fn();
  } finally {
    release?.();
  }
}
