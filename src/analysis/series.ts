/**
 * The single definition of every series this project knows how to compute.
 *
 * ## Why one registry instead of two
 *
 * The same condition — "SMA 20 crosses above SMA 50" — is consumed in two completely different
 * ways: emitted as Pine for TradingView to evaluate, and evaluated here against Stockbit bars to
 * fire an alert. Written twice, those two drift. Not dramatically, and not with an error — one gets
 * a Wilder-smoothed RSI and the other a simple one, or a sample standard deviation instead of a
 * population one, and then the alert fires on a day the chart says it should not have. The user has
 * no way to tell which is wrong.
 *
 * So each series is defined once, carrying both:
 *
 *   - `pine` — the expression TradingView evaluates;
 *   - `compute` — the function this server evaluates, from `src/core/indicators.ts`.
 *
 * The pairings are chosen so those two agree: `ta.rsi` and `ta.atr` smooth with `ta.rma`, which is
 * Wilder's, like ours. `ta.ema` seeds with an SMA, like ours. `ta.stdev` is a population standard
 * deviation, like ours. A test asserts every definition has both halves, so adding a series without
 * a local implementation fails the build rather than silently making alerts unevaluatable.
 */
import type { Bar } from "../core/bars.js";
import { atr, bollinger, ema, macd, rsi, sma, type Series } from "../core/indicators.js";

export type Pane = "price" | "rsi" | "macd" | "atr";

export interface SeriesDef {
  /** Identifier used in Pine, in alert rules, and in tool arguments. */
  id: string;
  label: string;
  pane: Pane;
  /** Right-hand side of `id = ...` in Pine. */
  pine: string;
  /** The same series, computed locally from Stockbit bars. */
  compute: (bars: Bar[]) => Series;
  /** Plot colour, or "" for an intermediate that is never plotted. */
  color: string;
  style?: "line" | "histogram";
}

export type Overlay =
  | { kind: "sma"; period: number }
  | { kind: "ema"; period: number }
  | { kind: "bollinger"; period: number; k: number };

export type Panel =
  | { kind: "rsi"; period: number }
  | { kind: "atr"; period: number }
  | { kind: "macd"; fast: number; slow: number; signal: number };

/** Price fields a condition may reference directly, with how to read them off a bar. */
export const PRICE_REFS = {
  open: (b: Bar) => b.open,
  high: (b: Bar) => b.high,
  low: (b: Bar) => b.low,
  close: (b: Bar) => b.close,
  hl2: (b: Bar) => (b.high + b.low) / 2,
  hlc3: (b: Bar) => (b.high + b.low + b.close) / 3,
  ohlc4: (b: Bar) => (b.open + b.high + b.low + b.close) / 4,
  volume: (b: Bar) => b.volume,
} as const;

export type PriceRef = keyof typeof PRICE_REFS;

export function isPriceRef(name: string): name is PriceRef {
  return Object.prototype.hasOwnProperty.call(PRICE_REFS, name);
}

/** Cycled so two moving averages never land in the same colour. */
const MA_COLORS = ["#58a6ff", "#d29922", "#a371f7", "#3fb950", "#f778ba"];

function requirePeriod(period: number, what: string): number {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`${what} period must be a positive integer, got ${period}`);
  }
  return period;
}

const closes = (bars: Bar[]) => bars.map((b) => b.close);

/**
 * Expand overlays and panels into concrete series definitions, in emission order.
 *
 * Bollinger emits its deviation as a named intermediate so upper and lower share one `ta.stdev`
 * call rather than recomputing it — three calls would be three passes over the same window.
 */
