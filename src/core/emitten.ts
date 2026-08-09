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
import type { MoverTypeName } from "../http/transport.js";

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
  /** Stockbit's short label, from `alias1`. Kept under a readable name. */
  alias?: string;
  /**
   * The sector this one sits under. Present on subsectors, absent on top-level ones.
   *
   * This is the field that makes sector rotation answerable at all — without it there is no way to
   * roll subsector readings up, and a flat list of 22 names is barely worth a request.
   */
  parent?: string;
  /** The sector's own index ticker, where Stockbit publishes one. */
  symbol?: string;
  /** Whatever else the row carried. See the note on `getSectors`. */
  [key: string]: unknown;
}

/**
 * The IDX sector list.
 *
 * Every field Stockbit sends is returned. The previous version projected the row down to exactly
 * `{id, name, alias}` and dropped the rest on the floor — including `parent`, which its own zod
 * schema already declared, and whatever performance figure the row carries. Naming the survivors is
 * the wrong default for a response whose shape is not fully mapped: it turns "we have not looked at
 * this field yet" into "this field does not exist", silently, and the only way to discover the loss
 * is to compare against the wire by hand.
 *
 * Passing the row through also means a performance field can be used the moment it is confirmed
 * live, without guessing its name here now and shipping a key that is always undefined.
 */
export async function getSectors(): Promise<Sector[]> {
  return cached("sectors", CACHE.keystatsTtlMs, async () => {
    const body = await getJson("emittenSectors");
    const parsed = parseOr(z.object({ data: z.array(SectorRow) }).passthrough(), body, "sectors");
    return parsed.data.map((s) => ({ ...s, id: String(s.id), name: s.name, alias: s.alias1 }));
  });
}

/* --------------------------------- top movers --------------------------------- */

export type MoverType = MoverTypeName;

/**
 * Top gainers / losers / most active.
 *
 * The path spelling is resolved by `MOVER_WIRE` in `src/http/transport.ts`, not written here — see
 * that table for why the two spellings differ and how sending the wrong one hid behind "the market
 * is closed" for the life of this tool.
 *
 * An empty array genuinely is normal outside 09:00–16:00 WIB. It is only a trustworthy answer now
 * that the request is known to be the one Stockbit's own client makes.
 */
export async function getTopMovers(
  type: MoverType,
  limit = 25,
): Promise<Array<Record<string, unknown>>> {
  // Not cached long: movers change during the session.
  const body = await getJson("emittenHotlist", { segments: { moverType: type }, params: { limit } });
  return parseOr(ListResponse, body, `hotlist ${type}`).data;
}
