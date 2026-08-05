// Isolate the rule store and the alert log before importing anything that reads them.
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-daemon-"));
// Nothing in this file may pop a notification on the machine running the tests.
delete process.env.STOCKBIT_ALERT_WEBHOOK;

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isMarketOpen, tick, watch } from "../src/alerts/daemon.ts";
import { alertLogPath, alertBody, alertTitle, isAcceptableWebhook, osaQuote, psQuote } from "../src/alerts/notify.ts";
import { loadRules, saveRules } from "../src/alerts/store.ts";
import type { AlertRule } from "../src/alerts/rules.ts";
import type { Bar } from "../src/core/bars.ts";

const ANCHOR = Date.parse("2026-08-05T00:00:00Z");

function bar(i: number, close: number): Bar {
  return {
    date: new Date(ANCHOR - i * 86_400_000).toISOString().slice(0, 10),
    open: close, high: close + 2, low: close - 2, close, average: close,
    volume: 1000, value: 1e9, frequency: 100, change: 0, changePercent: 0,
    foreignBuy: 0, foreignSell: 0, netForeign: 0,
  };
}
const series = (closes: number[]) => closes.map((c, i) => bar(closes.length - 1 - i, c));

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "r1", symbol: "BBRI", name: "above 100",
    overlays: [], panels: [], left: "close", op: ">", right: 100,
    cooldownMinutes: 0, enabled: true, createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

/** Desktop off and no webhook: delivery reduces to the log, which is what we assert on. */
const QUIET = { desktop: false as const, always: true as const };
const OPEN = new Date("2026-08-05T05:00:00Z"); // 12:00 WIB, a Wednesday

beforeEach(() => saveRules([]));

/* ----------------------------------- market hours ----------------------------------- */

test("market hours are judged in WIB, not in the machine's timezone", () => {
  // 09:00 WIB is 02:00 UTC. A daemon that used local time would poll all night for a box in
  // Jakarta and never poll at all for one in California.
  assert.equal(isMarketOpen(new Date("2026-08-05T03:00:00Z")), true, "10:00 WIB Wednesday");
  assert.equal(isMarketOpen(new Date("2026-08-05T00:00:00Z")), false, "07:00 WIB, before the open");
  assert.equal(isMarketOpen(new Date("2026-08-05T10:00:00Z")), false, "17:00 WIB, after the close");
});

test("weekends are closed", () => {
  assert.equal(isMarketOpen(new Date("2026-08-08T05:00:00Z")), false, "Saturday");
  assert.equal(isMarketOpen(new Date("2026-08-09T05:00:00Z")), false, "Sunday");
});

test("a closed market is skipped rather than polled, and says so", async () => {
  saveRules([rule()]);
  let fetched = 0;
  const result = await tick(async () => { fetched++; return series([90, 105]); }, new Date("2026-08-09T05:00:00Z"), { desktop: false });
  assert.equal(result.skipped, "market-closed");
  assert.equal(fetched, 0, "a guaranteed no-op should not cost a request");
});

test("--always overrides the market-hours check", async () => {
  saveRules([rule()]);
  const result = await tick(async () => series([90, 105]), new Date("2026-08-09T05:00:00Z"), QUIET);
  assert.notEqual(result.skipped, "market-closed");
  assert.equal(result.fired.length, 1);
});

/* -------------------------------------- ticking -------------------------------------- */

test("a tick fetches bars ONCE per symbol, not once per rule", async () => {
  // Ten rules on BBRI must not be ten pulls of the same series.
  saveRules([
    rule({ id: "a", right: 100 }),
    rule({ id: "b", right: 101 }),
    rule({ id: "c", right: 102 }),
    rule({ id: "d", symbol: "TLKM", right: 100 }),
  ]);
  const fetches: string[] = [];
  const result = await tick(async (symbol) => { fetches.push(symbol); return series([90, 105]); }, OPEN, QUIET);

  assert.deepEqual(fetches.sort(), ["BBRI", "TLKM"]);
  assert.equal(result.checked, 4);
});

test("a fired alert is recorded before delivery, so it cannot fire again next tick", async () => {
  saveRules([rule()]);
  const bars = series([90, 105]);
  const first = await tick(async () => bars, OPEN, QUIET);
  assert.equal(first.fired.length, 1);
  assert.equal(loadRules()[0].lastFiredBar, bars[bars.length - 1].date, "the fire must be persisted");

  const second = await tick(async () => bars, OPEN, QUIET);
  assert.equal(second.fired.length, 0, "the same bar must not fire twice");
  assert.equal(second.checked, 1, "but the rule is still being checked");
});

test("one dead symbol does not end the tick", async () => {
  saveRules([rule({ id: "ok", symbol: "BBRI" }), rule({ id: "dead", symbol: "GOTO" })]);
  const result = await tick(
    async (symbol) => {
      if (symbol === "GOTO") throw new Error("upstream 500");
      return series([90, 105]);
    },
    OPEN, QUIET,
  );
  assert.equal(result.fired.length, 1, "BBRI still has an answer");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /GOTO: upstream 500/);
});

