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
import { captureWebSession, saveWebSession } from "./websession.js";
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

export function defaultProfileDir(): string {
  return join(fileDir(), "browser-profile");
}

export interface LoginResult {
  captured: boolean;
  refresh?: string;
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

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      dbg(`timeout. frames=${cdp.messageCount} attached=${attached.size} tracked=${tracked.size}`);
      void cleanup().finally(() => reject(new Error("Login timed out — no session captured.")));
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

    const accept = (refresh: string, via: string) => {
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
      finish({ captured: true, refresh });
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
          if (refresh) accept(refresh, "intercepted");
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
        if (refresh) accept(refresh, "network");
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
      if (refresh) accept(refresh, "socket");
    };
    cdp.on("Network.webSocketFrameReceived", (p) => scanWsFrame(p));
    cdp.on("Network.webSocketFrameSent", (p) => scanWsFrame(p));

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
              await cdp.send("Page.navigate", { url: startUrl }, sid);
              dbg("navigated", startUrl);
            }
          } catch (e) {
            dbg("initial target setup failed", String(e));
          }
        }
      })
      .catch((e) => dbg("getTargets failed", String(e)));
  });
}
