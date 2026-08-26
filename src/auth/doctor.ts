/**
 * Preflight diagnostics.
 *
 * The point of this module is that a failed login should never again be a mystery. Every stage the
 * real capture depends on is exercised and reported separately, so "it didn't work" becomes a named
 * line item.
 *
 * The important stage is `captureSelfTest`, which runs the **real** `captureViaBrowserLogin` against
 * a local fixture that serves the token from a popup which then closes itself. That is the exact
 * shape that used to lose the token, and it is verified here without needing a real Stockbit login,
 * real credentials, or a live market.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDirWithRetry } from "./tempdir.js";
import { browserVersion, findBrowsers, type BrowserInfo } from "./browsers.js";
import { captureViaBrowserLogin } from "./login.js";
import { getStore, probeKeychainWrite } from "./store.js";
import { hasStoredSession } from "./session.js";
import { pinnedBrowserExists, readBrowserProfile } from "./browserprofile.js";
import { tradingPolicy } from "../settings.js";
import { decodeJwt } from "./session.js";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** A syntactically valid but meaningless JWT. Not a credential; it authorizes nothing. */
const FIXTURE_JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9." +
  Buffer.from(JSON.stringify({ exp: 4102444800, iss: "stockbit-mcp-selftest" })).toString("base64url") +
  ".self-test-not-a-real-signature";

/**
 * Fixture server. `/` opens a popup; only the **popup** fetches the token endpoint, and it closes
 * itself immediately afterwards. If capture still succeeds, the popup-race and body-lifetime fixes
 * are both working.
 */
function startFixture(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/social")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { token_data: { refresh: { token: FIXTURE_JWT } } } }));
      return;
    }
    if (url.startsWith("/popup")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><meta charset=utf-8><title>selftest popup</title><script>
         fetch('/api/social').then(r=>r.json()).then(()=>{ setTimeout(()=>window.close(), 30); });
         </script>`,
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><meta charset=utf-8><title>stockbit-mcp self-test</title>
       <body><p>stockbit-mcp self-test — this window closes itself.</p><script>
       window.open('/popup', 'selftest', 'width=420,height=420');
       </script>`,
    );
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Drive the real capture path against the fixture. Nothing is persisted: `persist:false` means a
 * successful self-test cannot overwrite the user's real stored token.
 */
