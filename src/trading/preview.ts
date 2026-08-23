/**
 * The order ticket: everything that is known before an order is sent, and every reason it might be
 * a bad idea, assembled into one object a person can say yes or no to.
 *
 * ## Why a preview exists at all
 *
 * A tool that took a symbol, a price and a quantity and placed an order would be one malformed
 * argument away from a real trade. The two-step protocol makes the write tools take a ticket id and
 * nothing else, so the order that is placed is exactly the order that was described — the
 * confirmation and the request are the same object, not two descriptions that have to agree.
 *
 * ## Checks that failed, and checks that could not be run
 *
 * These are different facts and the ticket keeps them apart. `ok: false` means something was read
 * and it says no — the price is off the tick grid, the lot count exceeds the configured cap, the
 * band would auto-reject it. Those block the order.
 *
 * `unverified` means the input could not be read at all: carina has never been observed live (see
 * `docs/PENDING-VERIFICATION.md`), so a projection that does not recognise this account's key names
 * leaves buying power or a position unknown. Failing those closed would brick order entry
 * permanently the first time a key name did not match, for a reason that has nothing to do with the
 * order. So they pass, they are named in `warnings`, and the summary the user reads says how many
 * could not be checked. The person confirming is the gate; this module's job is to tell them the
 * truth about what it does and does not know.
 *
 * ## Sequential, never concurrent
 *
 * Every read below runs one after another. Firing them together burned the session token on
 * 2026-08-05: several first calls each saw no access token, each triggered a refresh, and the
 * rotating refresh token meant all but one of them ended up invalid.
 */
import { createHash, randomUUID } from "node:crypto";
import { StockbitError } from "../http/errors.js";
import { normalizeSymbol } from "../symbol.js";
import { tradingPolicy, type TradingPolicy } from "../settings.js";
import { getQuote } from "../core/emitten.js";
import { extractBands, getOrderbook } from "../core/pricefeed.js";
import { getMarketSession } from "../core/market.js";
import {
  getCashBalance,
  getFees,
  getPosition,
  getStockTradable,
  listOrders,
  type Fees,
  type Order,
} from "./account.js";
import { TICKET_TTL_MS, issue, now } from "./tickets.js";

/* ---------------------------------- tick sizes ---------------------------------- */

/**
 * The IDX price ladder (*fraksi harga*): the increment a limit price must sit on.
 *
 * An off-grid price is rejected by the exchange, not corrected, so this is a check rather than a
 * rounding. The table is the one Stockbit's own client uses; it is duplicated here rather than read
 * from the wire because it is exchange rule, not account configuration, and because a preview must
 * be able to say "that price is invalid" without a request.
 */
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

/* ------------------------------------ shapes ------------------------------------ */

export type OrderAction = "buy" | "sell" | "amend" | "cancel";

export interface OrderCheck {
  name: string;
  /** False blocks the order. See the module note on the difference from `unverified`. */
  ok: boolean;
  detail: string;
  /** The check's input could not be read, so passing means "not contradicted", not "confirmed". */
  unverified?: true;
}

export interface TicketMarket {
  last: number | null;
  bid: number | null;
  offer: number | null;
  ara: number | null;
  arb: number | null;
  session: string | null;
  /** Signed: negative means the limit price sits below the last trade. */
  distanceFromLastPct: number | null;
}

export interface TicketAccount {
  buyingPowerIdr: number | null;
  positionShares: number | null;
  positionLots: number | null;
}

export interface OrderTicket {
  id: string;
  action: OrderAction;
  symbol: string;
  /** Null on a cancel, which carries no price. */
  price: number | null;
  lots: number | null;
  shares: number | null;
  /** The order being amended or cancelled. */
  orderId?: string;
  boardType: "RG";
  isGtc: boolean;
  timeInForce: "0";
  /** This order's idempotency handle, generated here and sent as `ui_ref`. */
  uiRef: string;
  grossIdr: number | null;
  feeIdr: number | null;
  feePct: number | null;
  feeSource: Fees["source"] | null;
  /** What leaves the account on a buy, or arrives on a sell. */
  netIdr: number | null;
  market: TicketMarket;
  account: TicketAccount;
  checks: OrderCheck[];
  warnings: string[];
  policy: TradingPolicy;
  /** Over the fields that define the order. Rechecked before the request goes out. */
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  /** One paragraph for the user. The tools tell the model to relay it verbatim. */
  summary: string;
}

