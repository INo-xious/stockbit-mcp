/**
 * The social stream: community posts, news, ideas, filed reports and research, market-wide or per
 * symbol.
 *   GET /stream/v3                          → market-wide, filtered by category/keyword/date
 *   GET /stream/v3/symbol/:symbol           → one symbol's stream (News tab = category NEWS)
 *   GET /stream/v3/symbol/:symbol/pinned    → the posts pinned to that symbol
 *   GET /stream/v3/post/:postId             → one post
 *   GET /stream/non-login/user/:username    → one user's posts
 *   POST /stream/v3/trending                → trending posts (a POST that READS)
 *
 * This is text people wrote, not market data. Nothing here is audited: a post is a pointer to a
 * source and a reading of sentiment, never a quotation of a number.
 *
 * ## Only one of these routes has been observed live
 *
 * The per-symbol one, which `getSentimentStream` has used since the first version of this server.
 * The other five are declared in the route table and wired here, but their envelopes have not been
 * seen. Everything below is therefore built to survive being wrong about the shape:
 *
 *   - the envelope is validated only as "an object that may carry `data`";
 *   - the row list is *located* among a few shapes this API is known to use elsewhere, and where it
 *     was found is reported as `source`, so a wrong guess shows up in the answer instead of turning
 *     into a silent empty page;
 *   - each row is projected into named fields where this project is confident, and the untouched
 *     wire object rides along as `raw`, because a news row's link, image or attached report lives in
 *     fields nobody here has mapped and dropping them would be unrecoverable.
 *
 * ## Paging is a cursor
 *
 * There is no page number and no offset. A page is continued by sending the id of the last row you
 * have already seen as `last_stream_id`, so the accessors return `nextCursor` — the id of the last
 * row in the page they are returning — and a caller that ignores it re-reads the same rows.
 */
import { z } from "zod";
import { getJson, postJson } from "../http/client.js";
import { cached, parseOr, StrOrNum } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { normalizeTradeDate } from "./dates.js";
import { StockbitError } from "../http/errors.js";
import type { QueryParams } from "../http/transport.js";

/* --------------------------------- vocabulary --------------------------------- */

/**
 * The `category` values, in Stockbit's own spelling.
 *
 * Wire constants, not friendly names — they are sent verbatim and are case-sensitive. The four
 * that are not obvious from their name:
 *
 *   - `MAIN_IDEAS` is the curated ideas feed, `IDEAS` the unfiltered one.
 *   - `LIKED` and `SAVED` are scoped to the signed-in account, so they are personal, not market-wide.
 *   - the three `*_WATCHLIST` values scope the stream to the account's own lists; `watchlistIds`
 *     narrows that further to named lists.
 *
 * Whether every value is accepted on every stream route is unverified. A wrong one on this API
 * usually answers 200 with a *different* selection rather than an error, which is why the tuple is
 * closed here and a value outside it never reaches the wire.
 */
export const STREAM_CATEGORIES = [
  "STREAM_CATEGORY_ALL",
  "STREAM_CATEGORY_NEWS",
  "STREAM_CATEGORY_IDEAS",
  "STREAM_CATEGORY_REPORTS",
  "STREAM_CATEGORY_CHART",
  "STREAM_CATEGORY_INSIDER",
  "STREAM_CATEGORY_PREDICTION",
  "STREAM_CATEGORY_POLLING",
  "STREAM_CATEGORY_ALL_WATCHLIST",
  "STREAM_CATEGORY_PEOPLE_WATCHLIST",
  "STREAM_CATEGORY_COMPANY_WATCHLIST",
  "STREAM_CATEGORY_MAIN_IDEAS",
  "STREAM_CATEGORY_LIKED",
  "STREAM_CATEGORY_SAVED",
] as const;

/**
 * The `report_type` values. Indonesian, because they are IDX filing kinds:
 * laporan keuangan = financial statements, RUPS = the shareholders' meeting, kepemilikan saham =
 * share ownership, dividen = dividend.
 *
 * Note the wire spelling `REPORT_TYPE_KEPIMILIKAN_SAHAM` — the Indonesian word is *kepemilikan*, and
 * the API's spelling is not. It is transcribed as the server has it; correcting it would be a
 * silently narrower query.
 */
