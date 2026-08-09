/**
 * A long-only backtest over daily Stockbit bars.
 *
 * Pure: bars in, results out. No network, no clock, no dependency on how the bars were obtained.
 *
 * ## The execution model, stated so it can be argued with
 *
 * Almost every way a backtest lies is a decision in this list taken the flattering way. None of
 * them announces itself — each produces a smoother equity curve and no error at all — so each is
 * written down here with the failure it avoids.
 *
 * **Signals are read at bar close; fills happen at the next bar's open.** Every indicator at index
 * `i` is computed from data through `bars[i].close`, so a condition that holds at `i` is only
 * knowable once `i` has closed. Filling at `bars[i].close` would be transacting at a price the
 * strategy consulted in order to decide — the classic lookahead bug, and the one that turns a
 * mediocre rule into a spectacular one. A signal on the final bar therefore produces no trade, only
 * a note. `test/backtest.test.ts` proves the absence of lookahead structurally: a backtest over the
 * first N bars must be a prefix of the backtest over all of them.
 *
 * **Stops win ties.** Daily OHLC does not record whether the low or the high came first. When a bar
 * breaches the stop *and* reaches the target, this takes the stop. Resolving that the other way is
 * how a backtest converts a coin flip into an edge — once per ambiguous bar, compounding.
 *
 * **A gap through a level fills at the open, not at the level.** A stop at 3,000 on a bar that
 * opens at 2,850 fills at 2,850. Assuming the level always fills is how a backtest survives a
 * limit-down that a real position would not have.
 *
 * **A locked session cannot be traded.** When `high === low`, the session was auto-rejected
 * (ARA/ARB) and there was no two-sided market at any price. The order is deferred to the next bar
 * rather than filled at a price nobody could transact at. This one is IDX-specific and it is the
 * difference between a breakout backtest that means something and one that buys every limit-up.
 *
 * **Buy-and-hold is measured over the same window,** from `firstTradeableIndex`, paying the same
 * commission and slippage on one buy and one sell. Benchmarking a strategy with a 200-bar warm-up
 * against a buy-and-hold that started 200 bars earlier hands the benchmark a free leg of trend and
 * decides the comparison before either has traded.
 *
 * **Sharpe comes from the equity curve's daily returns, never from trade returns.** Trade-return
 * Sharpe is a different and much more flattering statistic that gets quoted as if it were this one.
 * Because an equity-curve Sharpe rewards being flat, `exposurePct` is reported beside it: a Sharpe
 * of 2.0 earned on 8% of days is a different claim from the same number earned on 90%.
 *
 * **No metric reaches the caller as Infinity or NaN.** `JSON.stringify` turns both into `null`
 * silently, which would make "no losing trades" indistinguishable from "not computed". Every metric
 * is a finite number or an explicit `null`, and `warnings` says which case applied.
 */
import type { Bar } from "../core/bars.js";
import { compileCondition, defineSeries, warmupFor, type CompiledCondition } from "./series.js";
import { describeStrategy, requireAnExit, type StrategySpec } from "./strategy.js";

/* ------------------------------------- costs ------------------------------------- */

export interface Costs {
  /** Percent of notional paid on the buy. */
  commissionBuyPct: number;
  /** Percent of notional paid on the sell. */
  commissionSellPct: number;
  /** Percent moved against you on both sides. */
  slippagePct: number;
}

/**
 * IDX-realistic defaults.
 *
 * Indonesian retail brokers charge roughly 0.15% to buy and 0.25% to sell. The asymmetry is not a
 * markup: it is the 0.1% final income tax levied on sale proceeds. Stockbit's own default pair is
 * this one.
 *
 * Slippage stands in for the bid-ask spread *and* for IDX's banded tick sizes, which are not
 * modelled separately. Rounding fills to a tick without also modelling queue position would move a
 * fill by less than the spread while implying the spread had been accounted for — false precision.
 * Folding it into one honestly-estimated number is the smaller lie.
 */
