/**
 * Candlestick pattern tests.
 *
 * The two that carry weight: the SAME candle must read as a hammer after a fall and a hanging man
 * after a rally (proving context is wired, not decorative), and the same SHAPE must score the same
 * at Rp 50 and at Rp 10,000 (proving thresholds are range-relative, not price-relative).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PATTERNS, detectPatterns, topPatterns, trendAt, type PatternId } from "../src/analysis/patterns.ts";
import type { Bar } from "../src/core/bars.ts";

const ANCHOR = Date.parse("2026-01-05T00:00:00Z");

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

function bars(candles: Candle[]): Bar[] {
  return candles.map((c, i) => ({
    date: new Date(ANCHOR + i * 86_400_000).toISOString().slice(0, 10),
    ...c,
    average: (c.high + c.low) / 2,
    volume: 10_000,
    value: 1e9,
    frequency: 500,
    change: 0,
    changePercent: 0,
    foreignBuy: 0,
    foreignSell: 0,
    netForeign: 0,
  }));
}

/**
 * A run of plain down candles, to establish a downtrend before a pattern.
 *
 * The wick scales with `step` rather than being a fixed number of rupiah. `trendAt` measures the
 * move against the stock's own ATR, so a fixed ±2 wick on a Rp 70 stock makes every bar's range
 * enormous relative to a Rp 0.6 step and the detector correctly answers "range". That is the
 * detector being right and the fixture being unrealistic — a stock that moves 0.9% a day does not
 * have a 5.7% daily range.
 */
function downtrend(from: number, count = 8, step = 12): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = from - i * step;
    const close = open - step * 0.8;
    return { open, high: open + step * 0.15, low: close - step * 0.15, close };
  });
}

function uptrend(from: number, count = 8, step = 12): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = from + i * step;
    const close = open + step * 0.8;
    return { open, high: close + step * 0.15, low: open - step * 0.15, close };
  });
}

/** The classic hammer shape, scaled to any price level. */
function hammerCandle(base: number, scale: number): Candle {
  return { open: base, high: base + 1 * scale, low: base - 20 * scale, close: base + 0.5 * scale };
}

function detectOne(candles: Candle[], only: PatternId[], opts = {}) {
  return detectPatterns(bars(candles), { only, ...opts });
}

/* ------------------------- context is part of the pattern ------------------------- */

test("the SAME candle is a hammer after a fall and a hanging man after a rally", () => {
  // They are literally the same shape. A detector that reports the shape and calls it the signal
  // will find bullish reversals at the top of every rally, confidently and forever.
  const after = hammerCandle(1000, 1);

  const afterFall = detectOne([...downtrend(1200), { ...after }], ["hammer", "hanging_man"]);
  const afterRally = detectOne([...uptrend(800), { ...after }], ["hammer", "hanging_man"]);

  assert.deepEqual(afterFall.map((d) => d.pattern), ["hammer"]);
  assert.equal(afterFall[0].context, "downtrend");
  assert.equal(afterFall[0].direction, "bullish");

  assert.deepEqual(afterRally.map((d) => d.pattern), ["hanging_man"]);
  assert.equal(afterRally[0].context, "uptrend");
  assert.equal(afterRally[0].direction, "bearish");
});

test("an inverted hammer and a shooting star are the same candle too", () => {
  const candle: Candle = { open: 1000, high: 1020, low: 999, close: 1001 };
  const afterFall = detectOne([...downtrend(1200), candle], ["inverted_hammer", "shooting_star"]);
  const afterRally = detectOne([...uptrend(800), candle], ["inverted_hammer", "shooting_star"]);

  assert.deepEqual(afterFall.map((d) => d.pattern), ["inverted_hammer"]);
  assert.deepEqual(afterRally.map((d) => d.pattern), ["shooting_star"]);
});

test("ignoreContext exists but is off, and reports both readings when asked", () => {
  const candles = [...uptrend(800), hammerCandle(1000, 1)];
  assert.equal(detectOne(candles, ["hammer"]).length, 0, "a hammer in an uptrend is not a hammer");
  assert.equal(detectOne(candles, ["hammer"], { ignoreContext: true }).length, 1);
});

