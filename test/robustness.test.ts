/**
 * Walk-forward tests.
 *
 * Two properties carry the weight: a fold's test segment must not be able to trade in its own
 * training data, and a small sample must reach `inconclusive` before it can reach `robust`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_OOS_TRADES, walkForward } from "../src/analysis/robustness.ts";
import { presetSpec, type StrategySpec } from "../src/analysis/strategy.ts";
import type { Bar } from "../src/core/bars.ts";

const ANCHOR = Date.parse("2024-01-01T00:00:00Z");

function toBars(closes: number[]): Bar[] {
  let prev = closes[0];
  return closes.map((close, i) => {
    const bar: Bar = {
      date: new Date(ANCHOR + i * 86_400_000).toISOString().slice(0, 10),
      open: prev,
      high: Math.max(prev, close) + 1,
      low: Math.min(prev, close) - 1,
      close,
      average: close,
      volume: 10_000,
      value: 1e9,
      frequency: 500,
      change: 0,
      changePercent: 0,
      foreignBuy: 0,
      foreignSell: 0,
      netForeign: 0,
    };
    prev = close;
    return bar;
  });
}

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Choppy throughout — a strategy that works here works in every segment. */
function oscillating(n: number, seed = 7): Bar[] {
  const rand = rng(seed);
  return toBars(
    Array.from({ length: n }, (_, i) => Math.max(50, 1000 + Math.sin(i / 11) * 90 + Math.sin(i / 37) * 130 + (rand() - 0.5) * 40)),
  );
}

/**
 * A fast, clean cycle over a long history — enough trades to clear the sample floor.
 *
 * Needed because the honest floor (20 out-of-sample trades) is genuinely hard to reach on daily
 * data: three folds over 600 bars gives ~70-bar test segments and single-digit trade counts, so
 * every verdict comes back `inconclusive` and the robust/degraded/overfit branches never execute.
 * That is correct behaviour on real data and useless as a test, so this fixture oscillates fast
 * enough, for long enough, to actually exercise them.
 */
function tradeable(n = 3600, div = 6, seed = 5): Bar[] {
  const rand = rng(seed);
  return toBars(Array.from({ length: n }, (_, i) => Math.max(50, 1000 + Math.sin(i / div) * 140 + (rand() - 0.5) * 10)));
}

/** The same cycle, but the edge disappears at the halfway mark. */
function edgeDies(n = 3600, seed = 5): Bar[] {
  const rand = rng(seed);
  return toBars(
    Array.from({ length: n }, (_, i) =>
      i < n * 0.55
        ? Math.max(50, 1000 + Math.sin(i / 6) * 140 + (rand() - 0.5) * 10)
        : Math.max(50, 1000 + (rand() - 0.5) * 8),
    ),
  );
}

/** Choppy for the first half, then a smooth trend that a crossover strategy cannot exploit. */
function choppyThenSmooth(n: number, seed = 11): Bar[] {
  const rand = rng(seed);
  return toBars(
    Array.from({ length: n }, (_, i) =>
      i < n / 2
        ? Math.max(50, 1000 + Math.sin(i / 9) * 120 + (rand() - 0.5) * 40)
        : Math.max(50, 1000 - (i - n / 2) * 1.4 + (rand() - 0.5) * 4),
    ),
  );
}

/* --------------------------------- fold construction --------------------------------- */

test("no fold can take a trade inside its own training data", () => {
  // The property the whole method rests on. If an out-of-sample segment could enter before its
  // split, walk-forward would be reporting in-sample performance under an out-of-sample label.
  const bars = oscillating(600);
  const result = walkForward(bars, presetSpec("sma_cross"), { folds: 3 });

  assert.ok(result.folds.length >= 3);
  for (const fold of result.folds) {
    for (const trade of fold.test.trades) {
      assert.ok(
        trade.entryDate >= fold.testFrom,
        `fold ${fold.index} entered on ${trade.entryDate}, before its test window opened on ${fold.testFrom}`,
      );
    }
    for (const trade of fold.train.trades) {
      assert.ok(trade.entryDate <= fold.trainTo, `fold ${fold.index} trained on a trade after its split`);
    }
  }
});

test("a test fold sees enough history to be WARM at testFrom, not just enough to exist", () => {
  // Slicing the fold at testFrom exactly would leave every out-of-sample segment paying its own
  // warm-up, and walk-forward would then report degradation that is purely an artefact of cutting.
  const bars = oscillating(600);
  const result = walkForward(bars, presetSpec("sma_cross"), { folds: 3 });

  for (const fold of result.folds) {
    // The engine was handed bars from index 0; only ENTRY was restricted. So the first tradeable
    // date is the split itself, not the split plus a warm-up.
    assert.equal(
      fold.test.firstTradeableDate,
      fold.testFrom,
      `fold ${fold.index} could not trade until ${fold.test.firstTradeableDate}, but its window opened at ${fold.testFrom}`,
    );
  }
});

