/** Local paper order submission only. No securities write transport exists. ADR-0012. */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { StockbitError } from "../http/errors.js";
import { redactValue } from "../redact.js";
import { acquireDirLock } from "../util/dirlock.js";
import { tradingPolicy, type TradingPolicy } from "../settings.js";
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
  type PaperLedger,
  type PaperMarket,
  type PaperPlacementResult,
} from "./paper.js";
import { blockingCheck, peek, take, TICKET_TTL_MS, type TicketBase } from "./tickets.js";
import { grantRemember } from "./remember.js";
import {
  resolveConfirmation,
  type ConfirmationSource,
  type ElicitationOutcome,
} from "./confirmation.js";
import type { ElicitDecision } from "../tools/_define.js";
import { stockbitDir } from "../paths.js";

export type { ConfirmationSource, ElicitationOutcome };

/** Only local paper-order tickets are redeemable. */
function asOrderTicket(ticket: TicketBase): OrderTicket {
  if (ticket.kind !== "order") {
    refuse(`Ticket ${ticket.id} is not a local paper order. Create a paper_order_preview ticket.`);
  }
  return ticket as OrderTicket;
}

/** Where every order attempt is recorded, whatever its outcome. */
export function orderLogPath(): string {
  return join(stockbitDir(), "order-mutations.log");
}

/** A lock older than this belongs to a process that died mid-order. */
const ORDER_LOCK_STALE_MS = 60_000;

export type OrderOutcomeKind = "ok" | "rejected" | "write-failed";

export interface OrderResult {
  ticketId: string;
  action: OrderTicket["action"];
  symbol: string;
  uiRef: string;
  /** The order being amended or cancelled, or the one the read-back found for a new order. */
  orderId?: string;
  outcome: OrderOutcomeKind;
  /**
   * What happened on the human channel before this was sent. ADR-0010.
   *
   * Reported rather than `via` because it is the fact a PERSON needs: `unavailable` and
   * `disabled-by-policy` both mean nobody was asked, and a user is entitled to know that about an
   * order placed in their name. `via` — which distinguishes the five ways the gate was satisfied —
   * goes to the audit log, where the distinction is evidence rather than advice.
   */
  elicitation: ElicitationOutcome;
  /** True only when the read-back actually showed the intended state. */
  verified: boolean;
  price: number | null;
  shares: number | null;
  ordersBefore: number;
  /** The error the request or the read-back produced, when there was one. */
  error?: string;
  /** False means the attempt is NOT in the audit log — say so rather than implying it is. */
  logged: boolean;
  logPath: string;
  at: string;
  /** Every result is a local simulation. */
  paper: true;
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

/* ------------------------------------- the gates ------------------------------------- */

export interface SubmitOptions {
  ticketId: string;
  confirm?: boolean;
  /**
   * Ask the human directly, when the MCP client supports it.
   *
   * Injected rather than reached for: this module must not depend on the MCP server object, and a
   * test must be able to drive every answer. It reports "unavailable" when the client cannot ask.
   *
   * It is NOT optional in the sense that matters: when it is present it is always called, before
   * `confirm` is looked at, and a declined dialog refuses the order whatever `confirm` said. See
   * `src/trading/confirmation.ts` and ADR-0010.
   */
  elicit?: ElicitDecision;
}

function refuse(message: string): never {
  throw new StockbitError("invalid_param", message);
}

/**
 * Everything that must be true before a request is built. Throws — this is all before the wire.
 *
 * Three things happen here in an order that is load-bearing. The policy gate first, because a
 * server with no permission to trade should not be putting dialogs in front of anyone. Then the
 * confirmation gate, against a ticket that has been PEEKED rather than spent — a call about to be
 * refused must not cost the user their ticket. Only then is the ticket taken and re-fingerprinted,
 * so the last thing checked before the wire is that what is being sent is still what was shown.
 */
async function passGates(
  options: SubmitOptions,
): Promise<{ ticket: OrderTicket; policy: TradingPolicy; via: ConfirmationSource; elicitation: ElicitationOutcome }> {
  const policy = tradingPolicy();
  if (policy.mode !== "paper" || !policy.enabled) {
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

  // Before the dialog, not after it. `take()` refuses a ticket whose checks failed with this exact
  // sentence, and it would do so moments from now — so asking a person to approve an order that
  // cannot be placed whatever they answer would spend their attention on nothing and teach them
  // that the dialog is noise. Reading it costs no ticket: `blockingCheck` only inspects.
  const blocked = blockingCheck(ticket);
  if (blocked) refuse(blocked);

  const { via, elicitation, rememberRequested } = await resolveConfirmation({
    confirm: options.confirm,
    elicit: options.elicit,
    policy,
    summary: ticket.summary,
    valueIdr: ticket.grossIdr,
    noun: "order",
    // A NEW order only. An amend and a cancel change something already working, and agreeing to
    // spend X rupiah is not agreeing to move or withdraw an order already on the book. Stated here
    // rather than inferred from `grossIdr` being null: an amend's ticket resolves price and lots
    // from the working order, so its gross IS a number, and an earlier draft of this that leaned on
    // the null silently waived every amend.
    waivable: ticket.action === "buy" || ticket.action === "sell",
  });

  // Spends the ticket. Everything from here on is one attempt, and this is the last point at which
  // a refusal costs nothing.
  //
  // The one refusal that can still land here is expiry, and it is not a corner case: the dialog runs
  // at human speed and a ticket lasts two minutes, so a person who reads carefully can lose it while
  // deciding. `take()`'s own message explains the expiry but not the connection, so a reader who
  // just clicked yes would be told their ticket expired with nothing tying that to what they did.
  let taken: OrderTicket;
  try {
    taken = asOrderTicket(take(options.ticketId, "order"));
  } catch (err) {
    if (elicitation === "accepted" && err instanceof StockbitError && /expired/.test(err.message)) {
      refuse(
        `${err.message} The confirmation dialog was open while that happened: a ticket lasts ` +
          `${TICKET_TTL_MS / 1000} seconds and it ran out before the answer came back. Nothing was sent, and ` +
          "nothing was remembered. Preview again and the numbers will be current.",
      );
    }
    throw err;
  }

  if (fingerprintOf(taken) !== taken.fingerprint) {
    refuse(
      `Order ticket ${taken.id} does not match its own fingerprint — the order it describes has been altered ` +
        "since it was previewed. Nothing was sent. Run paper_order_preview again.",
    );
  }

  // The grant is created HERE, not inside the gate, and the placement is the point.
  //
  // The gate runs against a peeked ticket so that a refusal costs nothing — which means it must not
  // leave anything behind either. Creating the grant there meant every refusal after it (an expired
  // ticket, failed checks, a fingerprint mismatch) left a live fifteen-minute waiver for an order
  // that never happened, and the refusal said nothing about it. The waiver now rides with the
  // commitment: the ticket is spent and proven, so there is an order to have agreed to.
  //
  // Later failures — lock contention, an unreadable snapshot — do keep the grant. By then the person
  // approved a valid, well-formed order and the machinery failed underneath them; their "stop asking
  // me" stands, and the attempt is in the audit log either way.
  if (rememberRequested && taken.grossIdr !== null) grantRemember(policy, taken.grossIdr);

  return { ticket: taken, policy, via, elicitation };
}

/* ------------------------------------- the write ------------------------------------- */

/**
 * Send the order a ticket describes.
 *
 * Throws only before the request. After it, returns a description — see the outcome table above.
 */
export async function submitOrder(options: SubmitOptions): Promise<OrderResult> {
  const { ticket, via, elicitation } = await passGates(options);
  const at = new Date().toISOString();
  const base = {
    ticketId: ticket.id,
    action: ticket.action,
    symbol: ticket.symbol,
    uiRef: ticket.uiRef,
    price: ticket.price,
    shares: ticket.shares,
    // In `base` rather than passed alongside, so it reaches the result AND every audit line by the
    // same route the ticket id does. `via` is added at each log site instead, because it belongs to
    // the log and not to the answer the user reads.
    elicitation,
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
        "was sent — two orders from one intention is the failure this refuses to risk. Check `paper_orders`, " +
        "then preview again.",
    );
  }

  try {
    return await performPaperOrder(ticket, via, at, base);
  } finally {
    release();
  }
}

/** Apply the ticket to the local ledger and report its actual saved state. */
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

