/**
 * The broker family: the directory that gives every two-letter code a name, the reverse lookup of
 * broker summary (which stocks one broker traded), the market-wide league table, and a typed
 * accumulation/distribution reading built on the broker summary this project already has.
 *
 *   GET /findata-view/marketdetectors/brokers   page, limit
 *   GET /order-trade/broker/activity            one broker's stocks; REPEATED market/investor types
 *   GET /order-trade/broker/top                 the league table
 *
 * ## What has been seen, and what has not
 *
 * All three routes have now answered live. What that settled differs per route, and the difference
 * is what shapes every projection below.
 *
 * `brokerTop`'s ROW SHAPE was measured on 2026-09-01 — ten keys, every figure a plain numeric
 * string — so its rows ARE projected into named fields. Its two behaviours were measured too, and
 * both are wrong in a way a caller cannot see from the outside: it sorts ASCENDING by
 * `total_value`, and it ignores `limit`. `getBrokerTop` fixes both locally and says so in the
 * result, because a correction the caller cannot see is its own kind of silence.
 *
 * `brokerActivity` answered, and its ENVELOPE was measured — `broker_activity_transaction`, `from`,
 * `to`, `broker_code`, `broker_name` — but the names inside its rows were not recorded. Its
 * `period` parameter is refused outright; see `buildActivityParams` for the control that settles it.
 *
 * Where a shape is still unknown the old discipline holds: envelopes are permissive, `data` is
 * accepted as an array or as an object wrapping one, and no row field is renamed on a guess. Each
 * row is returned whole under `row`, with the fields this module is willing to claim it recognised
 * sitting beside it and `readFrom` naming the wire key each was read from. A wrong guess therefore
 * shows up as `code: undefined` next to a visible raw row, never as a confident wrong value and
 * never as a key that is always undefined.
 *
 * `bandar_detector` is the exception: it runs on `getBrokerSummary`, whose response shape was
 * measured, so it projects into named fields with no hedging.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { isSettledRange, normalizeDateRange, type DateRange, type DateRangeInput } from "./dates.js";
import { wibTodayIso } from "./sessionclock.js";
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
  /**
   * `data` itself, when it was an object.
   *
   * These envelopes carry provenance BESIDE the rows — `brokerActivity` puts the window it
   * aggregated over in `from`/`to`, `brokerTop` puts the session in `date` — and the projection
   * used to read the array out and drop everything around it. A window the endpoint volunteers and
   * the tool throws away is a window the caller then has to guess at.
   */
  dataObject: Row | null;
}

/**
 * Envelope keys that plausibly wrap the array, tried in order before falling back to any array.
 *
 * `broker_activity_transaction` leads because it is the only member here that was MEASURED rather
 * than guessed: a `brokerActivity` call with no `period` (2026-09-01) answered
 * `data = {broker_activity_transaction, from, to, broker_code, broker_name}`. The rest remain
 * plausible names for shapes nobody has seen, and a measured container must win over a guess if a
 * response ever carries both.
 */
