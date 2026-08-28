/**
 * Corporate actions, the market-wide calendar, and the IPO pipeline.
 *   GET /corpaction/{actionType}?symbol=&limit=      one action kind, optionally one issuer
 *   GET /corpaction?date=YYYY-MM-DD                  everything happening on ONE date, market-wide
 *   GET /corpaction/status?symbol=A,B,C              UMA / special-notation status, many at once
 *   GET /corpaction/{symbol}/stock_conversion?page=&limit=
 *   GET /order-trade/underwriters                    the underwriter directory
 *   GET /order-trade/underwriters/{code}/ipo-performance?sort_by=
 *
 * ## None of these six have been observed live in this session
 *
 * So the row shapes below are not projected into named fields. Every accessor returns the rows
 * Stockbit sent, untouched, plus a `rowsFrom` tag saying where in the payload they were found.
 * Naming survivors would turn "we have not looked at this field yet" into "this field does not
 * exist" (see `getSectors` in emitten.ts for the same argument made at length). The two places this
 * module does reach into a row — the ex-date sort in `getDividendCalendar` and the symbol matching
 * in `getCorpactionStatus` — both report what they found and what they did not, so a wrong guess
 * surfaces as "not located" rather than as a confident answer.
 */
import { z } from "zod";
import { getJson, type GetOptions } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { StockbitError } from "../http/errors.js";
import { normalizeSymbol } from "../symbol.js";
import { normalizeDateRange, normalizeTradeDate, type DateRangeInput } from "./dates.js";
import type { CorpactionType, RouteName } from "../http/transport.js";

/**
 * The action kinds, re-exported so tool schemas can say `z.enum(core.CORPACTION_TYPES)` without a
 * second copy of the list. The transport owns it because it validates the path segment.
 */
export { CORPACTION_TYPES } from "../http/transport.js";
export type { CorpactionType } from "../http/transport.js";

/* ------------------------------- envelope handling ------------------------------- */

/**
 * Deliberately the loosest envelope that still proves we got JSON with a `data` slot: `data` is
 * `unknown` because these payloads have not been measured, and a required inner field guessed wrong
 * would turn a working endpoint into a schema_drift error.
 */
const Envelope = z.object({ data: z.unknown() }).passthrough();

