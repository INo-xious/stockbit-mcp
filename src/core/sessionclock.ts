/**
 * Where the IDX trading day is right now, in Jakarta time.
 *
 * Half the confusing answers this server gives are really one answer: the market was shut. Empty
 * movers, a broker summary with no rows, a quote that has not moved in three hours — all of them
 * look like a broken tool and none of them is. So `status` reports the session, and a model can say
 * "the market closed at 15:50 WIB" instead of "no data was returned".
 *
 * ## What this does and does not know
 *
 * The weekly schedule is fixed and public: Monday–Thursday 09:00–12:00 and 13:30–15:50, Friday
 * 09:00–11:30 and 14:00–15:50, with pre-opening from 08:45 and post-closing to 16:15. Those are
 * modelled here.
 *
 * **Holidays are not.** IDX closes for national holidays and for the Idul Fitri week, which move
 * every year, and a hard-coded table would be confidently wrong the first time it went stale — the
 * worst failure available, because the answer would still look authoritative. The live
 * `market_session` tool asks Stockbit, and `note` says so.
 *
 * WIB is UTC+7 with no daylight saving, so a fixed offset is exact rather than approximate. It is
 * computed by shifting into UTC and reading UTC fields, which avoids depending on the host's
 * timezone database — an MCP server runs wherever the client launched it.
 *
 * ## Why every reading is given twice
 *
 * One session in the field carried three clocks at once: tool payloads stamped in UTC, this clock
 * in WIB, and a host machine in a third zone entirely — so a single event had three different
 * readings and correlating them meant doing the arithmetic by hand, every time. Leading with WIB is
 * right, because the market clock is the one that decides whether a quote can move. But the rest of
 * this server's output is UTC, so each WIB field carries a `…Utc` sibling naming the same instant.
 *
 * The siblings are additive rather than a `{ wib, utc }` swap: `nowWib` is what every existing
 * caller reads, and a shape change would break them all to save a few characters.
 */

/** IDX is UTC+7 year-round. */
const WIB_OFFSET_MINUTES = 7 * 60;

export type SessionPhase =
  | "weekend"
  | "closed"
  | "pre-opening"
  | "session-1"
  | "break"
  | "session-2"
  | "pre-closing"
  | "post-closing";

