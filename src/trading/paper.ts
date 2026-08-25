/**
 * A local ledger you can practise against, with the same protocol as the real thing.
 *
 * Order entry here has never been run against a live brokerage account, and the first person to try
 * it will be doing so with their own money, on a route this project has only projected. Paper mode
 * exists so that is not also the first time anyone has seen the *protocol* work: the preview, the
 * ticket, the confirmation, the elicitation, the outcome classes, the audit line. All of it is
 * identical. What changes is where the order goes.
 *
 * ## The fill model, and exactly how approximate it is
 *
 * A limit **buy** fills if the market was already there — the best offer at placement is at or below
 * the limit — or if the session's minutely close series later printed at or below it. **Sell** is the
 * mirror. That is the honest maximum from the data this project can see, and it is wrong in three
 * specific ways, all of them stated on every paper result:
 *
 *   - **Close-only.** `intraday_prices` is a minutely *close* series. A price that traded inside a
 *     minute and closed away from it is invisible, so some real fills are missed here.
 *   - **No queue position.** A real limit order at the touch joins a queue and may never reach the
 *     front. Here, price alone is enough — which makes paper fills optimistic.
 *   - **No partial fills.** An order fills whole or stays open. Real IDX orders partial-fill
 *     routinely, and a strategy that depends on that behaves differently here.
 *
 * These are not defects to be fixed later by trying harder; they are the limits of a close-only
 * series. ADR-0008 records them, and every result carries them so nobody backtests against a
 * simulator they think is a market.
 *
 * ## Why the ledger is a file and not a memory
 *
 * The MCP server lives only as long as a client holds it open, and the CLI is a different process
 * again. A paper account that vanished when Claude Desktop restarted would teach nothing. So: one
 * JSON file, written atomically (temp + rename, like the settings file), mutated under the same
 * directory lock the real order path uses.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { stockbitPath } from "../paths.js";
import { StockbitError } from "../http/errors.js";
import { DEFAULT_PAPER_CASH_IDR } from "../settings.js";
import { idr } from "../core/format.js";

/** Shares in one lot. */
const SHARES_PER_LOT = 100;

/** The published retail schedule. Paper has no account to read a real one from. */
export const PAPER_FEES = { buyPct: 0.15, sellPct: 0.25 } as const;

export const PAPER_LEDGER_VERSION = 1;

/** The sentence that opens every paper-served summary. Written once so they cannot drift apart. */
export const PAPER_BANNER = "PAPER ACCOUNT — no real money.";

export type PaperOrderStatus = "open" | "filled" | "cancelled" | "amended";

export interface PaperOrder {
  id: string;
  /** What the user sees in a summary, mirroring the real path's `ui_ref`. */
  uiRef: string;
  symbol: string;
  action: "buy" | "sell";
  price: number;
  lots: number;
  status: PaperOrderStatus;
  placedAt: string;
  filledAt?: string;
  fillPrice?: number;
  /** Set when an amend replaced this order, naming the one that did. */
  replacedBy?: string;
}

export interface PaperFill {
  orderId: string;
  symbol: string;
  action: "buy" | "sell";
  price: number;
  lots: number;
  at: string;
  feeIdr: number;
  /** Realised profit or loss on a sell, after both legs' commission. Absent on a buy. */
  realisedIdr?: number;
}

export interface PaperPosition {
  shares: number;
  /** Weighted average cost per share, INCLUDING the buy commission. */
  avgPrice: number;
}

export interface PaperLedger {
  version: number;
  createdAt: string;
  startingCashIdr: number;
  cashIdr: number;
  positions: Record<string, PaperPosition>;
  orders: PaperOrder[];
  fills: PaperFill[];
}

/** Where the ledger lives. Moves with `STOCKBIT_STORE_DIR` like everything else. */
export function paperLedgerPath(): string {
  return stockbitPath("paper", "ledger.json");
}

export function emptyLedger(startingCashIdr = DEFAULT_PAPER_CASH_IDR, at = new Date()): PaperLedger {
  return {
    version: PAPER_LEDGER_VERSION,
    createdAt: at.toISOString(),
    startingCashIdr,
    cashIdr: startingCashIdr,
    positions: {},
    orders: [],
    fills: [],
  };
}

/**
 * Read the ledger, or start a fresh one.
 *
 * A missing file is a new paper account, not an error. A **corrupt** file is an error and is not
 * silently replaced: the ledger is the only record of what the practice account did, and quietly
 * resetting it would destroy that history while looking like everything was fine.
 */
