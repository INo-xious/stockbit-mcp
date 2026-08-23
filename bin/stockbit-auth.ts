#!/usr/bin/env node
/**
 * Auth CLI.
 *
 *   stockbit-auth login       # one-time browser login; auto-captures your session (recommended)
 *   stockbit-auth bootstrap   # paste a refresh token manually (fallback if `login` can't run)
 *   stockbit-auth status      # show the store backend and verify the token still works
 *   stockbit-auth logout      # clear the stored refresh token
 *
 * `login` opens your existing Chrome/Edge/Brave, you log into Stockbit normally, and the refresh
 * token is captured from the login response — no DevTools, no copy-paste. After that, the MCP
 * auto-refreshes indefinitely.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, rmSync } from "node:fs";
import { bootstrap } from "../src/auth/bootstrap.js";
import { getStore } from "../src/auth/store.js";
import {
  decodeJwt,
  forceRefresh,
  hasStoredSession,
  missingSessionMessage,
  resetSession,
} from "../src/auth/session.js";
import { loginSecurities, logoutSecurities } from "../src/auth/tradinglogin.js";
import { securitiesTokenUrlAllowed } from "../src/auth/capture.js";
import { loadSettings, saveSettings, settingsPath, tradingPolicy } from "../src/settings.js";
import { captureViaBrowserLogin, defaultProfileDir } from "../src/auth/login.js";
import { clearBrowserProfile, readBrowserProfile } from "../src/auth/browserprofile.js";
import { removeDirWithRetry } from "../src/auth/tempdir.js";
import { explainMiss, scanHarFile } from "../src/auth/har.js";
import { formatChecks, runDoctor } from "../src/auth/doctor.js";
import { logStderr } from "../src/redact.js";

async function promptSecret(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  // Mute echo so the token isn't printed to the terminal as it's typed/pasted.
  const anyOut = stdout as unknown as { write: (s: string) => boolean };
  const origWrite = anyOut.write.bind(stdout);
  let muted = false;
  (stdout as unknown as { write: (s: string) => boolean }).write = (s: string) =>
    muted && s !== "\n" && s !== "\r\n" ? true : origWrite(s);
  stdout.write(question);
  muted = true;
  try {
    const answer = await rl.question("");
    return answer;
  } finally {
    muted = false;
    (stdout as unknown as { write: (s: string) => boolean }).write = origWrite;
    stdout.write("\n");
    rl.close();
  }
}

async function cmdDoctor(argv: string[]): Promise<void> {
  logStderr("stockbit-auth doctor — checking everything the login depends on…\n");
  const checks = await runDoctor({ skipSelfTest: argv.includes("--skip-self-test") });
  logStderr(formatChecks(checks));
  const failed = checks.filter((c) => c.status === "fail");
  logStderr(
    failed.length
      ? `\n${failed.length} check(s) failed: ${failed.map((c) => c.name).join(", ")}`
      : "\nAll checks passed.",
  );
  if (failed.length) process.exit(1);
}

/**
 * Import a login captured in ANY browser via a DevTools HAR export. This is the fallback for
 * browsers that cannot be driven (Safari has no reachable protocol; Firefox dropped CDP in v141).
 */
async function cmdImportHar(argv: string[]): Promise<void> {
  const path = argv.find((a) => !a.startsWith("--"));
  if (!path) {
    logStderr("Usage: stockbit-auth import-har <file.har> [--shred]");
    logStderr("");
    logStderr("  1. Open your browser's DevTools → Network panel.");
    logStderr("  2. Turn ON 'Preserve log' (Firefox: 'Persist Logs', Safari: 'Preserve Requests').");
    logStderr("  3. Clear the log, then log into stockbit.com with username + password.");
    logStderr("  4. Export the log to a .har file — in Chrome/Edge use the Export (download)");
    logStderr("     button, NOT 'Copy all as HAR' (that one omits response bodies).");
    logStderr("  5. Run this command on the file.");
    process.exit(2);
  }

  const report = scanHarFile(path);
  if (!report.match) {
    logStderr(explainMiss(report));
    process.exit(1);
  }

  logStderr(`Found a session token in entry #${report.match.entryIndex} (${report.match.url}).`);
  const result = await bootstrap(report.match.refresh);
  logStderr(`Stored in: ${result.backend}`);
  logStderr(`Test refresh: ${result.accessOk ? "OK ✓" : "FAILED — the token may already be stale"}`);

  if (argv.includes("--shred")) {
    try {
      rmSync(path, { force: true });
      logStderr(`Deleted ${path}.`);
    } catch (err) {
      logStderr(`Could not delete ${path}: ${String(err)}`);
    }
  } else {
    logStderr("");
    logStderr(`⚠ ${path} still contains your password, cookies and this token in plain text.`);
    logStderr("  Delete it now, or re-run with --shred to have this command remove it.");
  }
  if (!result.accessOk) process.exit(1);
}

