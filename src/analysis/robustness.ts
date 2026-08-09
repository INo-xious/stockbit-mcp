/**
 * Walk-forward validation, and an honest verdict about what it can and cannot show.
 *
 * ## This costs nothing upstream
 *
 * Every fold re-runs pure local maths over bars already in hand. There is no reason to cap it out
 * of caution about "expensive analysis" — CPU is the only budget, and five folds of nine strategies
 * over five hundred bars is milliseconds.
 *
 * ## The thing this feature invites you to do wrong
 *
 * A verdict of "robust" pronounced over four trades is not a weaker version of a real finding, it
 * is a different kind of statement altogether — and it is the one users will screenshot. So
 * `inconclusive` is checked FIRST, before robust or overfit can be reached at all, and the sample
 * size that triggered it is named in `reasons`.
 *
 * ## And the thing it cannot show at all
 *
 * A plain train/test split does not detect overfitting in the technical sense unless something was
 * *fitted* on the train segment. With no parameter search, all this measures is whether a strategy
 * that worked in one period kept working in the next — worth knowing, but a different question.
 * Presenting it as an overfit test would be the dishonest version of this feature, so when no grid
 * was searched, `caveats` says so in the payload rather than in a comment nobody reads.
 */
import type { Bar } from "../core/bars.js";
import { backtest, type BacktestOptions, type BacktestResult, type Metrics } from "./backtest.js";
import { warmupFor } from "./series.js";
import { requireAnExit, type StrategySpec } from "./strategy.js";

export interface Fold {
  index: number;
  trainFrom: string;
  trainTo: string;
  testFrom: string;
  testTo: string;
  /** Sessions in each segment. Efficiency is meaningless without them — see `efficiencyOf`. */
  trainBars: number;
  testBars: number;
  train: BacktestResult;
  test: BacktestResult;
  /** The parameters chosen on the train segment, when a grid was searched. */
  chosen?: Record<string, number>;
}

export type VerdictLabel = "robust" | "degraded" | "overfit" | "inconclusive";

export interface OverfitVerdict {
  label: VerdictLabel;
  /** Why this label, naming the numbers that decided it. */
  reasons: string[];
  /** What this verdict is NOT entitled to say. */
  caveats: string[];
}

export interface WalkForwardResult {
  symbol?: string;
  strategy: string;
  folds: Fold[];
  /** Train segments, pooled. */
  inSample: PooledMetrics;
  /** Test segments, pooled. The only numbers worth quoting. */
  outOfSample: PooledMetrics;
  /** Out-of-sample return divided by in-sample return, per bar. `null` when undefined. */
  efficiency: number | null;
  verdict: OverfitVerdict;
}

export interface PooledMetrics {
  folds: number;
  trades: number;
  wins: number;
  /** Compounded across folds, as if the test segments were traded consecutively. */
  totalReturnPct: number;
  /** Per fold, so an average is not mistaken for a compounded result. */
  meanReturnPct: number;
  winRatePct: number | null;
  worstFoldReturnPct: number | null;
  bestFoldReturnPct: number | null;
  maxDrawdownPct: number;
  buyHoldReturnPct: number | null;
  bars: number;
}

export interface WalkForwardOptions {
  /** Default 3. More folds means shorter segments, which this data cannot really afford. */
  folds?: number;
  /** Share of each fold spent training. Default 0.65. */
  trainRatio?: number;
  backtest?: BacktestOptions;
}

/** Minimum pooled out-of-sample trades before any verdict other than `inconclusive`. */
export const MIN_OOS_TRADES = 20;