export const IDX_COSTS: Costs = { commissionBuyPct: 0.15, commissionSellPct: 0.25, slippagePct: 0.1 };

export interface BacktestOptions {
  symbol?: string;
  /** IDR. Default 10,000,000. */
  initialCapital?: number;
  costs?: Partial<Costs>;
  /** Round position size down to whole 100-share lots. Default true — IDX has no odd-lot board. */
  roundLots?: boolean;
  /** Annualisation basis. 246, not 252: that is the IDX trading calendar. */
  barsPerYear?: number;
  /** Annual risk-free rate for Sharpe, in percent. Default 0, and echoed back in the metrics. */
  riskFreeAnnualPct?: number;
  /**
   * No entry before this index. Used by walk-forward so an out-of-sample fold can see the bars its
   * indicators need without being allowed to trade in them.
   */
  minEntryIndex?: number;
}

const SHARES_PER_LOT = 100;

/* ------------------------------------ results ------------------------------------ */

export type ExitReason = "signal" | "stop-loss" | "take-profit" | "max-hold" | "end-of-data";

export interface Trade {
  entryIndex: number;
  entryDate: string;
  entryPrice: number;
  exitIndex: number;
  exitDate: string;
  exitPrice: number;
  exitReason: ExitReason;
  lots: number;
  shares: number;
  /** Commission plus slippage, both sides, in IDR. */
  costIdr: number;
  pnlIdr: number;
  returnPct: number;
  barsHeld: number;
  /** Worst and best mark-to-market during the hold — whether a winner was ever painful to hold. */
  maxAdversePct: number;
  maxFavorablePct: number;
  /** True when the end of the data closed this, not the strategy. */
  forcedClose: boolean;
}

export interface EquityPoint {
  date: string;
  equity: number;
  cash: number;
  positionValue: number;
  drawdownPct: number;
}

export interface Metrics {
  trades: number;
  wins: number;
  losses: number;
  totalReturnPct: number;
  cagrPct: number | null;
  sharpe: number | null;
  sortino: number | null;
  calmar: number | null;
  maxDrawdownPct: number;
  maxDrawdownFrom: string | null;
  maxDrawdownTo: string | null;
  winRatePct: number | null;
  /** `null` rather than Infinity when there were no losing trades. */
  profitFactor: number | null;
  expectancyIdr: number | null;
  expectancyPct: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  avgBarsHeld: number | null;
  /** Fraction of tradeable bars spent holding a position. */
  exposurePct: number;
  buyHoldReturnPct: number | null;
  buyHoldMaxDrawdownPct: number | null;
  excessReturnPct: number | null;
  riskFreeAnnualPct: number;
  barsPerYear: number;
}

export interface BacktestResult {
  symbol?: string;
  strategy: string;
  description: string;
  costs: Costs;
  initialCapital: number;
  from: string | null;
  to: string | null;
  bars: number;
  warmupBars: number;
  firstTradeableIndex: number;
  firstTradeableDate: string | null;
  trades: Trade[];
  equity: EquityPoint[];
  metrics: Metrics;
  openTradeAtEnd: boolean;
  /** Sample-size and data-quality caveats. Never decorative — see `collectWarnings`. */
  warnings: string[];
}

/* ------------------------------------- helpers ------------------------------------- */

/** Finite or null. The single door every metric leaves through. */
function finite(value: number): number | null {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

/** A session with no two-sided market: IDX auto-rejection locked it at one price. */
function isLocked(bar: Bar): boolean {
  return bar.high === bar.low;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1));
}

/* ------------------------------------ the engine ------------------------------------ */