async function cmdLogin(argv: string[]): Promise<void> {
  logStderr("Opening a browser for a one-time Stockbit login…");
  const result = await captureViaBrowserLogin({
    profileDir: argv.includes("--fresh-profile") ? "fresh" : undefined,
  });
  if (!result.captured) {
    logStderr("No session captured. You can retry, or use `stockbit-auth bootstrap`.");
    process.exit(1);
  }
  // Validate by minting a fresh access token from the captured refresh token.
  resetSession();
  try {
    await forceRefresh();
    logStderr("Test refresh: OK ✓  — you're set. Run stockbit-mcp.");
  } catch (err) {
    logStderr("Captured a token but the test refresh failed:", String(err));
    logStderr("The captured token may use a different refresh path — tell the maintainer this message.");
    process.exit(1);
  }
}

async function cmdBootstrap(): Promise<void> {
  const token = (await promptSecret("Paste refresh token (input hidden): ")).trim();
  if (!token) {
    logStderr("No token entered. Aborting.");
    process.exit(2);
  }
  const result = await bootstrap(token);
  logStderr(`Stored in: ${result.backend}`);
  logStderr(`Test refresh: ${result.accessOk ? "OK ✓" : "FAILED — verify the token / refresh host"}`);
  if (!result.accessOk) process.exit(1);
  logStderr("Bootstrap complete. You can now run stockbit-mcp.");
}

/**
 * Report what is stored, and — unless asked not to — whether it actually works.
 *
 * The expiry in the JWT payload is a *claim about time*, not a statement of validity. A refresh
 * token can be revoked, rotated out from under this store by another process, or invalidated
 * server-side, and none of that changes a byte of the payload. So this command used to answer
 * "present, expires in ~1.4 day(s)" for a token that 401s on its first use, which is the most
 * expensive kind of wrong answer: it sends you off to debug the thing you were about to do.
 *
 * One real refresh settles it. `--offline` keeps the old behaviour for when the network is not
 * available or a round trip is unwanted, and says plainly that it did not check.
 */
async function cmdStatus(argv: string[]): Promise<void> {
  const store = getStore();
  const token = store.get();
  logStderr(`Backend: ${store.backend}`);
  const pinned = readBrowserProfile();
  logStderr(
    pinned
      ? `Browser profile: ${pinned.browserName}${pinned.version ? ` ${pinned.version}` : ""} (${pinned.browserPath})`
      : "Browser profile: not pinned — Chartbit drawing needs `stockbit-auth login` to record one.",
  );
  // Every slot, not just the main one: "am I logged in?" now has three answers and a user
  // debugging a portfolio call needs to see which of them is missing.
  logStderr(`Trading session: ${hasStoredSession("securities") ? "present" : "not set (stockbit-auth trading-login)"}`);
  logStderr(`e-IPO session:   ${hasStoredSession("eipo") ? "present" : "not set (minted on first use)"}`);
  const policy = tradingPolicy();
  logStderr(`Order placing:   ${policy.enabled ? "ENABLED" : "off"} — ${policy.reason}`);

  if (!token) {
    logStderr("Refresh token: NOT set. Run `stockbit-auth login` (or `bootstrap`).");
    return;
  }

  const exp = decodeJwt(token)["exp"];
  const expiry =
    typeof exp === "number" ? `expires in ~${((exp - Date.now() / 1000) / 86400).toFixed(1)} day(s)` : "no exp in payload";

  if (argv.includes("--offline")) {
    logStderr(`Refresh token: present, ${expiry}.`);
    logStderr("Validity: NOT CHECKED (--offline). An expiry in the payload does not mean the token still works.");
    return;
  }

  logStderr(`Refresh token: present, ${expiry}. Checking it against Stockbit…`);
  try {
    await forceRefresh();
    logStderr("Validity: OK — the token refreshed successfully.");
  } catch (err) {
    logStderr(`Validity: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    logStderr("Run `stockbit-auth login` to re-authenticate.");
    process.exit(1);
  }
}

async function cmdLogout(argv: string[]): Promise<void> {
  getStore().clear();
  logStderr("Cleared stored refresh token.");

  // The pin describes a profile that is about to stop being logged in; leaving it would send the
  // Chartbit driver at a browser with no session and no explanation.
  clearBrowserProfile();

  // The persistent browser profile is a SECOND copy of the session: it holds Stockbit cookies and a
  // Login Data store, so clearing only the token leaves an artifact that can still log straight back
  // in. Logging out should mean logged out.
  const profile = defaultProfileDir();
  if (!existsSync(profile)) return;
  if (argv.includes("--keep-profile")) {
    logStderr(`Kept the browser profile at ${profile} (it still contains a logged-in session).`);
    return;
  }
  logStderr(
    (await removeDirWithRetry(profile))
      ? "Removed the logged-in browser profile."
      : `Could not remove the browser profile at ${profile} — delete it manually; it still ` +
        "contains a logged-in Stockbit session.",
  );
}

/* ------------------------------- trading commands ------------------------------- */

/**
 * Unlock the Stockbit Sekuritas session.
 *
 * The PIN is read through the same hidden prompt the refresh-token bootstrap uses, handed to one
 * request, and never stored. `--browser` is the Cloudflare fallback: Turnstile blocks the direct
 * call often enough that shipping the workaround later would have meant shipping a command that
 * fails for some users with no way forward.
 */
async function cmdTradingLogin(argv: string[]): Promise<void> {
  if (argv.includes("--browser")) {
    logStderr("Opening the logged-in browser so Cloudflare sees a real one. Enter your trading PIN there.");
    const result = await captureViaBrowserLogin({
      startUrl: "https://stockbit.com/trade",
      isTokenUrl: securitiesTokenUrlAllowed,
      fetchPatterns: ["*carina.stockbit.com/auth/*"],
      slot: "securities",
    });
    if (!result.captured) {
      logStderr("No trading session captured.");
      process.exit(1);
    }
    logStderr("Trading session captured.");
  } else {
    const pin = (await promptSecret("Trading PIN (6 digits, input hidden): ")).trim();
    if (!pin) {
      logStderr("No PIN entered. Aborting; nothing was sent.");
      process.exit(2);
    }
    try {
      const result = await loginSecurities({ pin });
      logStderr(`Trading session stored in: ${result.backend}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logStderr(`Trading login failed: ${message}`);
      if (/challenge/i.test(message)) {
        logStderr("");
        logStderr("This was a Cloudflare browser challenge, NOT a wrong PIN — do not retype it.");
        logStderr("Run `stockbit-auth trading-login --browser` instead.");
      }
      process.exit(1);
    }
  }

  // Prove it works before saying it does. A stored token that 401s on first use is the most
  // expensive kind of "success".
  try {
    await forceRefresh("securities");
    logStderr("Test refresh: OK - the trading session is live.");
  } catch (err) {
    logStderr(`Stored the trading session but the test refresh failed: ${String(err)}`);
    process.exit(1);
  }

  const policy = tradingPolicy();
  logStderr("");
  logStderr(
    policy.enabled
      ? "Trading is ENABLED in settings. Orders still require confirmation per call unless autoConfirm is on."
      : "Trading is still OFF. Logging in unlocks the account READS; run `stockbit-auth trading-enable` to " +
        "allow orders.",
  );
}

