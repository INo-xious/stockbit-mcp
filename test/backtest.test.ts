/**
 * Backtest engine tests.
 *
 * The important one is `a backtest over the first N bars is a prefix of the backtest over all
 * bars`. Every form of lookahead — an indicator peeking forward, a fill at the signal bar's own
 * close, a stop checked against a future bar — breaks it, and nothing else does. One assertion
 * covering an entire class of bug is worth more than a dozen checking individual numbers.
 */
// Isolate the token store before importing anything that reads it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const STORE = mkdtempSync(join(tmpdir(), "stockbit-backtest-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { ROWS_PER_PAGE } from "../src/core/bars.ts";
import { registerTools } from "../src/tools/register.ts";
import { resolveToolProfile } from "../src/tools/_profile.ts";
import {
  IDX_COSTS,
  backtest,
  compareStrategies,
  type Costs,
} from "../src/analysis/backtest.ts";
import {
  PRESET_IDS,
  STRATEGY_PRESETS,
  presetSpec,
  requireAnExit,
  toPineSpec,
  type StrategySpec,
} from "../src/analysis/strategy.ts";
import { buildPine } from "../src/pine/emit.ts";
import type { Bar } from "../src/core/bars.ts";

/* ------------------------------------- fixtures ------------------------------------- */

const ANCHOR = Date.parse("2024-01-01T00:00:00Z");

interface BarInput {
  open?: number;
  high?: number;
  low?: number;
  close: number;
}

function makeBars(rows: Array<number | BarInput>): Bar[] {
  return rows.map((r, i) => {
    const row: BarInput = typeof r === "number" ? { close: r } : r;
    const close = row.close;
    return {
      date: new Date(ANCHOR + i * 86_400_000).toISOString().slice(0, 10),
      open: row.open ?? close,
      high: row.high ?? Math.max(row.open ?? close, close) + 1,
      low: row.low ?? Math.min(row.open ?? close, close) - 1,
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
  });
}

/**
 * Deterministic, choppy price series — real-ish without a dependency or a fixture file.
 *
 * Two cycles plus noise rather than a smooth drift, on purpose. A gently trending walk produces two
 * moving-average crossings in four hundred bars, which makes every test below technically pass and
 * actually vacuous: an engine that never opens a position cannot demonstrate that it opens them
 * correctly. This oscillates hard enough that every preset trades tens of times.
 */
function walk(n: number, seed = 42): Bar[] {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const rows: BarInput[] = [];
  let prev = 1000;
  for (let i = 0; i < n; i++) {
    const cycle = Math.sin(i / 11) * 90 + Math.sin(i / 37) * 130;
    const close = Math.max(50, 1000 + cycle + (rand() - 0.5) * 40);
    rows.push({
      open: prev,
      close,
      high: Math.max(prev, close) + rand() * 10,
      low: Math.min(prev, close) - rand() * 10,
    });
    prev = close;
  }
  return makeBars(rows);
}

const NO_COSTS: Costs = { commissionBuyPct: 0, commissionSellPct: 0, slippagePct: 0 };

/** Cross once up, then once down — one clean trade, hand-checkable. */
function oneTradeSpec(): StrategySpec {
  return {
    name: "test",
    overlays: [],
    panels: [],
    entry: { left: "close", op: "crossover", right: 100 },
    exit: { left: "close", op: "crossunder", right: 100 },
  };
}

/* --------------------------- the property that matters --------------------------- */

test("a backtest over the first N bars is a PREFIX of the backtest over all bars", () => {
  // Any lookahead anywhere breaks this and nothing else does. If an indicator peeked forward, or a
  // fill happened at the signal bar's own close, or a stop were checked against a later bar, then
  // a trade that closed inside the prefix would come out differently when more data existed.
  const bars = walk(500);
  let comparedTrades = 0;

  for (const id of PRESET_IDS) {
    const spec = presetSpec(id);
    // A stop and a target on every strategy, so the intrabar paths are exercised too.
    spec.stopLossPct = 5;
    spec.takeProfitPct = 8;

    const full = backtest(bars, spec, { costs: IDX_COSTS });

    for (const cut of [220, 330, 440]) {
      const prefix = backtest(bars.slice(0, cut), spec, { costs: IDX_COSTS });

      // Only trades that CLOSED strictly inside the prefix are comparable — one still open at the
      // cut is force-closed there, which is a different (and honestly reported) event.
      const closedInPrefix = prefix.trades.filter((t) => !t.forcedClose && t.exitIndex < cut - 1);
      const sameFromFull = full.trades.filter((t) => t.exitIndex < cut - 1 && !t.forcedClose);

      assert.deepEqual(
        closedInPrefix,
        sameFromFull.slice(0, closedInPrefix.length),
        `${id}: trades closed before bar ${cut} must not change when later bars are added`,
      );
      comparedTrades += closedInPrefix.length;
    }
  }

  // An engine that never opens a position passes every deepEqual above trivially. This is the
  // guard that the test actually exercised something.
  assert.ok(comparedTrades > 100, `only ${comparedTrades} trades were compared — the fixture is too quiet to prove anything`);
});

/* ------------------------------- the execution model ------------------------------- */

test("a fill happens at the NEXT bar's open, never at the signal bar's close", () => {
  // 99 -> 101 crosses 100 at index 1. The fill must be at index 2's open (140), not index 1's
  // close (101) — the price the strategy consulted to make the decision.
  const bars = makeBars([99, 101, { open: 140, close: 145 }, 150, 90, { open: 80, close: 82 }]);
  const result = backtest(bars, oneTradeSpec(), { costs: NO_COSTS, initialCapital: 1_000_000 });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryIndex, 2);
  assert.equal(result.trades[0].entryPrice, 140, "filled at the next open, not the signal close");
});

