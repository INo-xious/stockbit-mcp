import { test } from "node:test";
import assert from "node:assert/strict";
import {
  atr,
  bollinger,
  ema,
  latest,
  levels,
  macd,
  rsi,
  sma,
  smaNullable,
  type Series,
} from "../src/core/indicators.ts";
import type { Bar } from "../src/core/bars.ts";

const bar = (o: number, h: number, l: number, c: number, date = "2026-01-01"): Bar => ({
  date,
  open: o,
  high: h,
  low: l,
  close: c,
  average: c,
  volume: 0,
  value: 0,
  frequency: 0,
  change: 0,
  changePercent: 0,
  foreignBuy: 0,
  foreignSell: 0,
  netForeign: 0,
});

/* ------------------------------ alignment ------------------------------ */

test("every series is input-length with nulls for the warm-up, not a shortened array", () => {
  // Returning a shortened array would make callers re-derive the offset, and an off-by-one there
  // misaligns a signal against its own price without ever throwing.
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  for (const s of [sma(v, 3), ema(v, 3), rsi(v, 3), atr(v.map((x) => bar(x, x, x, x)), 3)] as Series[]) {
    assert.equal(s.length, v.length);
  }
  assert.deepEqual(sma(v, 3).slice(0, 2), [null, null], "SMA(3) is undefined for the first two bars");
  assert.equal(sma(v, 3)[2], 2, "and defined from the third");
});

test("a series shorter than the period is all nulls, not an error", () => {
  assert.deepEqual(sma([1, 2], 5), [null, null]);
  assert.deepEqual(ema([1, 2], 5), [null, null]);
  assert.deepEqual(rsi([1, 2], 14), [null, null]);
});

test("a non-positive or fractional period is rejected", () => {
  for (const bad of [0, -1, 2.5, NaN]) {
    assert.throws(() => sma([1, 2, 3], bad), /positive integer/);
  }
});

/* -------------------------------- averages -------------------------------- */

test("SMA is the plain mean of its window", () => {
  const s = sma([2, 4, 6, 8, 10], 3);
  assert.deepEqual(s, [null, null, 4, 6, 8]);
});

test("SMA of a flat series is that value", () => {
  assert.deepEqual(sma([5, 5, 5, 5], 2).slice(1), [5, 5, 5]);
});

test("EMA is seeded from the SMA, so one outlier bar cannot bias the whole series", () => {
  // Seeding from values[0] would let a spike propagate for hundreds of bars.
  const spiked = ema([1000, 1, 1, 1, 1, 1, 1, 1, 1, 1], 5);
  const clean = ema([1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 5);
  const drift = Math.abs(latest(spiked)! - latest(clean)!);
  assert.ok(drift < 60, `an early outlier still moves the tail by ${drift}`);
  assert.equal(clean[4], 1, "a flat series seeds at its own value");
});

test("EMA reacts to a step change faster than SMA", () => {
  // The real property of exponential weighting. On a LINEAR ramp the two converge — both lag by
  // about (n-1)/2 — so comparing them there proves nothing; a step is what separates them.
  const step = [...new Array(20).fill(100), ...new Array(5).fill(200)];
  const e = latest(ema(step, 10))!;
  const s = latest(sma(step, 10))!;
  assert.ok(e > s, `EMA (${e}) should have moved further toward the new level than SMA (${s})`);

  // And on a linear ramp they should be close, which is the thing that made the naive test fail.
  const ramp = Array.from({ length: 40 }, (_, i) => i + 1);
  assert.ok(Math.abs(latest(ema(ramp, 5))! - latest(sma(ramp, 5))!) < 1);
});

/* -------------------------------- momentum -------------------------------- */

test("RSI is 100 for an unbroken advance and near 0 for an unbroken decline", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  assert.equal(latest(rsi(up, 14)), 100, "no losses at all means RSI 100, not a divide-by-zero");
  assert.ok(latest(rsi(down, 14))! < 1);
});

test("RSI of a perfectly flat series is 50, not NaN", () => {
  assert.equal(latest(rsi(new Array(30).fill(100), 14)), 50);
});

test("RSI stays within 0..100", () => {
  const noisy = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 3) * 10 + (i % 7));
  for (const v of rsi(noisy, 14)) {
    if (v === null) continue;
    assert.ok(v >= 0 && v <= 100, `RSI out of range: ${v}`);
  }
});

