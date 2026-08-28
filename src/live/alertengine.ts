/**
 * What actually reaches the user, and — mostly — what does not.
 *
 * The detectors decide whether something is true. This decides whether it is worth interrupting
 * someone for, and it is the more important half. Clinical alarm research puts 72-99% of monitor
 * alarms in the false category, and the failure that produces is not annoyance but desensitisation:
 * people stop reading the alerts, including the one that mattered. A screener nobody reads is worse
 * than no screener, because it costs money and buys false confidence.
 *
 * So the hard cap comes first and everything else is secondary. Five per interval, twenty-five per
 * session, ranked by severity then surprise, remainder to a digest.
 *
 * ## Pure by construction
 *
 * All state is held on the instance and every decision takes `now` as an argument, so a whole trading
 * day can be replayed in a unit test in milliseconds. Nothing here reads a clock on its own.
 */
import type { Severity, Signal, SignalKind } from "./signals.js";

export interface FatigueConfig {
  /** Hard ceiling per polling interval. */
  maxPerInterval: number;
  /** Hard ceiling for the whole session. */
  maxPerSession: number;
  /** Same symbol, same signal type. */
  cooldownSameKindMs: number;
  /** Same symbol, different signal type. */
  cooldownCrossKindMs: number;
  /** A new signal bypasses cooldown only if it is this many times stronger than the one holding it. */
  escalationMultiple: number;
  /** A symbol firing more than this in one session gets its thresholds widened. */
  adaptivePerSymbol: number;
  /** ...by this factor, for the rest of the session. */
  adaptiveWidenBy: number;
  /** A signal kind producing more than this share of session alerts is over-firing. */
  adaptiveKindShare: number;
  /** If more than this share of the watched universe trips one signal, it is the index, not a stock. */
  marketWideShare: number;
  /** The lowest severity that may be emitted at all. */
  floor: Severity;
}

export const FATIGUE_DEFAULTS: FatigueConfig = {
  maxPerInterval: 5,
  maxPerSession: 25,
  cooldownSameKindMs: 15 * 60_000,
  cooldownCrossKindMs: 5 * 60_000,
  escalationMultiple: 2,
  adaptivePerSymbol: 5,
  adaptiveWidenBy: 1.5,
  adaptiveKindShare: 0.2,
  marketWideShare: 0.4,
  floor: "watch",
};

const RANK: Record<Severity, number> = { info: 0, watch: 1, alert: 2, critical: 3 };

/** Why a signal did not reach the user. Kept so a digest can explain a quiet interval honestly. */
export type SuppressionReason =
  | "below-floor"
  | "cooldown"
  | "quiet-period"
  | "interval-cap"
  | "session-cap"
  | "market-wide"
  | "duplicate";

export interface Decision {
  signal: Signal;
  emitted: boolean;
  reason?: SuppressionReason;
}

export interface EngineResult {
  /** Ranked, capped, and actually meant to be shown. */
  emitted: Signal[];
  /** Everything else, with the reason. Feeds the digest, never a notification. */
  suppressed: Decision[];
  /** Present when one signal tripped across most of the universe — emit this INSTEAD of the rows. */
  marketWide: { kind: SignalKind; count: number; universe: number; note: string } | null;
}

/**
 * Quiet periods, in WIB minutes-from-midnight, when only CRITICAL gets through.
 *
 * Intraday volume is U-shaped and the first five minutes run 1.5-1.75x baseline volatility, so the
 * open and the close generate signals that are real and useless. The lunch boundaries are here for
 * the same reason in miniature.
 *
 * Friday is a SEPARATE table. Session 1 ends 11:30 and session 2 starts 14:00 rather than
 * 12:00/13:30, so a Monday-to-Thursday table applied on a Friday silences the wrong hour and leaves
 * the actual break unguarded.
 */
const QUIET_MON_THU: [number, number][] = [
  [9 * 60, 9 * 60 + 15],
  [11 * 60 + 55, 12 * 60],
  [13 * 60 + 30, 13 * 60 + 35],
  [15 * 60 + 35, 16 * 60 + 15],
];
const QUIET_FRI: [number, number][] = [
  [9 * 60, 9 * 60 + 15],
  [11 * 60 + 25, 11 * 60 + 30],
  [14 * 60, 14 * 60 + 5],
  [15 * 60 + 35, 16 * 60 + 15],
];

/** WIB is UTC+7 with no daylight saving, so this is a fixed shift rather than a timezone lookup. */
export function wibParts(now: Date): { weekday: number; minutes: number } {
  const wib = new Date(now.getTime() + 7 * 3600_000);
  return { weekday: wib.getUTCDay(), minutes: wib.getUTCHours() * 60 + wib.getUTCMinutes() };
}

export function isQuietPeriod(now: Date): boolean {
  const { weekday, minutes } = wibParts(now);
  if (weekday === 0 || weekday === 6) return false;
  const table = weekday === 5 ? QUIET_FRI : QUIET_MON_THU;
  return table.some(([from, to]) => minutes >= from && minutes < to);
}

interface Fired {
  at: number;
  surprise: number;
  kind: SignalKind;
}

/**
 * Holds one session's alert history and decides what gets through.
 *
 * One instance per watcher. Two watchers should not share a budget — a user watching their portfolio
 * and a user watching the whole market are asking different questions, and merging their caps would
 * silence one on behalf of the other.
 */