test("a signal on the FINAL bar produces no trade — there is no next bar to fill at", () => {
  const bars = makeBars([99, 98, 97, 101]);
  const result = backtest(bars, oneTradeSpec(), { costs: NO_COSTS });
  assert.equal(result.trades.length, 0);
});

test("a flat round trip loses exactly the costs, to the last decimal", () => {
  // Nothing moved. Whatever came off the top is the cost model and only the cost model.
  const bars = makeBars([99, 101, { open: 100, close: 100 }, 100, 99, { open: 100, close: 100 }]);
  const costs: Costs = { commissionBuyPct: 0.15, commissionSellPct: 0.25, slippagePct: 0.1 };
  const result = backtest(bars, oneTradeSpec(), { costs, initialCapital: 1_000_000 });

  assert.equal(result.trades.length, 1);
  const t = result.trades[0];
  assert.equal(t.entryPrice, 100 * 1.001, "buy slips up");
  assert.equal(t.exitPrice, 100 * 0.999, "sell slips down");

  // buy at 100.1 + 0.15%, sell at 99.9 - 0.25%. Compared at the 4dp the field is stored to —
  // on a percentage that is a part in ten million, far finer than the cost model it is checking.
  const expected = ((99.9 * 0.9975 - 100.1 * 1.0015) / (100.1 * 1.0015)) * 100;
  assert.equal(t.returnPct, Number(expected.toFixed(4)), `expected ${expected}, got ${t.returnPct}`);
  assert.ok(t.returnPct < 0, "a flat round trip must lose money");
});

test("a bar that hits BOTH the stop and the target resolves to the stop", () => {
  // Daily OHLC does not say which came first. Resolving it optimistically is how a backtest turns
  // a coin flip into an edge, once per ambiguous bar.
  const spec: StrategySpec = { ...oneTradeSpec(), stopLossPct: 5, takeProfitPct: 5 };
  const bars = makeBars([
    99,
    101,
    { open: 100, close: 100, high: 101, low: 99 },
    { open: 100, close: 100, high: 120, low: 80 }, // reaches +20% and -20% on one bar
  ]);
  const result = backtest(bars, spec, { costs: NO_COSTS });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].exitReason, "stop-loss");
});

