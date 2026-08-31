/**
 * Daily OHLCV bars — the foundation every analytical feature stands on.
 *
 * Technical indicators, pattern detection, backtests and alert rules all need a price series, and
 * until now the only price data here was a minutely close series for the current session
 * (`intraday_prices`) and a set of pre-computed timeframe returns (`price_performance`). Neither can
 * answer "what has this stock done over the last six months".
 *
 * ## The endpoint pages, and that is the whole design problem
 *
 * The historical-summary endpoint returns **exactly 12 rows per page** and ignores
 * every attempt to widen it — `limit` is rejected outright (400), and `from`/`to`/`period_range` are
 * accepted but have no effect on what comes back. Measured. So a year of history is ~21 requests and
 * three years is ~62.
 *
 * That makes request count a first-class concern rather than an afterthought:
 *   - paging stops as soon as the caller's need is met, never "fetch everything then filter";
 *   - a hard cap bounds the worst case, and the result says when it was hit rather than pretending
 *     the series is complete;
 *   - the shared rate limiter (3 concurrent, 150ms spacing) still applies, so a deep pull is slow
 *     rather than abusive.
 *
 * ## Ordering
 *
 * The API returns newest-first. Bars here are returned **oldest-first**, because every moving
 * average, RSI and backtest is written against ascending time, and silently handing them a reversed
 * series produces plausible, wrong numbers rather than an error.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr, wireNumber } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { StockbitError } from "../http/errors.js";
import { normalizeTradeDate, todayIso } from "./dates.js";

/** Rows the endpoint returns per page. Not configurable — `limit` is rejected. */
export const ROWS_PER_PAGE = 12;

/**
 * Ceiling on pages fetched in one call (~2 years of trading days).
 *
 * Deep history is legitimate but expensive at 12 rows a page; this bounds a single request to ~42
 * upstream calls. `truncated` on the result tells the caller when it bit.
 */
export const MAX_PAGES = 42;

export interface Bar {
  /** `YYYY-MM-DD`. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Volume-weighted average price for the session, as Stockbit reports it. */
  average: number;
  /**
   * The eight fields below are `number | null`, and `null` means THE RESPONSE DID NOT CARRY IT.
   *
   * Every one of them used to be `?? 0`, which made "the field was absent" and "the figure really
   * was zero" the same bytes. On `netForeign` that is the difference between "foreigners were flat
   * today" and "we have no idea", and `analyze` read the first from a row that meant the second.
   * The row schema carries all eight as `z.unknown()` and hands them to `wireNumber`, which is
   * what keeps an empty wire value from arriving here as the figure zero. No live row shape for
   * this route is recorded anywhere, which is why none of them is assumed present.
   *
   * `null` rather than an absent key: it keeps the shape stable for `deepEqual` and JSON round
   * trips, and it matches `PriceBands` and `Series` (`Array<number | null>`), which are the two
   * places in this codebase that already had to answer the same question.
   *
   * `open`/`high`/`low`/`close` are always numbers, because a row that cannot yield one is REFUSED
   * rather than projected — see `toBar`. The ground is that a series with holes in it is worse than
   * an error: every average, pattern and backtest computed from it is quietly wrong rather than
   * absent.
   *
   * This is STRICTER than `projectSeries` in `src/core/market.ts`, which refuses only `date` and
   * `close` and falls back open/high/low to the close with a warning. That is deliberate on its
   * side — the daily chart route is observed sending those three empty, and degrading beats
   * failing there — and this route has no such observation. If `historical/summary` ever formats a
   * price that way, this refuses where the chart route degrades, and that asymmetry is the thing to
   * revisit rather than a bug to patch at the call site.
   */
  /** Lots (1 lot = 100 shares), matching the convention used elsewhere in this API. */
  volume: number | null;
  /** Traded value in IDR. */
  value: number | null;
  /** Number of transactions. */
  frequency: number | null;
  change: number | null;
  changePercent: number | null;
  /** Foreign flow for the session, in IDR. `null` when the response did not carry the field. */
  foreignBuy: number | null;
  foreignSell: number | null;
  netForeign: number | null;
}

