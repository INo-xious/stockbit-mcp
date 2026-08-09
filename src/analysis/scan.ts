/**
 * Run a condition across a universe of symbols — `alert_check` for stocks the user has no rules for.
 *
 * ## Dependencies are injected, exactly as the workflow engine does it
 *
 * `runWorkflow` takes its `invoke` rather than importing it, and the reason given there applies
 * verbatim: it makes the module testable with no network, and it stops this module from quietly
 * gaining the ability to fetch something it was not handed. Every budget and truncation test below
 * depends on that choice.
 *
 * ## The cost story, because it is the design constraint
 *
 * Bars are the expensive thing here. `src/core/bars.ts` walks 12 rows a page, and the rate limiter
 * in `src/http/client.ts` spaces request *starts* 150 ms apart **globally** before allowing three in
 * flight — so throughput caps at roughly **6.6 requests a second no matter how many workers run**.
 * Adding concurrency does not add throughput; it only deepens a queue, which makes a deadline less
 * responsive because already-queued work still runs after it.
 *
 * After the warm-up fix in `src/analysis/series.ts`, a 20-symbol screen costs about:
 *
 * ```
 *   close > sma20      21 bars   2 pages    40 requests   ~6 s
 *   sma20 x sma50      51 bars   5 pages   100 requests  ~15 s
 *   rsi14 crossover    71 bars   6 pages   120 requests  ~18 s
 *   anything sma200   201 bars  17 pages   340 requests  ~51 s
 * ```
 *
 * So the honest ceiling is **20–30 symbols for a moving-average or RSI screen, 10–15 for anything
 * needing two hundred bars**. That is the default, and the tool description says so rather than
 * letting a caller discover it by timing out.
 *
 * The cache is the strongest asset here and worth advertising: `fetchPage` already caches per
 * `(symbol, page)` for six hours on settled pages, so a *second* scan over an overlapping universe
 * costs roughly one page per symbol. Broad first pass, then iterate on the condition almost free.
 *
 * ## Budgets are checked before dispatch, never mid-flight
 *
 * A half-fetched symbol is spend with nothing to show for it. And a capped sweep that reads as
 * complete is a lie about coverage, so truncation is always reported with its reason — the same
 * principle as `getBars`'s `truncated` and `runWorkflow`'s `skipped`.
 */
import type { Bar } from "../core/bars.js";
import {
  compileCondition,
  defineSeries,
  resolveOperand,
  warmupFor,
  type Condition,
  type Overlay,
  type Panel,
} from "./series.js";

/* ------------------------------------- universe ------------------------------------- */

export type UniverseSource =
  | { kind: "symbols"; symbols: string[] }
  | { kind: "movers"; type: "topGainer" | "topLoser" | "mostActive"; limit?: number }
  | { kind: "trending"; limit?: number }
  | { kind: "watchlist"; id?: string; limit?: number };

/** Keys a universe row might carry its ticker under, in the order they are tried. */
const SYMBOL_KEYS = ["symbol", "code", "ticker", "name"] as const;

/**
 * Pull a ticker out of an untyped universe row.
 *
 * `getTopMovers` and `getTrending` both return `Array<Record<string, unknown>>` and nothing asserts
 * which key holds the ticker. Returning `[]` on an unrecognised shape would be the worst possible
 * failure here: a scan over an empty universe reports "0 hits", which reads as a clean negative
 * answer rather than as a broken one. So this throws, and names the keys it actually saw.
 */