test("a gap THROUGH a stop fills at the open, not at the stop price", () => {
  // Assuming the level always fills is how a backtest survives a limit-down a real position
  // would not have.
  const spec: StrategySpec = { ...oneTradeSpec(), stopLossPct: 5 };
  const bars = makeBars([
    99,
    101,
    { open: 100, close: 100, high: 101, low: 99 },
    { open: 70, close: 70, high: 71, low: 69 }, // gapped straight through a 95 stop
  ]);
  const result = backtest(bars, spec, { costs: NO_COSTS });

  assert.equal(result.trades[0].exitReason, "stop-loss");
  assert.equal(result.trades[0].exitPrice, 70, "the stop at 95 was unreachable; 70 is where it filled");
});

test("a locked (ARA/ARB) session defers the fill instead of inventing a price", () => {
  // high === low means IDX auto-rejection: one price, no two-sided market. Filling there is the
  // difference between a breakout backtest that means something and one that buys every limit-up.
  const bars = makeBars([
    99,
    101,
    { open: 120, close: 120, high: 120, low: 120 }, // locked — cannot transact
    { open: 130, close: 132 },
    90,
    { open: 85, close: 85 },
  ]);
  const result = backtest(bars, oneTradeSpec(), { costs: NO_COSTS });

  assert.equal(result.trades.length, 1);
  assert.equal(result.trades[0].entryIndex, 3, "the order carried to the first tradeable session");
  assert.equal(result.trades[0].entryPrice, 130);
});

test("no trade opens before the strategy's indicators are valid", () => {
  const bars = walk(120);
  const spec = presetSpec("golden_cross"); // needs an SMA 200 it will never get
  const result = backtest(bars, spec);

  assert.equal(result.firstTradeableIndex, -1);
  assert.equal(result.trades.length, 0);
  assert.match(result.warnings[0], /not enough history/);
});

test("firstTradeableIndex accounts for the EXIT condition, not just the entry", () => {
  // A position that could be opened but never closed on a signal is not a strategy, it is a hold.
  const spec: StrategySpec = {
    name: "asymmetric",
    overlays: [{ kind: "sma", period: 5 }, { kind: "sma", period: 60 }],
    panels: [],
    entry: { left: "close", op: "crossover", right: "sma5" },
    exit: { left: "close", op: "crossunder", right: "sma60" },
  };
  const result = backtest(walk(200), spec);
  assert.ok(result.firstTradeableIndex >= 59, `entry is ready at bar 4 but the exit is not until 59`);
});

test("minEntryIndex holds trading back while still letting indicators warm up", () => {
  // Walk-forward needs exactly this: an out-of-sample fold must see the bars its indicators need
  // without being allowed to trade inside them.
  const bars = walk(300);
  const spec = presetSpec("sma_cross");
  const held = backtest(bars, spec, { minEntryIndex: 200 });
  assert.equal(held.firstTradeableIndex, 200);
  assert.ok(held.trades.every((t) => t.entryIndex >= 200));
});

/* ---------------------------------- the metrics ---------------------------------- */

test("buy-and-hold starts where the STRATEGY could first trade, not at bar zero", () => {
  // Otherwise a 200-bar warm-up hands the benchmark a free leg of trend and the comparison is
  // decided by whatever happened before either side could act.
  const bars = walk(400);
  const result = backtest(bars, presetSpec("golden_cross"));
  assert.ok(result.firstTradeableIndex > 0);

  const startClose = bars[result.firstTradeableIndex].close;
  const endClose = bars[bars.length - 1].close;
  const naive = ((endClose - startClose) / startClose) * 100;
  // Costs make it slightly worse than the naive figure, but it must be in the same country.
  assert.ok(
    Math.abs(result.metrics.buyHoldReturnPct! - naive) < 5,
    `buy-and-hold ${result.metrics.buyHoldReturnPct} should be near ${naive} (measured from the tradeable bar)`,
  );
});

test("profit factor is null, never Infinity, when there are no losing trades", () => {
  // JSON.stringify(Infinity) is `null` and so is JSON.stringify(NaN) — silently. An infinite
  // profit factor would arrive at the caller indistinguishable from "not computed".
  const bars = makeBars([99, 101, { open: 100, close: 100 }, 130, 99, { open: 150, close: 150 }]);
  const result = backtest(bars, oneTradeSpec(), { costs: NO_COSTS });

  assert.equal(result.metrics.losses, 0);
  assert.equal(result.metrics.profitFactor, null);
  assert.notEqual(result.metrics.profitFactor, Infinity);
  assert.ok(result.warnings.some((w) => /undefined rather than infinite/.test(w)));
});