export const REPORT_TYPES = [
  "REPORT_TYPE_ALL",
  "REPORT_TYPE_LAPORAN_KEUANGAN",
  "REPORT_TYPE_RUPS",
  "REPORT_TYPE_KEPIMILIKAN_SAHAM",
  "REPORT_TYPE_DIVIDEN",
  "REPORT_TYPE_CORPORATE_ACTION",
  "REPORT_TYPE_OTHER",
] as const;

export type StreamCategory = (typeof STREAM_CATEGORIES)[number];
export type ReportType = (typeof REPORT_TYPES)[number];

/** The category the symbol page's News tab sends. Kept here so `getNews` and the docs cannot drift. */
export const NEWS_CATEGORY: StreamCategory = "STREAM_CATEGORY_NEWS";

/* ------------------------------- row projection ------------------------------- */

const Post = z
  .object({
    stream_id: StrOrNum.optional(),
    content: z.string().optional(),
    content_original: z.string().optional(),
    created_at: z.string().optional(),
    user: z
      .object({ username: z.string().optional(), fullname: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export interface StreamPost {
  id?: string;
  content?: string;
  createdAt?: string;
  author?: string;
}

/**
 * A row: the named projection plus the wire object it came from.
 *
 * `raw` is not redundancy for its own sake. The four named fields are the ones this project has
 * actually seen on the per-symbol route; a news row's headline link, an idea's attached chart, a
 * poll's options and every engagement counter live in fields that have not been mapped, and naming
 * only the survivors would turn "not looked at yet" into "does not exist" (the mistake `getSectors`
 * documents). Nesting rather than spreading keeps a wire key from being clobbered by a projected one.
 */
export interface StreamItem extends StreamPost {
  raw: unknown;
}

function projectItem(row: unknown): StreamItem {
  const parsed = Post.safeParse(row);
  // A row that is not an object at all still travels: `raw` is the only honest thing to say about it.
  if (!parsed.success) return { raw: row };
  const p = parsed.data;
  return {
    id: p.stream_id,
    content: p.content_original ?? p.content,
    createdAt: p.created_at,
    author: p.user?.username ?? p.user?.fullname,
    raw: row,
  };
}

/* --------------------------------- envelopes --------------------------------- */

/**
 * As permissive as it can be and still be a check: an object, whose `data` may be anything or absent.
 *
 * A required inner field guessed wrong turns a working endpoint into a `schema_drift` error, and
 * five of these six routes have never been seen. The shape work happens in `locateStreamRows` instead,
 * where being wrong is reportable rather than fatal.
 */
const Envelope = z.object({ data: z.unknown() }).passthrough();

/**
 * The three places a list of rows sits in this API, tried in order.
 *
 * Not a guess pulled from the air: `data.stream` is what the per-symbol stream returns and is the
 * only one verified for this family, `data` as a bare array is what the watchlist index returns, and
 * `data.result` is what the watchlist *detail* returns. Which one matched is returned to the caller,
 * so a fourth shape shows up as `source: null` next to the payload rather than as an empty page.
 *
 * Exported because `src/core/research.ts` reads the same envelopes from the same service and must
 * not re-guess them independently.
 */
export function locateStreamRows(data: unknown): { source: string | null; rows: unknown[] } {
  if (Array.isArray(data)) return { source: "data", rows: data };
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["stream", "result"] as const) {
      if (Array.isArray(obj[key])) return { source: `data.${key}`, rows: obj[key] as unknown[] };
    }
  }
  return { source: null, rows: [] };
}

export interface StreamPage {
  /**
   * Where the rows were found in the envelope (`data.stream`, `data`, `data.result`), or `null` when
   * no list was recognised.
   *
   * This is the difference between "the stream is empty" and "we could not read the response".
   * `items: []` with a non-null source is a real, empty answer; a null source is a shape this code
   * has not seen, and `unrecognized` carries what actually arrived.
   */
  source: string | null;
  items: StreamItem[];
  /**
   * The id of the LAST row in this page — what to send back as `last_stream_id` to continue.
   *
   * `null` when the page is empty or its last row carried no id, which means the walk cannot be
   * continued from here rather than that it has ended.
   */
  nextCursor: string | null;
  /** Present only when `source` is null: the response body, so the caller can see what came instead. */
  unrecognized?: unknown;
}

function toPage(body: unknown, context: string, limit?: number): StreamPage {
  const parsed = parseOr(Envelope, body, context);
  const { source, rows } = locateStreamRows(parsed.data);
  if (source === null) return { source, items: [], nextCursor: null, unrecognized: parsed.data ?? body };
  // Sliced client-side as well as asked for on the wire: whether every route in this family honours
  // `limit` is unverified, and a caller who asked for 5 must not be handed 30 either way. The cursor
  // is taken AFTER the slice, or continuing the page would skip the rows that were cut.
  const items = (limit === undefined ? rows : rows.slice(0, limit)).map(projectItem);
  return { source, items, nextCursor: items.at(-1)?.id ?? null };
}

/* --------------------------------- validation --------------------------------- */

function fromTuple<T extends readonly string[]>(
  values: T,
  input: unknown,
  field: string,
): T[number] | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input === "string" && (values as readonly string[]).includes(input)) return input;
  throw new StockbitError(
    "invalid_param",
    `Invalid ${field} ${JSON.stringify(input)}: expected one of ${values.join(", ")}`,
  );
}

