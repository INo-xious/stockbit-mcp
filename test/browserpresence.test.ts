// Set BEFORE importing: nothing in this file may actually open a browser window on the machine
// running the tests.
process.env.STOCKBIT_NO_BROWSER = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectStockbit,
  ensureStockbitOpen,
  installedBrowsers,
  openUrl,
  resolveBrowser,
  stockbitUrl,
} from "../src/desktop/browser.ts";
import { StockbitError } from "../src/http/errors.ts";

/* ------------------------------- the destination is ours ------------------------------- */

test("URLs are built from a validated symbol, not concatenated from input", () => {
  assert.equal(stockbitUrl("BBRI"), "https://stockbit.com/symbol/BBRI/chartbit");
  assert.equal(stockbitUrl("bbri"), "https://stockbit.com/symbol/BBRI/chartbit");
  assert.equal(stockbitUrl("BBRI", "symbol"), "https://stockbit.com/symbol/BBRI");
  assert.equal(stockbitUrl(undefined), "https://stockbit.com/");
  assert.equal(stockbitUrl("BBRI", "home"), "https://stockbit.com/");
  // "no symbol" and "empty symbol" mean the same thing to a caller; both land on the home page
  // rather than on a malformed /symbol// path.
  assert.equal(stockbitUrl(""), "https://stockbit.com/");
});

test("SECURITY: a hostile symbol cannot redirect the user's browser somewhere else", () => {
  // This function's output is handed to the OS default handler. If a symbol could steer it, this
  // would be an open redirect with the user's logged-in browser as the sink.
  const hostile = [
    "BBRI/../../evil",
    "..",
    "BBRI?next=https://evil.test",
    "BBRI#@evil.test",
    "https://evil.test",
    "BBRI evil",
    "  ",
  ];
  for (const symbol of hostile) {
    assert.throws(
      () => stockbitUrl(symbol),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      `${JSON.stringify(symbol)} must be rejected, not interpolated into a URL`,
    );
  }
});

test("every URL this module can produce points at stockbit.com and nowhere else", () => {
  for (const view of ["chart", "symbol", "home"] as const) {
    for (const symbol of [undefined, "BBRI", "BUKA-W"]) {
      const parsed = new URL(stockbitUrl(symbol, view));
      assert.equal(parsed.origin, "https://stockbit.com");
      assert.equal(parsed.username, "");
      assert.equal(parsed.password, "");
    }
  }
});

/* ----------------------------------- the opt-out holds ----------------------------------- */

test("STOCKBIT_NO_BROWSER suppresses opening entirely", () => {
  // The env var is set at the top of this file, so `opened: true` here would mean a real browser
  // window was launched on someone's machine by running the test suite.
  assert.deepEqual(openUrl("https://stockbit.com/"), { opened: false, via: "suppressed" });
  assert.deepEqual(openUrl("https://stockbit.com/", "Edge"), { opened: false, via: "suppressed" });
});

/* -------------------------------- choosing a browser -------------------------------- */

test("SECURITY: a caller cannot name an executable path, only an installed browser", () => {
  // Otherwise anything that can call the tool can launch an arbitrary binary.
  for (const hostile of [
    "C:\\Windows\\System32\\cmd.exe",
    "/bin/sh",
    "../../../../Windows/System32/calc.exe",
    "definitely-not-a-browser",
  ]) {
    assert.equal(resolveBrowser(hostile), null, `${hostile} must not resolve`);
  }
});

test("a browser is resolved by name, case- and substring-insensitively", () => {
  const installed = installedBrowsers();
  if (installed.length === 0) return; // nothing discoverable on this machine

  const first = installed[0];
  assert.equal(resolveBrowser(first)?.name, first, "an exact name should resolve");
  assert.equal(resolveBrowser(first.toUpperCase())?.name, first, "case should not matter");

  const word = first.split(/\s+/).pop()!; // e.g. "Edge" from "Microsoft Edge"
  const byWord = resolveBrowser(word);
  assert.ok(byWord, `"${word}" should resolve to an installed browser`);
});

test("every resolved browser is one of the installed ones", () => {
  const installed = new Set(installedBrowsers());
  for (const name of installed) {
    const hit = resolveBrowser(name);
    assert.ok(hit && installed.has(hit.name), `${name} resolved outside the installed set`);
  }
});

test("a requested browser that is not installed is reported, never silently downgraded", async () => {
  // Falling back to the default is how the user ends up staring at a blank page in the browser
  // they are not signed into — which is the bug this whole option exists to fix.
  const result = await ensureStockbitOpen({ symbol: "BBRI", browser: "NetscapeNavigator" });
  assert.equal(result.browserNotFound, "NetscapeNavigator");
  assert.equal(result.action, "suppressed");
  assert.ok(Array.isArray(result.installed), "it should say what IS available");
});

test("a suppressed open is reported as suppressed, not as success", async () => {
  const result = await ensureStockbitOpen({ symbol: "BBRI", force: true });
  assert.equal(result.action, "suppressed");
  assert.equal(result.url, "https://stockbit.com/symbol/BBRI/chartbit");
});

/* ------------------------------------- detection -------------------------------------- */

test("detection answers on this platform without throwing or launching anything", async () => {
  const presence = await detectStockbit();

  assert.equal(typeof presence.browserRunning, "boolean");
  assert.equal(typeof presence.stockbitOpen, "boolean");
  assert.equal(typeof presence.exact, "boolean");
  assert.ok(Array.isArray(presence.browsers));
  assert.ok(Array.isArray(presence.matches));
  assert.equal(presence.platform, process.platform);
});

test("a positive verdict always carries the evidence for it", async () => {
  // "Stockbit is open" with nothing to point at is a claim the user cannot check.
  const presence = await detectStockbit();
  if (presence.stockbitOpen) {
    assert.ok(presence.matches.length > 0, "stockbitOpen must be backed by a matched title or URL");
    assert.ok(presence.browserRunning, "a Stockbit page implies a running browser");
  }
});

test("resolution is reported honestly per platform", async () => {
  const presence = await detectStockbit();
  if (process.platform === "win32" || process.platform === "linux") {
    // Only each window's ACTIVE tab is visible here, so `false` must never be dressed up as certain.
    assert.equal(presence.exact, false);
  }
});

test("a missing helper binary degrades to a negative answer rather than an error", async () => {
  // `run()` resolves "" for ENOENT, so a box without tasklist/osascript/wmctrl still answers.
  const presence = await detectStockbit();
  assert.doesNotThrow(() => JSON.stringify(presence));
});
