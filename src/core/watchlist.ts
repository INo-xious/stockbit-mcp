/**
 * The user's own watchlists.
 *
 * The single biggest gap this server had. `STOCKBIT-API.md` defines much of the product as "for
 * each watchlist symbol…" and there was no way to learn what those symbols were, so every scan and
 * every sweep had to be handed tickers by hand.
 *
 * Reads only. Adding to or removing from a watchlist is account state, and the route table is where
 * that line is drawn — see `src/http/transport.ts`.
 *
 * ## Two traps, both measured
 *
 * **`total_items` is a lie.** Every list in the index reports `total_items: 0` regardless of how
 * many symbols it holds — the account probed on 2026-08-09 had a list reporting 0 and containing
 * 116. It is deliberately not surfaced as a count; `getWatchlist` returns the rows and the caller
 * counts them.
 *
 * **`limit` is required and capped at 500.** Omitting it does not mean "everything".
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr, StrOrNum } from "./_util.js";
import { CACHE } from "../config.js";

/** Stockbit's cap. Asking for more is not an error, it simply does not give more. */
export const WATCHLIST_MAX_LIMIT = 500;

const ListRow = z
  .object({
    watchlist_id: StrOrNum,
    name: z.string(),
    is_default: z.boolean().optional(),
    is_favorite: z.boolean().optional(),
    category_type: z.string().optional(),
  })
  .passthrough();

const IndexResponse = z.object({ data: z.array(ListRow) }).passthrough();

export interface WatchlistSummary {
  id: string;
  name: string;
  isDefault: boolean;
  isFavorite: boolean;
  categoryType?: string;
}

export async function getWatchlists(): Promise<WatchlistSummary[]> {
  return cached("watchlists", CACHE.keystatsTtlMs, async () => {
    const body = await getJson("watchlists");
    return parseOr(IndexResponse, body, "watchlists").data.map((row) => ({
      id: String(row.watchlist_id),
      name: row.name,
      isDefault: row.is_default === true,
      isFavorite: row.is_favorite === true,
      categoryType: row.category_type,
      // `total_items` is deliberately not mapped: it reports 0 for every list, so exposing it as a
      // count would be worse than not having one.
    }));
  });
}

const MemberRow = z
  .object({
    symbol: z.string(),
    name: z.string().optional(),
    last: StrOrNum.optional(),
    change: StrOrNum.optional(),
    percent: StrOrNum.optional(),
    previous: StrOrNum.optional(),
    volume: StrOrNum.optional(),
    id: StrOrNum.optional(),
  })
  .passthrough();

/**
 * The detail response wraps its rows in `data.result`, not `data`.
 *
 * Worth stating because the *index* endpoint does return `data` as a bare array, so the two look
 * interchangeable and are not. The first version of this assumed the array shape for both; zod
 * rejected it loudly at the first real call rather than quietly yielding an empty watchlist — which
 * for a scan universe would have reported "0 hits" as though it were an answer.
 *
 * `data.total` here IS trustworthy, unlike the index's `total_items`, which reports 0 for every list.
 */
const DetailResponse = z
  .object({
    data: z
      .object({
        result: z.array(MemberRow),
        total: z.number().optional(),
        name: z.string().optional(),
        watchlist_id: StrOrNum.optional(),
      })
      .passthrough(),
  })
  .passthrough();

export interface WatchlistMember {
  symbol: string;
  name?: string;
  last?: string;
  change?: string;
  percentChange?: string;
  /**
   * Session volume as this endpoint reports it — in **shares**.
   *
   * `historical/summary` reports volume in LOTS for the same stock on the same day, and one lot is
   * a hundred shares. Comparing the two directly is a 100x error, so the unit is named here rather
   * than left for a reader to assume.
   */
  volumeShares?: string;
  companyId?: string;
}

export interface Watchlist {
  id: string;
  name?: string;
  members: WatchlistMember[];
  /** How many symbols the list holds. This one is real, unlike the index's `total_items`. */
  total: number;
  /** What the caller asked for, so a truncated list is visible rather than implied. */
  limit: number;
  /** True when the response filled the requested limit and may therefore have been cut short. */
  possiblyTruncated: boolean;
}

export async function getWatchlist(id: string, limit = WATCHLIST_MAX_LIMIT): Promise<Watchlist> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), WATCHLIST_MAX_LIMIT);
  return cached(`watchlist:${id}:${capped}`, CACHE.defaultTtlMs, async () => {
    // `limit` is REQUIRED here — the endpoint does not default to "all".
    const body = await getJson("watchlistDetail", { segments: { watchlistId: id }, params: { limit: capped } });
    const { data } = parseOr(DetailResponse, body, "watchlist detail");
    const rows = data.result;
    return {
      id,
      name: data.name,
      members: rows.map((row) => ({
        symbol: row.symbol,
        name: row.name,
        last: row.last,
        change: row.change,
        percentChange: row.percent,
        volumeShares: row.volume,
        companyId: row.id,
      })),
      total: data.total ?? rows.length,
      limit: capped,
      possiblyTruncated: rows.length >= capped,
    };
  });
}

/**
 * Every symbol in a watchlist, or in the default one when no id is given.
 *
 * The convenience the scanner actually wants: "the stocks I care about", as tickers.
 */
export async function getWatchlistSymbols(id?: string, limit = WATCHLIST_MAX_LIMIT): Promise<string[]> {
  let listId = id;
  if (!listId) {
    const lists = await getWatchlists();
    if (lists.length === 0) return [];
    listId = (lists.find((l) => l.isDefault) ?? lists[0]).id;
  }
  return (await getWatchlist(listId, limit)).members.map((m) => m.symbol);
}
