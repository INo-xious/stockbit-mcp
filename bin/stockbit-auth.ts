#!/usr/bin/env node
/**
 * Auth CLI.
 *
 *   stockbit-auth login       # one-time browser login; auto-captures your session (recommended)
 *   stockbit-auth bootstrap   # paste a refresh token manually (fallback if `login` can't run)
 *   stockbit-auth status      # show store backend + whether a token is present
 *   stockbit-auth logout      # clear the stored refresh token
 *
 * `login` opens your existing Chrome/Edge/Brave, you log into Stockbit normally, and the refresh
 * token is captured from the login response — no DevTools, no copy-paste. After that, the MCP
 * auto-refreshes indefinitely.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { bootstrap } from "../src/auth/bootstrap.js";
import { getStore } from "../src/auth/store.js";
import { decodeJwt, forceRefresh, resetSession } from "../src/auth/session.js";
import { captureViaBrowserLogin } from "../src/auth/login.js";
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

async function cmdLogin(): Promise<void> {
  logStderr("Opening a browser for a one-time Stockbit login…");
  const result = await captureViaBrowserLogin();
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

function cmdStatus(): void {
  const store = getStore();
  const token = store.get();
  logStderr(`Backend: ${store.backend}`);
  if (!token) {
    logStderr("Refresh token: NOT set. Run `stockbit-auth login` (or `bootstrap`).");
    return;
  }
  const exp = decodeJwt(token)["exp"];
  if (typeof exp === "number") {
    const days = ((exp - Date.now() / 1000) / 86400).toFixed(1);
    logStderr(`Refresh token: present, expires in ~${days} day(s).`);
  } else {
    logStderr("Refresh token: present (no exp in payload).");
  }
}

function cmdLogout(): void {
  getStore().clear();
  logStderr("Cleared stored refresh token.");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  switch (cmd) {
    case "login":
      await cmdLogin();
      break;
    case "bootstrap":
      await cmdBootstrap();
      break;
    case "status":
      cmdStatus();
      break;
    case "logout":
      cmdLogout();
      break;
    default:
      logStderr("Usage: stockbit-auth <login|bootstrap|status|logout>");
      logStderr("  login      one-time browser login, auto-captures your session (recommended)");
      logStderr("  bootstrap  paste a refresh token manually (fallback)");
      process.exit(2);
  }
}

main().catch((err) => {
  logStderr("stockbit-auth: error:", String(err));
  process.exit(1);
});
