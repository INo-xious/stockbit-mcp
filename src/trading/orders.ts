/**
 * Placing, amending and cancelling an order. ADR-0004.
 *
 * ## What makes this different from every other write here
 *
 * A chart layout is snapshotted and restored. A watchlist entry is added back. An order cannot be
 * undone — once the exchange has it, the only thing that exists is another order. So the apparatus
 * ADR-0003 established is kept, with one deliberate inversion at each point where "undo" was the
 * answer:
 *
 *  - **Lock contention REFUSES.** `reflock` and the chart save proceed without the lock, because a
 *    possible clobber beats a guaranteed outage and both have a read-back that would catch it. Here
 *    a second writer means a second order, and there is no read-back that unsends one.
 *  - **A failed verification NEVER rolls back.** The rollback for an order would be a cancel, which
 *    is another order — sent on a guess, about a state we just admitted we could not read. If the
 *    outcome is unknown this module says so and stops.
 *  - **Nothing throws after the request goes out.** A thrown error is a caller's licence to retry,
 *    and a retry here is a duplicate order. Everything after the write returns a description of
 *    what is known, including "we do not know".
 *
 * ## The outcome classes
 *
 * | | Meaning |
 * |---|---|
 * | `ok` | 2xx, and the read-back shows it |
 * | `rejected` | The exchange or the validation layer said no. Nothing is on the book. |
 * | `not-visible` | 2xx, but the read-back cannot find it. It may appear a moment later. |
 * | `landed-despite-error` | The request errored and the order is there anyway |
 * | `not-found-after-error` | The request errored and the read-back is clean |
 * | `outcome-unknown` | The request errored and the read-back also failed. The worst case, and it is reported as itself. |
 * | `write-failed` | A synchronous client-side rejection. Nothing was sent to the exchange. |
 * | `aborted-no-snapshot` | Thrown before the request: the before-state could not be read, so no comparison would have been possible. |
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { postJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { redactValue } from "../redact.js";
import { acquireDirLock } from "../util/dirlock.js";
import { invalidateCache } from "../core/_util.js";
import { tradingPolicy, type TradingPolicy } from "../settings.js";
import { listOrdersRaw, readOrderList, type Order } from "./account.js";
import { bestPrices, fingerprintOf, idr, type OrderTicket } from "./preview.js";
import { getQuote } from "../core/emitten.js";
import { getOrderbook } from "../core/pricefeed.js";
import {
  amendPaperOrder,
  cancelPaperOrder,
  loadLedger,
  placePaperOrder,
  saveLedger,
  PAPER_BANNER,
  type PaperMarket,
  type PaperPlacementResult,
} from "./paper.js";
import { peek, take, type TicketBase } from "./tickets.js";
import { stockbitDir } from "../paths.js";

/**
 * The ticket store holds both kinds. This narrows to an exchange order, and refuses rather than
 * casting blindly — an e-IPO ticket redeemed by `order_buy` would carry no price the exchange could
 * use, and the error worth giving says which tool the user's ticket actually belongs to.
 */
function asOrderTicket(ticket: TicketBase): OrderTicket {
  if (ticket.kind !== "order") {
    refuse(`Ticket ${ticket.id} is an e-IPO subscription, not an exchange order. Use the e-IPO tools.`);
  }
  return ticket as OrderTicket;
}

/** Where every order attempt is recorded, whatever its outcome. */
export function orderLogPath(): string {
  return join(stockbitDir(), "order-mutations.log");
}

/** A lock older than this belongs to a process that died mid-order. */
export const ORDER_LOCK_STALE_MS = 60_000;

export type OrderOutcomeKind =
  | "ok"
  | "rejected"
  | "not-visible"
  | "landed-despite-error"
  | "not-found-after-error"
  | "outcome-unknown"
  | "write-failed";