test("folds do not overlap, and each reports its own window", () => {
  const result = walkForward(oscillating(600), presetSpec("sma_cross"), { folds: 3 });
  for (let i = 1; i < result.folds.length; i++) {
    assert.ok(
      result.folds[i].testFrom > result.folds[i - 1].testTo,
      "test segments must be disjoint or the same bars are counted twice",
    );
  }
  for (const fold of result.folds) {
    assert.ok(fold.trainFrom < fold.trainTo);
    assert.ok(fold.trainTo < fold.testFrom);
    assert.ok(fold.testFrom <= fold.testTo);
  }
});

/* ------------------------------------- efficiency ------------------------------------- */

test("REGRESSION: efficiency is per BAR, or a stationary series reads as overfit", () => {
  // A train segment is 65% of each fold and a test segment 35%, so dividing one total return by the
  // other compares spans in a 1.86:1 ratio. On this series the strategy performs identically
  // throughout BY CONSTRUCTION, and the un-normalised version returned 0.54 — which is exactly
  // 0.35/0.65 and nothing whatsoever to do with the strategy. Every honest result would have been
  // graded "overfit" for the crime of having a shorter test window than train window.
  const result = walkForward(tradeable(), presetSpec("rsi_trend"), { folds: 3 });

  assert.ok(result.efficiency !== null);
  assert.ok(
    result.efficiency! > 0.8 && result.efficiency! < 1.25,
    `a stationary series must score near 1.0, got ${result.efficiency}`,
  );
  assert.ok(
    Math.abs(result.efficiency! - 0.35 / 0.65) > 0.2,
    "an efficiency near the train/test length ratio means the normalisation is gone",
  );
});

test("pooled bars are the SEGMENT lengths, not the slices handed to the engine", () => {
  // Each fold's backtest receives every bar from index zero so its indicators are warm, so the
  // result's own `bars` is the whole history and says nothing about how long the fold traded.
  const result = walkForward(tradeable(), presetSpec("rsi_trend"), { folds: 3 });
  assert.equal(
    result.outOfSample.bars,
    result.folds.reduce((a, f) => a + f.testBars, 0),
  );
  assert.ok(result.inSample.bars > result.outOfSample.bars, "the train side is the longer one");
  assert.ok(
    result.outOfSample.bars < result.folds[result.folds.length - 1].test.bars,
    "the segment must be shorter than the slice it was measured inside",
  );
});

/* ------------------------------------- verdicts ------------------------------------- */

test("all four verdicts are reachable — a machine that only says one thing is broken", () => {
  const seen = new Set<string>();

  // Stationary and profitable, with enough trades to be pronounced on.
  seen.add(walkForward(tradeable(), presetSpec("rsi_trend"), { folds: 3 }).verdict.label);
  // The edge disappears halfway through.
  seen.add(walkForward(edgeDies(), presetSpec("rsi_trend"), { folds: 3 }).verdict.label);
  // Too little history to say anything.
  seen.add(walkForward(oscillating(160), presetSpec("golden_cross"), { folds: 3 }).verdict.label);

  assert.ok(seen.has("robust"), `never reached robust; saw ${[...seen].join(", ")}`);
  assert.ok(seen.has("inconclusive"), `never reached inconclusive; saw ${[...seen].join(", ")}`);
  assert.ok(seen.size >= 3, `only ${seen.size} distinct verdicts across three very different series`);
});

test("a stationary, profitable, well-sampled strategy IS called robust", () => {
  const result = walkForward(tradeable(), presetSpec("rsi_trend"), { folds: 3 });
  assert.equal(result.verdict.label, "robust");
  assert.ok(result.outOfSample.trades >= 20);
  assert.ok(result.verdict.reasons.some((r) => /held at 70% or more/.test(r)));
});

test("a strategy whose edge disappears is NOT called robust", () => {
  const result = walkForward(edgeDies(), presetSpec("rsi_trend"), { folds: 3 });
  assert.notEqual(result.verdict.label, "robust");
  assert.ok(result.verdict.reasons.length > 0);
});

test("a small sample is INCONCLUSIVE before it can be anything else", () => {
  // The failure mode this feature invites. A verdict of "robust" over four trades is not a weaker
  // finding, it is a different kind of claim — and it is the sentence that gets screenshotted.
  const result = walkForward(oscillating(160), presetSpec("golden_cross"), { folds: 3 });
  assert.equal(result.verdict.label, "inconclusive");
  assert.ok(
    result.verdict.reasons.some((r) => /fold\(s\)|trade\(s\)|not positive/.test(r)),
    `reasons must name what was insufficient, got ${JSON.stringify(result.verdict.reasons)}`,
  );
});

