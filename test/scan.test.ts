/**
 * Universe scan tests.
 *
 * All of them run against a fake `ScanDeps` — no network, no timers, no clock. That is only
 * possible because the module takes its dependencies rather than importing them, which is also what
 * stops it quietly gaining the ability to fetch something it was not handed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BUDGET, scan, symbolOf, type ScanDeps, type UniverseSource } from "../src/analysis/scan.ts";
import type { Bar } from "../src/core/bars.ts";

const ANCHOR = Date.parse("2026-08-05T00:00:00Z");

function series(closes: number[]): Bar[] {
  return closes.map((close, i) => ({
    date: new Date(ANCHOR - (closes.length - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    open: close,
    high: close + 2,
    low: close - 2,
    close,
    average: close,
    volume: 1000,
    value: 1e9,
    frequency: 100,
    change: 0,
    changePercent: 0,
    foreignBuy: 0,
    foreignSell: 0,
    netForeign: 0,
  }));
}

/** Rising, so `close > sma20` holds. */
const RISING = series(Array.from({ length: 120 }, (_, i) => 1000 + i * 5));
/** Falling, so it does not. */
const FALLING = series(Array.from({ length: 120 }, (_, i) => 2000 - i * 5));
/** Too short for an SMA 20 to exist. */
const SHORT = series([100, 101, 102]);

interface FakeOptions {
  bars?: Record<string, Bar[]>;
  fallback?: Bar[];
  throwFor?: Set<string>;
  pagesPerSymbol?: number;
  msPerCall?: number;
  universe?: string[];
}

/** Records every call, so a test asserts what was dispatched rather than only what came back. */
function fakeDeps(opts: FakeOptions = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  let clock = 0;

  const deps: ScanDeps = {
    getBars: async ({ symbol }) => {
      calls.push(symbol);
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      clock += opts.msPerCall ?? 0;
      inFlight--;
      if (opts.throwFor?.has(symbol)) throw new Error(`upstream exploded for ${symbol}`);
      return { bars: opts.bars?.[symbol] ?? opts.fallback ?? RISING, pagesFetched: opts.pagesPerSymbol ?? 10 };
    },
    resolveUniverse: async () => opts.universe ?? ["AAA", "BBB", "CCC"],
    now: () => clock,
  };
  return { deps, calls, peak: () => peakInFlight };
}

const SMA20: UniverseSource = { kind: "symbols", symbols: [] };
const ABOVE_SMA20 = { left: "close", op: ">" as const, right: "sma20" };
const OVERLAYS = [{ kind: "sma" as const, period: 20 }];

/* ------------------------------------ the basics ------------------------------------ */

test("a hit reports what matched and the values asked for", async () => {
  const { deps } = fakeDeps({ bars: { AAA: RISING, BBB: FALLING, CCC: RISING } });
  const result = await scan(
    { universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20], report: ["close", "sma20"] },
    deps,
  );

  assert.deepEqual(result.hits.map((h) => h.symbol), ["AAA", "CCC"]);
  assert.equal(result.hits[0].values.close, RISING[RISING.length - 1].close);
  assert.ok(typeof result.hits[0].values.sma20 === "number");
  assert.deepEqual(result.hits[0].matched, ["close > sma20"]);
});

test("warming-up is a DIFFERENT miss from condition-false", async () => {
  // The same distinction alert_check makes: only one of them is worth retrying with more history.
  const { deps } = fakeDeps({ bars: { AAA: RISING, BBB: FALLING, CCC: SHORT } });
  const result = await scan({ universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20] }, deps);

  const byReason = Object.fromEntries(result.misses.map((m) => [m.symbol, m.reason]));
  assert.equal(byReason.BBB, "condition-false");
  assert.equal(byReason.CCC, "warming-up", "three bars cannot answer an SMA 20 question");
});

test("a dead symbol becomes one miss, and the rest still evaluate", async () => {
  const { deps } = fakeDeps({ throwFor: new Set(["BBB"]) });
  const result = await scan({ universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20] }, deps);

  const dead = result.misses.find((m) => m.symbol === "BBB")!;
  assert.equal(dead.reason, "no-data");
  assert.match(dead.error!, /upstream exploded/);
  assert.deepEqual(result.hits.map((h) => h.symbol), ["AAA", "CCC"]);
});

