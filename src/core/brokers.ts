/**
 * The broker family: the directory that gives every two-letter code a name, the reverse lookup of
 * broker summary (which stocks one broker traded), the market-wide league table, and a typed
 * accumulation/distribution reading built on the broker summary this project already has.
 *
 *   GET /findata-view/marketdetectors/brokers   page, limit
 *   GET /order-trade/broker/activity            one broker's stocks; REPEATED market/investor types
 *   GET /order-trade/broker/top                 the league table
 *
 * ## None of these three has been observed live
 *
 * That is the fact that shapes every projection below. Envelopes are permissive, `data` is accepted
 * as an array or as an object wrapping one, and no row field is renamed on a guess: each row is
 * returned whole under `row`, with the one or two fields this module is willing to claim it
 * recognised sitting beside it and `readFrom` naming the wire key each was read from. A wrong guess
 * therefore shows up as `code: undefined` next to a visible raw row, never as a confident wrong
 * value and never as a key that is always undefined.
 *
 * `bandar_detector` is the exception: it runs on `getBrokerSummary`, whose response shape was
 * measured, so it projects into named fields with no hedging.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import {
  getBrokerSummary,
  type BrokerSummaryOptions,
  type NormalizedBroker,
} from "./marketdetectors.js";

/* ------------------------------- vocabularies ------------------------------- */

/**
 * Preset windows, sent as `TB_PERIOD_` + the member.
 *
 * The members are the ones measured against broker *distribution* (`DISTRIBUTION_PERIODS` in
 * `src/core/brokerdistribution.ts`), which reads the same `TB_PERIOD_*` enum out of Stockbit's
 * bundle. They are duplicated here rather than imported because acceptance was measured on that
 * route and not on these two: sharing one constant would quietly promote "the bundle names this"
 * into "this endpoint takes it", which is exactly the mistake `MARKET_BOARD_` vs `MARKET_TYPE_`
 * already cost this codebase once.
 */
export const BROKER_PERIODS = [
  "LAST_1_DAY",
  "LAST_7_DAYS",
  "LAST_1_MONTH",
  "LAST_3_MONTHS",
  "LAST_6_MONTHS",
  "LAST_1_YEAR",
  "PREVIOUS_DAY",
  "PREVIOUS_MONTH",
  "THIS_MONTH",
  "YEAR_TO_DATE",
] as const;
export type BrokerPeriod = (typeof BROKER_PERIODS)[number];

/** Boards, sent as `MARKET_TYPE_` + the member — the order-trade service's prefix, not `MARKET_BOARD_`. */
export const BROKER_MARKET_TYPES = ["REGULER", "ALL", "NEGO", "TUNAI"] as const;
export type BrokerMarketType = (typeof BROKER_MARKET_TYPES)[number];

/** Sent as `INVESTOR_TYPE_` + the member. */
export const BROKER_INVESTOR_TYPES = ["ALL", "FOREIGN", "DOMESTIC"] as const;
export type BrokerInvestorType = (typeof BROKER_INVESTOR_TYPES)[number];

/**
 * Sort keys, sent as `SORT_BY_` + the member.
 *
 * Read out of Stockbit's bundle, and **partial**: `SELL_VALUE` appears with no `BUY_VALUE` beside
 * it, which is not a vocabulary a designer would have written, so at least one member is missing
 * from what was read. `sortBy` therefore accepts any `A-Z0-9_` token rather than only these — the
 * list documents what is known, it does not fence the caller out of a value we failed to read.
 */
export const BROKER_SORT_KEYS = [
  "TOTAL_VALUE",
  "NET_VALUE",
  "SELL_VALUE",
  "TOTAL_VOLUME",
  "TOTAL_FREQUENCY",
  "CODE",
  "NAME",
  "GROUP",
] as const;
export type BrokerSortKey = (typeof BROKER_SORT_KEYS)[number];

/* -------------------------------- validation -------------------------------- */

/**
 * A broker code, on its way into a QUERY parameter.
 *
 * The transport validates dynamic path *segments* and nothing else, and none of these three routes
 * carries the code as a segment — so the pattern from `SEGMENT_VALIDATORS.brokerCode` is repeated
 * here rather than reached for. Same charset, different door.
 */
const BROKER_CODE_RE = /^[A-Z0-9]{2,4}$/;