test("MACD histogram is exactly macd minus signal wherever both exist", () => {
  const v = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5) * 8);
  const m = macd(v);
  let checked = 0;
  for (let i = 0; i < v.length; i++) {
    if (m.macd[i] === null || m.signal[i] === null) continue;
    assert.ok(Math.abs(m.histogram[i]! - (m.macd[i]! - m.signal[i]!)) < 1e-6);
    checked++;
  }
  assert.ok(checked > 50, "expected a long defined stretch to check");
});

test("MACD signal starts no earlier than the MACD line", () => {
  const v = Array.from({ length: 100 }, (_, i) => 100 + i);
  const m = macd(v);
  const firstMacd = m.macd.findIndex((x) => x !== null);
  const firstSignal = m.signal.findIndex((x) => x !== null);
  assert.ok(firstSignal >= firstMacd, "the signal cannot exist before the line it smooths");
});

/* ------------------------------- volatility ------------------------------- */

test("Bollinger bands straddle the middle and collapse onto it when flat", () => {
  const noisy = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i) * 5);
  const b = bollinger(noisy, 20, 2);
  for (let i = 19; i < noisy.length; i++) {
    assert.ok(b.upper[i]! >= b.middle[i]!, "upper band below the middle");
    assert.ok(b.lower[i]! <= b.middle[i]!, "lower band above the middle");
  }
  const flat = bollinger(new Array(40).fill(100), 20, 2);
  assert.equal(latest(flat.upper), 100, "zero variance means the bands sit on the mean");
  assert.equal(latest(flat.lower), 100);
});

test("ATR is non-negative and zero for a series that never moves", () => {
  const bars = Array.from({ length: 40 }, () => bar(100, 100, 100, 100));
  assert.equal(latest(atr(bars, 14)), 0);

  const moving = Array.from({ length: 40 }, (_, i) => bar(100 + i, 105 + i, 95 + i, 100 + i));
  const a = latest(atr(moving, 14))!;
  assert.ok(a > 0, "a moving series must have positive ATR");
});

test("ATR accounts for gaps, not just the intraday range", () => {
  // A bar that gaps far above the previous close has a true range larger than its own high-low.
  const flat = Array.from({ length: 20 }, () => bar(100, 101, 99, 100));
  const gapped = [...flat, bar(200, 201, 199, 200)];
  assert.ok(
    latest(atr(gapped, 14))! > latest(atr(flat, 14))!,
    "a gap must widen ATR even though the bar's own range is unchanged",
  );
});

/* -------------------------------- levels -------------------------------- */

test("levels finds a repeatedly-tested price and counts the touches", () => {
  // A price that turns down from ~110 three times should surface as one resistance with 3 touches.
  const bars: Bar[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const p of [100, 104, 108, 110, 108, 104, 100, 98, 100, 104]) {
      bars.push(bar(p, p + 0.5, p - 0.5, p));
    }
  }
  const res = levels(bars, 3, 2).filter((l) => l.kind === "resistance");
  assert.ok(res.length > 0, "expected at least one resistance level");
  assert.ok(res[0].touches >= 2, `strongest level should be multiply tested, got ${res[0].touches}`);
  assert.ok(Math.abs(res[0].price - 110.5) < 3, `expected a level near 110, got ${res[0].price}`);
});

test("levels returns nothing when there are too few bars to have a pivot", () => {
  assert.deepEqual(levels([bar(1, 1, 1, 1), bar(2, 2, 2, 2)], 5), []);
});

test("a level is support or resistance by where price is NOW, not by pivot type", () => {
  // Found against live data: BBRI fell from ~4000 to 3020 over the window, and labelling every old
  // pivot low "support" reported three levels ABOVE the market as the floor. Price fell through
  // them; broken support is overhead supply.
  // (levels 3860/3615/3580 reported as "support" while BBRI traded at 3020.)
  const bars: Bar[] = [];
  // Ramp up to 400, carving pivots on the way, then collapse to 300 and stay there.
  for (const p of [340, 360, 400, 360, 380, 400, 355, 390, 402, 350]) bars.push(bar(p, p + 1, p - 1, p));
  for (let i = 0; i < 30; i++) bars.push(bar(300, 301, 299, 300));

  const out = levels(bars, 3, 2);
  assert.ok(out.length > 0, "expected some levels");
  const lastClose = bars[bars.length - 1].close;
  for (const level of out) {
    const expected = level.price <= lastClose ? "support" : "resistance";
    assert.equal(level.kind, expected, `${level.price} labelled ${level.kind} with price at ${lastClose}`);
  }
  assert.equal(
    out.some((l) => l.kind === "support" && l.price > lastClose),
    false,
    "support above the market is not support",
  );
});

