/**
 * The shared condition primitives: `resolveOperand`, `compileCondition`, `warmupFor`, and the
 * preset vocabulary.
 *
 * These moved out of the alerts module because three consumers need them — an alert on the latest
 * bar, a backtest walking every bar, and a scan across a universe. The tests here are about the
 * properties those three now share; `test/alerts.test.ts` still covers alert firing itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERLAY_NAMES,
  OVERLAY_PRESETS,
  PANEL_NAMES,
  PANEL_PRESETS,
  compileCondition,
  defineSeries,
  overlaysFrom,
  panelsFrom,
  resolveOperand,
  warmupFor,
} from "../src/analysis/series.ts";
import { ema, highest, lowest, macd, rsi, sma } from "../src/core/indicators.ts";
import type { Bar } from "../src/core/bars.ts";

const ANCHOR = Date.parse("2026-08-05T00:00:00Z");

function bars(closes: number[], highs?: number[], lows?: number[]): Bar[] {
  return closes.map((c, i) => ({
    date: new Date(ANCHOR - (closes.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    open: c,
    high: highs?.[i] ?? c + 2,
    low: lows?.[i] ?? c - 2,
    close: c,
    average: c,
    volume: 1000 + i,
    value: 1e9,
    frequency: 100,
    change: 0,
    changePercent: 0,
    foreignBuy: 0,
    foreignSell: 0,
    netForeign: 0,
  }));
}

/** A wave, so indicators actually move rather than sitting on a straight line. */
const WAVE = Array.from({ length: 600 }, (_, i) => 1000 + Math.sin(i / 7) * 80 + i * 0.2);

/* ---------------------------------- warm-up ---------------------------------- */

test("a terminating indicator asks for its window, not three times its window", () => {
  // The flat 3x this replaced asked for 151 bars to compute an SMA 50 and 601 for an SMA 200. At
  // twelve rows an upstream page that is eight and thirty-four requests bought for nothing, per
  // symbol — which over a universe scan is the difference between a query that returns and one
  // that times out.
  assert.equal(warmupFor([{ kind: "sma", period: 50 }], []), 51);
  assert.equal(warmupFor([{ kind: "sma", period: 200 }], []), 201);
  assert.equal(warmupFor([{ kind: "bollinger", period: 20, k: 2 }], []), 21);
  assert.equal(warmupFor([{ kind: "donchian", period: 20 }], []), 21);
  assert.equal(warmupFor([{ kind: "volumeSma", period: 20 }], []), 21);
});

test("REGRESSION: the shorter warm-up is not a shortcut — the value is identical", () => {
  // This is the assertion that makes the reduction safe rather than merely cheap. If a window were
  // being cut short, the SMA computed from exactly `warmupFor` bars would differ from the one
  // computed over the full history, and every scan hit would be subtly wrong.
  for (const period of [20, 50, 200]) {
    const need = warmupFor([{ kind: "sma", period }], []);
    const short = WAVE.slice(-need);
    const full = WAVE;
    assert.equal(
      sma(short, period).at(-1),
      sma(full, period).at(-1),
      `sma${period} from ${need} bars must equal sma${period} from ${full.length}`,
    );
  }
});

test("a converging indicator gets a wider window, because a bare one is still drifting", () => {
  assert.equal(warmupFor([], [{ kind: "rsi", period: 14 }]), 71);
  assert.equal(warmupFor([], [{ kind: "atr", period: 14 }]), 71);
  assert.equal(warmupFor([{ kind: "ema", period: 20 }], []), 101);
  assert.equal(warmupFor([], [{ kind: "macd", fast: 12, slow: 26, signal: 9 }]), 176);
});

test("REGRESSION: the converging multiple is 5 because 3 measurably is not enough", () => {
  // The negative control. Wilder smoothing never terminates — it decays toward the true value — so
  // treating RSI like an SMA hands back a number that is still moving. The multiple is 5 rather
  // than the folk rule of 3 because at 3x the residual is ~2.75 RSI points, which is the difference
  // between 29.9 and 32.6 — a screen hit and a miss on the commonest oversold condition there is.
  const settled = rsi(WAVE, 14).at(-1)!;
  const errAt = (multiple: number) => Math.abs(rsi(WAVE.slice(-(14 * multiple + 1)), 14).at(-1)! - settled);

  assert.ok(errAt(1) > 5, `a bare window is wildly off, was ${errAt(1)}`);
  assert.ok(errAt(3) > 0.5, `3x is still off by more than half a point (${errAt(3)}) — this is why it was raised`);
  assert.ok(errAt(5) < 0.25, `5x must be settled to well under a quarter point, was ${errAt(5)}`);

  // And the shipped warm-up is on the right side of that line.
  const shipped = rsi(WAVE.slice(-warmupFor([], [{ kind: "rsi", period: 14 }])), 14).at(-1)!;
  assert.ok(Math.abs(shipped - settled) < 0.25);
});