/**
 * A row count.
 *
 * No ceiling is enforced because Stockbit's has not been measured, and a limit invented here that is
 * lower than the real one would refuse a request the API would have answered. Zero is rejected: it
 * reads as "no limit" to a caller and as "no rows" to a slice.
 */
function positiveLimit(input: unknown, field = "limit"): number | undefined {
  if (input === undefined || input === null) return undefined;
  const n = Number(input);
  if (!Number.isInteger(n) || n <= 0) {
    throw new StockbitError("invalid_param", `Invalid ${field} ${JSON.stringify(input)}: expected a positive integer`);
  }
  return n;
}

/** Watchlist ids are numeric on this API; anything else is a caller error and never sent. */
function watchlistIds(input: readonly string[] | undefined): string[] | undefined {
  if (input === undefined) return undefined;
  if (input.length === 0) return undefined;
  return input.map((id) => {
    const value = String(id).trim();
    if (!/^[0-9]{1,20}$/.test(value)) {
      throw new StockbitError("invalid_param", `Invalid watchlist id ${JSON.stringify(id)}: expected a numeric id`);
    }
    return value;
  });
}

/**
 * The two date ends, each validated through `normalizeTradeDate`.
 *
 * Either end may stand alone here — unlike the broker-summary range, where a lone `from` silently
 * returns the latest session. What is not allowed is an inverted pair, which would quietly select
 * nothing.
 */
function dateWindow(fromDate: unknown, toDate: unknown): { from_date?: string; to_date?: string } {
  const from = fromDate === undefined || fromDate === null ? undefined : normalizeTradeDate(fromDate, "from_date");
  const to = toDate === undefined || toDate === null ? undefined : normalizeTradeDate(toDate, "to_date");
  if (from !== undefined && to !== undefined && from > to) {
    throw new StockbitError("invalid_param", `from_date (${from}) must not be after to_date (${to})`);
  }
  return { from_date: from, to_date: to };
}

/* ------------------------------- request & cache ------------------------------- */

export interface StreamQuery {
  category?: string;
  /** Full-text search over post content. */
  keyword?: string;
  /** YYYY-MM-DD, calendar-checked. */
  fromDate?: string;
  toDate?: string;
  limit?: number;
  /** Narrows `STREAM_CATEGORY_REPORTS`. */
  reportType?: string;
  /** Cursor: the id of the last row already seen. */
  lastStreamId?: string;
  /**
   * The second cursor Stockbit's own client sends beside `last_stream_id`. Its role is unverified,
   * so it is passed through verbatim and never synthesised here.
   */
  lastReply?: string;
  /** The account's own watchlist ids, for the `*_WATCHLIST` categories. */
  watchlistIds?: readonly string[];
}