test("ALL conditions must hold, and the failing one is named", async () => {
  const { deps } = fakeDeps({ fallback: RISING });
  const result = await scan(
    {
      universe: SMA20,
      overlays: OVERLAYS,
      conditions: [ABOVE_SMA20, { left: "close", op: "<", right: 0, name: "impossible" }],
    },
    deps,
  );
  assert.equal(result.hits.length, 0);
  assert.ok(result.misses.every((m) => m.failed === "impossible"));
});

test("zero hits over a healthy universe is distinguishable from a broken one", async () => {
  // The difference that matters: `evaluated > 0` says the sweep actually happened.
  const { deps } = fakeDeps({ fallback: FALLING });
  const result = await scan({ universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20] }, deps);

  assert.equal(result.hits.length, 0);
  assert.equal(result.universe.evaluated, 3);
  assert.equal(result.universe.discovered, 3);
});

/* -------------------------------------- budgets -------------------------------------- */

test("maxSymbols truncates and REPORTS what it did not reach", async () => {
  const { deps, calls } = fakeDeps({ universe: ["A", "B", "C", "D", "E", "F"] });
  const result = await scan(
    { universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20], budget: { maxSymbols: 2, concurrency: 1 } },
    deps,
  );

  assert.equal(calls.length, 2);
  assert.equal(result.truncated.symbols, 4);
  assert.equal(result.truncated.reason, "maxSymbols");
  assert.equal(result.cost.symbolsFetched, 2);
});

test("maxPages stops BEFORE dispatching the symbol that would exceed it", async () => {
  // A half-fetched symbol is spend with nothing to show for it, so the check is pre-dispatch.
  const { deps, calls } = fakeDeps({ universe: ["A", "B", "C", "D"], pagesPerSymbol: 10 });
  const result = await scan(
    { universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20], budget: { maxPages: 15, concurrency: 1 } },
    deps,
  );

  assert.equal(calls.length, 2, "two symbols cost 20 pages; the third was never dispatched");
  assert.equal(result.truncated.reason, "maxPages");
  assert.ok(result.truncated.symbols > 0);
});

test("maxMs stops the sweep, using the injected clock", async () => {
  const { deps, calls } = fakeDeps({ universe: ["A", "B", "C", "D", "E"], msPerCall: 400 });
  const result = await scan(
    { universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20], budget: { maxMs: 900, concurrency: 1 } },
    deps,
  );

  assert.ok(calls.length < 5, `the deadline must bite, ran ${calls.length}`);
  assert.equal(result.truncated.reason, "maxMs");
  assert.ok(result.cost.elapsedMs >= 900);
});

test("a complete sweep reports no truncation at all", async () => {
  const { deps } = fakeDeps({ universe: ["A", "B"] });
  const result = await scan({ universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20] }, deps);
  assert.equal(result.truncated.reason, null);
  assert.equal(result.truncated.symbols, 0);
});

test("in-flight symbols never exceed the concurrency limit", async () => {
  // Raising this past the HTTP limiter's own cap would not add throughput — the limiter serialises
  // request starts globally — it would only make the deadline less responsive.
  const { deps, peak } = fakeDeps({ universe: Array.from({ length: 12 }, (_, i) => `S${i}`) });
  await scan(
    { universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20], budget: { concurrency: 3, maxSymbols: 12 } },
    deps,
  );
  assert.ok(peak() <= 3, `peak in flight was ${peak()}`);
  assert.equal(DEFAULT_BUDGET.concurrency, 3, "the default mirrors the HTTP limiter");
});

/* ------------------------------------ cost reporting ------------------------------------ */

