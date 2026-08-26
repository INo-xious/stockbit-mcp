/**
 * The three tools that are about this server rather than about the market.
 *
 * `status` answers "is this working, and what do I run"; `login` opens a browser so the user can
 * sign in without leaving the client; `logout` clears what was stored. ADR-0007 records why the
 * last two are tools at all, and the two things that stay at a terminal on purpose: the six-digit
 * PIN and the trading switch.
 *
 * ## Why `login` returns before the login finishes
 *
 * A browser login takes as long as a person takes — reading a password manager, doing 2FA, giving
 * up and starting again. Every MCP client has a tool-call timeout, and none of them is measured in
 * minutes. A blocking call would time out on the client while the browser sat waiting, and the user
 * would be told it failed while it was working.
 *
 * So the tool starts the capture, returns within a couple of seconds, and `status` is the poll.
 * That costs one thing and it is stated in the result: a server restarted mid-login abandons the
 * capture, and nothing is stored.
 *
 * ## Gates
 *
 * `login` launches a visible browser window on the user's machine, and `logout` destroys
 * credentials. Neither is something a model should be able to do because it seemed helpful:
 *
 *   - `confirm: true` — the caller states the user agreed.
 *   - elicitation, where the client supports it — the user themselves clicks yes.
 *   - `STOCKBIT_NO_BROWSER` set to anything but 0/false/no/off refuses outright and names the
 *     terminal command instead. A headless
 *     box, a CI runner and a locked-down desktop all set it, and all of them mean "not from here".
 *   - a directory lock, so two logins cannot fight over one browser profile.
 *
 * ## The invariant
 *
 * **No result from any tool here ever carries a token.** Every return value goes through
 * `redactValue`, and `test/system.test.ts` asserts that nothing JWT-shaped survives into the
 * serialised output of any of them.
 */
import { existsSync } from "node:fs";
import { z } from "zod";
import { jsonResult, runTool } from "./_format.js";
import type { Definer } from "./_define.js";
import { collectStatus, loginFinished, loginStarted, loginStatus } from "../status.js";
import { captureViaBrowserLogin, findBrowser, findBrowsers } from "../auth/login.js";
import { clearBrowserProfile, readBrowserProfile } from "../auth/browserprofile.js";
import { defaultProfileDir } from "../auth/login.js";
import { removeDirWithRetry } from "../auth/tempdir.js";
import { getStore, type StoreSlot } from "../auth/store.js";
import { withCredentialLock } from "../auth/reflock.js";
import { hasStoredSession, resetSession } from "../auth/session.js";
import { logoutSecurities } from "../auth/tradinglogin.js";
import { acquireDirLock } from "../util/dirlock.js";
import { stockbitPath } from "../paths.js";
import { redactValue } from "../redact.js";
import { browserSuppressed } from "../desktop/browser.js";

/** How long the login lock is held before it is assumed to belong to a dead process. */
const LOGIN_LOCK_STALE_MS = 20 * 60_000;

/** The terminal fallback, quoted verbatim wherever a tool refuses to open a browser. */
const CLI_LOGIN = "npx -y -p stockbit-mcp stockbit-auth login";

export interface SystemToolOptions {
  /** How many tools this server registered, for the status report. */
  toolCount?: number;
  /** What the active tool profile is called. */
  profileLabel?: string;
}