function buildParams(query: StreamQuery): QueryParams {
  const { from_date, to_date } = dateWindow(query.fromDate, query.toDate);
  return {
    category: fromTuple(STREAM_CATEGORIES, query.category, "category"),
    report_type: fromTuple(REPORT_TYPES, query.reportType, "report_type"),
    keyword: query.keyword,
    from_date,
    to_date,
    limit: positiveLimit(query.limit),
    last_stream_id: query.lastStreamId,
    last_reply: query.lastReply,
    // Repeated `watchlist_ids=` parameters, which is what the transport does with an array and what
    // this API wanted the one time it was measured (broker activity). Comma-joining is the other
    // candidate; if the filter ever appears to be ignored, that is the first thing to check.
    watchlist_ids: watchlistIds(query.watchlistIds),
  };
}

/**
 * A cache key derived FROM the request rather than restated beside it.
 *
 * The bug this shape exists to prevent is this file's own: the key was `stream:${symbol}` while the
 * answer also depended on `limit`, so a caller who asked for 50 rows was served a cached 5. Building
 * the key out of the params object that is about to be sent means a parameter cannot be added to the
 * request without appearing in the key. `extra` is for anything that shapes the ANSWER but not the
 * REQUEST — a client-side slice, a path segment.
 */
function requestKey(prefix: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const entries = Object.entries({ ...params, ...extra })
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`);
  return `${prefix}?${entries.join("&")}`;
}

/* ---------------------------------- accessors ---------------------------------- */

/** The market-wide stream. Every filter is optional; with none, Stockbit's own default feed. */
export async function getStream(query: StreamQuery = {}): Promise<StreamPage> {
  const params = buildParams(query);
  return cached(requestKey("stream:all", params), CACHE.defaultTtlMs, async () => {
    const body = await getJson("streamAll", { params });
    return toPage(body, "stream", params.limit as number | undefined);
  });
}

/**
 * One symbol's stream.
 *
 * The symbol page's News tab is exactly this route with `category=STREAM_CATEGORY_NEWS`, which is
 * why `getNews` routes here when it is given a symbol instead of reaching for a separate endpoint.
 */
export async function getSymbolStream(symbol: string, query: StreamQuery = {}): Promise<StreamPage> {
  const sym = normalizeSymbol(symbol);
  const params = buildParams(query);
  return cached(requestKey("stream:symbol", params, { symbol: sym }), CACHE.defaultTtlMs, async () => {
    const body = await getJson("streamSymbol", { segments: { symbol: sym }, params });
    return toPage(body, "symbol stream", params.limit as number | undefined);
  });
}

/**
 * News, market-wide or for one symbol.
 *
 * Both are the same category on two different routes: with a symbol it is the per-symbol stream the
 * app's News tab uses, without one it is the market-wide stream. `category` is not accepted — the
 * whole point of this accessor is that it is fixed to NEWS; use `getStream` for anything else.
 */
export async function getNews(
  query: Omit<StreamQuery, "category"> & { symbol?: string } = {},
): Promise<StreamPage> {
  const { symbol, ...rest } = query;
  const withCategory: StreamQuery = { ...rest, category: NEWS_CATEGORY };
  return symbol === undefined || symbol === "" ? getStream(withCategory) : getSymbolStream(symbol, withCategory);
}

/**
 * The posts pinned to a symbol.
 *
 * Sent with no parameters at all: pinned posts are a short, hand-curated list, and no filter has
 * been observed on this route. An empty list is the normal answer for most symbols.
 */
export async function getPinnedPosts(symbol: string): Promise<StreamPage> {
  const sym = normalizeSymbol(symbol);
  return cached(requestKey("stream:pinned", {}, { symbol: sym }), CACHE.brokerSummaryTtlMs, async () => {
    const body = await getJson("streamSymbolPinned", { segments: { symbol: sym } });
    return toPage(body, "pinned stream");
  });
}

/**
 * One user's posts.
 *
 * The route is Stockbit's `non-login` one — a public profile feed — but it is still sent with the
 * account's bearer, because the route table gives every exodus row the main session and a read that
 * quietly went out unauthenticated would be a different request than the one declared.
 *
 * The username charset is enforced by the transport's segment validator, so a bad one throws before
 * a request is built.
 */
export async function getUserStream(
  username: string,
  query: Pick<StreamQuery, "limit" | "lastStreamId"> = {},
): Promise<StreamPage> {
  const name = String(username).trim();
  const limit = positiveLimit(query.limit);
  const params: QueryParams = { limit, last_stream_id: query.lastStreamId };
  return cached(requestKey("stream:user", params, { username: name }), CACHE.defaultTtlMs, async () => {
    const body = await getJson("streamUser", { segments: { username: name }, params });
    return toPage(body, "user stream", limit);
  });
}

export interface TrendingQuery {
  /** YYYY-MM-DD. Omitted means whatever day Stockbit considers current. */
  date?: string;
  lastStreamId?: string;
  limit?: number;
}

/**
 * Trending posts.
 *
 * A POST that reads: the route table says so, and the body carries only the date/cursor/limit triple
 * that does not fit a URL. Nothing is created, so the result is cached like any other read.
 */
export async function getTrendingStream(query: TrendingQuery = {}): Promise<StreamPage> {
  const limit = positiveLimit(query.limit);
  const body: Record<string, unknown> = {
    date: query.date === undefined || query.date === null ? undefined : normalizeTradeDate(query.date, "date"),
    last_stream_id: query.lastStreamId,
    limit,
  };
  // `undefined` values are dropped so the body carries only what the caller actually asked for.
  for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
  return cached(requestKey("stream:trending", body), CACHE.defaultTtlMs, async () => {
    const res = await postJson("streamTrending", { body });
    return toPage(res, "trending stream", limit);
  });
}

export interface PostDetail {
  /** The named projection, or `null` when no post could be located in the response. */
  post: StreamItem | null;
  /** Where it was found (`data`, `data.stream`), or `null`. */
  source: string | null;
  /**
   * The envelope's `data`, always. A post detail carries replies, counters and attachments that this
   * projection does not name, and unlike a page of rows it is one object, so returning it costs
   * little and losing it costs a second request.
   */
  raw: unknown;
}

/**
 * One post by id.
 *
 * `postId` is validated as a numeric id by the transport's segment validator, so a slug or a URL
 * fragment throws before a request is built.
 */
export async function getPost(postId: string): Promise<PostDetail> {
  const id = String(postId).trim();
  return cached(requestKey("stream:post", {}, { postId: id }), CACHE.defaultTtlMs, async () => {
    const body = await getJson("streamPost", { segments: { postId: id } });
    const parsed = parseOr(Envelope, body, "stream post");
    const data = parsed.data;

    // A detail endpoint may answer with the post object itself or with a one-row list, so both are
    // handled and which one it was is reported rather than assumed. The object is checked FIRST: a
    // post that carries its replies under `stream` would otherwise have its first reply returned as
    // the post, which is a wrong answer that looks like a right one.
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      if (obj.stream_id !== undefined || obj.content !== undefined) {
        return { post: projectItem(obj), source: "data", raw: data };
      }
    }
    const located = locateStreamRows(data);
    if (located.source !== null) {
      const first = located.rows[0];
      return { post: first === undefined ? null : projectItem(first), source: located.source, raw: data };
    }
    return { post: null, source: null, raw: data ?? body };
  });
}

/**
 * Recent community posts mentioning a symbol, as a flat list. The original sentiment accessor.
 *
 * Kept because `sentiment_stream` is registered against it. Two things about it are deliberate:
 *
 * **The request is byte-identical to what it has always sent** — no `limit` parameter — so the one
 * route in this family that is known to work keeps working exactly as it did. `limit` is applied to
 * the rows afterwards.
 *
 * **Its own cache key is gone rather than corrected.** The old key `stream:${sym}` ignored `limit`
 * while the answer depended on it, so a caller asking for 50 was served a cached 5. Caching the full
 * page under `getSymbolStream`'s key and slicing after the fact removes the class of bug instead of
 * patching this instance: there is nothing left for the key to omit.
 *
 * A response with no recognisable list still throws `schema_drift` here, as it always did. This
 * accessor promises a list of posts, and an empty array is a claim that the symbol has none.
 */
export async function getSentimentStream(symbol: string, limit = 30): Promise<StreamPost[]> {
  const page = await getSymbolStream(symbol);
  if (page.source === null) {
    throw new StockbitError("schema_drift", "Unexpected sentiment stream response shape (no post list found)");
  }
  const count = positiveLimit(limit) ?? 30;
  return page.items.slice(0, count).map(({ raw: _raw, ...post }) => post);
}
