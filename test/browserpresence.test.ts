// Set BEFORE importing: nothing in this file may actually open a browser window on the machine
// running the tests.
process.env.STOCKBIT_NO_BROWSER = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserSuppressed,
  detectStockbit,
  ensureStockbitOpen,
  installedBrowsers,
  looksLikeStockbit,
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

test("the opt-out is read truthily, because a Desktop Extension checkbox arrives as \"true\"", () => {
  // Claude Desktop substitutes a boolean user setting into the environment as a string. An exact
  // match against "1" would have let someone tick "never open a browser window" and watch one open.
  const original = process.env.STOCKBIT_NO_BROWSER;
  try {
    for (const on of ["1", "true", "TRUE", " True ", "yes", "on"]) {
      process.env.STOCKBIT_NO_BROWSER = on;
      assert.equal(browserSuppressed(), true, `${JSON.stringify(on)} should suppress`);
      assert.equal(openUrl("https://stockbit.com/").via, "suppressed");
    }
    for (const off of ["0", "false", "FALSE", "no", "off", "", "   "]) {
      process.env.STOCKBIT_NO_BROWSER = off;
      assert.equal(browserSuppressed(), false, `${JSON.stringify(off)} should not suppress`);
    }
    delete process.env.STOCKBIT_NO_BROWSER;
    assert.equal(browserSuppressed(), false, "unset means not suppressed");
  } finally {
    // Every later test in this file depends on the suppression being back on.
    process.env.STOCKBIT_NO_BROWSER = original;
  }
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

test("a window title must be the Stockbit SITE, not merely contain the word", () => {
  // Found in the wild, not theorised: a tab on this project's own GitHub page,
  // "INo-xious/stockbit-mcp - Opera", reported Stockbit as open — so ensureStockbitOpen decided
  // there was nothing to do and the user was told to look at a chart that never opened.
  for (const title of [
    "Saham: BBRI - PT. Bank Rakyat Indonesia (Persero) Tbk. | Stockbit",
    "Stockbit - Investasi Saham Bersama Komunitas Saham Terbesar di Indonesia - Opera",
    "stockbit — Google Chrome",
  ]) {
    assert.equal(looksLikeStockbit(title), true, `should match: ${title}`);
  }
  for (const title of [
    "INo-xious/stockbit-mcp - Opera",
    "stockbit-mcp — Visual Studio Code",
    "stockbit.com/docs at main",
    "stockbit_notes.txt - Notepad",
    "GitHub - INo-xious/stockbit-mcp: unofficial MCP",
  ]) {
    assert.equal(looksLikeStockbit(title), false, `should NOT match: ${title}`);
  }

  // A title like "My stockbit project - File Explorer" DOES match this predicate, and that is
  // accepted rather than papered over: "stockbit" there is a standalone word and no string rule
  // separates it from "Stockbit - Investasi Saham" without also rejecting real page titles. It is
  // harmless because the predicate is only ever applied to BROWSER window titles — see the next
  // test. Tightening it further would trade a false positive that cannot occur for false negatives
  // that can.
  assert.equal(looksLikeStockbit("My stockbit project - File Explorer"), true);
});

test("only browser processes are considered, which is what makes the title rule safe", async () => {
  // The guard against non-browser windows is the process filter, not the title pattern.
  const presence = await detectStockbit();
  const browserish = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|google chrome|microsoft edge|safari)$/i;
  for (const name of presence.browsers) {
    assert.ok(browserish.test(name), `${name} is not a browser and should not have been counted`);
  }
  for (const match of presence.matches) {
    assert.ok(
      presence.browsers.some((b) => match.startsWith(b)),
      `match "${match}" is not attributed to a detected browser`,
    );
  }
});

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