export class AlertEngine {
  private readonly lastByKey = new Map<string, Fired>();
  private readonly lastBySymbol = new Map<string, Fired>();
  private readonly firesBySymbol = new Map<string, number>();
  private readonly firesByKind = new Map<SignalKind, number>();
  private sessionCount = 0;

  constructor(private readonly config: FatigueConfig = FATIGUE_DEFAULTS) {}

  /** Dedup identity: the same condition on the same symbol at the same price is one alert. */
  private static key(s: Signal): string {
    return `${s.symbol}|${s.kind}|${s.priceBucket}`;
  }

  /**
   * How much a symbol's thresholds should be widened, given how much it has already fired today.
   *
   * Returned rather than applied, because widening belongs to the detector's inputs and this class
   * must not reach into them. A caller multiplies its thresholds by this.
   */
  widenFactor(symbol: string): number {
    const fires = this.firesBySymbol.get(symbol) ?? 0;
    return fires > this.config.adaptivePerSymbol ? this.config.adaptiveWidenBy : 1;
  }

  /** Signal kinds that produced more than their share of today's alerts, for tomorrow's config. */
  overFiringKinds(): SignalKind[] {
    if (this.sessionCount === 0) return [];
    const out: SignalKind[] = [];
    for (const [kind, n] of this.firesByKind) {
      if (n / this.sessionCount > this.config.adaptiveKindShare) out.push(kind);
    }
    return out;
  }

  /**
   * Decide one interval's worth of signals.
   *
   * @param universe how many symbols were examined, for the market-wide check
   */
  process(signals: Signal[], now: Date, universe: number): EngineResult {
    const nowMs = now.getTime();
    const quiet = isQuietPeriod(now);
    const suppressed: Decision[] = [];

    // Market-wide check first. If most of the universe trips one signal, that is the index moving,
    // and reporting it per symbol would burn the whole interval budget saying one thing many times.
    const byKind = new Map<SignalKind, number>();
    for (const s of signals) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
    let marketWide: EngineResult["marketWide"] = null;
    if (universe > 0) {
      for (const [kind, count] of byKind) {
        if (count / universe > this.config.marketWideShare) {
          marketWide = {
            kind,
            count,
            universe,
            note: `${count} of ${universe} symbols tripped ${kind} at once — that is the market, not a stock.`,
          };
          break;
        }
      }
    }

    const candidates: Signal[] = [];
    for (const s of signals) {
      if (marketWide && s.kind === marketWide.kind) {
        suppressed.push({ signal: s, emitted: false, reason: "market-wide" });
        continue;
      }
      if (RANK[s.severity] < RANK[this.config.floor]) {
        suppressed.push({ signal: s, emitted: false, reason: "below-floor" });
        continue;
      }
      if (quiet && s.severity !== "critical") {
        suppressed.push({ signal: s, emitted: false, reason: "quiet-period" });
        continue;
      }
      candidates.push(s);
    }

    // Rank before capping: severity first, then how far past its own threshold it fired. Ranking
    // after capping would make the cap arbitrary.
    candidates.sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.surprise - a.surprise);

    const emitted: Signal[] = [];
    for (const s of candidates) {
      if (this.sessionCount >= this.config.maxPerSession) {
        suppressed.push({ signal: s, emitted: false, reason: "session-cap" });
        continue;
      }
      if (emitted.length >= this.config.maxPerInterval) {
        suppressed.push({ signal: s, emitted: false, reason: "interval-cap" });
        continue;
      }

      const key = AlertEngine.key(s);
      const sameKey = this.lastByKey.get(key);
      const sameSymbol = this.lastBySymbol.get(s.symbol);

      // A repeat of the exact same condition UPDATES rather than emitting again.
      if (sameKey && nowMs - sameKey.at < this.config.cooldownSameKindMs) {
        if (s.surprise < sameKey.surprise * this.config.escalationMultiple) {
          suppressed.push({ signal: s, emitted: false, reason: "duplicate" });
          continue;
        }
      } else if (
        sameSymbol &&
        sameSymbol.kind !== s.kind &&
        nowMs - sameSymbol.at < this.config.cooldownCrossKindMs &&
        s.surprise < sameSymbol.surprise * this.config.escalationMultiple
      ) {
        suppressed.push({ signal: s, emitted: false, reason: "cooldown" });
        continue;
      }

      emitted.push(s);
      this.sessionCount++;
      this.lastByKey.set(key, { at: nowMs, surprise: s.surprise, kind: s.kind });
      this.lastBySymbol.set(s.symbol, { at: nowMs, surprise: s.surprise, kind: s.kind });
      this.firesBySymbol.set(s.symbol, (this.firesBySymbol.get(s.symbol) ?? 0) + 1);
      this.firesByKind.set(s.kind, (this.firesByKind.get(s.kind) ?? 0) + 1);
    }

    return { emitted, suppressed, marketWide };
  }

  /** How many alerts this session has already spent. */
  get spent(): number {
    return this.sessionCount;
  }

  /** Start a new trading day. */
  resetSession(): void {
    this.lastByKey.clear();
    this.lastBySymbol.clear();
    this.firesBySymbol.clear();
    this.firesByKind.clear();
    this.sessionCount = 0;
  }
}
