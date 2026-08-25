/**
 * Everything this project writes has to land inside the store, and the store has to move.
 *
 * `STOCKBIT_STORE_DIR` is what makes the test suite safe to run — without it, a test that renders a
 * chart writes a real file into the developer's home directory. It was honoured by nine modules and
 * ignored by one: `src/render/write.ts` hard-coded `~/.stockbit` at three sites, so every chart SVG,
 * every generated Pine script and every Chartbit screenshot escaped the sandbox. The bug was
 * invisible because the escape *succeeded* — a file was written, a path was returned, nothing threw.
 *
 * So this file asserts the property rather than the implementation: with the variable set, no path
 * helper and no writer may resolve outside it. A tenth module that forgets will fail here.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-paths-test-"));
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { stockbitDir, stockbitPath, chartsDir, pineDir } from "../src/paths.js";
import { defaultChartPath, defaultPinePath, writeChartPng, writeSvg, writePine } from "../src/render/write.js";
import { fileDir } from "../src/auth/store.js";
import { settingsPath } from "../src/settings.js";
import { alertLogPath } from "../src/alerts/notify.js";
import { orderLogPath } from "../src/trading/orders.js";
import { accountLogPath } from "../src/account/log.js";

after(() => rmSync(STORE, { recursive: true, force: true }));

/** True when `path` is `STORE` itself or lives under it — not merely string-prefixed by it. */
function insideStore(path: string): boolean {
  return path === STORE || path.startsWith(STORE + sep);
}

test("the store root is the environment variable when one is set", () => {
  assert.equal(stockbitDir(), STORE);
  assert.equal(stockbitPath("alerts.log"), join(STORE, "alerts.log"));
  assert.equal(stockbitPath("paper", "ledger.json"), join(STORE, "paper", "ledger.json"));
  assert.equal(chartsDir(), join(STORE, "charts"));
  assert.equal(pineDir(), join(STORE, "pine"));
});

test("the store root falls back to ~/.stockbit when nothing is set", () => {
  const saved = process.env.STOCKBIT_STORE_DIR;
  delete process.env.STOCKBIT_STORE_DIR;
  try {
    assert.ok(stockbitDir().endsWith(join(".stockbit")), `unexpected default: ${stockbitDir()}`);
    assert.ok(!insideStore(stockbitDir()));
  } finally {
    process.env.STOCKBIT_STORE_DIR = saved;
  }
});

test("it is read on every call, not captured at import", () => {
  const saved = process.env.STOCKBIT_STORE_DIR;
  const other = mkdtempSync(join(tmpdir(), "stockbit-paths-other-"));
  try {
    process.env.STOCKBIT_STORE_DIR = other;
    assert.equal(stockbitDir(), other);
  } finally {
    process.env.STOCKBIT_STORE_DIR = saved;
    rmSync(other, { recursive: true, force: true });
  }
  assert.equal(stockbitDir(), STORE);
});

test("every module that owns a file in the store resolves it under the store", () => {
  for (const [name, path] of [
    ["credential file dir", fileDir()],
    ["settings.json", settingsPath()],
    ["alerts.log", alertLogPath()],
    ["order-mutations.log", orderLogPath()],
    ["account-mutations.log", accountLogPath()],
  ] as const) {
    assert.ok(insideStore(path), `${name} escaped the store: ${path}`);
  }
});

test("default chart and Pine paths land in the store — this is the bug that hid", () => {
  const chart = defaultChartPath({ symbol: "BBRI", side: "buy", dataType: "daily" });
  const pine = defaultPinePath("BBRI", "main");
  assert.ok(insideStore(chart), `chart path escaped the store: ${chart}`);
  assert.ok(insideStore(pine), `pine path escaped the store: ${pine}`);
  assert.ok(chart.startsWith(join(STORE, "charts") + sep));
  assert.ok(pine.startsWith(join(STORE, "pine") + sep));
});

test("writeChartPng actually writes inside the store", () => {
  // 1x1 transparent PNG.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const at = new Date("2026-08-25T09:15:00Z");
  const written = writeChartPng("BBRI", png, at);
  assert.ok(insideStore(written), `screenshot escaped the store: ${written}`);
  assert.ok(existsSync(written));
  assert.ok(readFileSync(written).length > 0);
});

test("writeSvg and writePine force their extension and create parents", () => {
  const svg = writeSvg(join(chartsDir(), "nested", "deep", "x"), "<svg/>");
  assert.ok(svg.endsWith(".svg"));
  assert.equal(readFileSync(svg, "utf8"), "<svg/>");

  const pine = writePine(join(pineDir(), "y"), "//@version=5");
  assert.ok(pine.endsWith(".pine"));
  assert.equal(readFileSync(pine, "utf8"), "//@version=5");
});