test("the bar count comes from the warm-up the conditions actually need", async () => {
  const { deps } = fakeDeps();
  const cheap = await scan({ universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20] }, deps);
  const dear = await scan(
    {
      universe: SMA20,
      overlays: [{ kind: "sma", period: 200 }],
      conditions: [{ left: "close", op: ">", right: "sma200" }],
    },
    deps,
  );
  assert.equal(cheap.barsPerSymbol, 30, "an SMA 20 screen needs 21, floored at 30");
  assert.equal(dear.barsPerSymbol, 201);
  assert.ok(dear.barsPerSymbol > cheap.barsPerSymbol * 5, "the cost difference must be visible up front");
});

test("cost reports pages and symbols, so a caller can see what a query spent", async () => {
  const { deps } = fakeDeps({ universe: ["A", "B", "C"], pagesPerSymbol: 4 });
  const result = await scan({ universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20] }, deps);
  assert.equal(result.cost.pagesFetched, 12);
  assert.equal(result.cost.symbolsFetched, 3);
  assert.match(result.note, /cached for six hours/);
});

/* ----------------------------- failing before spending ----------------------------- */

test("a typo in an operand fails BEFORE a single request goes out", async () => {
  // Discovering it symbol by symbol would mean paying for the whole universe first.
  const { deps, calls } = fakeDeps();
  await assert.rejects(
    () => scan({ universe: SMA20, overlays: OVERLAYS, conditions: [{ left: "close", op: ">", right: "sma21" }] }, deps),
    /not a declared series/,
  );
  assert.equal(calls.length, 0, "nothing may be fetched for a scan that cannot run");
});

test("an unresolvable report field is refused up front too", async () => {
  const { deps, calls } = fakeDeps();
  await assert.rejects(
    () => scan({ universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20], report: ["nonsense"] }, deps),
    /not a declared series/,
  );
  assert.equal(calls.length, 0);
});

test("a scan with no conditions is refused rather than matching everything", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(() => scan({ universe: SMA20, conditions: [] }, deps), /at least one condition/);
});

/* -------------------------------------- symbolOf -------------------------------------- */

test("symbolOf tries the plausible keys and normalises", () => {
  assert.equal(symbolOf({ symbol: "bbri" }), "BBRI");
  assert.equal(symbolOf({ code: "TLKM" }), "TLKM");
  assert.equal(symbolOf({ ticker: " ANTM " }), "ANTM");
  assert.equal(symbolOf({ name: "BBCA" }), "BBCA");
  assert.equal(symbolOf({ symbol: "BBRI", code: "IGNORED" }), "BBRI", "the first key wins");
});

test("symbolOf THROWS on an unrecognised row, naming the keys it saw", () => {
  // Returning [] here would be the worst possible failure: a scan over an empty universe reports
  // "0 hits", which reads as a clean negative answer rather than as a broken one.
  assert.throws(
    () => symbolOf({ emiten: "BBRI", harga: 4820 }),
    (err: unknown) => err instanceof Error && /emiten, harga/.test(err.message) && /Tried symbol, code/.test(err.message),
  );
  assert.throws(() => symbolOf({}), /no keys at all/);
  assert.throws(() => symbolOf({ symbol: "" }), /No ticker field/);
});

/* -------------------------------------- universe -------------------------------------- */

test("the source is labelled in the result, whatever kind it was", async () => {
  const cases: Array<[UniverseSource, RegExp]> = [
    [{ kind: "symbols", symbols: ["A", "B"] }, /2 explicit symbol/],
    [{ kind: "movers", type: "topGainer" }, /topGainer hotlist/],
    [{ kind: "trending" }, /trending/],
    [{ kind: "watchlist", id: "7" }, /watchlist 7/],
  ];
  for (const [universe, pattern] of cases) {
    const { deps } = fakeDeps();
    const result = await scan({ universe, overlays: OVERLAYS, conditions: [ABOVE_SMA20] }, deps);
    assert.match(result.universe.source, pattern);
  }
});

test("the whole result survives a JSON round trip", async () => {
  const { deps } = fakeDeps({ bars: { AAA: RISING, BBB: FALLING, CCC: SHORT } });
  const result = await scan(
    { universe: SMA20, overlays: OVERLAYS, conditions: [ABOVE_SMA20], report: ["close"] },
    deps,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