export interface BarSeries {
  symbol: string;
  /** Oldest first. */
  bars: Bar[];
  from?: string;
  to?: string;
  /** True when MAX_PAGES stopped the walk before the request was satisfied. */
  truncated: boolean;
  /** Upstream requests spent, so a caller can see what a query cost. */
  pagesFetched: number;
}

const Row = z
  .object({
    date: z.string(),
    // Read the same way as everything else rather than coerced. `z.coerce.number().parse(null)` is
    // 0, and a PRICE of 0 is far worse than a statistic of 0: an alert rule `close < 100` fires on
    // it, `backtest` divides by an entry price of zero, and the chart collapses its axis. A row
    // that cannot yield a price is refused in `toBar`.
    open: z.unknown(),
    high: z.unknown(),
    low: z.unknown(),
    close: z.unknown(),
    // Deliberately NOT `z.coerce.number().optional()`. `z.coerce.number()` is `Number()`, and
    // `Number("")`, `Number(null)`, `Number("  ")`, `Number(false)` and `Number([])` are every one
    // of them 0 — so an empty field would reach `toBar` as the FIGURE ZERO and the absence would be
    // destroyed one layer before anything could report it, making `number | null` on `Bar` pure
    // decoration. The value is carried through untouched and read by `optionalNumber` below.
    average: z.unknown(),
    volume: z.unknown(),
    value: z.unknown(),
    frequency: z.unknown(),
    change: z.unknown(),
    change_percentage: z.unknown(),
    foreign_buy: z.unknown(),
    foreign_sell: z.unknown(),
    net_foreign: z.unknown(),
  })
  .passthrough();