test("EMA and MACD converge too, so neither is treated as a terminating window", () => {
  const emaSettled = ema(WAVE, 20).at(-1)!;
  const emaShipped = ema(WAVE.slice(-warmupFor([{ kind: "ema", period: 20 }], [])), 20).at(-1)!;
  assert.ok(Math.abs(emaShipped - emaSettled) < 0.01);
  assert.ok(Math.abs(ema(WAVE.slice(-20), 20).at(-1)! - emaSettled) > 1, "a bare EMA window is not settled");

  const macdNeed = warmupFor([], [{ kind: "macd", fast: 12, slow: 26, signal: 9 }]);
  assert.ok(
    Math.abs(macd(WAVE.slice(-macdNeed)).histogram.at(-1)! - macd(WAVE).histogram.at(-1)!) < 0.01,
    "MACD is an EMA of a difference of EMAs, so both stages have to settle",
  );
});

test("the longest declared series decides, and a crossing gets its extra bar", () => {
  const need = warmupFor([{ kind: "sma", period: 20 }, { kind: "sma", period: 200 }], [{ kind: "rsi", period: 14 }]);
  assert.equal(need, 201, "the SMA 200 dominates a 43-bar RSI");
  assert.equal(warmupFor([], []), 2, "even an empty spec leaves room for the previous bar");
});

/* ------------------------------- compileCondition ------------------------------- */

test("warming up and condition-false are different answers at every index", () => {
  const b = bars(WAVE.slice(0, 60));
  const defs = defineSeries([{ kind: "sma", period: 50 }], []);
  const c = compileCondition({ left: "close", op: ">", right: "sma50" }, b, defs);

  assert.equal(c.warmingUpAt(10), true, "no SMA 50 exists at bar 10");
  assert.equal(c.holdsAt(10), false, "and it must not report as a satisfied condition either");
  assert.equal(c.warmingUpAt(55), false);
  assert.equal(c.firstValidIndex, 49, "the SMA 50's first value is at index 49");
});

test("a crossing needs the previous bar, so bar 0 can never carry one", () => {
  const b = bars([100, 105, 110]);
  const defs = defineSeries([], []);
  const cross = compileCondition({ left: "close", op: "crossover", right: 102 }, b, defs);
  const plain = compileCondition({ left: "close", op: ">", right: 102 }, b, defs);

  assert.equal(cross.warmingUpAt(0), true, "a crossing at bar 0 has nothing to cross from");
  assert.equal(plain.warmingUpAt(0), false, "a plain comparison does not need history");
  assert.equal(cross.firstValidIndex, 1);
  assert.equal(plain.firstValidIndex, 0);
  assert.equal(cross.holdsAt(1), true, "100 -> 105 crosses 102");
  assert.equal(cross.holdsAt(2), false, "105 -> 110 was already above");
});

test("firstValidIndex is -1 when the window can never satisfy the condition", () => {
  const b = bars(WAVE.slice(0, 20));
  const defs = defineSeries([{ kind: "sma", period: 200 }], []);
  const c = compileCondition({ left: "close", op: ">", right: "sma200" }, b, defs);
  assert.equal(c.firstValidIndex, -1);
  assert.equal(c.holdsAt(19), false);
});

test("an out-of-range index is warming up, not a crash and not a hit", () => {
  const b = bars([100, 101]);
  const c = compileCondition({ left: "close", op: ">", right: 50 }, b, defineSeries([], []));
  for (const i of [-1, 2, 999]) {
    assert.equal(c.warmingUpAt(i), true, `index ${i}`);
    assert.equal(c.holdsAt(i), false, `index ${i}`);
  }
});

/* -------------------------------- resolveOperand -------------------------------- */

test("a number becomes a constant series, so it shares the comparator's code path", () => {
  const b = bars([100, 101, 102]);
  assert.deepEqual(resolveOperand(4820, b, [], "left"), [4820, 4820, 4820]);
  assert.throws(() => resolveOperand(Number.NaN, b, [], "left"), /finite number/);
});