export function backtest(bars: Bar[], spec: StrategySpec, opts: BacktestOptions = {}): BacktestResult {
  requireAnExit(spec);

  const costs: Costs = { ...IDX_COSTS, ...opts.costs };
  const initialCapital = opts.initialCapital ?? 10_000_000;
  const roundLots = opts.roundLots !== false;
  const barsPerYear = opts.barsPerYear ?? 246;
  const riskFreeAnnualPct = opts.riskFreeAnnualPct ?? 0;
  const warmup = warmupFor(spec.overlays, spec.panels);

  const defs = defineSeries(spec.overlays, spec.panels);
  const entry = compileCondition(spec.entry, bars, defs);
  const exit = spec.exit ? compileCondition(spec.exit, bars, defs) : undefined;

  const firstTradeableIndex = firstTradeable(bars, entry, exit, opts.minEntryIndex);

  const trades: Trade[] = [];
  const equity: EquityPoint[] = [];

  let cash = initialCapital;
  let shares = 0;
  let peak = initialCapital;
  let maxDrawdownPct = 0;
  let maxDrawdownFrom: string | null = null;
  let maxDrawdownTo: string | null = null;
  let peakDate: string | null = null;
  let barsHolding = 0;

  /** The position currently open, if any. */
  let open: {
    entryIndex: number;
    /** The price actually paid, slippage included. */
    entryPrice: number;
    /** The quoted price before slippage, so total cost is reportable rather than implied. */
    entryRaw: number;
    lots: number;
    stop?: number;
    target?: number;
    worst: number;
    best: number;
  } | null = null;
  /** A signal seen at bar i, to be filled at bar i+1's open. */
  let pendingEntry = false;
  let pendingExit: ExitReason | null = null;

  const buyFill = (price: number) => price * (1 + costs.slippagePct / 100);
  const sellFill = (price: number) => price * (1 - costs.slippagePct / 100);

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    /* -- fills first: they act on a signal from the PREVIOUS bar, at this bar's open -- */

    if (pendingEntry && open === null) {
      if (isLocked(bar)) {
        // No two-sided market. Keep the order alive rather than inventing a fill.
        pendingEntry = true;
      } else {
        const price = buyFill(bar.open);
        const affordable = cash / (price * (1 + costs.commissionBuyPct / 100));
        const lots = roundLots ? Math.floor(affordable / SHARES_PER_LOT) : affordable / SHARES_PER_LOT;
        if (lots > 0) {
          const qty = lots * SHARES_PER_LOT;
          const notional = qty * price;
          cash -= notional * (1 + costs.commissionBuyPct / 100);
          shares = qty;
          open = {
            entryIndex: i,
            entryPrice: price,
            entryRaw: bar.open,
            lots,
            stop: spec.stopLossPct === undefined ? undefined : price * (1 - spec.stopLossPct / 100),
            target: spec.takeProfitPct === undefined ? undefined : price * (1 + spec.takeProfitPct / 100),
            worst: 0,
            best: 0,
          };
        }
        pendingEntry = false;
      }
    } else if (pendingExit && open !== null && !isLocked(bar)) {
      // A locked bar leaves `pendingExit` set, so the order carries forward to the next session
      // that actually has a two-sided market.
      closeAt(i, bar.open, pendingExit);
      pendingExit = null;
    }

    /* -- while holding: stops and targets are checked intrabar, from the fill bar onward -- */

    if (open !== null) {
      barsHolding++;
      const adverse = ((bar.low - open.entryPrice) / open.entryPrice) * 100;
      const favorable = ((bar.high - open.entryPrice) / open.entryPrice) * 100;
      if (adverse < open.worst) open.worst = adverse;
      if (favorable > open.best) open.best = favorable;

      const hitStop = open.stop !== undefined && bar.low <= open.stop;
      const hitTarget = open.target !== undefined && bar.high >= open.target;

      if (hitStop) {
        // Stop wins the tie. A bar that reached both is ambiguous in daily OHLC, and resolving it
        // the optimistic way is how a backtest manufactures an edge one ambiguous bar at a time.
        // A gap through the level fills at the OPEN, never at the level — assuming the level always
        // fills is how a backtest survives a limit-down a real position would not have.
        closeAt(i, Math.min(open.stop!, bar.open), "stop-loss");
      } else if (hitTarget) {
        closeAt(i, Math.max(open.target!, bar.open), "take-profit");
      } else if (spec.maxHoldBars !== undefined && i - open.entryIndex >= spec.maxHoldBars) {
        closeAt(i, bar.close, "max-hold");
      }
    }

    /* -- signals last: read at THIS close, acted on at the NEXT open -- */

    const tradeable = firstTradeableIndex >= 0 && i >= firstTradeableIndex;
    if (tradeable && i < bars.length - 1) {
      if (open === null && !pendingEntry && entry.holdsAt(i)) pendingEntry = true;
      else if (open !== null && !pendingExit && exit?.holdsAt(i)) pendingExit = "signal";
    }

    /* -- mark to market -- */

    const positionValue = shares * bar.close;
    const total = cash + positionValue;
    if (total > peak) {
      peak = total;
      peakDate = bar.date;
    }
    const drawdownPct = peak > 0 ? ((peak - total) / peak) * 100 : 0;
    if (drawdownPct > maxDrawdownPct) {
      maxDrawdownPct = drawdownPct;
      maxDrawdownFrom = peakDate;
      maxDrawdownTo = bar.date;
    }
    equity.push({
      date: bar.date,
      equity: Number(total.toFixed(2)),
      cash: Number(cash.toFixed(2)),
      positionValue: Number(positionValue.toFixed(2)),
      drawdownPct: Number(drawdownPct.toFixed(4)),
    });
  }

  // A position still open at the end is closed at the last close so the numbers are complete, and
  // flagged so nobody reads an unrealised mark as a realised result.
  const openTradeAtEnd = open !== null;
  if (open !== null && bars.length > 0) {
    const last = bars.length - 1;
    closeAt(last, bars[last].close, "end-of-data", true);
    const final = cash;
    equity[last] = { ...equity[last], equity: Number(final.toFixed(2)), cash: Number(final.toFixed(2)), positionValue: 0 };
  }

  /**
   * Close the open position at a QUOTED price; slippage is applied here so every exit — signal,
   * stop, target, max-hold, end-of-data — is costed identically. A stop that fills exactly at its
   * level is the one assumption a real stop never honours.
   */
  function closeAt(i: number, quoted: number, reason: ExitReason, forced = false): void {
    if (open === null) return;
    const price = sellFill(quoted);
    const qty = open.lots * SHARES_PER_LOT;
    const proceeds = qty * price;
    const sellCost = proceeds * (costs.commissionSellPct / 100);
    const buyNotional = qty * open.entryPrice;
    const buyCost = buyNotional * (costs.commissionBuyPct / 100);
    cash += proceeds - sellCost;
    shares = 0;

    const pnl = proceeds - sellCost - (buyNotional + buyCost);
    trades.push({
      entryIndex: open.entryIndex,
      entryDate: bars[open.entryIndex].date,
      entryPrice: Number(open.entryPrice.toFixed(4)),
      exitIndex: i,
      exitDate: bars[i].date,
      exitPrice: Number(price.toFixed(4)),
      exitReason: reason,
      lots: open.lots,
      shares: qty,
      // Commission both sides PLUS the slippage actually paid, rather than commission alone with
      // slippage hidden inside the fill prices where a reader cannot see what it cost.
      costIdr: Number(
        (buyCost + sellCost + qty * (open.entryPrice - open.entryRaw) + qty * (quoted - price)).toFixed(2),
      ),
      pnlIdr: Number(pnl.toFixed(2)),
      returnPct: Number(((pnl / (buyNotional + buyCost)) * 100).toFixed(4)),
      barsHeld: i - open.entryIndex,
      maxAdversePct: Number(open.worst.toFixed(4)),
      maxFavorablePct: Number(open.best.toFixed(4)),
      forcedClose: forced,
    });
    open = null;
  }

  const metrics = computeMetrics({
    bars,
    trades,
    equity,
    initialCapital,
    firstTradeableIndex,
    barsHolding,
    costs,
    barsPerYear,
    riskFreeAnnualPct,
    maxDrawdownPct,
    maxDrawdownFrom,
    maxDrawdownTo,
  });

  return {
    symbol: opts.symbol,
    strategy: spec.name,
    description: describeStrategy(spec),
    costs,
    initialCapital,
    from: bars[0]?.date ?? null,
    to: bars[bars.length - 1]?.date ?? null,
    bars: bars.length,
    warmupBars: warmup,
    firstTradeableIndex,
    firstTradeableDate: firstTradeableIndex >= 0 ? (bars[firstTradeableIndex]?.date ?? null) : null,
    trades,
    equity,
    metrics,
    openTradeAtEnd,
    warnings: collectWarnings(bars, trades, metrics, firstTradeableIndex, openTradeAtEnd),
  };
}

