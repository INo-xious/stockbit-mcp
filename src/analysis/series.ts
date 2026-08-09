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
import {
  atr,
  bollinger,
  ema,
  highest,
  lowest,
  macd,
  rsi,
  sma,
  type Series,
} from "../core/indicators.js";

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
  /**
   * Plot colour as a plain hex, or "" for an intermediate that is never plotted.
   *
   * Stored raw rather than as Pine's `color.new(...)` because there are two renderers now: the Pine
   * emitter wraps it, and the SVG chart uses it directly. Keeping the Pine spelling here would have
   * meant the chart parsing a Pine expression to get a colour back out.
   */
  color: string;
  /** Pine transparency, 0 = opaque. Only meaningful alongside a colour. */
  alpha?: number;
  style?: "line" | "histogram";
}

export type Overlay =
  | { kind: "sma"; period: number }
  | { kind: "ema"; period: number }
  | { kind: "bollinger"; period: number; k: number }
  | { kind: "donchian"; period: number }
  | { kind: "volumeSma"; period: number };

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
        color: maColor(),
      });
    } else if (o.kind === "ema") {
      const p = requirePeriod(o.period, "ema");
      out.push({
        id: `ema${p}`, label: `EMA ${p}`, pane: "price",
        pine: `ta.ema(close, ${p})`,
        compute: (bars) => ema(closes(bars), p),
        color: maColor(),
      });
    } else if (o.kind === "donchian") {
      // The breakout family the grammar could not express at all. `close > dcUpper` is never true —
      // the channel includes the current bar, so the close that sets a new high IS the high. The
      // condition that means "broke out" is `close crossover dcUpper[1]`-shaped, which in this
      // grammar is a crossover against the channel: the previous bar was inside, this one is not.
      const p = requirePeriod(o.period, "donchian");
      out.push(
        {
          id: `dcUpper${p}`, label: `Donchian upper ${p}`, pane: "price",
          pine: `ta.highest(high, ${p})`,
          compute: (bars) => highest(bars.map((b) => b.high), p),
          color: "#f778ba",
        },
        {
          id: `dcLower${p}`, label: `Donchian lower ${p}`, pane: "price",
          pine: `ta.lowest(low, ${p})`,
          compute: (bars) => lowest(bars.map((b) => b.low), p),
          color: "#f778ba",
        },
        {
          id: `dcMiddle${p}`, label: `Donchian mid ${p}`, pane: "price",
          pine: `(dcUpper${p} + dcLower${p}) / 2`,
          compute: (bars) => {
            const up = highest(bars.map((b) => b.high), p);
            const dn = lowest(bars.map((b) => b.low), p);
            return up.map((u, i) => (u === null || dn[i] === null ? null : (u + dn[i]!) / 2));
          },
          color: "#8b949e", alpha: 40,
        },
      );
    } else if (o.kind === "volumeSma") {
      // Volume confirmation — "is this move backed by participation" — was the one screen condition
      // asked for most and impossible to write, because `volume` had nothing to be compared against
      // except a hard-coded lot count that means something different for every stock.
      const p = requirePeriod(o.period, "volumeSma");
      out.push({
        id: `volSma${p}`, label: `Volume SMA ${p}`, pane: "price",
        pine: `ta.sma(volume, ${p})`,
        compute: (bars) => sma(bars.map((b) => b.volume), p),
        color: "",
      });
    } else {
      const p = requirePeriod(o.period, "bollinger");
      if (!Number.isFinite(o.k)) throw new Error(`bollinger k must be a finite number, got ${o.k}`);
      out.push(
        {
          id: "bbMiddle", label: `BB basis (${p})`, pane: "price",
          pine: `ta.sma(close, ${p})`,
          compute: (bars) => bollinger(closes(bars), p, o.k).middle,
          color: "#8b949e", alpha: 40,
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
          color: "#8b949e",
        },
        {
          id: "bbLower", label: "BB lower", pane: "price",
          pine: "bbMiddle - bbDev",
          compute: (bars) => bollinger(closes(bars), p, o.k).lower,
          color: "#8b949e",
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
        color: "#a371f7",
      });
    } else if (p.kind === "atr") {
      const n = requirePeriod(p.period, "atr");
      out.push({
        id: `atr${n}`, label: `ATR ${n}`, pane: "atr",
        pine: `ta.atr(${n})`,
        compute: (bars) => atr(bars, n),
        color: "#3fb950",
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
          color: "#58a6ff",
        },
        {
          id: "macdSignal", label: "Signal", pane: "macd",
          pine: `ta.ema(macdLine, ${g})`,
          compute: (bars) => macd(closes(bars), f, s, g).signal,
          color: "#d29922",
        },
        {
          id: "macdHist", label: "Histogram", pane: "macd",
          pine: "macdLine - macdSignal",
          compute: (bars) => macd(closes(bars), f, s, g).histogram,
          color: "#8b949e", alpha: 20,
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

/**
 * Resolve one side of a condition into a series aligned to `bars`.
 *
 * A number becomes a constant series rather than a special case in the comparator, so a crossover
 * against a fixed price (`close crossover 4820`) runs through the same code path as a crossover
 * against another series.
 *
 * This lives here, beside the registry it resolves against, rather than inside the alerts module
 * where it started. Alerts, backtests and universe scans are three peers that all need it; leaving
 * it inside one of them would have the other two importing from a sibling feature to borrow a
 * private helper.
 */
export function resolveOperand(
  operand: string | number,
  bars: Bar[],
  defs: SeriesDef[],
  side: string,
): Series {
  if (typeof operand === "number") {
    if (!Number.isFinite(operand)) throw new Error(`${side} must be a finite number, got ${operand}`);
    return new Array(bars.length).fill(operand);
  }
  if (isPriceRef(operand)) return bars.map((b) => PRICE_REFS[operand](b));
  const def = defs.find((d) => d.id === operand);
  if (!def) {
    throw new Error(
      `${side} references "${operand}", which is not a declared series. ` +
        `Available: ${[...defs.map((d) => d.id), ...Object.keys(PRICE_REFS)].join(", ")}`,
    );
  }
  return def.compute(bars);
}

/* -------------------------------- compiled conditions -------------------------------- */

export interface Condition {
  left: string | number;
  op: Operator;
  right: string | number;
}

/**
 * A condition with both sides resolved once, answerable at any bar.
 *
 * Everything that evaluates a condition — an alert on the latest bar, a backtest walking every bar,
 * a scan across a universe — needs the same two questions answered at an index: *can this be judged
 * yet*, and *does it hold*. Those were previously answered by code inlined in `evaluateRule`, which
 * meant a backtest would have had to re-derive "a crossing also needs the previous bar" and would
 * eventually have disagreed with `alert_check` about what `warming-up` means.
 */
export interface CompiledCondition {
  op: Operator;
  left: Series;
  right: Series;
  /** First index the comparison can be judged at. `-1` when it never can, over these bars. */
  firstValidIndex: number;
  /** True when an operand needed at `i` is still null — "cannot say yet", which is not "no". */
  warmingUpAt(i: number): boolean;
  /** True when the comparison holds at `i`. False when warming up, never a throw. */
  holdsAt(i: number): boolean;
}

const isCrossing = (op: Operator): boolean => op === "crossover" || op === "crossunder" || op === "cross";

export function compileCondition(cond: Condition, bars: Bar[], defs: SeriesDef[]): CompiledCondition {
  const left = resolveOperand(cond.left, bars, defs, "left");
  const right = resolveOperand(cond.right, bars, defs, "right");
  const crossing = isCrossing(cond.op);

  const warmingUpAt = (i: number): boolean => {
    if (i < 0 || i >= bars.length) return true;
    // A crossing is a statement about two bars, so the previous one has to exist and be settled.
    // Bar 0 can therefore never carry a crossing, however warm the indicators are.
    const needed = crossing ? [left[i], right[i], left[i - 1], right[i - 1]] : [left[i], right[i]];
    return needed.some((v) => v === null || v === undefined);
  };

  let firstValidIndex = -1;
  for (let i = 0; i < bars.length; i++) {
    if (!warmingUpAt(i)) {
      firstValidIndex = i;
      break;
    }
  }

  return {
    op: cond.op,
    left,
    right,
    firstValidIndex,
    warmingUpAt,
    holdsAt: (i) => (warmingUpAt(i) ? false : evaluateAt(cond.op, left, right, i)),
  };
}

/* ----------------------------------- warm-up ----------------------------------- */

/**
 * How many bars a spec needs before every series it declares has a settled value.
 *
 * Split by how each indicator converges, rather than a flat multiple applied to everything, because
 * one number is wrong in both directions:
 *
 *   - **SMA, Bollinger, Donchian and a volume SMA terminate.** A 20-bar window is a 20-bar window;
 *     the 20th value is the value, not an approximation of it. A flat 3x asked for 151 bars to
 *     compute an SMA 50 and 601 for an SMA 200 — at twelve rows an upstream page, eight and
 *     thirty-four requests bought for nothing. Over a universe scan that is the difference between
 *     a query that returns and one that times out.
 *   - **EMA, RSI, ATR and MACD converge.** Wilder smoothing and an EMA never terminate: they decay
 *     toward the true value. Asking for exactly `period` there gives a number that is still visibly
 *     drifting toward where it belongs, and an alert or a backtest entry taken on that drift is
 *     acting on an artefact of where the fetch happened to start.
 *
 * ## Why the converging multiplier is 5 and not the usual 3
 *
 * "Three times the period" is the folk rule and it is not enough. Measured against a full series,
 * the residual error at the last bar of a truncated window is:
 *
 * ```
 *   multiple   rsi14    ema20    macd hist
 *      3x       2.75    0.288      0.022
 *      4x       0.84    0.029      0.001
 *      5x       0.07    0.003      0.000
 * ```
 *
 * An RSI 2.75 points out is not a rounding difference — it is the difference between 29.9 and 32.6,
 * which is the difference between a screen hit and a miss on the most common oversold condition
 * there is. So this pays for one extra upstream page to stop being wrong about that. Terminating
 * indicators are unaffected and still get the large saving, which is where the pages come from:
 * an SMA 50 went from 151 bars to 51 in the same change.
 *
 * Plus one bar, because a crossing compares against the previous one.
 */
const CONVERGENCE_MULTIPLE = 5;

export function warmupFor(overlays: Overlay[] = [], panels: Panel[] = []): number {
  let longest = 1;
  for (const o of overlays) {
    // `bollinger` needs its standard deviation over the same window, which also terminates.
    const settles = o.kind === "ema" ? o.period * CONVERGENCE_MULTIPLE : o.period;
    longest = Math.max(longest, settles);
  }
  for (const p of panels) {
    // MACD is an EMA of a difference of EMAs, so both stages have to settle.
    const base = p.kind === "macd" ? p.slow + p.signal : p.period;
    longest = Math.max(longest, base * CONVERGENCE_MULTIPLE);
  }
  return longest + 1;
}

/* ----------------------------------- presets ----------------------------------- */

/**
 * The named overlays and panels a tool argument may ask for.
 *
 * One table, because there were two identical copies inside `register.ts` and every new consumer —
 * backtest, scan, patterns — wanted another. Copies of a vocabulary do not stay in step: the moment
 * one gains an entry, a tool that reads well in its own schema silently rejects a value another
 * tool accepts. The zod enums are derived from these keys so a preset is available everywhere or
 * nowhere.
 */
export const OVERLAY_PRESETS = {
  sma20: { kind: "sma", period: 20 },
  sma50: { kind: "sma", period: 50 },
  sma200: { kind: "sma", period: 200 },
  ema20: { kind: "ema", period: 20 },
  ema50: { kind: "ema", period: 50 },
  bollinger: { kind: "bollinger", period: 20, k: 2 },
  donchian20: { kind: "donchian", period: 20 },
  volume_sma20: { kind: "volumeSma", period: 20 },
} as const satisfies Record<string, Overlay>;

export const PANEL_PRESETS = {
  rsi: { kind: "rsi", period: 14 },
  atr: { kind: "atr", period: 14 },
  macd: { kind: "macd", fast: 12, slow: 26, signal: 9 },
} as const satisfies Record<string, Panel>;

export type OverlayName = keyof typeof OVERLAY_PRESETS;
export type PanelName = keyof typeof PANEL_PRESETS;

/** Non-empty tuples, because `z.enum` requires at least one member at the type level. */
export const OVERLAY_NAMES = Object.keys(OVERLAY_PRESETS) as [OverlayName, ...OverlayName[]];
export const PANEL_NAMES = Object.keys(PANEL_PRESETS) as [PanelName, ...PanelName[]];

/** Expand preset names into specs, ignoring anything unrecognised rather than throwing. */
export function overlaysFrom(names: readonly string[] = []): Overlay[] {
  return names.map((n) => OVERLAY_PRESETS[n as OverlayName]).filter(Boolean) as Overlay[];
}

export function panelsFrom(names: readonly string[] = []): Panel[] {
  return names.map((n) => PANEL_PRESETS[n as PanelName]).filter(Boolean) as Panel[];
}
