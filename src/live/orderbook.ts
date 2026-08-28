/**
 * The order book, parsed into something the signal detectors can trust.
 *
 * Everything here was read off a live response (BRMS, 2026-08-28) rather than inferred from field
 * names, because two of the names are actively misleading and a detector that believes them produces
 * numbers that look plausible and are wrong.
 *
 * ## The two unit traps, both measured
 *
 * **`total_bid_offer.bid.raw_lot` is NOT lots.** It is the sum of the visible ladder's `volume`, in
 * SHARES. Verified by addition: the twenty bid levels of BRMS summed to exactly 152,228,700, which is
 * the value of that field to the share. One IDX lot is 100 shares, so reading it as lots overstates
 * depth by 100x.
 *
 * **`volume` on the book is SHARES; `volumeLots` from `technicals` is LOTS.** BRMS closed with
 * `volume: 253,908,500` against `value: 192,602,886,000` at an average of 759 — which divides out to
 * 253.8 million SHARES, not lots. The same session read through `technicals` reports its volume in
 * lots. Two endpoints, same word, factor of 100 apart.
 *
 * ## The ladder is asymmetric, and does not always reach the auto-reject band
 *
 * BRMS: twenty bid levels running 750 down to 655, and forty-one offer levels running 755 up to 955.
 * ARA was 935 and ARB was 640. So the offer side extended PAST its band edge while the bid side
 * stopped fifteen rupiah SHORT of its own.
 *
 * That asymmetry is also the real reason `bid_percent` misleads: at 50.1 it reported BRMS as balanced,
 * but it is comparing twenty levels of bid against forty-one levels of offer. It is not summing "the
 * whole band including junk at the floor" — it is summing whatever happens to be visible, and the two
 * sides are not equally visible.
 *
 * `reachesBand` records whether the ladder actually got to the edge, so a feature that measures
 * distance-to-ARB can say "at least this much" instead of quietly reporting a floor it never saw.
 */
import { readRaw } from "./tape.js";

/** Shares per IDX lot. Fixed by the exchange, and the conversion every unit trap here turns on. */
export const SHARES_PER_LOT = 100;

/** One price level. `shares` is deliberately named for its unit, not for the field it came from. */
export interface BookLevel {
  price: number;
  /** Resting size at this level, in SHARES. */
  shares: number;
  /** How many separate orders make up this level. A wall of one is not a wall of four hundred. */
  orders: number;
}

export interface OrderBook {
  symbol: string;
  lastPrice: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  /** Session VWAP, as the exchange reports it. */
  average: number | null;

  /** Best bid first, descending. */
  bid: BookLevel[];
  /** Best offer first, ascending. */
  offer: BookLevel[];

  /** Auto-reject ceiling for the session, an exact price. */
  ara: number | null;
  /** Auto-reject floor for the session, an exact price. */
  arb: number | null;
  /** Whether each ladder actually extends to its band edge. See the header. */
  reachesBand: { ara: boolean; arb: boolean };

  /** Cumulative session figures. `volumeShares` is SHARES — see the header. */
  frequency: number;
  value: number;
  volumeShares: number;

  /** Market-wide breadth, free in every response. */
  breadth: { up: number; down: number; unchanged: number };

  /** Foreign flows, in rupiah. Null when the symbol does not carry them. */
  foreign: { buy: number; sell: number; net: number } | null;

  /** IDX's own Unusual Market Activity flag. */
  uma: boolean;
  /** IDX notation codes. Empty for an unflagged stock. */
  notation: string[];

  /** True when the symbol trades by periodic call auction rather than a continuous book. */
  isCallAuction: boolean;
  /** Indicative equilibrium price/volume, only meaningful during a call auction. */
  indicative: { price: number | null; volume: number | null; secondsLeft: number | null } | null;

  tradable: boolean;
  status: string;
}

function level(row: unknown): BookLevel | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const price = readRaw(r.price);
  const shares = readRaw(r.volume);
  if (price === null || shares === null || price <= 0) return null;
  return { price, shares, orders: readRaw(r.que_num) ?? 0 };
}

