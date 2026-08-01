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

/** Find a `refresh`/`refresh_token` JWT anywhere in a parsed response body. */
export function extractRefresh(body: unknown): string | null {
  const seen = new Set<object>();
  const walk = (o: unknown): string | null => {
    if (!o || typeof o !== "object" || seen.has(o)) return null;
    seen.add(o);
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (/^refresh(_token)?$/i.test(k) && looksLikeJwt(v)) return v;
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
export async function captureViaBrowserLogin(timeoutMs = 300_000): Promise<LoginResult> {
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
      LOGIN_URL,
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

  const cdp = await CDP.connect(wsUrl);
  const trackedUrls = new Map<string, string>(); // `${sessionId}:${requestId}` -> url

  return new Promise<LoginResult>((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      cdp.close();
      child.kill();
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("Login timed out — no session captured."));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();

    const finish = (result: LoginResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      resolve(result);
    };

    // Enable Network on every attached target (page/popup/OAuth window).
    cdp.on("Target.attachedToTarget", (p) => {
      const sid = (p as { sessionId?: string }).sessionId;
      cdp.send("Network.enable", {}, sid).catch(() => {});
    });

    // Only inspect bodies of auth-relevant responses.
    cdp.on("Network.responseReceived", (p, sid) => {
      const url = (p as any).response?.url ?? "";
      if (/\/login\/|\/auth\/|social|refresh/i.test(url)) {
        trackedUrls.set(`${sid}:${(p as any).requestId}`, url);
      }
    });

    cdp.on("Network.loadingFinished", async (p, sid) => {
      const key = `${sid}:${(p as any).requestId}`;
      if (!trackedUrls.has(key)) return;
      try {
        const res = await cdp.send("Network.getResponseBody", { requestId: (p as any).requestId }, sid);
        const text = res.base64Encoded ? Buffer.from(res.body, "base64").toString("utf8") : res.body;
        const json = JSON.parse(text);
        const refresh = extractRefresh(json);
        if (refresh) {
          getStore().set(refresh);
          logStderr("Session captured. You can close the browser window.");
          finish({ captured: true, refresh });
        }
      } catch {
        /* body gone or not JSON — ignore */
      }
    });

    // Attach to current + future targets, flattened onto this one connection.
    cdp
      .send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      .catch((e) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          cleanup();
          reject(e as Error);
        }
      });
    cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  });
}
