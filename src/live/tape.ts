/**
 * The live market sampler: what changed between two moments, and how big the prints were.
 *
 * ## Why this exists at all, and why it is not the running-trade tape
 *
 * The obvious way to watch for a big transaction is to read the running-trade tape. Measured against
 * the live API during an open session, that does not work: `/order-trade/running-trade` runs ABOUT
 * EIGHT TO TEN MINUTES BEHIND and refreshes in bursts. Its head sat unchanged for over three minutes
 * while the lag grew second for second, and `cache-control: max-age=1` with `x-cache: Miss from
 * cloudfront` puts the staleness at Stockbit's own origin rather than in a CDN. The project's API
 * notes say the same thing from the other direction: live data flows over WebSocket, and REST is the
 * snapshot. An alert built on that tape would be telling you about a trade that happened ten minutes
 * ago, which for a "big transaction just went through" alert is worse than saying nothing.
 *
 * What IS live over REST, measured the same way:
 *
 *   - `/order-trade/top-stock` — 100 most-active symbols with CUMULATIVE `value`, `lot` and
 *     `frequency`. Over 25 seconds DSSA moved +1,394,039,000 in value across +91 transactions and
 *     BBCA +55,665,000 across +19. One request, one hundred symbols, continuously updating.
 *   - the order book, and a symbol's cumulative volume — both tick continuously.
 *
 * ## The idea this module rests on
 *
 * `frequency` is a COUNT OF TRANSACTIONS. So between two snapshots:
 *
 *     Δvalue / Δfrequency  =  the average rupiah size of the trades that printed in that window
 *
 * A single enormous print is a large Δvalue against a Δfrequency of one or two. Ordinary churn is a
 * large Δvalue spread over hundreds. That ratio is the whole detector, and it needs no tape.
 *
 * It is an AVERAGE, not a single trade, and this module never pretends otherwise: with Δfrequency of
 * 40 it cannot tell one 4-billion print from forty 100-million ones. `confidence` reports that
 * honestly rather than burying it — see `TradeDelta`.
 *
 * ## Everything here is pure
 *
 * Fetching lives in `poller.ts`. This file turns snapshots into deltas and nothing else, so the
 * arithmetic that decides whether a user gets woken up is testable without a market being open.
 */

/** Stockbit returns numbers as `{raw, formatted}`. `raw` is a STRING, and it is the one to use. */
export interface RawNumber {
  raw: string;
  formatted?: string;
}

/**
 * Read a Stockbit numeric field.
 *
 * Every one of these arrives as `{raw: "477705146500", formatted: "477.7B"}`, and the first version
 * of this code read the object with `Number(...)`, got `NaN` for all 100 symbols, and concluded the
 * endpoint was frozen. It was not; the parser was. Hence a named function with a test rather than an
 * inline coercion: the failure it prevents is silent and looks exactly like "no market activity".
 */
export function readRaw(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    // Formatted strings carry separators; raw ones do not. Strip only separators, never digits.
    const n = Number(value.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === "object" && "raw" in value) return readRaw((value as RawNumber).raw);
  return null;
}

/** One symbol at one instant. Cumulative-since-open figures, exactly as the exchange reports them. */
export interface SymbolSample {
  symbol: string;
  /** Cumulative traded VALUE in rupiah since the session opened. */
  value: number;
  /** Cumulative traded LOTS since the session opened. One IDX lot is 100 shares. */
  lot: number;
  /** Cumulative NUMBER OF TRANSACTIONS since the session opened. The denominator that matters. */
  frequency: number;
  /** Volume-weighted average price for the session, when the source provides it. */
  average: number | null;
}

export interface MarketSnapshot {
  /** When this was taken, epoch ms. */
  at: number;
  symbols: Map<string, SymbolSample>;
}