  /**
   * The ledger write, kept apart from the ledger's own refusals.
   *
   * `saveLedger` throwing is a disk problem — ENOSPC, EACCES, a read-only home — and it is not the
   * ledger saying no. Classifying it as `rejected` told the user their order was refused on its
   * merits and left them with no reason to look at the filesystem. Nothing was committed, so
   * `write-failed` is the honest class: this one is literally a synchronous client-side failure
   * with nothing sent anywhere, which is what that word means.
   */
  const persist = (next: PaperLedger): OrderResult | null => {
    try {
      saveLedger(next);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return finish("write-failed", false, {
        error: `The paper ledger could not be written, so nothing was recorded: ${message}`,
      });
    }
  };

  try {
    if (ticket.action === "cancel") {
      const orderId = ticket.orderId as string;
      const result = cancelPaperOrder(ledger, orderId);
      const failed = persist(result.ledger);
      if (failed) return failed;
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
      const failed = persist(result.ledger);
      if (failed) return failed;
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
    const failed = persist(result.ledger);
    if (failed) return failed;
    return finish("ok", true, {
      orderId: result.order.id,
      reason: `${PAPER_BANNER} ${result.reason}`,
      fill: paperFill(result),
    });
  } catch (err) {
    // Ledger refusals are rejections, never successful fills.
    const message = err instanceof Error ? err.message : String(err);
    return finish("rejected", false, { error: message });
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
 * `bestPrices` is the reader `paper_order_preview` already uses over the depth payload — reused rather
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

type ResultBase = Omit<OrderResult, "outcome" | "verified" | "ordersBefore" | "logged" | "paper">;

/* ------------------------------- the four entry points ------------------------------- */

/**
 * One implementation, four names.
 *
 * The action lives on the ticket, not on the call, so `paper_order_sell` cannot redeem a ticket that was
 * previewed as a buy — the mismatch is caught here rather than applied to the local ledger.
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