function normalizeBrokerCode(input: unknown): string {
  if (typeof input !== "string") {
    throw new StockbitError("invalid_param", "broker code must be a string");
  }
  const code = input.trim().toUpperCase();
  if (!BROKER_CODE_RE.test(code)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid broker code ${JSON.stringify(input)}: expected 2-4 uppercase letters or digits, e.g. YP`,
    );
  }
  return code;
}

/** An enum token on its way onto the wire. Anchored, so no separator can smuggle a second param in. */
const ENUM_TOKEN_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

function enumToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !ENUM_TOKEN_RE.test(value.trim().toUpperCase())) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${field} ${JSON.stringify(value)}: expected an uppercase token such as NET_VALUE`,
    );
  }
  return value.trim().toUpperCase();
}

/** A member of a closed list. Rejected here so a typo never reaches the wire as a silent default. */
function member<T extends readonly string[]>(list: T, value: unknown, field: string): T[number] {
  const token = enumToken(value, field);
  if (!(list as readonly string[]).includes(token)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${field} ${JSON.stringify(value)}: expected one of ${list.join(", ")}`,
    );
  }
  // The membership check above is what makes this cast true; TypeScript cannot see through
  // `includes` to narrow a widened string back to the tuple's union.
  return token as T[number];
}

/**
 * A pagination number. The ceiling is ours, not a measured server limit — it exists so a mistyped
 * `limit` becomes an error here instead of an enormous request there.
 */
const MAX_PAGE_SIZE = 1000;

function pageNumber(value: unknown, field: string, max = MAX_PAGE_SIZE): number {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > max) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${field} ${JSON.stringify(value)}: expected an integer between 1 and ${max}`,
    );
  }
  return n;
}

/** Drop empties, uppercase, validate against a closed list, and de-duplicate — order preserved. */
function tokenList<T extends readonly string[]>(
  list: T,
  values: readonly unknown[] | undefined,
  field: string,
): Array<T[number]> | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) {
    throw new StockbitError("invalid_param", `${field} must be an array of strings`);
  }
  const seen = values.map((v) => member(list, v, field));
  const unique = [...new Set(seen)];
  // An empty array must become an absent parameter, not `?market_type=`: a bare empty value is a
  // value, and this endpoint's whole failure mode is answering narrower questions confidently.
  return unique.length > 0 ? unique : undefined;
}

/* ------------------------------ envelope reading ------------------------------ */

type Row = Record<string, unknown>;

/**
 * Where the rows sat in the envelope.
 *
 * `from` is null when the response carried no array at all. That is deliberately NOT collapsed into
 * "zero rows": on a shape nobody has mapped, an empty list and a list this projection failed to
 * find look identical to a caller, and only one of them means "the broker traded nothing". Callers
 * get `rowsFrom` and `dataKeys` so the difference is visible in the tool output itself.
 */
interface Rowset {
  rows: Row[];
  from: string | null;
  dataKeys: string[];
}

/** Envelope keys that plausibly wrap the array, tried in order before falling back to any array. */
const ROW_CONTAINERS = [
  "result",
  "results",
  "list",
  "items",
  "rows",
  "brokers",
  "broker",
  "stocks",
  "activities",
  "data",
] as const;

const Envelope = z.object({ data: z.unknown() }).passthrough();
const RowArray = z.array(z.record(z.unknown()));

function readRows(body: unknown, context: string): Rowset {
  const { data } = parseOr(Envelope, body, context);
  if (data === null || data === undefined) return { rows: [], from: null, dataKeys: [] };
  if (Array.isArray(data)) {
    return { rows: parseOr(RowArray, data, `${context} rows`), from: "data", dataKeys: [] };
  }
  if (typeof data === "object") {
    const obj = data as Row;
    const dataKeys = Object.keys(obj);
    const key =
      ROW_CONTAINERS.find((k) => Array.isArray(obj[k])) ?? dataKeys.find((k) => Array.isArray(obj[k]));
    if (key === undefined) return { rows: [], from: null, dataKeys };
    return { rows: parseOr(RowArray, obj[key], `${context} rows`), from: key, dataKeys };
  }
  // A scalar under `data` is not a paging edge case; it is a different endpoint answering.
  throw new StockbitError(
    "schema_drift",
    `Unexpected ${context} response shape (data was ${typeof data}, expected an array or an object)`,
  );
}

/* ------------------------------- row projection ------------------------------- */

/** Which wire key each recognised field was read from. Empty when nothing was recognised. */
export interface ReadFrom {
  code?: string;
  name?: string;
  symbol?: string;
}

function pick(
  row: Row,
  candidates: readonly string[],
  accept: (value: string) => boolean,
): { value?: string; key?: string } {
  for (const key of candidates) {
    const raw = row[key];
    if (typeof raw === "string" && accept(raw.trim())) return { value: raw.trim(), key };
  }
  return {};
}