test("every metric is a finite number or an explicit null — never NaN, never Infinity", () => {
  for (const bars of [makeBars([100]), makeBars([100, 100, 100]), walk(30), walk(400)]) {
    for (const id of PRESET_IDS) {
      const result = backtest(bars, presetSpec(id));
      for (const [key, value] of Object.entries(result.metrics)) {
        if (value === null) continue;
        // The two drawdown bounds are dates; everything else is a number.
        if (key === "maxDrawdownFrom" || key === "maxDrawdownTo") {
          assert.equal(typeof value, "string", `${id}/${key}`);
          continue;
        }
        assert.equal(typeof value, "number", `${id}/${key}`);
        assert.ok(Number.isFinite(value as number), `${id}/${key} was ${value}`);
      }
      // And the whole payload must survive a JSON round trip unchanged.
      assert.deepEqual(JSON.parse(JSON.stringify(result.metrics)), result.metrics, id);
    }
  }
});

test("zero trades is reported as zero trades, with a warning rather than a return", () => {
  const flat = makeBars(Array.from({ length: 80 }, () => 100));
  const result = backtest(flat, oneTradeSpec(), { costs: IDX_COSTS });
  assert.equal(result.trades.length, 0);
  assert.equal(result.metrics.totalReturnPct, 0);
  assert.equal(result.metrics.winRatePct, null);
  assert.ok(result.warnings.some((w) => /never triggered/.test(w)));
});

test("a small sample is called a small sample", () => {
  const result = backtest(makeBars([99, 101, { open: 100, close: 100 }, 130, 99, { open: 90, close: 90 }, 88]), oneTradeSpec());
  assert.ok(result.warnings.some((w) => /too few to distinguish this strategy from luck/.test(w)));
});

test("exposure is reported beside Sharpe, because a flat strategy flatters an equity-curve Sharpe", () => {
  const result = backtest(walk(400), presetSpec("rsi_reversion"));
  assert.ok(result.metrics.exposurePct >= 0 && result.metrics.exposurePct <= 100);
  assert.equal(typeof result.metrics.barsPerYear, "number");
  assert.equal(result.metrics.barsPerYear, 246, "IDX, not 252");
});

test("the equity curve has one point per bar and its drawdown never goes negative", () => {
  const result = backtest(walk(300), presetSpec("sma_cross"));
  assert.equal(result.equity.length, 300);
  assert.ok(result.equity.every((p) => p.drawdownPct >= 0));
  assert.equal(result.equity[0].date, result.from);
});

test("positions are whole lots, because IDX has no odd-lot board", () => {
  const result = backtest(walk(200), presetSpec("sma_cross"), { initialCapital: 7_777_777 });
  for (const t of result.trades) {
    assert.equal(t.shares % 100, 0, "a fill must be a whole number of 100-share lots");
    assert.equal(t.shares, t.lots * 100);
  }
});

/* -------------------------------- the strategy specs -------------------------------- */

test("a strategy with no way to close a position is refused, not silently held", () => {
  // Without this it buys once, holds to the end, and reports buy-and-hold with worse costs as if
  // it were a result.
  assert.throws(
    () => requireAnExit({ name: "hold", overlays: [], panels: [], entry: { left: "close", op: ">", right: 1 } }),
    /no way to close a position/,
  );
  assert.throws(() => backtest(walk(50), { name: "hold", overlays: [], panels: [], entry: { left: "close", op: ">", right: 1 } }));

  // Any one of these is enough.
  for (const closer of [{ maxHoldBars: 5 }, { stopLossPct: 5 }, { takeProfitPct: 5 }]) {
    assert.doesNotThrow(() =>
      requireAnExit({ name: "ok", overlays: [], panels: [], entry: { left: "close", op: ">", right: 1 }, ...closer }),
    );
  }
});

