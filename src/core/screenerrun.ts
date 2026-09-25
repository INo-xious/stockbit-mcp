/**
 * Ad-hoc screener runs and watchlist reads.
 *
 * Run and save use the same POST route. The public Stockbit screener frontend sets save:"0" and
 * screenerid:"0" for an unsaved run, with JSON strings for filters and universe. The request shape
 * and paged response were verified with the catalogue's Market Cap metric on 2026-09-24.
 * buildScreenBody hard-codes the read flag. Saving uses a separate confirmation-gated function
 * and route in src/account/screener.ts; no input to this module can enable saving.
 */
import { z } from "zod";
import { getJson, postJson, type GetOptions } from "../http/client.js";
import { cached, parseOr, StrOrNum } from "./_util.js";
import { CACHE } from "../config.js";
import { StockbitError } from "../http/errors.js";
import { isSymbol } from "../symbol.js";
import type { RouteName } from "../http/transport.js";

/* ------------------------------- the rule grammar ------------------------------- */

/**
 * The comparison operators the screener accepts, quoted from the web bundle.
 *
 * Rules combine with an implicit AND and **there is no OR**. That limit is encoded here rather than
 * papered over: an "A or B" screen is two runs and a union of the results, done by the caller. A
 * silent reinterpretation of "or" as "and" — or as one branch of it — would return a confident,
 * wrong, and completely plausible-looking answer.
 *
 * The bundle also carries a non-filtering operator ("all") that projects a metric as an output column
 * without constraining it, which would turn this into a batch fundamentals fetcher. It is left out
 * until a capture shows what its rule carries in the value slot; guessing that would be one more
 * unverified field on a request that already has several.
 */
export const SCREEN_OPERATORS = [">", "<", ">=", "<=", "="] as const;
export type ScreenOperator = (typeof SCREEN_OPERATORS)[number];

export interface ScreenRule {
  /** A metric id from the screener catalogue (the `screener` tool with `catalogue: true`). */
  metric: string;
  operator: ScreenOperator;
  /** The threshold. Sent as a string; see the wire note on `buildScreenBody`. */
  value: number | string;
}

/**
 * The universe a screen runs over.
 *
 * `scope` "wl" with the watchlist id in `scopeID` is the one spelling read out of the bundle. The
 * index-universe spelling is NOT known, which is why this type takes the pair verbatim instead of an
 * enum that would imply the other values had been checked.
 */
export interface ScreenScope {
  scope: string;
  scopeID: string;
}

/** The wire spelling for "screen only the members of this watchlist". */
const WATCHLIST_SCOPE = "wl";

/** The frontend wire body. The unsaved flag is a literal, never caller-controlled. */
export interface ScreenBody {
  save: "0";
  screenerid: "0";
  name: string;
  description: string;
  ordertype: "asc";
  ordercol: number;
  page: number;
  universe: string;
  filters: string;
  sequence: string;
  type: "TEMPLATE_TYPE_CUSTOM";
}

function invalid(message: string): never {
  throw new StockbitError("invalid_param", message);
}

/**
 * Scope a screen to a watchlist's members.
 *
 * The id lands in a request BODY, so none of the transport's path-segment validators ever sees it.
 * That is why it is checked here: a non-numeric id would otherwise be posted verbatim and the screen
 * would run over whatever the server makes of it, which is not distinguishable from a screen that
 * matched nothing.
 */
export function watchlistScope(watchlistId: string): ScreenScope {
  const id = String(watchlistId).trim();
  if (!/^[0-9]{1,20}$/.test(id)) {
    invalid(`Invalid watchlist id ${JSON.stringify(watchlistId)}: expected a numeric id`);
  }
  return { scope: WATCHLIST_SCOPE, scopeID: id };
}

/**
 * Validate model-supplied rules, then serialize Stockbit's basic numeric comparisons.
 * The frontend embeds these two structures as JSON strings inside the outer JSON request.
 * Source: /_next/static/chunks/pages/screener-f6f3c6b38de0136b.js, module 18544.
 */
