/**
 * Ad-hoc screener runs, and the two watchlist reads that scope and feed one.
 *
 * Deliberately separate from `src/core/screener.ts`. That module holds the screener calls that were
 * observed live on 2026-08-09; everything here is either a request shape nobody has captured yet or a
 * route nobody has probed. Keeping them in different files means a reader can tell which half is
 * measured without reading either.
 *
 * ## The one invariant this file exists to hold
 *
 * Running a screen and saving one are the SAME endpoint. Stockbit's own client separates them with a
 * single body field: `save` of "0" evaluates the rules and persists nothing, `save` of "1" creates a
 * saved screen on the account — its reducer only adopts a new screener id in the second case (see the
 * screener section of `docs/CAPABILITY-RESEARCH.md`). So the difference between a read and an account
 * write here is one character, and it must not be reachable from tool input.
 *
 * `buildScreenBody` hard-codes "0" and accepts no parameter that could change it. There is no
 * argument to any function in this module — and therefore none to any tool built on it — that turns
 * this into a write. The saving variant is a separate confirm-gated tool in a later increment and it
 * does not live in this file.
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

/** The body as it goes out. `save` is typed as the literal "0" so a widening assignment fails to compile. */
export interface ScreenBody {
  save: "0";
  rules: Array<{ metric: string; operator: ScreenOperator; value: string }>;
  scope?: string;
  scopeID?: string;
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
 * Build the body for an ad-hoc run. Pure, exported, and the only place this shape exists.
 *
 * ## What is sourced and what is a hypothesis
 *
 * Sourced from the web bundle: `save` of "0" meaning run-and-persist-nothing, the operator list, the
 * implicit AND, and the watchlist scope pair. Everything else — the key that holds the rule list, the
 * spelling of the three rule fields, whether the scope pair sits at the top level or nested, and
 * whether values travel as strings or numbers — has NOT been observed. A HAR of the web UI running an
 * unsaved screen is what settles them, and when it is captured this function is the single edit:
 * nothing else in the codebase writes this shape, and `runScreen` returns the body it sent so a
 * mismatch is readable straight off a tool result rather than needing a proxy.
 *
 * Values are stringified because the one field known for certain, `save`, is a string on an API whose
 * ids arrive as strings too. That is an inference, not a measurement, and it is listed above.
 *
 * The validation below is not decoration. These rules are assembled from model-supplied arguments,
 * and a rule with an empty metric or an empty value is one the server would answer normally — with a
 * result set that quietly means something other than what was asked.
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
    return { metric, operator: rule.operator, value };
  });

  return {
    // Hard-coded, with no parameter above that can reach it. See the module note.
    save: "0",
    rules: built,
    ...(scope ? { scope: scope.scope, scopeID: scope.scopeID } : {}),
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
const ROW_KEYS = ["calcs", "result", "results", "list", "items", "symbols"] as const;

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
  /** How many rows matched in total, BEFORE `limit` truncated the list. `null` alongside `matches`. */
  count: number | null;
  /** True when `matches` holds fewer rows than `count`. */
  truncated: boolean;
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
  if (!Number.isFinite(limit) || Math.floor(limit) < 1) {
    invalid(`Invalid limit ${JSON.stringify(limit)}: expected a whole number of 1 or more`);
  }
  return Math.floor(limit);
}

/**
 * Run an ad-hoc screen. Creates nothing — see the module note on `save`.
 *
 * `limit` truncates the returned matches HERE, after the response, and never appears on the wire. The
 * saved-screen GET takes `page`/`limit` query parameters but nothing has confirmed this POST honours
 * them, and a paging parameter the server ignores is the worst kind: the caller believes the answer
 * was narrowed on purpose. `count` therefore stays the true total and `truncated` says the list was
 * cut. It also means the cache is keyed on the request alone: two limits over the same rules are one
 * upstream call, correctly, because they ARE one request.
 */
export async function runScreen(
  rules: readonly ScreenRule[],
  options: { scope?: ScreenScope; limit?: number } = {},
): Promise<ScreenRunResult> {
  const limit = checkLimit(options.limit);
  const body = buildScreenBody(rules, options.scope);
  // Every field that changes the answer is in the body, so the serialized body IS the cache key.
  const full = await cached(`screen:run:${JSON.stringify(body)}`, CACHE.defaultTtlMs, async () => {
    const payload = await postJson("screenerRun", { body });
    const parsed = parseOr(Envelope, payload, "screener run");
    const { rows, foundAt } = findRows(parsed.data);
    if (rows === null) {
      return {
        request: body,
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
}

/**
 * Search Stockbit's company directory by keyword — the lookup behind the watchlist's add-a-stock box.
 *
 * The rows are returned unprojected: which key holds the ticker on this route has not been observed,
 * and naming one now would ship a key that is always undefined.
 */
export async function searchCompanies(keyword: string): Promise<CompanySearchResult> {
  const trimmed = typeof keyword === "string" ? keyword.trim() : "";
  // An empty keyword is refused rather than sent: the endpoint would answer it with either everything
  // or nothing, and both read like a real answer to a search nobody actually performed.
  if (!trimmed) invalid("Search keyword must not be empty");
  // The key uses the exact string that goes on the wire. A key normalized differently from the
  // request is how two different searches come to share one cached answer.
  return cached(`watchlist:search:${trimmed}`, CACHE.keystatsTtlMs, async () => {
    const list = await readRowList("watchlistSearchCompany", "company search", {
      params: { keyword: trimmed },
    });
    return { keyword: trimmed, ...list };
  });
}
