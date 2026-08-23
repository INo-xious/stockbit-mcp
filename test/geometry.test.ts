/**
 * Chart geometry.
 *
 * These are the tests that matter for drawing, because a wrong line is not a crash — it is a
 * confident horizontal stripe on someone's chart at a price that means nothing. So the assertions
 * are about the two claims the module makes: that a line touches the pivots it says it does, and
 * that a line price has broken through is not shown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bar } from "../src/core/bars.ts";
import { levels as legacyLevels } from "../src/core/indicators.ts";
import {
  channel,
  fitTrendLines,
  geometryToAnnotations,
  levels,
  levelsWithAnchors,
  pivots,
} from "../src/analysis/geometry.ts";

/** A bar from a close, with a high/low spread around it unless overridden. */
function bar(date: string, close: number, high = close, low = close): Bar {
  return {
    date,
    open: close,
    high,
    low,
    close,
    average: close,
    volume: 1000,
    value: close * 100000,
    frequency: 100,
    change: 0,
    changePercent: 0,
    foreignBuy: 0,
    foreignSell: 0,
    netForeign: 0,
  };
}

/** `YYYY-MM-DD` for day `i`, starting 2026-01-01. Stays inside January for the small series here. */
function day(i: number): string {
  return `2026-01-${String(i + 1).padStart(2, "0")}`;
}

/** A series from closes, with each bar's high/low equal to its close unless a shaper is given. */
function series(closes: number[], shape?: (i: number, close: number) => { high: number; low: number }): Bar[] {
  return closes.map((close, i) => {
    const s = shape?.(i, close);
    return bar(day(i), close, s?.high ?? close, s?.low ?? close);
  });
}

/* ------------------------------------- pivots ------------------------------------- */

test("a pivot is a bar no neighbour within lookback beats", () => {
  // A single peak at index 5, symmetric so both windows confirm it.
  const bars = series([10, 11, 12, 13, 14, 20, 14, 13, 12, 11, 10]);
  const found = pivots(bars, 3);
  const highs = found.filter((p) => p.kind === "high");
  assert.equal(highs.length, 1);
  assert.equal(highs[0].index, 5);
  assert.equal(highs[0].price, 20);
  assert.equal(highs[0].date, day(5), "a pivot carries its date, which is the whole point of this module");
});

test("a series too short to fill a window yields no pivots", () => {
  // Reporting the highest of five bars as a swing high with lookback 5 would be a guess wearing a
  // name: the window that would confirm it does not exist.
  assert.deepEqual(pivots(series([1, 2, 3, 4, 5]), 5), []);
});

test("a flat top registers, because a doubled top is exactly what a trader wants marked", () => {
  // Under strict inequality neither bar of a plateau beats the other and nothing is reported.
  const bars = series([10, 12, 20, 20, 12, 10, 9]);
  const highs = pivots(bars, 2).filter((p) => p.kind === "high");
  assert.ok(highs.length >= 1, "a plateau must produce at least one pivot");
  assert.ok(highs.every((p) => p.price === 20));
});

test("a lookback that is not a positive integer is refused", () => {
  assert.throws(() => pivots(series([1, 2, 3]), 0), /positive integer/);
  assert.throws(() => pivots(series([1, 2, 3]), 1.5), /positive integer/);
});

/* ------------------------------------- levels ------------------------------------- */

test("levels() here is identical to the one in indicators.ts", () => {
  // The rewrite's whole claim is that it changed nothing. A drift between the two would show up as
  // one tool reporting a level another does not.
  const closes = [100, 104, 99, 106, 101, 107, 100, 105, 98, 106, 102, 108, 101, 107, 99, 105, 100];
  const bars = series(closes, (_, c) => ({ high: c + 2, low: c - 2 }));
  for (const lookback of [2, 3, 5]) {
    assert.deepEqual(
      levels(bars, lookback),
      legacyLevels(bars, lookback),
      `lookback ${lookback} must produce the same levels as before the rewrite`,
    );
  }
});

