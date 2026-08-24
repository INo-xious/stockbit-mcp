/**
 * The IDX price grid — *fraksi harga*.
 *
 * A limit order must sit exactly on this grid. An off-grid price is **rejected by the exchange**,
 * not rounded to the nearest valid one, so this is a check rather than a correction: a position
 * sizer that quietly moved a stop from 4103 to 4100 would be changing the user's risk without
 * saying so.
 *
 * The table is the one Stockbit's own client uses. It lives here rather than being read from the
 * wire because it is an exchange rule, not account configuration — which is what lets a preview,
 * and now `position_size`, say "that price is invalid" without a request and without a session.
 *
 * It was in `src/trading/preview.ts`, where only the order tools could reach it. `position_size` is
 * pure arithmetic with no account behind it, and it needs the same grid, so the grid moved down to
 * `core/`. `preview.ts` re-exports it, both for its own callers and because the trading tests
 * import from there.
 */
import { StockbitError } from "../http/errors.js";

/** The tick for a price, in rupiah. */
export function tickSize(price: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    throw new StockbitError("invalid_param", `A price must be a positive number, got ${price}`);
  }
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}

/** The nearest valid prices on either side of an off-grid one, for an error message worth reading. */
export function nearestTicks(price: number): { below: number; above: number } {
  const tick = tickSize(price);
  const below = Math.floor(price / tick) * tick;
  return { below, above: below + tick };
}

/** Whether a price sits exactly on the grid. */
export function onTickGrid(price: number): boolean {
  return price % tickSize(price) === 0;
}

/**
 * Move a price onto the grid, in a stated direction.
 *
 * Direction is required rather than "nearest" because the two ends of a trade want opposite
 * roundings and getting it wrong is silently expensive: a buy limit rounded **up** crosses further
 * into the offer than intended, and a stop rounded **up** cuts the loss later than intended. The
 * caller knows which it is; this function refuses to guess.
 *
 * Rounding down can cross a tick boundary — 200 has a 2 tick, 199 has a 1 tick — so the result is
 * re-checked against the grid at its own price rather than assumed valid.
 */
export function roundToTick(price: number, direction: "down" | "up"): number {
  const tick = tickSize(price);
  const candidate =
    direction === "down" ? Math.floor(price / tick) * tick : Math.ceil(price / tick) * tick;
  if (candidate <= 0) return tickSize(1);
  // The candidate may sit in a different band than the input did (rounding 200 down to 199, say).
  return onTickGrid(candidate) ? candidate : roundToTick(candidate, direction);
}