export function walkForward(
  bars: Bar[],
  spec: StrategySpec,
  opts: WalkForwardOptions = {},
): WalkForwardResult {
  requireAnExit(spec);

  const foldCount = Math.max(1, Math.floor(opts.folds ?? 3));
  const trainRatio = opts.trainRatio ?? 0.65;
  const warmup = warmupFor(spec.overlays, spec.panels);
  const folds: Fold[] = [];

  // Anchored, non-overlapping test segments across the usable span. The train segment for fold k is
  // everything from the start of its window to the split; the test segment is what follows.
  const usable = bars.length - warmup;
  const perFold = Math.floor(usable / foldCount);

  for (let k = 0; k < foldCount && perFold > 2; k++) {
    const windowStart = warmup + k * perFold;
    const windowEnd = k === foldCount - 1 ? bars.length : warmup + (k + 1) * perFold;
    const splitIndex = windowStart + Math.floor((windowEnd - windowStart) * trainRatio);
    if (splitIndex <= windowStart || splitIndex >= windowEnd - 1) continue;

    const train = backtest(bars.slice(0, splitIndex), spec, {
      ...opts.backtest,
      minEntryIndex: windowStart,
    });

    // The test fold sees ALL bars up to its end so its indicators are warm at `testFrom`, but no
    // entry may be taken before the split. Slicing at the split instead would leave every
    // out-of-sample fold crippled by its own warm-up, and walk-forward would then report
    // degradation that is purely an artefact of how the data was cut.
    const test = backtest(bars.slice(0, windowEnd), spec, {
      ...opts.backtest,
      minEntryIndex: splitIndex,
    });

    folds.push({
      index: k,
      trainFrom: bars[windowStart].date,
      trainTo: bars[splitIndex - 1].date,
      testFrom: bars[splitIndex].date,
      testTo: bars[windowEnd - 1].date,
      trainBars: splitIndex - windowStart,
      testBars: windowEnd - splitIndex,
      train,
      test,
    });
  }

  const inSample = pool(folds.map((f) => f.train), folds.map((f) => f.trainBars));
  const outOfSample = pool(folds.map((f) => f.test), folds.map((f) => f.testBars));
  const efficiency = efficiencyOf(inSample, outOfSample);

  return {
    symbol: opts.backtest?.symbol,
    strategy: spec.name,
    folds,
    inSample,
    outOfSample,
    efficiency,
    verdict: judge(folds, inSample, outOfSample, efficiency),
  };
}

/* ------------------------------------- pooling ------------------------------------- */