const CODE_KEYS = ["code", "broker_code", "netbs_broker_code", "broker"] as const;
const NAME_KEYS = ["name", "broker_name", "full_name", "company_name"] as const;
const SYMBOL_KEYS = ["symbol", "stock_code", "company_symbol", "code"] as const;

const isCode = (v: string): boolean => BROKER_CODE_RE.test(v);
const isName = (v: string): boolean => v.length > 0;
/** Same charset `src/symbol.ts` admits, checked without throwing — this is a guess, not an input. */
const isSymbolish = (v: string): boolean => /^[A-Z0-9]{1,12}(-[A-Z0-9]{1,4})?$/.test(v);

/**
 * How many rows nothing could be read from, plus the keys of the first one.
 *
 * The sample keys are the diagnostic that matters: if this projection is looking under the wrong
 * name, the right name is in that list and the fix is one line, without a second live probe.
 */
export interface Unmapped {
  count: number;
  sampleKeys: string[];
}

function unmappedOf(rows: Row[], mapped: Array<{ readFrom: ReadFrom }>, field: keyof ReadFrom): Unmapped {
  let count = 0;
  let sampleKeys: string[] = [];
  for (let i = 0; i < mapped.length; i++) {
    if (mapped[i].readFrom[field] === undefined) {
      count++;
      if (sampleKeys.length === 0) sampleKeys = Object.keys(rows[i]);
    }
  }
  return { count, sampleKeys };
}

/* -------------------------------- directory -------------------------------- */

export interface BrokerDirectoryEntry {
  /** The two-letter code, when a code-shaped value sat under a key this module recognises. */
  code?: string;
  name?: string;
  readFrom: ReadFrom;
  /** The whole row as it arrived. Nothing is dropped and nothing is renamed on a guess. */
  row: Row;
}

export interface BrokerDirectory {
  page: number;
  limit: number;
  count: number;
  /** Envelope key the rows were read from; null when the response carried no array. */
  rowsFrom: string | null;
  /** What `data` did carry when it was an object. Only interesting when `rowsFrom` is null. */
  dataKeys: string[];
  brokers: BrokerDirectoryEntry[];
  unmapped: Unmapped;
  /**
   * The codes asked for, echoed back — present only when `codes` was passed.
   *
   * Stated back for the reason `listShapes` states its filter back: a short list must read as
   * "filtered to this" and not as "the exchange has three brokers".
   */
  filteredTo?: string[];
  /**
   * Codes that were asked for and that no row ON THIS PAGE carried.
   *
   * Present only when `codes` was passed. An empty array is the good answer and is kept rather than
   * omitted, so "everything you asked for was found" is something the caller can READ instead of
   * having to infer it from a length comparison.
   *
   * "On this page", not "in the directory", and the distinction is load-bearing. The filter runs on
   * whatever `page`/`limit` fetched, and the default pair covers the whole exchange in one page —
   * but a caller who narrowed the page can land a real broker here purely because it sits on
   * another one. Two other causes are equally not "no such broker": the row may exist with its code
   * under a key this projection does not recognise (that is what `unmapped` counts), or the
   * exchange may genuinely not list it. This field cannot tell them apart, so it does not try.
   */
  notFound?: string[];
}

export interface BrokerDirectoryOptions {
  page?: unknown;
  limit?: unknown;
  /**
   * Keep only these broker codes.
   *
   * Filtered HERE, after the response, because the route has never been observed accepting a code
   * parameter and inventing one would be a guess on the wire. That costs nothing: one page at the
   * default limit covers the whole exchange, the fetch is cached, and the filter runs on the cached
   * copy — so asking for two codes and asking for the whole directory are the same single request.
   */
  codes?: unknown;
}

/**
 * The broker directory: every IDX broker code with the house behind it.
 *
 * Both parameters are always sent. Stockbit's own client asks for page 1, limit 150, and one page
 * that size covers the whole exchange — so the defaults are that pair rather than the server's,
 * which is not known and would make the result depend on an unobserved decision.
 *
 * Cached for `keystatsTtlMs`: the membership list changes when a securities house is licensed or
 * renamed, which is not a thing that happens during a session.
 */