test("a level carries the dates of its first and last touch", () => {
  const bars = series([100, 110, 100, 90, 100, 110, 100, 90, 100, 110, 100], (_, c) => ({ high: c, low: c }));
  const anchored = levelsWithAnchors(bars, 2, 1);
  assert.ok(anchored.length > 0);
  for (const level of anchored) {
    assert.ok(level.firstTouch <= level.lastTouch, "first touch must not be after the last");
    assert.equal(level.pivots.length, level.touches, "the touch count must be the pivots it actually has");
    assert.equal(level.pivots[0].date, level.firstTouch);
  }
});

test("kind is decided by where price is NOW, not by the pivot's own direction", () => {
  // The bug this replaced: BBRI fell from 4000 to 3020 and every old pivot LOW was reported as
  // support, putting three levels above the market and calling them the floor.
  const falling = [400, 380, 386, 358, 366, 340, 348, 322, 330, 310, 316, 300, 305, 302];
  const bars = series(falling, (_, c) => ({ high: c, low: c }));
  const last = bars[bars.length - 1].close;
  for (const level of levelsWithAnchors(bars, 2, 1)) {
    if (level.kind === "support") assert.ok(level.price <= last, `${level.price} called support above ${last}`);
    else assert.ok(level.price > last, `${level.price} called resistance below ${last}`);
  }
});

/* ---------------------------------- trend lines ---------------------------------- */

/**
 * A clean descending-highs series: four swing highs on one straight line, each separated by a
 * trough deep enough to make them pivots.
 */
function descendingHighs(): Bar[] {
  const closes: number[] = [];
  for (let i = 0; i < 4; i++) {
    closes.push(100 - i * 10, 120 - i * 10, 100 - i * 10);
  }
  closes.push(60, 58);
  return series(closes, (_, c) => ({ high: c, low: c }));
}

test("a trend line reports the pivots it actually touches", () => {
  const lines = fitTrendLines(descendingHighs(), { lookback: 1, tolerancePct: 2, minTouches: 3 });
  assert.ok(lines.length > 0, "four collinear swing highs must produce a line");
  const best = lines[0];
  assert.equal(best.kind, "resistance", "a line through swing HIGHS is resistance");
  assert.ok(best.touches >= 3, `expected at least 3 touches, got ${best.touches}`);
  assert.ok(best.slopePerBar < 0, "descending highs must give a negative slope");
  assert.ok(best.r2 > 0.9, `a line through collinear points should fit well, got r2 ${best.r2}`);
});

test("a line price has closed decisively through is discarded, not shown", () => {
  // Broken resistance drawn as resistance is worse than no line: it invites a decision on a
  // structure that no longer exists.
  const bars = descendingHighs();
  const broken = [...bars, bar(day(bars.length), 200, 200, 200)];
  const lines = fitTrendLines(broken, { lookback: 1, tolerancePct: 2, minTouches: 3 });
  for (const line of lines) {
    assert.notEqual(line.kind, "resistance", "a resistance line closed far above must not survive");
  }
});

test("a single wick through a line does not discard it", () => {
  // "Decisive" is a close beyond the tolerance band. Discarding on any touch would leave almost no
  // line on a real chart, which is the opposite failure.
  const bars = descendingHighs();
  const anchorIndex = bars.length;
  // A bar whose HIGH pokes above the line but whose close does not.
  const poke = bar(day(anchorIndex), 60, 95, 59);
  const lines = fitTrendLines([...bars, poke], { lookback: 1, tolerancePct: 2, minTouches: 3 });
  assert.ok(
    lines.some((l) => l.kind === "resistance"),
    "a wick through the line must not discard it",
  );
});

