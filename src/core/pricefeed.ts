/**
 * Price feed: intraday minutely prices, multi-timeframe performance, and full orderbook depth.
 *   GET /company-price-feed/prices/close?symbol=&interval=
 *   GET /company-price-feed/price-performance/{symbol}
 *   GET /company-price-feed/v2/orderbook/companies/{symbol}
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr, wireNumber } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";

/* ------------------------------ intraday prices ------------------------------ */

const CloseResponse = z
  .object({
    data: z.array(z.object({ symbol: z.string().optional(), prices: z.array(z.string()) }).passthrough()),
  })
  .passthrough();

export interface IntradayPrices {
  symbol: string;
  /** Minutes per point AS ASKED FOR. Not proof the points are that far apart in wall-clock time. */
  interval: number;
  /**
   * Closes, oldest first, index-stable. An element the wire did not spell as a number is `null`.
   *
   * `Number("")` is 0, and a free zero here is not cosmetic: `settlePaper` asks
   * `series.some(close => close <= order.price)`, so one empty string on the wire would fill every
   * open paper buy at any limit. `null` is refused there; 0 was not.
   */
  prices: Array<number | null>;
  /**
   * The row's unrecognised keys: NAMES only, so one live call settles whether a time channel
   * exists here without this module guessing at one. No value is copied out.
   *
   * The two fields do NOT mean what the identically named ones in `src/core/brokers.ts` mean, and
   * the difference matters because there the unit is a row and here it is a key:
   *   - `count` — how many KEYS on this one row this module does not read. Not a row count; the
   *     close route answers with a single row and this projection reads that one.
   *   - `sampleKeys` — the COMPLETE list of those keys, uncapped and unsampled, so
   *     `count === sampleKeys.length` always holds. `brokers.ts` samples one row's keys out of
   *     many; there is nothing to sample from here.
   * Neither `symbol` nor `prices` is ever in it, and for different reasons. `prices` is the one key
   * this module reads by name. `row.symbol` is read by NOTHING — the `symbol` above is the
   * normalized REQUEST symbol — so a row whose own `symbol` disagrees with the one that was asked
   * for is neither used nor surfaced here.
   */
  unmapped: { count: number; sampleKeys: string[] };
  /** Why index x interval is not wall-clock time. Always present, because it is always relevant. */
  note: string;
}

/**
 * What the caller cannot work out from the array alone.
 *
 * The series is ORDERED, not timestamped. No stamp is computed from `src/core/sessionclock.ts`
 * either: that module models a weekly schedule and says at its head that holidays are deliberately
 * not in it, so a time derived from it would map no wire field at all — a number this server made
 * up rather than one it read. If the row does carry a clock reading under some other key, its name
 * comes back in `unmapped.sampleKeys` and one live call settles it.
 */
const INTRADAY_NOTE =
  "Ordered, not timestamped: this row carries no clock reading this server recognises, and none " +
  "was computed. IDX breaks midday (Mon-Thu 12:00-13:30 WIB, Fri 11:30-14:00 WIB), so index x " +
  "interval is NOT wall-clock time and two adjacent points can straddle a 90- or 150-minute gap. " +
  "`unmapped.sampleKeys` names the row's other keys. A null in `prices` is a value the wire did " +
  "not spell as a number, not a zero.";

/** Kept out of the report: `prices` is read here, and `symbol` is the request's, never the row's. */
const INTRADAY_OWN_KEYS = new Set(["symbol", "prices"]);

/** Shape one close row. Pure, so it is testable offline. */
export function shapeIntraday(
  symbol: string,
  interval: number,
  row: Record<string, unknown> | undefined,
): IntradayPrices {
  const sampleKeys = Object.keys(row ?? {}).filter((key) => !INTRADAY_OWN_KEYS.has(key));
  // `Array.isArray`, not a cast to `string[]`: the parameter is `Record<string, unknown>` and this
  // function is exported, so `{prices: "3000"}` reaches it without ever passing `CloseResponse` —
  // and the cast made that throw "prices.map is not a function". A shape this cannot read is an
  // empty series, the same answer as a row with no `prices` at all. It stays OUT of `sampleKeys`
  // either way: that list names keys this module does not READ, and this is one it reads.
  const raw: unknown = row?.prices;
  return {
    symbol,
    interval,
    // `numberish`, not `Number`: it is the reader this file already documents as the guard against
    // an empty string becoming a free zero, and it lives 100 lines below for the bands. Each
    // element goes through it as `unknown`, so a number, a string or neither are all handled there.
    prices: Array.isArray(raw) ? (raw as unknown[]).map((value) => wireNumber(value)) : [],
    unmapped: { count: sampleKeys.length, sampleKeys },
    note: INTRADAY_NOTE,
  };
}

export async function getIntradayPrices(symbol: string, interval = 1): Promise<IntradayPrices> {
  const sym = normalizeSymbol(symbol);
  return cached(`intraday:${sym}:${interval}`, CACHE.quoteTtlMs, async () => {
    const body = await getJson("pricesClose", { params: { symbol: sym, interval } });
    const parsed = parseOr(CloseResponse, body, "intraday prices");
    return shapeIntraday(sym, interval, parsed.data[0]);
  });
}

/* ---------------------------- price performance ---------------------------- */

