/**
 * Higher timeframes, resampled from daily bars — and an honest account of what does not exist.
 *
 * ## What this data source actually has
 *
 * Stockbit serves **daily** OHLCV, and that is all. Weekly and monthly are folded up from those
 * sessions here. Lower timeframes are not available and are not offered: `intraday_prices` is a
 * minutely *close-only* series for the current session, with no open, high, low, or history, so
 * there is nothing to reconstruct a 4H or 15m candle from. A multi-timeframe report that quietly
 * omitted that would read as if the lower rows had simply been left out of this release.
 *
 * ## The ceiling, which decides everything below
 *
 * `src/core/bars.ts` walks 42 pages of 12 rows: about **500 daily sessions ≈ 2 years ≈ 104 weekly
 * bars ≈ 24 monthly bars**. So weekly RSI(14) and SMA(50) are available and weekly SMA(200) is not.
 * More sharply: **monthly RSI(14) needs ~70 monthly bars and there are 24**, so it is reported as
 * `null` rather than computed from a shorter window. `rsi()` would cheerfully return a number from
 * bar 15 onward — a number close enough to look right and be wrong, which is the exact failure the
 * indicators module was written to avoid.
 */
import type { Bar } from "../core/bars.js";
import { ema, latest, macd, rsi, sma } from "../core/indicators.js";
import { warmupFor } from "./series.js";

export type Timeframe = "D" | "W" | "M";

export const TIMEFRAME_LABELS: Record<Timeframe, string> = { D: "Daily", W: "Weekly", M: "Monthly" };

export interface ResampledSeries {
  timeframe: Timeframe;
  /** Oldest first, like every other series in this project. */
  bars: Bar[];
  /** Source sessions folded into each output bar, same order. */
  sessionsPerBar: number[];
  /** True when the trailing bar aggregates a period that has not finished. */
  partialLast: boolean;
  sourceBars: number;
}

/* ------------------------------------- bucketing ------------------------------------- */

/**
 * The bucket key for a session.
 *
 * Monthly is the `YYYY-MM` prefix — a string operation, so no timezone can move it. Weekly is the
 * ISO Monday, computed through `Date.UTC` for the same reason: parsing `"2026-08-09"` in local time
 * shifts the weekday for roughly half the world, which would put Sunday's session in the wrong week
 * for those users and nobody else.
 */