test("mean-reversion presets enter on a CROSSING, not on a standing threshold", () => {
  // `rsi14 < 30` is true on every bar of an oversold stretch, so a backtest of it re-enters on all
  // of them and measures the cost model rather than the strategy.
  assert.equal(STRATEGY_PRESETS.rsi_reversion.entry.op, "crossover");
  assert.equal(STRATEGY_PRESETS.rsi_trend.entry.op, "crossover");
  // And the Donchian channel includes the current bar, so `close > dcUpper` is never true.
  assert.equal(STRATEGY_PRESETS.donchian_breakout.entry.op, "crossover");
});

test("every preset is runnable and closeable", () => {
  const bars = walk(500);
  for (const id of PRESET_IDS) {
    const spec = presetSpec(id);
    assert.doesNotThrow(() => requireAnExit(spec), id);
    const result = backtest(bars, spec);
    assert.equal(result.strategy, id);
    assert.ok(result.description.length > 10, `${id} needs a real description`);
  }
});

test("presetSpec hands back a copy, so mutating one run cannot change the next", () => {
  const a = presetSpec("sma_cross");
  a.stopLossPct = 99;
  assert.equal(presetSpec("sma_cross").stopLossPct, undefined);
  assert.equal((STRATEGY_PRESETS.sma_cross as StrategySpec).stopLossPct, undefined);
});

/* ---------------------------- the one-grammar property ---------------------------- */

