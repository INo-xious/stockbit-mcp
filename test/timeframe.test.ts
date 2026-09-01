/**
 * Resampling and multi-timeframe alignment.
 *
 * The load-bearing tests are the honest ones: an indicator that cannot settle at a timeframe must
 * be `null` rather than computed from a short window, and the "no intraday OHLC exists" sentence
 * must ship inside the payload — locked here the same way `permittedRequests()` is locked in
 * `test/transport.test.ts`, so it cannot quietly vanish in a refactor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_INTRADAY_LIMIT,
  RESAMPLED_LIMIT,
  alignment,
  bucketKey,
  resample,
} from "../src/analysis/timeframe.ts";
import type { Bar } from "../src/core/bars.ts";

/** Sessions from a start date, weekdays only — the shape a real IDX series has. */
function sessions(startIso: string, count: number, priceAt: (i: number) => number): Bar[] {
  const out: Bar[] = [];
  let ms = Date.parse(`${startIso}T00:00:00Z`);
  let prev = priceAt(0);
  while (out.length < count) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) {
      const i = out.length;
      const close = priceAt(i);
      out.push({
        date: new Date(ms).toISOString().slice(0, 10),
        open: prev,
        high: Math.max(prev, close) + 2,
        low: Math.min(prev, close) - 2,
        close,
        average: (prev + close) / 2,
        volume: 1000 + i,
        value: (1000 + i) * close * 100,
        frequency: 100,
        change: 0,
        changePercent: 0,
        foreignBuy: 10,
        foreignSell: 5,
        netForeign: 5,
      });
      prev = close;
    }
    ms += 86_400_000;
  }
  return out;
}

/* ------------------------------------- bucketing ------------------------------------- */

test("weekly buckets key on the ISO Monday, computed in UTC", () => {
  // Parsing "2026-08-09" in local time shifts the weekday for roughly half the world, which would
  // put Sunday's session in the wrong week for those users and nobody else — the worst kind of bug.
  assert.equal(bucketKey("2026-08-03", "W"), "2026-08-03", "a Monday is its own week");
  assert.equal(bucketKey("2026-08-07", "W"), "2026-08-03", "Friday belongs to that Monday");
  assert.equal(bucketKey("2026-08-09", "W"), "2026-08-03", "and so does the Sunday after it");
  assert.equal(bucketKey("2026-08-10", "W"), "2026-08-10", "the next Monday starts a new week");
});

test("monthly buckets are a string prefix, so no timezone can move them", () => {
  assert.equal(bucketKey("2026-08-01", "M"), "2026-08");
  assert.equal(bucketKey("2026-08-31", "M"), "2026-08");
  assert.equal(bucketKey("2026-09-01", "M"), "2026-09");
});

/* ------------------------------------ resampling ------------------------------------ */

test("a weekly bar is labelled by its LAST session, never its first", () => {
  // Labelling by period start makes a two-day partial week read as a complete week that has not
  // happened yet. Labelling by close never claims a session that does not exist.
  const daily = sessions("2026-08-03", 15, (i) => 1000 + i);
  const weekly = resample(daily, "W", { includePartial: true });

  assert.equal(weekly.bars[0].date, "2026-08-07", "the first full week ends on its Friday");
  assert.ok(weekly.bars.every((b) => daily.some((d) => d.date === b.date)), "every label is a real session");
});

test("OHLC folds correctly and the sums are sums", () => {
  const daily = sessions("2026-08-03", 5, (i) => 1000 + i * 10);
  const weekly = resample(daily, "W", { includePartial: true });

  assert.equal(weekly.bars.length, 1);
  const w = weekly.bars[0];
  assert.equal(w.open, daily[0].open, "open is the first session's open");
  assert.equal(w.close, daily[4].close, "close is the last session's close");
  assert.equal(w.high, Math.max(...daily.map((d) => d.high)));
  assert.equal(w.low, Math.min(...daily.map((d) => d.low)));
  assert.equal(w.volume, daily.reduce((a, d) => a + d.volume, 0));
  assert.equal(w.frequency, daily.reduce((a, d) => a + d.frequency, 0));
  assert.equal(w.netForeign, daily.reduce((a, d) => a + d.netForeign, 0));
  assert.equal(weekly.sessionsPerBar[0], 5);
});

test("one unreadable session makes the whole bucket unreadable, not a partial week reported as whole", () => {
  // All-or-nothing on purpose. Summing only the legible sessions would present four days as five,
  // and a weekly volume carries nothing that says how many days went into it — so the invention
  // would be undetectable downstream. `sessionsPerBar` counts sessions, not legible ones.
  const daily = sessions("2026-08-03", 5, (i) => 1000 + i);
  daily[2] = { ...daily[2], netForeign: null, volume: null };
  const weekly = resample(daily, "W", { includePartial: true });
  const w = weekly.bars[0];

  assert.equal(w.netForeign, null, "four days of foreign flow is not this week's foreign flow");
  assert.equal(w.volume, null);
  assert.equal(w.value, daily.reduce((a, d) => a + (d.value as number), 0), "a field that WAS complete still sums");
  assert.equal(w.close, daily[4].close, "and the price bar is unaffected — close is never absent");
  assert.equal(weekly.sessionsPerBar[0], 5);
});

