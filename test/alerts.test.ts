// Isolate the rule store before importing anything that reads it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-alerts-"));

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  describeCondition,
  evaluateRule,
  validateRule,
  warmupBars,
  type AlertRule,
} from "../src/alerts/rules.ts";
import { addRule, loadRules, newRuleId, removeRule, saveRules, updateRule } from "../src/alerts/store.ts";
import { defineSeries } from "../src/analysis/series.ts";
import { buildPine } from "../src/pine/emit.ts";
import { rsi, sma } from "../src/core/indicators.ts";
import type { Bar } from "../src/core/bars.ts";

/* ------------------------------------- fixtures ------------------------------------- */

const ANCHOR = Date.parse("2026-08-05T00:00:00Z");

function bar(i: number, close: number): Bar {
  return {
    date: new Date(ANCHOR - i * 86_400_000).toISOString().slice(0, 10),
    open: close, high: close + 2, low: close - 2, close, average: close,
    volume: 1000, value: 1e9, frequency: 100, change: 0, changePercent: 0,
    foreignBuy: 0, foreignSell: 0, netForeign: 0,
  };
}

/** Oldest-first series from a closes array given newest-last. */
function series(closes: number[]): Bar[] {
  return closes.map((c, i) => bar(closes.length - 1 - i, c));
}

const NOW = new Date("2026-08-05T10:00:00Z");

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "r1", symbol: "BBRI", name: "test",
    overlays: [], panels: [],
    left: "close", op: ">", right: 100,
    cooldownMinutes: 0, enabled: true, createdAt: NOW.toISOString(),
    ...over,
  };
}

beforeEach(() => saveRules([]));

/* ----------------------- the property that ties this to Pine ----------------------- */

test("an alert and its Pine alertcondition are the same condition over the same maths", () => {
  // Both sides expand the same overlays/panels through the same registry. If one grew its own
  // indicator list they would drift silently — a Wilder RSI here and a simple one there — and the
  // alert would fire on a day the chart says it should not have.
  const defs = defineSeries([{ kind: "sma", period: 20 }], [{ kind: "rsi", period: 14 }]);
  const ids = defs.map((d) => d.id);
  assert.deepEqual(ids, ["sma20", "rsi14"]);

  const pine = buildPine({
    symbol: "BBRI", kind: "indicator",
    overlays: [{ kind: "sma", period: 20 }], panels: [{ kind: "rsi", period: 14 }],
    signals: [{ name: "oversold", left: "rsi14", op: "<", right: 30 }],
    alerts: true,
  });
  for (const id of ids) assert.match(pine, new RegExp(`\\b${id} = `), `${id} missing from Pine`);

  // And the local compute for each id is the same function the technicals tool uses.
  const bars = series(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 10));
  const closes = bars.map((b) => b.close);
  assert.deepEqual(defs[0].compute(bars), sma(closes, 20));
  assert.deepEqual(defs[1].compute(bars), rsi(closes, 14));
});

test("every declared series carries BOTH a Pine expression and a local implementation", () => {
  // Adding one without the other makes alerts silently unevaluatable for that indicator.
  const defs = defineSeries(
    [{ kind: "sma", period: 20 }, { kind: "ema", period: 20 }, { kind: "bollinger", period: 20, k: 2 }],
    [{ kind: "rsi", period: 14 }, { kind: "atr", period: 14 }, { kind: "macd", fast: 12, slow: 26, signal: 9 }],
  );
  const bars = series(Array.from({ length: 200 }, (_, i) => 100 + i * 0.5));
  for (const def of defs) {
    assert.ok(def.pine.length > 0, `${def.id} has no Pine expression`);
    assert.equal(typeof def.compute, "function", `${def.id} has no local implementation`);
    const values = def.compute(bars);
    assert.equal(values.length, bars.length, `${def.id} returned a misaligned series`);
  }
});