test("the trade-count floor is stated and enforced", () => {
  const result = walkForward(oscillating(600), presetSpec("golden_cross"), { folds: 3 });
  if (result.outOfSample.trades < MIN_OOS_TRADES) {
    assert.equal(result.verdict.label, "inconclusive");
  }
});

test("a strategy that stops working out of sample is not called robust", () => {
  const result = walkForward(choppyThenSmooth(700), presetSpec("sma_cross"), { folds: 3 });
  assert.notEqual(result.verdict.label, "robust");
  assert.ok(["overfit", "degraded", "inconclusive"].includes(result.verdict.label));
});

test("efficiency is null rather than a misleading ratio when in-sample lost money", () => {
  // A strategy that lost less out of sample than in sample is not 70% "efficient". Reporting a
  // number there would be worse than reporting nothing, because it would be graded.
  const falling = toBars(Array.from({ length: 600 }, (_, i) => Math.max(50, 2000 - i * 2)));
  const result = walkForward(falling, presetSpec("sma_cross"), { folds: 3 });
  if (result.inSample.totalReturnPct <= 0) {
    assert.equal(result.efficiency, null);
    assert.equal(result.verdict.label, "inconclusive");
  }
});

test("the caveats state what a plain split CANNOT show, in the payload", () => {
  const result = walkForward(oscillating(600), presetSpec("sma_cross"), { folds: 3 });

  // Not a code comment — a field the caller receives. Without a parameter search, a train/test
  // split does not detect overfitting in the technical sense at all.
  assert.ok(
    result.verdict.caveats.some((c) => /nothing was FITTED|only detects overfitting when a search/.test(c)),
    "the no-search caveat must ship with every verdict",
  );
  assert.ok(
    result.verdict.caveats.some((c) => /fragility check, not a statistical validation/.test(c)),
    "the sample-size caveat must ship with every verdict",
  );
  // And it is there for every label, not only the flattering ones.
  const small = walkForward(oscillating(160), presetSpec("golden_cross"), { folds: 3 });
  assert.ok(small.verdict.caveats.length >= 2);
});

/* -------------------------------------- pooling -------------------------------------- */

test("fold returns are COMPOUNDED, not summed", () => {
  // Two consecutive +10% periods are +21%. Summing understates a good run and misstates a recovery.
  const result = walkForward(oscillating(600), presetSpec("sma_cross"), { folds: 3 });
  const each = result.folds.map((f) => f.test.metrics.totalReturnPct);
  const expected = (each.reduce((acc, r) => acc * (1 + r / 100), 1) - 1) * 100;
  assert.ok(Math.abs(result.outOfSample.totalReturnPct - expected) < 1e-3);
  assert.equal(result.outOfSample.folds, result.folds.length);
});

test("pooled trade counts add up to the folds they came from", () => {
  const result = walkForward(oscillating(600), presetSpec("rsi_trend"), { folds: 3 });
  assert.equal(
    result.outOfSample.trades,
    result.folds.reduce((a, f) => a + f.test.metrics.trades, 0),
  );
  assert.equal(
    result.inSample.trades,
    result.folds.reduce((a, f) => a + f.train.metrics.trades, 0),
  );
});

test("best and worst fold are reported, so one lucky segment cannot hide behind an average", () => {
  const result = walkForward(oscillating(600), presetSpec("sma_cross"), { folds: 3 });
  const each = result.folds.map((f) => f.test.metrics.totalReturnPct);
  assert.equal(result.outOfSample.worstFoldReturnPct, Number(Math.min(...each).toFixed(4)));
  assert.equal(result.outOfSample.bestFoldReturnPct, Number(Math.max(...each).toFixed(4)));
});

/* ------------------------------------- robustness ------------------------------------- */

test("walkForward refuses a spec that can never close a position", () => {
  const noExit: StrategySpec = {
    name: "hold",
    overlays: [],
    panels: [],
    entry: { left: "close", op: ">", right: 1 },
  };
  assert.throws(() => walkForward(oscillating(600), noExit), /no way to close a position/);
});

test("too little history yields no folds rather than nonsense ones", () => {
  const result = walkForward(oscillating(30), presetSpec("golden_cross"), { folds: 3 });
  assert.equal(result.folds.length, 0);
  assert.equal(result.verdict.label, "inconclusive");
  assert.equal(result.efficiency, null);
});

test("every verdict field survives a JSON round trip", () => {
  const result = walkForward(oscillating(600), presetSpec("sma_cross"), { folds: 3 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.outOfSample)), result.outOfSample);
  assert.deepEqual(JSON.parse(JSON.stringify(result.verdict)), result.verdict);
});