export interface PreviewInput {
  action: OrderAction;
  symbol?: string;
  price?: number;
  lots?: number;
  orderId?: string;
}

/* ---------------------------------- formatting ---------------------------------- */

/** Rupiah with thousand separators, locale-independent so a test asserts one spelling. */
export function idr(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = Math.abs(rounded).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}Rp ${grouped}`;
}

function pct(value: number | null, places = 2): string {
  return value === null || !Number.isFinite(value) ? "unknown" : `${value.toFixed(places)}%`;
}

/* ------------------------------------ helpers ------------------------------------ */

const SHARES_PER_LOT = 100;

function check(name: string, ok: boolean, detail: string): OrderCheck {
  return { name, ok, detail };
}

function unverified(name: string, detail: string): OrderCheck {
  return { name, ok: true, detail, unverified: true };
}

/** Read a session label out of a payload whose shape is not mapped. Null when nothing looks like one. */
export function sessionLabel(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  for (const key of ["status", "session", "state", "phase", "market_status", "session_name", "name"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Best bid and offer, dug defensively out of the depth payload nobody has fully mapped. */
export function bestPrices(payload: unknown): { bid: number | null; offer: number | null } {
  const row = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && /^-?[\d,]+(?:\.\d+)?$/.test(v.trim())) {
      const n = Number(v.replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  const ladderTop = (value: unknown): number | null => {
    if (!Array.isArray(value) || !value.length) return null;
    const first = value[0];
    if (first && typeof first === "object") {
      const entry = first as Record<string, unknown>;
      return num(entry.price ?? entry.value ?? entry.bid ?? entry.offer ?? entry.ask);
    }
    return num(first);
  };
  return {
    bid: num(row.bid) ?? ladderTop(row.bids) ?? ladderTop(row.bid_list),
    offer: num(row.offer) ?? num(row.ask) ?? ladderTop(row.offers) ?? ladderTop(row.offer_list) ?? ladderTop(row.asks),
  };
}

/** The fields that define the order, hashed. Anything else about the ticket may change freely. */
export function fingerprintOf(ticket: OrderTicket): string {
  const material = {
    action: ticket.action,
    symbol: ticket.symbol,
    price: ticket.price,
    shares: ticket.shares,
    orderId: ticket.orderId ?? null,
    uiRef: ticket.uiRef,
    boardType: ticket.boardType,
    timeInForce: ticket.timeInForce,
    isGtc: ticket.isGtc,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

/** Read a value without letting its failure end the preview. Returns null and records the reason. */
async function attempt<T>(label: string, load: () => Promise<T>, notes: string[]): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    notes.push(`${label} could not be read (${err instanceof StockbitError ? err.message : String(err)})`);
    return null;
  }
}

/* ------------------------------------ preview ------------------------------------ */

/**
 * Build a ticket, and issue it.
 *
 * Always returns a ticket, even when checks fail: the user asked what would happen, and "here is
 * why it will not work" is the answer. `take()` in `tickets.ts` is what refuses to redeem one.
 */
export async function previewOrder(input: PreviewInput): Promise<OrderTicket> {
  const policy = tradingPolicy();
  const action = input.action;
  const warnings: string[] = [];
  const checks: OrderCheck[] = [];

  if (action !== "cancel" && action !== "amend" && !input.symbol) {
    throw new StockbitError("invalid_param", "A symbol is required to preview a buy or a sell.");
  }
  if ((action === "amend" || action === "cancel") && !input.orderId) {
    throw new StockbitError("invalid_param", `An order id is required to preview an ${action}.`);
  }

  // The open orders come first for an amend or a cancel: they carry the symbol, and without the
  // target there is nothing to price.
  let target: Order | undefined;
  let targetLookupFailed = false;
  if (action === "amend" || action === "cancel") {
    const open = await attempt("The open order list", () => listOrders(), warnings);
    if (open) target = open.orders.find((o) => o.orderId === input.orderId);
    else targetLookupFailed = true;
  }

  // Checked before normalising, which refuses an empty string with a message about symbols rather
  // than about the order that could not be found.
  const rawSymbol = input.symbol ?? target?.symbol ?? "";
  if (!rawSymbol) {
    throw new StockbitError(
      "invalid_param",
      targetLookupFailed
        ? `The open orders could not be read, so the symbol of order ${input.orderId} is unknown. Pass ` +
          "`symbol` explicitly to preview it anyway."
        : `Order ${input.orderId} was not found among the open orders and no symbol was given, so there is ` +
          "nothing to preview. Read `orders` first.",
    );
  }
  const symbol = normalizeSymbol(rawSymbol);

  const price = action === "cancel" ? null : (input.price ?? target?.price ?? null);
  const lots =
    action === "cancel"
      ? (target?.lots ?? null)
      : (input.lots ?? target?.lots ?? (target?.shares ? target.shares / SHARES_PER_LOT : null));
  const shares = lots === null ? null : lots * SHARES_PER_LOT;

  /* ------------------------------ the reads, in order ------------------------------ */

  const quote = await attempt("The quote", () => getQuote(symbol), warnings);
  const last = quote ? Number(String(quote.price).replace(/,/g, "")) : Number.NaN;
  const lastPrice = Number.isFinite(last) ? last : null;

  // One request for three things. The bands, the best bid and the best offer all arrive inside the
  // same depth payload, and `extractBands` is the pure reader over it that `price_bands` already uses.
  const book = await attempt("The orderbook", () => getOrderbook(symbol), warnings);
  const bands = book === null ? null : extractBands(symbol, book);
  const depth = bestPrices(book);

  const session = await attempt("The market session", () => getMarketSession(), warnings);
  const sessionName = sessionLabel(session);
  if (sessionName && /clos|break|pre|halt|suspend/i.test(sessionName)) {
    warnings.push(
      `The market session reads "${sessionName}". An order sent now queues for the next session rather than ` +
        "trading immediately.",
    );
  }

  const tradable = await attempt("Tradability", () => getStockTradable([symbol]), warnings);
  const fees = await attempt("The commission schedule", () => getFees(), warnings);
  if (fees?.source === "default") {
    warnings.push(
      "This account's own commission could not be read, so every fee figure below uses this project's " +
        "defaults and may be wrong.",
    );
  }

  const cash = action === "buy" ? await attempt("Cash and buying power", () => getCashBalance(), warnings) : null;
  const position =
    action === "sell" ? await attempt("The position", () => getPosition(symbol), warnings) : null;

  /* --------------------------------- the arithmetic --------------------------------- */

  const feePct = fees ? (action === "sell" ? fees.sellPct : fees.buyPct) : null;
  const grossIdr = price !== null && shares !== null ? price * shares : null;
  const feeIdr = grossIdr !== null && feePct !== null ? Math.round((grossIdr * feePct) / 100) : null;
  const netIdr =
    grossIdr === null || feeIdr === null ? null : action === "sell" ? grossIdr - feeIdr : grossIdr + feeIdr;

  const buyingPowerIdr = cash?.buyingPowerIdr ?? cash?.cashIdr ?? null;
  const positionShares = position?.holding?.availableShares ?? position?.holding?.shares ?? null;

  /* ----------------------------------- the checks ----------------------------------- */

  checks.push(
    check(
      "trading_enabled",
      policy.enabled,
      policy.enabled ? `Trading is on (${policy.source}).` : policy.reason,
    ),
  );

  checks.push(
    policy.allowedSymbols.length === 0
      ? check("symbol_allowed", true, "No symbol allow-list is configured, so every symbol is permitted.")
      : check(
          "symbol_allowed",
          policy.allowedSymbols.includes(symbol),
          policy.allowedSymbols.includes(symbol)
            ? `${symbol} is on the configured allow-list.`
            : `${symbol} is not on the allow-list (${policy.allowedSymbols.join(", ")}). Change it with ` +
              "`stockbit-auth trading-enable --symbols ...`.",
        ),
  );

  const tradableVerdict = tradable?.symbols[0]?.tradable;
  checks.push(
    tradableVerdict === undefined
      ? unverified(
          "symbol_tradable",
          `Whether ${symbol} can be traded right now could not be established. If it is suspended, the ` +
            "exchange will reject the order.",
        )
      : check(
          "symbol_tradable",
          tradableVerdict,
          tradableVerdict
            ? `${symbol} is tradable.`
            : `${symbol} is not tradable right now${tradable?.symbols[0]?.reason ? `: ${tradable.symbols[0].reason}` : "."}`,
        ),
  );

  if (action !== "cancel") {
    const lotsValid = lots !== null && Number.isInteger(lots) && lots > 0;
    checks.push(
      check(
        "lots_positive_integer",
        lotsValid,
        lotsValid ? `${lots} lots (${shares} shares).` : `Lots must be a positive whole number, got ${lots}.`,
      ),
    );
    checks.push(
      check(
        "lots_within_cap",
        lots !== null && lots <= policy.maxLotsPerOrder,
        lots !== null && lots <= policy.maxLotsPerOrder
          ? `${lots} lots is within the configured cap of ${policy.maxLotsPerOrder}.`
          : `${lots} lots exceeds the configured cap of ${policy.maxLotsPerOrder} per order.`,
      ),
    );

    if (price === null) {
      checks.push(check("price_tick", false, "No price was given and none could be read from the order."));
    } else {
      const tick = tickSize(price);
      const onGrid = price % tick === 0;
      const near = nearestTicks(price);
      checks.push(
        check(
          "price_tick",
          onGrid,
          onGrid
            ? `${idr(price)} sits on the ${idr(tick)} tick grid.`
            : `${idr(price)} is not a valid IDX price — at this level the tick is ${idr(tick)}, so the ` +
              `nearest valid prices are ${idr(near.below)} and ${idr(near.above)}. The exchange rejects ` +
              "off-grid prices rather than rounding them.",
        ),
      );
    }

    if (price === null || bands === null || (bands.ara === null && bands.arb === null)) {
      checks.push(
        unverified(
          "price_within_bands",
          "The auto-rejection band could not be read, so whether this price would be rejected is unknown.",
        ),
      );
    } else {
      const aboveAra = bands.ara !== null && price > bands.ara;
      const belowArb = bands.arb !== null && price < bands.arb;
      checks.push(
        check(
          "price_within_bands",
          !aboveAra && !belowArb,
          aboveAra
            ? `${idr(price)} is above today's auto-rejection ceiling of ${idr(bands.ara)} and would be rejected.`
            : belowArb
              ? `${idr(price)} is below today's auto-rejection floor of ${idr(bands.arb)} and would be rejected.`
              : `${idr(price)} is inside today's band (${idr(bands.arb)} – ${idr(bands.ara)}).`,
        ),
      );
    }

    if (policy.maxOrderValueIdr === null) {
      checks.push(
        check(
          "value_within_cap",
          true,
          "No per-order value cap is configured. Set one with `stockbit-auth trading-enable " +
            "--max-order-value N`; it is also what `autoConfirm` requires.",
        ),
      );
    } else {
      const within = grossIdr !== null && grossIdr <= policy.maxOrderValueIdr;
      checks.push(
        check(
          "value_within_cap",
          within,
          within
            ? `${idr(grossIdr)} is within the configured cap of ${idr(policy.maxOrderValueIdr)}.`
            : `${idr(grossIdr)} exceeds the configured per-order cap of ${idr(policy.maxOrderValueIdr)}.`,
        ),
      );
    }
  }

  if (action === "buy") {
    if (buyingPowerIdr === null || netIdr === null) {
      checks.push(
        unverified(
          "buy_affordable",
          "Buying power could not be read, so affordability was not checked. If the account cannot cover " +
            "this, the order is rejected.",
        ),
      );
    } else {
      checks.push(
        check(
          "buy_affordable",
          netIdr <= buyingPowerIdr,
          netIdr <= buyingPowerIdr
            ? `${idr(netIdr)} against ${idr(buyingPowerIdr)} of buying power.`
            : `${idr(netIdr)} is more than the ${idr(buyingPowerIdr)} of buying power available.`,
        ),
      );
    }
  }

  if (action === "sell") {
    if (positionShares === null || shares === null) {
      checks.push(
        unverified(
          "sell_covered",
          `The position in ${symbol} could not be read, so whether these shares are available to sell was ` +
            "not checked.",
        ),
      );
    } else {
      checks.push(
        check(
          "sell_covered",
          shares <= positionShares,
          shares <= positionShares
            ? `${shares} shares against ${positionShares} available.`
            : `${shares} shares is more than the ${positionShares} available to sell.`,
        ),
      );
    }
  }

  if (action === "amend" || action === "cancel") {
    const name = action === "amend" ? "amend_target_open" : "cancel_target_open";
    if (targetLookupFailed) {
      checks.push(unverified(name, `The open orders could not be read, so order ${input.orderId} was not confirmed to exist.`));
    } else {
      checks.push(
        check(
          name,
          target !== undefined,
          target
            ? `Order ${input.orderId} is open${target.status ? ` (${target.status})` : ""}.`
            : `Order ${input.orderId} is not among the open orders. It may already have filled or been cancelled.`,
        ),
      );
    }
  }

  /* ----------------------------------- the ticket ----------------------------------- */

  const createdMs = now();
  const distance =
    price !== null && lastPrice !== null && lastPrice !== 0
      ? ((price - lastPrice) / lastPrice) * 100
      : null;

  const unverifiedNames = checks.filter((c) => c.unverified).map((c) => c.name);
  if (unverifiedNames.length) {
    warnings.push(
      `${unverifiedNames.length} check(s) could not be run against live data and passed by default: ` +
        `${unverifiedNames.join(", ")}. They mean "not contradicted", not "confirmed".`,
    );
  }

  const ticket: OrderTicket = {
    id: `tk_${randomUUID()}`,
    action,
    symbol,
    price,
    lots,
    shares,
    ...(input.orderId ? { orderId: input.orderId } : {}),
    boardType: "RG",
    isGtc: false,
    timeInForce: "0",
    uiRef: randomUUID(),
    grossIdr,
    feeIdr,
    feePct,
    feeSource: fees?.source ?? null,
    netIdr,
    market: {
      last: lastPrice,
      bid: depth.bid,
      offer: depth.offer,
      ara: bands?.ara ?? null,
      arb: bands?.arb ?? null,
      session: sessionName,
      distanceFromLastPct: distance,
    },
    account: {
      buyingPowerIdr,
      positionShares,
      positionLots: positionShares === null ? null : positionShares / SHARES_PER_LOT,
    },
    checks,
    warnings,
    policy,
    fingerprint: "",
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(createdMs + TICKET_TTL_MS).toISOString(),
    summary: "",
  };
  ticket.fingerprint = fingerprintOf(ticket);
  ticket.summary = summarize(ticket);
  return issue(ticket);
}