const ROW_CONTAINERS = [
  "broker_activity_transaction",
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
  if (data === null || data === undefined) return { rows: [], from: null, dataKeys: [], dataObject: null };
  if (Array.isArray(data)) {
    return {
      rows: parseOr(RowArray, data, `${context} rows`),
      from: "data",
      dataKeys: [],
      // A bare array carries no provenance beside itself. Null, not `{}`: "there was nothing to
      // read it from" and "it was there and empty" are different answers.
      dataObject: null,
    };
  }
  if (typeof data === "object") {
    const obj = data as Row;
    const dataKeys = Object.keys(obj);
    const key =
      ROW_CONTAINERS.find((k) => Array.isArray(obj[k])) ?? dataKeys.find((k) => Array.isArray(obj[k]));
    if (key === undefined) return { rows: [], from: null, dataKeys, dataObject: obj };
    return {
      rows: parseOr(RowArray, obj[key], `${context} rows`),
      from: key,
      dataKeys,
      dataObject: obj,
    };
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
 * A number off the broker wire, or `undefined`.
 *
 * The same pattern and the same refusals as `asBrokerNumber` in `src/core/marketdetectors.ts`, and
 * for the same two reasons: a separated number ("1,234" / "1.234,56") is REFUSED rather than
 * guessed at, because the two Indonesian conventions disagree about which separator is the decimal
 * one; and E-notation is admitted, because this API sends it.
 *
 * It is duplicated rather than imported because that one is not exported and this one reads a
 * different service's rows — `brokerTop` sends `total_value` as a PLAIN numeric string
 * (`"5636360451396"`), not the `{raw, formatted}` pair most of this API uses.
 *
 * `undefined` on anything else, including on a number that arrived as a JSON number: every figure
 * measured on these routes is a string, so a bare number is a shape change worth seeing as absent
 * rather than silently absorbing.
 */
const WIRE_NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function asWireNumber(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!WIRE_NUMBER_RE.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** A non-empty string off the envelope, or `undefined`. Empty means "no value here", not "". */
function asWireString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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
    const note =
      `Broker names were not resolved (${why}): the directory could not be read. ` +
      "The codes and every figure beside them are unaffected.";
    // A fresh `resolution` per set, not one shared reference. Nothing mutates it today, but a
    // caller that annotated one side's resolution would silently annotate every side's.
    return sets.map((rows) => ({ rows: [...rows], resolution: { resolved: false, note } }));
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

/**
 * Which container name means which side. Recognising a name is how the SIDE is known; it is not how
 * the ROWS are found — see `activityRows`, which finds them structurally.
 */
const ACTIVITY_SIDE_KEYS: Readonly<Record<string, BrokerActivitySide>> = {
  brokers_buy: "buy",
  brokers_sell: "sell",
};

/**
 * The rows of a broker-activity response, from BOTH sides.
 *
 * ## Why this route needs its own reader
 *
 * `readRows` finds a container by looking for an ARRAY. This route does not have one: measured
 * 2026-09-01, `data.broker_activity_transaction` is an OBJECT holding `brokers_buy` and
 * `brokers_sell`, each an array. So the array search fell through to `dataKeys.find`, found nothing
 * either, and returned `rows: []` with `rowsFrom: null` — for a response carrying 868 buy rows and
 * 836 sell rows. Naming `broker_activity_transaction` in `ROW_CONTAINERS` could never have fixed
 * that, because the finder tests `Array.isArray` and the value is an object.
 *
 * That is the same defect `bucketsOf` was written for on the day calendar, and it is answered the
 * same way: a shape-aware reader that runs AHEAD of the generic one on the single route that needs
 * it, tagging every row with the container it came from.
 *
 * ## Why the side is a field and not a sign
 *
 * Both sides send POSITIVE values. A sell row is not a negative buy row, and nothing inside a row
 * says which half it came from — so dropping the container name would make the two indistinguishable
 * and a net figure computed from them meaningless. `side` is therefore required on every row.
 *
 * Returns `null` when the payload is not this shape, so the caller can fall back to `readRows` and
 * an unrecognised response still reports honestly rather than throwing.
 */
function activityRows(
  data: unknown,
): { rows: Array<{ row: Row; side?: BrokerActivitySide }>; from: string } | null {
  if (!isRecordLike(data)) return null;
  const container = (data as Row).broker_activity_transaction;
  if (!isRecordLike(container)) return null;

  // STRUCTURAL, like `bucketsOf`: every array-of-records inside the container contributes its rows,
  // whether or not this module knows the name. Filtering to the two names it does know would make a
  // renamed half — or a third one — vanish with no signal at all, since `dataKeys` lists `data`'s
  // top-level keys and would still show only the container. That silent under-count is the exact
  // defect this route was just fixed for, and hard-coding the names would reintroduce it one level
  // down.
  const present = Object.entries(container as Row).filter(
    (entry): entry is [string, Row[]] => Array.isArray(entry[1]) && entry[1].every((v) => isRecordLike(v)),
  );
  if (present.length === 0) return null;

  const rows: Array<{ row: Row; side?: BrokerActivitySide }> = [];
  for (const [key, value] of present) {
    // A name this module does not know yields rows with NO side, rather than a guessed one.
    const side = Object.hasOwn(ACTIVITY_SIDE_KEYS, key) ? ACTIVITY_SIDE_KEYS[key] : undefined;
    for (const row of parseOr(RowArray, value, `broker activity ${key} rows`)) {
      rows.push(side === undefined ? { row } : { row, side });
    }
  }
  // Names every container that contributed, even an empty one, so "this broker only bought" is
  // distinguishable from "the sell half was not in the payload".
  return { rows, from: `data.broker_activity_transaction.{${present.map(([key]) => key).join(",")}}` };
}

function isRecordLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A number off the broker-ACTIVITY wire, which is not the same wire as the rest of this module.
 *
 * `asWireNumber` refuses a JSON number on purpose, and says why: every figure measured on
 * `brokerTop` is a numeric STRING, so a bare number there is a shape change worth seeing as absent.
 * That reasoning is sound and is left alone — but it does not describe this route. Measured
 * 2026-09-01, `broker_activity` sends `value: 86170933300`, `lot: 4264563`,
 * `avg_price: 202.06275132997214` and `freq: 4848` as real JSON numbers, so reading them with
 * `asWireNumber` returned `undefined` for every one and the rows came back with a symbol and
 * nothing else.
 *
 * So this accepts a finite JSON number, and the same unambiguous numeric string `asWireNumber`
 * takes, and still refuses a separated one ("1,234" / "1.234,56") for the reason that one gives:
 * the two Indonesian conventions disagree about which separator is the decimal.
 */
function asActivityNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  return asWireNumber(value);
}

/** `figure`, for the one route whose figures arrive as JSON numbers. */
function activityFigure(row: Row, key: string): { value?: number; key?: string } {
  const value = asActivityNumber(row[key]);
  return value === undefined ? {} : { value, key };
}

/**
 * Preset windows for `broker_activity`, resolved HERE into `from`/`to` and never sent as a name.
 *
 * ## Why these are resolved locally
 *
 * Measured 2026-09-01: this endpoint answers **400** to `period` on every one of the ten
 * `BROKER_PERIODS` members and to eight other spellings, while `tb_period`, `periode`, `range` and
 * `time_period` answer 200 and are ignored — so the service silently drops keys it does not know,
 * and the 400 is a recognised field refusing a value. There is no spelling left to find, and that
 * was where the previous investigation stopped.
 *
 * What it never tried is the form this route actually takes. Measured the same way on 2026-09-01,
 * `from`/`to` **bind**: `from=2026-08-17&to=2026-08-21` came back with `data.from`/`data.to` echoing
 * those exact dates, 1034 buy rows instead of the default 868, and rows whose own `date` fields sat
 * inside the window. A second window moved it again. So the window is choosable after all — by date
 * pair rather than by name — and a caller who wants "the last week" can have it.
 *
 * ## Why a local calendar window is honest here
 *
 * These are THIS SERVER's definitions, not Stockbit's, and the difference was measured rather than
 * waved at. Asking `broker_summary` — which resolves the same names server-side and echoes the
 * result — gave `LAST_7_DAYS` → 2026-08-26..2026-09-01 and `LAST_3_MONTHS` → 2026-06-01..2026-09-01,
 * which the arithmetic below reproduces exactly. `YEAR_TO_DATE` it resolved to 2026-01-**02**, the
 * first trading day, where this resolves to January 1st.
 *
 * That one-day difference cannot change a figure, and that is measured too: `from=2026-08-15`
 * (a Saturday) and `from=2026-08-17` (the Monday) returned byte-identical rows. Padding a window
 * with days the exchange was shut adds no trades. Computing the first TRADING day instead would
 * need a holiday table, which this project refuses to hard-code for the reason `sessionclock.ts`
 * gives — it goes stale and then lies with confidence.
 *
 * Either way the caller never has to trust the arithmetic: the resolved window goes onto the wire
 * and the server echoes it back into `from`/`to` on the result.
 */
export const ACTIVITY_PERIODS = [
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

export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

/** Days before or after a `YYYY-MM-DD`, in UTC so the host's zone cannot move a day. */
function shiftDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Months before a `YYYY-MM-DD`, CLAMPED to the target month's last day.
 *
 * `Date.UTC(2026, 1, 31)` is not 31 February, it is 3 March — the constructor rolls over. Used
 * naively for a window START that silently loses the first days of the month: "one month before
 * 31 March" would begin on 3 March and quietly drop the 1st and 2nd. Clamping to 28 February is
 * both the conventional reading and the one that cannot lose a session.
 */
function shiftMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  // Day 0 of the following month is the last day of the target one.
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Resolve a preset window against a WIB "today". Exported so the arithmetic is testable offline. */
export function resolveActivityPeriod(period: ActivityPeriod, today: string): DateRange {
  switch (period) {
    case "LAST_1_DAY":
      return { from: today, to: today };
    case "LAST_7_DAYS":
      // today-6, inclusive of both ends, which is the seven days Stockbit itself returned.
      return { from: shiftDays(today, -6), to: today };
    case "LAST_1_MONTH":
      return { from: shiftMonths(today, -1), to: today };
    case "LAST_3_MONTHS":
      return { from: shiftMonths(today, -3), to: today };
    case "LAST_6_MONTHS":
      return { from: shiftMonths(today, -6), to: today };
    case "LAST_1_YEAR":
      return { from: shiftMonths(today, -12), to: today };
    case "PREVIOUS_DAY": {
      // The previous CALENDAR day, which on a Monday is a Sunday and carries no trades. Named for
      // what it does rather than "the previous session": finding that needs a holiday table.
      const yesterday = shiftDays(today, -1);
      return { from: yesterday, to: yesterday };
    }
    case "PREVIOUS_MONTH": {
      const firstOfThis = `${today.slice(0, 7)}-01`;
      const lastOfPrev = shiftDays(firstOfThis, -1);
      return { from: `${lastOfPrev.slice(0, 7)}-01`, to: lastOfPrev };
    }
    case "THIS_MONTH":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "YEAR_TO_DATE":
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

/** Which half of the response a row came out of. Never inferred from a sign — see `activityRows`. */
export type BrokerActivitySide = "buy" | "sell";

/** Which wire key each of this route's figures was read from. */
export interface BrokerActivityReadFrom extends ReadFrom {
  date?: string;
  value?: string;
  lot?: string;
  avgPrice?: string;
  freq?: string;
  investorType?: string;
}

export interface BrokerActivityRow {
  /** The traded ticker, when a symbol-shaped value sat under a key this module recognises. */
  symbol?: string;
  /**
   * `buy` or `sell`, from the CONTAINER this row sat in — never from the sign of any figure.
   *
   * The response splits the two sides into `brokers_buy` and `brokers_sell` and sends both as
   * POSITIVE numbers, so a sell row read without its container looks exactly like a buy. The
   * container is the only thing that distinguishes them.
   *
   * **Absent** when the payload was not that two-sided shape and the generic reader was used
   * instead. That is a real state — an unrecognised response still returns its rows — and the side
   * is then genuinely unknown. It is left off rather than defaulted, because a row labelled `buy`
   * on no evidence is worse than one that admits it does not know: the label would be summed.
   */
  side?: BrokerActivitySide;
  /** The session this row is for, when the row carried one. Rows are per stock PER DAY. */
  date?: string;
  /** Traded value in rupiah on this side. Positive on both sides; read `side`. */
  value?: number;
  /** Traded volume in LOTS on this side. */
  lot?: number;
  /** The average price this side traded at, as the wire computed it. */
  avgPrice?: number;
  /** Transaction count on this side. */
  freq?: number;
  /** `BROKER_TYPE_LOCAL` / `BROKER_TYPE_FOREIGN` etc., exactly as spelled on the wire. */
  investorType?: string;
  readFrom: BrokerActivityReadFrom;
  /**
   * The whole row, unmodified — including `company_detail` and `nval_trend`, which are passed
   * through rather than projected.
   */
  row: Row;
}

export interface BrokerActivity {
  brokerCode: string;
  /** Exactly what went onto the wire, so the filters that produced these rows are visible. */
  request: Record<string, string | number | readonly string[]>;
  /**
   * The window the endpoint says these rows cover, read from `data.from` / `data.to`.
   *
   * This route has no period filter (see `buildActivityParams`), so the window is not something a
   * caller chose — it is something the response announces, and it is the only thing that dates
   * these figures. Absent when the response did not carry it; never defaulted to today.
   */
  from?: string;
  to?: string;
  count: number;
  rowsFrom: string | null;
  dataKeys: string[];
  rows: BrokerActivityRow[];
  unmapped: Unmapped;
}

export interface BrokerActivityOptions extends DateRangeInput {
  brokerCode: unknown;
  /**
   * A preset window, resolved locally into `from`/`to` — see `ACTIVITY_PERIODS`. The NAME is never
   * sent: this endpoint answers 400 to `period`, but it takes the dates the name resolves to.
   *
   * Ignored when an explicit `from`/`to` is given, the same precedence `brokerDistribution` uses.
   */
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
 * this project invented would decide the boards on the caller's behalf, and on a route nobody has
 * probed it could equally well be a value the server rejects.
 *
 * ## The window: `from`/`to`, never `period`
 *
 * The NAME `period` is refused by the endpoint and is never put on the wire. Measured 2026-09-01,
 * it answers **400 `Your request is invalid`** to every one of the ten `BROKER_PERIODS` members and
 * to eight other spellings (`TB_PERIOD_DAILY`, `_1D`, `_ONE_DAY`, `_WEEKLY`, `_MONTHLY`, `DAILY`,
 * `1D`, `daily`), while `tb_period`, `periode`, `range` and `time_period` answer 200 and are
 * ignored — so the service silently drops keys it does not know, and a 400 means `period` is a
 * recognised field refusing a value. No spelling of the NAME will ever work.
 *
 * The DATES do work. Measured the same day: `from=2026-08-17&to=2026-08-21` came back with
 * `data.from`/`data.to` echoing exactly those dates, 1034 buy rows against the default 868, and
 * rows whose own `date` fields sat inside the window; a second window moved it again. So this route
 * has a fully working time filter that the earlier investigation missed by only ever varying the
 * `period` key and its values. `period` is now ACCEPTED here and resolved into a date pair by
 * `resolveActivityPeriod` — the caller gets the window they asked for, and the server echoes back
 * which one it served.
 *
 * `date_from`/`start_date` and friends are accepted from callers and normalised away by
 * `normalizeDateRange`: measured 2026-09-01, `date_from`/`date_to` are among the keys this service
 * silently ignores, so sending them would return today's rows under a caller's belief that they had
 * asked for a window.
 *
 * A half-specified range is rejected by `normalizeDateRange` even though this endpoint tolerates one
 * (a lone `from` came back as `from`..today, honestly echoed). One date-range contract across the
 * broker family is worth more than one route's leniency.
 *
 * Exported so the shape can be asserted without a network round-trip.
 */
export function buildActivityParams(opts: BrokerActivityOptions): WireParams {
  const explicit = normalizeDateRange(opts);
  const range =
    explicit ??
    (opts.period === undefined
      ? undefined
      : resolveActivityPeriod(member(ACTIVITY_PERIODS, opts.period, "period"), wibTodayIso()));
  const markets = tokenList(BROKER_MARKET_TYPES, opts.marketTypes, "market_type");
  const investors = tokenList(BROKER_INVESTOR_TYPES, opts.investorTypes, "investor_type");
  return {
    broker_code: normalizeBrokerCode(opts.brokerCode),
    from: range?.from,
    to: range?.to,
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
 * The cache key is the full parameter set, so a different board list or a different page is a
 * different entry. Keying on the broker code alone would serve one broker's REGULER answer to a
 * question about their ALL board.
 */
export async function getBrokerActivity(opts: BrokerActivityOptions): Promise<BrokerActivity> {
  const params = buildActivityParams(opts);
  const request = sent(params);

  // A window that ended before today can never change, so it caches the way `broker_summary`'s
  // does. This only became available when the route gained `from`/`to`: with a server-chosen
  // window there was no range to settle, and everything took the 60 s TTL.
  const from = typeof params.from === "string" ? params.from : undefined;
  const to = typeof params.to === "string" ? params.to : undefined;
  const ttl =
    from !== undefined && to !== undefined && isSettledRange({ from, to })
      ? CACHE.brokerSummarySettledTtlMs
      : CACHE.brokerSummaryTtlMs;

  return cached(`brokers:activity:${JSON.stringify(request)}`, ttl, async () => {
    const body = await getJson("brokerActivity", { params });
    // The two-sided reader FIRST, and the generic one only if it declines — the order `bucketsOf`
    // takes ahead of `rowsOf` on the day calendar, and the order this comment claimed while the
    // code did the opposite. `readRows` ran unconditionally, and it throws on any top-level array
    // of non-objects beside the container: a `warnings: ["stale"]` key would abort a response the
    // two-sided reader parses correctly. Only `dataKeys` was ever needed from it here, and that is
    // read off the envelope directly.
    const { data } = parseOr(Envelope, body, "broker activity");
    const dataObject = isRecordLike(data) ? (data as Row) : null;
    const dataKeys = dataObject ? Object.keys(dataObject) : [];

    const sided = activityRows(dataObject);
    const generic = sided ? null : readRows(body, "broker activity");
    const rows = sided ? sided.rows.map((r) => r.row) : (generic?.rows ?? []);
    const from = sided ? sided.from : (generic?.from ?? null);

    // An unrecognised shape still yields rows, but their side is unknowable — so it is left absent
    // rather than defaulted to one of the two answers.
    const pairs: Array<{ row: Row; side?: BrokerActivitySide }> =
      sided?.rows ?? rows.map((row) => ({ row }));

    const mapped: BrokerActivityRow[] = pairs.map(({ row, side }) => {
      const symbol = pick(row, SYMBOL_KEYS, isSymbolish);
      const value = activityFigure(row, "value");
      const lot = activityFigure(row, "lot");
      const avgPrice = activityFigure(row, "avg_price");
      const freq = activityFigure(row, "freq");
      const date = label(row, "date");
      const investorType = label(row, "type");
      return {
        symbol: symbol.value,
        ...(side === undefined ? {} : { side }),
        ...(date.value === undefined ? {} : { date: date.value }),
        ...(value.value === undefined ? {} : { value: value.value }),
        ...(lot.value === undefined ? {} : { lot: lot.value }),
        ...(avgPrice.value === undefined ? {} : { avgPrice: avgPrice.value }),
        ...(freq.value === undefined ? {} : { freq: freq.value }),
        ...(investorType.value === undefined ? {} : { investorType: investorType.value }),
        readFrom: {
          symbol: symbol.key,
          ...(date.key === undefined ? {} : { date: date.key }),
          ...(value.key === undefined ? {} : { value: value.key }),
          ...(lot.key === undefined ? {} : { lot: lot.key }),
          ...(avgPrice.key === undefined ? {} : { avgPrice: avgPrice.key }),
          ...(freq.key === undefined ? {} : { freq: freq.key }),
          ...(investorType.key === undefined ? {} : { investorType: investorType.key }),
        },
        row,
      };
    });
    // Beside the rows, not inside them: `data.from` / `data.to` are the window the SERVER chose,
    // and since `period` is refused they are the only statement of which days these figures are.
    // Spread, so an envelope that carried neither leaves the keys absent rather than undefined.
    // Named apart from the destructured `from` above, which is the ENVELOPE KEY the rows came out
    // of. Two different `from`s in one scope, and confusing them would put a container name where
    // a date belongs.
    const windowFrom = asWireString(dataObject?.from);
    const windowTo = asWireString(dataObject?.to);
    const window = {
      ...(windowFrom === undefined ? {} : { from: windowFrom }),
      ...(windowTo === undefined ? {} : { to: windowTo }),
    };
    return {
      brokerCode: String(params.broker_code),
      request,
      ...window,
      count: mapped.length,
      rowsFrom: from,
      dataKeys,
      rows: mapped,
      unmapped: unmappedOf(rows, mapped, "symbol"),
    };
  });
}

/* ----------------------------------- top ----------------------------------- */

/**
 * Which wire key each of `brokerTop`'s figures was read from.
 *
 * Wider than `ReadFrom` because this route's row shape IS observed (2026-09-01) and its figures are
 * therefore projected into named fields rather than left in `row`. A key appears here only when a
 * value actually came out of it: a `total_value` that would not parse leaves both `totalValue` and
 * `readFrom.totalValue` absent, so "the wire did not send it" and "this server would not read it"
 * never look like a figure of zero.
 */
export interface BrokerTopReadFrom extends ReadFrom {
  investorType?: string;
  totalValue?: string;
  netValue?: string;
  buyValue?: string;
  sellValue?: string;
  totalVolume?: string;
  totalFrequency?: string;
  group?: string;
}

export interface BrokerTopRow {
  code?: string;
  name?: string;
  /** `investor_type` verbatim — a wire vocabulary this project has not mapped, so it is not renamed. */
  investorType?: string;
  /** IDR. The figure the league table is ranked by, and the key the local sort reads. */
  totalValue?: number;
  /** IDR. Buys netted against sells. Negative is a net seller; the sign is the wire's. */
  netValue?: number;
  buyValue?: number;
  sellValue?: number;
  totalVolume?: number;
  totalFrequency?: number;
  /** `group` verbatim, e.g. a house's affiliation label. Not mapped, not renamed. */
  group?: string;
  readFrom: BrokerTopReadFrom;
  /** The whole row as it arrived. Nothing is dropped, and a key this projection does not know is here. */
  row: Row;
}

/**
 * How the rows got into the order they are in.
 *
 * Returned rather than merely documented, because the order is OURS. The endpoint answers
 * **ascending** by `total_value` (measured across all 89 rows on 2026-09-01: first `22,485,000`,
 * last `5,636,360,451,396`) and no `sort_by` value reverses it — `sort_by=total_value`,
 * `sort_by=TOTAL_VALUE`, `order_by=desc` and `sort_direction=DESC` are all accepted with a 200 and
 * all leave the order alone, while `order=desc` and `sort=desc` answer 400. So a descending league
 * table can only be produced here, and a re-sort the caller cannot see would be exactly the kind of
 * silent behaviour this module exists to refuse.
 */
export interface BrokerTopSort {
  /** The row key the sort read. Always `total_value`: it is the only ranking the route publishes. */
  by: "total_value";
  direction: "descending";
  /** True always, and stated anyway — the caller must not read this order as the exchange's. */
  appliedLocally: true;
  /**
   * Rows whose `total_value` could not be read. They keep their wire order and sit AFTER every
   * sorted row, because a row with no rank cannot be given one.
   */
  unsortable: number;
}

/** The session this table covers, from `data.date`. Absent keys stay absent. */
export interface BrokerTopDate {
  from?: string;
  to?: string;
  /** Stockbit's own index-date field. Passed through under its wire name; its meaning is unmapped. */
  idx?: string;
}

export interface BrokerTop {
  /** Exactly what went onto the wire. `limit` is NOT in here — see `getBrokerTop`. */
  request: Record<string, string | number | readonly string[]>;
  /** Provenance the response volunteered: which session these figures are. Absent if it did not. */
  date?: BrokerTopDate;
  /** Rows in `brokers` — after the local `limit`, when one was given. */
  count: number;
  /** Rows the response actually carried. Equal to `count` when no `limit` was applied. */
  countBeforeLimit: number;
  /** Present only when `limit` was passed. The cap is OURS: the endpoint ignores its own. */
  limitAppliedLocally?: number;
  rowsFrom: string | null;
  dataKeys: string[];
  sortedLocally: BrokerTopSort;
  brokers: BrokerTopRow[];
  unmapped: Unmapped;
}

export interface BrokerTopOptions {
  period?: unknown;
  sortBy?: unknown;
  page?: unknown;
  /**
   * Rows to keep. Applied HERE, after the descending sort, because the endpoint ignores it: at
   * `limit=3` and at `limit=5` it returned the same 89 rows (2026-09-01).
   */
  limit?: unknown;
}

/** Read one measured numeric key, naming it only when a number actually came out of it. */
function figure(row: Row, key: string): { value?: number; key?: string } {
  const value = asWireNumber(row[key]);
  return value === undefined ? {} : { value, key };
}

/** The same for a measured string key. */
function label(row: Row, key: string): { value?: string; key?: string } {
  const value = asWireString(row[key]);
  return value === undefined ? {} : { value, key };
}

/** `data.date` — three strings, each absent rather than empty when the wire sent nothing. */
function readTopDate(raw: Row): BrokerTopDate | undefined {
  const from = asWireString(raw.from);
  const to = asWireString(raw.to);
  const idx = asWireString(raw.idx);
  if (from === undefined && to === undefined && idx === undefined) return undefined;
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(idx === undefined ? {} : { idx }),
  };
}

/**
 * The market-wide broker league table: who moved the most, across every stock.
 *
 * Deliberately narrower than `getBrokerActivity`. The repeated `market_type` / `investor_type`
 * parameters are documented for the activity route and only for it, so they are not sent here —
 * a filter this endpoint ignores would silently widen the answer, and one it rejects would 400 a
 * call that had no need to carry it.
 *
 * ## Two things this function does that the endpoint does not
 *
 * **It sorts.** Descending by `total_value`, locally. See `BrokerTopSort` for what was measured.
 * A tool whose whole description is "which brokers moved the most" was putting the biggest broker
 * last, and the ignored `limit` was the only thing hiding it.
 *
 * **It applies `limit`.** Also locally, and `limit` is NOT sent: the endpoint ignores it, and a
 * parameter on the wire that changes nothing reads back through `request` as a cap the server
 * honoured. Refusing it outright was the alternative, but a league table is exactly the shape a
 * caller wants the top of, and `limitAppliedLocally` says whose cap it is.
 *
 * Because `limit` is not on the wire it is not in the cache key either — which is the point. The
 * FULL sorted table is what is cached, and the trim happens on a copy, so asking for the top 3 and
 * then the top 10 is one fetch. Same shape, and the same trap, as `getBrokerDirectory`'s `codes`:
 * trimming the cached object in place would hand every later caller this caller's cap.
 */
export async function getBrokerTop(opts: BrokerTopOptions = {}): Promise<BrokerTop> {
  const period = opts.period === undefined ? undefined : member(BROKER_PERIODS, opts.period, "period");
  // Validated before the fetch, so a mistyped cap is an error here rather than a silent full table.
  const limit = opts.limit === undefined ? undefined : pageNumber(opts.limit, "limit");
  const params: WireParams = {
    period: period === undefined ? undefined : `TB_PERIOD_${period}`,
    sort_by: opts.sortBy === undefined ? undefined : `SORT_BY_${enumToken(opts.sortBy, "sort_by")}`,
    page: opts.page === undefined ? undefined : pageNumber(opts.page, "page"),
  };
  const request = sent(params);

  const full = await cached(`brokers:top:${JSON.stringify(request)}`, CACHE.brokerSummaryTtlMs, async () => {
    const body = await getJson("brokerTop", { params });
    const { rows, from, dataKeys, dataObject } = readRows(body, "top brokers");
    const mapped = rows.map((row) => {
      const code = pick(row, CODE_KEYS, isCode);
      const name = pick(row, NAME_KEYS, isName);
      // These eight are read by their MEASURED key, not from a candidate list: the row shape was
      // observed on 2026-09-01 and each figure is a plain numeric string ("-15025000"), not the
      // `{raw, formatted}` pair most of this API sends. A candidate list here would be pretending
      // not to know something that was measured.
      const investorType = label(row, "investor_type");
      const group = label(row, "group");
      const totalValue = figure(row, "total_value");
      const netValue = figure(row, "net_value");
      const buyValue = figure(row, "buy_value");
      const sellValue = figure(row, "sell_value");
      const totalVolume = figure(row, "total_volume");
      const totalFrequency = figure(row, "total_frequency");
      return {
        code: code.value,
        name: name.value,
        investorType: investorType.value,
        totalValue: totalValue.value,
        netValue: netValue.value,
        buyValue: buyValue.value,
        sellValue: sellValue.value,
        totalVolume: totalVolume.value,
        totalFrequency: totalFrequency.value,
        group: group.value,
        readFrom: {
          code: code.key,
          name: name.key,
          investorType: investorType.key,
          totalValue: totalValue.key,
          netValue: netValue.key,
          buyValue: buyValue.key,
          sellValue: sellValue.key,
          totalVolume: totalVolume.key,
          totalFrequency: totalFrequency.key,
          group: group.key,
        },
        row,
      };
    });
    // Counted BEFORE the sort: `unmappedOf` walks `rows` and `mapped` in parallel, so it has to see
    // them in the same order. Sorting first would report another row's keys as the unreadable one's.
    const unmapped = unmappedOf(rows, mapped, "code");

    // Partition, then sort — rather than one comparator that pushes undefined to the end. A row
    // with no readable `total_value` has no rank, and giving it one (top or bottom, by comparator
    // accident) is inventing a position. These keep wire order and sit after everything ranked.
    const ranked = mapped.filter((b) => b.totalValue !== undefined);
    const unranked = mapped.filter((b) => b.totalValue === undefined);
    // Node's sort is stable, so brokers tied on value stay in the order the exchange sent them.
    ranked.sort((a, b) => (b.totalValue as number) - (a.totalValue as number));
    const brokers = [...ranked, ...unranked];

    const rawDate = dataObject?.date;
    const date =
      typeof rawDate === "object" && rawDate !== null && !Array.isArray(rawDate)
        ? readTopDate(rawDate as Row)
        : undefined;

    const result: BrokerTop = {
      request,
      ...(date === undefined ? {} : { date }),
      count: brokers.length,
      countBeforeLimit: brokers.length,
      rowsFrom: from,
      dataKeys,
      sortedLocally: {
        by: "total_value",
        direction: "descending",
        appliedLocally: true,
        unsortable: unranked.length,
      },
      brokers,
      unmapped,
    };
    return result;
  });

  if (limit === undefined) return full;

  // A NEW object. `full` is the shared cache entry, and slicing its `brokers` in place would hand
  // every later caller of that entry this caller's cap.
  const brokers = full.brokers.slice(0, limit);
  return { ...full, count: brokers.length, brokers, limitAppliedLocally: limit };
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
