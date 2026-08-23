/**
 * Trading-date validation — the single door a user-supplied date passes through before it can
 * shape a request, in the same spirit as `symbol.ts`.
 *
 * This exists because of how the broker-summary endpoint fails: nearly every bad date input returns
 * **HTTP 200 with the latest session** rather than an error. Measured against the live API:
 *
 *   from=2026-07-28&to=2026-08-01   → the real range          ✅
 *   from=2026-07-28  (no `to`)      → **today's session**, 200 — the lone date is ignored
 *   date_from=…&date_to=…           → **today's session**, 200 — parameter names ignored
 *   start_date=…&end_date=…         → **today's session**, 200 — parameter names ignored
 *   from=20260728                   → error (dashes are required)
 *   from=2026/07/27                 → error
 *   from > to                       → error
 *
 * A caller who mistypes a parameter therefore gets a confident, wrong answer instead of a failure.
 * Validating here converts every one of those into a loud, specific error before the request goes
 * out.
 */
import { StockbitError } from "../http/errors.js";

/** Anchored: the API rejects `YYYYMMDD` and `YYYY/MM/DD`, so only the dashed form is accepted. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate one `YYYY-MM-DD` date.
 *
 * The calendar check matters: `2026-02-30` matches the pattern but is not a day. JavaScript's Date
 * would silently roll it to 2026-03-02, so the request would succeed and return data for a date the
 * caller never asked for.
 */
export function normalizeTradeDate(input: unknown, field = "date"): string {
  if (typeof input !== "string") {
    throw new StockbitError("invalid_param", `${field} must be a string in YYYY-MM-DD form`);
  }
  const value = input.trim();
  if (!DATE_RE.test(value)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${field} ${JSON.stringify(input)}: expected YYYY-MM-DD (e.g. 2026-08-03). ` +
        "Compact (20260803) and slashed (2026/08/03) forms are rejected by the API.",
    );
  }
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${field} ${JSON.stringify(input)}: not a real calendar date`,
    );
  }
  return value;
}

export interface DateRange {
  from: string;
  to: string;
}

/** The alias spellings accepted from callers. Only `from`/`to` ever reach the wire. */
export interface DateRangeInput {
  from?: unknown;
  to?: unknown;
  date_from?: unknown;
  date_to?: unknown;
  start_date?: unknown;
  end_date?: unknown;
}

const START_ALIASES = ["from", "date_from", "start_date"] as const;
const END_ALIASES = ["to", "date_to", "end_date"] as const;

function present(v: unknown): v is string {
  return v !== undefined && v !== null && String(v).trim() !== "";
}

/**
 * Collapse the accepted spellings onto one value per side.
 *
 * `date_from`/`start_date` are accepted for convenience — a caller (or a model driving the tool)
 * reasonably guesses those names — but the API ignores both, so they are translated to `from`/`to`
 * here and never sent. Two different values for the same side is a mistake, not a precedence
 * question, so it is rejected rather than silently resolved.
 */
function collapse(input: DateRangeInput, aliases: readonly string[], side: string): string | undefined {
  const supplied = aliases
    .filter((key) => present((input as Record<string, unknown>)[key]))
    .map((key) => [key, String((input as Record<string, unknown>)[key]).trim()] as const);

  if (supplied.length === 0) return undefined;
  const distinct = new Set(supplied.map(([, v]) => v));
  if (distinct.size > 1) {
    throw new StockbitError(
      "invalid_param",
      `Conflicting ${side} dates: ${supplied.map(([k, v]) => `${k}=${v}`).join(", ")}. ` +
        "These are aliases for the same parameter; supply only one.",
    );
  }
  return supplied[0][1];
}

/**
 * Resolve and validate a date range, or `undefined` when the caller supplied none.
 *
 * Both ends are required together. A lone `from` is the worst input this endpoint accepts: it
 * returns HTTP 200 with the latest session, so the caller believes they queried a window when they
 * actually got one day.
 */
export function normalizeDateRange(input: DateRangeInput): DateRange | undefined {
  const rawFrom = collapse(input, START_ALIASES, "start");
  const rawTo = collapse(input, END_ALIASES, "end");

  if (rawFrom === undefined && rawTo === undefined) return undefined;
  if (rawFrom === undefined || rawTo === undefined) {
    const given = rawFrom === undefined ? "to" : "from";
    const missing = rawFrom === undefined ? "from" : "to";
    throw new StockbitError(
      "invalid_param",
      `A date range needs both ends: got ${given} but no ${missing}. ` +
        "The API silently returns the latest session for a half-specified range, so it is rejected here. " +
        "For a single day pass the same date twice (from=2026-08-03, to=2026-08-03).",
    );
  }

  const from = normalizeTradeDate(rawFrom, "from");
  const to = normalizeTradeDate(rawTo, "to");
  // ISO dates compare correctly as strings.
  if (from > to) {
    throw new StockbitError("invalid_param", `from (${from}) must not be after to (${to})`);
  }
  return { from, to };
}

/** Today in UTC as `YYYY-MM-DD`. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Whether a range is entirely in the past, and therefore immutable.
 *
 * A closed historical window can never change, so it is safe to cache for a long time. A window
 * whose end is today (or later) is still being written to by the current session and must keep the
 * short TTL.
 */
export function isSettledRange(range: DateRange, now: Date = new Date()): boolean {
  return range.to < todayIso(now);
}

/**
 * A `YYYY-MM-DD` date as the UNIX epoch second of its UTC midnight.
 *
 * TradingView's charting library — and therefore every Chartbit drawing point — locates a shape in
 * time by epoch seconds, not by a date string. Sending a millisecond value silently places the shape
 * about fifty thousand years in the future, which renders as nothing at all rather than as an error,
 * so the conversion belongs in one tested place rather than at each call site.
 *
 * UTC midnight, not local: the daily bars this project draws on are keyed by calendar date, and
 * anchoring to the running machine's zone would move a level by a day for anyone west of Greenwich.
 * Whether Stockbit's daily bars snap to UTC or WIB midnight is a wire fact recorded in
 * `docs/chartbit-drawing.md` once observed; if it is WIB the offset is applied there, once, rather
 * than by re-deciding what "a date" means here.
 */
export function epochSeconds(date: string, field = "date"): number {
  const value = normalizeTradeDate(date, field);
  const [y, m, d] = value.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}
