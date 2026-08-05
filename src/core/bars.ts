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
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
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
  /** Lots (1 lot = 100 shares), matching the convention used elsewhere in this API. */
  volume: number;
  /** Traded value in IDR. */
  value: number;
  /** Number of transactions. */
  frequency: number;
  change: number;
  changePercent: number;
  /** Foreign flow for the session, in IDR. Zero on days with no foreign participation. */
  foreignBuy: number;
  foreignSell: number;
  netForeign: number;
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
    open: z.coerce.number(),
    high: z.coerce.number(),
    low: z.coerce.number(),
    close: z.coerce.number(),
    average: z.coerce.number().optional(),
    volume: z.coerce.number().optional(),
    value: z.coerce.number().optional(),
    frequency: z.coerce.number().optional(),
    change: z.coerce.number().optional(),
    change_percentage: z.coerce.number().optional(),
    foreign_buy: z.coerce.number().optional(),
    foreign_sell: z.coerce.number().optional(),
    net_foreign: z.coerce.number().optional(),
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

function toBar(r: z.output<typeof Row>): Bar {
  return {
    date: r.date,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    average: r.average ?? r.close,
    volume: r.volume ?? 0,
    value: r.value ?? 0,
    frequency: r.frequency ?? 0,
    change: r.change ?? 0,
    changePercent: r.change_percentage ?? 0,
    foreignBuy: r.foreign_buy ?? 0,
    foreignSell: r.foreign_sell ?? 0,
    netForeign: r.net_foreign ?? 0,
  };
}

/* ---------------------------------- options ---------------------------------- */

export interface BarsOptions {
  symbol: string;
  /** How many of the most recent sessions to return. Ignored when `from` is given. */
  bars?: number;
  /** Earliest session to include, `YYYY-MM-DD`. Paging walks back until it is covered. */
  from?: string;
  /** Latest session to include, `YYYY-MM-DD`. Filters after fetching; paging always starts at today. */
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
 */
async function pagedBars(symbol: string, from: string | undefined, want: number): Promise<Walk> {
  const collected: Bar[] = [];
  let page = 1;
  let requests = 0;
  let truncated = false;

  for (;;) {
    const body = await fetchPage(symbol, page);
    requests++;

    const parsed = parseOr(Response, body, "historical bars");
    const rows = parsed.data.result ?? [];
    if (rows.length === 0) break;
    collected.push(...rows.map(toBar));

    const oldest = collected[collected.length - 1]?.date;
    const covered = from ? oldest !== undefined && oldest <= from : collected.length >= want;
    if (covered) break;
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
  const walk = await pagedBars(symbol, from, want);

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