export function defineSeries(overlays: Overlay[] = [], panels: Panel[] = []): SeriesDef[] {
  const out: SeriesDef[] = [];
  const maColor = () => MA_COLORS[out.filter((s) => /^(sma|ema)\d/.test(s.id)).length % MA_COLORS.length];

  for (const o of overlays) {
    if (o.kind === "sma") {
      const p = requirePeriod(o.period, "sma");
      out.push({
        id: `sma${p}`, label: `SMA ${p}`, pane: "price",
        pine: `ta.sma(close, ${p})`,
        compute: (bars) => sma(closes(bars), p),
        color: `color.new(${maColor()}, 0)`,
      });
    } else if (o.kind === "ema") {
      const p = requirePeriod(o.period, "ema");
      out.push({
        id: `ema${p}`, label: `EMA ${p}`, pane: "price",
        pine: `ta.ema(close, ${p})`,
        compute: (bars) => ema(closes(bars), p),
        color: `color.new(${maColor()}, 0)`,
      });
    } else {
      const p = requirePeriod(o.period, "bollinger");
      if (!Number.isFinite(o.k)) throw new Error(`bollinger k must be a finite number, got ${o.k}`);
      out.push(
        {
          id: "bbMiddle", label: `BB basis (${p})`, pane: "price",
          pine: `ta.sma(close, ${p})`,
          compute: (bars) => bollinger(closes(bars), p, o.k).middle,
          color: "color.new(#8b949e, 40)",
        },
        {
          id: "bbDev", label: "", pane: "price",
          pine: `${o.k} * ta.stdev(close, ${p})`,
          // The band half-width, so upper/lower below are one subtraction rather than a second pass.
          compute: (bars) => {
            const bb = bollinger(closes(bars), p, o.k);
            return bb.upper.map((u, i) => (u === null || bb.middle[i] === null ? null : u - bb.middle[i]!));
          },
          color: "",
        },
        {
          id: "bbUpper", label: "BB upper", pane: "price",
          pine: "bbMiddle + bbDev",
          compute: (bars) => bollinger(closes(bars), p, o.k).upper,
          color: "color.new(#8b949e, 0)",
        },
        {
          id: "bbLower", label: "BB lower", pane: "price",
          pine: "bbMiddle - bbDev",
          compute: (bars) => bollinger(closes(bars), p, o.k).lower,
          color: "color.new(#8b949e, 0)",
        },
      );
    }
  }

  for (const p of panels) {
    if (p.kind === "rsi") {
      const n = requirePeriod(p.period, "rsi");
      out.push({
        id: `rsi${n}`, label: `RSI ${n}`, pane: "rsi",
        pine: `ta.rsi(close, ${n})`,
        compute: (bars) => rsi(closes(bars), n),
        color: "color.new(#a371f7, 0)",
      });
    } else if (p.kind === "atr") {
      const n = requirePeriod(p.period, "atr");
      out.push({
        id: `atr${n}`, label: `ATR ${n}`, pane: "atr",
        pine: `ta.atr(${n})`,
        compute: (bars) => atr(bars, n),
        color: "color.new(#3fb950, 0)",
      });
    } else {
      const f = requirePeriod(p.fast, "macd fast");
      const s = requirePeriod(p.slow, "macd slow");
      const g = requirePeriod(p.signal, "macd signal");
      if (f >= s) throw new Error(`macd fast (${f}) must be shorter than slow (${s})`);
      out.push(
        {
          id: "macdLine", label: "MACD", pane: "macd",
          pine: `ta.ema(close, ${f}) - ta.ema(close, ${s})`,
          compute: (bars) => macd(closes(bars), f, s, g).macd,
          color: "color.new(#58a6ff, 0)",
        },
        {
          id: "macdSignal", label: "Signal", pane: "macd",
          pine: `ta.ema(macdLine, ${g})`,
          compute: (bars) => macd(closes(bars), f, s, g).signal,
          color: "color.new(#d29922, 0)",
        },
        {
          id: "macdHist", label: "Histogram", pane: "macd",
          pine: "macdLine - macdSignal",
          compute: (bars) => macd(closes(bars), f, s, g).histogram,
          color: "color.new(#8b949e, 20)",
          style: "histogram",
        },
      );
    }
  }

  return out;
}

/* ---------------------------------- conditions ---------------------------------- */

/** Comparisons a condition may use. Closed on purpose: free text would be arbitrary code. */
export const OPERATORS = ["crossover", "crossunder", "cross", ">", "<", ">=", "<="] as const;
export type Operator = (typeof OPERATORS)[number];

export function isOperator(value: string): value is Operator {
  return (OPERATORS as readonly string[]).includes(value);
}

/**
 * Evaluate a comparison on the last bar of a window.
 *
 * Crossings need the previous bar too, and a null on either side means the indicator is still in
 * its warm-up. That case returns false rather than treating null as zero — an RSI that does not
 * exist yet is not "below 30", and firing an alert on it would be a false positive on every new
 * symbol.
 */
export function evaluateAt(
  op: Operator,
  left: Array<number | null>,
  right: Array<number | null>,
  index: number,
): boolean {
  const l = left[index];
  const r = right[index];
  if (l === null || l === undefined || r === null || r === undefined) return false;

  if (op === ">") return l > r;
  if (op === "<") return l < r;
  if (op === ">=") return l >= r;
  if (op === "<=") return l <= r;

  const pl = left[index - 1];
  const pr = right[index - 1];
  if (pl === null || pl === undefined || pr === null || pr === undefined) return false;

  const up = pl <= pr && l > r;
  const down = pl >= pr && l < r;
  if (op === "crossover") return up;
  if (op === "crossunder") return down;
  return up || down;
}