test("ONE GRAMMAR: a backtested strategy emits Pine over the same operand identifiers", () => {
  // This is what makes the backtest checkable: the TradingView strategy fires on the same
  // condition, over the same declared series, so a disagreement between the two is about data or
  // costs — never about what the strategy was.
  for (const id of PRESET_IDS) {
    const spec = presetSpec(id);
    const pine = buildPine(toPineSpec(spec, { symbol: "BBRI" }));

    for (const operand of [spec.entry.left, spec.entry.right, spec.exit?.left, spec.exit?.right]) {
      if (typeof operand !== "string") continue;
      // A price builtin is written as-is in Pine; a declared series gets an assignment line.
      const isBuiltin = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"].includes(operand);
      const pattern = isBuiltin ? new RegExp(`\\b${operand}\\b`) : new RegExp(`\\b${operand} = `);
      assert.match(pine, pattern, `${id}: Pine is missing the operand ${operand}`);
    }
    assert.match(pine, /^strategy\(/m, `${id} must emit a strategy(), not an indicator()`);
  }
});

test("a Pine strategy does not claim alertcondition, which Pine forbids there", () => {
  const spec = toPineSpec(presetSpec("sma_cross"), { symbol: "BBRI" });
  assert.equal(spec.alerts, false);
  assert.doesNotMatch(buildPine(spec), /alertcondition/);
});

/* ---------------------------------- comparison ---------------------------------- */

test("compareStrategies runs every spec over ONE bar array and ranks by excess return", () => {
  const bars = walk(400);
  const specs = PRESET_IDS.map((id) => presetSpec(id));
  const comparison = compareStrategies(bars, specs, { symbol: "BBRI" });

  assert.equal(comparison.results.length, PRESET_IDS.length);
  assert.equal(comparison.ranking.length, PRESET_IDS.length);
  assert.deepEqual(
    comparison.ranking.map((r) => r.rank),
    comparison.ranking.map((_, i) => i + 1),
  );
  for (let i = 1; i < comparison.ranking.length; i++) {
    const prev = comparison.ranking[i - 1].excessReturnPct ?? -Infinity;
    const cur = comparison.ranking[i].excessReturnPct ?? -Infinity;
    assert.ok(prev >= cur, "ranking must be ordered by excess return");
  }
  // Ranking nine strategies on one window and taking the winner is a selection, not a finding.
  assert.match(comparison.note, /selection, not a finding/);
});

test("comparison results are identical to running each strategy alone", () => {
  const bars = walk(300);
  const specs = [presetSpec("sma_cross"), presetSpec("rsi_trend")];
  const comparison = compareStrategies(bars, specs);
  for (const spec of specs) {
    const alone = backtest(bars, spec);
    const inComparison = comparison.results.find((r) => r.strategy === spec.name)!;
    assert.deepEqual(inComparison.trades, alone.trades);
    assert.deepEqual(inComparison.metrics, alone.metrics);
  }
});

/* ------------------------------------ edge cases ------------------------------------ */

test("an empty or single-bar series does not throw", () => {
  for (const bars of [[], makeBars([100])]) {
    const result = backtest(bars, oneTradeSpec());
    assert.equal(result.trades.length, 0);
    assert.equal(result.bars, bars.length);
  }
});

test("a position open on the last bar is closed and flagged as a mark, not a realised trade", () => {
  const bars = makeBars([99, 101, { open: 100, close: 100 }, 110, 120, 130]);
  const result = backtest(bars, oneTradeSpec(), { costs: NO_COSTS });
  assert.equal(result.openTradeAtEnd, true);
  assert.equal(result.trades[0].exitReason, "end-of-data");
  assert.equal(result.trades[0].forcedClose, true);
  assert.ok(result.warnings.some((w) => /a mark, not a realised trade/.test(w)));
});

test("max-hold closes a position the strategy would otherwise never let go of", () => {
  const spec: StrategySpec = {
    name: "held",
    overlays: [],
    panels: [],
    entry: { left: "close", op: "crossover", right: 100 },
    exit: { left: "close", op: "crossunder", right: 1 }, // never true
    maxHoldBars: 3,
  };
  const bars = makeBars([99, 101, { open: 100, close: 100 }, 105, 110, 115, 120, 125]);
  const result = backtest(bars, spec, { costs: NO_COSTS });
  assert.equal(result.trades[0].exitReason, "max-hold");
  assert.equal(result.trades[0].barsHeld, 3);
});

test("MAE and MFE record how painful a trade was to hold", () => {
  const bars = makeBars([
    99,
    101,
    { open: 100, close: 100, high: 100, low: 100 },
    { open: 100, close: 95, high: 102, low: 80 }, // -20% at the low, +2% at the high
    99,
    { open: 98, close: 98 },
  ]);
  const result = backtest(bars, oneTradeSpec(), { costs: NO_COSTS });
  assert.ok(result.trades[0].maxAdversePct <= -20, `MAE was ${result.trades[0].maxAdversePct}`);
  assert.ok(result.trades[0].maxFavorablePct >= 2);
});

/* ------------------------------ the backtest TOOL, not the engine ------------------------------ */

/**
 * Everything above this line calls `backtest()` directly. These four call the registered TOOL.
 *
 * That gap is why they exist: the tool's own return object — `notes`, the `include_trades` switch,
 * `barsTruncated`, `pagesFetched` — was covered by nothing at all. `docs/TOOLS.md` renders only
 * arguments, the surface snapshot records only arguments, and every backtest test read the engine.
 * A wrong sentence in `notes` would have shipped through a green gate.
 */
const REAL_FETCH = globalThis.fetch;
type ToolEntry = { shape: z.ZodRawShape; handler: (a: Record<string, unknown>) => Promise<unknown> };
const toolRegistry = new Map<string, ToolEntry>();

/**
 * 260 sessions that oscillate, so `sma_cross` actually crosses.
 *
 * The first version of this fixture was 40 bars of one up-then-down move. `PRESET_IDS[0]` is
 * `sma_cross`, whose 50-period average needs 50 bars of warm-up, so the strategy could never fire
 * and every test below ran against a backtest the engine itself calls vacuous ("No bar in this
 * window could satisfy the strategy's conditions"). All four still passed — including the one whose
 * whole purpose is to check that dropping the trade log changes no metric, which cannot see a
 * metric change when there are no trades and every metric is null.
 *
 * `assertTrades` below is the guard against that happening again silently.
 */
const TOOL_BARS = Array.from({ length: 260 }, (_, i) => {
  const close = Math.round(1000 + 300 * Math.sin(i / 14));
  return {
    date: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    open: close,
    high: close + 10,
    low: close - 10,
    close,
    average: close,
    volume: 5_000,
    value: 1e9,
    frequency: 300,
  };
}).reverse(); // newest first, the order the wire uses

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.includes("/login/refresh") || u.includes("/refresh")) {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      return json({ data: { access_token: `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig` } });
    }
    if (u.includes("/company-price-feed/historical/summary/")) {
      const page = Number(new URL(u).searchParams.get("page") ?? "1");
      const slice = TOOL_BARS.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);
      const more = TOOL_BARS.length > page * ROWS_PER_PAGE;
      return json({ data: { result: slice, paginate: more ? { next_page: page + 1 } : {} } });
    }
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;

  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodRawShape }, cb: ToolEntry["handler"]) => {
      toolRegistry.set(name, { shape: config.inputSchema, handler: cb });
    },
  } as unknown as McpServer;
  registerTools(server, { profile: resolveToolProfile("all").profile });
});

