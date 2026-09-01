/**
 * One-time browser login capture. Launches a Chromium-family browser with remote debugging, points
 * it at the Stockbit login page, and watches network responses over CDP. When a login response
 * carries a `refresh` JWT it is stored — the user only had to log in; they never see or handle a
 * token.
 *
 * The interactive login itself (credentials, captcha, OTP) is done by the human and cannot be
 * automated. Everything after — capture, storage, and all subsequent refreshes — is automatic.
 *
 * Two capture routes run at once, because neither alone is sufficient:
 *
 *   1. `Fetch` interception at the Response stage. The request is *paused* while we read its body,
 *      so the body cannot be destroyed before we get it. This is the reliable route.
 *   2. `Network` events + `Network.getResponseBody`. Kept as a fallback, since `Fetch` patterns are
 *      URL-scoped and a token arriving somewhere unexpected would slip past them.
 *
 * Route 2 alone was the original implementation, and it loses the token whenever the owning target
 * goes away before the body is read: `Network.getResponseBody` resolves against a target that must
 * still exist. A login flow that finishes in a popup which then closes itself — the shape every
 * OAuth provider uses — destroys the body on the way out. This was observed in practice against the
 * new-device verification response, which failed with "No resource with given identifier found" and
 * only succeeded on a lucky `loadingFinished` retry.
 */
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeDirWithRetry } from "./tempdir.js";
import { CDP } from "./cdp.js";
import { launchDebuggableBrowser } from "./launch.js";
import { writeBrowserProfile } from "./browserprofile.js";
import { fileDir, getStore, type StoreSlot } from "./store.js";
import { HOSTS } from "../config.js";
import { logStderr } from "../redact.js";
import { extractRefresh, refreshFromRawBody, tokenUrlAllowed } from "./capture.js";
import { captureWebSession, readCredentialStorage, saveWebSession } from "./websession.js";
import { decodeJwt } from "./session.js";
import { syncStoreFromBrowser } from "./resync.js";
import { findBrowser, findBrowsers } from "./browsers.js";

// Re-exported so existing importers (and tests) keep their entry point while the rules themselves
// live in the module both capture routes share.
export { extractRefresh, tokenUrlAllowed } from "./capture.js";
export { findBrowser, findBrowsers } from "./browsers.js";

const LOGIN_URL = `${HOSTS.web}/login`;

/**
 * URL patterns handed to `Fetch.enable`. Deliberately narrow: every matching response is paused
 * until we resume it, so a broad pattern would stall the whole page load behind our round-trips.
 */
const FETCH_PATTERNS = ["*stockbit.com/login/*", "*stockbit.com/auth/*"];

/** Ceiling on any single arming command. See `armSession` for why an unbounded await deadlocks. */
const ARM_TIMEOUT_MS = 5_000;

/** Ceiling on browser startup, independent of how long the user then has to log in. */
const BROWSER_START_TIMEOUT_MS = 30_000;

/**
 * Persistent profile, so a re-login does not mean re-entering password + OTP from scratch.
 *
 * Resolved through `fileDir()` rather than `homedir()` directly, so it lands beside the credential
 * store and moves with `STOCKBIT_STORE_DIR` — which is how a test gets a profile path that is not
 * the developer's real logged-in one.
 */
/**
 * How long to wait for the logged-in page to appear before closing the login browser.
 *
 * Bounded rather than generous: this runs after the credential is already stored, so every extra
 * second is one the user spends watching a browser they were just told they could close.
 */
const SESSION_SETTLE_TIMEOUT_MS = 12_000;

/** Grace for the page's own storage writes once it has landed. */
const SESSION_WRITE_GRACE_MS = 2_000;

/** How long a graceful browser close may take before it is killed instead. */
const BROWSER_CLOSE_TIMEOUT_MS = 8_000;

/** How often to ask where the page has got to, while waiting for the user. */
const LANDING_POLL_MS = 1_500;

/**
 * How long after the first navigation a signed-in page still counts as "it was ALREADY signed in".
 *
 * This bound is what makes the auto-logout tier safe. A Stockbit page that leaves `/login` within
 * seconds of being opened was signed in before this command ran. One that leaves it four minutes in
 * is a person who has just typed their password — and clearing their session at that moment would
 * undo the login instead of enabling one. So the harvest tier stays armed for the whole window (it
 * can only help), and the clearing tier expires.
 */
const ALREADY_SIGNED_IN_WINDOW_MS = 45_000;