export async function getBrokerDirectory(opts: BrokerDirectoryOptions = {}): Promise<BrokerDirectory> {
  const page = opts.page === undefined ? 1 : pageNumber(opts.page, "page");
  const limit = opts.limit === undefined ? 150 : pageNumber(opts.limit, "limit");
  // Validated before the request, so a typo is refused rather than silently matching nothing and
  // reading as "that broker does not exist".
  const wanted = opts.codes === undefined ? null : normalizeCodeFilter(opts.codes);

  const full = await cached(`brokers:directory:${page}:${limit}`, CACHE.keystatsTtlMs, async () => {
    const body = await getJson("brokerDirectory", { params: { page, limit } });
    const { rows, from, dataKeys } = readRows(body, "broker directory");
    const brokers = rows.map((row) => {
      const code = pick(row, CODE_KEYS, isCode);
      const name = pick(row, NAME_KEYS, isName);
      return {
        code: code.value,
        name: name.value,
        readFrom: { code: code.key, name: name.key },
        row,
      };
    });
    return {
      page,
      limit,
      count: brokers.length,
      rowsFrom: from,
      dataKeys,
      brokers,
      unmapped: unmappedOf(rows, brokers, "code"),
    };
  });

  if (!wanted) return full;

  // A NEW object, never a mutation: `full` is the shared cache entry, and trimming its `brokers`
  // in place would hand every later caller of that entry the filter this one asked for. The same
  // trap `getBandarDetector` documents when it sorts.
  const keep = new Set(wanted);
  const brokers = full.brokers.filter((b) => b.code !== undefined && keep.has(b.code));
  const found = new Set(brokers.map((b) => b.code));
  return {
    ...full,
    count: brokers.length,
    brokers,
    filteredTo: wanted,
    notFound: wanted.filter((code) => !found.has(code)),
  };
}

/** What a name resolution did, for a caller that has to know whether a blank is a gap or a failure. */
export interface NameResolution {
  /** True when the directory was read. Rows may still lack a name; that is a gap, not a failure. */
  resolved: boolean;
  /** Why no name was attached, when none was. Absent on success. */
  note?: string;
}

/**
 * Attach securities-house names to rows carrying bare broker codes.
 *
 * `broker_summary` and `bandar_detector` answer in codes — `AK`, `XL`, `YP` — and the directory
 * that decodes them is a different route, so every consumer was writing the same join by hand. This
 * is that join, once, on the directory's own five-minute cache: for a caller that has already
 * listed the directory it costs no request at all.
 *
 * **Best-effort, by construction.** A tool whose job is reporting flow must not fail because a
 * lookup table could not be fetched — the numbers are the answer and the names are a convenience.
 * When the directory cannot be read the rows come back exactly as they went in, `resolved` is
 * false, and `note` says so. A code the directory does not carry simply gets no name: absent is
 * absent, and a house nobody can name is not a house called "unknown".
 */
export async function withBrokerNames<T extends { code: string; name?: string }>(
  rows: readonly T[],
): Promise<{ rows: T[]; resolution: NameResolution }> {
  const [resolved] = await withBrokerNamesAll([rows]);
  return resolved;
}

/**
 * The same join over several row-sets at once, sharing ONE directory read.
 *
 * A broker summary has two sides, and resolving them with two calls meant two attempts at the
 * directory. That is invisible when it succeeds — the second is a cache hit — and doubles the
 * damage when it fails: two failed requests, and two identical notes of which the caller keeps one.
 */
export async function withBrokerNamesAll<T extends { code: string; name?: string }>(
  sets: ReadonlyArray<readonly T[]>,
): Promise<Array<{ rows: T[]; resolution: NameResolution }>> {
  let directory: BrokerDirectory;
  try {
    directory = await getBrokerDirectory();
  } catch (err) {
    // The KIND only. A fetch failure quotes its URL, and a note is not worth widening what this
    // server is willing to write down.
    const why = err instanceof StockbitError ? err.kind : "unreadable";
    const resolution: NameResolution = {
      resolved: false,
      note:
        `Broker names were not resolved (${why}): the directory could not be read. ` +
        "The codes and every figure beside them are unaffected.",
    };
    return sets.map((rows) => ({ rows: [...rows], resolution }));
  }

  const byCode = new Map<string, string>();
  for (const entry of directory.brokers) {
    if (entry.code !== undefined && entry.name !== undefined) byCode.set(entry.code, entry.name);
  }
  // The two sides of this join do NOT arrive normalized the same way. A directory code has passed
  // `isCode` (`/^[A-Z0-9]{2,4}$/`), so every key in the map is already upper case — but a summary
  // row's `code` is `netbs_broker_code` straight off the wire (src/core/marketdetectors.ts), never
  // trimmed and never upper-cased. Joining on the raw value would drop the name for any row the
  // wire happened to send in lower case, and drop it SILENTLY: the row would look exactly like a
  // broker the directory has never heard of.
  return sets.map((rows) => ({
    rows: rows.map((row) => {
      const name = byCode.get(String(row.code).trim().toUpperCase());
      return name === undefined ? { ...row } : { ...row, name };
    }),
    resolution: { resolved: true } as NameResolution,
  }));
}