export function buildScreenBody(rules: readonly ScreenRule[], scope?: ScreenScope): ScreenBody {
  if (rules.length === 0) {
    invalid("A screen needs at least one rule: a run with no rules would return the whole universe");
  }
  const built = rules.map((rule, index) => {
    const where = `rule ${index + 1}`;
    const metric = typeof rule.metric === "string" ? rule.metric.trim() : "";
    if (!metric) invalid(`${where}: metric must be a non-empty metric id from the screener catalogue`);
    if (!(SCREEN_OPERATORS as readonly string[]).includes(rule.operator)) {
      invalid(
        `${where}: invalid operator ${JSON.stringify(rule.operator)}: expected one of ` +
          `${SCREEN_OPERATORS.join(", ")}. There is no OR — run two screens and union the results.`,
      );
    }
    let value: string;
    if (typeof rule.value === "number") {
      if (!Number.isFinite(rule.value)) invalid(`${where}: value must be a finite number`);
      value = String(rule.value);
    } else if (typeof rule.value === "string") {
      value = rule.value.trim();
      // Number("") is 0, so an empty value that reached the wire would screen for zero rather than
      // fail. It is refused here instead.
      if (!value) invalid(`${where}: value must not be empty`);
    } else {
      invalid(`${where}: value must be a number or a string`);
    }
    return { type: "basic", item1: metric, item1name: "", operator: rule.operator, item2: value, multiplier: "" };
  });

  const universe = scope ? { ...watchlistScope(scope.scopeID), name: "" } : { scope: "IHSG", scopeID: "", name: "" };
  if (scope && scope.scope !== WATCHLIST_SCOPE) invalid("Only watchlist scope is supported");
  return {
    save: "0",
    screenerid: "0",
    name: "TEMPLATE_BUILD_MCP",
    description: "",
    ordertype: "asc",
    ordercol: 2,
    page: 1,
    universe: JSON.stringify(universe),
    filters: JSON.stringify(built),
    sequence: [...new Set(built.map((rule) => rule.item1))].join(","),
    type: "TEMPLATE_TYPE_CUSTOM",
  };
}

/* ----------------------------- locating rows in a payload ----------------------------- */

/**
 * Keys that have held a row array on this API.
 *
 * `calcs` is what the sibling GET that runs a SAVED screen returns and `result` is what the watchlist
 * detail uses; the rest are searched on spec. Guessing where to *look* is harmless in a way that
 * guessing a field name is not — a miss is reported as a miss, with the payload attached, instead of
 * being flattened into an empty list that reads like "nothing matched".
 */
const ROW_KEYS = ["calcs", "result", "results", "list", "items", "symbols", "companies"] as const;

/** Where a row array was found, and the rows. `rows: null` means "not found", never "none". */
export function findRows(data: unknown): { rows: unknown[] | null; foundAt: string | null } {
  if (Array.isArray(data)) return { rows: data, foundAt: "data" };
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ROW_KEYS) {
      const candidate = record[key];
      if (Array.isArray(candidate)) return { rows: candidate, foundAt: `data.${key}` };
    }
  }
  return { rows: null, foundAt: null };
}

/** A list read whose inner shape has not been observed. */
export interface RowList {
  /** The rows, or `null` when no array was found where one was looked for. */
  rows: unknown[] | null;
  /** How many rows. `null` when `rows` is null — an unlocated list has no count, and 0 would lie. */
  count: number | null;
  /** The response key the rows came out of, for the capture that will confirm this shape. */
  foundAt: string | null;
  /** The whole response body, returned ONLY when the rows could not be located. */
  raw?: unknown;
}

const Envelope = z.object({ data: z.unknown() }).passthrough();

async function readRowList(route: RouteName, context: string, opts: GetOptions = {}): Promise<RowList> {
  const body = await getJson(route, opts);
  const { data } = parseOr(Envelope, body, context);
  const { rows, foundAt } = findRows(data);
  if (rows === null) return { rows: null, count: null, foundAt: null, raw: body };
  return { rows, count: rows.length, foundAt };
}

/* --------------------------------- running a screen --------------------------------- */

const ResultCell = z
  .object({ id: StrOrNum.optional(), name: z.string().optional(), display: z.string().optional() })
  .passthrough();

/**
 * One matched row.
 *
 * The company block is the shape the saved-screen GET returns; a flat `symbol` on the row is checked
 * too because this endpoint's response has not been seen and the two are equally plausible.
 */
const MatchRow = z
  .object({
    company: z
      .object({ symbol: z.string().optional(), name: z.string().optional(), id: StrOrNum.optional() })
      .passthrough()
      .optional(),
    symbol: z.string().optional(),
    name: z.string().optional(),
    results: z.array(ResultCell).optional(),
  })
  .passthrough();

export interface ScreenMatch {
  symbol: string;
  name?: string;
  companyId?: string;
  /**
   * The metric columns the screen projected, each cell passed through whole with its id normalized.
   *
   * Naming a subset of the cell would repeat the mistake `getSectors` in `src/core/emitten.ts`
   * documents: it turns "we have not looked at this field" into "this field does not exist".
   */
  metrics: Array<Record<string, unknown>>;
}

