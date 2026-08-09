/**
 * Strategies, expressed in the condition grammar the alerts and the Pine emitter already share.
 *
 * ## Why a strategy is not its own thing
 *
 * A backtest is the third consumer of one grammar, and it is the one that makes the grammar earn
 * its keep. "SMA 20 crosses above SMA 50" now has exactly one meaning across three places that
 * would otherwise each hold their own copy:
 *
 *   - `src/alerts/rules.ts` fires on it when it happens;
 *   - `src/analysis/backtest.ts` measures what happened the last two hundred times it happened;
 *   - `src/pine/emit.ts` writes it as a TradingView `strategy()` you can run against their data.
 *
 * That third one is the reason `toPineSpec` lives here. A backtest whose numbers cannot be
 * reproduced on the chart the user actually looks at is a number with no way to check it, and the
 * usual reason two backtests of "the same" strategy disagree is that they were never the same
 * strategy — one entered on `rsi < 30` and the other on `ta.crossover(rsi, 30)`.
 *
 * ## Long-only, and that is accuracy rather than a shortcut
 *
 * Retail short selling is effectively unavailable on IDX. A long/short engine here would report
 * returns the user cannot realise, which is worse than not offering the feature.
 */
import type { Level } from "../core/indicators.js";
import type { PineSpec, Signal } from "../pine/emit.js";
import type { Condition, Operator, Overlay, Panel } from "./series.js";
import { OVERLAY_PRESETS, PANEL_PRESETS } from "./series.js";

export interface StrategySpec {
  name: string;
  /** Human sentence for reports. Derived when absent. */
  description?: string;
  overlays: Overlay[];
  panels: Panel[];
  /** Opens a long, evaluated on a closed bar. */
  entry: Condition;
  /**
   * Closes it. Optional, but a spec with neither `exit` nor `maxHoldBars` can only ever be closed
   * by a stop, a target, or the end of the data — see `requireAnExit`.
   */
  exit?: Condition;
  /** Percent below the fill price, e.g. 5 for -5%. */
  stopLossPct?: number;
  /** Percent above the fill price. */
  takeProfitPct?: number;
  /** Forced exit after this many bars held. */
  maxHoldBars?: number;
}

/**
 * A spec that can never close a position measures nothing.
 *
 * Without this, a "strategy" of `close crossover sma20` and no exit buys once and holds to the end
 * of the data, and reports a total return that is buy-and-hold with a late start and worse costs.
 * It looks like a result. It is the benchmark wearing a hat.
 */
export function requireAnExit(spec: StrategySpec): void {
  if (!spec.exit && spec.stopLossPct === undefined && spec.takeProfitPct === undefined && spec.maxHoldBars === undefined) {
    throw new Error(
      `Strategy ${JSON.stringify(spec.name)} has no way to close a position. ` +
        "Give it an `exit` condition, a stop_loss_pct, a take_profit_pct, or max_hold_bars — " +
        "otherwise it buys once and holds, and its return is buy-and-hold with extra steps.",
    );
  }
}

/* ---------------------------------- the presets ---------------------------------- */

const O = OVERLAY_PRESETS;
const P = PANEL_PRESETS;

/**
 * The nine strategies `strategy_compare` runs, all expressible in the shared grammar.
 *
 * Two decisions worth stating, because both are easy to get backwards and neither announces itself:
 *
 * **Mean-reversion entries use a crossing, not a threshold.** `rsi14 < 30` is true on *every bar*
 * of an oversold stretch, so a backtest of it re-enters on every one of them and what it measures
 * is the cost model, not the strategy. `rsi14 crossover 30` fires once, on the bar the condition
 * becomes true. The grammar has crossing operators for exactly this and using them is not a style
 * preference.
 *
 * **Donchian breakout compares against the channel with a crossing too.** `close > dcUpper20` is
 * never true: the channel includes the current bar, so the close that sets a new high *is* the
 * high. `high crossover dcUpper20` is the bar where the channel was taken out.
 */