export function registerSystemTools(define: Definer, options: SystemToolOptions = {}): void {
  define.read(
    "status",
    "Is this server working, and what do I run if it is not? Call this FIRST whenever anything " +
      "looks wrong, and call it after logging in to confirm it took.\n" +
      "Reports the version and Node, which of the three sessions are stored (NEVER the tokens " +
      "themselves), how long the stored market-data token claims it has left, the trading mode and " +
      "why, the IDX session clock in WIB, and a `nextStep` naming the single next command.\n" +
      "It answers with no session at all — that is the state every new user is in, and the answer " +
      "is the useful one.\n" +
      "`live: true` additionally refreshes the market-data token against Stockbit (one request) to " +
      "prove it still works. Without it, `expiresInDays` is a claim from the token's payload, not " +
      "evidence: a revoked token keeps its expiry.\n" +
      "The `market` block does not model public holidays; call `market_session` for that.",
    {
      live: z
        .boolean()
        .optional()
        .describe("Also refresh the market-data token to prove it works. One request. Default false."),
    },
    async (a) =>
      runTool(async () =>
        collectStatus({
          live: a.live === true,
          toolCount: options.toolCount,
          profileLabel: options.profileLabel,
        }),
      ),
  );

  define.write(
    "login",
    "Open a browser window so the user can sign in to Stockbit. Nothing else here works until they " +
      "have.\n" +
      "ASK THE USER FIRST, then call with `confirm: true`. This opens a real, visible window on " +
      "their machine; where the client supports elicitation they are also asked directly.\n" +
      "It returns in about a second, BEFORE the login finishes — a person takes minutes and every " +
      "client has a tool-call timeout. Tell them to sign in in the window that opened, then call " +
      "`status` to see whether it worked. Do not call this again while `status` says a login is in " +
      "progress.\n" +
      "The captured token goes straight to the keychain (or the encrypted file store off macOS). It " +
      "is never returned here and never shown to you.\n" +
      "If the browser is ALREADY signed in to Stockbit, it no longer waits fifteen minutes for a " +
      "form that will never appear: it reads the credential out of the browser's own session and " +
      "finishes in seconds, and if there is nothing usable there it signs that profile out and " +
      "re-opens the login page.\n" +
      "`switch_account: true` is for signing in as a DIFFERENT account — it clears the browser's " +
      "Stockbit session first and never reuses what was there. Ask the user before using it; it " +
      "signs them out of Stockbit in that browser profile.\n" +
      "Refuses when STOCKBIT_NO_BROWSER is set (to anything but 0/false/no/off), and names the "
      + "terminal command instead. It also refuses " +
      "if a session is already stored, unless `force: true` (which `switch_account` implies).\n" +
      "This does NOT log in to the trading account: that needs a 6-digit PIN typed at the user's own " +
      "terminal via `stockbit-auth trading-login`, and no tool here accepts a PIN.",
    {
      confirm: z.boolean().describe("Must be true, and only after asking the user in words."),
      force: z.boolean().optional().describe("Log in again even though a session is already stored."),
      fresh_profile: z
        .boolean()
        .optional()
        .describe(
          "Use a throwaway browser profile instead of the saved one — nothing carried over, so the " +
            "user re-enters password and OTP. For a profile that is corrupt or held open by another " +
            "process. To sign in as a different account, use switch_account instead.",
        ),
      switch_account: z
        .boolean()
        .optional()
        .describe(
          "Sign the current Stockbit account OUT of the browser profile first, then show a real " +
            "login form. For logging in as someone else. Implies force.",
        ),
    },
    async (a) =>
      startLogin(define, {
        confirm: a.confirm === true,
        // switch_account is an instruction to replace the stored session, so it cannot be blocked
        // by "a session is already stored" — that refusal is the whole thing it is asking to undo.
        force: a.force === true || a.switch_account === true,
        fresh: a.fresh_profile === true,
        switchAccount: a.switch_account === true,
      }),
    { destructiveHint: false, idempotentHint: true, evidence: "observed" },
  );

  define.write(
    "logout",
    "Clear stored Stockbit credentials from this machine.\n" +
      "ASK THE USER FIRST, then call with `confirm: true`. There is no undo: logging back in means " +
      "signing in again in a browser (and, for the trading session, re-entering the 6-digit PIN at " +
      "a terminal).\n" +
      "`scope` picks what to clear — `main` (market data), `trading` (the securities session, which " +
      "is also ended at Stockbit's end), `eipo`, or `all` (the default).\n" +
      "`remove_browser_profile: true` also deletes the saved browser profile. That profile is a " +
      "SECOND copy of the session — it holds Stockbit cookies — so on a shared or lost machine, " +
      "clearing the token without it is not really logging out.",
    {
      confirm: z.boolean().describe("Must be true, and only after asking the user in words."),
      scope: z
        .enum(["main", "trading", "eipo", "all"])
        .optional()
        .describe("What to clear. Default `all`."),
      remove_browser_profile: z
        .boolean()
        .optional()
        .describe("Also delete the saved browser profile, which holds Stockbit cookies. Default false."),
    },
    async (a) =>
      doLogout({
        confirm: a.confirm === true,
        scope: (a.scope as LogoutScope | undefined) ?? "all",
        removeProfile: a.remove_browser_profile === true,
      }),
    { destructiveHint: true, idempotentHint: true, evidence: "observed" },
  );
}