export function symbolOf(row: Record<string, unknown>): string {
  for (const key of SYMBOL_KEYS) {
    const value = row[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim().toUpperCase();
  }
  throw new Error(
    `No ticker field on a universe row. Tried ${SYMBOL_KEYS.join(", ")}; the row has: ` +
      `${Object.keys(row).join(", ") || "(no keys at all)"}`,
  );
}

/* -------------------------------------- request -------------------------------------- */

export interface ScanBudget {
  /** Symbols evaluated. Default 20 — see the cost table in the module note. */
  maxSymbols: number;
  /** Upstream bar pages across the whole scan. Default 200. */
  maxPages: number;
  /** Wall clock. Default 45s, deliberately inside a typical MCP client timeout. */
  maxMs: number;
  /** Symbols in flight. Default 3, mirroring the HTTP limiter. Raising it does not help. */
  concurrency: number;
}

export const DEFAULT_BUDGET: ScanBudget = { maxSymbols: 20, maxPages: 200, maxMs: 45_000, concurrency: 3 };

export interface ScanRequest {
  universe: UniverseSource;
  overlays?: Overlay[];
  panels?: Panel[];
  /** ALL must hold on the latest bar. */
  conditions: Array<Condition & { name?: string }>;
  /** Series ids or price refs to report for every symbol reached, hit or miss. */
  report?: string[];
  budget?: Partial<ScanBudget>;
}

export interface ScanHit {
  symbol: string;
  date: string;
  close: number;
  values: Record<string, number | null>;
  matched: string[];
}

export type MissReason = "condition-false" | "warming-up" | "no-data";

export interface ScanMiss {
  symbol: string;
  reason: MissReason;
  /** Which condition failed, when one did. */
  failed?: string;
  error?: string;
}

export interface ScanResult {
  universe: { source: string; discovered: number; evaluated: number };
  conditions: string[];
  barsPerSymbol: number;
  hits: ScanHit[];
  misses: ScanMiss[];
  truncated: { symbols: number; reason: "maxSymbols" | "maxPages" | "maxMs" | null };
  cost: { pagesFetched: number; symbolsFetched: number; elapsedMs: number };
  note: string;
}

export interface BarsResponse {
  bars: Bar[];
  pagesFetched: number;
}

/** Everything this module is allowed to reach. Nothing is imported for its side effects. */
export interface ScanDeps {
  getBars: (opts: { symbol: string; bars: number }) => Promise<BarsResponse>;
  resolveUniverse: (universe: UniverseSource) => Promise<string[]>;
  now: () => number;
}

function describe(condition: Condition & { name?: string }): string {
  if (condition.name) return condition.name;
  const word =
    condition.op === "crossover"
      ? "crosses above"
      : condition.op === "crossunder"
        ? "crosses below"
        : condition.op === "cross"
          ? "crosses"
          : condition.op;
  return `${condition.left} ${word} ${condition.right}`;
}

/* --------------------------------------- scan --------------------------------------- */

export async function scan(request: ScanRequest, deps: ScanDeps): Promise<ScanResult> {
  const budget: ScanBudget = { ...DEFAULT_BUDGET, ...request.budget };
  const overlays = request.overlays ?? [];
  const panels = request.panels ?? [];
  const conditions = request.conditions;
  if (conditions.length === 0) throw new Error("A scan needs at least one condition.");

  const started = deps.now();
  const defs = defineSeries(overlays, panels);

  // Every condition is validated against an EMPTY window before a single request goes out. A typo
  // in an operand would otherwise be discovered symbol by symbol, after paying for all of them.
  for (const condition of conditions) {
    resolveOperand(condition.left, [], defs, `condition ${JSON.stringify(describe(condition))} left`);
    resolveOperand(condition.right, [], defs, `condition ${JSON.stringify(describe(condition))} right`);
  }
  for (const name of request.report ?? []) {
    resolveOperand(name, [], defs, `report field ${JSON.stringify(name)}`);
  }

  const barsPerSymbol = Math.max(warmupFor(overlays, panels), 30);
  const discovered = await deps.resolveUniverse(request.universe);

  const hits: ScanHit[] = [];
  const misses: ScanMiss[] = [];
  let pagesFetched = 0;
  let symbolsFetched = 0;
  let truncatedReason: ScanResult["truncated"]["reason"] = null;
  let cursor = 0;

  /**
   * Whether another symbol may be dispatched.
   *
   * Checked BEFORE the request, never during it: stopping mid-fetch spends a symbol's worth of
   * requests and has nothing to show for them.
   */
  const mayDispatch = (): boolean => {
    if (symbolsFetched >= budget.maxSymbols) {
      truncatedReason ??= "maxSymbols";
      return false;
    }
    if (pagesFetched >= budget.maxPages) {
      truncatedReason ??= "maxPages";
      return false;
    }
    if (deps.now() - started >= budget.maxMs) {
      truncatedReason ??= "maxMs";
      return false;
    }
    return true;
  };

  async function evaluate(symbol: string): Promise<void> {
    let bars: Bar[];
    try {
      const response = await deps.getBars({ symbol, bars: barsPerSymbol });
      pagesFetched += response.pagesFetched;
      bars = response.bars;
    } catch (err) {
      // One dead symbol must not abort the sweep — the rest still have answers.
      misses.push({ symbol, reason: "no-data", error: err instanceof Error ? err.message : String(err) });
      return;
    }

    if (bars.length === 0) {
      misses.push({ symbol, reason: "no-data" });
      return;
    }

    const i = bars.length - 1;
    const compiled = conditions.map((condition) => ({
      condition,
      compiled: compileCondition(condition, bars, defs),
    }));

    // "Cannot say yet" and "no" are different answers, and only one is worth retrying with more
    // history. Reported with the same words `alert_check` uses, because it is the same question.
    const warming = compiled.find(({ compiled: c }) => c.warmingUpAt(i));
    if (warming) {
      misses.push({ symbol, reason: "warming-up", failed: describe(warming.condition) });
      return;
    }
    const failed = compiled.find(({ compiled: c }) => !c.holdsAt(i));
    if (failed) {
      misses.push({ symbol, reason: "condition-false", failed: describe(failed.condition) });
      return;
    }

    const values: Record<string, number | null> = {};
    for (const name of request.report ?? []) {
      values[name] = resolveOperand(name, bars, defs, "report")[i] ?? null;
    }

    hits.push({
      symbol,
      date: bars[i].date,
      close: bars[i].close,
      values,
      matched: conditions.map(describe),
    });
  }

  /**
   * One worker: take the next symbol and evaluate it, until the budget says stop.
   *
   * `concurrency` mirrors the HTTP limiter rather than exceeding it. The limiter serialises request
   * starts globally, so more workers here would not produce more throughput — they would only make
   * the `maxMs` deadline less responsive, since work already queued still runs after it.
   */
  const worker = async (): Promise<void> => {
    for (;;) {
      if (cursor >= discovered.length) return;
      if (!mayDispatch()) return;
      const symbol = discovered[cursor++];
      symbolsFetched++;
      await evaluate(symbol);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, budget.concurrency) }, worker));

  const evaluated = hits.length + misses.length;
  const remaining = Math.max(0, discovered.length - cursor);

  return {
    universe: { source: sourceLabel(request.universe), discovered: discovered.length, evaluated },
    conditions: conditions.map(describe),
    barsPerSymbol,
    hits,
    misses,
    truncated: { symbols: remaining, reason: remaining > 0 ? (truncatedReason ?? "maxSymbols") : null },
    cost: { pagesFetched, symbolsFetched, elapsedMs: deps.now() - started },
    note:
      `Bar pages are cached for six hours once settled, so a second scan over an overlapping ` +
      `universe costs roughly one page per symbol. A hit can be turned into a standing alert with ` +
      `alert_create using the same condition.`,
  };
}

function sourceLabel(universe: UniverseSource): string {
  switch (universe.kind) {
    case "symbols":
      return `${universe.symbols.length} explicit symbol(s)`;
    case "movers":
      return `${universe.type} hotlist`;
    case "trending":
      return "trending";
    case "watchlist":
      return universe.id ? `watchlist ${universe.id}` : "watchlist";
  }
}