export function loadLedger(startingCashIdr = DEFAULT_PAPER_CASH_IDR): PaperLedger {
  let raw: string;
  try {
    raw = readFileSync(paperLedgerPath(), "utf8");
  } catch {
    return emptyLedger(startingCashIdr);
  }
  try {
    const parsed = JSON.parse(raw) as PaperLedger;
    if (typeof parsed?.cashIdr !== "number" || !Array.isArray(parsed.orders)) throw new Error("shape");
    return {
      version: parsed.version ?? PAPER_LEDGER_VERSION,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      startingCashIdr: parsed.startingCashIdr ?? startingCashIdr,
      cashIdr: parsed.cashIdr,
      positions: parsed.positions ?? {},
      orders: parsed.orders,
      fills: parsed.fills ?? [],
    };
  } catch {
    throw new StockbitError(
      "invalid_param",
      `The paper ledger at ${paperLedgerPath()} could not be read. It is not being replaced ` +
        "automatically — it is the only record of what this account did. Fix it, or start over with " +
        "`stockbit-auth paper-reset`.",
    );
  }
}

/** Write the ledger atomically, for the same reason the settings file is written atomically. */
export function saveLedger(ledger: PaperLedger): void {
  const target = paperLedgerPath();
  mkdirSync(stockbitPath("paper"), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/* ---------------------------------- pure operations ---------------------------------- */

export interface PaperMarket {
  /** Best offer right now, from the orderbook or the quote. */
  offer: number | null;
  /** Best bid right now. */
  bid: number | null;
  /** Last traded price, used as a mark and as a fallback for marketability. */
  last: number | null;
}

export interface PaperPlacement {
  symbol: string;
  action: "buy" | "sell";
  price: number;
  lots: number;
}

/** What `placePaperOrder` decided, so the tool layer can explain it. */
export interface PaperPlacementResult {
  ledger: PaperLedger;
  order: PaperOrder;
  filled: boolean;
  /** Why it did or did not fill, in one sentence. */
  reason: string;
}

const feeFor = (value: number, action: "buy" | "sell"): number =>
  value * ((action === "buy" ? PAPER_FEES.buyPct : PAPER_FEES.sellPct) / 100);

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

/**
 * Place an order against the ledger.
 *
 * Affordability and position are checked here rather than trusted from the preview: the preview
 * priced the order against the ledger a moment ago, and between then and now another paper order
 * may have spent the cash. The real path checks the same things at the same point for the same
 * reason.
 *
 * Returns a NEW ledger — the caller writes it. Nothing here touches the disk, which is what makes
 * the fill rules testable without a store.
 */
export function placePaperOrder(
  ledger: PaperLedger,
  placement: PaperPlacement,
  market: PaperMarket,
  now: Date,
): PaperPlacementResult {
  const { symbol, action, price, lots } = placement;
  const shares = lots * SHARES_PER_LOT;
  const gross = shares * price;

  if (action === "buy") {
    const cost = gross + feeFor(gross, "buy");
    if (cost > ledger.cashIdr) {
      throw new StockbitError(
        "invalid_param",
        `${PAPER_BANNER} Not enough cash: ${lots} lots of ${symbol} at ${idr(price)} costs ` +
          `${idr(cost)} with commission, and the ledger holds ${idr(ledger.cashIdr)}.`,
      );
    }
  } else {
    const held = ledger.positions[symbol]?.shares ?? 0;
    if (shares > held) {
      throw new StockbitError(
        "invalid_param",
        `${PAPER_BANNER} The paper account holds ${held / SHARES_PER_LOT} lots of ${symbol}, ` +
          `so it cannot sell ${lots}. IDX retail has no short selling.`,
      );
    }
  }

  const order: PaperOrder = {
    id: newId("paper"),
    uiRef: newId("ref"),
    symbol,
    action,
    price,
    lots,
    status: "open",
    placedAt: now.toISOString(),
  };

  // Marketable at placement: someone is already showing a price that satisfies this limit.
  const marketable =
    action === "buy"
      ? market.offer !== null && market.offer <= price
      : market.bid !== null && market.bid >= price;

  const next: PaperLedger = { ...ledger, orders: [...ledger.orders, order] };

  if (!marketable) {
    return {
      ledger: next,
      order,
      filled: false,
      reason:
        action === "buy"
          ? `Left OPEN: the best offer is ${market.offer === null ? "unknown" : idr(market.offer)}, above the ` +
            `${idr(price)} limit. It fills if the session prints at or below the limit — checked on the next read.`
          : `Left OPEN: the best bid is ${market.bid === null ? "unknown" : idr(market.bid)}, below the ` +
            `${idr(price)} limit. It fills if the session prints at or above the limit — checked on the next read.`,
    };
  }

  // Fills at the limit price, not at the touch. Assuming price improvement would be the flattering
  // assumption, and a paper account that flatters is worse than none.
  return {
    ...applyFill(next, order, price, now),
    reason: `Filled at ${idr(price)} — the market was already there when it was placed. No partial fills in paper.`,
  };
}

/** Apply a fill: move the cash, move the position, record it. Pure. */
function applyFill(
  ledger: PaperLedger,
  order: PaperOrder,
  fillPrice: number,
  now: Date,
): { ledger: PaperLedger; order: PaperOrder; filled: boolean } {
  const shares = order.lots * SHARES_PER_LOT;
  const gross = shares * fillPrice;
  const fee = feeFor(gross, order.action);

  const positions = { ...ledger.positions };
  let cashIdr = ledger.cashIdr;
  let realisedIdr: number | undefined;

  if (order.action === "buy") {
    cashIdr -= gross + fee;
    const existing = positions[order.symbol];
    // Average cost carries the commission, so a "break-even" reading is a real one.
    const totalCost = (existing ? existing.shares * existing.avgPrice : 0) + gross + fee;
    const totalShares = (existing?.shares ?? 0) + shares;
    positions[order.symbol] = { shares: totalShares, avgPrice: totalCost / totalShares };
  } else {
    cashIdr += gross - fee;
    const existing = positions[order.symbol];
    const costOfSold = (existing?.avgPrice ?? 0) * shares;
    realisedIdr = gross - fee - costOfSold;
    const remaining = (existing?.shares ?? 0) - shares;
    if (remaining <= 0) delete positions[order.symbol];
    else positions[order.symbol] = { shares: remaining, avgPrice: existing!.avgPrice };
  }

  const filledOrder: PaperOrder = {
    ...order,
    status: "filled",
    filledAt: now.toISOString(),
    fillPrice,
  };

  return {
    ledger: {
      ...ledger,
      cashIdr,
      positions,
      orders: ledger.orders.map((o) => (o.id === order.id ? filledOrder : o)),
      fills: [
        ...ledger.fills,
        {
          orderId: order.id,
          symbol: order.symbol,
          action: order.action,
          price: fillPrice,
          lots: order.lots,
          at: now.toISOString(),
          feeIdr: fee,
          ...(realisedIdr === undefined ? {} : { realisedIdr }),
        },
      ],
    },
    order: filledOrder,
    filled: true,
  };
}

export interface PaperSettlementInput {
  /** Minutely close series for the current session, per symbol, oldest first. */
  intradayBySymbol: Record<string, number[]>;
}

/**
 * Fill any open order the session has since printed through.
 *
 * Runs lazily at the start of every paper read, so the ledger is never stale when someone looks at
 * it, and there is no background process to keep alive.
 *
 * The series is close-only. A price that traded inside a minute and closed away from it never
 * appears here, so this misses fills a real market would have given — the error is in the
 * conservative direction for entries and the optimistic one for exits, and neither is corrected by
 * pretending otherwise.
 */
export function settlePaper(
  ledger: PaperLedger,
  input: PaperSettlementInput,
  now: Date,
): { ledger: PaperLedger; filled: PaperOrder[] } {
  let current = ledger;
  const filled: PaperOrder[] = [];

  for (const order of ledger.orders) {
    if (order.status !== "open") continue;
    const series = input.intradayBySymbol[order.symbol];
    if (!series?.length) continue;

    const touched =
      order.action === "buy"
        ? series.some((close) => close <= order.price)
        : series.some((close) => close >= order.price);
    if (!touched) continue;

    const applied = applyFill(current, order, order.price, now);
    current = applied.ledger;
    filled.push(applied.order);
  }

  return { ledger: current, filled };
}

/** Cancel an open order. A filled one cannot be cancelled, which is true of the real market too. */
export function cancelPaperOrder(ledger: PaperLedger, orderId: string): { ledger: PaperLedger; order: PaperOrder } {
  const order = ledger.orders.find((o) => o.id === orderId || o.uiRef === orderId);
  if (!order) {
    throw new StockbitError("invalid_param", `${PAPER_BANNER} No paper order with id ${JSON.stringify(orderId)}.`);
  }
  if (order.status !== "open") {
    throw new StockbitError(
      "invalid_param",
      `${PAPER_BANNER} Paper order ${order.id} is ${order.status}, not open. A filled order cannot be ` +
        "cancelled here for the same reason it cannot be cancelled on the exchange.",
    );
  }
  const cancelled: PaperOrder = { ...order, status: "cancelled" };
  return {
    ledger: { ...ledger, orders: ledger.orders.map((o) => (o.id === order.id ? cancelled : o)) },
    order: cancelled,
  };
}

/**
 * Amend an open order: cancel it and place a replacement.
 *
 * Modelled as replace rather than edit because that is what it is on the exchange — an amended
 * order loses its queue position, and pretending otherwise would make paper flatter a strategy that
 * amends often.
 */
export function amendPaperOrder(
  ledger: PaperLedger,
  orderId: string,
  next: { price: number; lots: number },
  market: PaperMarket,
  now: Date,
): PaperPlacementResult {
  const cancelled = cancelPaperOrder(ledger, orderId);
  const original = cancelled.order;
  const withAmended: PaperLedger = {
    ...cancelled.ledger,
    orders: cancelled.ledger.orders.map((o) => (o.id === original.id ? { ...o, status: "amended" as const } : o)),
  };
  const placed = placePaperOrder(
    withAmended,
    { symbol: original.symbol, action: original.action, price: next.price, lots: next.lots },
    market,
    now,
  );
  return {
    ...placed,
    ledger: {
      ...placed.ledger,
      orders: placed.ledger.orders.map((o) =>
        o.id === original.id ? { ...o, replacedBy: placed.order.id } : o,
      ),
    },
    reason: `Amended: paper order ${original.id} was replaced by ${placed.order.id}. ${placed.reason}`,
  };
}

/* ---------------------------------- reading it back ---------------------------------- */

export interface PaperHolding {
  symbol: string;
  lots: number;
  shares: number;
  avgPrice: number;
  /** Present when a mark was available. */
  lastPrice?: number;
  marketValueIdr?: number;
  unrealisedIdr?: number;
  unrealisedPct?: number;
}

export interface PaperSnapshot {
  mode: "paper";
  cashIdr: number;
  startingCashIdr: number;
  holdings: PaperHolding[];
  /** Cash plus marked holdings, when every holding could be marked. */
  totalValueIdr: number | null;
  realisedIdr: number;
  openOrders: PaperOrder[];
  summary: string;
}

/** The whole account, marked against whatever quotes the caller could get. */
export function snapshot(ledger: PaperLedger, marks: Record<string, number | null>): PaperSnapshot {
  const holdings: PaperHolding[] = [];
  let marked = 0;
  let unmarked = 0;

  for (const [symbol, position] of Object.entries(ledger.positions)) {
    const last = marks[symbol] ?? null;
    const holding: PaperHolding = {
      symbol,
      lots: position.shares / SHARES_PER_LOT,
      shares: position.shares,
      avgPrice: position.avgPrice,
    };
    if (last !== null) {
      const value = position.shares * last;
      holding.lastPrice = last;
      holding.marketValueIdr = value;
      holding.unrealisedIdr = value - position.shares * position.avgPrice;
      holding.unrealisedPct = ((last - position.avgPrice) / position.avgPrice) * 100;
      marked += value;
    } else {
      unmarked += 1;
    }
    holdings.push(holding);
  }

  const realisedIdr = ledger.fills.reduce((sum, f) => sum + (f.realisedIdr ?? 0), 0);
  const totalValueIdr = unmarked === 0 ? ledger.cashIdr + marked : null;
  const openOrders = ledger.orders.filter((o) => o.status === "open");

  const summary =
    `${PAPER_BANNER} Cash ${idr(ledger.cashIdr)} of a starting ${idr(ledger.startingCashIdr)}; ` +
    `${holdings.length} holding${holdings.length === 1 ? "" : "s"}, ${openOrders.length} open order` +
    `${openOrders.length === 1 ? "" : "s"}; realised P&L ${idr(realisedIdr)}` +
    (totalValueIdr === null
      ? `. ${unmarked} holding${unmarked === 1 ? "" : "s"} could not be marked, so there is no total.`
      : `; total ${idr(totalValueIdr)}.`) +
    " Fills are approximate: close-only minutely data, no queue position, no partial fills.";

  return {
    mode: "paper",
    cashIdr: ledger.cashIdr,
    startingCashIdr: ledger.startingCashIdr,
    holdings,
    totalValueIdr,
    realisedIdr,
    openOrders,
    summary,
  };
}
