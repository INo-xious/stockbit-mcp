/**
 * Market data: the whole-series chart fetch, the running-trade tape, and the order queue.
 *
 * Routes used here are declared in `src/http/routes/exodus.ts` under `charts`, `chartsDaily`, the
 * `runningTrade*` / `tradeBook*` / `marketMover` / `topStock` / `orderQueue` group, and the three
 * price-feed rows `marketSession`, `pricesBatch` and `pricesMarket`.
 *
 * ## None of these responses have been observed live
 *
 * That is the fact that shapes every line below. Two rules follow from it and are applied
 * everywhere:
 *
 *   1. **Envelopes are permissive and the payload is returned.** A route whose row shape nobody has
 *      mapped gets `{ data }` validated and its `data` handed back untouched, because naming three
 *      survivors of an unknown row turns "we have not looked at this field" into "this field does
 *      not exist" — see the note on `getSectors` in `src/core/emitten.ts`.
 *   2. **Nothing is sent that the caller did not ask for.** No default `limit`, no default board, no
 *      default action type. A query-parameter name guessed wrong is harmless when it is only sent
 *      by a caller who explicitly asked for that filter, and silently narrowing every response by
 *      default is how this project has already been burned once (`topGainer` vs `topgainer`).
 *
 * The parameter *names* below are the consistent spelling for this API (`action_type`, `data_type`,
 * `market_board`, `limit`), taken from the endpoints in this repo that were measured. They are still
 * unverified for these routes and are recorded as such in `docs/PENDING-VERIFICATION.md`.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { normalizeTradeDate, todayIso } from "./dates.js";
import type { Bar } from "./bars.js";
import type { QueryParams, RouteName } from "../http/transport.js";

/**
 * The one thing every response here has in common: a `data` block whose contents vary.
 *
 * `z.unknown()` rather than `z.array(...)`: a required inner shape that was guessed wrong turns a
 * working endpoint into a `schema_drift` error, and none of these have been seen.
 */
const Envelope = z.object({ data: z.unknown() }).passthrough();

/** Fetch a route and return its `data` block verbatim. `null` when the response carried none. */
async function readData(
  route: RouteName,
  context: string,
  opts: { segments?: { symbol?: string }; params?: QueryParams } = {},
): Promise<unknown> {
  const body = await getJson(route, opts);
  return parseOr(Envelope, body, context).data ?? null;
}

/* ------------------------------ shared small parsers ------------------------------ */

/**
 * Read a number that may arrive as a number, a numeric string, or a `{value}` / `{raw}` wrapper.
 *
 * All of those shapes are live in this API — `src/core/pricefeed.ts` found the auto-rejection bands
 * arriving as `{"value":"3,910"}` with bare numbers beside them — so a chart point's OHLCV is read
 * the same defensive way. `Number("")` being `0` is the specific trap: an empty string must come
 * back as absent, never as a free zero.
 */
function numberish(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    const wrapper = value as Record<string, unknown>;
    if ("value" in wrapper) return numberish(wrapper.value);
    if ("raw" in wrapper) return numberish(wrapper.raw);
  }
  return null;
}

/**
 * Jakarta's offset from UTC. IDX does not observe daylight saving, so this is a constant and not a
 * timezone lookup.
 */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * An instant to the IDX **session date** it belongs to.
 *
 * Shifting into WIB before taking the date is not a nicety, it is the difference between a bar
 * being filed on the right day and the day before. All three plausible encodings land correctly:
 * midnight UTC (07:00 WIB, same day), midnight WIB (17:00Z the previous day, shifted forward to the
 * right one), and an intraday timestamp such as the 16:00 WIB close. Formatting in UTC instead
 * would move every midnight-WIB bar back one session, and a series shifted by one day produces
 * plausible, wrong indicator values rather than an error.
 */