test("the level asymmetry between alerts and Pine is deliberate, and the numeric literal bridges it", () => {
  // The module comment used to claim the two grammars were the same. They are the same for every
  // indicator, and deliberately not for support/resistance: Pine bakes a level in as a constant at
  // emission so TradingView plots the level derived from Stockbit's bars, while an alert evaluated
  // later would recompute the pivot clustering over a moved window and get a different price. The
  // two surfaces sharing a name while disagreeing on its value is worse than not sharing it.
  const alertRule = rule({ left: "close", op: "crossover", right: "sup1" });
  assert.throws(
    () => validateRule(alertRule),
    /not a declared series/,
    "an alert must refuse a level name rather than resolve it to a moving target",
  );

  // Pine accepts it, because there it is a literal written into the script.
  const pine = buildPine({
    symbol: "BBRI",
    kind: "indicator",
    overlays: [],
    panels: [],
    levels: [{ kind: "support", price: 4820, touches: 3 }],
    signals: [{ name: "breaks support", left: "close", op: "crossunder", right: "sup1" }],
    alerts: true,
  });
  assert.match(pine, /sup1 = 4820/, "Pine captures the level as a constant, not a computation");

  // And the bridge: the same condition as an alert, written the way Pine actually evaluates it.
  const asLiteral = rule({ left: "close", op: "crossunder", right: 4820 });
  assert.doesNotThrow(() => validateRule(asLiteral));
  const bars = series([4900, 4880, 4850, 4830, 4810]);
  const fired = evaluateRule(asLiteral, bars, NOW);
  assert.equal(fired.fired, true, "a fixed price is exactly what Pine's constant means");
  assert.equal(fired.rightValue, 4820);
});

/* -------------------------------- evaluation is honest -------------------------------- */

test("warming up is reported as warming up, not as a no", () => {
  // The difference matters: "not enough history yet" is worth waiting on, "condition false" is not.
  const bars = series([100, 101, 102]); // far too few for RSI 14
  const result = evaluateRule(rule({ panels: [{ kind: "rsi", period: 14 }], left: "rsi14", op: "<", right: 30 }), bars, NOW);
  assert.equal(result.fired, false);
  assert.equal(result.reason, "warming-up");
});

test("a null indicator is never treated as zero", () => {
  // If null read as 0, "rsi14 < 30" would fire on every symbol the first time it was checked.
  const bars = series([100, 101, 102]);
  const result = evaluateRule(rule({ panels: [{ kind: "rsi", period: 14 }], left: "rsi14", op: "<", right: 30 }), bars, NOW);
  assert.notEqual(result.reason, "condition-false");
  assert.equal(result.leftValue, null);
});

test("a simple threshold fires on the latest bar", () => {
  const bars = series([90, 95, 105]);
  const fired = evaluateRule(rule({ left: "close", op: ">", right: 100 }), bars, NOW);
  assert.equal(fired.fired, true);
  assert.equal(fired.leftValue, 105);
  assert.equal(fired.barDate, bars[bars.length - 1].date);

  const not = evaluateRule(rule({ left: "close", op: ">", right: 200 }), bars, NOW);
  assert.equal(not.fired, false);
  assert.equal(not.reason, "condition-false");
});

test("a crossover needs the previous bar and fires only on the bar it crosses", () => {
  const crossing = series([90, 95, 105]); // 95 -> 105 crosses 100
  assert.equal(evaluateRule(rule({ left: "close", op: "crossover", right: 100 }), crossing, NOW).fired, true);

  // Already above on both bars: still above, but not a crossing.
  const stayed = series([90, 105, 110]);
  const result = evaluateRule(rule({ left: "close", op: "crossover", right: 100 }), stayed, NOW);
  assert.equal(result.fired, false);
  assert.equal(result.reason, "condition-false");
});

test("crossunder is not just the negation of crossover", () => {
  const down = series([110, 105, 95]);
  assert.equal(evaluateRule(rule({ left: "close", op: "crossunder", right: 100 }), down, NOW).fired, true);
  assert.equal(evaluateRule(rule({ left: "close", op: "crossover", right: 100 }), down, NOW).fired, false);
  assert.equal(evaluateRule(rule({ left: "close", op: "cross", right: 100 }), down, NOW).fired, true);
});

test("two series can be compared against each other", () => {
  const bars = series([...Array.from({ length: 60 }, () => 100), ...Array.from({ length: 5 }, (_, i) => 100 + (i + 1) * 5)]);
  const r = rule({
    overlays: [{ kind: "sma", period: 20 }, { kind: "sma", period: 50 }],
    left: "sma20", op: ">", right: "sma50",
  });
  const result = evaluateRule(r, bars, NOW);
  assert.equal(result.fired, true, "a rising series should lift the fast MA above the slow one");
  assert.ok(result.leftValue !== null && result.rightValue !== null);
});

/* ---------------------------------- firing discipline ---------------------------------- */

test("a rule does not fire twice for the same bar", () => {
  // Checking twice in an afternoon must not alert twice for Tuesday's close.
  const bars = series([90, 95, 105]);
  const first = evaluateRule(rule(), bars, NOW);
  assert.equal(first.fired, true);

  const again = evaluateRule(rule({ lastFiredBar: first.barDate }), bars, NOW);
  assert.equal(again.fired, false);
  assert.equal(again.reason, "already-fired-this-bar");
});

