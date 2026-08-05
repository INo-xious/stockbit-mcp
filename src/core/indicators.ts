/**
 * Technical indicators over a daily bar series.
 *
 * Pure functions on `number[]` / `Bar[]`, no network and no state, so they are cheap to test and
 * reusable by chart rendering, alert rules and any future backtester.
 *
 * ## Two conventions worth stating, because getting either wrong is silent
 *
 * **Alignment.** Every series returned is the same length as its input, with `null` for the leading
 * bars where the indicator is not yet defined (an SMA(20) has no value until bar 20). Returning a
 * shortened array instead would mean callers re-derive the offset every time, and an off-by-one
 * there misaligns a signal against its own price without ever throwing.
 *
 * **Warm-up.** Wilder-smoothed indicators (RSI, ATR) are seeded with a simple average of the first
 * `period` values and then smoothed, which is the original Wilder definition and what Stockbit's
 * charts use. Seeding with an EMA instead produces values that drift from every published chart by
 * a few percent — close enough to look right and be wrong.
 */
import type { Bar } from "./bars.js";

/** A value per input bar; `null` where the indicator is not yet defined. */
export type Series = Array<number | null>;

const round = (n: number, dp = 4): number => Number(n.toFixed(dp));

function requirePeriod(period: number, name: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`${name} period must be a positive integer, got ${period}`);
  }
}

/* --------------------------------- averages --------------------------------- */

/** Simple moving average. */
export function sma(values: number[], period: number): Series {
  requirePeriod(period, "sma");
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = round(sum / period);
  }
  return out;
}

/**
 * Exponential moving average.
 *
 * Seeded with the SMA of the first `period` values rather than with `values[0]`. Seeding from a
 * single price lets an outlier first bar bias the whole series, and the bias decays slowly enough
 * to still be visible hundreds of bars later.
 */
export function ema(values: number[], period: number): Series {
  requirePeriod(period, "ema");
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = round(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = round(prev);
  }
  return out;
}

/** Wilder's smoothing — the running average used by RSI and ATR. */
function wilder(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/* -------------------------------- momentum -------------------------------- */

/**
 * Relative Strength Index, Wilder's original definition.
 *
 * A flat series has no losses at all, which would divide by zero; that case is defined as 100 (or
 * 50 when there is no movement either way), matching every mainstream implementation.
 */
export function rsi(values: number[], period = 14): Series {
  requirePeriod(period, "rsi");
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;

  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  // Drop the synthetic first element so the smoother sees only real deltas.
  const g = wilder(gains.slice(1), period);
  const l = wilder(losses.slice(1), period);
  for (let i = 0; i < g.length; i++) {
    const gv = g[i];
    const lv = l[i];
    if (gv === null || lv === null) continue;
    let value: number;
    if (lv === 0) value = gv === 0 ? 50 : 100;
    else value = 100 - 100 / (1 + gv / lv);
    out[i + 1] = round(value, 2);
  }
  return out;
}

export interface Macd {
  macd: Series;
  signal: Series;
  histogram: Series;
}

/** MACD: fast EMA − slow EMA, with an EMA signal line and their difference. */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] !== null && s[i] !== null ? round(f[i]! - s[i]!) : null));

  // The signal line is an EMA of the MACD line, which only exists from the slow period onward.
  const defined = line.filter((v): v is number => v !== null);
  const sig = ema(defined, signalPeriod);
  const offset = line.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  if (offset >= 0) for (let i = 0; i < sig.length; i++) signal[offset + i] = sig[i];

  const histogram: Series = values.map((_, i) =>
    line[i] !== null && signal[i] !== null ? round(line[i]! - signal[i]!) : null,
  );
  return { macd: line, signal, histogram };
}

/* ------------------------------- volatility ------------------------------- */

export interface Bollinger {
  middle: Series;
  upper: Series;
  lower: Series;
}

/** Bollinger Bands: SMA ± k population standard deviations. */
export function bollinger(values: number[], period = 20, k = 2): Bollinger {
  requirePeriod(period, "bollinger");
  const middle = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = middle[i]!;
    // Population (not sample) SD — the convention every charting package uses here.
    const variance = window.reduce((acc, v) => acc + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = round(mean + k * sd);
    lower[i] = round(mean - k * sd);
  }
  return { middle, upper, lower };
}

/** Average True Range — Wilder-smoothed true range. */
export function atr(bars: Bar[], period = 14): Series {
  requirePeriod(period, "atr");
  if (bars.length === 0) return [];
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose)));
  }
  const smoothed = wilder(tr, period);
  const out: Series = new Array(bars.length).fill(null);
  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] !== null) out[i + 1] = round(smoothed[i]!);
  }
  return out;
}

/* --------------------------- structure & levels --------------------------- */

export interface Level {
  price: number;
  /** How many pivots cluster at this level — higher means better tested. */
  touches: number;
  /** Relative to the latest close: below is support, above is resistance. */
  kind: "support" | "resistance";
}

/**
 * Support and resistance from pivot clustering.
 *
 * A pivot is a bar whose high (or low) exceeds every bar within `lookback` on both sides. Pivots
 * within `tolerance` of each other are one level, and the count of clustered pivots is reported as
 * `touches` — a level tested five times is a different proposition from one touched once, and
 * collapsing that distinction is how these get over-trusted.
 *
 * ## Two decisions that were wrong in the first version, both found against live data
 *
 * **`kind` is decided by where price is NOW, not by whether the pivot was a high or a low.** BBRI
 * over the last year fell from about 4000 to 3020, and labelling every old pivot low as "support"
 * reported "support 3860, support 3615, support 3580" on a stock trading at 3020 — three levels
 * above the market, described as the floor. They are not a floor; price fell through them, and
 * broken support is overhead supply. What makes a level support is that price is above it.
 *
 * **Clustering ignores which kind a pivot was.** A price that has acted as both a ceiling and a
 * floor is a *stronger* level, not two unrelated weak ones, and clustering per-kind split exactly
 * those into two half-strength entries — the levels most worth seeing.
 */
export function levels(bars: Bar[], lookback = 5, tolerancePct = 1.5): Level[] {
  if (bars.length < lookback * 2 + 1) return [];
  const pivots: number[] = [];

  for (let i = lookback; i < bars.length - lookback; i++) {
    const window = bars.slice(i - lookback, i + lookback + 1);
    if (window.every((b) => bars[i].high >= b.high)) pivots.push(bars[i].high);
    if (window.every((b) => bars[i].low <= b.low)) pivots.push(bars[i].low);
  }

  const clusters: Array<{ price: number; touches: number }> = [];
  for (const price of pivots) {
    const hit = clusters.find((c) => Math.abs(c.price - price) / c.price <= tolerancePct / 100);
    if (hit) {
      // Keep the running mean so a level is where the pivots actually sit, not where the first one did.
      hit.price = round((hit.price * hit.touches + price) / (hit.touches + 1), 2);
      hit.touches++;
    } else {
      clusters.push({ price: round(price, 2), touches: 1 });
    }
  }

  const reference = bars[bars.length - 1].close;
  return clusters
    .map((c) => ({ ...c, kind: (c.price <= reference ? "support" : "resistance") as Level["kind"] }))
    .sort((a, b) => b.touches - a.touches || b.price - a.price);
}

/** Latest defined value of a series, or null. */
export function latest(series: Series): number | null {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] !== null) return series[i];
  return null;
}