function sessionDate(epochMs: number): string | null {
  const shifted = new Date(epochMs + WIB_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return null;
  return shifted.toISOString().slice(0, 10);
}

/** Seconds or milliseconds since the epoch to a session date. */
function fromEpoch(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  // 1e11 seconds is the year 5138 and 1e11 milliseconds is 1973: nothing this API returns is
  // ambiguous across that line.
  return sessionDate(value > 1e11 ? value : value * 1000);
}

/**
 * A chart point's time field to `YYYY-MM-DD`, accepting every encoding this shape might use.
 *
 * A bare `YYYY-MM-DD` and a zone-less datetime are taken at face value — they already state a wall
 * clock, and re-interpreting them as UTC would move them. Only a *zoned* instant (trailing `Z` or
 * `+07:00`) and an epoch number get the WIB shift, because only those name a point in absolute time.
 */
function tradeDate(value: unknown): string | null {
  if (typeof value === "number") return fromEpoch(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (s === "") return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    if (/^\d{4}-\d{2}-\d{2}[T ]/.test(s)) {
      if (/(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
        const parsed = Date.parse(s);
        return Number.isFinite(parsed) ? sessionDate(parsed) : null;
      }
      return s.slice(0, 10);
    }
    if (/^\d+$/.test(s)) return fromEpoch(Number(s));
    return null;
  }
  if (value && typeof value === "object") {
    const wrapper = value as Record<string, unknown>;
    if ("value" in wrapper) return tradeDate(wrapper.value);
    if ("raw" in wrapper) return tradeDate(wrapper.raw);
  }
  return null;
}

/* ------------------------------ locating a row array ------------------------------ */

interface Located {
  /** Dotted path from `data`, so a caller can see where the rows were actually found. */
  path: string;
  rows: Array<Record<string, unknown>>;
}

const isRow = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Find the array of row objects inside an unmapped `data` block.
 *
 * Searching for the array beats guessing its key. Every candidate spelling this project could have
 * hard-coded (`result`, `chart`, `points`, `series`, …) is a name nobody has seen, and picking the
 * wrong one produces "no data" for a response that plainly contains data.
 *
 * Non-empty arrays win. A response that carries both an empty `[]` under some incidental key and the
 * real rows deeper down must not resolve to the empty one, which is exactly what taking the first
 * array found would do. Only when no non-empty candidate exists does an empty array answer, so that
 * "the endpoint returned zero rows" stays distinguishable from "the rows are somewhere else".
 */
function search(value: unknown, path: string, depth: number, requireRows: boolean): Located | null {
  if (depth > 3) return null;
  if (Array.isArray(value)) {
    if (requireRows && value.length === 0) return null;
    return value.every(isRow) ? { path, rows: value as Array<Record<string, unknown>> } : null;
  }
  if (!isRow(value)) return null;
  for (const [key, child] of Object.entries(value)) {
    const found = search(child, `${path}.${key}`, depth + 1, requireRows);
    if (found) return found;
  }
  return null;
}

/** The row array in a `data` block, or `null` when there is none at any reachable depth. */
export function locateRows(data: unknown): Located | null {
  return search(data, "data", 0, true) ?? search(data, "data", 0, false);
}

/* ================================ chart series ================================ */

/**
 * The timeframes the chart routes accept, in the **lowercase** spelling.
 *
 * `docs/PENDING-VERIFICATION.md` filed this route as real-but-unusable after probes sent `1D`,
 * `daily`, `D`, `DAILY` and `TIMEFRAME_DAILY`. The vocabulary was never the problem, the casing and
 * the units were: these are calendar windows, not bar intervals.
 */
export const CHART_TIMEFRAMES = ["1w", "1m", "3m", "ytd", "1y", "3y", "5y"] as const;
export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];

/**
 * The two windows that need the previous-historical flag.
 *
 * Both are anchored to a boundary rather than to a fixed length — a week starts on Monday, a
 * year-to-date starts on 1 January — so early in either window the series can hold only a handful of
 * sessions. The flag asks the server to include what came before it, which is what makes a Monday
 * `1w` request return something an indicator can be computed from.
 */
const NEEDS_PREVIOUS_HISTORICAL: readonly ChartTimeframe[] = ["1w", "ytd"];

/**
 * Validate a timeframe, refusing anything outside the vocabulary.
 *
 * **This guard is the reason the function is safe to call.** An unrecognised timeframe does not
 * 400 here: it answers HTTP 200 with an empty series, which is byte-for-byte what a symbol with no
 * history looks like. Passing an unknown value through would therefore hand the caller an empty
 * chart and no way to tell a typo from a delisting — the same silent-empty failure that hid the
 * `topGainer` casing bug for the life of that tool. So the value is checked before it can reach the
 * wire, and the message names every accepted spelling.
 */
export function normalizeChartTimeframe(input: string): ChartTimeframe {
  const tf = typeof input === "string" ? input.trim().toLowerCase() : "";
  if ((CHART_TIMEFRAMES as readonly string[]).includes(tf)) return tf as ChartTimeframe;
  throw new StockbitError(
    "invalid_param",
    `Invalid chart timeframe ${JSON.stringify(input)}: expected one of ` +
      `${CHART_TIMEFRAMES.join(", ")} (lowercase, exactly as written). Uppercase and bar-interval ` +
      "spellings such as 1D, D, DAILY or TIMEFRAME_DAILY are not rejected by the server — they " +
      "return HTTP 200 with an empty series, which is indistinguishable from a symbol that has no " +
      "history, so they are refused here instead.",
  );
}

/**
 * Wire keys each `Bar` field is read from, most specific spelling first.
 *
 * These are not invented names. Everything past the time field is the vocabulary
 * `GET /company-price-feed/historical/summary/{symbol}` already uses in this codebase
 * (`src/core/bars.ts`), so the chart payload is read with its sibling's dictionary; the short
 * aliases on the OHLCV five are the conventional single-letter forms. Whatever is not matched is
 * reported in `unmapped` rather than silently defaulted, and the first raw point is returned so the
 * real spelling can be read off it in one call.
 */
const POINT_KEYS = {
  date: ["date", "time", "timestamp", "datetime", "t"],
  open: ["open", "o"],
  high: ["high", "h"],
  low: ["low", "l"],
  // `value` last, and only as a fallback: /charts/:symbol/daily carries the price there and sends no
  // `close` at all. Settled live on 2026-08-29 by arithmetic on the payload itself — a BBRI point
  // read {value:"2930", change:-20, percentage:"-0.68"}, and 20/2930 = 0.68%, so `value` is the
  // price level and not a traded value. A real `close` key still wins.
  close: ["close", "c", "value"],
  volume: ["volume", "vol", "v"],
  average: ["average", "vwap"],
  value: ["value"],
  frequency: ["frequency", "freq"],
  change: ["change"],
  changePercent: ["change_percentage", "percentage"],
  foreignBuy: ["foreign_buy"],
  foreignSell: ["foreign_sell"],
  netForeign: ["net_foreign"],
} as const satisfies Record<keyof Bar, readonly string[]>;

type PointField = keyof typeof POINT_KEYS;

export interface ChartSeries {
  symbol: string;
  timeframe: ChartTimeframe;
  /** Which code path produced these bars. The paged walk in `src/core/bars.ts` is the other one. */
  source: "charts";
  /** Oldest first, matching every consumer of `Bar`. */
  bars: Bar[];
  from?: string;
  to?: string;
  /** Where in the `data` block the point array was found. */
  dataPath: string;
  /** `Bar` field to the wire key it was read from. */
  mapped: Partial<Record<PointField, string>>;
  /** `Bar` fields no wire key supplied. Their values are the defaults `src/core/bars.ts` uses. */
  unmapped: PointField[];
  /** Keys on the first point that no field consumed. Candidates for `POINT_KEYS`. */
  extraKeys: string[];
  /** Things to know before trusting the numbers. Empty when every field mapped. */
  warnings: string[];
  /** The first point exactly as it arrived. This shape has not been observed live. */
  sample: Record<string, unknown>;
}

/** Which of `keys` this row actually carries, or `undefined`. */
function keyIn(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  return keys.find((k) => row[k] !== undefined && row[k] !== null);
}

/**
 * Project the located points onto `Bar`.
 *
 * The key map is built once from the first point and then applied to every other point, rather than
 * re-resolved per point. A payload that switched from `close` to `c` half way through would
 * otherwise be absorbed silently; here it fails loudly on the point where it changed.
 *
 * A point that cannot yield a date and a close is fatal for the whole series, never skipped. A
 * series with holes in it is worse than an error: every moving average, pattern and backtest
 * computed from it is quietly wrong rather than absent, which is the same argument `src/core/bars.ts`
 * makes for refusing to present a truncated walk as complete.
 */
function projectSeries(
  symbol: string,
  timeframe: ChartTimeframe,
  data: unknown,
): ChartSeries {
  const located = locateRows(data);
  if (!located) {
    throw new StockbitError(
      "schema_drift",
      `Chart series for ${symbol} (${timeframe}) contained no array of points at any depth. ` +
        "The response parsed as JSON, so this is a shape change rather than an outage: fall back " +
        "to the paged historical walk and re-map this projection against the live payload.",
    );
  }
  if (located.rows.length === 0) {
    throw new StockbitError(
      "not_found",
      `Chart series for ${symbol} (${timeframe}) came back with zero points (at ${located.path}). ` +
        "This is NOT evidence that the symbol has no history — an unrecognised parameter makes " +
        "this route answer 200-with-empty — so it is raised rather than returned, and the caller " +
        "should fall back to the paged historical walk, which reports emptiness truthfully.",
    );
  }

  const first = located.rows[0] as Record<string, unknown>;
  const mapped: Partial<Record<PointField, string>> = {};
  const unmapped: PointField[] = [];
  for (const field of Object.keys(POINT_KEYS) as PointField[]) {
    const key = keyIn(first, POINT_KEYS[field]);
    if (key === undefined) unmapped.push(field);
    else mapped[field] = key;
  }

  const describe = (row: Record<string, unknown>): string => Object.keys(row).join(", ") || "<empty>";
  if (mapped.date === undefined || mapped.close === undefined) {
    throw new StockbitError(
      "schema_drift",
      `Chart points for ${symbol} (${timeframe}) carry no recognisable ` +
        `${mapped.date === undefined ? "date" : "close"} field. Keys present: ${describe(first)}.`,
    );
  }

  const read = (row: Record<string, unknown>, field: PointField): number | null => {
    const key = mapped[field];
    return key === undefined ? null : numberish(row[key]);
  };

  const bars: Bar[] = located.rows.map((row, index) => {
    const date = tradeDate(row[mapped.date as string]);
    const close = read(row, "close");
    if (date === null || close === null) {
      throw new StockbitError(
        "schema_drift",
        `Chart point ${index} for ${symbol} (${timeframe}) has no usable ` +
          `${date === null ? "date" : "close"}. Keys present: ${describe(row)}. The whole series is ` +
          "refused rather than returned with a hole in it.",
      );
    }
    return {
      date,
      open: read(row, "open") ?? close,
      high: read(row, "high") ?? close,
      low: read(row, "low") ?? close,
      close,
      average: read(row, "average") ?? close,
      volume: read(row, "volume") ?? 0,
      value: read(row, "value") ?? 0,
      frequency: read(row, "frequency") ?? 0,
      change: read(row, "change") ?? 0,
      changePercent: read(row, "changePercent") ?? 0,
      foreignBuy: read(row, "foreignBuy") ?? 0,
      foreignSell: read(row, "foreignSell") ?? 0,
      netForeign: read(row, "netForeign") ?? 0,
    };
  });

  // Ordering is unobserved and the paged endpoint returns newest-first, so sorting is not
  // redundant: everything downstream assumes ascending time and a reversed series computes
  // plausible, wrong numbers.
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const warnings: string[] = [];
  // Absent is not the only way to be flat. /charts/:symbol/daily sends open/high/low/volume as
  // EMPTY STRINGS, so the keys are mapped, `unmapped` stays clean, and `numberish("")` returns null
  // — every bar silently took its close for all three and nothing said so. A field that reads null
  // on every row is as unusable as one that was never there, and the caller has to be told.
  const flat = (["open", "high", "low"] as const).filter(
    (f) => unmapped.includes(f) || located.rows.every((row) => read(row, f) === null),
  );
  if (flat.length > 0) {
    warnings.push(
      `No usable ${flat.join("/")} arrived — absent, or present and empty on every bar — so those ` +
        "are filled from close and every candle is " +
        "flat. Do not run candlestick pattern detection or a high/low-based indicator on this series.",
    );
  }
  if (unmapped.includes("volume")) {
    warnings.push("No volume field was found; volume is 0 on every bar and is not a real zero.");
  }

  const consumed = new Set(Object.values(mapped));
  return {
    symbol,
    timeframe,
    source: "charts",
    bars,
    from: bars[0]?.date,
    to: bars[bars.length - 1]?.date,
    dataPath: located.path,
    mapped,
    unmapped,
    extraKeys: Object.keys(first).filter((k) => !consumed.has(k)),
    warnings,
    sample: first,
  };
}

/**
 * A whole daily price series in ONE request.
 *
 * The paged path this replaces walks 12 rows at a time and ignores every widening parameter, so a
 * year of history is roughly 21 upstream calls and three years roughly 62. That request count is
 * the constraint behind every cost figure in `scan`, `backtest` and `timeframe_alignment`.
 *
 * Throws rather than returning an empty series when the response cannot be projected — including
 * when it parses but holds no points. That is deliberate and is the whole contract: a caller that
 * received `bars: []` could not tell "this symbol has no history" from "this fast path stopped
 * working", and would silently serve an empty chart forever. Raising means the fallback to the
 * paged walk is a decision the caller makes, not an accident.
 */
export async function getSeriesBars(symbol: string, timeframe: string): Promise<ChartSeries> {
  const sym = normalizeSymbol(symbol);
  const tf = normalizeChartTimeframe(timeframe);
  // A daily series only changes when a session prints, but the last bar moves all day; 60s is the
  // same lifetime `src/core/bars.ts` gives the page that contains today.
  return cached(`chartSeries:${sym}:${tf}`, CACHE.brokerSummaryTtlMs, async () => {
    const params: QueryParams = { timeframe: tf };
    if (NEEDS_PREVIOUS_HISTORICAL.includes(tf)) params.is_include_previous_historical = true;
    const data = await readData("chartsDaily", "chart series", { segments: { symbol: sym }, params });
    return projectSeries(sym, tf, data);
  });
}

/**
 * The chart route's payload, unprojected.
 *
 * The sibling of the route `getSeriesBars` reads, and the one to reach for when a projected series
 * comes back with a non-empty `unmapped` or `extraKeys`: it returns exactly what Stockbit sends, so
 * the real field spellings can be read off it and `POINT_KEYS` corrected. It is not a fallback for
 * `getSeriesBars` and is never called automatically — a silent second attempt against a different
 * route would make "which endpoint answered" unknowable.
 */
export async function getChartRaw(symbol: string, timeframe: string): Promise<unknown> {
  const sym = normalizeSymbol(symbol);
  const tf = normalizeChartTimeframe(timeframe);
  return cached(`chartRaw:${sym}:${tf}`, CACHE.brokerSummaryTtlMs, () => {
    const params: QueryParams = { timeframe: tf };
    if (NEEDS_PREVIOUS_HISTORICAL.includes(tf)) params.is_include_previous_historical = true;
    return readData("charts", "chart", { segments: { symbol: sym }, params });
  });
}

/* ================================ enum vocabularies ================================ */

/** Sides of the running-trade tape. Wire form is `RUNNING_TRADE_ACTION_TYPE_<value>`. */
/**
 * The most rows the running-trade tape will ever return, whatever `limit` says.
 *
 * OBSERVED BEHAVIOUR, not a documented maximum — the same distinction
 * `INSIDER_TRANSACTIONS_LIMIT_CEILING` draws next door. Measured directly on 2026-09-01 against
 * BBRI: `limit=100` returned 100 rows, `limit=101` returned 100, `limit=250` returned 100. Never
 * an error, always a silent truncation. That agrees with the 2026-08-28 probe recorded on
 * `getRunningTrade` below and with a 2026-08-31 field report that got byte-identical responses for
 * 200 and 3000, so the boundary is pinned at 100 rather than merely bracketed.
 *
 *
 * Refused rather than clamped. Nothing in the response marks the truncation, so a caller who asked
 * for 250 would be handed 100 and no way to notice — and because `order_by` starts every window at
 * the session open and `offset`/`page` were measured to move nothing, the rows they wanted are not
 * reachable through this route at any limit. Being told that is the useful answer.
 */
export const RUNNING_TRADE_MAX_LIMIT = 100;

export const RUNNING_TRADE_ACTIONS = ["ALL", "BUY", "SELL"] as const;
/** The three orderings the endpoint accepts. `0` and `4` were measured to be rejected. */
export const RUNNING_TRADE_ORDER_BY = [1, 2, 3] as const;
export type RunningTradeAction = (typeof RUNNING_TRADE_ACTIONS)[number];

/** Trade-book views. `BIG_MONEY` restricts to large prints. Wire form is `TRADE_BOOK_MODE_<value>`. */
export const TRADE_BOOK_MODES = ["OVERALL", "BIG_MONEY"] as const;
export type TradeBookMode = (typeof TRADE_BOOK_MODES)[number];

/**
 * Which auction phases to leave out. Wire form is `TRADE_BOOK_DATA_MODE_<value>`.
 *
 * Pre-opening and post-closing prints are matched at a single auction price and can distort a
 * session's distribution badly, which is why excluding them is a first-class option rather than
 * something a caller filters afterwards.
 */
export const TRADE_BOOK_DATA_MODES = ["EXCLUDE_PRE", "EXCLUDE_POST"] as const;
export type TradeBookDataMode = (typeof TRADE_BOOK_DATA_MODES)[number];

/**
 * Sort keys, wire form `SORT_BY_<value>`.
 *
 * **This list is PARTIAL.** These four are the ones this project knows of; the endpoint accepts
 * others that have not been enumerated. So `normalizeSortKey` validates the *shape* of the value and
 * lets an unlisted-but-well-formed key through rather than refusing it — a closed `z.enum` here
 * would reject valid sort keys purely because nobody has written them down yet.
 */
const SORT_KEYS = ["TIME", "QUEUE", "LOT", "PRICE"] as const;

const SORT_KEY_RE = /^[A-Z][A-Z0-9_]{0,30}$/;

/** `lot` or `SORT_BY_LOT` to the wire spelling `SORT_BY_LOT`. */
export function normalizeSortKey(input: string): string {
  const raw = typeof input === "string" ? input.trim().toUpperCase() : "";
  // Accept the already-prefixed form so a caller quoting the wire value does not produce
  // SORT_BY_SORT_BY_LOT.
  const key = raw.startsWith("SORT_BY_") ? raw.slice("SORT_BY_".length) : raw;
  if (!SORT_KEY_RE.test(key)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid sort key ${JSON.stringify(input)}: expected an uppercase name such as ` +
        `${SORT_KEYS.join(", ")}. That list is partial, so an unlisted key is allowed, but it must ` +
        "be letters, digits and underscores only.",
    );
  }
  return `SORT_BY_${key}`;
}

/**
 * A positive whole `limit`.
 *
 * No ceiling is imposed: the server's own maximum is unknown here, and inventing one would silently
 * truncate a caller who asked for more. Non-integers and zero are refused because they reach the
 * wire as literal garbage (`limit=NaN`) and this API answers those with a confident 200.
 */
function positiveInt(name: string, value: number, max?: number, note?: string): number {
  if (!Number.isInteger(value) || value <= 0 || (max !== undefined && value > max)) {
    throw new StockbitError(
      "invalid_param",
      max === undefined
        ? `${name} must be a positive whole number, got ${String(value)}`
        : `${name} must be a whole number between 1 and ${max}, got ${String(value)}${note ?? ""}`,
    );
  }
  return value;
}

/**
 * Cache key for a request built from a parameter object.
 *
 * The whole param set goes in, so two calls that differ in any argument are distinct entries.
 * Dropping one — a key of `runningTrade:${symbol}` that ignores `limit` — serves a five-row answer
 * to a caller who asked for fifty, which is a bug this repo has shipped before.
 */
export function keyFor(route: RouteName, params: QueryParams): string {
  // Sorted BY KEY. A bare `.sort()` orders the [k, v] pairs by their default string coercion, so it
  // is really sorting on "key,value" — two different param sets can tie, and the reader is told
  // something other than what happens. Comparing the key alone is both injective and what the line
  // looks like it does.
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${route}:${JSON.stringify(entries)}`;
}

/* ================================ running trade ================================ */

export interface RunningTradeOptions {
  /** Restrict to one ticker. Omitted means the market-wide tape. */
  symbol?: string;
  action?: RunningTradeAction;
  limit?: number;
  /**
   * Row ordering. The endpoint REQUIRES this, and it is NOT a time ordering.
   *
   * Measured 2026-08-28 against BRMS:
   *
   *   `1` — true chronological order FROM THE SESSION OPEN, with real trade sizes (2, 12, 12, 6…).
   *   `2` — lot-ascending: 100 rows, every one a 1-lot trade.
   *   `3` — lot-ascending on a different tiebreak; also every row a 1-lot trade.
   *
   * So the only two things obtainable are "the first prints of the day" and "the smallest prints of
   * the day". **No ordering returns the most recent prints, and none returns the largest.**
   * `offset` and `page` are accepted and change nothing, so the window cannot be moved either.
   *
   * `1` is the default because chronological-with-real-sizes is the only one of the three that
   * answers a question anybody actually asks.
   */
  orderBy?: 1 | 2 | 3;
  /** Read the grouped view (`runningTradeGroup`) instead of the raw tape. */
  grouped?: boolean;
}

/**
 * The running-trade tape: individual prints, with the broker on each side of them.
 *
 * ## This route used to return nothing at all, for two reasons
 *
 * Both were found by probing the live endpoint (2026-08-28) rather than by reading anything, because
 * the parameter names here were guessed when this file was written and recorded as unverified.
 *
 *   1. **`order_by` is a REQUIRED field.** Without it every call returns
 *      `400 {"key":"OrderBy","error":"OrderBy is a required field"}`. So every call this project
 *      has ever made to this route failed. Accepted values are `1`, `2` and `3`; `0` and `4` are
 *      rejected.
 *   2. **The filter parameter is `symbols`, PLURAL.** `symbol` is accepted and silently ignored —
 *      asking for BRMS returned rows for ZONE and WINE. A filter that is quietly dropped is worse
 *      than one that errors, because the answer looks right.
 *
 * `limit` is honoured but the server caps the response at 100 rows.
 *
 * ## What a row carries, observed
 *
 * `time`, `action` (`buy`/`sell` — the aggressor side), `code`, `price`, `lot`, `value {raw}`,
 * `market_board`, and — the surprise — `buyer` and `seller` broker codes with `buyer_type` /
 * `seller_type` marking foreign versus local, plus `buy_order_number` and `sell_order_number`.
 *
 * **Broker identity was observed on a CLOSED market.** IDX closed broker codes in live running trade
 * on 6 December 2021, so whether `buyer`/`seller` stay populated while the session is open is NOT
 * established here. `is_broker_exists` is the per-row flag to check rather than assume.
 */
export async function getRunningTrade(opts: RunningTradeOptions = {}): Promise<unknown> {
  const params: QueryParams = {};
  // Plural. See the note above — the singular form is accepted and ignored.
  if (opts.symbol !== undefined) params.symbols = normalizeSymbol(opts.symbol);
  if (opts.action !== undefined) params.action_type = `RUNNING_TRADE_ACTION_TYPE_${opts.action}`;
  if (opts.limit !== undefined) {
    params.limit = positiveInt(
      "limit",
      opts.limit,
      RUNNING_TRADE_MAX_LIMIT,
      ` — ${RUNNING_TRADE_MAX_LIMIT} is the largest value this endpoint has been seen to answer, and ` +
        `200 and 3000 came back identical to each other. Its window always starts at the session ` +
        `open and offset/page were measured to move nothing, so a bigger limit would not have ` +
        `reached later prints either. Use broker_flow_intraday for the rest of the session: whole ` +
        `day, one-minute resolution, per-broker value and volume`,
    );
  }
  // Always sent: omitting it is a hard 400, so there is no "unset" worth preserving here.
  // Refused here when it is outside the measured set, because 0 and 4 were both seen rejected and
  // a round trip that comes back 400 teaches the caller nothing this file does not already know.
  if (opts.orderBy !== undefined && !RUNNING_TRADE_ORDER_BY.includes(opts.orderBy)) {
    throw new StockbitError(
      "invalid_param",
      `order_by must be one of ${RUNNING_TRADE_ORDER_BY.join(", ")} — 0 and 4 were both refused ` +
        `upstream when measured — got ${String(opts.orderBy)}`,
    );
  }
  params.order_by = String(opts.orderBy ?? 1);
  const route: RouteName = opts.grouped ? "runningTradeGroup" : "runningTrade";
  return cached(keyFor(route, params), CACHE.defaultTtlMs, () =>
    readData(route, opts.grouped ? "running trade group" : "running trade", { params }),
  );
}

/**
 * The intraday running-trade chart for one symbol: per-broker flow on a one-minute grid.
 *
 * Returned unprojected. The name this is registered under used to be a hope rather than a claim —
 * "whether it breaks the session down by broker, by price level or by side is unobserved". Read
 * live on 2026-09-01 against BBRI, it is by broker and by minute:
 *
 *   `data.price_chart_data`  — 335 points, 09:00 → 16:14, each `{date, time, datetime_label,
 *                              value{raw,formatted}, open, high, low}`
 *   `data.broker_chart_data` — TWO series, `TYPE_CHART_VALUE` and `TYPE_CHART_VOLUME`, each with a
 *                              `brokers` code list and `charts: [{broker_code, chart[]}]` on the
 *                              same grid. Five brokers on that reading, not the whole market.
 *   also `from`, `to`, `data_last_updated`, `date_session_info`
 *
 * Worth knowing beside `getRunningTrade` above: that tape shows only the first 100 prints of the
 * day and runs eight to ten minutes behind. This covers the whole session at minute resolution, so
 * it answers the questions the tape cannot.
 */
export async function getRunningTradeChart(symbol: string): Promise<unknown> {
  const sym = normalizeSymbol(symbol);
  return cached(`runningTradeChart:${sym}`, CACHE.defaultTtlMs, () =>
    readData("runningTradeChart", "running trade chart", { segments: { symbol: sym } }),
  );
}

/* ================================== trade book ================================== */

export interface TradeBookOptions {
  symbol?: string;
  mode?: TradeBookMode;
  /** Auction phases to exclude. Sent as repeated parameters, one per value. */
  dataModes?: readonly TradeBookDataMode[];
  /**
   * REQUIRED by the endpoint, and it has no default here because none has been observed.
   *
   * A 2026-08-31 field report called this route with `mode` set and with `mode` omitted and got
   * `400 {"error":"Group by is required","kind":"invalid_param"}` both times. The parameter was
   * absent from this interface entirely, so every call this project could make was a call that
   * could not succeed.
   *
   * Settled on the wire 2026-09-01, on the first candidate. The key really is `group_by` — the
   * same transformation `/order-trade/running-trade` shows, where `"OrderBy is a required field"`
   * means `order_by`. Values, measured against BBRI:
   *
   *   `1` — 200, a book of price levels. This is the view the tool is named for.
   *   `2` — 200, but `book: []` on a closed market, so what it groups by is NOT established.
   *   `0` — 400 `Group by is required`; the server reads it as absent rather than as a value.
   *   `3` — 400 `Your request is invalid`.
   *
   * Still passed through VERBATIM rather than mapped to an enum. Only four values have been tried,
   * and refusing a fifth that this file has never heard of would be the tool telling the caller
   * what the server accepts on the strength of one afternoon.
   */
  groupBy?: string;
  limit?: number;
  /** Read the chart form (`tradeBookChart`) instead of the table. */
  chart?: boolean;
}

/**
 * Traded volume by price level for a session.
 *
 * `dataModes` goes on the wire as a repeated key rather than a comma-joined value, matching the
 * form `brokerActivity` needed — this API reads only the first item out of a joined list and answers
 * 200, so the joined shape returns a confidently narrower result instead of an error. Whether this
 * particular endpoint wants repeated or joined is unverified.
 */
export async function getTradeBook(opts: TradeBookOptions = {}): Promise<unknown> {
  const params: QueryParams = {};
  if (opts.symbol !== undefined) params.symbol = normalizeSymbol(opts.symbol);
  if (opts.mode !== undefined) params.mode = `TRADE_BOOK_MODE_${opts.mode}`;
  if (opts.dataModes !== undefined && opts.dataModes.length > 0) {
    params.data_mode = opts.dataModes.map((m) => `TRADE_BOOK_DATA_MODE_${m}`);
  }
  if (opts.limit !== undefined) params.limit = positiveInt("limit", opts.limit);
  const groupBy = opts.groupBy?.trim();
  // Only the table route is known to demand it. The chart route is a different endpoint and the
  // 400 was never seen from it, so requiring it there too would be this file inventing a rule.
  if (!groupBy && opts.chart !== true) {
    throw new StockbitError(
      "invalid_param",
      "trade book needs group_by: without it the endpoint answers " +
        '400 {"error":"Group by is required"} whatever else is sent, so there is no argument ' +
        "combination that works without one. Pass group_by=1 for the by-price book, which is the " +
        "view this tool is named for. Measured 2026-09-01: 1 and 2 are accepted, 0 answers the " +
        "same 400 as omitting it, and 3 answers `Your request is invalid`. What 2 groups by is not " +
        "established — it answered with an empty book outside session hours.",
    );
  }
  // Sent exactly as given. Prefixing it the way `mode` is prefixed would be a guess about a
  // vocabulary nothing here has seen, and a wrong guess reads as a working call that filters to
  // something the caller did not ask for.
  if (groupBy) params.group_by = groupBy;
  const route: RouteName = opts.chart ? "tradeBookChart" : "tradeBook";
  return cached(keyFor(route, params), CACHE.defaultTtlMs, () =>
    readData(route, opts.chart ? "trade book chart" : "trade book", { params }),
  );
}

/* ============================== movers & top stocks ============================== */

/**
 * The order-trade service's own market movers.
 *
 * Not the same endpoint as `top_movers` in `src/core/emitten.ts`, which reads the hotlist, and the
 * two are not guaranteed to agree — a caller comparing them is comparing two services, not
 * validating one. No filter is sent beyond `limit`: this endpoint's category vocabulary has not been
 * observed, and a guessed one would narrow the answer silently.
 */
export async function getMarketMovers(limit?: number): Promise<unknown> {
  const params: QueryParams = {};
  if (limit !== undefined) params.limit = positiveInt("limit", limit);
  return cached(keyFor("marketMover", params), CACHE.defaultTtlMs, () =>
    readData("marketMover", "market mover", { params }),
  );
}

/** The order-trade service's top-stock list. Same caveats as `getMarketMovers`. */
export async function getTopStocks(limit?: number): Promise<unknown> {
  const params: QueryParams = {};
  if (limit !== undefined) params.limit = positiveInt("limit", limit);
  return cached(keyFor("topStock", params), CACHE.defaultTtlMs, () =>
    readData("topStock", "top stock", { params }),
  );
}

/* ================================= order queue ================================= */

export interface OrderQueueOptions {
  symbol: string;
  /** A `SORT_KEYS` value or any other well-formed key; see `normalizeSortKey`. */
  sortBy?: string;
  limit?: number;
}

/**
 * The live order queue for one symbol.
 *
 * Cached for the quote TTL rather than the list one: a queue is the most perishable thing this
 * module reads, and a stale queue is a wrong answer about what is currently resting on the book.
 */
export async function getOrderQueue(opts: OrderQueueOptions): Promise<unknown> {
  // `stock_code`, not `symbol`. Settled live on 2026-08-29: `symbol`, `code`, `emiten_code`,
  // `stockCode` and `company` all come back 400 "Stock code is required"; `stock_code` answers.
  // The tool had always sent `symbol`, so this endpoint had never once returned data.
  const params: QueryParams = { stock_code: normalizeSymbol(opts.symbol) };
  if (opts.sortBy !== undefined) params.sort_by = normalizeSortKey(opts.sortBy);
  if (opts.limit !== undefined) params.limit = positiveInt("limit", opts.limit);
  return cached(keyFor("orderQueue", params), CACHE.quoteTtlMs, () =>
    readData("orderQueue", "order queue", { params }),
  );
}

/* ================================ market session ================================ */

/**
 * Where the trading day currently is: pre-opening, session 1, break, session 2, closed.
 *
 * Cached for 5 seconds and not longer. This reading is what a caller uses to decide whether an empty
 * movers list or a still order queue is normal, and being wrong about it for five minutes would make
 * every one of those judgements wrong too — a cheap request is the right trade.
 */
export async function getMarketSession(): Promise<unknown> {
  return cached("marketSession", CACHE.defaultTtlMs, () => readData("marketSession", "market session"));
}

/* ================================= batch prices ================================= */

/** Our own ceiling on one batch, to keep a query string from growing without bound. */
export const PRICES_BATCH_MAX = 50;

export interface PricesBatch {
  /** What was asked for, normalized and de-duplicated. */
  requested: string[];
  /** Symbols a returned row mentions. */
  found: string[];
  /** Symbols asked for that no row mentions. See the note on `getPricesBatch`. */
  missing: string[];
  rows: Array<Record<string, unknown>>;
  /** Where the rows were located, or `null` when the response held no row array at all. */
  dataPath: string | null;
  /** The `data` block verbatim when no rows could be located, so nothing is lost. */
  raw?: unknown;
}

/**
 * Which requested symbols a row mentions.
 *
 * Deliberately matched against the row's own string *values* rather than a named field. The key the
 * symbol lives under is unobserved, and picking one would mean this check reports every symbol
 * missing the moment the guess is wrong — turning the diagnostic into the thing it was meant to
 * diagnose.
 */
function symbolsIn(row: Record<string, unknown>, requested: readonly string[]): string[] {
  const values = new Set(
    Object.values(row)
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toUpperCase()),
  );
  return requested.filter((s) => values.has(s));
}

/**
 * Last price for several symbols in one request.
 *
 * The multi-value encoding is the open question. `stock_code` is singular, so the symbols are sent
 * comma-joined; if the endpoint in fact wants a repeated key it will read only the first and answer
 * 200 with one row, exactly the silent narrowing that `brokerActivity` was bitten by.
 *
 * That is why the result reports `found` and `missing` instead of just rows. A wrong encoding then
 * shows up as "asked for six, one found, five missing" — a loud, correct description of what
 * happened — rather than as a short list nobody questions. `missing` is not proof a symbol has no
 * price; it means no returned row mentioned it.
 */
export async function getPricesBatch(symbols: readonly string[]): Promise<PricesBatch> {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new StockbitError("invalid_param", "At least one symbol is required");
  }
  const requested = [...new Set(symbols.map((s) => normalizeSymbol(s)))];
  if (requested.length > PRICES_BATCH_MAX) {
    throw new StockbitError(
      "invalid_param",
      `Too many symbols (${requested.length}); this client sends at most ${PRICES_BATCH_MAX} per ` +
        "request. Split the list and call again.",
    );
  }

  const params: QueryParams = { stock_code: requested.join(",") };
  return cached(keyFor("pricesBatch", params), CACHE.quoteTtlMs, async () => {
    const data = await readData("pricesBatch", "batch prices", { params });
    const located = locateRows(data);
    if (!located) {
      return { requested, found: [], missing: [...requested], rows: [], dataPath: null, raw: data };
    }
    const found = [...new Set(located.rows.flatMap((row) => symbolsIn(row, requested)))];
    return {
      requested,
      found,
      missing: requested.filter((s) => !found.includes(s)),
      rows: located.rows,
      dataPath: located.path,
    };
  });
}