export interface OrderResult {
  ticketId: string;
  action: OrderTicket["action"];
  symbol: string;
  uiRef: string;
  /** The order being amended or cancelled, or the one the read-back found for a new order. */
  orderId?: string;
  outcome: OrderOutcomeKind;
  /** True only when the read-back actually showed the intended state. */
  verified: boolean;
  /** Set when the account's state could not be established. Always relayed to the user verbatim. */
  outcomeUnknown?: string;
  price: number | null;
  shares: number | null;
  ordersBefore: number;
  ordersAfter?: number;
  /** The error the request or the read-back produced, when there was one. */
  error?: string;
  /** False means the attempt is NOT in the audit log — say so rather than implying it is. */
  logged: boolean;
  logPath: string;
  at: string;
  /** Set on every paper result. Its absence means the order went to the exchange. */
  paper?: true;
  /** What the ledger did with it, and how approximate that is. Paper only. */
  fill?: { status: "filled" | "open"; price?: number; model: "paper-approximate"; note: string };
  /** One sentence of paper-specific explanation, always opening with the PAPER banner. */
  paperNote?: string;
}

/**
 * One append-only line per attempt.
 *
 * Through `redactValue`, so a body echoed into an error can never carry a token into the log. A
 * failure to log does not mask the write it describes — but it is reported, because advertising an
 * audit trail that does not exist is worse than having none.
 */
