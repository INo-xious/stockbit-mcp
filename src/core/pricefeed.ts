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