test("trendAt measures the move against the stock's own volatility", () => {
  // A fixed percentage would call a 0.2% drift a downtrend on a quiet stock and miss a real one on
  // a noisy stock.
  assert.equal(trendAt(bars(downtrend(1200)), 7), "downtrend");
  assert.equal(trendAt(bars(uptrend(800)), 7), "uptrend");

  const flat = bars(Array.from({ length: 10 }, () => ({ open: 1000, high: 1005, low: 995, close: 1000 })));
  assert.equal(trendAt(flat, 8), "range");
  assert.equal(trendAt(bars(downtrend(1200)), 1), "range", "not enough history is a range, not a guess");
});

/* --------------------------- thresholds are range-relative --------------------------- */

test("the same SHAPE scores identically at Rp 50 and at Rp 10,000", () => {
  // A body worth 0.1% of price is an ordinary session on a big bank and physically impossible on a
  // stock whose tick is Rp 1. Every test in the module is a ratio for exactly this reason.
  const cheap = detectOne([...downtrend(70, 8, 0.6), hammerCandle(50, 0.05)], ["hammer"]);
  const dear = detectOne([...downtrend(14_000, 8, 120), hammerCandle(10_000, 10)], ["hammer"]);

  assert.equal(cheap.length, 1, "the cheap stock's hammer must be found");
  assert.equal(dear.length, 1, "and so must the expensive one's");
  assert.equal(cheap[0].confidence, dear[0].confidence, "identical shapes must score identically");
});

/* ------------------------------- degenerate sessions ------------------------------- */

test("a zero-range (ARA/ARB locked) bar produces no detection and no NaN", () => {
  // IDX auto-rejection gives high === low === close, which is 0/0 in every ratio in the module.
  // On small caps this is weekly, not exceptional.
  const locked: Candle = { open: 1200, high: 1200, low: 1200, close: 1200 };
  const detections = detectPatterns(bars([...downtrend(1400), locked]));

  assert.equal(detections.filter((d) => d.index === 8).length, 0);
  for (const d of detections) {
    for (const [key, value] of Object.entries(d.detail)) {
      assert.ok(Number.isFinite(value), `${d.pattern}.${key} was ${value}`);
    }
    assert.ok(Number.isFinite(d.confidence));
  }
});

test("a locked bar anywhere inside a multi-bar pattern's span disqualifies it", () => {
  const locked: Candle = { open: 1000, high: 1000, low: 1000, close: 1000 };
  const detections = detectPatterns(
    bars([...downtrend(1200), locked, { open: 990, high: 1100, low: 985, close: 1090 }]),
    { only: ["bullish_engulfing"] },
  );
  assert.equal(detections.length, 0);
});

/* --------------------------------- the pattern set --------------------------------- */

test("a bullish engulfing needs a real body to engulf, not a doji", () => {
  // Every candle engulfs a point. "Engulfing a doji" is not the pattern.
  const realBody = detectOne(
    [...downtrend(1200), { open: 1110, high: 1112, low: 1090, close: 1092 }, { open: 1085, high: 1125, low: 1082, close: 1120 }],
    ["bullish_engulfing"],
  );
  assert.equal(realBody.length, 1);
  assert.equal(realBody[0].direction, "bullish");

  const dojiPrev = detectOne(
    [...downtrend(1200), { open: 1100, high: 1112, low: 1090, close: 1100 }, { open: 1085, high: 1125, low: 1082, close: 1120 }],
    ["bullish_engulfing"],
  );
  assert.equal(dojiPrev.length, 0, "a zero-body previous candle is a doji, not something to engulf");
});

test("a morning star reports the bar that COMPLETES it", () => {
  const candles = [
    ...downtrend(1200),
    { open: 1110, high: 1112, low: 1050, close: 1055 }, // long down bar
    { open: 1045, high: 1050, low: 1035, close: 1042 }, // small star
    { open: 1050, high: 1110, low: 1048, close: 1105 }, // strong recovery
  ];
  const detections = detectOne(candles, ["morning_star"]);
  assert.equal(detections.length, 1);
  assert.equal(detections[0].index, candles.length - 1, "a three-bar pattern is reported at its last bar");
  assert.equal(detections[0].bars, 3);
  assert.equal(detections[0].date, bars(candles)[candles.length - 1].date);
});

test("three white soldiers must be a staircase, not a run of gaps", () => {
  const staircase = detectOne(
    [
      ...downtrend(1200),
      { open: 1100, high: 1152, low: 1098, close: 1150 },
      { open: 1130, high: 1202, low: 1128, close: 1200 },
      { open: 1180, high: 1252, low: 1178, close: 1250 },
    ],
    ["three_white_soldiers"],
  );
  assert.equal(staircase.length, 1);

  const gapped = detectOne(
    [
      ...downtrend(1200),
      { open: 1100, high: 1152, low: 1098, close: 1150 },
      { open: 1300, high: 1352, low: 1298, close: 1350 }, // opened above the prior body entirely
      { open: 1500, high: 1552, low: 1498, close: 1550 },
    ],
    ["three_white_soldiers"],
  );
  assert.equal(gapped.length, 0, "each candle must open INSIDE the previous body");
});