after(() => {
  globalThis.fetch = REAL_FETCH;
  getStore().clear();
  resetSession();
  clearCache();
  rmSync(STORE, { recursive: true, force: true });
});

/** Run the registered tool and unwrap its JSON text block, the way `invokeTool` does. */
async function runBacktestTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  clearCache();
  const entry = toolRegistry.get("backtest");
  assert.ok(entry, "backtest is not registered");
  const result = (await entry.handler(args)) as { content: { text: string }[] };
  const parsed = JSON.parse(result.content[0].text) as { success: boolean; data: Record<string, unknown> };
  assert.equal(parsed.success, true, `backtest failed: ${result.content[0].text.slice(0, 300)}`);
  return parsed.data;
}

/** Every test here is meaningless against a backtest that never traded. Say so out loud. */
function assertTrades(data: Record<string, unknown>): void {
  const metrics = data.metrics as { trades?: number } | undefined;
  assert.ok(
    (metrics?.trades ?? 0) > 0,
    `the fixture must produce trades or these tests prove nothing — warnings: ${JSON.stringify(data.warnings)}`,
  );
}

test("the backtest tool includes the trade log by default and says so in notes", async () => {
  const data = await runBacktestTool({ symbol: "BBRI", strategy: PRESET_IDS[0], bars: 260 });
  assertTrades(data);
  assert.ok(Array.isArray(data.trades), "the log is present by default");
  assert.ok((data.trades as unknown[]).length > 0, "and it is not empty");
  const notes = data.notes as string[];
  assert.ok(Array.isArray(notes) && notes.length === 1);
  assert.match(notes[0], /full trade log is included/);
  assert.match(notes[0], /include_trades=false/, "a note about a switch must name the switch");
});

test("include_trades=false drops the log and the note changes to match", async () => {
  const data = await runBacktestTool({
    symbol: "BBRI",
    strategy: PRESET_IDS[0],
    bars: 260,
    include_trades: false,
  });
  assertTrades(data);
  assert.ok(!("trades" in data), "an undefined key is absent from the JSON, not null");
  const notes = data.notes as string[];
  assert.match(notes[0], /dropped/, "the note must not still claim the log is included");
  assert.doesNotMatch(notes[0], /full trade log is included/);
});

test("notes never dilutes warnings — they stay separate lists", async () => {
  // `warnings` is sample-size and data-quality caveats about THIS run, and the tool's description
  // tells a model to read it before quoting any number. A housekeeping sentence in there would
  // weaken exactly the signal that is meant to stop a claim.
  const data = await runBacktestTool({ symbol: "BBRI", strategy: PRESET_IDS[0], bars: 260 });
  assertTrades(data);
  assert.ok(Array.isArray(data.warnings), "the engine's warnings survive the tool layer");
  for (const w of data.warnings as string[]) {
    assert.doesNotMatch(w, /include_trades/, "the trade-log note belongs in notes, not in warnings");
  }
});

test("dropping the trade log does not change a single metric", async () => {
  // The note claims the metrics are computed from all the trades either way. This is that claim.
  const withLog = await runBacktestTool({ symbol: "BBRI", strategy: PRESET_IDS[0], bars: 260 });
  const without = await runBacktestTool({
    symbol: "BBRI",
    strategy: PRESET_IDS[0],
    bars: 260,
    include_trades: false,
  });
  assertTrades(withLog);
  assertTrades(without);
  assert.deepEqual(without.metrics, withLog.metrics);
  assert.deepEqual(without.warnings, withLog.warnings);
  // The claim in the note is about the ARITHMETIC, so check a metric that only trades can produce.
  assert.equal(
    (without.metrics as { trades: number }).trades,
    (withLog.metrics as { trades: number }).trades,
    "the trade COUNT must not change with the log's visibility",
  );
});