/* ================================ market prices ================================ */

/** Board names are passed through uppercased and unprefixed; see `getMarketPrices`. */
const BOARD_RE = /^[A-Z][A-Z0-9_]{1,19}$/;

export interface MarketPricesOptions {
  symbol: string;
  /** `YYYY-MM-DD`. Omitted means the current session. */
  date?: string;
  /** Market boards, e.g. REGULER, NEGO, TUNAI. Sent as repeated parameters. */
  boards?: readonly string[];
}

/**
 * One symbol's prices broken down by market board, for a session.
 *
 * Board values are sent **unprefixed**. This repo already carries two prefixed board vocabularies
 * that disagree with each other — `MARKET_BOARD_` on broker summary, `MARKET_TYPE_` on broker
 * distribution, and sending one endpoint's spelling to the other 400s — so inventing a third prefix
 * here would be guessing twice over. The caller's value goes out as written, uppercased.
 */
export async function getMarketPrices(opts: MarketPricesOptions): Promise<unknown> {
  const sym = normalizeSymbol(opts.symbol);
  const params: QueryParams = {};
  const date = opts.date === undefined ? undefined : normalizeTradeDate(opts.date, "date");
  if (date !== undefined) params.date = date;
  if (opts.boards !== undefined && opts.boards.length > 0) {
    params.boards = opts.boards.map((b) => {
      const board = String(b).trim().toUpperCase();
      if (!BOARD_RE.test(board)) {
        throw new StockbitError(
          "invalid_param",
          `Invalid market board ${JSON.stringify(b)}: expected an uppercase name such as REGULER, ` +
            "NEGO or TUNAI",
        );
      }
      return board;
    });
  }
  // A session that closed before today can no longer change; only a request touching today needs a
  // short lifetime. Same split `src/core/brokerdistribution.ts` makes for a settled date range.
  const ttl = date !== undefined && date < todayIso() ? CACHE.keystatsTtlMs : CACHE.quoteTtlMs;
  return cached(`${keyFor("pricesMarket", params)}:${sym}`, ttl, () =>
    readData("pricesMarket", "market prices", { segments: { symbol: sym }, params }),
  );
}