test("a price tested from both sides is ONE strong level, not two weak ones", () => {
  // Clustering per pivot-type split exactly the levels most worth seeing: a price that has acted as
  // both ceiling and floor is stronger evidence, not two unrelated touches.
  const bars: Bar[] = [];
  for (let cycle = 0; cycle < 3; cycle++) {
    // Oscillate tightly enough that pivot highs (~201.4) and pivot lows (~198.6) fall inside one
    // 3% band — that is the case the old per-kind clustering split in two.
    for (const p of [199, 200, 201, 200, 199, 200, 201]) bars.push(bar(p, p + 0.4, p - 0.4, p));
  }
  const near200 = levels(bars, 2, 3).filter((l) => Math.abs(l.price - 200) <= 6);
  assert.equal(near200.length, 1, `expected one merged level near 200, got ${JSON.stringify(near200)}`);
  assert.ok(near200[0].touches >= 4, `merged level should carry both sides' touches, got ${near200[0].touches}`);
});

test("levels ranks the best-tested level first", () => {
  const bars: Bar[] = [];
  for (let i = 0; i < 60; i++) {
    const p = 100 + (i % 10 === 5 ? 10 : 0);
    bars.push(bar(p, p + 0.2, p - 0.2, p));
  }
  const out = levels(bars, 2, 2);
  if (out.length > 1) {
    assert.ok(out[0].touches >= out[1].touches, "levels must be sorted by how well tested they are");
  }
});

/* --------------------------------- latest --------------------------------- */

test("latest skips trailing nulls and returns null for an empty or all-null series", () => {
  assert.equal(latest([1, 2, null]), 2);
  assert.equal(latest([null, null]), null);
  assert.equal(latest([]), null);
});


/* ------------------------------------------------------------------ *
 * Bollinger's variance is taken about the EXACT window mean.
 *
 * It used to read `middle[i]`, which `sma` has already put through `round(_, 4)` — a rounded mean
 * feeding a standard deviation. The file's own `highest` comment argues the principle a few lines
 * up: round the output, never the input to the next calculation. The series below is one where the
 * difference survives the output rounding, so this is a real guard and not a restatement.
 * ------------------------------------------------------------------ */

test("Bollinger centres its variance on the exact mean, not sma's rounded output", () => {
  // mean of [3,1,3] is 2.333…, which round(_, 4) turns into 2.3333.
  const b = bollinger([3, 1, 3], 3, 2);
  assert.equal(b.upper[2], 4.219, "the rounded-mean variance gave 4.2189 here");
  assert.equal(b.middle[2], 2.3333);

  const c = bollinger([1, 3, 1], 3, 2);
  assert.equal(c.lower[2], -0.219, "and 0.4477 / -0.2189 on the way down");

  // Recomputed from first principles, independently of the implementation.
  const window = [3, 1, 3];
  const mean = window.reduce((a, v) => a + v, 0) / 3;
  const sd = Math.sqrt(window.reduce((a, v) => a + (v - mean) ** 2, 0) / 3);
  assert.equal(b.upper[2], Number((mean + 2 * sd).toFixed(4)));
  assert.equal(b.lower[2], Number((mean - 2 * sd).toFixed(4)));
});

/* ------------------------------ a series with holes ------------------------------ */

test("smaNullable makes a window containing a hole null, rather than averaging what is left", () => {
  // Not the mean of the readable values: the mean of "three sessions, one of which we could not
  // read" is not the mean of the two we could, and reporting it as one answers a question nobody
  // asked. Not a zero substituted either — that pulls the average down and says nothing.
  // Windows of 3: index 4 is [null, 40, 50] and still holds the hole, so it is null too. Only
  // index 5 — [40, 50, 60], the first window clear of it — has a value.
  const out = smaNullable([10, 20, null, 40, 50, 60], 3);
  assert.deepEqual(out, [null, null, null, null, null, 50]);
});

test("smaNullable recovers once the hole leaves the window", () => {
  // The property `sma`'s rolling sum cannot have: one hole must not poison every later window.
  const out = smaNullable([null, 10, 20, 30], 2);
  assert.deepEqual(out, [null, null, 15, 25]);
});

test("smaNullable agrees with sma on a series with no holes", () => {
  const values = [10, 20, 30, 40, 50];
  assert.deepEqual(smaNullable(values, 3), sma(values, 3));
});