test("a doji is indecision, and its confidence rises as the body shrinks", () => {
  const wide = detectOne([{ open: 1000, high: 1050, low: 950, close: 1004 }], ["doji"]);
  const exact = detectOne([{ open: 1000, high: 1050, low: 950, close: 1000 }], ["doji"]);
  assert.equal(exact[0].direction, "indecision");
  assert.ok(exact[0].confidence > wide[0].confidence);
  assert.equal(exact[0].confidence, 1);
});

test("every pattern in the table is reachable and self-consistent", () => {
  for (const [id, def] of Object.entries(PATTERNS)) {
    assert.ok(def.label.length > 0, `${id} has no label`);
    assert.ok(def.bars >= 1 && def.bars <= 3, `${id} spans ${def.bars} bars`);
    assert.equal(typeof def.detect, "function");
  }
  assert.equal(Object.keys(PATTERNS).length, 16);
});

test("a context-free pattern needs no history; a reversal pattern does", () => {
  // One candle, no history at all. A hammer cannot be reported — there is no prior trend to make it
  // one — but the same candle IS a dragonfly doji, and a doji means the same thing whatever came
  // before it. Suppressing both would be treating "we have no context" as "the shape is absent".
  const alone = detectPatterns(bars([hammerCandle(1000, 1)]));

  assert.equal(alone.filter((d) => d.pattern === "hammer").length, 0, "a hammer without a downtrend is not a hammer");
  assert.deepEqual(alone.map((d) => d.pattern), ["doji"]);
  assert.equal(alone[0].context, "range", "no history reads as range, not as a guessed trend");

  // Multi-bar patterns cannot be reported before their own span exists either.
  assert.equal(detectPatterns(bars([hammerCandle(1000, 1)]), { only: ["morning_star"] }).length, 0);
});

/* ----------------------------------- the sweep ----------------------------------- */

test("minConfidence filters, and `since` restricts the window", () => {
  // A textbook hammer — 95% of its range is lower shadow — scores exactly 1.0, so filtering it
  // needs a mediocre one. This is a shorter shadow: still a hammer, visibly less of one.
  const perfect = [...downtrend(1400, 20), hammerCandle(1150, 1)];
  const mediocre = [...downtrend(1400, 20), { open: 1150, high: 1152, low: 1130, close: 1147 }];

  assert.equal(detectPatterns(bars(perfect), { only: ["hammer"] })[0].confidence, 1);
  const weak = detectPatterns(bars(mediocre), { only: ["hammer"], minConfidence: 0 });
  assert.equal(weak.length, 1);
  assert.ok(weak[0].confidence < 0.9, `a shorter shadow must score lower, got ${weak[0].confidence}`);
  assert.equal(detectPatterns(bars(mediocre), { only: ["hammer"], minConfidence: 0.9 }).length, 0);

  assert.equal(detectPatterns(bars(perfect), { only: ["hammer"], since: 1 }).length, 1);
  assert.equal(detectPatterns(bars(perfect), { only: ["hammer"], since: 0 }).length, 0);
});

test("topPatterns caps by confidence but returns them in chart order", () => {
  // The chart's marker layer has no collision avoidance and silently drops unlabelled markers, so
  // drawing every detection on a 120-bar chart gives an unreadable smear and no warning.
  const many = Array.from({ length: 20 }, (_, i) => ({
    pattern: "doji" as PatternId,
    label: "Doji",
    index: i,
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    direction: "indecision" as const,
    bars: 1,
    context: "range" as const,
    confidence: (i % 10) / 10,
    detail: {},
  }));
  const top = topPatterns(many, 5);
  assert.equal(top.length, 5);
  assert.deepEqual(top.map((d) => d.index), [...top.map((d) => d.index)].sort((a, b) => a - b));
  assert.ok(Math.min(...top.map((d) => d.confidence)) >= 0.5);
});

test("detections survive a JSON round trip unchanged", () => {
  const detections = detectPatterns(bars([...downtrend(1200), hammerCandle(1000, 1)]));
  assert.deepEqual(JSON.parse(JSON.stringify(detections)), detections);
});