export function bucketKey(date: string, tf: Timeframe): string {
  if (tf === "D") return date;
  if (tf === "M") return date.slice(0, 7);

  const [y, m, d] = date.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const weekday = new Date(ms).getUTCDay(); // 0 = Sunday
  const backToMonday = (weekday + 6) % 7;
  return new Date(ms - backToMonday * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Fold daily bars into weekly or monthly ones.
 *
 * Each field has a wrong-and-plausible alternative, so each is chosen deliberately:
 *
 *   - **`date` is the LAST session in the bucket**, not the first. Labelling by period start makes a
 *     two-day partial week read as a complete week that has not happened yet; labelling by close
 *     never claims a session that does not exist.
 *   - **`average` is volume-weighted.** Averaging the daily VWAPs unweighted makes a 100-lot session
 *     count as much as a 10,000-lot one. Deriving it as value/volume instead would bake in the
 *     lots-to-shares constant, which is one silent unit assumption too many in this codebase.
 *   - **`changePercent` is recomputed against the PREVIOUS bucket's close.** Summing daily percent
 *     changes is arithmetically wrong — they compound — and it looks right to three decimal places.
 *
 * `partialLast` is derived structurally: a bucket is complete if and only if a later bucket exists
 * in the input. That needs no holiday calendar and is conservative in the right direction — the
 * trailing bucket is always flagged, because we genuinely cannot know whether more sessions are
 * coming.
 */
export function resample(bars: Bar[], tf: Timeframe, opts: { includePartial?: boolean } = {}): ResampledSeries {
  if (tf === "D") {
    return { timeframe: "D", bars: [...bars], sessionsPerBar: bars.map(() => 1), partialLast: false, sourceBars: bars.length };
  }

  const groups = new Map<string, Bar[]>();
  const order: string[] = [];
  for (const bar of bars) {
    const key = bucketKey(bar.date, tf);
    const existing = groups.get(key);
    if (existing) existing.push(bar);
    else {
      groups.set(key, [bar]);
      order.push(key);
    }
  }

  const out: Bar[] = [];
  const sessionsPerBar: number[] = [];
  let previousClose: number | null = null;

  for (const key of order) {
    const group = groups.get(key)!;
    const first = group[0];
    const last = group[group.length - 1];
    const volume = group.reduce((a, b) => a + b.volume, 0);
    const weightedAverage = volume > 0 ? group.reduce((a, b) => a + b.average * b.volume, 0) / volume : last.average;

    const close = last.close;
    const change = previousClose === null ? 0 : close - previousClose;
    const changePercent = previousClose ? (change / previousClose) * 100 : 0;

    out.push({
      // The last session's date: a bucket never claims a day that has not traded.
      date: last.date,
      open: first.open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close,
      average: Number(weightedAverage.toFixed(4)),
      volume,
      value: group.reduce((a, b) => a + b.value, 0),
      frequency: group.reduce((a, b) => a + b.frequency, 0),
      change: Number(change.toFixed(4)),
      changePercent: Number(changePercent.toFixed(4)),
      foreignBuy: group.reduce((a, b) => a + b.foreignBuy, 0),
      foreignSell: group.reduce((a, b) => a + b.foreignSell, 0),
      netForeign: group.reduce((a, b) => a + b.netForeign, 0),
    });
    sessionsPerBar.push(group.length);
    previousClose = close;
  }

  // The trailing bucket is always incomplete as far as this function can tell.
  const partialLast = out.length > 0;
  if (!opts.includePartial && out.length > 0) {
    out.pop();
    sessionsPerBar.pop();
  }

  return { timeframe: tf, bars: out, sessionsPerBar, partialLast, sourceBars: bars.length };
}

/* ------------------------------------- alignment ------------------------------------- */

export interface TimeframeReading {
  timeframe: Timeframe;
  label: string;
  bars: number;
  sourceSessions: number;
  /** True when the trailing period was dropped as incomplete. */
  droppedPartial: boolean;
  lastDate: string | null;
  lastClose: number | null;
  trend: "up" | "down" | "flat";
  /** `null` means "not enough bars at this timeframe" — never 0, never a short-window substitute. */
  evidence: {
    fastMa: number | null;
    slowMa: number | null;
    closeVsSlowMaPct: number | null;
    rsi: number | null;
    macdHistogram: number | null;
  };
  /** The periods actually used, because they differ per timeframe and the reader must know. */
  periods: { fast: number; slow: number; rsi: number };
  /** What could not be computed here, and why. */
  unavailable: string[];
}

export interface AlignmentReport {
  symbol?: string;
  timeframes: TimeframeReading[];
  /** −3…+3, one vote per timeframe. */
  score: number;
  aligned: boolean;
  verdict: string;
  /** What this report cannot say. Always populated — see the module note. */
  limits: string[];
}

/**
 * Periods per timeframe.
 *
 * Monthly does NOT use 20/50/14. Twenty monthly bars is nearly two years and there are only ~24 of
 * them available, so a monthly SMA(20) would be defined for four bars and a monthly RSI(14) would
 * never settle. 6 and 12 are the conventional monthly lines anyway, and `periods` reports them so
 * nobody compares a monthly SMA(6) to a weekly SMA(20) without noticing.
 */
const PERIODS: Record<Timeframe, { fast: number; slow: number; rsi: number }> = {
  D: { fast: 20, slow: 50, rsi: 14 },
  W: { fast: 10, slow: 30, rsi: 14 },
  M: { fast: 6, slow: 12, rsi: 14 },
};

/** The sentence that must never quietly disappear from the payload. */
export const NO_INTRADAY_LIMIT =
  "No 4H / 1H / 15m OHLC exists in this data source. Stockbit's intraday feed is a minutely " +
  "CLOSE-only series for the current session — no open, high, low, or history — so lower " +
  "timeframes cannot be reconstructed and are not offered.";

export const RESAMPLED_LIMIT =
  "Stockbit serves daily bars only. Weekly and Monthly here are resampled from those daily " +
  "sessions, not exchange-published weekly or monthly candles.";

/**
 * Compute one timeframe's reading, reporting `null` for anything the bar count cannot support.
 *
 * The alternative — computing an RSI from 15 monthly bars because the function will return a
 * number — is the failure this whole module is arranged around. A number that is merely available
 * is not a number that means anything.
 */
function read(tf: Timeframe, series: ResampledSeries): TimeframeReading {
  const bars = series.bars;
  const closes = bars.map((b) => b.close);
  const p = PERIODS[tf];
  const unavailable: string[] = [];

  const need = (period: number, kind: "terminating" | "converging"): boolean => {
    const required = kind === "terminating" ? period : warmupFor([], [{ kind: "rsi", period }]);
    return bars.length >= required;
  };

  const fastMa = need(p.fast, "terminating") ? latest(sma(closes, p.fast)) : null;
  const slowMa = need(p.slow, "terminating") ? latest(sma(closes, p.slow)) : null;
  if (fastMa === null) unavailable.push(`SMA ${p.fast} needs ${p.fast} ${TIMEFRAME_LABELS[tf]} bars, there are ${bars.length}`);
  if (slowMa === null) unavailable.push(`SMA ${p.slow} needs ${p.slow} ${TIMEFRAME_LABELS[tf]} bars, there are ${bars.length}`);

  const rsiWarmup = warmupFor([], [{ kind: "rsi", period: p.rsi }]);
  const rsiValue = bars.length >= rsiWarmup ? latest(rsi(closes, p.rsi)) : null;
  if (rsiValue === null) {
    unavailable.push(
      `RSI ${p.rsi} needs ${rsiWarmup} ${TIMEFRAME_LABELS[tf]} bars to settle, there are ${bars.length}. ` +
        "Reported as null rather than computed from a window that has not converged.",
    );
  }

  const macdWarmup = warmupFor([], [{ kind: "macd", fast: 12, slow: 26, signal: 9 }]);
  const macdHistogram = bars.length >= macdWarmup ? latest(macd(closes).histogram) : null;
  if (macdHistogram === null) unavailable.push(`MACD needs ${macdWarmup} ${TIMEFRAME_LABELS[tf]} bars, there are ${bars.length}`);

  const lastClose = closes[closes.length - 1] ?? null;
  const closeVsSlowMaPct = lastClose !== null && slowMa !== null ? Number((((lastClose - slowMa) / slowMa) * 100).toFixed(4)) : null;

  // A trend needs the slow average to exist. Falling back to "whatever we have" would produce an
  // up/down verdict from an EMA of four bars, which is a coin flip wearing a label.
  let trend: TimeframeReading["trend"] = "flat";
  if (fastMa !== null && slowMa !== null && lastClose !== null) {
    if (fastMa > slowMa && lastClose > slowMa) trend = "up";
    else if (fastMa < slowMa && lastClose < slowMa) trend = "down";
  } else if (bars.length >= 4 && lastClose !== null) {
    // Not enough for the averages, but a short EMA is still better than silence — and it is
    // recorded as unavailable evidence so nobody mistakes it for the real reading.
    const short = latest(ema(closes, Math.min(4, bars.length)));
    if (short !== null) trend = lastClose > short ? "up" : lastClose < short ? "down" : "flat";
    unavailable.push(`Trend fell back to a ${Math.min(4, bars.length)}-bar EMA because the averages are unavailable`);
  }

  return {
    timeframe: tf,
    label: TIMEFRAME_LABELS[tf],
    bars: bars.length,
    sourceSessions: series.sourceBars,
    droppedPartial: series.partialLast,
    lastDate: bars[bars.length - 1]?.date ?? null,
    lastClose,
    trend,
    evidence: { fastMa, slowMa, closeVsSlowMaPct, rsi: rsiValue, macdHistogram },
    periods: p,
    unavailable,
  };
}

export function alignment(bars: Bar[], opts: { symbol?: string; timeframes?: Timeframe[] } = {}): AlignmentReport {
  const wanted = opts.timeframes ?? (["D", "W", "M"] as Timeframe[]);
  const readings = wanted.map((tf) => read(tf, resample(bars, tf)));

  const score = readings.reduce((a, r) => a + (r.trend === "up" ? 1 : r.trend === "down" ? -1 : 0), 0);
  const nonFlat = readings.filter((r) => r.trend !== "flat");
  const aligned = nonFlat.length > 1 && Math.abs(score) === nonFlat.length;

  const limits = [RESAMPLED_LIMIT, NO_INTRADAY_LIMIT];
  for (const r of readings) {
    if (r.unavailable.length > 0) {
      limits.push(`${r.label}: ${r.bars} bars from ${r.sourceSessions} daily sessions. ${r.unavailable.join("; ")}.`);
    }
  }

  return {
    symbol: opts.symbol,
    timeframes: readings,
    score,
    aligned,
    verdict: verdictFor(readings, score, aligned),
    limits,
  };
}

function verdictFor(readings: TimeframeReading[], score: number, aligned: boolean): string {
  const named = readings.map((r) => `${r.label} ${r.trend}`).join(", ");
  if (aligned && score > 0) return `Every timeframe with a readable trend points up (${named}).`;
  if (aligned && score < 0) return `Every timeframe with a readable trend points down (${named}).`;
  if (readings.every((r) => r.trend === "flat")) return `No timeframe shows a directional trend (${named}).`;
  return `Timeframes disagree (${named}) — a signal on one is being taken against another.`;
}
