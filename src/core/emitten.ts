/**
 * Quote/resolver, trending, sectors, and top movers (hotlist).
 *   GET /emitten/{symbol}/info                          → quote + best bid/offer + company id
 *   GET /emitten/trending                               → trending stocks
 *   GET /emitten/sectors                                → sector list
 *   GET /emitten/hotlist/{topGainer|topLoser|mostActive}?limit  → movers (empty when market closed)
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr, StrOrNum } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";

/* ----------------------------------- quote ----------------------------------- */

const QuoteResponse = z
  .object({
    data: z
      .object({
        id: StrOrNum.optional(),
        name: z.string().optional(),
        price: StrOrNum.optional(),
        change: StrOrNum.optional(),
        percentage: StrOrNum.optional(),
        exchange: z.string().optional(),
        country: z.string().optional(),
        orderbook: z
          .object({
            bid: z.object({ price: StrOrNum, volume: StrOrNum }).partial().passthrough().optional(),
            offer: z.object({ price: StrOrNum, volume: StrOrNum }).partial().passthrough().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface Quote {
  symbol: string;
  companyId?: string;
  name?: string;
  price?: string;
  change?: string;
  percentage?: string;
  exchange?: string;
  bestBid?: { price?: string; volume?: string };
  bestOffer?: { price?: string; volume?: string };
}

export async function getQuote(symbol: string): Promise<Quote> {
  const sym = normalizeSymbol(symbol);
  return cached(`quote:${sym}`, CACHE.quoteTtlMs, async () => {
    const body = await getJson("emittenInfo", { segments: { symbol: sym } });
    const { data } = parseOr(QuoteResponse, body, "quote");
    return {
      symbol: sym,
      companyId: data.id,
      name: data.name,
      price: data.price,
      change: data.change,
      percentage: data.percentage,
      exchange: data.exchange,
      bestBid: data.orderbook?.bid,
      bestOffer: data.orderbook?.offer,
    };
  });
}

/** Resolve a ticker to its internal numeric company/orderbook id. */
export async function resolveCompanyId(symbol: string): Promise<string | undefined> {
  return (await getQuote(symbol)).companyId;
}

/* ---------------------------------- trending ---------------------------------- */

const ListResponse = z.object({ data: z.array(z.record(z.unknown())) }).passthrough();

export async function getTrending(): Promise<Array<Record<string, unknown>>> {
  return cached("trending", CACHE.defaultTtlMs, async () => {
    const body = await getJson("emittenTrending");
    return parseOr(ListResponse, body, "trending").data;
  });
}

/* ----------------------------------- sectors ---------------------------------- */

const SectorRow = z
  .object({
    id: StrOrNum,
    name: z.string(),
    alias1: z.string().optional(),
    parent: z.string().optional(),
    symbol: z.string().optional(),
  })
  .passthrough();

export interface Sector {
  id: string;
  name: string;
  alias?: string;
}

export async function getSectors(): Promise<Sector[]> {
  return cached("sectors", CACHE.keystatsTtlMs, async () => {
    const body = await getJson("emittenSectors");
    const parsed = parseOr(z.object({ data: z.array(SectorRow) }).passthrough(), body, "sectors");
    return parsed.data.map((s) => ({ id: s.id, name: s.name, alias: s.alias1 }));
  });
}

/* --------------------------------- top movers --------------------------------- */

export type MoverType = "topGainer" | "topLoser" | "mostActive";

export async function getTopMovers(
  type: MoverType,
  limit = 25,
): Promise<Array<Record<string, unknown>>> {
  // Not cached long: movers change during the session. Empty array after-hours is normal.
  const body = await getJson("emittenHotlist", { segments: { moverType: type }, params: { limit } });
  return parseOr(ListResponse, body, `hotlist ${type}`).data;
}