/* ------------------------------------- login ------------------------------------- */

interface LoginRequest {
  confirm: boolean;
  force: boolean;
  fresh: boolean;
  /** Clear the browser's Stockbit session first, and never reuse what was there. */
  switchAccount: boolean;
}

/** A refusal is a normal answer here, not an exception: it always says what to do instead. */
function refusal(reason: string, nextStep: string): ReturnType<typeof jsonResult> {
  return jsonResult({ started: false, reason, nextStep }, true);
}

async function startLogin(define: Definer, request: LoginRequest) {
  if (browserSuppressed()) {
    return refusal(
      `STOCKBIT_NO_BROWSER=${process.env.STOCKBIT_NO_BROWSER} is set in this server's environment, ` +
        "so it will not open a browser window.",
      `Run \`${CLI_LOGIN}\` in a terminal instead, then call status. If the machine has no browser at ` +
        "all, `stockbit-auth import-har` imports a login captured in any browser.",
    );
  }

  if (!request.confirm) {
    return refusal(
      "confirm was not true. This opens a real browser window on the user's machine.",
      "Ask the user whether to open their browser to log in to Stockbit, then call again with confirm: true.",
    );
  }

  if (hasStoredSession("main") && !request.force) {
    const report = await collectStatus();
    return jsonResult({
      started: false,
      alreadyLoggedIn: true,
      auth: report.auth.main,
      nextStep: "Already signed in. Pass force: true to sign in again, or call status to check the session.",
    });
  }

  const browser = findBrowser();
  if (!browser) {
    const seen = findBrowsers().map((b) => b.name);
    return refusal(
      seen.length
        ? `Found ${seen.join(", ")}, but none of them can be driven — Firefox removed DevTools Protocol support in v141.`
        : "No browser was found on this machine.",
      "Install a Chromium-family browser (Chrome, Edge, Brave, Vivaldi), or point STOCKBIT_BROWSER at " +
        "one, or run `stockbit-auth import-har` to import a login captured elsewhere.",
    );
  }

  if (loginStatus().inProgress) {
    return refusal(
      "A login started by this server is already waiting for the user to sign in.",
      "Finish signing in in the window that is already open, then call status. Nothing new was opened.",
    );
  }

  // A directory lock, not just the in-process flag: a second server instance (a different client,
  // or the CLI) would otherwise drive the same browser profile at the same time.
  const release = await acquireDirLock(stockbitPath("login.lock"), {
    staleMs: LOGIN_LOCK_STALE_MS,
    timeoutMs: 0,
  });
  if (!release) {
    return refusal(
      "Another login is already in progress — a lock is held on the browser profile, probably by a terminal or a second client.",
      "Finish or cancel that one, then call status.",
    );
  }

  const elicited = define.elicit
    ? await define.elicit(
        "Open your browser to log in to Stockbit? A visible window opens on this machine. The token " +
          "is stored in your keychain and is never shown to the assistant.",
        { title: "Open a browser to log in?", description: "Yes opens a window. Nothing is sent anywhere else." },
      )
    : "unavailable";
  if (elicited === "declined") {
    release();
    return refusal("The user declined when asked directly.", "Nothing was opened. Ask them what they would rather do.");
  }

  const timeoutMs = Number(process.env.STOCKBIT_LOGIN_TIMEOUT_MS) || 900_000;
  const pinned = readBrowserProfile();

  loginStarted();
  // Deliberately not awaited: the whole point is to return before the person finishes.
  void captureViaBrowserLogin({
    quiet: true,
    slot: "main",
    timeoutMs,
    switchAccount: request.switchAccount,
    ...(request.fresh ? { profileDir: "fresh" as const } : {}),
  })
    .then((result) => {
      if (result.captured) resetSession("main");
      loginFinished(result.captured ? "captured" : "no-token");
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      // Redacted: a capture failure can quote a URL, and a URL here can carry a token.
      loginFinished(`error: ${String(redactValue(message))}`);
    })
    .finally(release);

  return jsonResult({
    started: true,
    browser: pinned?.browserName ?? browser,
    freshProfile: request.fresh,
    switchedAccount: request.switchAccount,
    elicitation: elicited,
    timeoutMinutes: Math.round(timeoutMs / 60_000),
    message:
      "A browser window is opening. Tell the user to sign in there with their username and password — " +
      "Google sign-in is broken on Stockbit's own site. Then call `status` to confirm it worked.",
    note:
      "This server does not wait. If it restarts before the user finishes, the capture is abandoned " +
      "and nothing is stored; status will say the session is still missing.",
  });
}

