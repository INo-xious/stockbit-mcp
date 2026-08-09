/**
 * Price feed: intraday minutely prices, multi-timeframe performance, and full orderbook depth.
 *   GET /company-price-feed/prices/close?symbol=&interval=
 *   GET /company-price-feed/price-performance/{symbol}
 *   GET /company-price-feed/v2/orderbook/companies/{symbol}
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
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
  interval: number;
  prices: number[];
}

export async function getIntradayPrices(symbol: string, interval = 1): Promise<IntradayPrices> {
  const sym = normalizeSymbol(symbol);
  return cached(`intraday:${sym}:${interval}`, CACHE.quoteTtlMs, async () => {
    const body = await getJson("pricesClose", { params: { symbol: sym, interval } });
    const parsed = parseOr(CloseResponse, body, "intraday prices");
    const row = parsed.data[0];
    return { symbol: sym, interval, prices: (row?.prices ?? []).map(Number) };
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
 * ## Field names are looked for, not assumed
 *
 * The spellings below come from Stockbit's own bundle rather than from a live response, so each is
 * tried and the ones that were actually present are reported in `found`. A missing field is `null`
 * and named in `missing` — never zero, and never quietly dropped. Zero is a real value for foreign
 * net flow and would be indistinguishable from "this field was not in the payload".
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

/**
 * Read a numeric field that may arrive as a number, a string, or a `{raw}` wrapper.
 *
 * Stockbit uses all three shapes across this API, and `Number("")` is 0 — so an empty string
 * silently becoming zero is exactly the failure this guards. Anything not parseable is `null`.
 */
function numberish(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object" && "raw" in value) return numberish((value as { raw: unknown }).raw);
  return null;
}

/** Extract the bands from an already-fetched orderbook payload. Pure, so it is testable offline. */
export function extractBands(symbol: string, payload: unknown): PriceBands {
  const source = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const out: Record<string, number | null> = {};
  const found: string[] = [];
  const missing: string[] = [];

  for (const [wire, name] of Object.entries(BAND_FIELDS)) {
    const parsed = numberish(source[wire]);
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