test("a bucket with no readable volume falls back to the last session's average rather than a NaN VWAP", () => {
  const daily = sessions("2026-08-03", 5, (i) => 1000 + i);
  const holed = daily.map((d) => ({ ...d, volume: null }));
  const w = resample(holed, "W", { includePartial: true }).bars[0];
  assert.equal(w.volume, null);
  assert.equal(w.average, holed[4].average, "the documented fallback, not a division by an absent total");
  assert.ok(Number.isFinite(w.average));
});

test("the weekly average is volume-WEIGHTED, not a mean of daily averages", () => {
  // Unweighted makes a 100-lot session count as much as a 10,000-lot one.
  const daily = sessions("2026-08-03", 2, (i) => (i === 0 ? 1000 : 2000));
  daily[0].volume = 1;
  daily[0].average = 1000;
  daily[1].volume = 999;
  daily[1].average = 2000;

  const weekly = resample(daily, "W", { includePartial: true });
  const unweighted = (1000 + 2000) / 2;
  const weighted = (1000 * 1 + 2000 * 999) / 1000;

  assert.ok(Math.abs(weekly.bars[0].average - weighted) < 0.01, `expected ${weighted}, got ${weekly.bars[0].average}`);
  assert.notEqual(weekly.bars[0].average, unweighted);
});

test("changePercent is recomputed against the previous bucket, not summed", () => {
  // Daily percent changes compound; summing them is arithmetically wrong and looks right to three
  // decimal places.
  const daily = sessions("2026-08-03", 10, (i) => 1000 * 1.1 ** i);
  const weekly = resample(daily, "W", { includePartial: true });

  // null, not 0. The comment this assertion has always carried — "nothing to change from" — is the
  // argument for it: there is no prior bucket in this window, which is not the same as a week that
  // moved nowhere, and a reader cannot tell those apart from a zero.
  assert.equal(weekly.bars[0].changePercent, null, "the first bucket has nothing to change from");
  assert.equal(weekly.bars[0].change, null);
  const expected = ((weekly.bars[1].close - weekly.bars[0].close) / weekly.bars[0].close) * 100;
  assert.ok(Math.abs((weekly.bars[1].changePercent as number) - expected) < 1e-3);
});

test("the trailing bucket is dropped as partial unless asked for", () => {
  // A bucket is complete iff a later one exists in the input. That needs no holiday calendar and
  // errs in the right direction: a weekly RSI computed on a Wednesday's three-day 'week'
  // reconciles with no chart anywhere.
  const daily = sessions("2026-08-03", 8, (i) => 1000 + i); // one full week plus three days
  const dropped = resample(daily, "W");
  const kept = resample(daily, "W", { includePartial: true });

  assert.equal(kept.bars.length, dropped.bars.length + 1);
  assert.equal(dropped.partialLast, true, "it is still REPORTED as having been partial");
  assert.equal(dropped.bars.length, 1);
  assert.equal(dropped.sessionsPerBar.length, dropped.bars.length, "the session counts stay aligned");
});

test("resampling to D is a pass-through", () => {
  const daily = sessions("2026-08-03", 10, (i) => 1000 + i);
  const same = resample(daily, "D");
  assert.deepEqual(same.bars, daily);
  assert.equal(same.partialLast, false);
});

test("an empty series resamples to an empty series", () => {
  for (const tf of ["D", "W", "M"] as const) {
    const out = resample([], tf);
    assert.deepEqual(out.bars, []);
    assert.equal(out.sourceBars, 0);
  }
});

/* -------------------------------- honest unavailability -------------------------------- */

test("monthly RSI is NULL rather than computed from a window that cannot settle", () => {
  // ~500 daily sessions is ~24 monthly bars. RSI(14) needs ~71 to settle. `rsi()` would cheerfully
  // return a number from bar 15 onward — close enough to look right and be wrong, which is exactly
  // what the indicators module was written to avoid.
  const twoYears = sessions("2024-08-01", 500, (i) => 1000 + Math.sin(i / 30) * 100 + i * 0.3);
  const report = alignment(twoYears, { symbol: "BBRI" });

  const monthly = report.timeframes.find((t) => t.timeframe === "M")!;
  assert.ok(monthly.bars < 30, `two years is about 24 monthly bars, got ${monthly.bars}`);
  assert.equal(monthly.evidence.rsi, null, "a monthly RSI on 24 bars must not be reported");
  assert.ok(monthly.unavailable.some((u) => /RSI 14 needs/.test(u)), "and it must say why");
});