/**
 * Wipe the browser's Stockbit session so the login page shows a form instead of the app.
 *
 * `Storage.clearDataForOrigin` rather than `Network.clearBrowserCookies`, so no `Network` or `Fetch`
 * domain has to be enabled to do it. ADR-0005 restricts the *Chartbit driver* to `Page` and
 * `Runtime`, and `test/chartbit.test.ts` only greps `src/chartbit/` — so this file would not trip
 * that test either way. Matching the restraint anyway is the decision: the reason behind the rule is
 * that this project does not turn on the domains that read response bodies unless it is capturing a
 * login, and "clear some cookies" is not that.
 *
 * **It must be sent to a PAGE session, not to the browser.** Measured, by the fixture test in
 * `test/webharvest.test.ts` against a real Chromium: at browser level the call answers "Internal
 * error" for every `storageTypes` value, while the identical call on an attached page session
 * succeeds. Without a `sessionId` this function therefore always fell through to the fallback below
 * — which still clears, so nothing looked broken, and the origin scope this was chosen for was
 * silently not happening. That is exactly the kind of thing only a real browser can tell you, and
 * it is why the test exists.
 *
 * Falls back to the browser-wide `Storage.clearCookies` when the origin-scoped call is unavailable.
 * That is a bigger hammer than intended, and acceptable only because this profile exists solely for
 * Stockbit — it is created by this project, pinned by this project, and holds nothing else. The
 * return value says which branch ran, so a caller can report it and a test can prove it.
 */
export async function clearBrowserSession(
  cdp: CDP,
  origin: string = HOSTS.web,
  sessionId?: string,
): Promise<"origin" | "browser" | "failed"> {
  try {
    await cdp.send(
      "Storage.clearDataForOrigin",
      { origin, storageTypes: "all" },
      sessionId,
      ARM_TIMEOUT_MS,
    );
    return "origin";
  } catch {
    /* no page session, or a build without it; fall through */
  }
  try {
    await cdp.send("Storage.clearCookies", {}, undefined, ARM_TIMEOUT_MS);
    return "browser";
  } catch {
    return "failed";
  }
}

export function defaultProfileDir(): string {
  return join(fileDir(), "browser-profile");
}