export interface ScreenRunResult {
  /** Exactly what was posted, including `save`, so the shape is auditable from the result. */
  request: ScreenBody;
  /**
   * The matches, or `null` when no row array was found in the response. `null` is not "no stock
   * matched" — an empty `[]` is that, and the two must not be confused when the response shape is
   * still a hypothesis.
   */
  matches: ScreenMatch[] | null;
  /** Projected matches in this page before the local `limit`. `null` alongside `matches`. */
  count: number | null;
  /** True when the local limit omitted matches from this page. */
  truncated: boolean;
  /** Upstream pagination metadata. Missing totals stay null, never zero. */
  page: number;
  pageSize: number | null;
  totalMatches: number | null;
  hasMore: boolean | null;
  foundAt: string | null;
  /** Rows that were present but carried no ticker in either place one is looked for. */
  unprojected: number;
  /** The first such row, verbatim, so the real shape can be read off a tool result. */
  unprojectedSample?: unknown;
  /** The whole response body, returned ONLY when no row array was found at all. */
  raw?: unknown;
}

function projectMatch(row: unknown): ScreenMatch | null {
  const parsed = MatchRow.safeParse(row);
  if (!parsed.success) return null;
  const { company, results } = parsed.data;
  const symbol = company?.symbol ?? parsed.data.symbol;
  if (!symbol) return null;
  return {
    symbol,
    name: company?.name ?? parsed.data.name,
    companyId: company?.id,
    metrics: (results ?? []).map((cell) => ({
      ...cell,
      id: cell.id === undefined ? undefined : String(cell.id),
    })),
  };
}

function checkLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    invalid(`Invalid limit ${JSON.stringify(limit)}: expected a whole number of 1 or more`);
  }
  return limit;
}

/**
 * Run one upstream page without saving. `limit` trims only that page locally; `totalMatches`
 * and `hasMore` report upstream pagination separately. Page is part of the request/cache key.
 */
export async function runScreen(
  rules: readonly ScreenRule[],
  options: { scope?: ScreenScope; limit?: number; page?: number } = {},
): Promise<ScreenRunResult> {
  const limit = checkLimit(options.limit);
  const page = options.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) invalid("page must be a positive whole number");
  const body = { ...buildScreenBody(rules, options.scope), page };
  // Every field that changes the answer is in the body, so the serialized body IS the cache key.
  const full = await cached(`screen:run:${JSON.stringify(body)}`, CACHE.defaultTtlMs, async () => {
    const payload = await postJson("screenerRun", { body });
    const parsed = parseOr(Envelope, payload, "screener run");
    const { rows, foundAt } = findRows(parsed.data);
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data as Record<string, unknown> : {};
    const integer = (value: unknown): number | null => {
      if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return null;
      const n = Number(value);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    const totalMatches = integer(data.totalrows);
    const pageSize = integer(data.perpage);
    const current = integer(data.curpage);
    const actualPage = current && current > 0 ? current : page;
    const pagination = {
      page: actualPage, pageSize, totalMatches,
      hasMore: totalMatches !== null && pageSize !== null && pageSize > 0 ? actualPage * pageSize < totalMatches : null,
    };
    if (rows === null) {
      return {
        request: body,
        ...pagination,
        matches: null,
        count: null,
        truncated: false,
        foundAt: null,
        unprojected: 0,
        raw: payload,
      } satisfies ScreenRunResult;
    }
    const matches: ScreenMatch[] = [];
    let unprojected = 0;
    let unprojectedSample: unknown;
    for (const row of rows) {
      const match = projectMatch(row);
      if (match) matches.push(match);
      else {
        unprojected++;
        if (unprojectedSample === undefined) unprojectedSample = row;
      }
    }
    return {
      request: body,
      ...pagination,
      matches,
      count: matches.length,
      truncated: false,
      foundAt,
      unprojected,
      ...(unprojectedSample === undefined ? {} : { unprojectedSample }),
    } satisfies ScreenRunResult;
  });

  if (limit === undefined || full.matches === null || full.matches.length <= limit) return full;
  return { ...full, matches: full.matches.slice(0, limit), truncated: true };
}

/* --------------------------------- screener lists --------------------------------- */

/**
 * The user's favourited screens.
 *
 * Unprobed. The favourite flag also arrives on the saved-screen listing that `getScreenerTemplates`
 * already reads, so if this route answers with something unexpected that listing is the fallback
 * rather than a dead end.
 */
export async function getScreenerFavorites(): Promise<RowList> {
  return cached("screener:favorites", CACHE.keystatsTtlMs, () =>
    readRowList("screenerFavorites", "screener favorites"),
  );
}

/**
 * Stockbit calls this the fin-item watchlist: the financial-statement line items saved for use as
 * screener columns.
 *
 * Unprobed, including what a row means. The rows are returned as they arrive rather than projected
 * into names that would be a guess about a shape nobody has looked at.
 */
export async function getScreenerFinItems(): Promise<RowList> {
  return cached("screener:finitems", CACHE.keystatsTtlMs, () =>
    readRowList("screenerFinItems", "screener fin-item watchlist"),
  );
}

/* -------------------------------- watchlist reads -------------------------------- */