test("a new bar re-arms the rule", () => {
  const bars = series([90, 95, 105]);
  const stale = evaluateRule(rule({ lastFiredBar: "2020-01-01" }), bars, NOW);
  assert.equal(stale.fired, true, "yesterday's fire must not suppress today's");
});

test("cooldown suppresses by time, and expires", () => {
  const bars = series([90, 95, 105]);
  const inside = evaluateRule(
    rule({ cooldownMinutes: 60, lastFiredAt: new Date(NOW.getTime() - 10 * 60_000).toISOString() }),
    bars, NOW,
  );
  assert.equal(inside.reason, "cooldown");

  const outside = evaluateRule(
    rule({ cooldownMinutes: 60, lastFiredAt: new Date(NOW.getTime() - 120 * 60_000).toISOString() }),
    bars, NOW,
  );
  assert.equal(outside.fired, true);
});

test("a disabled rule is never evaluated as fired", () => {
  const bars = series([90, 95, 105]);
  const result = evaluateRule(rule({ enabled: false }), bars, NOW);
  assert.equal(result.fired, false);
  assert.equal(result.reason, "disabled");
});

test("no bars is 'no data', not a silent false", () => {
  assert.equal(evaluateRule(rule(), [], NOW).reason, "no-data");
});

/* ------------------------------------- validation ------------------------------------- */

test("a rule referencing an undeclared series is refused at creation", () => {
  // Otherwise it sits in the file looking healthy and never fires — the worst kind of broken.
  assert.throws(() => validateRule(rule({ left: "rsi14", op: "<", right: 30 })), /not a declared series/);
  assert.throws(() => validateRule(rule({ left: "sma20", op: ">", right: "sma50" })), /Available:/);
  // Declared, so it validates.
  assert.doesNotThrow(() =>
    validateRule(rule({ panels: [{ kind: "rsi", period: 14 }], left: "rsi14", op: "<", right: 30 })),
  );
});

test("validation rejects the arguments that cannot work", () => {
  assert.throws(() => validateRule(rule({ symbol: "" })), /symbol is required/);
  assert.throws(() => validateRule(rule({ name: "   " })), /name is required/);
  assert.throws(() => validateRule(rule({ op: "≈" as never })), /Unknown operator/);
  assert.throws(() => validateRule(rule({ cooldownMinutes: -5 })), /zero or positive/);
  assert.throws(() => validateRule(rule({ right: Number.NaN })), /finite number/);
});

test("warmupBars asks for enough history for the slowest indicator", () => {
  assert.ok(warmupBars(rule({ overlays: [{ kind: "sma", period: 200 }] })) >= 200);
  // MACD needs slow + signal before its histogram means anything.
  const macdNeed = warmupBars(rule({ panels: [{ kind: "macd", fast: 12, slow: 26, signal: 9 }] }));
  assert.ok(macdNeed >= 35, `macd asked for only ${macdNeed} bars`);
});

test("describeCondition reads as English, not as an operator dump", () => {
  assert.equal(describeCondition({ left: "sma20", op: "crossover", right: "sma50" }), "sma20 crosses above sma50");
  assert.equal(describeCondition({ left: "rsi14", op: "<", right: 30 }), "rsi14 < 30");
});

/* --------------------------------------- store --------------------------------------- */

test("rules survive a round trip", () => {
  const r = rule({ id: newRuleId(), note: "watch this" });
  addRule(r);
  const loaded = loadRules();
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], r);
});

test("ids do not collide", () => {
  const ids = new Set(Array.from({ length: 500 }, () => newRuleId()));
  assert.equal(ids.size, 500);
});

test("update re-reads rather than trusting a caller's copy", () => {
  // Recording a fire must not resurrect a rule another process just deleted.
  const r = rule({ id: newRuleId() });
  addRule(r);
  removeRule(r.id);
  assert.equal(updateRule(r.id, { lastFiredBar: "2026-08-05" }), null);
  assert.equal(loadRules().length, 0, "the deleted rule must stay deleted");
});

test("update cannot change an id out from under the store", () => {
  const r = rule({ id: newRuleId() });
  addRule(r);
  const updated = updateRule(r.id, { id: "hijacked", name: "renamed" } as Partial<AlertRule>);
  assert.equal(updated?.id, r.id);
  assert.equal(updated?.name, "renamed");
});

test("removing something that is not there reports so instead of throwing", () => {
  assert.equal(removeRule("nope"), null);
});

test("a corrupt store degrades to no rules rather than taking the server down", () => {
  writeFileSync(join(process.env.STOCKBIT_STORE_DIR!, "alerts.json"), "{not json", "utf8");
  assert.deepEqual(loadRules(), []);
  // …and the file is left alone so it can be inspected.
  saveRules([]);
});