/** Whether a Stockbit URL is the login form rather than the signed-in app. */
export function isLoginPage(url: string): boolean {
  try {
    return /^\/login(?:[/?#]|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * What to tell someone whose login timed out.
 *
 * Exported so a test can assert all three branches without waiting fifteen minutes for one. The old
 * message was "Login timed out — no session captured." for every case, which is true and useless:
 * the three ways to arrive here need three different next steps, and only the URL tells them apart.
 */
export function timeoutMessage(url: string | null, timeoutMs: number): string {
  const minutes = Math.round(timeoutMs / 60_000);
  const head = `Login timed out after ~${minutes} minute(s) — no session captured.`;
  if (!url) {
    return (
      `${head} No Stockbit page was open when it gave up, so the window may never have reached the ` +
      "site. Check the machine's network and try again; `stockbit-auth import-har` imports a login " +
      "captured in any other browser."
    );
  }
  if (!isLoginPage(url)) {
    return (
      `${head} The window was on ${url} — already signed in, not on a login form, and the credential ` +
      "could not be read out of the browser's own session. Run `stockbit-auth login --switch-account` " +
      "to sign that account out and get a real form."
    );
  }
  return (
    `${head} The window was still on ${url}, so the form was never completed. Sign in inside the ` +
    "window this command opens — a login in a different window is not observed. If the form itself " +
    "is stuck, `stockbit-auth login --fresh-profile` starts from a clean profile."
  );
}

/**
 * How a credential was obtained — and therefore how far it can be trusted without checking.
 *
 * `intercepted` means the token came out of a live login RESPONSE: the server minted it, seconds
 * ago, for the refresh route. There is a real basis for assuming it works, which is why the login
 * deliberately does not spend a rotating test refresh proving it.
 *
 * `harvested` means it was read out of the browser's own `credentialStorage` because the profile
 * was already signed in. No login happened and the refresh route never issued it. Measured on
 * 2026-08-29 and 2026-08-30: four harvested credentials in a row returned HTTP 401 on their first
 * use while `login`, `doctor` and `status` all reported them healthy; six intercepted ones in the
 * same hours worked. The distinction decides whether verification is optional, so it is typed
 * rather than left buried in a display string.
 */
export type CaptureMethod = "intercepted" | "harvested";

export interface LoginResult {
  captured: boolean;
  refresh?: string;
  /** Set whenever `captured` is true. Callers MUST branch on it — see `CaptureMethod`. */
  method?: CaptureMethod;
}

/**
 * Must this capture be proven against the API before the CLI may call it a success?
 *
 * Extracted from `bin/stockbit-auth.ts` for the reason `src/cliargs.ts` was: a decision that lives
 * inline in a bin is a decision no test can reach, and this one is load-bearing enough that its
 * truth table should be written down and checked.
 *
 * The rule, and why it is asymmetric:
 *
 * - An INTERCEPTED token came out of a live login response seconds ago. Proving it costs a refresh,
 *   refreshes ROTATE, and rotation invalidates the browser session the login just established —
 *   measured, and the reason the default proof was removed in the first place. So: trust it.
 * - A HARVESTED token was read out of a cookie because the profile was already signed in. Nothing
 *   logged in and the refresh route never issued it. Four of them in a row were rejected with HTTP
 *   401 on first use while every diagnostic reported healthy. So: prove it, and accept the rotation
 *   as the price of not shipping a credential that does not work.
 * - `--verify` always proves, whatever the method: an explicit request outranks the heuristic.
 *
 * An absent method is treated as needing proof. It should not happen — `captureViaBrowserLogin`
 * always sets one alongside `captured: true` — but "unknown provenance" is exactly the case where
 * assuming the happy path is how this bug existed.
 */
export function captureNeedsProof(
  method: CaptureMethod | undefined,
  explicitVerify: boolean,
): boolean {
  if (explicitVerify) return true;
  return method !== "intercepted";
}

export interface CaptureOptions {
  /** How long the user has to complete login. */
  timeoutMs?: number;
  /** Page to open. */
  startUrl?: string;
  /** Which responses may carry a token. */
  isTokenUrl?: (url: string) => boolean;
  /** `Fetch.enable` URL patterns; must cover whatever `isTokenUrl` accepts. */
  fetchPatterns?: string[];
  /** Browser executable. Defaults to the best one discovered. */
  browserPath?: string;
  /** Profile directory. Pass `"fresh"` for a throwaway one. */
  profileDir?: string | "fresh";
  /** Extra command-line flags. */
  extraArgs?: string[];
  /** Persist the captured token. `false` for self-tests. */
  persist?: boolean;
  /**
   * Which store slot the captured token belongs in. Defaults to the market-data session.
   *
   * The `--browser` trading login captures a carina token, which must NOT land in the main slot —
   * see `securitiesTokenUrlAllowed`.
   */
  slot?: StoreSlot;
  /** Suppress the user-facing "a browser opened" chatter. */
  quiet?: boolean;
  /**
   * Sign out of Stockbit in this profile first, and never harvest the session that was there.
   *
   * The point of this flag is to log in as somebody ELSE, so reusing what is already in the profile
   * is exactly the wrong answer — it would report success and store the previous account's token.
   */
  switchAccount?: boolean;
  /**
   * If the browser exits immediately because something already holds the profile, kill it and retry
   * once.
   *
   * Off by default. Orphaned browser processes holding `~/.stockbit/browser-profile` blocked every
   * subsequent login until they were killed by hand, and nothing here reaped them — but the same
   * profile is what the Chartbit driver keeps open on purpose, so this is a decision the caller
   * makes, never a default. See `reap.ts`.
   */
  reapOrphans?: boolean;
}

/**
 * Run the interactive capture. Resolves once a refresh token is seen (and stored), or rejects on
 * timeout, browser exit, or the DevTools transport dropping.
 */
export async function captureViaBrowserLogin(
  optionsOrTimeout: CaptureOptions | number = {},
): Promise<LoginResult> {
  const options: CaptureOptions =
    typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;

  const timeoutMs =
    options.timeoutMs ?? (Number(process.env.STOCKBIT_LOGIN_TIMEOUT_MS) || 900_000);
  const startUrl = options.startUrl ?? LOGIN_URL;
  const isTokenUrl = options.isTokenUrl ?? tokenUrlAllowed;
  const fetchPatterns = options.fetchPatterns ?? FETCH_PATTERNS;
  const persist = options.persist !== false;

  const bin = options.browserPath ?? findBrowser();
  if (!bin) {
    const seen = findBrowsers();
    const detail = seen.length
      ? `Found ${seen.map((b) => b.name).join(", ")}, but none can be driven ` +
        "(Firefox removed CDP support in v141)."
      : "No browser found.";
    throw new Error(
      `${detail}\nEither install a Chromium-family browser (Chrome/Edge/Brave), point ` +
        "STOCKBIT_BROWSER at one, or use `stockbit-auth import-har` to import a login from any browser.",
    );
  }

  // A browser profile that has been logged into Stockbit holds session cookies and a Login Data
  // store — a second copy of the credential this project guards. It is created owner-only, and the
  // parent is corrected too: `mkdirSync(recursive)` applies the mode only to directories it
  // actually creates, so a `~/.stockbit` that already exists keeps whatever mode it had.
  let profile: string;
  let profileIsDisposable = false;
  if (options.profileDir === "fresh") {
    profile = mkdtempSync(join(tmpdir(), "stockbit-login-"));
    profileIsDisposable = true;
  } else {
    profile = options.profileDir ?? defaultProfileDir();
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      for (const dir of [dirname(profile), profile]) {
        try {
          chmodSync(dir, 0o700);
        } catch {
          /* best effort; a pre-existing dir we do not own is not ours to fix */
        }
      }
    }
  }

  // Launching and waiting for the DevTools endpoint is shared with the Chartbit driver — see
  // `launch.ts` for why each flag is there and why the wait loop watches the child.
  const { child, wsUrl } = await launchDebuggableBrowser({
    bin,
    profileDir: profile,
    extraArgs: options.extraArgs,
    startTimeoutMs: Math.min(timeoutMs, BROWSER_START_TIMEOUT_MS),
    reapOrphans: options.reapOrphans === true,
  });

  if (!options.quiet) {
    logStderr("A browser window opened. Log into Stockbit there — your session is captured automatically.");
  }

  const debug = process.env.STOCKBIT_DEBUG === "1";
  const dbg = (...m: unknown[]) => {
    if (debug) logStderr("[login:debug]", ...m);
  };

  const cdp = await CDP.connect(wsUrl);
  const tracked = new Map<string, { sid?: string; url: string }>();
  const attached = new Set<string>();

  return new Promise<LoginResult>((resolve, reject) => {
    let done = false;

    /**
     * Tear down and, for a throwaway profile, delete it.
     *
     * Returns a promise the settlement path must await. Fire-and-forget does not work here: the CLI
     * calls `process.exit` as soon as this function's promise settles, which kills the retry loop
     * before Windows has released the browser's file handles — the profile then survives in %TEMP%
     * holding live Stockbit session cookies. (Observed: a `--fresh-profile` run left its profile
     * behind every time.)
     */
    /**
     * Shut the browser down in a way that leaves the profile usable.
     *
     * The token is intercepted on the `/auth/v1/login` RESPONSE — the instant the server confirms
     * the credential, before the page has run the script that turns it into a signed-in session.
     * Chromium writes its cookie jar and Local Storage lazily, so killing the process here left a
     * profile with a half-written session: the API token worked, the Chartbit driver opened the same
     * profile minutes later and was bounced to `/login`, and the user was told to log in again. That
     * is the "log in every time" complaint, and it is entirely self-inflicted — the message printed
     * one line earlier already says "you can close the browser window", which is what should happen.
     *
     * So: wait for the app to actually land somewhere signed-in, give it a moment to write, then ask
     * the browser to close, which flushes. `child.kill()` remains the fallback for a browser that
     * will not go, because refusing to exit must not hang the login.
     */
    const flushAndCloseBrowser = async (): Promise<void> => {
      // Capturing the web session is worth the settle even for a disposable profile — arguably
      // especially so, because that profile is about to be deleted and the captured session is the
      // only thing that will survive it.
      const wantsWebSession = persist && (options.slot ?? "main") === "main";
      if (!profileIsDisposable || wantsWebSession) {
        const settleDeadline = Date.now() + SESSION_SETTLE_TIMEOUT_MS;
        while (Date.now() < settleDeadline) {
          try {
            const { targetInfos } = (await cdp.send("Target.getTargets", {}, undefined, 5_000)) as {
              targetInfos?: Array<{ type?: string; url?: string }>;
            };
            const landed = (targetInfos ?? []).some(
              (t) => t.type === "page" && /stockbit\.com/i.test(t.url ?? "") && !/\/login/i.test(t.url ?? ""),
            );
            if (landed) break;
          } catch {
            break;
          }
          await delay(500);
        }
        // Even once the URL is right, the store write that follows it is asynchronous.
        await delay(SESSION_WRITE_GRACE_MS);

        // Snapshot the browser's own session — cookies and Local Storage — alongside the API token.
        // They are different credentials for different transports, and keeping only the token is
        // what made a successful login still land the chart page on `/login`. Best-effort: a login
        // that captured the token is a successful login whether or not this part works.
        if (wantsWebSession) {
          try {
            const web = await captureWebSession(cdp);
            if (web) {
              saveWebSession(web);
              dbg("web session captured:", web.cookies.length, "cookies,", web.origins.length, "origin(s)");
              // And take the API credential out of the same capture.
              //
              // This is what fixes the login race. `flushAndCloseBrowser` deliberately keeps the
              // page alive for 12 s + 2 s after the token was stored, so the profile flushes — and
              // that window is exactly SPA boot, which calls the refresh route and rotates away the
              // token just written. `done = true` blocks re-capture, so the successor was never
              // picked up and the credential could be dead before the command returned. Reading it
              // out of the cookie here catches the successor, because this runs AFTER the app has
              // landed signed in.
              //
              // Inside the existing `wantsWebSession` guard on purpose: that guard is already
              // exactly `persist && slot === "main"`, which keeps the trading-login capture and
              // `doctor`'s non-persisting self-test from ever writing the main slot.
              // A short timeout, like the chart path. This runs at the tail of an interactive
              // login, after the credential is already stored and the user has been told they can
              // close the window; inheriting the full lock wait would hold that window open for a
              // minute or more to do something the next call would do anyway.
              const resync = await syncStoreFromBrowser(web, { lockTimeoutMs: 5_000 });
              dbg("store resync from browser:", resync.reason);
            } else {
              dbg("web session capture found nothing to store");
            }
          } catch (err) {
            dbg("web session capture failed:", err instanceof Error ? err.message : String(err));
          }
        }
      }

      try {
        // A graceful close is what flushes; it also lets Windows release the profile's file handles,
        // which `removeDirWithRetry` below otherwise has to fight.
        await cdp.send("Browser.close", {}, undefined, BROWSER_CLOSE_TIMEOUT_MS);
      } catch {
        /* fall through to the kill */
      }
      cdp.close();

      const exited = await Promise.race([
        new Promise<boolean>((res) => child.once("exit", () => res(true))),
        delay(BROWSER_CLOSE_TIMEOUT_MS).then(() => false),
      ]);
      if (!exited) child.kill();
    };

    const cleanup = async (): Promise<void> => {
      await flushAndCloseBrowser();
      if (!profileIsDisposable) return;
      if (!(await removeDirWithRetry(profile))) {
        logStderr(
          `Note: could not delete the temporary browser profile at ${profile} — it contains a ` +
            "Stockbit session; please remove it.",
        );
      }
    };

    /**
     * Where the Stockbit page has got to, or null if there is not one.
     *
     * The same `Target.getTargets` call `flushAndCloseBrowser` already makes — whose answer that
     * function throws away after using it as a boolean. Everything the ladder and the timeout
     * message need is in it.
     */
    const stockbitPageUrl = async (): Promise<string | null> => {
      try {
        const { targetInfos } = (await cdp.send("Target.getTargets", {}, undefined, 5_000)) as {
          targetInfos?: Array<{ type?: string; url?: string }>;
        };
        const page = (targetInfos ?? []).find(
          (t) => t.type === "page" && /^https?:\/\/[^/]*stockbit\.com(?:[/?#]|$)/i.test(t.url ?? ""),
        );
        return page?.url ?? null;
      } catch {
        return null;
      }
    };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      dbg(`timeout. frames=${cdp.messageCount} attached=${attached.size} tracked=${tracked.size}`);
      // Read where the page actually is BEFORE cleanup closes the browser. A timeout that only says
      // "no session captured" sends every diagnosis in the wrong direction: the three ways to be
      // here — still on the form, already signed in, never got to Stockbit at all — need three
      // different next steps, and the URL is what tells them apart.
      void (async () => {
        const where = await stockbitPageUrl();
        await cleanup();
        reject(new Error(timeoutMessage(where, timeoutMs)));
      })();
    }, timeoutMs);
    // Deliberately NOT unref'd. The DevTools socket is the only other handle keeping this process
    // alive; when the browser closes, an unref'd timer lets the loop drain with the promise still
    // pending, and the process exits 0 — indistinguishable from a successful capture.

    const fail = (message: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      dbg(`${message} frames=${cdp.messageCount} attached=${attached.size} tracked=${tracked.size}`);
      void cleanup().finally(() => reject(new Error(message)));
    };

    cdp.onClose(() =>
      fail(
        "The browser closed before a session was captured. Re-run `stockbit-auth login` and log in " +
          "inside the new window it opens — logging into a different browser window is not observed.",
      ),
    );
    child.on("exit", () =>
      fail("The browser exited before a session was captured. Re-run `stockbit-auth login`."),
    );

    const finish = (result: LoginResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // Settle only after cleanup, so the caller cannot exit the process mid-deletion.
      void cleanup().finally(() => resolve(result));
    };

    const accept = (refresh: string, via: string, method: CaptureMethod) => {
      if (done) return;
      // Persistence is separated from recognition because both callers sit inside a catch that
      // logs "getResponseBody failed" at debug level. A store write that throws there — a locked
      // Keychain, a denied access prompt, EPERM from an antivirus holding the temp file — would be
      // swallowed, leaving `done` false and the capture running until it reported "no session
      // captured" fifteen minutes later. That is the opposite of what happened, and it points
      // diagnosis at interception instead of at the store.
      //
      // This is the ONE credential write that deliberately takes no lock, and it is not an
      // oversight — every other one in the project now goes through `withCredentialLock`. Two
      // reasons, either of which alone is sufficient. An interactive re-login is *meant* to
      // supersede whatever was stored: the user is standing there having just typed a password,
      // and a concurrent refresh losing to them is the correct outcome, not a clobber. And
      // `accept` is synchronous by design — making it await a lock would let the capture promise
      // settle, and the CLI `process.exit` that follows it, before the write ever landed.
      if (persist) {
        try {
          getStore(options.slot ?? "main").set(refresh);
        } catch (err) {
          fail(
            `Session was captured but could not be stored: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
      // Pin the browser this profile belongs to. A Chromium profile is not portable between
      // browsers, and the Chartbit driver opens this one long after the login — without the pin its
      // most likely failure is a logged-out window reported as an empty chart. Disposable profiles
      // are deliberately not pinned: there is nothing to come back to.
      if (persist && !profileIsDisposable && (options.slot ?? "main") === "main") writeBrowserProfile(bin);
      if (!options.quiet) logStderr(`Session captured (${via}). You can close the browser window.`);
      finish({ captured: true, refresh, method });
    };

    /**
     * Bring a session fully online, then release it.
     *
     * Order matters and is the whole point: with `waitForDebuggerOnStart` the target is frozen
     * before it runs a single byte of script, so enabling interception here cannot lose a response
     * to a race. `Runtime.runIfWaitingForDebugger` MUST be called afterwards or the target stays
     * frozen forever — a hung popup is a worse failure than a missed one.
     */
    const armSession = async (sid?: string) => {
      if (sid && attached.has(sid)) return;
      if (sid) attached.add(sid);
      try {
        // Every enable is bounded. A target frozen by waitForDebuggerOnStart dispatches these to
        // its own suspended thread, so for worker-class targets (service workers, and the browser's
        // internal `other` target) the reply cannot arrive until the resume below — which an
        // unbounded await would be blocking. That circularity wedges the target for the whole login
        // window. Bounding turns a permanent deadlock into a logged, harmless miss.
        await cdp.send("Network.enable", {}, sid, ARM_TIMEOUT_MS).then(
          () => dbg("Network.enable ok", sid ?? "(root)"),
          (e) => dbg("Network.enable failed", String(e)),
        );
        await cdp
          .send(
            "Fetch.enable",
            { patterns: fetchPatterns.map((urlPattern) => ({ urlPattern, requestStage: "Response" })) },
            sid,
            ARM_TIMEOUT_MS,
          )
          .then(
            () => dbg("Fetch.enable ok", sid ?? "(root)"),
            (e) => dbg("Fetch.enable failed", String(e)),
          );
        // Nested targets (a popup opening a popup) need their own auto-attach.
        if (sid) {
          await cdp
            .send(
              "Target.setAutoAttach",
              { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
              sid,
              ARM_TIMEOUT_MS,
            )
            .catch(() => {});
        }
      } finally {
        // The resume runs on every path, including a thrown enable. Skipping it leaves the target
        // frozen forever, which is a worse failure than missing its traffic.
        if (sid) {
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, sid, ARM_TIMEOUT_MS).catch(() => {});
          dbg("resumed", sid);
        }
      }
    };

    /* ------------------------- route 1: Fetch (authoritative) ------------------------- */

    cdp.on("Fetch.requestPaused", (p, sid) => {
      const requestId = (p as any).requestId as string;
      const url: string = (p as any).request?.url ?? "";
      const status = (p as any).responseStatusCode;

      const resume = async () => {
        // The request is stalled until we answer. Any failure here must still release it, or the
        // user's login hangs on a spinner forever.
        try {
          await cdp.send("Fetch.continueResponse", { requestId }, sid);
        } catch {
          await cdp.send("Fetch.continueRequest", { requestId }, sid).catch(() => {});
        }
      };

      void (async () => {
        try {
          if (status === undefined || !isTokenUrl(url)) return;
          const res = await cdp.send("Fetch.getResponseBody", { requestId }, sid);
          const refresh = refreshFromRawBody(res?.body ?? "", Boolean(res?.base64Encoded));
          dbg("fetch-intercepted", status, url, "-> refresh found:", Boolean(refresh));
          if (refresh) accept(refresh, "intercepted", "intercepted");
        } catch (e) {
          dbg("Fetch.getResponseBody failed", url, String(e));
        } finally {
          await resume();
        }
      })();
    });

    /* --------------------- route 2: Network events (fallback) --------------------- */

    const tryCapture = async (requestId: string, sid?: string) => {
      const info = tracked.get(requestId);
      if (!info) return;
      if (!isTokenUrl(info.url)) {
        tracked.delete(requestId);
        return;
      }
      try {
        const res = await cdp.send("Network.getResponseBody", { requestId }, sid);
        const refresh = refreshFromRawBody(res?.body ?? "", Boolean(res?.base64Encoded));
        dbg("checked body", info.url, "-> refresh found:", Boolean(refresh));
        if (refresh) accept(refresh, "network", "intercepted");
      } catch (e) {
        dbg("getResponseBody failed", info.url, String(e));
      }
    };

    cdp.on("Target.attachedToTarget", (p) => {
      const sid = (p as { sessionId?: string }).sessionId;
      const info = (p as any).targetInfo ?? {};
      dbg("attached", info.type, info.url);
      void armSession(sid);
    });

    cdp.on("Network.responseReceived", (p, sid) => {
      const r = (p as any).response ?? {};
      const url: string = r.url ?? "";
      const mime: string = r.mimeType ?? "";
      const authish = /\/login|\/auth|social|refresh|token|session/i.test(url);
      if (mime.includes("json") || authish) {
        tracked.set((p as any).requestId, { sid, url });
        if (authish) {
          dbg("candidate response", r.status, mime, url);
          void tryCapture((p as any).requestId, sid);
        }
      }
    });

    cdp.on("Network.loadingFinished", (p, sid) => void tryCapture((p as any).requestId, sid));

    // Some flows deliver the token over a WebSocket (e.g. wssocial).
    const scanWsFrame = (p: unknown) => {
      const payload: string = (p as any).response?.payloadData ?? "";
      if (!payload || !payload.includes("eyJ")) return;
      const refresh = refreshFromRawBody(payload, false);
      dbg("ws frame scanned -> refresh found:", Boolean(refresh));
      if (refresh) accept(refresh, "socket", "intercepted");
    };
    cdp.on("Network.webSocketFrameReceived", (p) => scanWsFrame(p));
    cdp.on("Network.webSocketFrameSent", (p) => scanWsFrame(p));

    /* ---------------------------- the already-signed-in ladder ---------------------------- */

    /** The page session the first navigation went through, so the ladder can re-navigate it. */
    let primarySid: string | undefined;
    /** One shot each. A loop that harvested or cleared repeatedly would be worse than either. */
    let harvestTried = false;
    let clearedOnce = false;

    /**
     * Watch for a page that has landed signed-in with nothing captured.
     *
     * This is the case that used to hang for fifteen minutes and then report that no session was
     * captured: `stockbit-auth login` on a browser that is already signed in lands in the app, no
     * login response is ever issued, and the two capture routes have nothing to intercept — while
     * the credential sits in front of them in the `credentialStorage` cookie.
     *
     * Tier 1 reads it out. Tier 2, if there is nothing usable there, signs the profile out and
     * re-opens the form. Tier 2 expires after `ALREADY_SIGNED_IN_WINDOW_MS`: past that point a page
     * leaving `/login` is a person who has just signed in, and clearing then would undo their work
     * rather than enable it. Tier 1 stays armed the whole time, because reading can only help — if
     * the interception missed the token, this catches it.
     */
    const watchForSignedInPage = async (): Promise<void> => {
      const clearingExpiresAt = Date.now() + ALREADY_SIGNED_IN_WINDOW_MS;
      while (!done) {
        await delay(LANDING_POLL_MS);
        if (done) return;

        const url = await stockbitPageUrl();
        if (!url || isLoginPage(url)) continue;

        // Only the MAIN slot may be filled this way. `credentialStorage` is the stockbit.com web
        // session, so what this tier reads is a market-data credential BY CONSTRUCTION. Accepting it
        // for another slot stores the wrong domain's token under the right name and reports success:
        // `trading-login --browser` did exactly that, and the 401 only surfaced on the test refresh
        // afterwards. The guard at `slot` was one-directional — it kept a carina token out of main,
        // and left the reverse open.
        if (!harvestTried && !options.switchAccount && (options.slot ?? "main") === "main") {
          harvestTried = true;
          dbg("landed signed-in at", url, "— harvesting the browser's own session");
          const token = await harvestFromBrowser();
          if (token) {
            accept(token, "harvested from the already-signed-in browser", "harvested");
            return;
          }
          dbg("nothing usable in credentialStorage");
        }

        if (!clearedOnce && Date.now() < clearingExpiresAt) {
          clearedOnce = true;
          const how = await clearBrowserSession(cdp, HOSTS.web, primarySid);
          dbg("cleared the browser's Stockbit session via", how);
          if (!options.quiet) {
            logStderr(
              "That browser was already signed in and the session could not be read out of it — " +
                "signing it out and re-opening the login form.",
            );
          }
          await renavigate();
          continue;
        }
        // Signed in, nothing to harvest, and past the point where clearing would be safe. Keep
        // waiting: the timeout message names `--switch-account`, which is the deliberate version
        // of what tier 2 does.
        return;
      }
    };

    /** Read the browser's own credential, and reject one that is already dead. */
    const harvestFromBrowser = async (): Promise<string | null> => {
      try {
        const web = await captureWebSession(cdp);
        if (!web) return null;
        const token = readCredentialStorage(web);
        if (!token) return null;
        // A token that has already expired is not "usable" — accepting it would report a successful
        // login and then fail on the first call. Falling through to the clearing tier is the right
        // recovery, and it is the whole reason this check is here rather than in the caller.
        const exp = decodeJwt(token)["exp"];
        if (typeof exp === "number" && exp - Math.floor(Date.now() / 1000) <= 0) {
          dbg("credentialStorage held an expired token");
          return null;
        }
        return token;
      } catch (err) {
        dbg("harvest failed:", err instanceof Error ? err.message : String(err));
        return null;
      }
    };

    const renavigate = async (): Promise<void> => {
      if (!primarySid) return;
      try {
        await cdp.send("Page.navigate", { url: startUrl }, primarySid);
        dbg("re-navigated to", startUrl);
      } catch (err) {
        dbg("re-navigate failed:", err instanceof Error ? err.message : String(err));
      }
    };

    /* --------------------------------- bring-up --------------------------------- */

    void armSession(undefined);

    cdp
      .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
      .then(() => dbg("setAutoAttach ok"))
      .catch((e) => fail(`Could not attach to browser targets: ${String(e)}`));
    cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});

    // Explicitly attach to already-open tabs (auto-attach does not cover pre-existing ones).
    cdp
      .send("Target.getTargets")
      .then(async (res) => {
        let navigated = false;
        for (const t of (res?.targetInfos ?? []) as Array<{ targetId: string; type: string; url: string }>) {
          if (t.type !== "page") continue;
          dbg("existing target", t.url);
          try {
            const attachedTarget = await cdp.send("Target.attachToTarget", {
              targetId: t.targetId,
              flatten: true,
            });
            const sid = attachedTarget?.sessionId as string | undefined;
            if (!sid) continue;
            // Await arming before navigating so the login response cannot race capture.
            await armSession(sid);
            if (!navigated) {
              navigated = true;
              primarySid = sid;
              // `--switch-account` clears BEFORE the first navigation, not after landing. The whole
              // point of it is to sign in as somebody else, so there is nothing to harvest and
              // nothing to check first — going straight to a cleared profile is the fastest path to
              // the form, and it removes any window in which the previous account's token could be
              // captured.
              if (options.switchAccount) {
                const how = await clearBrowserSession(cdp, HOSTS.web, sid);
                clearedOnce = true;
                dbg("switch-account: cleared the browser's Stockbit session via", how);
                if (!options.quiet) {
                  logStderr("Signed the previous account out of this browser profile.");
                }
              }
              await cdp.send("Page.navigate", { url: startUrl }, sid);
              dbg("navigated", startUrl);
              void watchForSignedInPage();
            }
          } catch (e) {
            dbg("initial target setup failed", String(e));
          }
        }
      })
      .catch((e) => dbg("getTargets failed", String(e)));
  });
}