export interface SessionClock {
  /** `YYYY-MM-DD HH:MM` in WIB. */
  nowWib: string;
  /**
   * The same instant as `nowWib`, ISO-8601 in UTC — the clock the rest of this server's output uses.
   *
   * Carries seconds where `nowWib` is truncated to the minute, deliberately: the whole point is
   * cross-referencing against tool payloads stamped like `2026-08-30T19:55:14Z`, and rounding the
   * one field that exists to be compared would take the comparison away.
   */
  nowUtc: string;
  /** `Monday` … `Sunday`, in WIB. */
  weekday: string;
  phase: SessionPhase;
  /** True during session 1 or session 2 — when a price can actually change. */
  isTradingHours: boolean;
  /** When the next continuous session begins, `YYYY-MM-DD HH:MM` WIB. Absent while one is open. */
  nextOpenWib?: string;
  /** The same instant as `nextOpenWib`, ISO-8601 in UTC. Present exactly when `nextOpenWib` is. */
  nextOpenUtc?: string;
  /** What this clock does not model. Always present, because it is always relevant. */
  note: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const NOTE =
  "Weekly schedule only — IDX public holidays and the Idul Fitri closure are not modelled here, " +
  "because a hard-coded table goes stale and then lies with confidence. Call `market_session` to " +
  "ask Stockbit whether today is actually a trading day.";

/** Minutes since midnight. */
const at = (hours: number, minutes: number): number => hours * 60 + minutes;

/** The continuous-trading windows for one weekday, in WIB minutes. */
function sessionsFor(day: number): { open: number; close: number }[] {
  if (day === 0 || day === 6) return [];
  // Friday's break is longer: session 2 starts at 14:00 rather than 13:30.
  return day === 5
    ? [
        { open: at(9, 0), close: at(11, 30) },
        { open: at(14, 0), close: at(15, 50) },
      ]
    : [
        { open: at(9, 0), close: at(12, 0) },
        { open: at(13, 30), close: at(15, 50) },
      ];
}

function shiftToWib(now: Date): Date {
  return new Date(now.getTime() + WIB_OFFSET_MINUTES * 60_000);
}

/**
 * Today's calendar date in Jakarta, as `YYYY-MM-DD`.
 *
 * `todayIso` in `dates.ts` answers the same question in UTC, and for seven hours of every day the
 * two disagree: at 02:00 WIB it is still yesterday in UTC. A market window that ends "today" has to
 * mean the trading day the user is living in, so anything building one from a relative period reads
 * this rather than the UTC date.
 *
 * Lives here because this module already owns `WIB_OFFSET_MINUTES`, and a second copy of the offset
 * is exactly the kind of duplication that drifts.
 */
export function wibTodayIso(now: Date = new Date()): string {
  return shiftToWib(now).toISOString().slice(0, 10);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatWib(wib: Date, minutesOverride?: number): string {
  const date = `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())}`;
  const minutes = minutesOverride ?? wib.getUTCHours() * 60 + wib.getUTCMinutes();
  return `${date} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * ISO-8601, exactly as every other timestamp in this server is stamped.
 *
 * A raw `toISOString()`, milliseconds and all. Trimming them to `…:14Z` looks tidier and was the
 * first thing tried here, but it would have made this the only bespoke timestamp format in the
 * tree — against 37 raw `toISOString()` sites — and the entire point of these fields is that a
 * reading can be compared against the server's other output without thinking about it. A second
 * format is the problem this issue exists to remove, not a polish on it.
 */
function iso(instant: Date): string {
  return instant.toISOString();
}

/**
 * The real instant a WIB wall-clock reading refers to.
 *
 * Built from the shifted date's calendar fields and undone by the same offset, rather than by
 * reformatting the WIB string: subtracting seven hours can roll the reading back into the previous
 * DAY, and a 09:00 open on Monday is 02:00Z on Monday but a 06:00 open would be the Sunday before.
 * Deriving both strings from one instant is what keeps the pair from ever disagreeing.
 */
function wibInstant(wib: Date, minutesOverride?: number): Date {
  const minutes = minutesOverride ?? wib.getUTCHours() * 60 + wib.getUTCMinutes();
  const midnight = Date.UTC(wib.getUTCFullYear(), wib.getUTCMonth(), wib.getUTCDate());
  return new Date(midnight + (minutes - WIB_OFFSET_MINUTES) * 60_000);
}

/** One moment on the trading calendar, in both clocks, from a single instant. */
interface Moment {
  wib: string;
  utc: string;
}

function moment(wibDay: Date, minutesOverride?: number): Moment {
  return { wib: formatWib(wibDay, minutesOverride), utc: iso(wibInstant(wibDay, minutesOverride)) };
}

/** The next weekday at `minutes`, searching forward from `wib` (exclusive of today when `skipToday`). */
function nextOpening(wib: Date, skipToday: boolean): Moment {
  for (let ahead = skipToday ? 1 : 0; ahead <= 7; ahead++) {
    const day = new Date(wib.getTime() + ahead * 86_400_000);
    const sessions = sessionsFor(day.getUTCDay());
    if (!sessions.length) continue;
    if (ahead === 0) {
      const minutes = wib.getUTCHours() * 60 + wib.getUTCMinutes();
      const upcoming = sessions.find((s) => minutes < s.open);
      if (upcoming) return moment(day, upcoming.open);
      continue;
    }
    return moment(day, sessions[0].open);
  }
  // Unreachable with a five-day week, but returning something honest beats throwing from a clock.
  return moment(wib);
}

/**
 * Read the clock.
 *
 * `now` is injectable so the tests are not a function of when they run — a session clock whose
 * tests only pass on a Tuesday afternoon is not a tested clock.
 */
export function sessionClock(now: Date = new Date()): SessionClock {
  const wib = shiftToWib(now);
  const day = wib.getUTCDay();
  const minutes = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  const nowWib = formatWib(wib);
  const weekday = WEEKDAYS[day];
  // `nowUtc` is `now` itself, not a round-trip through the WIB rendering: that would silently drop
  // the seconds, which are exactly what a caller needs to line this up against a payload stamp.
  const base = { nowWib, nowUtc: iso(now), weekday, note: NOTE };

  /** Spread a moment into the pair of fields, so neither can be set without the other. */
  const nextOpen = (m: Moment) => ({ nextOpenWib: m.wib, nextOpenUtc: m.utc });

  if (day === 0 || day === 6) {
    return { ...base, phase: "weekend", isTradingHours: false, ...nextOpen(nextOpening(wib, true)) };
  }

  const [first, second] = sessionsFor(day);

  if (minutes < at(8, 45)) {
    return { ...base, phase: "closed", isTradingHours: false, ...nextOpen(moment(wib, first.open)) };
  }
  if (minutes < first.open) {
    return { ...base, phase: "pre-opening", isTradingHours: false, ...nextOpen(moment(wib, first.open)) };
  }
  if (minutes < first.close) {
    return { ...base, phase: "session-1", isTradingHours: true };
  }
  if (minutes < second.open) {
    return { ...base, phase: "break", isTradingHours: false, ...nextOpen(moment(wib, second.open)) };
  }
  if (minutes < second.close) {
    return { ...base, phase: "session-2", isTradingHours: true };
  }
  if (minutes < at(16, 1)) {
    // 15:50–16:00 is the pre-closing auction and the random close.
    return { ...base, phase: "pre-closing", isTradingHours: false, ...nextOpen(nextOpening(wib, true)) };
  }
  if (minutes <= at(16, 15)) {
    return { ...base, phase: "post-closing", isTradingHours: false, ...nextOpen(nextOpening(wib, true)) };
  }
  return { ...base, phase: "closed", isTradingHours: false, ...nextOpen(nextOpening(wib, true)) };
}

/**
 * The window the alert daemon polls in — deliberately wider than any single phase.
 *
 * Shares the WIB conversion above rather than keeping a second copy of it. It stays generous at the
 * edges on purpose: a daemon that stopped exactly at a session boundary would miss the post-closing
 * print, and a break in the middle of the day is not a reason to stop watching.
 */
export function isWithinPollingWindow(now: Date): boolean {
  const wib = shiftToWib(now);
  const day = wib.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  return minutes >= at(8, 45) && minutes <= at(16, 15);
}