/**
 * The first bar an entry may be taken on.
 *
 * Computed explicitly rather than left to fall out of "a null operand makes `holdsAt` false",
 * because buy-and-hold is benchmarked from this index and the comparison is only fair if both
 * sides start on the same day.
 */
function firstTradeable(
  bars: Bar[],
  entry: CompiledCondition,
  exit: CompiledCondition | undefined,
  minEntryIndex?: number,
): number {
  if (bars.length === 0 || entry.firstValidIndex < 0) return -1;
  // The exit has to be answerable too, or the first position could never be closed on a signal.
  const exitReady = exit ? exit.firstValidIndex : 0;
  if (exitReady < 0) return -1;
  return Math.max(entry.firstValidIndex, exitReady, minEntryIndex ?? 0);
}

/* ------------------------------------ metrics ------------------------------------ */

interface MetricInput {
  bars: Bar[];
  trades: Trade[];
  equity: EquityPoint[];
  initialCapital: number;
  firstTradeableIndex: number;
  barsHolding: number;
  costs: Costs;
  barsPerYear: number;
  riskFreeAnnualPct: number;
  maxDrawdownPct: number;
  maxDrawdownFrom: string | null;
  maxDrawdownTo: string | null;
}

function computeMetrics(input: MetricInput): Metrics {
  const { bars, trades, equity, initialCapital, firstTradeableIndex, barsHolding, barsPerYear } = input;

  const finalEquity = equity[equity.length - 1]?.equity ?? initialCapital;
  const totalReturnPct = ((finalEquity - initialCapital) / initialCapital) * 100;

  const wins = trades.filter((t) => t.pnlIdr > 0);
  const losses = trades.filter((t) => t.pnlIdr <= 0);
  const grossProfit = wins.reduce((a, t) => a + t.pnlIdr, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlIdr, 0));

  // Daily returns of the equity CURVE, restricted to the tradeable window. Trade returns would give
  // a different and much more flattering Sharpe.
  const start = firstTradeableIndex >= 0 ? firstTradeableIndex : 0;
  const curve = equity.slice(start).map((e) => e.equity);
  const dailyReturns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    if (curve[i - 1] > 0) dailyReturns.push(curve[i] / curve[i - 1] - 1);
  }

  const rfDaily = input.riskFreeAnnualPct / 100 / barsPerYear;
  const excessDaily = dailyReturns.map((r) => r - rfDaily);
  const sd = stdev(excessDaily);
  const downside = Math.sqrt(mean(excessDaily.map((r) => (r < 0 ? r * r : 0))));
  const annualise = Math.sqrt(barsPerYear);

  const years = dailyReturns.length / barsPerYear;
  const cagr =
    years > 0 && finalEquity > 0 && initialCapital > 0
      ? ((finalEquity / initialCapital) ** (1 / years) - 1) * 100
      : Number.NaN;

  const bh = buyAndHold(bars, start, initialCapital, input.costs);
  const tradeableBars = Math.max(0, bars.length - start);

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    totalReturnPct: finite(totalReturnPct) ?? 0,
    cagrPct: finite(cagr),
    sharpe: sd > 0 ? finite((mean(excessDaily) / sd) * annualise) : null,
    sortino: downside > 0 ? finite((mean(excessDaily) / downside) * annualise) : null,
    calmar: input.maxDrawdownPct > 0 ? finite((finite(cagr) ?? 0) / input.maxDrawdownPct) : null,
    maxDrawdownPct: finite(input.maxDrawdownPct) ?? 0,
    maxDrawdownFrom: input.maxDrawdownFrom,
    maxDrawdownTo: input.maxDrawdownTo,
    winRatePct: trades.length > 0 ? finite((wins.length / trades.length) * 100) : null,
    // null, never Infinity: JSON.stringify(Infinity) is `null`, which would be indistinguishable
    // from "not computed" by the time it reached the caller.
    profitFactor: grossLoss > 0 ? finite(grossProfit / grossLoss) : null,
    expectancyIdr: trades.length > 0 ? finite(mean(trades.map((t) => t.pnlIdr))) : null,
    expectancyPct: trades.length > 0 ? finite(mean(trades.map((t) => t.returnPct))) : null,
    avgWinPct: wins.length > 0 ? finite(mean(wins.map((t) => t.returnPct))) : null,
    avgLossPct: losses.length > 0 ? finite(mean(losses.map((t) => t.returnPct))) : null,
    avgBarsHeld: trades.length > 0 ? finite(mean(trades.map((t) => t.barsHeld))) : null,
    exposurePct: tradeableBars > 0 ? (finite((barsHolding / tradeableBars) * 100) ?? 0) : 0,
    buyHoldReturnPct: bh.returnPct,
    buyHoldMaxDrawdownPct: bh.maxDrawdownPct,
    excessReturnPct: bh.returnPct === null ? null : finite(totalReturnPct - bh.returnPct),
    riskFreeAnnualPct: input.riskFreeAnnualPct,
    barsPerYear,
  };
}