const RawFormatted = z.object({ raw: z.number().optional(), formatted: z.string().optional() }).passthrough();
const PerfRow = z
  .object({
    close: RawFormatted.optional(),
    high: RawFormatted.optional(),
    low: RawFormatted.optional(),
    percentage: RawFormatted.optional(),
    timeframe: z.string(),
  })
  .passthrough();

const PerfResponse = z.object({ data: z.object({ prices: z.array(PerfRow) }).passthrough() }).passthrough();

export interface PerformancePoint {
  timeframe: string;
  close?: number;
  high?: number;
  low?: number;
  changePercent?: number;
}

export async function getPricePerformance(symbol: string): Promise<PerformancePoint[]> {
  const sym = normalizeSymbol(symbol);
  return cached(`perf:${sym}`, CACHE.defaultTtlMs, async () => {
    const body = await getJson("pricePerformance", { segments: { symbol: sym } });
    const parsed = parseOr(PerfResponse, body, "price performance");
    return parsed.data.prices.map((p) => ({
      timeframe: p.timeframe,
      close: p.close?.raw,
      high: p.high?.raw,
      low: p.low?.raw,
      changePercent: p.percentage?.raw,
    }));
  });
}

/* --------------------------------- orderbook --------------------------------- */

// Full depth ladder shape not exhaustively mapped; validate envelope, return data as-is.
const OrderbookResponse = z.object({ data: z.unknown() }).passthrough();

export async function getOrderbook(symbol: string): Promise<unknown> {
  const sym = normalizeSymbol(symbol);
  return cached(`orderbook:${sym}`, CACHE.quoteTtlMs, async () => {
    const body = await getJson("orderbook", { segments: { symbol: sym } });
    return parseOr(OrderbookResponse, body, "orderbook").data;
  });
}

/* ------------------------- auto-rejection bands & foreign flow ------------------------- */

/**
 * The IDX auto-rejection band and the session's foreign flow, pulled out of the orderbook response.
 *
 * **No new request and no new route.** These fields already arrive inside the ~19KB depth payload
 * that `getOrderbook` returns; they were simply never surfaced, so reaching them meant knowing they
 * existed and parsing the blob by hand. That is the whole change: a named accessor over bytes we
 * were already paying for.
 *
 * The bands matter more on IDX than a foreign reader might expect. A stock at its ARA has no seller
 * at any price and a stock at its ARB has no buyer — "the price is 1,200 and rising" means something
 * different when 1,200 *is* the ceiling. It is also the same condition `src/analysis/backtest.ts`
 * refuses to fill against, so having it available as a live reading keeps the two consistent.
 *
 * ## Verified live, and the shape was not what it looked like
 *
 * Probed against BBRI on 2026-08-09. The two families arrive in **different shapes**, which is
 * exactly the kind of thing that is invisible until it is measured:
 *
 * ```
 *   ara      {"value":"3,910","visible":true}     ← wrapped, string, thousands separator
 *   arb      {"value":"2,670","visible":true}
 *   next_ara {"value":"3,910","visible":true}
 *   next_arb {"value":"2,670","visible":true}
 *   fbuy     789081065000                          ← a bare number
 *   fsell    282200351000
 *   fnet     506880714000
 * ```
 *
 * The first draft of this handled a `{raw}` wrapper and a bare number and would have reported all
 * four bands as missing. It did not report them as *zero*, which is the point of the `found` /
 * `missing` split: a wrong guess about shape surfaced as "this field was not in the payload"
 * rather than as a confident 0 for the auto-rejection ceiling.
 */
export interface PriceBands {
  symbol: string;
  /** Auto-rejection ceiling for the session: no seller exists above this. */
  ara: number | null;
  /** Auto-rejection floor: no buyer exists below this. */
  arb: number | null;
  /** The band for the NEXT session, where Stockbit publishes it. */
  nextAra: number | null;
  nextArb: number | null;
  /** Foreign buy / sell / net for the session, in the units the payload uses. */
  foreignBuy: number | null;
  foreignSell: number | null;
  foreignNet: number | null;
  /** Field names that were present in the response. */
  found: string[];
  /** Field names that were looked for and were not there. */
  missing: string[];
}

/** Wire spelling → the name this project uses. */
const BAND_FIELDS = {
  ara: "ara",
  arb: "arb",
  next_ara: "nextAra",
  next_arb: "nextArb",
  fbuy: "foreignBuy",
  fsell: "foreignSell",
  fnet: "foreignNet",
} as const;

/** Extract the bands from an already-fetched orderbook payload. Pure, so it is testable offline. */
export function extractBands(symbol: string, payload: unknown): PriceBands {
  const source = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const out: Record<string, number | null> = {};
  const found: string[] = [];
  const missing: string[] = [];

  for (const [wire, name] of Object.entries(BAND_FIELDS)) {
    const parsed = wireNumber(source[wire]);
    out[name] = parsed;
    if (parsed === null) missing.push(wire);
    else found.push(wire);
  }

  return {
    symbol,
    ara: out.ara,
    arb: out.arb,
    nextAra: out.nextAra,
    nextArb: out.nextArb,
    foreignBuy: out.foreignBuy,
    foreignSell: out.foreignSell,
    foreignNet: out.foreignNet,
    found,
    missing,
  };
}

/** The bands for a symbol, off the same cached orderbook response the depth ladder comes from. */
export async function getPriceBands(symbol: string): Promise<PriceBands> {
  const sym = normalizeSymbol(symbol);
  return extractBands(sym, await getOrderbook(sym));
}