/** What happened to one symbol between two snapshots. */
export interface TradeDelta {
  symbol: string;
  /** Rupiah that traded in the window. */
  value: number;
  lots: number;
  /** How many transactions printed. Zero means nothing traded. */
  trades: number;
  /** Rupiah per transaction, averaged over the window. Null when nothing traded. */
  averageTradeValue: number | null;
  /** Seconds between the two snapshots. */
  seconds: number;
  /**
   * How much weight `averageTradeValue` can carry.
   *
   * `single` — exactly one transaction printed, so the average IS that trade. This is the only case
   *   where "a transaction of X just went through" is literally true.
   * `few` — 2..5 transactions. A large average still means at least one large trade.
   * `averaged` — more than five. A large average means large trades ON AVERAGE and nothing about any
   *   individual one. An alert built on this must say so.
   */
  confidence: "single" | "few" | "averaged" | "none";
}

/**
 * Turn Stockbit's `top-stock` rows into a snapshot.
 *
 * Defensive about shape: rows that lack a usable code, value or frequency are skipped rather than
 * defaulted to zero. A zero would read as "this symbol stopped trading", which is a real market
 * event, and inventing one from a parse failure is how a screener cries wolf.
 */
export function snapshotFromTopStock(rows: unknown[], at = Date.now()): MarketSnapshot {
  const symbols = new Map<string, SymbolSample>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const symbol = typeof r.code === "string" ? r.code.trim().toUpperCase() : "";
    const value = readRaw(r.value);
    const lot = readRaw(r.lot);
    const frequency = readRaw(r.frequency);
    if (!symbol || value === null || frequency === null) continue;
    symbols.set(symbol, {
      symbol,
      value,
      lot: lot ?? 0,
      frequency,
      average: readRaw(r.average),
    });
  }
  return { at, symbols };
}

/**
 * What traded between two snapshots.
 *
 * Only symbols present in BOTH are reported: a symbol that appears in the later snapshot alone has
 * no baseline, and treating its cumulative total as a delta would report an entire session's volume
 * as if it had just happened. `top-stock` is a ranked list, so symbols genuinely do enter and leave
 * it between polls — this is the common case, not an edge one.
 */
export function diffSnapshots(before: MarketSnapshot, after: MarketSnapshot): TradeDelta[] {
  const seconds = Math.max(0, (after.at - before.at) / 1000);
  const out: TradeDelta[] = [];

  for (const [symbol, now] of after.symbols) {
    const then = before.symbols.get(symbol);
    if (!then) continue;

    const value = now.value - then.value;
    const trades = now.frequency - then.frequency;
    const lots = now.lot - then.lot;

    // A NEGATIVE delta is not a small trade — it is a new session. These figures are cumulative
    // since the open, so they reset to zero every morning, and the first poll after a reset would
    // otherwise report a large negative "trade". Skip rather than clamp: clamping to zero would
    // silently report "nothing traded" on the one poll where the truth is "the counter restarted".
    if (value < 0 || trades < 0 || lots < 0) continue;

    out.push({
      symbol,
      value,
      lots,
      trades,
      averageTradeValue: trades > 0 ? value / trades : null,
      seconds,
      confidence: trades === 0 ? "none" : trades === 1 ? "single" : trades <= 5 ? "few" : "averaged",
    });
  }

  // Biggest rupiah first: that is the order a human wants to read, and it makes "top N" meaningful
  // without a second pass.
  return out.sort((a, b) => b.value - a.value);
}

/** True when the two snapshots straddle a session reset, so their difference is meaningless. */
export function looksLikeSessionReset(before: MarketSnapshot, after: MarketSnapshot): boolean {
  let dropped = 0;
  let compared = 0;
  for (const [symbol, now] of after.symbols) {
    const then = before.symbols.get(symbol);
    if (!then) continue;
    compared++;
    if (now.value < then.value) dropped++;
  }
  // One symbol going backwards is a data glitch; most of them going backwards is a new day. The
  // caller needs to tell those apart, because the first should be ignored and the second should
  // reset the baseline.
  return compared > 0 && dropped / compared > 0.5;
}