function pool(results: BacktestResult[], segmentBars: number[]): PooledMetrics {
  const each = results.map((r) => r.metrics);
  const returns = each.map((m) => m.totalReturnPct);
  const trades = each.reduce((a, m) => a + m.trades, 0);
  const wins = each.reduce((a, m) => a + m.wins, 0);

  // Compounded, not summed: two consecutive +10% periods are +21%, and reporting +20% understates
  // a good result and overstates a recovery from a loss.
  const compounded = returns.reduce((acc, r) => acc * (1 + r / 100), 1);
  const buyHolds = each.map((m) => m.buyHoldReturnPct).filter((v): v is number => v !== null);

  return {
    folds: results.length,
    trades,
    wins,
    totalReturnPct: Number(((compounded - 1) * 100).toFixed(4)),
    meanReturnPct: Number((returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0).toFixed(4)),
    winRatePct: trades > 0 ? Number(((wins / trades) * 100).toFixed(4)) : null,
    worstFoldReturnPct: returns.length ? Number(Math.min(...returns).toFixed(4)) : null,
    bestFoldReturnPct: returns.length ? Number(Math.max(...returns).toFixed(4)) : null,
    maxDrawdownPct: each.length ? Number(Math.max(...each.map((m) => m.maxDrawdownPct)).toFixed(4)) : 0,
    buyHoldReturnPct: buyHolds.length
      ? Number(((buyHolds.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100).toFixed(4))
      : null,
    // The SEGMENT lengths, not the slice lengths. A fold's backtest is handed every bar from index
    // zero so its indicators are warm, so `result.bars` is the whole history up to that point and
    // says nothing about how long the fold actually traded for.
    bars: segmentBars.reduce((a, b) => a + b, 0),
  };
}

/**
 * Out-of-sample performance as a fraction of in-sample, **per bar**.
 *
 * The per-bar part is not a refinement, it is the whole correctness of the number. A train segment
 * is 65% of each fold and a test segment is 35%, so comparing the two total returns compares
 * returns earned over spans in a 1.86:1 ratio. Measured on a deliberately stationary series — one
 * where the strategy performs identically throughout by construction — that gave an efficiency of
 * 0.54, which is exactly 0.35/0.65 and nothing to do with the strategy. Every result would have
 * been graded "overfit" for the crime of having a shorter test window than train window.
 *
 * So both sides are converted to a compounded growth rate per bar first.
 *
 * `null` rather than a number whenever the ratio would not mean anything: a negative or zero
 * in-sample return makes the quotient uninterpretable (a strategy that lost less out of sample than
 * in sample is not 70% "efficient"), and reporting a figure there would be worse than reporting
 * nothing, because it would then be graded against the thresholds below.
 */
function efficiencyOf(inSample: PooledMetrics, outOfSample: PooledMetrics): number | null {
  if (inSample.folds === 0 || inSample.bars <= 0 || outOfSample.bars <= 0) return null;
  if (inSample.totalReturnPct <= 0) return null;

  const perBar = (totalPct: number, bars: number): number => (1 + totalPct / 100) ** (1 / bars) - 1;
  const isRate = perBar(inSample.totalReturnPct, inSample.bars);
  const oosRate = perBar(outOfSample.totalReturnPct, outOfSample.bars);
  if (!Number.isFinite(isRate) || !Number.isFinite(oosRate) || isRate <= 0) return null;
  return Number((oosRate / isRate).toFixed(4));
}

/* ------------------------------------- verdict ------------------------------------- */

function judge(
  folds: Fold[],
  inSample: PooledMetrics,
  outOfSample: PooledMetrics,
  efficiency: number | null,
): OverfitVerdict {
  const reasons: string[] = [];
  const caveats: string[] = [
    "Only ~500 daily sessions (about two years) are reachable from this data source. Three folds " +
      "means roughly eight-month train and four-month test segments, which for a daily strategy is " +
      "a handful of trades each. This is a fragility check, not a statistical validation.",
    "No parameter grid was searched, so nothing was FITTED on the train segments. A train/test " +
      "split only detects overfitting when a search happened — what this measures is whether a " +
      "strategy that worked in one period kept working in the next. Worth knowing, different question.",
  ];

  // Checked first, on purpose. "Robust" over four trades is the failure mode this whole feature
  // invites, and it is the sentence that would get quoted.
  if (folds.length < 3) {
    reasons.push(`Only ${folds.length} fold(s) could be built from this history.`);
    return { label: "inconclusive", reasons, caveats };
  }
  if (outOfSample.trades < MIN_OOS_TRADES) {
    reasons.push(
      `${outOfSample.trades} out-of-sample trade(s), below the ${MIN_OOS_TRADES} this will pronounce on. ` +
        "Any verdict here would be about luck, not about the strategy.",
    );
    return { label: "inconclusive", reasons, caveats };
  }
  const emptyFolds = folds.filter((f) => f.test.metrics.trades === 0).length;
  if (emptyFolds > 0) {
    reasons.push(`${emptyFolds} fold(s) produced no out-of-sample trades at all, so the folds are not comparable.`);
    return { label: "inconclusive", reasons, caveats };
  }

  if (efficiency === null) {
    reasons.push(
      `In-sample return was ${inSample.totalReturnPct}%, which is not positive — there is no ` +
        "in-sample performance for the out-of-sample result to be a fraction of.",
    );
    return { label: "inconclusive", reasons, caveats };
  }

  reasons.push(
    `In-sample ${inSample.totalReturnPct}%, out-of-sample ${outOfSample.totalReturnPct}% ` +
      `across ${folds.length} folds and ${outOfSample.trades} trades (efficiency ${efficiency}).`,
  );

  if (efficiency < 0.3 || outOfSample.totalReturnPct < 0) {
    reasons.push(
      outOfSample.totalReturnPct < 0
        ? "The strategy made money in sample and lost it out of sample."
        : "Out-of-sample performance is under a third of in-sample.",
    );
    return { label: "overfit", reasons, caveats };
  }
  if (efficiency < 0.7) {
    reasons.push("Out-of-sample performance held up partially — between a third and 70% of in-sample.");
    return { label: "degraded", reasons, caveats };
  }

  const bh = outOfSample.buyHoldReturnPct;
  if (bh !== null && outOfSample.totalReturnPct <= bh) {
    reasons.push(
      `Out-of-sample performance held up, but it did not beat simply owning the stock ` +
        `(${outOfSample.totalReturnPct}% against ${bh}%). Consistency is not an edge.`,
    );
    return { label: "degraded", reasons, caveats };
  }

  reasons.push("Out-of-sample performance held at 70% or more of in-sample, and beat buy-and-hold.");
  return { label: "robust", reasons, caveats };
}