export interface WatchlistSymbolList {
  watchlistId: string;
  /** Tickers, or `null` when no row array was found. `null` is not "the list is empty". */
  symbols: string[] | null;
  count: number | null;
  foundAt: string | null;
  /** Rows that held no recognisable ticker. */
  unprojected: number;
  unprojectedSample?: unknown;
  /**
   * The rows as they arrived, when they carried more than a bare ticker. Omitted when every row was
   * a string, because then `symbols` already is the payload.
   */
  rows?: unknown[];
  /** The whole response body, returned ONLY when the rows could not be located. */
  raw?: unknown;
}

/** A ticker off a row that may be a bare string or an object. */
function symbolOf(row: unknown): string | null {
  const raw =
    typeof row === "string"
      ? row
      : row && typeof row === "object" && typeof (row as Record<string, unknown>).symbol === "string"
        ? ((row as Record<string, unknown>).symbol as string)
        : null;
  if (raw === null) return null;
  const symbol = raw.trim().toUpperCase();
  // `isSymbol` rather than `normalizeSymbol`: this value came from upstream, and upstream junk is
  // drift to be reported, not an invalid_param to be blamed on the caller.
  return isSymbol(symbol) ? symbol : null;
}

/**
 * The dedicated symbols route for one watchlist.
 *
 * `getWatchlistSymbols` in `src/core/watchlist.ts` answers the same question a different way — off
 * the detail endpoint, which is verified, returns quotes alongside the tickers, and requires a limit
 * capped at 500. This route has not been probed, so for a scan universe the proven one is still the
 * one to reach for; this exists because it is the endpoint Stockbit's own client uses for the plain
 * membership question and it takes no limit.
 */
export async function getWatchlistSymbolList(watchlistId: string): Promise<WatchlistSymbolList> {
  // Not normalized here: the transport's `watchlistId` validator rejects a non-numeric id before the
  // request is built, and duplicating that rule is how the two drift apart.
  const id = String(watchlistId).trim();
  return cached(`watchlist:symbols:${id}`, CACHE.defaultTtlMs, async () => {
    const list = await readRowList("watchlistSymbols", "watchlist symbols", {
      segments: { watchlistId: id },
    });
    if (list.rows === null) {
      return { watchlistId: id, symbols: null, count: null, foundAt: null, unprojected: 0, raw: list.raw };
    }
    const symbols: string[] = [];
    let unprojected = 0;
    let unprojectedSample: unknown;
    for (const row of list.rows) {
      const symbol = symbolOf(row);
      if (symbol) symbols.push(symbol);
      else {
        unprojected++;
        if (unprojectedSample === undefined) unprojectedSample = row;
      }
    }
    const allStrings = list.rows.every((row) => typeof row === "string");
    return {
      watchlistId: id,
      symbols,
      count: symbols.length,
      foundAt: list.foundAt,
      unprojected,
      ...(unprojectedSample === undefined ? {} : { unprojectedSample }),
      ...(allStrings ? {} : { rows: list.rows }),
    };
  });
}

export interface CompanySearchResult extends RowList {
  keyword: string;
  watchlistId: string;
  page: number;
  hasMore: boolean | null;
}

/**
 * Search Stockbit's company directory by keyword — the lookup behind the watchlist's add-a-stock box.
 *
 * The endpoint requires a watchlist id and one-based page in addition to the keyword. Membership
 * flags in its suggestions are relative to that watchlist, so it is part of the cache identity.
 * Response rows and has_more_companies were observed on 2026-09-24; rows remain unprojected.
 */
export async function searchCompanies(keyword: string, watchlistId: string, page = 1): Promise<CompanySearchResult> {
  const trimmed = typeof keyword === "string" ? keyword.trim() : "";
  // An empty keyword is refused rather than sent: the endpoint would answer it with either everything
  // or nothing, and both read like a real answer to a search nobody actually performed.
  if (!trimmed) invalid("Search keyword must not be empty");
  const id = watchlistScope(watchlistId).scopeID;
  if (!Number.isSafeInteger(page) || page < 1) invalid("Search page must be a positive integer (first page is 1)");
  // The key uses the exact string that goes on the wire. A key normalized differently from the
  // request is how two different searches come to share one cached answer.
  return cached(`watchlist:search:${JSON.stringify([id, page, trimmed])}`, CACHE.keystatsTtlMs, async () => {
    const body = await getJson("watchlistSearchCompany", {
      params: { keyword: trimmed, watchlist_id: id, page },
    });
    const { data } = parseOr(Envelope, body, "company search");
    const { rows, foundAt } = findRows(data);
    const more = data && typeof data === "object" ? (data as Record<string, unknown>).has_more_companies : undefined;
    return {
      keyword: trimmed, watchlistId: id, page, hasMore: typeof more === "boolean" ? more : null,
      rows, foundAt, count: rows === null ? null : rows.length,
      ...(rows === null ? { raw: body } : {}),
    };
  });
}