const Response = z
  .object({
    data: z
      .object({
        result: z.array(Row).optional(),
        paginate: z.object({ next_page: z.union([z.string(), z.number()]).optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/**
 * Project one wire row onto `Bar`. Exported so the absence rules above are testable offline.
 *
 * Throws rather than emitting a price of zero. A statistic this row did not carry is reported
 * absent; a PRICE it did not carry makes the row unusable, and one bad bar quietly poisons every
 * indicator computed over the series that contains it.
 */
export function toBar(r: z.output<typeof Row>): Bar {
  const price = (field: "open" | "high" | "low" | "close"): number => {
    const value = wireNumber(r[field]);
    if (value === null) {
      throw new StockbitError(
        "schema_drift",
        `Historical bar for ${String(r.date)} has no usable ${field} (received ` +
          `${JSON.stringify(r[field])}). The row is refused rather than returned with a price of 0.`,
      );
    }
    return value;
  };

  const close = price("close");
  return {
    date: r.date,
    open: price("open"),
    high: price("high"),
    low: price("low"),
    close,
    // `average` keeps its fallback: substituting the close for a missing VWAP is a documented
    // approximation of the same quantity, not a number invented out of nothing. The eight below
    // have no such stand-in — there is nothing a missing foreign flow could sensibly be — so they
    // report absence instead of a zero nobody sent.
    average: wireNumber(r.average) ?? close,
    volume: wireNumber(r.volume),
    value: wireNumber(r.value),
    frequency: wireNumber(r.frequency),
    change: wireNumber(r.change),
    changePercent: wireNumber(r.change_percentage),
    foreignBuy: wireNumber(r.foreign_buy),
    foreignSell: wireNumber(r.foreign_sell),
    netForeign: wireNumber(r.net_foreign),
  };
}

/* ---------------------------------- options ---------------------------------- */

export interface BarsOptions {
  symbol: string;
  /** How many of the most recent sessions to return. Ignored when `from` is given. */
  bars?: number;
  /** Earliest session to include, `YYYY-MM-DD`. Paging walks back until it is covered. */
  from?: string;
  /**
   * Latest session to include, `YYYY-MM-DD`.
   *
   * Paging always starts at today — that is the only entry point the endpoint has — so a window
   * ending in the past is reached by walking back through sessions that are then discarded. Those
   * discarded pages still cost a request each, which is why a far-past window is expensive.
   */
  to?: string;
}

/**
 * How many bars a request implies, used only to decide when to stop paging.
 *
 * A calendar span is converted at ~252 trading days a year with headroom, because the walk stops on
 * the `from` date itself — the estimate only needs to avoid stopping *early*.
 */
function targetCount(opts: BarsOptions): number {
  if (opts.from) {
    const days = (Date.parse(`${opts.to ?? todayIso()}T00:00:00Z`) - Date.parse(`${opts.from}T00:00:00Z`)) / 86_400_000;
    return Math.max(1, Math.ceil((days / 365) * 252) + ROWS_PER_PAGE);
  }
  return Math.max(1, opts.bars ?? 120);
}

/** One page of the proven endpoint. Cached: page 3 is the same 12 sessions whoever asked for it. */
function fetchPage(symbol: string, page: number): Promise<unknown> {
  return cached(
    `bars:${symbol}:p${page}`,
    // A page of closed sessions is immutable; only the page containing today can still change.
    page === 1 ? CACHE.brokerSummaryTtlMs : CACHE.brokerSummarySettledTtlMs,
    () => getJson("historicalSummary", { segments: { symbol }, params: { page } }),
  );
}

interface Walk {
  /** Oldest first. */
  bars: Bar[];
  requests: number;
  truncated: boolean;
}

/**
 * The proven path: walk pages until the request is covered.
 *
 * Paging stops as soon as the caller's need is met rather than fetching everything and filtering,
 * and MAX_PAGES bounds the worst case — with `truncated` saying so instead of presenting a short
 * series as complete.
 *
 * ## Why `to` is part of the stop condition and not just a filter afterwards
 *
 * The walk always starts at today, because that is the only place this endpoint can be entered.
 * When the caller asked for a window that *ends* in the past, every page fetched so far may be
 * entirely outside it — so counting rows collected answers the wrong question. It used to: the walk
 * stopped once it held `want` rows of any date, `getBars` then filtered to `<= to`, and a request
 * for "120 sessions ending last March" returned whatever few rows happened to fall inside, with
 * `truncated: false` asserting that was all of them. A short series presented as complete is worse
 * than an error, because every indicator computed from it is quietly wrong rather than absent.
 *
 * So coverage counts only the rows that are actually inside the window.
 */
async function pagedBars(
  symbol: string,
  from: string | undefined,
  to: string | undefined,
  want: number,
): Promise<Walk> {
  const collected: Bar[] = [];
  let page = 1;
  let requests = 0;
  let truncated = false;

  /** Rows that will survive the caller's window filter — the only ones that count toward `want`. */
  const usable = (): number => (to ? collected.filter((b) => b.date <= to).length : collected.length);

  for (;;) {
    const body = await fetchPage(symbol, page);
    requests++;

    const parsed = parseOr(Response, body, "historical bars");
    const rows = parsed.data.result ?? [];
    if (rows.length === 0) break;
    collected.push(...rows.map(toBar));

    const oldest = collected[collected.length - 1]?.date;
    const covered = from ? oldest !== undefined && oldest <= from : usable() >= want;
    if (covered) break;
    // No further pages: this is the beginning of the symbol's history, not a ceiling we imposed.
    // Reporting `truncated` here would blame us for data that does not exist.
    if (!parsed.data.paginate?.next_page) break;
    if (page >= MAX_PAGES) {
      truncated = true;
      break;
    }
    page++;
  }

  // API order is newest-first; every indicator downstream assumes ascending time.
  collected.reverse();
  return { bars: collected, requests, truncated };
}

/** Fetch daily bars, walking pages until the request is covered. */
export async function getBars(opts: BarsOptions): Promise<BarSeries> {
  const symbol = normalizeSymbol(opts.symbol);
  const from = opts.from === undefined ? undefined : normalizeTradeDate(opts.from, "from");
  const to = opts.to === undefined ? undefined : normalizeTradeDate(opts.to, "to");
  if (from && to && from > to) {
    const { StockbitError } = await import("../http/errors.js");
    throw new StockbitError("invalid_param", `from (${from}) must not be after to (${to})`);
  }

  const want = targetCount({ ...opts, from, to });
  const walk = await pagedBars(symbol, from, to, want);

  let bars = walk.bars;
  if (from) bars = bars.filter((b) => b.date >= from);
  if (to) bars = bars.filter((b) => b.date <= to);
  if (!from && opts.bars) bars = bars.slice(-opts.bars);

  return {
    symbol,
    bars,
    from: bars[0]?.date,
    to: bars[bars.length - 1]?.date,
    truncated: walk.truncated,
    pagesFetched: walk.requests,
  };
}