/** What the trading side is currently able to do, and why. */
async function cmdTradingStatus(argv: string[]): Promise<void> {
  const policy = tradingPolicy();
  logStderr(`Settings file: ${policy.settingsPath}`);
  logStderr(`Trading: ${policy.enabled ? "ENABLED" : "OFF"} (${policy.source})`);
  logStderr(`  ${policy.reason}`);
  if (policy.corrupt) logStderr("  WARNING: the settings file could not be parsed and was treated as no permission.");
  if (policy.autoConfirmIgnored) logStderr(`  ${policy.autoConfirmIgnored}`);
  logStderr(
    `  autoConfirm: ${policy.autoConfirm ? "on" : "off"}; ` +
      `maxOrderValueIdr: ${policy.maxOrderValueIdr ?? "none"}; ` +
      `maxLotsPerOrder: ${policy.maxLotsPerOrder}; ` +
      `allowedSymbols: ${policy.allowedSymbols.length ? policy.allowedSymbols.join(", ") : "any"}`,
  );

  if (!hasStoredSession("securities")) {
    logStderr(`Securities session: NOT set. ${missingSessionMessage("securities")}`);
    return;
  }
  if (argv.includes("--offline")) {
    logStderr("Securities session: present. Validity NOT CHECKED (--offline).");
    return;
  }
  logStderr("Securities session: present. Checking it against Stockbit...");
  try {
    await forceRefresh("securities");
    logStderr("Validity: OK - the trading token refreshed successfully.");
  } catch (err) {
    logStderr(`Validity: FAILED - ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function cmdTradingLogout(): Promise<void> {
  const result = await logoutSecurities();
  logStderr("Cleared the stored trading session.");
  if (result.remote === "ok") logStderr("Stockbit was told to end the session too.");
  else if (result.remote !== "skipped") {
    logStderr(`Note: the server-side logout did not succeed (${result.remote}).`);
    logStderr("The credential is gone from this machine either way; the session may still be open in your app.");
  }
}

/** Numeric flag value, e.g. `--max-order-value 5000000`. */
function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) return argv[index + 1];
  const inline = argv.find((a) => a.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

async function cmdTradingEnable(argv: string[]): Promise<void> {
  const settings = loadSettings();
  settings.trading.enabled = true;

  if (argv.includes("--auto-confirm")) settings.trading.autoConfirm = true;
  if (argv.includes("--no-auto-confirm")) settings.trading.autoConfirm = false;

  const maxValue = flagValue(argv, "--max-order-value");
  if (maxValue !== undefined) {
    const parsed = Number(maxValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logStderr(`--max-order-value must be a positive number of rupiah; got ${JSON.stringify(maxValue)}.`);
      process.exit(2);
    }
    settings.trading.maxOrderValueIdr = parsed;
  }

  const maxLots = flagValue(argv, "--max-lots");
  if (maxLots !== undefined) {
    const parsed = Number(maxLots);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logStderr(`--max-lots must be a positive number of lots; got ${JSON.stringify(maxLots)}.`);
      process.exit(2);
    }
    settings.trading.maxLotsPerOrder = Math.floor(parsed);
  }

  const symbols = flagValue(argv, "--symbols");
  if (symbols !== undefined) {
    settings.trading.allowedSymbols = symbols
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  saveSettings(settings);
  logStderr(`Trading ENABLED. Wrote ${settingsPath()}.`);
  const policy = tradingPolicy();
  if (policy.autoConfirmIgnored) logStderr(policy.autoConfirmIgnored);
  else if (policy.autoConfirm) {
    logStderr(
      `autoConfirm is ON for orders up to Rp ${policy.maxOrderValueIdr?.toLocaleString("en-US")}. ` +
        "Anything above that still needs confirm: true.",
    );
  } else {
    logStderr("Every order needs confirm: true. That is the default and it is the safe one.");
  }
  if (!hasStoredSession("securities")) {
    logStderr("");
    logStderr(`No trading session yet. ${missingSessionMessage("securities")}`);
  }
}

async function cmdTradingDisable(): Promise<void> {
  const settings = loadSettings();
  settings.trading.enabled = false;
  settings.trading.autoConfirm = false;
  saveSettings(settings);
  logStderr(`Trading DISABLED. Wrote ${settingsPath()}.`);
  logStderr("The order tools still exist and will now refuse, naming this file. The session is untouched.");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  const argv = process.argv.slice(3);
  switch (cmd) {
    case "login":
      await cmdLogin(argv);
      break;
    case "bootstrap":
      await cmdBootstrap();
      break;
    case "import-har":
      await cmdImportHar(argv);
      break;
    case "doctor":
      await cmdDoctor(argv);
      break;
    case "status":
      await cmdStatus(argv);
      break;
    case "logout":
      await cmdLogout(argv);
      break;
    case "trading-login":
      await cmdTradingLogin(argv);
      break;
    case "trading-status":
      await cmdTradingStatus(argv);
      break;
    case "trading-logout":
      await cmdTradingLogout();
      break;
    case "trading-enable":
      await cmdTradingEnable(argv);
      break;
    case "trading-disable":
      await cmdTradingDisable();
      break;
    default:
      logStderr(
        "Usage: stockbit-auth <login|import-har|doctor|bootstrap|status|logout|" +
          "trading-login|trading-status|trading-enable|trading-disable|trading-logout>",
      );
      logStderr("  login       one-time browser login, auto-captures your session (recommended)");
      logStderr("              --fresh-profile  use a throwaway browser profile");
      logStderr("  import-har  import a login captured in ANY browser via a DevTools HAR export");
      logStderr("  doctor      diagnose browsers, token store, and the capture path");
      logStderr("  bootstrap   paste a refresh token manually (fallback)");
      logStderr("  status      show store backend, token expiry, and whether it still works");
      logStderr("              --offline  skip the live validity check");
      logStderr("  logout      clear the stored refresh token AND the logged-in browser profile");
      logStderr("              --keep-profile  keep the browser profile (still logged in)");
      logStderr("");
      logStderr("  trading-login    unlock Stockbit Sekuritas with your 6-digit PIN (never stored)");
      logStderr("                   --browser  complete it in the logged-in browser (Cloudflare fallback)");
      logStderr("  trading-status   show the trading policy and whether the session still works");
      logStderr("                   --offline  skip the live validity check");
      logStderr("  trading-enable   ALLOW this server to place orders. Off until you run this.");
      logStderr("                   --max-order-value N  cap one order's value in IDR");
      logStderr("                   --max-lots N         cap one order's size in lots");
      logStderr("                   --symbols A,B        restrict trading to these tickers");
      logStderr("                   --auto-confirm       skip per-order confirmation (needs --max-order-value)");
      logStderr("  trading-disable  turn ordering off again. The session is left alone.");
      logStderr("  trading-logout   end the trading session and delete its credential");
      process.exit(2);
  }
}

main().catch((err) => {
  logStderr("stockbit-auth: error:", String(err));
  process.exit(1);
});