test("monthly uses 6/12, not 20/50, and reports which periods it used", () => {
  // Twenty monthly bars is nearly two years, and only ~24 exist. 6 and 12 are the conventional
  // monthly lines anyway — but a reader comparing a monthly SMA(6) to a weekly SMA(10) has to be
  // able to see that they are different.
  const report = alignment(sessions("2024-08-01", 500, (i) => 1000 + i * 0.5));
  const monthly = report.timeframes.find((t) => t.timeframe === "M")!;
  const weekly = report.timeframes.find((t) => t.timeframe === "W")!;

  assert.deepEqual(monthly.periods, { fast: 6, slow: 12, rsi: 14 });
  assert.deepEqual(weekly.periods, { fast: 10, slow: 30, rsi: 14 });
  assert.notDeepEqual(monthly.periods, weekly.periods);
});

test("weekly RSI IS available at two years, so the null above is a real limit and not a blanket refusal", () => {
  // The negative control. If everything came back null the tests above would pass vacuously.
  const report = alignment(sessions("2024-08-01", 500, (i) => 1000 + Math.sin(i / 20) * 120));
  const weekly = report.timeframes.find((t) => t.timeframe === "W")!;

  assert.ok(weekly.bars > 90, `two years is about 104 weekly bars, got ${weekly.bars}`);
  assert.notEqual(weekly.evidence.rsi, null, "weekly RSI 14 fits comfortably in 104 bars");
  assert.notEqual(weekly.evidence.fastMa, null);
});

test("LOCKED: the payload always states that no intraday OHLC exists", () => {
  // Not a code comment — a field the caller receives. `intraday_prices` is a minutely CLOSE-only
  // series for the current session, so 4H/1H/15m cannot be reconstructed. A report that silently
  // omitted the lower rows would read as if they had been left out of this release.
  for (const count of [30, 200, 500]) {
    const report = alignment(sessions("2024-08-01", count, (i) => 1000 + i));
    assert.ok(report.limits.includes(NO_INTRADAY_LIMIT), `missing at ${count} bars`);
    assert.ok(report.limits.includes(RESAMPLED_LIMIT), `missing at ${count} bars`);
  }
  assert.match(NO_INTRADAY_LIMIT, /CLOSE-only/);
  assert.match(RESAMPLED_LIMIT, /not exchange-published/);
});

/* -------------------------------------- alignment -------------------------------------- */

test("a series trending up on every timeframe reads as aligned", () => {
  const report = alignment(sessions("2024-08-01", 500, (i) => 1000 + i * 2), { symbol: "BBRI" });
  assert.equal(report.symbol, "BBRI");
  assert.equal(report.score > 0, true);
  assert.match(report.verdict, /points up/);
});

test("disagreement is reported as disagreement, not averaged away", () => {
  // Long-run up, recent sharp fall: the monthly and daily views genuinely differ, and a single
  // blended number would hide the one thing worth knowing.
  const bars = sessions("2024-08-01", 500, (i) => (i < 430 ? 1000 + i * 2 : 1860 - (i - 430) * 12));
  const report = alignment(bars);
  const trends = new Set(report.timeframes.map((t) => t.trend));
  if (trends.size > 1) {
    assert.equal(report.aligned, false);
    assert.match(report.verdict, /disagree/);
  }
});

test("each reading reports the daily sessions behind it, so a thin timeframe is visible", () => {
  const report = alignment(sessions("2024-08-01", 500, (i) => 1000 + i));
  for (const reading of report.timeframes) {
    assert.equal(reading.sourceSessions, 500);
    assert.ok(reading.bars > 0, `${reading.label} has no bars`);
    assert.ok(reading.label.length > 0);
  }
  const daily = report.timeframes.find((t) => t.timeframe === "D")!;
  const monthly = report.timeframes.find((t) => t.timeframe === "M")!;
  assert.ok(daily.bars > monthly.bars * 15, "a monthly bar is ~21 sessions");
});

test("the whole report survives a JSON round trip", () => {
  // With a symbol: an absent one is `undefined`, which JSON drops rather than preserves, and that
  // is a property of the optional field rather than of the report.
  const report = alignment(sessions("2024-08-01", 200, (i) => 1000 + i), { symbol: "BBRI" });
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test("a very short series does not throw, it reports what it cannot do", () => {
  const report = alignment(sessions("2026-08-03", 6, (i) => 1000 + i));
  assert.ok(report.limits.length >= 2);
  assert.ok(report.timeframes.every((t) => Number.isFinite(t.bars)));
  const monthly = report.timeframes.find((t) => t.timeframe === "M")!;
  assert.ok(monthly.unavailable.length > 0, "a six-session series can say nothing monthly");
});
