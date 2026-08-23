/**
 * Stockbit's research surface: the category list behind the Research filter, and the per-symbol
 * "new research" indicator.
 *   GET /research/categories
 *   GET /research/indicator/new?symbol=
 *
 * Both are reads and neither has been observed live. That is the whole design constraint here:
 * nothing below names a field it has not seen. The category list is *located* with the same helper
 * the stream family uses and its rows are returned untouched; the indicator is returned as the
 * envelope's `data`, unprojected, because inventing `{count, hasNew}` around a response nobody has
 * looked at would ship two keys that are always undefined.
 *
 * Research posts themselves are not here — they arrive through the stream, as
 * `STREAM_CATEGORY_REPORTS` (optionally narrowed by `report_type`). See `src/core/stream.ts`.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { locateStreamRows } from "./stream.js";

const Envelope = z.object({ data: z.unknown() }).passthrough();

export interface ResearchCategories {
  /**
   * Where the rows were found (`data`, `data.result`, `data.stream`), or `null` when no list was
   * recognised — the difference between "there are no categories" and "this response is a shape we
   * have not seen". When it is null, `unrecognized` carries what arrived.
   */
  source: string | null;
  /** The category rows exactly as sent. Field names are unmapped, so nothing is renamed or dropped. */
  rows: unknown[];
  unrecognized?: unknown;
}

/**
 * The research categories.
 *
 * Cached for the long TTL: this is a vocabulary list, and a vocabulary that changed during a session
 * would be a bigger surprise than a stale one.
 */
export async function getResearchCategories(): Promise<ResearchCategories> {
  return cached("research:categories", CACHE.keystatsTtlMs, async () => {
    const body = await getJson("researchCategories");
    const { data } = parseOr(Envelope, body, "research categories");
    const located = locateStreamRows(data);
    if (located.source === null) return { source: null, rows: [], unrecognized: data ?? body };
    return { source: located.source, rows: located.rows };
  });
}

export interface ResearchIndicator {
  /** The symbol asked about, or `null` when the request was made without one. */
  symbol: string | null;
  /**
   * The envelope's `data`, unprojected.
   *
   * This response has not been observed, so no field is named. A `null` or `{}` here is Stockbit
   * saying there is nothing new, not a failure — the call is a badge check, and "no badge" is its
   * most common answer.
   */
  data: unknown;
}

/**
 * The new-research indicator.
 *
 * `symbol` is optional because the route declares it as a query parameter rather than a segment, and
 * an omitted parameter is genuinely absent from the URL rather than sent empty. Whether the
 * market-wide form (no symbol) is meaningful is unverified; with a symbol it is the call the app
 * makes when it opens a company page.
 */
export async function getResearchIndicator(symbol?: string): Promise<ResearchIndicator> {
  const sym = symbol === undefined || symbol === "" ? undefined : normalizeSymbol(symbol);
  return cached(`research:indicator:${sym ?? "*"}`, CACHE.brokerSummaryTtlMs, async () => {
    const body = await getJson("researchIndicator", { params: { symbol: sym } });
    const { data } = parseOr(Envelope, body, "research indicator");
    return { symbol: sym ?? null, data: data ?? null };
  });
}