/* ------------------------------------- logout ------------------------------------- */

type LogoutScope = "main" | "trading" | "eipo" | "all";

interface LogoutRequest {
  confirm: boolean;
  scope: LogoutScope;
  removeProfile: boolean;
}

const SCOPE_SLOTS: Record<Exclude<LogoutScope, "all">, StoreSlot> = {
  main: "main",
  trading: "securities",
  eipo: "eipo",
};

async function doLogout(request: LogoutRequest) {
  if (!request.confirm) {
    return refusal(
      "confirm was not true. This destroys stored credentials and there is no undo.",
      "Ask the user whether to log out, and what to clear, then call again with confirm: true.",
    );
  }

  const scopes: Exclude<LogoutScope, "all">[] =
    request.scope === "all" ? ["main", "trading", "eipo"] : [request.scope];

  const cleared: Record<string, string> = {};
  for (const scope of scopes) {
    if (scope === "trading") {
      // The securities session is ended at Stockbit's end too, not merely forgotten here.
      try {
        const result = await logoutSecurities();
        cleared.trading = result.cleared ? `cleared (remote: ${result.remote})` : `nothing stored (remote: ${result.remote})`;
      } catch (err) {
        cleared.trading = `local store cleared, remote logout failed: ${String(redactValue(err instanceof Error ? err.message : String(err)))}`;
        try {
          await withCredentialLock("securities", () => getStore("securities").clear());
        } catch {
          /* already reported */
        }
      }
      resetSession("securities");
      continue;
    }
    const slot = SCOPE_SLOTS[scope];
    const had = hasStoredSession(slot === "securities" ? "securities" : slot);
    try {
      // Under the credential lock, like every other credential write — a logout that races a
      // refresh must not be undone by the rotation landing a moment later.
      await withCredentialLock(slot, () => getStore(slot).clear());
      cleared[scope] = had ? "cleared" : "nothing stored";
    } catch (err) {
      cleared[scope] = `failed: ${String(redactValue(err instanceof Error ? err.message : String(err)))}`;
    }
    resetSession(slot === "securities" ? "securities" : slot);
  }

  let browserProfile = "kept — it still holds a logged-in Stockbit session";
  if (request.removeProfile) {
    try {
      clearBrowserProfile();
      const dir = defaultProfileDir();
      browserProfile = existsSync(dir)
        ? (await removeDirWithRetry(dir))
          ? "removed"
          : `pin cleared, but ${dir} could not be deleted — remove it by hand; it still holds a logged-in session`
        : "pin cleared; there was no saved profile directory";
    } catch (err) {
      browserProfile = `failed: ${String(redactValue(err instanceof Error ? err.message : String(err)))}`;
    }
  }

  const report = await collectStatus();
  return jsonResult({
    cleared,
    browserProfile,
    auth: report.auth,
    nextStep: report.nextStep,
  });
}
