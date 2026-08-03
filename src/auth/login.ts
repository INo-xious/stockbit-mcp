/**
 * One-time browser login capture. Launches the user's existing Chromium-family browser with a
 * temporary profile + remote debugging, points it at the Stockbit login page, and watches network
 * responses over CDP. When a login/refresh response carries a `refresh` JWT, it's stored — the user
 * only had to log in; they never see or handle a token.
 *
 * The initial interactive login (OAuth + reCAPTCHA) is unavoidable and done by the human. Everything
 * after — capture and all subsequent refreshes — is automatic.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CDP } from "./cdp.js";
import { getStore } from "./store.js";
import { HOSTS } from "../config.js";
import { logStderr } from "../redact.js";

const LOGIN_URL = `${HOSTS.web}/login`;

/** Locate an installed Chromium-family browser (Chrome/Edge/Brave/Chromium). */
export function findBrowser(): string | null {
  const byPlatform: Record<string, string[]> = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/usr/bin/brave-browser",
    ],
  };
  return (byPlatform[process.platform] ?? byPlatform.linux).find(existsSync) ?? null;
}

function looksLikeJwt(v: unknown): v is string {
  return typeof v === "string" && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(v);
}

/**
 * Only accept the main-session refresh token, which is issued on the exodus domain
 * (e.g. /login/v6/social). Reject other token domains — notably the securities/e-IPO partner
 * (`api-sekuritas.stockbit.com`, `/partner/`, `eipo`), which also expose a `refresh` field.
 */
export function tokenUrlAllowed(url: string): boolean {
  if (/api-sekuritas\.stockbit\.com|eipo|\/partner\//i.test(url)) return false;
  if (/wssocial\.stockbit\.com/i.test(url)) return true;
  if (!/exodus\.stockbit\.com/i.test(url)) return false;

  // For email/password accounts with phone verification, this final verification response issues
  // the usable session token. No additional token response occurs after the logged-in page loads.
  if (/\/login\/v\d+\/new-device\/prompt\/verify(?:[/?]|$)/i.test(url)) return true;
  if (/verification|\/otp(?:[/?]|$)/i.test(url)) return false;

  // Direct username/social logins issue the session on their final credential response.
  return (
    /\/login\/v\d+\/(?:username(?:\/browser)?|social)(?:[/?]|$)/i.test(url) ||
    /\/auth\/v\d+\/login(?:[/?]|$)/i.test(url)
  );
}

/** Find a `refresh`/`refresh_token` JWT anywhere in a parsed response body. */
export function extractRefresh(body: unknown): string | null {
  const seen = new Set<object>();
  const walk = (o: unknown): string | null => {
    if (!o || typeof o !== "object" || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/^refresh(_token)?$/i.test(k) && looksLikeJwt(v)) return v;
      if (/^refresh(_token)?$/i.test(k) && v && typeof v === "object") {
        const token = (v as Record<string, unknown>).token;
        if (looksLikeJwt(token)) return token;
      }
      const nested = walk(v);
      if (nested) return nested;
    }
    return null;
  };
  return walk(body);
}

export interface LoginResult {
  captured: boolean;
  refresh?: string;
}

/**
 * Run the interactive capture. Resolves once a refresh token is seen (and stored), or rejects on
 * timeout / no browser. `timeoutMs` is how long the user has to complete login.
 */
