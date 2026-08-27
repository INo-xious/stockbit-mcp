/**
 * Fetching the live market, and holding just enough state to say what changed.
 *
 * `tape.ts` owns the arithmetic and is pure. This file owns the requests and the one piece of
 * mutable state the arithmetic needs — the previous snapshot — and nothing else.
 *
 * ## Which endpoint, and why not the obvious one
 *
 * Measured against the live API during an open session (2026-08-27):
 *
 * | source | freshness |
 * |---|---|
 * | `/order-trade/top-stock` | **live** — 100 symbols, cumulative value/lot/frequency, moving continuously |
 * | order book, symbol volume | **live** |
 * | `/order-trade/running-trade` | **8-10 minutes behind**, refreshed in bursts |
 *
 * So the watcher reads `top-stock`. One request covers the hundred most-active symbols, which is
 * also the only place a large transaction can occur — a stock with no turnover cannot print one.
 * The running-trade tape is deliberately not used for detection; it is available for CONTEXT, and
 * anything built on it has to say how old it is.
 *
 * ## Cost
 *
 * One HTTP request per poll, regardless of how many symbols are being watched. Watching all 100 and
 * watching one cost the same, so the interval can be short without hammering anything.
 */
import { getJson } from "../http/client.js";
import {
  diffSnapshots,
  looksLikeSessionReset,
  snapshotFromTopStock,
  type MarketSnapshot,
  type TradeDelta,
} from "./tape.js";

/**
 * Find the row array in a Stockbit envelope.
 *
 * The envelopes here have moved before — `{data}`, `{data:{data}}`, and a named key have all been
 * seen across this API — so this searches structurally rather than following a fixed path. A fixed
 * path that breaks returns an empty list, which reads as "the market went quiet".
 */
function findRows(value: unknown, depth = 0): unknown[] {
  if (Array.isArray(value)) return value.length && typeof value[0] === "object" ? value : [];
  if (value && typeof value === "object" && depth < 5) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = findRows(child, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

/**
 * One live reading of the hundred most-active symbols.
 *
 * Goes through `getJson` rather than minting a token and calling the transport directly. The first
 * version of this did the latter, and it was wrong in a way that only shows up after several minutes
 * of running:
 *
 *   - `ensureFresh` HAS NO FORCE PARAMETER. It returns the cached token while that token is
 *     unexpired, and a 401 is not an expiry. So a token retired by another process — the browser,
 *     the MCP server, the alert daemon, any of which can rotate the family — would 401, and every
 *     subsequent poll would re-send the same dead token and 401 identically, forever.
 *   - `getJson` handles exactly that: 401 once, then `forceRefresh(domain)`, then retry. Only
 *     `forceRefresh` clears the shared access cache, which is what stops another process restoring
 *     the dead token underneath us.
 *
 * It also brings the concurrency limiter, 429/5xx backoff, the request timeout and Cloudflare
 * challenge detection. None of the response caching comes with it — the 5s TTL lives in `cached()`
 * in `core/market.ts`, not here — so consecutive polls still hit the wire, which is the whole point.
 */
export async function takeMarketSnapshot(now = Date.now()): Promise<MarketSnapshot> {
  // Throws StockbitError on a non-2xx, which is what we want. A watcher that swallows an error and
  // reports an empty market is telling the user "nothing is happening" when the truth is
  // "I cannot see".
  const body = await getJson("topStock");
  const rows = findRows(body);
  const snapshot = snapshotFromTopStock(rows, now);
  if (snapshot.symbols.size === 0) {
    throw new Error("top-stock returned no readable rows — the response shape may have changed");
  }
  return snapshot;
}

/** What one poll produced. */
export interface PollResult {
  at: number;
  /** Null on the very first poll: a delta needs two snapshots. */
  deltas: TradeDelta[] | null;
  /** Why there is no delta, when there is none. */
  reason?: "first-poll" | "session-reset";
  symbolsSeen: number;
}

/**
 * A watcher over the live market.
 *
 * Holds the previous snapshot so consecutive polls can be differenced. Deliberately a class rather
 * than a closure: the interval, the baseline and the reset handling belong together, and a caller
 * that wants two independent watchers should get two independent baselines.
 */
export class MarketWatcher {
  private previous: MarketSnapshot | null = null;

  /** Poll once and report what traded since the last poll. */
  async poll(now = Date.now()): Promise<PollResult> {
    const snapshot = await takeMarketSnapshot(now);
    const previous = this.previous;
    this.previous = snapshot;

    if (!previous) {
      return { at: snapshot.at, deltas: null, reason: "first-poll", symbolsSeen: snapshot.symbols.size };
    }

    // A new trading day zeroes every cumulative counter. Differencing across that boundary would
    // report the whole previous session as a single window of activity, so the baseline is replaced
    // and this poll produces nothing. The NEXT poll is the first honest one.
    if (looksLikeSessionReset(previous, snapshot)) {
      return { at: snapshot.at, deltas: null, reason: "session-reset", symbolsSeen: snapshot.symbols.size };
    }

    return { at: snapshot.at, deltas: diffSnapshots(previous, snapshot), symbolsSeen: snapshot.symbols.size };
  }

  /** Throw the baseline away, so the next poll starts fresh. */
  reset(): void {
    this.previous = null;
  }

  /** Whether a delta is possible on the next poll. */
  get ready(): boolean {
    return this.previous !== null;
  }
}