function ladder(rows: unknown): BookLevel[] {
  if (!Array.isArray(rows)) return [];
  const out: BookLevel[] = [];
  for (const row of rows) {
    const l = level(row);
    // A zero-size level is a real thing the exchange prints; a malformed one is not. Only the
    // second is dropped, because silently discarding empty levels would shorten the ladder and
    // make "the book does not reach ARB" indistinguishable from "we could not read it".
    if (l) out.push(l);
  }
  return out;
}

/** Parse a raw `orderbook` response. Returns null when the payload is not a readable book. */
export function parseOrderBook(payload: unknown): OrderBook | null {
  if (!payload || typeof payload !== "object") return null;
  const d = payload as Record<string, unknown>;

  const symbol = typeof d.symbol === "string" ? d.symbol.trim().toUpperCase() : "";
  const lastPrice = readRaw(d.lastprice) ?? readRaw(d.close);
  if (!symbol || lastPrice === null) return null;

  const bid = ladder(d.bid);
  const offer = ladder(d.offer);

  const band = (v: unknown): number | null => {
    if (v && typeof v === "object" && "value" in v) return readRaw((v as { value: unknown }).value);
    return readRaw(v);
  };
  const ara = band(d.ara);
  const arb = band(d.arb);

  const iep = d.iepiev as Record<string, unknown> | undefined;
  const iepStatus = typeof iep?.status === "string" ? iep.status : "";
  // A regular stock still carries the object, filled with zeroes and STATUS_UNSPECIFIED — measured on
  // BRMS. So presence of the key proves nothing; only a populated status does.
  const isCallAuction = iepStatus !== "" && iepStatus !== "STATUS_UNSPECIFIED";

  const fbuy = readRaw(d.fbuy);
  const fsell = readRaw(d.fsell);
  const fnet = readRaw(d.fnet);

  return {
    symbol,
    lastPrice,
    previousClose: readRaw(d.previous) ?? 0,
    open: readRaw(d.open) ?? 0,
    high: readRaw(d.high) ?? 0,
    low: readRaw(d.low) ?? 0,
    average: readRaw(d.average),
    bid,
    offer,
    ara,
    arb,
    reachesBand: {
      // The ladder reaches the ceiling when its furthest offer is at or above ARA, and the floor
      // when its furthest bid is at or below ARB.
      ara: ara !== null && offer.length > 0 && offer[offer.length - 1].price >= ara,
      arb: arb !== null && bid.length > 0 && bid[bid.length - 1].price <= arb,
    },
    frequency: readRaw(d.frequency) ?? 0,
    value: readRaw(d.value) ?? 0,
    volumeShares: readRaw(d.volume) ?? 0,
    breadth: {
      up: readRaw(d.up) ?? 0,
      down: readRaw(d.down) ?? 0,
      unchanged: readRaw(d.unchanged) ?? 0,
    },
    foreign: fbuy === null && fsell === null ? null : { buy: fbuy ?? 0, sell: fsell ?? 0, net: fnet ?? 0 },
    uma: d.uma === true,
    notation: Array.isArray(d.notation) ? d.notation.filter((n): n is string => typeof n === "string") : [],
    isCallAuction,
    indicative: isCallAuction
      ? {
          price: readRaw(iep?.iep),
          volume: readRaw(iep?.iev),
          secondsLeft: readRaw(iep?.time_left_seconds),
        }
      : null,
    tradable: d.tradable !== false,
    status: typeof d.status === "string" ? d.status : "",
  };
}

/** Shares → lots. */
export const toLots = (shares: number): number => shares / SHARES_PER_LOT;

/** Rupiah resting at a level. */
export const levelValue = (l: BookLevel): number => l.price * l.shares;

/**
 * Sum resting size across the first `n` levels of one side.
 *
 * Returns shares. `n` larger than the ladder returns the whole ladder rather than throwing — a short
 * ladder is a normal condition, not an error.
 */
export function depth(side: BookLevel[], n: number): number {
  let total = 0;
  for (let i = 0; i < Math.min(n, side.length); i++) total += side[i].shares;
  return total;
}