export interface RowSet {
  /** The rows, exactly as Stockbit sent them. */
  rows: Array<Record<string, unknown>>;
  /**
   * Where the rows were found:
   *   `data`            — `data` was itself the array
   *   `data.<key>`      — the array was nested one level down (the watchlist detail does this)
   *   `absent`          — the response carried no `data` at all. NOT the same as an empty list.
   *   `unrecognized`    — `data` was present but was not a row list; see `raw`, which is then the
   *                       only trustworthy answer, and treat `rows: []` as "not parsed", not "none".
   */
  rowsFrom: string;
  /** The sibling fields beside a nested row array — pagination, totals. Kept rather than dropped. */
  meta?: Record<string, unknown>;
  /** The unparsed `data`, present only when `rowsFrom` is `unrecognized`. */
  raw?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Locate the row list in an unmeasured payload without naming a field.
 *
 * Both shapes this API is known to use are covered — `data` as a bare array, and `data.<something>`
 * as the array with pagination beside it — and anything else is reported as `unrecognized` rather
 * than flattened to an empty list. That distinction is the point: an empty array from the server and
 * a shape this function could not read are the same value and must not be the same answer.
 */
function rowsOf(data: unknown): RowSet {
  if (data === undefined || data === null) return { rows: [], rowsFrom: "absent" };
  if (Array.isArray(data)) {
    if (data.every(isRecord)) return { rows: data, rowsFrom: "data" };
    return { rows: [], rowsFrom: "unrecognized", raw: data };
  }
  if (isRecord(data)) {
    for (const [key, value] of Object.entries(data)) {
      if (!Array.isArray(value) || !value.every(isRecord)) continue;
      const meta = Object.fromEntries(Object.entries(data).filter(([k]) => k !== key));
      return {
        rows: value,
        rowsFrom: `data.${key}`,
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      };
    }
  }
  return { rows: [], rowsFrom: "unrecognized", raw: data };
}

/** Fetch a route and split its `data` into rows. */
async function fetchRows(route: RouteName, context: string, opts: GetOptions = {}): Promise<RowSet> {
  const body = await getJson(route, opts);
  return rowsOf(parseOr(Envelope, body, context).data);
}

/* ------------------------------ argument validation ------------------------------ */

/**
 * A count that goes on the wire as `limit` or `page`.
 *
 * `min` differs between the two because the pagination base of this endpoint family is unverified:
 * `page` allows 0 in case it is 0-based, since a rule tighter than reality would refuse a legitimate
 * request, while `limit: 0` is refused because every Stockbit endpoint measured so far treats it as
 * an error rather than as "no rows".
 */
function count(name: string, value: number | undefined, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${name} ${JSON.stringify(value)}: expected an integer >= ${min}`,
    );
  }
  return value;
}

/* -------------------------------- corporate actions -------------------------------- */

export interface ActionPage extends RowSet {
  actionType: CorpactionType;
  /** The issuer filter that was applied, absent when the request was market-wide. */
  symbol?: string;
}

/**
 * One kind of corporate action, optionally for one issuer.
 *
 * The action kind is a path segment validated against `CORPACTION_TYPES` by the transport, because
 * an unknown kind comes back 200-with-nothing rather than 404 and would read as a quiet calendar.
 */
export async function getCorpactions(
  actionType: CorpactionType,
  symbol?: string,
  limit?: number,
): Promise<ActionPage> {
  const sym = symbol === undefined ? undefined : normalizeSymbol(symbol);
  const rows = count("limit", limit, 1);
  // Every argument that changes the answer is in the key. A key of `corpaction:${actionType}` would
  // serve a 5-row answer to the caller who asked for 50.
  const key = `corpaction:${actionType}:${sym ?? "-"}:${rows ?? "-"}`;
  return cached(key, CACHE.keystatsTtlMs, async () => ({
    actionType,
    ...(sym ? { symbol: sym } : {}),
    ...(await fetchRows("corpaction", `corporate actions (${actionType})`, {
      segments: { actionType },
      params: { symbol: sym, limit: rows },
    })),
  }));
}

/* -------------------------------- dividend calendar -------------------------------- */

/**
 * Candidate spellings for the ex-date, tried in order.
 *
 * These are guesses, and they are treated as guesses: whichever one is present on the rows is
 * reported back as `exDateField`, and if none is present the merged list keeps Stockbit's own order
 * and says `exDateField: null`. Nothing is dropped either way. The alternative — silently sorting by
 * a key that does not exist — produces a list that looks chronological and is not.
 */
const EX_DATE_KEYS = ["ex_date", "exdate", "ex_dividend_date", "date_ex", "ex", "date"] as const;

/** The two action kinds a dividend calendar covers. They are different instruments; see below. */
const DIVIDEND_KINDS = ["dividend", "stock_dividend"] as const;

export interface DividendRow extends Record<string, unknown> {
  /** Which of the two kinds this row came from. Added last, so it always describes the merge. */
  corpactionType: (typeof DIVIDEND_KINDS)[number];
  /** The value the sort used, normalized to YYYY-MM-DD, or null when none was found on this row. */
  exDate: string | null;
}

export interface DividendCalendar {
  symbol?: string;
  rows: DividendRow[];
  /** The key the ex-date sort read, or null when no candidate key was present on any row. */
  exDateField: string | null;
  /** Rows carrying no usable ex-date. They are kept, at the end of the list, never dropped. */
  undated: number;
  /** `rowsFrom` for each leg, so an unreadable payload on one kind is visible rather than silent. */
  rowsFrom: Record<(typeof DIVIDEND_KINDS)[number], string>;
}

/**
 * Normalize a candidate ex-date value to `YYYY-MM-DD`, or null if it is not a date.
 *
 * Four encodings are handled because the wire format is unverified and each of the plausible ones
 * fails differently if guessed at:
 *
 *   `2026-04-02`   the dashed form, taken as-is (a trailing time is ignored)
 *   `20260402`     compact. Checked BEFORE the epoch branch: read as epoch seconds it is August
 *                  1970, which is a confident wrong date rather than a missing one
 *   `1775433600`   epoch seconds, or milliseconds above ~1e11
 *   anything else  handed to `Date.parse`, and null when that fails
 *
 * `Number("")` being 0 is the trap under all of this: an empty field must be absent, not 1970.
 */
function isoFromEpoch(ms: number): string | null {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** A run of digits as either a compact YYYYMMDD date or an epoch stamp. */
function digitsToDate(text: string): string | null {
  const compact = /^((?:19|20)\d{2})(\d{2})(\d{2})$/.exec(text);
  if (compact) {
    const [, year, month, day] = compact;
    const inRange = Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31;
    return inRange ? `${year}-${month}-${day}` : null;
  }
  if (/^\d{9,13}$/.test(text)) {
    const value = Number(text);
    return isoFromEpoch(value < 1e11 ? value * 1000 : value);
  }
  return null;
}

function asDate(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? digitsToDate(String(Math.trunc(value))) : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const dashed = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  if (dashed) return dashed[1];
  if (/^\d+$/.test(text)) return digitsToDate(text);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : isoFromEpoch(parsed);
}

/** The first candidate key that yields a real date on at least one row, or null. */
function findExDateKey(rows: Array<Record<string, unknown>>): string | null {
  return EX_DATE_KEYS.find((key) => rows.some((row) => asDate(row[key]) !== null)) ?? null;
}

/**
 * Cash dividends and stock dividends in one list, newest ex-date first.
 *
 * The two are fetched as two requests, one after the other. Sequential is not an accident: a
 * concurrent pair of first calls has burned this project's session token before, because both miss
 * the cache, both see an expired access token, and both refresh.
 */
export async function getDividendCalendar(symbol?: string, limit?: number): Promise<DividendCalendar> {
  const legs: Array<{ kind: (typeof DIVIDEND_KINDS)[number]; page: ActionPage }> = [];
  for (const kind of DIVIDEND_KINDS) {
    legs.push({ kind, page: await getCorpactions(kind, symbol, limit) });
  }

  const merged: DividendRow[] = legs.flatMap(({ kind, page }) =>
    page.rows.map((row) => ({ ...row, corpactionType: kind, exDate: null as string | null })),
  );
  const exDateField = findExDateKey(merged);
  for (const row of merged) row.exDate = exDateField ? asDate(row[exDateField]) : null;

  // Descending: the near future and the most recent past are what a caller asks a calendar for.
  // Undated rows keep their relative order and go last rather than sorting as the epoch.
  const sorted = [...merged].sort((a, b) => {
    if (a.exDate === b.exDate) return 0;
    if (a.exDate === null) return 1;
    if (b.exDate === null) return -1;
    return a.exDate < b.exDate ? 1 : -1;
  });

  return {
    ...(legs[0].page.symbol ? { symbol: legs[0].page.symbol } : {}),
    rows: sorted,
    exDateField,
    undated: sorted.filter((row) => row.exDate === null).length,
    rowsFrom: { dividend: legs[0].page.rowsFrom, stock_dividend: legs[1].page.rowsFrom },
  };
}

/* --------------------------------- the day calendar --------------------------------- */

export interface CalendarDay extends RowSet {
  /** The date requested, or null when none was sent and the server chose its own "today". */
  date: string | null;
}

/**
 * Every corporate action on ONE date, market-wide.
 *
 * `from`/`to` are accepted by this endpoint and SILENTLY IGNORED — it answers 200 with today's
 * actions — so only `date` is ever sent. Omitting the date sends no parameter at all and lets the
 * server pick the day; this module does not substitute its own "today", because the process clock is
 * UTC and IDX trades in WIB, which disagree for the first seven hours of every day.
 */
export async function getCalendarDay(date?: string): Promise<CalendarDay> {
  const day = date === undefined ? undefined : normalizeTradeDate(date);
  return cached(`corpaction:day:${day ?? "server-default"}`, CACHE.keystatsTtlMs, async () => ({
    date: day ?? null,
    ...(await fetchRows("corpactionToday", "corporate action calendar", { params: { date: day } })),
  }));
}

/** The most days one `calendar_range` call will fetch. One request per day, so this is 31 requests. */
export const MAX_CALENDAR_DAYS = 31;

export interface CalendarRange {
  requestedFrom: string;
  requestedTo: string;
  /** The window actually covered. Equal to the requested one only when `truncated` is false. */
  coveredFrom: string;
  coveredTo: string;
  daysRequested: number;
  daysFetched: number;
  /** Days in the requested window that were NOT fetched. Zero when the answer is complete. */
  daysSkipped: number;
  truncated: boolean;
  /** Spelled out when `truncated`, so a partial answer cannot be skimmed as a complete one. */
  note?: string;
  days: CalendarDay[];
  rowsTotal: number;
}

/** Inclusive list of `YYYY-MM-DD` days, `from` forward, at most `max` of them. */
function daysBetween(from: string, to: string, max: number): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end && out.length < max; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * A date RANGE, assembled from one request per day.
 *
 * There is no range form of this endpoint. `from`/`to` are accepted and ignored, which is the worst
 * failure mode available: 200, today's rows, and a caller who believes they queried a month. So the
 * range is walked day by day.
 *
 * **Sequentially, never fanned out.** Concurrent first calls have burned this project's session
 * token, and 31 of them at once would be 31 chances to do it again.
 *
 * Capped at `MAX_CALENDAR_DAYS`. A longer request is answered with the first 31 days plus a count of
 * the days that were skipped, rather than with silence or an error — but it is never presented as
 * complete: `truncated`, `daysSkipped` and `note` all say otherwise, and `coveredTo` is the real end
 * of the answer.
 */
export async function getCalendarRange(input: DateRangeInput): Promise<CalendarRange> {
  const range = normalizeDateRange(input);
  if (!range) {
    throw new StockbitError(
      "invalid_param",
      "A calendar range needs both from and to (YYYY-MM-DD). For a single day use the day calendar.",
    );
  }

  const totalDays =
    Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;
  const wanted = daysBetween(range.from, range.to, MAX_CALENDAR_DAYS);

  const days: CalendarDay[] = [];
  for (const day of wanted) days.push(await getCalendarDay(day));

  const skipped = totalDays - wanted.length;
  return {
    requestedFrom: range.from,
    requestedTo: range.to,
    coveredFrom: wanted[0],
    coveredTo: wanted[wanted.length - 1],
    daysRequested: totalDays,
    daysFetched: wanted.length,
    daysSkipped: skipped,
    truncated: skipped > 0,
    ...(skipped > 0
      ? {
          note:
            `INCOMPLETE: capped at ${MAX_CALENDAR_DAYS} days. This covers ${wanted[0]} to ` +
            `${wanted[wanted.length - 1]} only; ${skipped} day(s) up to ${range.to} were not ` +
            "fetched. Request them as a further range.",
        }
      : {}),
    days,
    rowsTotal: days.reduce((sum, day) => sum + day.rows.length, 0),
  };
}

/* ----------------------------------- action status ----------------------------------- */

export interface CorpactionStatus extends RowSet {
  /** The symbols that were asked about, normalized, deduped, in the order they were sent. */
  requested: string[];
  /** Requested symbols the response mentions. See `getCorpactionStatus` for how that is decided. */
  answered: string[];
  /** Requested symbols the response does not mention anywhere this code could look. */
  unanswered: string[];
}

/** Split a caller's symbol list: an array, a comma string, or an array of comma strings. */
function symbolList(symbols: readonly string[] | string): string[] {
  const parts = (typeof symbols === "string" ? [symbols] : symbols)
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => normalizeSymbol(entry));
  if (parts.length === 0) {
    throw new StockbitError("invalid_param", "At least one symbol is required");
  }
  return [...new Set(parts)];
}

/** Whether a row carries this symbol as one of its top-level string values. */
function mentions(row: Record<string, unknown>, symbol: string): boolean {
  return Object.values(row).some((value) => typeof value === "string" && value.trim().toUpperCase() === symbol);
}

/**
 * UMA and IDX special-notation status for several symbols in ONE request.
 *
 * This endpoint genuinely takes a comma-joined list in a single `symbol` parameter, which is the
 * opposite of the broker-activity endpoint next door: that one takes REPEATED parameters and reads
 * only the first when they arrive joined. The two conventions live three routes apart, so the choice
 * is made here explicitly rather than inherited.
 *
 * `answered` / `unanswered` are computed by VALUE, not by field name: a row belongs to a symbol if
 * any of its top-level strings equals that symbol, and when `data` is a map its keys are checked
 * too. That avoids inventing a field name for a payload nobody has mapped, at the cost of being
 * conservative — a symbol can land in `unanswered` because the response nests its rows deeper than
 * this looks. `unanswered` therefore means "no row here mentions it", which most likely means the
 * issuer carries no special notation, and must not be reported as "confirmed clean".
 */
export async function getCorpactionStatus(symbols: readonly string[] | string): Promise<CorpactionStatus> {
  const requested = symbolList(symbols);
  return cached(`corpaction:status:${requested.join(",")}`, CACHE.keystatsTtlMs, async () => {
    const body = await getJson("corpactionStatus", { params: { symbol: requested.join(",") } });
    const data = parseOr(Envelope, body, "corporate action status").data;
    const set = rowsOf(data);
    const keys = isRecord(data) ? Object.keys(data).map((key) => key.trim().toUpperCase()) : [];
    const answered = requested.filter(
      (sym) => set.rows.some((row) => mentions(row, sym)) || keys.includes(sym),
    );
    return {
      requested,
      answered,
      unanswered: requested.filter((sym) => !answered.includes(sym)),
      ...set,
    };
  });
}

/* --------------------------------- stock conversion --------------------------------- */

export interface StockConversion extends RowSet {
  symbol: string;
}

/**
 * Warrant and rights conversion history for one issuer.
 *
 * `page` and `limit` are sent only when given. Whether pagination is 0- or 1-based is unverified, so
 * both 0 and 1 are accepted here and neither is assumed by default.
 */
export async function getStockConversion(
  symbol: string,
  page?: number,
  limit?: number,
): Promise<StockConversion> {
  const sym = normalizeSymbol(symbol);
  // Both are REQUIRED by the endpoint, which has no default of its own: omitting either returns
  // 400 "Page is a required field;Limit is a required field;". Settled live on 2026-08-29, and it
  // is why this tool had never returned a row. `index_members` documents the same behaviour on its
  // own `limit`. Defaulted here rather than made mandatory on the tool, because a caller asking a
  // company for its conversions should not have to know the API needs paging to answer at all.
  const p = count("page", page, 0) ?? 1;
  const rows = count("limit", limit, 1) ?? 20;
  return cached(`corpaction:conversion:${sym}:${p ?? "-"}:${rows ?? "-"}`, CACHE.keystatsTtlMs, async () => ({
    symbol: sym,
    ...(await fetchRows("stockConversion", "stock conversion", {
      segments: { symbol: sym },
      params: { page: p, limit: rows },
    })),
  }));
}

/* ----------------------------------- underwriters ----------------------------------- */

/**
 * The one `sort_by` spelling that has been seen for the IPO-performance endpoint.
 *
 * A closed list rather than a free string because this parameter's failure mode is the family's
 * usual one: an unrecognised value is ignored, not rejected, so `ara_streak` would return the
 * default order and look like it worked. If more orderings are confirmed they are added here.
 */
export const UNDERWRITER_SORT_BY = ["GET_UNDERWRITER_IPO_PERFORMANCE_SORT_BY_ARA_STREAK"] as const;

export type UnderwriterSortBy = (typeof UNDERWRITER_SORT_BY)[number];

/** The underwriter directory: every code, with whatever the row carries about the house. */
export async function getUnderwriters(): Promise<RowSet> {
  return cached("corpaction:underwriters", CACHE.keystatsTtlMs, () =>
    fetchRows("underwriters", "underwriters"),
  );
}

export interface UnderwriterPerformance extends RowSet {
  underwriterCode: string;
  sortBy?: UnderwriterSortBy;
}

/**
 * One underwriter's IPO track record.
 *
 * The code is a path segment the transport validates as 2-6 uppercase alphanumerics; a lowercase or
 * over-long code is refused before a bearer-carrying request is built.
 */
export async function getUnderwriterPerformance(
  underwriterCode: string,
  sortBy?: string,
): Promise<UnderwriterPerformance> {
  const code = String(underwriterCode).trim().toUpperCase();
  if (sortBy !== undefined && !(UNDERWRITER_SORT_BY as readonly string[]).includes(sortBy)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid sort_by ${JSON.stringify(sortBy)}: expected one of ${UNDERWRITER_SORT_BY.join(", ")}. ` +
        "An unrecognised value is ignored by the endpoint rather than rejected, so it is refused here.",
    );
  }
  const sort = sortBy as UnderwriterSortBy | undefined;
  return cached(`corpaction:underwriter:${code}:${sort ?? "-"}`, CACHE.keystatsTtlMs, async () => ({
    underwriterCode: code,
    ...(sort ? { sortBy: sort } : {}),
    ...(await fetchRows("underwriterPerformance", "underwriter IPO performance", {
      segments: { underwriterCode: code },
      params: { sort_by: sort },
    })),
  }));
}
