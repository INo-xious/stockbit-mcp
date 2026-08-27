/**
 * The `<time-frame>` argument: turning what a person types into a polling interval.
 *
 * The command is `/<name> <scope> <time-frame> <prompt>`, so this parses exactly one word-ish token
 * out of the middle. It accepts what someone would actually type — `5m`, `5 minutes`, `5 menit`,
 * `realtime`, `real-time`, `30s` — and it is deliberately strict about everything else: an
 * unrecognised token is an error, never a silent fall back to the default. A watcher that quietly
 * polls every five minutes when the user asked for thirty seconds is worse than one that refuses to
 * start, because the user has no way to tell.
 *
 * ## "Real time" is a promise this data source cannot keep
 *
 * Measured against the live API: `/order-trade/running-trade` is EIGHT TO TEN MINUTES BEHIND, and the
 * cumulative aggregates that `tape.ts` differences refresh on their own cadence — under two minutes
 * between observed changes, but the absolute lag was never established. So the fastest honest
 * interval is not "as fast as the loop can spin".
 *
 * `realtime` therefore resolves to {@link FASTEST_MS} and is reported back with a caveat rather than
 * accepted silently. The floor is not politeness about rate limits: polling faster than the source
 * updates produces windows where nothing changed, which the detector would read as "the market went
 * quiet" — a false statement about the market caused entirely by our own clock.
 */

/**
 * The shortest interval this data source can honestly support.
 *
 * Twenty seconds. The measured deltas that proved the aggregates were live were taken over ~20s
 * windows and showed real movement (81 of 100 symbols trading), so a window this size is known to
 * contain signal. Shorter has not been shown to.
 */
export const FASTEST_MS = 20_000;

/** What the command uses when the user does not say. The spec fixes this at five minutes. */
export const DEFAULT_MS = 5 * 60_000;

/** An interval a user asked for, after parsing. */
export interface ParsedInterval {
  /** How often to poll, in milliseconds. Never below {@link FASTEST_MS}. */
  ms: number;
  /** Exactly what the user typed, kept so errors and confirmations can quote it back. */
  source: string;
  /** True when the user asked for real time and got the floor instead. */
  clamped: boolean;
  /** True when the token asked for "real time" in some form. */
  realtime: boolean;
}

/** Words that mean "as fast as you can", in both languages this is used in. */
const REALTIME_WORDS = new Set([
  "realtime",
  "real-time",
  "real_time",
  "live",
  "now",
  "langsung",
  "sekarang",
]);

/**
 * Unit suffixes, mapped to milliseconds.
 *
 * Indonesian units are here because that is what he types. `d` and `h` are deliberately ABSENT: a
 * polling interval measured in hours or days is not a live watcher, and accepting one would let a
 * typo like `5h` silently produce a watcher that reports once per trading session.
 */
const UNITS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  detik: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  menit: 60_000,
};

/** The longest interval that is still a "watcher" rather than a scheduled report. */
const SLOWEST_MS = 60 * 60_000;

export class IntervalParseError extends Error {
  constructor(readonly token: string, reason: string) {
    super(`Cannot read "${token}" as a time frame: ${reason}`);
    this.name = "IntervalParseError";
  }
}

/**
 * Parse a time-frame token.
 *
 * @param token what the user typed, or undefined/empty for the default
 * @throws {IntervalParseError} on anything unrecognised — see the note at the top of the file about
 *   why this does not fall back
 */
export function parseInterval(token?: string | null): ParsedInterval {
  const source = (token ?? "").trim();
  if (!source) return { ms: DEFAULT_MS, source: "default", clamped: false, realtime: false };

  const normalized = source.toLowerCase().replace(/\s+/g, "");

  if (REALTIME_WORDS.has(normalized)) {
    return { ms: FASTEST_MS, source, clamped: true, realtime: true };
  }

  // `5m`, `5 minutes`, `30s`, `5menit` — a number, then optionally a unit. A bare number is minutes,
  // because that is what "watch it every 5" means to anyone who says it out loud.
  const match = /^(\d+(?:\.\d+)?)([a-z]*)$/.exec(normalized);
  if (!match) {
    throw new IntervalParseError(source, "expected something like 5m, 30s, 10 minutes, or realtime");
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new IntervalParseError(source, "the number must be greater than zero");
  }

  const unitMs = unit === "" ? UNITS.m : UNITS[unit];
  if (unitMs === undefined) {
    // Naming the units is the difference between a user fixing their typo and a user giving up.
    throw new IntervalParseError(source, `"${unit}" is not a unit I know — use s/sec/detik or m/min/menit`);
  }

  const requested = amount * unitMs;
  if (requested > SLOWEST_MS) {
    throw new IntervalParseError(
      source,
      `that is longer than an hour — a watcher polling that slowly would miss most of a session`,
    );
  }

  const ms = Math.max(FASTEST_MS, requested);
  return { ms, source, clamped: ms !== requested, realtime: false };
}

/** How to say an interval back to a person, so they can confirm it is what they meant. */
export function describeInterval(interval: ParsedInterval): string {
  const seconds = interval.ms / 1000;
  const pretty = seconds >= 60 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`;

  if (interval.realtime) {
    // Say the limitation up front. The user asked for real time and is not getting it, and finding
    // that out later — from an alert about a trade that already happened — is how trust is lost.
    return (
      `every ${pretty} (the fastest this data source supports; Stockbit's REST feed is not tick-by-tick, ` +
      `and its trade tape runs 8-10 minutes behind)`
    );
  }
  if (interval.clamped) {
    return `every ${pretty} — you asked for ${interval.source}, which is faster than the data updates`;
  }
  return `every ${pretty}`;
}
