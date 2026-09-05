/**
 * What to fetch, in what order, and what has already been fetched.
 *
 * Pure: no clock, no network, no filesystem. The planner decides the shape of a 120,000-request
 * backfill, and a decision that large deserves to be exhaustively testable without a single HTTP
 * call.
 *
 * ## Why broker work is one request per (symbol, session)
 *
 * `broker_summary` aggregates its whole window into one buyers/sellers table — a month-wide request
 * returns the month's totals, not thirty daily rows. Per-day bandar behaviour is the entire point of
 * the dataset, so the window has to be a single session and the request count is symbols × sessions.
 * For the 239-name universe over two years that is ~120k requests, which is why the drip exists.
 *
 * Bars are the opposite: `getBars` pages internally, so one work item covers a symbol's whole range.
 *
 * ## Why the default order is most-recent-first
 *
 * A three-week backfill WILL be interrupted — by a reboot, a token expiry, a kill-file, or a change
 * of mind. Ordering date-major from the newest session means an interruption leaves a complete
 * rectangle: every symbol, covering the most recent N sessions. Ordering symbol-major would instead
 * leave complete history for the first few dozen tickers and nothing for the rest, which is not a
 * dataset anything can train on. Recent data is also the data most likely to matter.
 */
import { normalizeTradeDate } from "../core/dates.js";
import { normalizeSymbol } from "../symbol.js";

/**
 * The three things this CLI backfills.
 *
 * `news` (added 2026-09-05) is the stream filtered to the news category, per symbol. Like bars it
 * is one work item per symbol per window: the endpoint takes a date range and pages by cursor, so
 * the request count is symbols x pages, not symbols x sessions. What comes back is HEADLINES with a
 * publisher link - not article bodies - and the raw payload is stored verbatim so that fact stays
 * visible downstream rather than being flattened into a field that pretends otherwise.
 */
export type BatchKind = "bars" | "broker" | "news";

export type PlanOrder = "recent-first" | "oldest-first" | "symbol-major";

/** One request to make. `from`/`to` are inclusive and equal for a single-session broker pull. */
export interface WorkItem {
  kind: BatchKind;
  symbol: string;
  from: string;
  to: string;
  /** Stable identity for checkpointing. Must not change between runs, or resume re-fetches. */
  key: string;
}

export interface PlanOptions {
  kind: BatchKind;
  symbols: readonly string[];
  from: string;
  to: string;
  /** Keys already completed, from the checkpoint file. */
  done?: ReadonlySet<string>;
  order?: PlanOrder;
  /** Hard cap on items returned, applied AFTER ordering so a capped run is a coherent prefix. */
  limit?: number;
}

export function itemKey(kind: BatchKind, symbol: string, from: string, to: string): string {
  return `${kind}:${symbol}:${from}:${to}`;
}

/** Days between two ISO dates, inclusive, as `YYYY-MM-DD`. UTC arithmetic — no timezone drift. */
export function daysBetween(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (end < start) throw new Error(`from ${from} is after to ${to}`);
  const out: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Candidate session dates: weekdays only.
 *
 * IDX public holidays are deliberately NOT modelled, for the reason `core/sessionclock.ts` gives
 * about its own schedule: a hard-coded holiday table goes stale and then lies with confidence.
 * A holiday costs one request that comes back empty, and the runner records that as a real
 * observation ("no session") rather than a failure. Paying ~15 wasted requests a year beats
 * silently skipping a session the table got wrong.
 */
export function sessionDates(from: string, to: string): string[] {
  return daysBetween(from, to).filter((day) => {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  });
}

/**
 * Build the work list.
 *
 * @throws Error when the range or symbols are unusable — loudly, before a long run starts, rather
 *   than 40,000 requests in.
 */
export function plan(opts: PlanOptions): WorkItem[] {
  const from = normalizeTradeDate(opts.from, "from");
  const to = normalizeTradeDate(opts.to, "to");
  if (Date.parse(`${from}T00:00:00Z`) > Date.parse(`${to}T00:00:00Z`)) {
    throw new Error(`from ${from} is after to ${to}`);
  }

  const symbols = [...new Set(opts.symbols.map((s) => normalizeSymbol(s)))];
  if (!symbols.length) throw new Error("no symbols to plan: the symbol list is empty");

  const done = opts.done ?? new Set<string>();
  const order = opts.order ?? "recent-first";
  const items: WorkItem[] = [];

  if (opts.kind === "bars" || opts.kind === "news") {
    // One item per symbol: getBars pages the range internally, and the news fetch follows the
    // stream cursor the same way. A window is the unit of resumption for both.
    const kind = opts.kind;
    for (const symbol of symbols) {
      items.push({ kind, symbol, from, to, key: itemKey(kind, symbol, from, to) });
    }
  } else {
    const dates = sessionDates(from, to);
    if (order === "symbol-major") {
      for (const symbol of symbols) {
        for (const date of dates) {
          items.push({ kind: "broker", symbol, from: date, to: date, key: itemKey("broker", symbol, date, date) });
        }
      }
    } else {
      const ordered = order === "recent-first" ? [...dates].reverse() : dates;
      for (const date of ordered) {
        for (const symbol of symbols) {
          items.push({ kind: "broker", symbol, from: date, to: date, key: itemKey("broker", symbol, date, date) });
        }
      }
    }
  }

  const remaining = items.filter((item) => !done.has(item.key));
  return opts.limit !== undefined ? remaining.slice(0, Math.max(0, opts.limit)) : remaining;
}

/** How much of a plan is left, for progress reporting and the daily "still alive" ping. */
export function planSummary(opts: PlanOptions): { total: number; done: number; remaining: number } {
  const all = plan({ ...opts, done: new Set(), limit: undefined });
  const remaining = plan({ ...opts, limit: undefined });
  return { total: all.length, done: all.length - remaining.length, remaining: remaining.length };
}