export async function captureViaBrowserLogin(
  timeoutMs = Number(process.env.STOCKBIT_LOGIN_TIMEOUT_MS) || 900_000,
): Promise<LoginResult> {
  const bin = findBrowser();
  if (!bin) {
    throw new Error(
      "No Chromium-family browser found (Chrome/Edge/Brave/Chromium). " +
        "Use `stockbit-auth bootstrap` to paste a refresh token instead.",
    );
  }

  const port = 9500 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), "stockbit-login-"));
  const child: ChildProcess = spawn(
    bin,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      // A fresh --user-data-dir still inherits browser-managed extensions, which open their own
      // tabs (an OAuth prompt stole focus from the login page here) and bury the Stockbit
      // responses we are watching for. Nothing in this flow needs them.
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      // The one window the user must actually find and type into; do not let it open behind others.
      "--start-maximized",
      "--new-window",
      // Start blank so we can enable network interception BEFORE the login page loads
      // (the token response fires early — we navigate ourselves once we're listening).
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  logStderr("A browser window opened. Log into Stockbit there — your session is captured automatically.");

  // Wait for the DevTools endpoint to come up.
  let wsUrl = "";
  const deadline = Date.now() + timeoutMs;
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
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("Browser did not start in time.");
    }
    await delay(250);
  }

  const debug = process.env.STOCKBIT_DEBUG === "1";
  const dbg = (...m: unknown[]) => {
    if (debug) logStderr("[login:debug]", ...m);
  };

  const cdp = await CDP.connect(wsUrl);
  // requestId -> { sid, url }. Track anything that might carry the token.
  const tracked = new Map<string, { sid?: string; url: string }>();
  const attached = new Set<string>();

  const enableNetwork = (sid?: string) => {
    if (sid && attached.has(sid)) return;
    if (sid) attached.add(sid);
    cdp.send("Network.enable", {}, sid).then(
      () => dbg("Network.enable ok", sid ?? "(root)"),
      (e) => dbg("Network.enable failed", String(e)),
    );
  };

  return new Promise<LoginResult>((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      cdp.close();
      child.kill();
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

    // Closing the browser window before logging in is the common way this goes wrong; say so
    // rather than exiting silently.
    cdp.onClose(() =>
      fail(
        "The browser closed before a session was captured. Re-run `stockbit-auth login` and log in " +
          "inside the new window it opens (a blank temporary profile) — logging into a different " +
          "browser window is not observed.",
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

    const tryCapture = async (requestId: string, sid?: string) => {
      const info = tracked.get(requestId);
      if (!info) return;
      if (!tokenUrlAllowed(info.url)) {
        dbg("skipped non-main token source", info.url);
        tracked.delete(requestId);
        return;
      }
      try {
        const res = await cdp.send("Network.getResponseBody", { requestId }, sid);
        const text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
        const json = JSON.parse(text);
        const refresh = extractRefresh(json);
        dbg("checked body", info.url, "-> refresh found:", Boolean(refresh));
        if (refresh) {
          getStore().set(refresh);
          logStderr("Session captured. You can close the browser window.");
          finish({ captured: true, refresh });
        }
      } catch (e) {
        dbg("getResponseBody failed", info.url, String(e));
      }
    };

    // Enable Network on every attached target (page/popup/OAuth window).
    cdp.on("Target.attachedToTarget", (p) => {
      const sid = (p as { sessionId?: string }).sessionId;
      const info = (p as any).targetInfo ?? {};
      dbg("attached", info.type, info.url);
      enableNetwork(sid);
    });

    // Track JSON responses and auth-relevant URLs; inspect their bodies for a refresh token.
    cdp.on("Network.responseReceived", (p, sid) => {
      const r = (p as any).response ?? {};
      const url: string = r.url ?? "";
      const mime: string = r.mimeType ?? "";
      const authish = /\/login|\/auth|social|refresh|token|session/i.test(url);
      if (mime.includes("json") || authish) {
        tracked.set((p as any).requestId, { sid, url });
        if (authish) dbg("candidate response", r.status, mime, url);
      }
    });

    // Some flows deliver the token over a WebSocket (e.g. wssocial). Scan frame payloads too.
    const scanWsFrame = (p: unknown) => {
      const payload: string = (p as any).response?.payloadData ?? "";
      if (!payload || !payload.includes("eyJ")) return;
      let refresh: string | null = null;
      try {
        refresh = extractRefresh(JSON.parse(payload));
      } catch {
        const m = payload.match(/"refresh(?:_token)?"\s*:\s*"(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[^"]+)"/i);
        refresh = m?.[1] ?? null;
      }
      dbg("ws frame scanned -> refresh found:", Boolean(refresh));
      if (refresh) {
        getStore().set(refresh);
        logStderr("Session captured (via socket). You can close the browser window.");
        finish({ captured: true, refresh });
      }
    };
    cdp.on("Network.webSocketFrameReceived", (p) => scanWsFrame(p));
    cdp.on("Network.webSocketFrameSent", (p) => scanWsFrame(p));

    // Try on both events — some XHR bodies are only retrievable at loadingFinished.
    cdp.on("Network.loadingFinished", (p, sid) => void tryCapture((p as any).requestId, sid));
    cdp.on("Network.responseReceived", (p, sid) => {
      // Best-effort early attempt for auth URLs (body often ready already).
      const url = (p as any).response?.url ?? "";
      if (/\/login|\/auth|social/i.test(url)) void tryCapture((p as any).requestId, sid);
    });

    // Enable Network at the root connection too (covers non-flattened event delivery).
    enableNetwork(undefined);

    // Attach to current + future targets, flattened onto this one connection.
    cdp
      .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      .then(() => dbg("setAutoAttach ok"))
      .catch((e) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          cleanup();
          reject(e as Error);
        }
      });
    cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});

    // Explicitly attach to already-open tabs (autoAttach doesn't always cover pre-existing ones).
    cdp
      .send("Target.getTargets")
      .then(async (res) => {
        let navigated = false;
        for (const t of (res?.targetInfos ?? []) as Array<{ targetId: string; type: string; url: string }>) {
          if (t.type === "page") {
            dbg("existing target", t.url);
            try {
              const attachedTarget = await cdp.send("Target.attachToTarget", {
                targetId: t.targetId,
                flatten: true,
              });
              const sid = attachedTarget?.sessionId as string | undefined;
              if (!sid) continue;

              // Await Network.enable before navigating so the login response cannot race capture.
              await cdp.send("Network.enable", {}, sid);
              attached.add(sid);
              if (!navigated) {
                navigated = true;
                await cdp.send("Page.navigate", { url: LOGIN_URL }, sid);
                dbg("navigated", LOGIN_URL);
              }
            } catch (e) {
              dbg("initial target setup failed", String(e));
            }
          }
        }
      })
      .catch((e) => dbg("getTargets failed", String(e)));
  });
}