/**
 * The paragraph the user actually reads.
 *
 * Written here rather than at the tool boundary so there is one wording, and so the numbers in it
 * come from the same object the request is built from. A model relaying this is relaying the ticket.
 */
export function summarize(ticket: OrderTicket): string {
  const failed = ticket.checks.filter((c) => !c.ok);
  const unverifiedCount = ticket.checks.filter((c) => c.unverified).length;
  const parts: string[] = [];

  if (ticket.action === "cancel") {
    parts.push(`CANCEL order ${ticket.orderId} on ${ticket.symbol}.`);
  } else if (ticket.action === "amend") {
    parts.push(
      `AMEND order ${ticket.orderId} on ${ticket.symbol} to ${ticket.lots} lots ` +
        `(${ticket.shares} shares) at ${idr(ticket.price)}.`,
    );
  } else {
    parts.push(
      `${ticket.action.toUpperCase()} ${ticket.lots} lots (${ticket.shares} shares) of ${ticket.symbol} ` +
        `at ${idr(ticket.price)}.`,
    );
  }

  if (ticket.grossIdr !== null) {
    const direction = ticket.action === "sell" ? "You would receive" : "It would cost";
    parts.push(
      `Gross ${idr(ticket.grossIdr)}, commission ${idr(ticket.feeIdr)} (${pct(ticket.feePct)}` +
        `${ticket.feeSource === "default" ? ", this project's DEFAULT rate, not read from the account" : ""}). ` +
        `${direction} ${idr(ticket.netIdr)}.`,
    );
  }

  if (ticket.market.last !== null) {
    parts.push(
      `Last traded ${idr(ticket.market.last)}` +
        (ticket.market.distanceFromLastPct === null
          ? "."
          : `; this price is ${pct(Math.abs(ticket.market.distanceFromLastPct))} ` +
            `${ticket.market.distanceFromLastPct < 0 ? "below" : "above"} it.`),
    );
  }

  if (ticket.market.arb !== null || ticket.market.ara !== null) {
    parts.push(`Today's band runs ${idr(ticket.market.arb)} to ${idr(ticket.market.ara)}.`);
  }

  if (failed.length) {
    parts.push(`THIS ORDER CANNOT BE PLACED: ${failed.map((c) => c.detail).join(" ")}`);
  } else {
    parts.push(`Every check passed${unverifiedCount ? `, though ${unverifiedCount} could not be verified` : ""}.`);
  }

  parts.push(`Ticket ${ticket.id} expires ${ticket.expiresAt}.`);
  return parts.join(" ");
}