/**
 * The `codes` filter, normalized and checked.
 *
 * Deduplicated so asking twice cannot report a code as both found and not found, and order is the
 * caller's — the answer reads back in the order the question was asked.
 */
function normalizeCodeFilter(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new StockbitError("invalid_param", "codes must be an array of broker codes, e.g. [\"AK\", \"XL\"]");
  }
  if (input.length === 0) {
    // An empty list is refused rather than treated as "no filter": the two readings are opposite
    // (everything, or nothing), and guessing which was meant is how a caller ends up with the whole
    // exchange when they asked for none of it.
    throw new StockbitError("invalid_param", "codes was an empty array — omit it to get the whole directory");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const code = normalizeBrokerCode(raw);
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

/* --------------------------------- activity --------------------------------- */

export interface BrokerActivityRow {
  /** The traded ticker, when a symbol-shaped value sat under a key this module recognises. */
  symbol?: string;
  readFrom: ReadFrom;
  /**
   * The whole row. The buy/sell/net figures live in here under names that have not been observed,
   * so they are deliberately not renamed: a projected `netValueIdr` read out of the wrong key would
   * be a confident number pointing the wrong way.
   */
  row: Row;
}

export interface BrokerActivity {
  brokerCode: string;
  /** Exactly what went onto the wire, so the window and filters that produced these rows are visible. */
  request: Record<string, string | number | readonly string[]>;
  count: number;
  rowsFrom: string | null;
  dataKeys: string[];
  rows: BrokerActivityRow[];
  unmapped: Unmapped;
}

export interface BrokerActivityOptions {
  brokerCode: unknown;
  period?: unknown;
  /** Boards to include. REPEATED on the wire, one `market_type` per value. */
  marketTypes?: readonly unknown[];
  /** Investor classes to include. REPEATED on the wire, one `investor_type` per value. */
  investorTypes?: readonly unknown[];
  sortBy?: unknown;
  page?: unknown;
  limit?: unknown;
}

type WireParams = Record<string, string | number | readonly string[] | undefined>;

/**
 * Build the activity query.
 *
 * `market_type` and `investor_type` go out as ARRAYS, which the transport appends one key at a time
 * (`?market_type=A&market_type=B`). Comma-joining them is the trap this whole route is annotated
 * for: the server reads the joined string as a single value, finds no board by that name, and
 * answers 200 with a narrower result instead of an error. `test/brokers.test.ts` asserts the
 * repetition on the URL that was actually sent and that no `%2C` appears in it.
 *
 * Every filter is omitted when the caller omits it. Nothing here defaults to a value: a default
 * this project invented would decide the window and the boards on the caller's behalf, and on a
 * route nobody has probed it could equally well be a value the server rejects.
 *
 * Exported so the shape can be asserted without a network round-trip.
 */
export function buildActivityParams(opts: BrokerActivityOptions): WireParams {
  const period = opts.period === undefined ? undefined : member(BROKER_PERIODS, opts.period, "period");
  const markets = tokenList(BROKER_MARKET_TYPES, opts.marketTypes, "market_type");
  const investors = tokenList(BROKER_INVESTOR_TYPES, opts.investorTypes, "investor_type");
  return {
    broker_code: normalizeBrokerCode(opts.brokerCode),
    period: period === undefined ? undefined : `TB_PERIOD_${period}`,
    market_type: markets?.map((m) => `MARKET_TYPE_${m}`),
    investor_type: investors?.map((i) => `INVESTOR_TYPE_${i}`),
    sort_by: opts.sortBy === undefined ? undefined : `SORT_BY_${enumToken(opts.sortBy, "sort_by")}`,
    page: opts.page === undefined ? undefined : pageNumber(opts.page, "page"),
    limit: opts.limit === undefined ? undefined : pageNumber(opts.limit, "limit"),
  };
}

/** Drop the absent parameters, for the cache key and for the `request` echo. */
function sent(params: WireParams): Record<string, string | number | readonly string[]> {
  const out: Record<string, string | number | readonly string[]> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Which stocks one broker traded, and how much of each.
 *
 * The reverse of `broker_summary`: that one fixes a stock and lists brokers, this one fixes a
 * broker and lists stocks. Two calls chain into the question neither answers alone — find today's
 * biggest net seller of a stock, then ask what else that broker was distributing.
 *
 * The cache key is the full parameter set, so a different window, a different board list or a
 * different page is a different entry. Keying on the broker code alone would serve one broker's
 * REGULER week in answer to a question about their ALL-board day.
 */
export async function getBrokerActivity(opts: BrokerActivityOptions): Promise<BrokerActivity> {
  const params = buildActivityParams(opts);
  const request = sent(params);

  return cached(`brokers:activity:${JSON.stringify(request)}`, CACHE.brokerSummaryTtlMs, async () => {
    const body = await getJson("brokerActivity", { params });
    const { rows, from, dataKeys } = readRows(body, "broker activity");
    const mapped = rows.map((row) => {
      const symbol = pick(row, SYMBOL_KEYS, isSymbolish);
      return { symbol: symbol.value, readFrom: { symbol: symbol.key }, row };
    });
    return {
      brokerCode: String(params.broker_code),
      request,
      count: mapped.length,
      rowsFrom: from,
      dataKeys,
      rows: mapped,
      unmapped: unmappedOf(rows, mapped, "symbol"),
    };
  });
}

/* ----------------------------------- top ----------------------------------- */

export interface BrokerTopRow {
  code?: string;
  name?: string;
  readFrom: ReadFrom;
  /** The whole row: the value/volume/frequency figures are in here under unobserved names. */
  row: Row;
}

export interface BrokerTop {
  request: Record<string, string | number | readonly string[]>;
  count: number;
  rowsFrom: string | null;
  dataKeys: string[];
  brokers: BrokerTopRow[];
  unmapped: Unmapped;
}

export interface BrokerTopOptions {
  period?: unknown;
  sortBy?: unknown;
  page?: unknown;
  limit?: unknown;
}

/**
 * The market-wide broker league table: who moved the most, across every stock.
 *
 * Deliberately narrower than `getBrokerActivity`. The repeated `market_type` / `investor_type`
 * parameters are documented for the activity route and only for it, so they are not sent here —
 * a filter this endpoint ignores would silently widen the answer, and one it rejects would 400 a
 * call that had no need to carry it.
 */
export async function getBrokerTop(opts: BrokerTopOptions = {}): Promise<BrokerTop> {
  const period = opts.period === undefined ? undefined : member(BROKER_PERIODS, opts.period, "period");
  const params: WireParams = {
    period: period === undefined ? undefined : `TB_PERIOD_${period}`,
    sort_by: opts.sortBy === undefined ? undefined : `SORT_BY_${enumToken(opts.sortBy, "sort_by")}`,
    page: opts.page === undefined ? undefined : pageNumber(opts.page, "page"),
    limit: opts.limit === undefined ? undefined : pageNumber(opts.limit, "limit"),
  };
  const request = sent(params);

  return cached(`brokers:top:${JSON.stringify(request)}`, CACHE.brokerSummaryTtlMs, async () => {
    const body = await getJson("brokerTop", { params });
    const { rows, from, dataKeys } = readRows(body, "top brokers");
    const brokers = rows.map((row) => {
      const code = pick(row, CODE_KEYS, isCode);
      const name = pick(row, NAME_KEYS, isName);
      return { code: code.value, name: name.value, readFrom: { code: code.key, name: name.key }, row };
    });
    return {
      request,
      count: brokers.length,
      rowsFrom: from,
      dataKeys,
      brokers,
      unmapped: unmappedOf(rows, brokers, "code"),
    };
  });
}

/* ------------------------------ bandar detector ------------------------------ */

/**
 * How concentrated each side of the table is.
 *
 * Every share is `null` rather than `0` when its denominator is zero. A share of 0 says "the top
 * broker took none of it"; when there is nothing to take a share of, the truth is that the question
 * cannot be asked, and a reader acting on a 0 would conclude the flow was evenly spread.
 *
 * A denominator is zero in two different situations and `null` does not distinguish them: the side
 * was empty, or every figure on it was unreadable. `sellersListed` tells them apart — a null share
 * beside a non-zero count means the rows were there and their numbers were not.
 */
export interface BandarConcentration {
  /** The largest accumulator's share of all listed net buy value, 0-1. */
  topBuyerShare: number | null;
  /** The top three accumulators' combined share, 0-1. */
  top3BuyerShare: number | null;
  topSellerShare: number | null;
  top3SellerShare: number | null;
  /**
   * Herfindahl index over each side, 0-1: the sum of squared shares. 1 is one broker doing all of
   * it; 0.1 is roughly ten brokers of equal size. A blunter instrument than it looks — see the note
   * on `getBandarDetector` about what broker concentration does not prove.
   */
  buyHerfindahl: number | null;
  sellHerfindahl: number | null;
  /** How many brokers the summary returned per side, before `top` trimmed the two lists. */
  buyersListed: number;
  sellersListed: number;
}

export interface BandarReading {
  symbol: string;
  /** The window the summary actually covered, as the server reported it. */
  from?: string;
  to?: string;
  /** Sum of the listed brokers' net BUY value, IDR. Positive. */
  buyValueIdr: number;
  /**
   * Sum of the listed brokers' net SELL value, IDR.
   *
   * NEGATIVE, because the wire signs the sell side that way and this server does not launder it.
   * See the sign note at the top of `src/core/marketdetectors.ts`.
   */
  sellValueIdr: number;
  /**
   * `buyValueIdr` minus the MAGNITUDE of `sellValueIdr` — how lopsided the two sides are.
   *
   * The magnitude is taken rather than the raw value so the reading stays right whichever way the
   * wire signs the sell side, which is the exact assumption that was wrong before. With today's
   * negative sells it is simply `buyValueIdr + sellValueIdr`. It assumes each side is signed
   * CONSISTENTLY; a side carrying both signs at once is not something this wire produces and is not
   * modelled here.
   *
   * Near zero means the two lists describe the same trades from opposite ends, which is what a
   * complete NET table looks like. A large magnitude means the sides do NOT cover the same trades —
   * usually the table was truncated by `limit`, sometimes the request was GROSS.
   *
   * `limit` applies PER SIDE, so equal list lengths prove nothing: when both sides overflow, both
   * come back at exactly `limit`. A count that has reached `limit` is the signal; raise it and see
   * whether the totals move. The captured BBRI fixture is the cautionary case in the other
   * direction — its sell side is truncated 25 of 48 while the net is under 2% of the buy side, so a
   * small net does not prove completeness either.
   *
   * It is a coverage reading, not a verdict on the stock; the per-side totals are the quantities to
   * reason about.
   */
  netValueIdr: number;
  buyLots: number;
  /** Negative, like `sellValueIdr`. */
  sellLots: number;
  /** `buyLots` minus the magnitude of `sellLots`, on the same reasoning as `netValueIdr`. */
  netLots: number;
  /** Largest net buyers first, by size of flow. */
  topAccumulators: NormalizedBroker[];
  /** Largest net sellers first, by size of flow — the biggest distributor is element 0. */
  topDistributors: NormalizedBroker[];
  concentration: BandarConcentration;
  /**
   * Which brokers are missing from which total, passed through from the summary.
   *
   * `buyers` / `sellers` count LISTED brokers whose own side's flow figure did not yield a number.
   * They are excluded from that side's totals and from its concentration denominator rather than
   * counted as zero — so `buyers: 1` against `concentration.buyersListed: 16` means every buy
   * figure above is over 15 brokers. `keys` names the wire keys involved, including decorative ones
   * that move neither count. Absent when everything parsed.
   */
  unreadable?: { buyers: number; sellers: number; keys: string[] };
  /**
   * Stockbit's own `bandar_detector` block, passed through untouched. Its shape has not been
   * mapped, so it is neither parsed nor dropped.
   */
  stockbitBandarDetector?: Record<string, unknown>;
}

export interface BandarDetectorOptions extends BrokerSummaryOptions {
  /** How many brokers to keep per side. Default 5, maximum 50. */
  top?: unknown;
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * Every concentration figure is computed on MAGNITUDES.
 *
 * The sell side arrives negative, so a share taken on raw values divides by a negative total and
 * `shareOf` answers `null` for every real stock on the exchange — which the tool description then
 * reports to the model as "nothing traded on that side". `src/analysis/analyze.ts` already takes
 * magnitudes for the same reason.
 */
function shareOf(part: number, total: number): number | null {
  return total > 0 ? part / total : null;
}

function herfindahl(values: number[], total: number): number | null {
  if (total <= 0) return null;
  return sum(values.map((v) => (v / total) ** 2));
}

/**
 * A typed accumulation/distribution reading for one symbol.
 *
 * Runs entirely on `getBrokerSummary` — same request, same cache entry, no second round-trip — and
 * turns its two lists into named quantities: totals per side, the top accumulators and
 * distributors, and how concentrated each side is.
 *
 * ## What this does not prove
 *
 * Broker flow is not identity. A broker code is a pipe, not a person:
 *
 *   - One broker carries thousands of clients. "YP accumulated 40% of today's net buying" means
 *     YP's clients did, and they are not one client with one intention. A retail-heavy house looks
 *     like a whale on any day retail agrees with itself.
 *   - The same beneficial owner can spread orders across several brokers precisely so this reading
 *     shows nothing. Concentration can therefore be low *because* someone is accumulating.
 *   - A single session says very little. Institutions build over weeks; one day of net buying is
 *     inside the noise of ordinary two-way flow. Ask for a window (`period`, or `from`/`to`) before
 *     reading anything into it.
 *   - Net flow is not a price forecast, and this returns no verdict, score or direction. Nothing
 *     here distinguishes accumulation from a client rotating between accounts, a market maker
 *     hedging, an index fund tracking a reweight, or a block crossed by prior agreement.
 *
 * The board matters too: the default REGULER excludes negotiated blocks, and switching to ALL can
 * multiply the numbers several times over. That choice belongs to the caller and is passed straight
 * through to the summary.
 */
export async function getBandarDetector(opts: BandarDetectorOptions): Promise<BandarReading> {
  const top = opts.top === undefined ? 5 : pageNumber(opts.top, "top", 50);
  const summary = await getBrokerSummary(opts);

  // Ranked by SIZE OF FLOW, not by signed value. The wire sends the sell side negative, so a plain
  // descending sort puts the *smallest* seller at the top of a list labelled "largest net sellers
  // first" — which is precisely what this tool used to return. Magnitude ranks both sides the same
  // way and cannot be inverted by a sign.
  //
  // Copied before sorting. `getBrokerSummary` hands back a CACHED object, and sorting its arrays in
  // place would reorder what every later caller of that cache entry sees.
  const magnitude = (b: NormalizedBroker): number => Math.abs(b.netValueIdr ?? 0);
  const lotMagnitude = (b: NormalizedBroker): number => Math.abs(b.netLots ?? 0);
  const byFlow = (a: NormalizedBroker, b: NormalizedBroker): number =>
    magnitude(b) - magnitude(a) || lotMagnitude(b) - lotMagnitude(a);
  const buyers = [...summary.buyers].sort(byFlow);
  const sellers = [...summary.sellers].sort(byFlow);

  // A row whose figure could not be read is left out of every total and every denominator rather
  // than counted as zero. `summary.unreadable` is what says so out loud.
  const readable = (values: Array<number | undefined>): number[] =>
    values.filter((v): v is number => v !== undefined);

  const buyValues = readable(buyers.map((b) => b.netValueIdr));
  const sellValues = readable(sellers.map((s) => s.netValueIdr));
  const buyValueIdr = sum(buyValues);
  const sellValueIdr = sum(sellValues);
  const buyLots = sum(readable(buyers.map((b) => b.netLots)));
  const sellLots = sum(readable(sellers.map((s) => s.netLots)));

  // Shares and Herfindahls run on magnitudes; see the note on `shareOf`.
  const buyMagnitudes = buyValues.map(Math.abs);
  const sellMagnitudes = sellValues.map(Math.abs);
  const buyTotal = sum(buyMagnitudes);
  const sellTotal = sum(sellMagnitudes);

  const top3 = (values: number[]): number => sum(values.slice(0, 3));

  return {
    symbol: summary.symbol,
    from: summary.from,
    to: summary.to,
    buyValueIdr,
    sellValueIdr,
    netValueIdr: buyValueIdr - Math.abs(sellValueIdr),
    buyLots,
    sellLots,
    netLots: buyLots - Math.abs(sellLots),
    topAccumulators: buyers.slice(0, top),
    topDistributors: sellers.slice(0, top),
    concentration: {
      topBuyerShare: shareOf(buyMagnitudes[0] ?? 0, buyTotal),
      top3BuyerShare: shareOf(top3(buyMagnitudes), buyTotal),
      topSellerShare: shareOf(sellMagnitudes[0] ?? 0, sellTotal),
      top3SellerShare: shareOf(top3(sellMagnitudes), sellTotal),
      buyHerfindahl: herfindahl(buyMagnitudes, buyTotal),
      sellHerfindahl: herfindahl(sellMagnitudes, sellTotal),
      buyersListed: buyers.length,
      sellersListed: sellers.length,
    },
    ...(summary.unreadable ? { unreadable: summary.unreadable } : {}),
    stockbitBandarDetector: summary.bandarDetector,
  };
}