test("an unknown identifier names what IS available rather than just failing", () => {
  const defs = defineSeries([{ kind: "sma", period: 20 }], []);
  assert.throws(
    () => resolveOperand("sma99", bars([1, 2, 3]), defs, "right"),
    (err: unknown) => err instanceof Error && /sma20/.test(err.message) && /close/.test(err.message),
  );
});

/* ---------------------------------- new series ---------------------------------- */

test("donchian gives the breakout family a channel to cross", () => {
  const closes = WAVE.slice(0, 60);
  const highs = closes.map((c) => c + 5);
  const lows = closes.map((c) => c - 5);
  const b = bars(closes, highs, lows);
  const defs = defineSeries([{ kind: "donchian", period: 20 }], []);
  const ids = defs.map((d) => d.id);
  assert.deepEqual(ids, ["dcUpper20", "dcLower20", "dcMiddle20"]);

  assert.deepEqual(defs[0].compute(b), highest(highs, 20));
  assert.deepEqual(defs[1].compute(b), lowest(lows, 20));

  // The channel includes the current bar, matching ta.highest — so a new high never reads as
  // "above the channel". That is why the breakout condition is a crossover, not a `>`.
  const upper = defs[0].compute(b);
  assert.ok(b.every((bar, i) => upper[i] === null || bar.high <= upper[i]!));
});

test("a volume SMA makes volume confirmation expressible at all", () => {
  const b = bars(WAVE.slice(0, 40));
  const defs = defineSeries([{ kind: "volumeSma", period: 20 }], []);
  assert.equal(defs[0].id, "volSma20");
  assert.deepEqual(defs[0].compute(b), sma(b.map((x) => x.volume), 20));

  // And it resolves as an operand, which is the whole point.
  const c = compileCondition({ left: "volume", op: ">", right: "volSma20" }, b, defs);
  assert.equal(c.warmingUpAt(b.length - 1), false);
});

test("every declared series still carries BOTH halves, including the new ones", () => {
  const defs = defineSeries(Object.values(OVERLAY_PRESETS), Object.values(PANEL_PRESETS));
  const b = bars(WAVE.slice(0, 300));
  for (const def of defs) {
    assert.ok(def.pine.length > 0, `${def.id} has no Pine expression`);
    assert.equal(typeof def.compute, "function", `${def.id} has no local implementation`);
    assert.equal(def.compute(b).length, b.length, `${def.id} returned a misaligned series`);
  }
});

/* ----------------------------------- presets ----------------------------------- */

test("the preset vocabulary is one table, so a preset exists everywhere or nowhere", () => {
  // There were two identical copies of this inside register.ts and a third hand-rolled inside
  // price_chart that had fallen behind — it drew no ema50 and no ATR panel. A chart that silently
  // omits a line an alert rule references is worse than one that refuses the argument.
  assert.deepEqual([...OVERLAY_NAMES].sort(), Object.keys(OVERLAY_PRESETS).sort());
  assert.deepEqual([...PANEL_NAMES].sort(), Object.keys(PANEL_PRESETS).sort());
  assert.ok(OVERLAY_NAMES.includes("ema50"));
  assert.ok(PANEL_NAMES.includes("atr"));

  assert.deepEqual(overlaysFrom(["sma20", "bollinger"]), [
    { kind: "sma", period: 20 },
    { kind: "bollinger", period: 20, k: 2 },
  ]);
  assert.deepEqual(panelsFrom(["rsi"]), [{ kind: "rsi", period: 14 }]);
  assert.deepEqual(overlaysFrom(["nonsense"]), [], "an unknown name is dropped, not thrown");
  assert.deepEqual(overlaysFrom(), []);
});

test("every preset expands into something computable", () => {
  const b = bars(WAVE.slice(0, 300));
  for (const name of OVERLAY_NAMES) {
    const defs = defineSeries(overlaysFrom([name]), []);
    assert.ok(defs.length > 0, `${name} expanded to nothing`);
    for (const d of defs) assert.equal(d.compute(b).length, b.length);
  }
  for (const name of PANEL_NAMES) {
    const defs = defineSeries([], panelsFrom([name]));
    assert.ok(defs.length > 0, `${name} expanded to nothing`);
    for (const d of defs) assert.equal(d.compute(b).length, b.length);
  }
});