export async function captureSelfTest(browserPath?: string): Promise<Check[]> {
  const checks: Check[] = [];
  let fixture: { server: Server; origin: string } | undefined;
  const profile = mkdtempSync(join(tmpdir(), "stockbit-selftest-"));

  try {
    fixture = await startFixture();
    const started = Date.now();
    const result = await captureViaBrowserLogin({
      timeoutMs: 60_000,
      startUrl: `${fixture.origin}/`,
      isTokenUrl: (u) => u.includes("/api/social"),
      fetchPatterns: [`${fixture.origin}/api/*`],
      browserPath,
      profileDir: profile,
      // The fixture opens its popup on load, with no user gesture behind it, so the popup blocker
      // would otherwise suppress the very thing under test.
      extraArgs: ["--disable-popup-blocking"],
      persist: false,
      quiet: true,
    });
    const ms = Date.now() - started;

    if (result.captured && result.refresh === FIXTURE_JWT) {
      checks.push({
        name: "Popup capture",
        status: "pass",
        detail: `token recovered from a self-closing popup in ${ms} ms`,
      });
    } else {
      checks.push({
        name: "Popup capture",
        status: "fail",
        detail: "capture returned, but not the fixture token — interception is misbehaving",
      });
    }
  } catch (err) {
    checks.push({
      name: "Popup capture",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    fixture?.server.close();
    // The browser was killed a moment ago and Windows has not released its handles yet, so an
    // immediate delete fails every time. Retry, and if it still fails say so — each leaked profile
    // is ~14 MB, and silently shedding one per run is how a temp directory fills up unnoticed.
    if (!(await removeDirWithRetry(profile))) {
      checks.push({
        name: "Temp cleanup",
        status: "warn",
        detail: `could not delete the self-test profile at ${profile} — safe to remove manually`,
      });
    }
  }
  return checks;
}

function describeBrowser(b: BrowserInfo): string {
  const version = browserVersion(b.path) || "version unknown";
  const note = b.supported ? "" : "  [unsupported — Firefox removed CDP in v141; use import-har]";
  return `${b.name} · ${version}${note}\n      ${b.path}`;
}

export interface DoctorOptions {
  /** Skip the browser-launching self-test (fast, offline-safe). */
  skipSelfTest?: boolean;
}

/** Run every diagnostic and return the checks in display order. */
export async function runDoctor(options: DoctorOptions = {}): Promise<Check[]> {
  const checks: Check[] = [];

  /* --------------------------------- browsers --------------------------------- */
  let browsers: BrowserInfo[] = [];
  try {
    browsers = findBrowsers();
  } catch (err) {
    checks.push({
      name: "Browsers",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  const drivable = browsers.filter((b) => b.supported);
  if (browsers.length === 0) {
    checks.push({
      name: "Browsers",
      status: "fail",
      detail: "none found. Set STOCKBIT_BROWSER, or use `stockbit-auth import-har`.",
    });
  } else {
    checks.push({
      name: "Browsers",
      status: drivable.length ? "pass" : "warn",
      detail: browsers.map(describeBrowser).join("\n    "),
    });
  }

  /* ------------------------------- token store ------------------------------- */
  let store: ReturnType<typeof getStore> | undefined;
  try {
    store = getStore();
    checks.push({
      name: "Token store",
      status: store.backend === "keychain" ? "pass" : "warn",
      detail:
        store.backend === "keychain"
          ? "macOS Keychain"
          : "AES-256-GCM file (machine+user derived key) — no OS keychain on this platform",
    });
  } catch (err) {
    checks.push({
      name: "Token store",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  /* --------------------------- how the Keychain is written --------------------------- */
  //
  // Machine-checked rather than asserted in a comment. `man security` recommends putting `-w` last
  // so the value is prompted for instead of passed in `argv`, but whether `security` will take that
  // value from a pipe depends on `readpassphrase` finding a controlling terminal — which differs
  // between an MCP server spawned by a client and the same command typed at a shell. The probe
  // writes a throwaway value under its own account name, reads it back, and deletes it, so the
  // answer comes from this machine and the real credential is never touched.
  if (store?.backend === "keychain") {
    try {
      const probe = probeKeychainWrite();
      checks.push({
        name: "Keychain write",
        status: probe.method === "stdin" ? "pass" : probe.method === "argv" ? "warn" : "fail",
        detail: probe.detail,
      });
    } catch (err) {
      checks.push({
        name: "Keychain write",
        status: "warn",
        detail: `could not be probed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /* ---------------------------------- token ---------------------------------- */
  try {
    const token = store?.get() ?? null;
    if (!token) {
      checks.push({
        name: "Refresh token",
        status: "warn",
        detail: "not set — run `stockbit-auth login`",
      });
    } else {
      const exp = decodeJwt(token)["exp"];
      if (typeof exp === "number") {
        const days = (exp - Date.now() / 1000) / 86400;
        checks.push({
          name: "Refresh token",
          status: days > 0 ? "pass" : "fail",
          detail:
            days > 0
              ? `present, expires in ~${days.toFixed(1)} day(s). Rotates on each refresh, so it ` +
                "keeps sliding as long as the server runs weekly."
              : "present but EXPIRED — run `stockbit-auth login`",
        });
      } else {
        checks.push({ name: "Refresh token", status: "warn", detail: "present (no exp claim)" });
      }
    }
  } catch (err) {
    checks.push({
      name: "Refresh token",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  /* ------------------------------ browser pin ------------------------------ */
  // The Chartbit driver opens the logged-in profile long after the login, and a Chromium profile is
  // not portable between browsers. Without this record the driver's likeliest failure is a
  // logged-out window reported as an empty chart.
  const pinned = readBrowserProfile();
  checks.push(
    pinned
      ? {
          name: "Chartbit driver",
          status: pinnedBrowserExists(pinned) ? "pass" : "fail",
          detail: pinnedBrowserExists(pinned)
            ? `profile pinned to ${pinned.browserName}${pinned.version ? ` ${pinned.version}` : ""}`
            : `pinned to ${pinned.browserPath}, which is no longer on disk — re-run \`stockbit-auth login\``,
        }
      : {
          name: "Chartbit driver",
          status: "warn",
          detail: "no browser pinned — run `stockbit-auth login` so drawing knows which browser holds the session",
        },
  );

  /* ------------------------------ trading side ------------------------------ */
  const policy = tradingPolicy();
  checks.push({
    name: "Trading policy",
    // Off is the CORRECT state, not a problem: this row reports, it does not nag.
    status: policy.corrupt ? "fail" : "pass",
    detail: policy.corrupt
      ? `${policy.settingsPath} could not be parsed; treated as no permission`
      : `${policy.enabled ? "enabled" : "off"} (${policy.source})` +
        (policy.autoConfirmIgnored ? " — autoConfirm set but ignored without a value cap" : ""),
  });
  checks.push({
    name: "Trading session",
    status: hasStoredSession("securities") ? "pass" : "warn",
    detail: hasStoredSession("securities")
      ? "securities credential present (validity not checked here — use `trading-status`)"
      : "not set — run `stockbit-auth trading-login` for portfolio and orders",
  });

  /* -------------------------------- self-test -------------------------------- */
  if (options.skipSelfTest) {
    checks.push({ name: "Popup capture", status: "skip", detail: "--skip-self-test" });
  } else if (!drivable.length) {
    checks.push({ name: "Popup capture", status: "skip", detail: "no drivable browser" });
  } else {
    checks.push(...(await captureSelfTest(drivable[0].path)));
  }

  return checks;
}

const ICON: Record<CheckStatus, string> = { pass: "✓", fail: "✗", warn: "!", skip: "-" };

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map((c) => `  ${ICON[c.status]} ${c.name.padEnd(width)}  ${c.detail}`)
    .join("\n");
}
