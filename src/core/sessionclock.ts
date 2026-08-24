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
  /** `Monday` … `Sunday`, in WIB. */
  weekday: string;
  phase: SessionPhase;
  /** True during session 1 or session 2 — when a price can actually change. */
  isTradingHours: boolean;
  /** When the next continuous session begins, `YYYY-MM-DD HH:MM` WIB. Absent while one is open. */
  nextOpenWib?: string;
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

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatWib(wib: Date, minutesOverride?: number): string {
  const date = `${wib.getUTCFullYear()}-${pad(wib.getUTCMonth() + 1)}-${pad(wib.getUTCDate())}`;
  const minutes = minutesOverride ?? wib.getUTCHours() * 60 + wib.getUTCMinutes();
  return `${date} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** The next weekday at `minutes`, searching forward from `wib` (exclusive of today when `skipToday`). */
function nextOpening(wib: Date, skipToday: boolean): string {
  for (let ahead = skipToday ? 1 : 0; ahead <= 7; ahead++) {
    const day = new Date(wib.getTime() + ahead * 86_400_000);
    const sessions = sessionsFor(day.getUTCDay());
    if (!sessions.length) continue;
    if (ahead === 0) {
      const minutes = wib.getUTCHours() * 60 + wib.getUTCMinutes();
      const upcoming = sessions.find((s) => minutes < s.open);
      if (upcoming) return formatWib(day, upcoming.open);
      continue;
    }
    return formatWib(day, sessions[0].open);
  }
  // Unreachable with a five-day week, but returning something honest beats throwing from a clock.
  return formatWib(wib);
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
  const base = { nowWib, weekday, note: NOTE };

  if (day === 0 || day === 6) {
    return { ...base, phase: "weekend", isTradingHours: false, nextOpenWib: nextOpening(wib, true) };
  }

  const [first, second] = sessionsFor(day);

  if (minutes < at(8, 45)) {
    return { ...base, phase: "closed", isTradingHours: false, nextOpenWib: formatWib(wib, first.open) };
  }
  if (minutes < first.open) {
    return { ...base, phase: "pre-opening", isTradingHours: false, nextOpenWib: formatWib(wib, first.open) };
  }
  if (minutes < first.close) {
    return { ...base, phase: "session-1", isTradingHours: true };
  }
  if (minutes < second.open) {
    return { ...base, phase: "break", isTradingHours: false, nextOpenWib: formatWib(wib, second.open) };
  }
  if (minutes < second.close) {
    return { ...base, phase: "session-2", isTradingHours: true };
  }
  if (minutes < at(16, 1)) {
    // 15:50–16:00 is the pre-closing auction and the random close.
    return { ...base, phase: "pre-closing", isTradingHours: false, nextOpenWib: nextOpening(wib, true) };
  }
  if (minutes <= at(16, 15)) {
    return { ...base, phase: "post-closing", isTradingHours: false, nextOpenWib: nextOpening(wib, true) };
  }
  return { ...base, phase: "closed", isTradingHours: false, nextOpenWib: nextOpening(wib, true) };
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
