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
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeDirWithRetry } from "./tempdir.js";
import { setTimeout as delay } from "node:timers/promises";
import { CDP } from "./cdp.js";
import { getStore } from "./store.js";
import { HOSTS } from "../config.js";
import { logStderr } from "../redact.js";
import { extractRefresh, refreshFromRawBody, tokenUrlAllowed } from "./capture.js";
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

/** Persistent profile, so a re-login does not mean re-entering password + OTP from scratch. */
export function defaultProfileDir(): string {
  return join(homedir(), ".stockbit", "browser-profile");
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

  const port = 9500 + Math.floor(Math.random() * 400);
  const child: ChildProcess = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      // Chrome 136+ refuses remote debugging against the DEFAULT profile directory, so this flag
      // is mandatory, not merely tidy.
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // A fresh --user-data-dir still inherits browser-managed extensions, which open their own
      // tabs (an OAuth prompt stole focus from the login page here) and bury the responses we watch.
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      // The one window the user must find and type into; do not let it open behind others.
      "--start-maximized",
      "--new-window",
      // Start blank so interception is live before the login page loads.
      "about:blank",
      ...(options.extraArgs ?? []),
    ],
    { stdio: "ignore" },
  );

  if (!options.quiet) {
    logStderr("A browser window opened. Log into Stockbit there — your session is captured automatically.");
  }

  // Wait for the DevTools endpoint.
  //
  // The startup wait is bounded separately from the login window, and it watches the child. The
  // most common Windows failure is launching against a profile that another window already has
  // open: the new process hands off to the running instance and exits immediately, so the debugging
  // port never opens. Polling on the login timeout alone turned that into a fifteen-minute silent
  // hang with no window to look at.
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });

  let wsUrl = "";
  const alreadyOpenHint =
    "The browser exited immediately without opening a debugging port. This usually means a window " +
    "is already open using this profile — close every window of that browser and retry, or use " +
    "`--fresh-profile`.";
  const deadline = Date.now() + Math.min(timeoutMs, BROWSER_START_TIMEOUT_MS);
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        wsUrl = ((await r.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* not up yet */
    }
    if (childExited) throw new Error(alreadyOpenHint);
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(
        "Browser did not start in time (no debugging port after " +
          `${Math.round(Math.min(timeoutMs, BROWSER_START_TIMEOUT_MS) / 1000)}s). ` +
          "If a window using this profile is already open, close it and retry.",
      );
    }
    await delay(250);
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
    const cleanup = () => {
      cdp.close();
      child.kill();
      // A throwaway profile is disposable to us but not to an attacker: by now it holds Stockbit
      // session cookies. Remove it rather than leaving it in %TEMP% indefinitely.
      if (profileIsDisposable) {
        void removeDirWithRetry(profile).then((ok) => {
          if (!ok) logStderr(`Note: could not delete the temporary browser profile at ${profile}`);
        });
      }
    };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      dbg(`timeout. frames=${cdp.messageCount} attached=${attached.size} tracked=${tracked.size}`);
      cleanup();
      reject(new Error("Login timed out — no session captured."));
    }, timeoutMs);
    // Deliberately NOT unref'd. The DevTools socket is the only other handle keeping this process
    // alive; when the browser closes, an unref'd timer lets the loop drain with the promise still
    // pending, and the process exits 0 — indistinguishable from a successful capture.

    const fail = (message: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      dbg(`${message} frames=${cdp.messageCount} attached=${attached.size} tracked=${tracked.size}`);
      cleanup();
      reject(new Error(message));
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
      cleanup();
      resolve(result);
    };

    const accept = (refresh: string, via: string) => {
      if (done) return;
      // Persistence is separated from recognition because both callers sit inside a catch that
      // logs "getResponseBody failed" at debug level. A store write that throws there — a locked
      // Keychain, a denied access prompt, EPERM from an antivirus holding the temp file — would be
      // swallowed, leaving `done` false and the capture running until it reported "no session
      // captured" fifteen minutes later. That is the opposite of what happened, and it points
      // diagnosis at interception instead of at the store.
      if (persist) {
        try {
          getStore().set(refresh);
        } catch (err) {
          fail(
            `Session was captured but could not be stored: ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
      }
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