/**
 * Buy at `start`, hold to the end, paying the same costs once each way.
 *
 * Deliberately not "the first bar of the data": a strategy needing 200 bars of warm-up would
 * otherwise be compared against a benchmark that had already been long for 200 sessions, and the
 * winner would be decided by whatever the market did during the warm-up.
 */
function buyAndHold(
  bars: Bar[],
  start: number,
  capital: number,
  costs: Costs,
): { returnPct: number | null; maxDrawdownPct: number | null } {
  if (start < 0 || start >= bars.length - 1) return { returnPct: null, maxDrawdownPct: null };

  const entryPrice = bars[start].close * (1 + costs.slippagePct / 100);
  const qty = Math.floor(capital / (entryPrice * (1 + costs.commissionBuyPct / 100)) / SHARES_PER_LOT) * SHARES_PER_LOT;
  if (qty <= 0) return { returnPct: null, maxDrawdownPct: null };

  const spent = qty * entryPrice * (1 + costs.commissionBuyPct / 100);
  const cash = capital - spent;

  let peak = capital;
  let maxDd = 0;
  for (let i = start; i < bars.length; i++) {
    const total = cash + qty * bars[i].close;
    if (total > peak) peak = total;
    const dd = ((peak - total) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }

  const exitPrice = bars[bars.length - 1].close * (1 - costs.slippagePct / 100);
  const proceeds = qty * exitPrice * (1 - costs.commissionSellPct / 100);
  const final = cash + proceeds;
  return { returnPct: finite(((final - capital) / capital) * 100), maxDrawdownPct: finite(maxDd) };
}

/**
 * The caveats that make a result readable.
 *
 * Populated, not decorative. The single most common way a backtest misleads is not a wrong number —
 * it is a right number computed over four trades and read as if it meant something.
 */
function collectWarnings(
  bars: Bar[],
  trades: Trade[],
  metrics: Metrics,
  firstTradeableIndex: number,
  openTradeAtEnd: boolean,
): string[] {
  const out: string[] = [];

  if (firstTradeableIndex < 0) {
    out.push(
      "No bar in this window could satisfy the strategy's conditions — there is not enough history " +
        "for its indicators. Nothing was traded and every metric below is vacuous.",
    );
    return out;
  }
  if (trades.length === 0) {
    out.push("The strategy never triggered over this window. Zero trades is a result, but it is not a return.");
  } else if (trades.length < 10) {
    out.push(
      `Only ${trades.length} trade(s). That is far too few to distinguish this strategy from luck — ` +
        "treat every ratio below as an anecdote, not an estimate.",
    );
  }
  if (bars.length < 100) {
    out.push(`Only ${bars.length} bars of history. Short windows flatter whichever strategy suited the period.`);
  }
  if (metrics.profitFactor === null && trades.length > 0 && metrics.losses === 0) {
    out.push(
      "No losing trades, so profit factor is undefined rather than infinite. With this few trades " +
        "that is a sign of a small sample, not of an edge.",
    );
  }
  if (openTradeAtEnd) {
    out.push(
      "A position was still open on the last bar and has been closed at that close. Its result is a " +
        "mark, not a realised trade.",
    );
  }
  if (metrics.exposurePct < 20 && metrics.sharpe !== null) {
    out.push(
      `The strategy held a position on only ${metrics.exposurePct.toFixed(1)}% of bars. An equity-curve ` +
        "Sharpe rewards being flat, so compare it against exposure rather than against a always-in strategy.",
    );
  }
  const forced = trades.filter((t) => t.forcedClose).length;
  if (forced > 0 && trades.length > 0) {
    out.push(`${forced} trade(s) were closed by the end of the data rather than by the strategy.`);
  }
  return out;
}

/* --------------------------------- comparison --------------------------------- */

export interface StrategyRanking {
  name: string;
  rank: number;
  totalReturnPct: number;
  excessReturnPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number;
  trades: number;
}

export interface ComparisonResult {
  symbol?: string;
  from: string | null;
  to: string | null;
  results: BacktestResult[];
  ranking: StrategyRanking[];
  rankedBy: string;
  note: string;
}

/**
 * Run several strategies over ONE bar array.
 *
 * The bars are the expensive part — tens of upstream requests — and they are fetched once for all
 * nine. Ranking is by return in excess of buy-and-hold rather than by raw return, because over a
 * rising window every long-only strategy shows a profit and the only question worth asking is
 * whether the trading added anything to owning the stock.
 */
export function compareStrategies(
  bars: Bar[],
  specs: StrategySpec[],
  opts: BacktestOptions = {},
): ComparisonResult {
  const results = specs.map((spec) => backtest(bars, spec, opts));

  const ranking: StrategyRanking[] = results
    .map((r) => ({
      name: r.strategy,
      rank: 0,
      totalReturnPct: r.metrics.totalReturnPct,
      excessReturnPct: r.metrics.excessReturnPct,
      sharpe: r.metrics.sharpe,
      maxDrawdownPct: r.metrics.maxDrawdownPct,
      trades: r.metrics.trades,
    }))
    .sort((a, b) => (b.excessReturnPct ?? -Infinity) - (a.excessReturnPct ?? -Infinity))
    .map((row, i) => ({ ...row, rank: i + 1 }));

  return {
    symbol: opts.symbol,
    from: bars[0]?.date ?? null,
    to: bars[bars.length - 1]?.date ?? null,
    results,
    ranking,
    rankedBy: "excessReturnPct (return above buy-and-hold over the same window and costs)",
    note:
      "Every strategy here was run over the same bars with the same costs. Ranking nine strategies " +
      "on one window and taking the winner is a selection, not a finding — run walk_forward on the " +
      "winner before believing it.",
  };
}