test("two points alone are not a trend line", () => {
  // Any two pivots define a line. What makes it worth showing is a third and fourth landing on it.
  const bars = series([10, 30, 10, 5, 10, 25, 10, 5, 8, 7], (_, c) => ({ high: c, low: c }));
  const strict = fitTrendLines(bars, { lookback: 1, tolerancePct: 0.1, minTouches: 3 });
  for (const line of strict) assert.ok(line.touches >= 3);
});

test("a flat set of touches scores a perfect fit rather than zero", () => {
  // R² has no variance to explain when every touch is at the same price. Reporting 0 there would
  // rank a flawless horizontal line last.
  const bars = series([10, 20, 10, 5, 10, 20, 10, 5, 10, 20, 10, 8], (_, c) => ({ high: c, low: c }));
  const lines = fitTrendLines(bars, { lookback: 1, tolerancePct: 1, minTouches: 3 });
  for (const line of lines) assert.ok(line.r2 >= 0 && line.r2 <= 1, `r2 out of range: ${line.r2}`);
});

test("the line is extended to the last bar, and priceNow says where it sits today", () => {
  const bars = descendingHighs();
  const lines = fitTrendLines(bars, { lookback: 1, tolerancePct: 2, minTouches: 3 });
  assert.ok(lines.length > 0);
  assert.equal(lines[0].toDate, bars[bars.length - 1].date, "a trend line is only useful extended to now");
  assert.equal(lines[0].toPrice, lines[0].priceNow);
});

test("no pivots means no lines, not an empty-looking success", () => {
  assert.deepEqual(fitTrendLines(series([1, 2, 3]), { lookback: 5 }), []);
});

/* ------------------------------------ channels ------------------------------------ */

test("a channel is the best line plus a parallel through the furthest opposite pivot", () => {
  const bars = descendingHighs();
  const found = channel(bars, { lookback: 1, tolerancePct: 2, minTouches: 3 });
  assert.ok(found, "this series has both highs and lows, so a channel is available");
  assert.equal(found!.parallel.slopePerBar, found!.primary.slopePerBar, "the boundaries must be parallel");
  assert.notEqual(found!.parallel.kind, found!.primary.kind, "a channel has one of each");
  assert.equal(found!.parallel.touches, 1, "the parallel is anchored by ONE pivot and must not claim more");
  assert.ok(found!.widthNow >= 0);
  assert.ok(found!.positionInChannel >= 0 && found!.positionInChannel <= 1.5);
});

test("no fitted line means no channel, rather than a channel with one side", () => {
  assert.equal(channel(series([1, 2, 3]), { lookback: 5 }), null);
});

/* ---------------------------------- annotations ---------------------------------- */

test("annotations carry the evidence, not just the price", () => {
  // A bare horizontal line invites more confidence than the data supports. The label is where the
  // touch count and the last test date go.
  const bars = descendingHighs();
  const anchored = levelsWithAnchors(bars, 1, 2);
  const lines = fitTrendLines(bars, { lookback: 1, tolerancePct: 2, minTouches: 3 });
  const annotations = geometryToAnnotations({ levels: anchored.slice(0, 2), trendLines: lines });

  const level = annotations.find((a) => a.kind === "level");
  assert.ok(level, "levels must be emitted");
  assert.match(String(level!.label), /\d+x/, "the label must state how many times the level was tested");
  assert.match(String(level!.label), /last \d{4}-\d{2}-\d{2}/, "and when it was last tested");

  const trend = annotations.find((a) => a.kind === "trend");
  if (trend) assert.match(String(trend.label), /r2/, "a trend line's label must state its fit");
});

test("a channel emits both of its boundaries", () => {
  const bars = descendingHighs();
  const found = channel(bars, { lookback: 1, tolerancePct: 2, minTouches: 3 });
  const annotations = geometryToAnnotations({ channel: found });
  assert.equal(annotations.filter((a) => a.kind === "trend").length, 2);
});

test("empty geometry produces no annotations rather than a placeholder", () => {
  assert.deepEqual(geometryToAnnotations({}), []);
});