test("a disabled rule is not fetched for or checked", async () => {
  saveRules([rule({ enabled: false })]);
  let fetched = 0;
  const result = await tick(async () => { fetched++; return series([90, 105]); }, OPEN, QUIET);
  assert.equal(result.skipped, "no-rules");
  assert.equal(fetched, 0);
});

test("dry-run reports what would fire without recording or delivering it", async () => {
  saveRules([rule()]);
  const result = await tick(async () => series([90, 105]), OPEN, { ...QUIET, dryRun: true });
  assert.equal(result.fired.length, 1);
  assert.equal(loadRules()[0].lastFiredBar, undefined, "dry-run must not mark the rule as fired");
  assert.equal(result.deliveries.length, 0);
});

test("a symbol filter narrows the tick", async () => {
  saveRules([rule({ id: "a", symbol: "BBRI" }), rule({ id: "b", symbol: "TLKM" })]);
  const result = await tick(async () => series([90, 105]), OPEN, { ...QUIET, symbol: "TLKM" });
  assert.equal(result.checked, 1);
  assert.equal(result.fired[0].symbol, "TLKM");
});

/* ------------------------------------- delivery ------------------------------------- */

test("every fired alert lands in the log, whatever else fails", async () => {
  // The log is the answer to "did it actually fire?" — a toast on a locked screen is not.
  saveRules([rule()]);
  await tick(async () => series([90, 105]), OPEN, QUIET);

  assert.ok(existsSync(alertLogPath()), "the log file should exist");
  const lines = readFileSync(alertLogPath(), "utf8").trim().split("\n").filter(Boolean);
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.symbol, "BBRI");
  assert.equal(entry.name, "above 100");
  assert.equal(entry.condition, "close > 100");
  assert.equal(entry.left, 105);
});

test("the log is append-only, so history cannot be overwritten", async () => {
  saveRules([rule()]);
  await tick(async () => series([90, 105]), OPEN, QUIET);
  const after1 = readFileSync(alertLogPath(), "utf8").trim().split("\n").length;

  saveRules([rule({ id: "r2", name: "second" })]);
  await tick(async () => series([90, 105]), OPEN, QUIET);
  const after2 = readFileSync(alertLogPath(), "utf8").trim().split("\n").length;
  assert.equal(after2, after1 + 1);
});

test("notification text names the symbol and shows the values that triggered it", () => {
  const event = {
    ruleId: "r", symbol: "BBRI", name: "RSI oversold", fired: true,
    condition: "rsi14 < 30", barDate: "2026-08-05", leftValue: 28.4, rightValue: 30,
  };
  assert.equal(alertTitle(event), "BBRI — RSI oversold");
  assert.match(alertBody(event), /rsi14 < 30/);
  assert.match(alertBody(event), /28\.40/);
  assert.match(alertBody(event), /2026-08-05/);
});

/* ------------------------------------- security ------------------------------------- */

test("SECURITY: a webhook may not silently send in plaintext to a remote host", () => {
  // The payload names the user's watchlist.
  assert.equal(isAcceptableWebhook("https://hooks.example.com/x"), true);
  assert.equal(isAcceptableWebhook("http://localhost:3000/x"), true);
  assert.equal(isAcceptableWebhook("http://127.0.0.1:3000/x"), true);
  assert.equal(isAcceptableWebhook("http://evil.test/x"), false);
  assert.equal(isAcceptableWebhook("ftp://evil.test/x"), false);
  assert.equal(isAcceptableWebhook("not a url"), false);
});

test("SECURITY: an alert name cannot break out of the notification command", () => {
  // Rule names are user-supplied and reach a shell-adjacent context on Windows.
  assert.equal(psQuote("it's fine"), "'it''s fine'");
  assert.equal(psQuote("'; Remove-Item C:\\ -Recurse; '"), "'''; Remove-Item C:\\ -Recurse; '''");
  assert.equal(osaQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(osaQuote("back\\slash"), '"back\\\\slash"');
});

/* --------------------------------------- watch --------------------------------------- */

test("watch stops when aborted", async () => {
  saveRules([]);
  const controller = new AbortController();
  const ticks: number[] = [];
  const running = watch(async () => series([90, 105]), {
    ...QUIET,
    intervalMs: 5,
    signal: controller.signal,
    onTick: () => {
      ticks.push(1);
      if (ticks.length >= 2) controller.abort();
    },
  });
  await running;
  assert.ok(ticks.length >= 2, "it should have ticked before stopping");
});

test("a throwing tick is reported and the loop survives", async () => {
  // A daemon that dies on the first network blip is worse than none: the user believes it is
  // still watching.
  saveRules([rule()]);
  const controller = new AbortController();
  const seen: string[][] = [];
  let calls = 0;
  await watch(
    async () => {
      calls++;
      if (calls === 1) throw new Error("blip");
      return series([90, 105]);
    },
    {
      ...QUIET,
      intervalMs: 5,
      signal: controller.signal,
      onTick: (result) => {
        seen.push(result.errors);
        if (seen.length >= 2) controller.abort();
      },
    },
  );
  assert.ok(seen[0].some((e) => /blip/.test(e)), "the first tick's error should be reported");
  assert.equal(seen.length >= 2, true, "and the loop kept going");
});