function logOrder(entry: Record<string, unknown>): boolean {
  try {
    mkdirSync(stockbitDir(), { recursive: true });
    appendFileSync(orderLogPath(), `${JSON.stringify(redactValue(entry))}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------- the body ------------------------------------- */

/**
 * The request body, per plan §2.4 — `shares`, never lots.
 *
 * `platform_order_type` is in Stockbit's own body and is deliberately NOT sent: it is an enum whose
 * vocabulary has not been observed, and inventing a member is how a request gets accepted meaning
 * something other than what was shown to the user. An omitted field that turns out to be required
 * produces a 400 on the first attempt, which is visible; a wrong enum value might not be.
 * `split_order: false` IS sent, because it is a boolean whose meaning is not in question.
 */
export function orderBody(ticket: OrderTicket): Record<string, unknown> {
  if (ticket.action === "cancel") {
    return { order_id: ticket.orderId, ui_ref: ticket.uiRef };
  }
  if (ticket.action === "amend") {
    return {
      order_id: ticket.orderId,
      ui_ref: ticket.uiRef,
      symbol: ticket.symbol,
      price: ticket.price,
      shares: ticket.shares,
      board_type: ticket.boardType,
    };
  }
  return {
    ui_ref: ticket.uiRef,
    symbol: ticket.symbol,
    price: ticket.price,
    shares: ticket.shares,
    board_type: ticket.boardType,
    is_gtc: ticket.isGtc,
    time_in_force: ticket.timeInForce,
    split_order: false,
  };
}

const ROUTE_FOR = {
  buy: "orderBuy",
  sell: "orderSell",
  amend: "orderAmend",
  cancel: "orderCancel",
} as const;

/* ---------------------------------- verification ---------------------------------- */

/** Did the account end up in the state the ticket described? */
export function verifyAgainst(
  ticket: OrderTicket,
  before: Order[],
  after: Order[],
): { landed: boolean; orderId?: string; rejected: boolean } {
  const byUiRef = after.find((o) => o.uiRef && o.uiRef === ticket.uiRef);
  const rejectedText = (o: Order | undefined) => Boolean(o?.status && /reject/i.test(o.status));

  if (ticket.action === "buy" || ticket.action === "sell") {
    if (byUiRef) return { landed: true, orderId: byUiRef.orderId, rejected: rejectedText(byUiRef) };
    // No `ui_ref` came back on the row. Fall back to a diff: an order id that was not there before.
    const seen = new Set(before.map((o) => o.orderId).filter(Boolean));
    const fresh = after.find((o) => o.orderId && !seen.has(o.orderId) && o.symbol === ticket.symbol);
    if (fresh) return { landed: true, orderId: fresh.orderId, rejected: rejectedText(fresh) };
    return { landed: false, rejected: false };
  }

  const target = after.find((o) => o.orderId === ticket.orderId);
  if (ticket.action === "cancel") {
    // Gone, or explicitly cancelled. Either is the cancel having worked.
    const gone = target === undefined;
    const cancelled = Boolean(target?.status && /cancel/i.test(target.status));
    return { landed: gone || cancelled, orderId: ticket.orderId, rejected: rejectedText(target) };
  }

  // Amend: the target must now carry the new terms.
  const matches =
    target !== undefined &&
    (ticket.price === null || target.price === ticket.price) &&
    (ticket.shares === null || target.shares === ticket.shares);
  return { landed: matches, orderId: ticket.orderId, rejected: rejectedText(target) };
}

/* ------------------------------------- the gates ------------------------------------- */

/** How the confirmation was satisfied, for the log and for the user. */
export type ConfirmationSource = "explicit" | "auto-confirm" | "elicited";

export interface SubmitOptions {
  ticketId: string;
  confirm?: boolean;
  /**
   * Ask the human directly, when the MCP client supports it.
   *
   * Injected rather than reached for: this module must not depend on the MCP server object, and a
   * test must be able to drive both answers. Returns "unavailable" when the client cannot ask.
   */
  elicit?: (message: string) => Promise<"accepted" | "declined" | "unavailable">;
}

function refuse(message: string): never {
  throw new StockbitError("invalid_param", message);
}

/**
 * Everything that must be true before a request is built. Throws — this is all before the wire.
 */
async function passGates(options: SubmitOptions): Promise<{ ticket: OrderTicket; policy: TradingPolicy; via: ConfirmationSource }> {
  const policy = tradingPolicy();
  if (!policy.enabled) {
    refuse(
      `${policy.reason} No order was sent. Settings file: ${policy.settingsPath}.` +
        (policy.corrupt ? " The settings file could not be read, which is treated as no permission." : ""),
    );
  }

  // Peeked, not taken: the confirmation decision needs the order's value, and a ticket must not be
  // spent by a call that is about to be refused.
  const found = peek(options.ticketId);
  if (!found) take(options.ticketId); // throws with the precise reason (missing / expired)

  const ticket = asOrderTicket(found as TicketBase);
  let via: ConfirmationSource | null = options.confirm === true ? "explicit" : null;

  // Configured but not in effect. Falling through to the generic "no confirmation" refusal would be
  // correct and useless: the user set a switch and it is not doing anything, and that is the fact
  // worth saying.
  if (!via && policy.autoConfirmIgnored) refuse(`${policy.autoConfirmIgnored} Nothing was sent.`);

  if (!via && policy.autoConfirm) {
    const cap = policy.maxOrderValueIdr;
    // Belt and braces: `tradingPolicy` already refuses to report autoConfirm without a cap, and this
    // module refuses to act on it without one. A single guard would be enough right up until
    // somebody edits the other file.
    if (cap === null) {
      refuse(
        "autoConfirm is set but no maxOrderValueIdr is configured, so it is ignored. Pass confirm: true after " +
          "asking the user, or set a cap with `stockbit-auth trading-enable --max-order-value N`.",
      );
    }
    if (ticket.grossIdr !== null && ticket.grossIdr <= cap) via = "auto-confirm";
    else {
      refuse(
        `autoConfirm covers orders up to ${idr(cap)} and this one is ${idr(ticket.grossIdr)}. Ask the user and ` +
          "pass confirm: true.",
      );
    }
  }

  if (!via && options.elicit) {
    const answer = await options.elicit(ticket.summary);
    if (answer === "accepted") via = "elicited";
    else if (answer === "declined") refuse("The user declined this order when asked directly. Nothing was sent.");
  }

  if (!via) {
    refuse(
      "Refusing to send an order without confirmation. Show the user the ticket's `summary`, in words, and " +
        "pass confirm: true only after they agree to THAT order. Do not set it on their behalf.",
    );
  }

  // Spends the ticket. Everything from here on is one attempt, and this is the last point at which
  // a refusal costs nothing.
  const taken = asOrderTicket(take(options.ticketId, "order"));

  if (fingerprintOf(taken) !== taken.fingerprint) {
    refuse(
      `Order ticket ${taken.id} does not match its own fingerprint — the order it describes has been altered ` +
        "since it was previewed. Nothing was sent. Run order_preview again.",
    );
  }

  return { ticket: taken, policy, via };
}

/* ------------------------------------- the write ------------------------------------- */

/**
 * Send the order a ticket describes.
 *
 * Throws only before the request. After it, returns a description — see the outcome table above.
 */
export async function submitOrder(options: SubmitOptions): Promise<OrderResult> {
  const { ticket, via, policy } = await passGates(options);
  const at = new Date().toISOString();
  const base = {
    ticketId: ticket.id,
    action: ticket.action,
    symbol: ticket.symbol,
    uiRef: ticket.uiRef,
    price: ticket.price,
    shares: ticket.shares,
    logPath: orderLogPath(),
    at,
    ...(ticket.orderId ? { orderId: ticket.orderId } : {}),
  };

  // One order per symbol at a time, across processes. Refused rather than waited out: a caller that
  // waited would place its order into a market the other one just moved, against a ticket priced
  // before either.
  const release = await acquireDirLock(join(stockbitDir(), `order-${ticket.symbol}.lock`), {
    staleMs: ORDER_LOCK_STALE_MS,
    timeoutMs: 0,
  });
  if (!release) {
    logOrder({ ...base, via, outcome: "refused-lock" });
    // What it knows is that the lock was not taken, which is USUALLY a concurrent order and is now
    // also "the lock could not be created" — `acquireDirLock` refuses to hold one whose owner token
    // it could not write (a full or read-only disk), rather than holding one it cannot prove is its
    // own. Both mean the same thing here and neither sends anything, but naming only the first as
    // fact would be this file asserting something it did not establish.
    refuse(
      `Could not take the order lock for ${ticket.symbol}: either another order on it is in flight in ` +
        "this or another process, or the lock could not be created (a full or read-only disk). Nothing " +
        "was sent — two orders from one intention is the failure this refuses to risk. Check `orders`, " +
        "then preview again.",
    );
  }

  try {
    // Paper mode diverges HERE and nowhere earlier, which is the whole design. Everything above —
    // the policy gate, the ticket, the confirmation, the elicitation, the fingerprint check, the
    // per-symbol lock — has already run identically. What changes is where the order goes.
    return policy.mode === "paper"
      ? await performPaperOrder(ticket, via, at, base)
      : await performOrder(ticket, via, at, base);
  } finally {
    release();
  }
}

/**
 * The paper path: the same result shape, filled from a local ledger.
 *
 * It returns the same `outcome` vocabulary as the real path because a user rehearsing here should
 * be reading the same words they will read live. `ok` still means "the ledger shows it", which is
 * the paper equivalent of "the exchange showed it on the read-back" — and, unlike the real path, it
 * cannot be uncertain: the ledger is a local file this process just wrote.
 */
async function performPaperOrder(
  ticket: OrderTicket,
  via: ConfirmationSource,
  at: string,
  base: ResultBase,
): Promise<OrderResult> {
  const now = new Date(at);
  const ledger = loadLedger();
  const before = ledger.orders.filter((o) => o.status === "open").length;

  const finish = (
    outcome: OrderOutcomeKind,
    verified: boolean,
    extra: { orderId?: string; error?: string; fill?: Record<string, unknown>; reason?: string } = {},
  ): OrderResult => {
    const logged = logOrder({ ...base, via, mode: "paper", outcome, verified, ordersBefore: before, ...extra });
    return {
      ...base,
      ...(extra.orderId ? { orderId: extra.orderId } : {}),
      outcome,
      verified,
      ordersBefore: before,
      ...(extra.error ? { error: extra.error } : {}),
      logged,
      paper: true,
      ...(extra.fill ? { fill: extra.fill } : {}),
      ...(extra.reason ? { paperNote: extra.reason } : {}),
    } as OrderResult;
  };

  try {
    if (ticket.action === "cancel") {
      const orderId = ticket.orderId as string;
      const result = cancelPaperOrder(ledger, orderId);
      saveLedger(result.ledger);
      return finish("ok", true, {
        orderId: result.order.id,
        reason: `${PAPER_BANNER} Paper order ${result.order.id} is cancelled in the ledger.`,
      });
    }

    const market = await paperMarket(ticket.symbol);

    if (ticket.action === "amend") {
      const result = amendPaperOrder(
        ledger,
        ticket.orderId as string,
        { price: ticket.price as number, lots: (ticket.shares as number) / 100 },
        market,
        now,
      );
      saveLedger(result.ledger);
      return finish("ok", true, {
        orderId: result.order.id,
        reason: `${PAPER_BANNER} ${result.reason}`,
        fill: paperFill(result),
      });
    }

    const result = placePaperOrder(
      ledger,
      {
        symbol: ticket.symbol,
        action: ticket.action,
        price: ticket.price as number,
        lots: (ticket.shares as number) / 100,
      },
      market,
      now,
    );
    saveLedger(result.ledger);
    return finish("ok", true, {
      orderId: result.order.id,
      reason: `${PAPER_BANNER} ${result.reason}`,
      fill: paperFill(result),
    });
  } catch (err) {
    // A refusal from the ledger (no cash, no position, no such order) is a rejection, which is
    // exactly the class the real path would use for the same refusal from the exchange.
    const message = err instanceof Error ? err.message : String(err);
    return finish("rejected", true, { error: message });
  }
}

function paperFill(result: PaperPlacementResult): Record<string, unknown> {
  return {
    status: result.filled ? "filled" : "open",
    ...(result.filled ? { price: result.order.fillPrice } : {}),
    model: "paper-approximate",
    note:
      "Close-only minutely data, no queue position, no partial fills. A real order at this price " +
      "might not have filled, or might have filled in part.",
  };
}

/**
 * Marks for the paper fill rule, read the same way the preview reads them.
 *
 * `bestPrices` is the reader `order_preview` already uses over the depth payload — reused rather
 * than reimplemented, so a paper fill and the preview that priced it cannot disagree about what the
 * market was.
 *
 * A failure is not fatal: with no bid or offer the order is left open, which is the conservative
 * reading. It fills on the next settlement pass if the session prints through the limit.
 */
async function paperMarket(symbol: string): Promise<PaperMarket> {
  let bid: number | null = null;
  let offer: number | null = null;
  let last: number | null = null;
  try {
    const book = await getOrderbook(symbol);
    ({ bid, offer } = bestPrices(book));
  } catch {
    /* no depth; the order stays open */
  }
  try {
    const quote = await getQuote(symbol);
    const parsed = Number(String(quote.price).replace(/,/g, ""));
    last = Number.isFinite(parsed) ? parsed : null;
  } catch {
    /* no mark */
  }
  return { bid, offer, last };
}

type ResultBase = Omit<OrderResult, "outcome" | "verified" | "ordersBefore" | "logged">;

async function performOrder(
  ticket: OrderTicket,
  via: ConfirmationSource,
  at: string,
  base: ResultBase,
): Promise<OrderResult> {
  /* ---------------------------------- the snapshot ---------------------------------- */

  let before: Order[];
  try {
    before = readOrderList(await listOrdersRaw()).orders;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logOrder({ ...base, via, outcome: "aborted-no-snapshot", error: message });
    refuse(
      `The open orders could not be read (${message}), so there would have been no way to tell whether this ` +
        "order landed. Nothing was sent.",
    );
  }

  /* ------------------------------------ the write ------------------------------------ */

  const body = orderBody(ticket);
  let writeError: StockbitError | Error | null = null;
  try {
    await postJson(ROUTE_FOR[ticket.action], { body });
  } catch (err) {
    writeError = err instanceof Error ? err : new Error(String(err));
  }

  // The order list has changed either way, and a stale cached copy is what a caller would read next.
  invalidateCache("carina:orders");
  invalidateCache("carina:order:");

  /* ----------------------------------- the read-back ----------------------------------- */

  let after: Order[] | null = null;
  let readBackError: string | undefined;
  try {
    after = readOrderList(await listOrdersRaw()).orders;
  } catch (err) {
    readBackError = err instanceof Error ? err.message : String(err);
  }

  const evidence = after ? verifyAgainst(ticket, before, after) : null;

  const finish = (
    outcome: OrderOutcomeKind,
    verified: boolean,
    extra: { outcomeUnknown?: string; error?: string; orderId?: string } = {},
  ): OrderResult => {
    const logged = logOrder({
      ...base,
      via,
      outcome,
      verified,
      ordersBefore: before.length,
      ordersAfter: after?.length,
      ...extra,
    });
    return {
      ...base,
      ...(extra.orderId ? { orderId: extra.orderId } : {}),
      outcome,
      verified,
      ordersBefore: before.length,
      ...(after ? { ordersAfter: after.length } : {}),
      ...(extra.outcomeUnknown ? { outcomeUnknown: extra.outcomeUnknown } : {}),
      ...(extra.error ? { error: extra.error } : {}),
      logged,
    };
  };

  if (writeError) {
    const message = writeError.message;
    const status = writeError instanceof StockbitError ? writeError.status : undefined;
    const rejection = /reject|insufficient|invalid|not allowed|forbidden/i.test(message);

    if (evidence?.landed) {
      return finish("landed-despite-error", true, {
        error: message,
        orderId: evidence.orderId,
        outcomeUnknown:
          `The request errored (${message}) but the order IS on the book. It was NOT retried and must not be ` +
          "— check `orders` before doing anything else.",
      });
    }
    if (after === null) {
      return finish("outcome-unknown", false, {
        error: message,
        outcomeUnknown:
          `The request errored (${message}) AND the order list could not be read back (${readBackError}), so ` +
          "whether this order exists is unknown. Do not resend it. Look at the Stockbit app before acting.",
      });
    }
    // The read-back is clean. A 4xx that named a rejection is the exchange or the validator saying
    // no, which is a definite answer; anything else errored on the way and left nothing behind.
    if (status !== undefined && status >= 400 && status < 500) {
      return finish(rejection ? "rejected" : "write-failed", false, { error: message });
    }
    return finish("not-found-after-error", false, { error: message });
  }

  if (after === null) {
    return finish("outcome-unknown", false, {
      error: readBackError,
      outcomeUnknown:
        `The request succeeded but the order list could not be read back (${readBackError}), so it is unconfirmed. ` +
        "Do not resend it — check `orders` in a moment, or the Stockbit app.",
    });
  }

  if (evidence?.rejected) {
    return finish("rejected", false, {
      orderId: evidence.orderId,
      error: "The order appears on the book with a rejected status.",
    });
  }
  if (evidence?.landed) return finish("ok", true, { orderId: evidence.orderId });

  return finish("not-visible", false, {
    outcomeUnknown:
      "The request was accepted but the order is not visible in the list yet. That is common for a few " +
      "seconds. Do NOT resend it — read `orders` again before concluding anything.",
  });
}

/* ------------------------------- the four entry points ------------------------------- */

/**
 * One implementation, four names.
 *
 * The action lives on the ticket, not on the call, so `order_sell` cannot redeem a ticket that was
 * previewed as a buy — the mismatch is caught here rather than discovered on the exchange.
 */
function forAction(action: OrderTicket["action"]) {
  return async (options: SubmitOptions): Promise<OrderResult> => {
    const preview = peek(options.ticketId);
    if (preview && preview.kind === "order" && (preview as OrderTicket).action !== action) {
      refuse(
        `Ticket ${options.ticketId} is a ${(preview as OrderTicket).action.toUpperCase()} and this is the ` +
          `${action.toUpperCase()} ` +
          "tool. Nothing was sent. Use the tool that matches the ticket, or preview again.",
      );
    }
    return submitOrder(options);
  };
}

export const placeBuy = forAction("buy");
export const placeSell = forAction("sell");
export const amendOrder = forAction("amend");
export const cancelOrder = forAction("cancel");