export const STRATEGY_PRESETS = {
  sma_cross: {
    name: "sma_cross",
    description: "Long while the 20-day average is above the 50-day.",
    overlays: [O.sma20, O.sma50],
    panels: [],
    entry: { left: "sma20", op: "crossover", right: "sma50" },
    exit: { left: "sma20", op: "crossunder", right: "sma50" },
  },
  ema_cross: {
    name: "ema_cross",
    description: "The same trade on exponential averages, which turn sooner and whipsaw more.",
    overlays: [O.ema20, O.ema50],
    panels: [],
    entry: { left: "ema20", op: "crossover", right: "ema50" },
    exit: { left: "ema20", op: "crossunder", right: "ema50" },
  },
  golden_cross: {
    name: "golden_cross",
    description: "The classic 50/200 crossover. Few trades, long holds — expect a small sample.",
    overlays: [O.sma50, O.sma200],
    panels: [],
    entry: { left: "sma50", op: "crossover", right: "sma200" },
    exit: { left: "sma50", op: "crossunder", right: "sma200" },
  },
  price_above_ma: {
    name: "price_above_ma",
    description: "Hold whenever price is above its 50-day average.",
    overlays: [O.sma50],
    panels: [],
    entry: { left: "close", op: "crossover", right: "sma50" },
    exit: { left: "close", op: "crossunder", right: "sma50" },
  },
  macd_cross: {
    name: "macd_cross",
    description: "Long when MACD crosses above its signal line.",
    overlays: [],
    panels: [P.macd],
    entry: { left: "macdLine", op: "crossover", right: "macdSignal" },
    exit: { left: "macdLine", op: "crossunder", right: "macdSignal" },
  },
  rsi_reversion: {
    name: "rsi_reversion",
    description: "Buy the recovery out of oversold, sell into overbought.",
    overlays: [],
    panels: [P.rsi],
    entry: { left: "rsi14", op: "crossover", right: 30 },
    exit: { left: "rsi14", op: "crossover", right: 70 },
    maxHoldBars: 40,
  },
  rsi_trend: {
    name: "rsi_trend",
    description: "Momentum rather than reversion: long above 50, out below.",
    overlays: [],
    panels: [P.rsi],
    entry: { left: "rsi14", op: "crossover", right: 50 },
    exit: { left: "rsi14", op: "crossunder", right: 50 },
  },
  bollinger_breakout: {
    name: "bollinger_breakout",
    description: "Long on a close above the upper band, out at the basis.",
    overlays: [O.bollinger],
    panels: [],
    entry: { left: "close", op: "crossover", right: "bbUpper" },
    exit: { left: "close", op: "crossunder", right: "bbMiddle" },
  },
  donchian_breakout: {
    name: "donchian_breakout",
    description: "Long when the 20-day high is taken out, out when the 20-day low is.",
    overlays: [O.donchian20],
    panels: [],
    entry: { left: "high", op: "crossover", right: "dcUpper20" },
    exit: { left: "low", op: "crossunder", right: "dcLower20" },
  },
} as const satisfies Record<string, StrategySpec>;

export type PresetId = keyof typeof STRATEGY_PRESETS;

export const PRESET_IDS = Object.keys(STRATEGY_PRESETS) as [PresetId, ...PresetId[]];

export function presetSpec(id: PresetId): StrategySpec {
  // Structured-cloned so a caller applying a stop to one run cannot mutate the shared preset and
  // silently change every later comparison in the same process.
  return structuredClone(STRATEGY_PRESETS[id]) as StrategySpec;
}

export function describeStrategy(spec: StrategySpec): string {
  if (spec.description) return spec.description;
  const say = (c: Condition) => `${c.left} ${wordFor(c.op)} ${c.right}`;
  const parts = [`enter when ${say(spec.entry)}`];
  if (spec.exit) parts.push(`exit when ${say(spec.exit)}`);
  if (spec.stopLossPct !== undefined) parts.push(`stop ${spec.stopLossPct}%`);
  if (spec.takeProfitPct !== undefined) parts.push(`target ${spec.takeProfitPct}%`);
  if (spec.maxHoldBars !== undefined) parts.push(`max hold ${spec.maxHoldBars} bars`);
  return parts.join(", ");
}

function wordFor(op: Operator): string {
  return op === "crossover" ? "crosses above" : op === "crossunder" ? "crosses below" : op === "cross" ? "crosses" : op;
}

/* --------------------------------- the Pine bridge --------------------------------- */

export interface ToPineOptions {
  symbol: string;
  levels?: Level[];
  levelsFrom?: string;
  levelsTo?: string;
}

/**
 * The same spec as a TradingView `strategy()` script.
 *
 * This is what makes the one-grammar claim checkable rather than merely asserted: the entry and
 * exit conditions become named signals over the *same* operand identifiers `compileCondition`
 * resolved locally, so a disagreement between the two backtests is a disagreement about data or
 * cost model, never about what the strategy was.
 *
 * Pine executes a bar-close order at the next bar's open, which is precisely the fill model
 * `backtest.ts` uses — so the two are comparable, not merely similar.
 */
export function toPineSpec(spec: StrategySpec, opts: ToPineOptions): PineSpec {
  const signals: Signal[] = [
    { name: `${spec.name} entry`, ...spec.entry, message: `${spec.name}: entry` },
  ];
  if (spec.exit) signals.push({ name: `${spec.name} exit`, ...spec.exit, message: `${spec.name}: exit` });

  return {
    symbol: opts.symbol,
    kind: "strategy",
    title: `${opts.symbol} — ${spec.name}`,
    overlays: spec.overlays,
    panels: spec.panels,
    levels: opts.levels,
    levelsFrom: opts.levelsFrom,
    levelsTo: opts.levelsTo,
    signals,
    // Pine forbids `alertcondition` inside a strategy script; the emitter honours that, and saying
    // so here rather than passing `alerts: true` and having it dropped keeps the two in agreement.
    alerts: false,
    strategy: {
      longWhen: signals[0].name,
      exitWhen: spec.exit ? signals[1].name : undefined,
      stopLossPct: spec.stopLossPct,
      takeProfitPct: spec.takeProfitPct,
    },
  };
}
