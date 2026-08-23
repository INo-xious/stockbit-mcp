/**
 * Order tickets: the two-step protocol's memory.
 *
 * `order_preview` builds a ticket and hands back its id. `order_buy` takes that id and places what
 * the ticket says. Nothing between the two can change the order — the write tools accept a ticket
 * id and a confirmation, and no price, no lot count and no symbol. That is what makes the user's
 * "yes" mean something specific: they agreed to the summary they were shown, and the summary and
 * the request are the same object.
 *
 * ## Why they live in memory and expire
 *
 * A ticket is priced against a market. Two minutes later the quote, the bands and the buying power
 * it was checked against may all be different, so it stops being an agreement and becomes a stale
 * intention. Expiry is not a security control; it is honesty about what the checks covered.
 *
 * In memory, and never on disk: a persisted ticket would survive a restart and could be redeemed
 * against a market it was never priced for, and a file of them would be a list of intended orders
 * sitting in the user's home directory.
 *
 * ## `take` consumes before the request goes out
 *
 * Not after. A double-send is the one failure mode here with no undo — the exchange would have two
 * orders and the account holder agreed to one — so the window between "this ticket is spent" and
 * "the request left" is closed on the safe side. The cost of getting it wrong the other way is an
 * order the user has to re-preview; the cost this way is an order they never agreed to.
 */
import { StockbitError } from "../http/errors.js";

/**
 * What every ticket has, whatever it is a ticket for.
 *
 * Exchange orders and e-IPO subscriptions are different commitments with different checks, but the
 * protocol around them is identical — preview, show the user, redeem once, expire — so they share
 * one store. `kind` is what stops an e-IPO ticket being redeemed by `order_buy` and vice versa.
 */
export interface TicketBase {
  id: string;
  kind: "order" | "eipo";
  expiresAt: string;
  checks: Array<{ name: string; ok: boolean; detail: string; unverified?: true }>;
  summary: string;
}

/** How long a ticket stays redeemable. Two minutes: long enough to ask, short enough to still mean it. */
export const TICKET_TTL_MS = 120_000;

interface Slot {
  ticket: TicketBase;
  consumedAt: number | null;
}

const slots = new Map<string, Slot>();

/**
 * The clock, injectable.
 *
 * Expiry is the behaviour most worth testing here and the only way to test it honestly is to move
 * time. Exported as a setter rather than read from the environment so nothing in production can
 * accidentally run on a fake clock.
 */
let clock: () => number = () => Date.now();

/** Replace the clock. Tests only — `resetClock()` puts it back. */
export function setClock(fn: () => number): void {
  clock = fn;
}

export function resetClock(): void {
  clock = () => Date.now();
}

export function now(): number {
  return clock();
}

/** Drop every ticket. Tests only. */
export function clearTickets(): void {
  slots.clear();
}

/** Store a ticket and return it unchanged, so a caller can `return issue(build(...))`. */
export function issue<T extends TicketBase>(ticket: T): T {
  slots.set(ticket.id, { ticket, consumedAt: null });
  return ticket;
}

/**
 * Look at a ticket without spending it.
 *
 * Returns undefined for an id that was never issued and for one that has expired — a caller
 * inspecting a ticket wants to know it is still good, and "expired" and "gone" lead to the same
 * next step.
 */
export function peek(id: string): TicketBase | undefined {
  const slot = slots.get(id);
  if (!slot) return undefined;
  if (now() > Date.parse(slot.ticket.expiresAt)) return undefined;
  return slot.ticket;
}

/**
 * Spend a ticket, or refuse and say exactly why.
 *
 * The four refusals are separate messages on purpose. "Expired" tells the user to preview again;
 * "already used" tells them the order may already exist and to look before retrying; "checks
 * failed" tells them what to fix. One generic error would make all three read as a glitch.
 */
export function take(id: string, expectedKind?: TicketBase["kind"]): TicketBase {
  const slot = slots.get(id);
  if (!slot) {
    throw new StockbitError(
      "invalid_param",
      `No order ticket ${id}. Tickets last ${TICKET_TTL_MS / 1000} seconds and are held in memory, so this one ` +
        "has expired, was already used, or belongs to a previous run of this server. Run order_preview again.",
    );
  }
  if (slot.consumedAt !== null) {
    throw new StockbitError(
      "invalid_param",
      `Order ticket ${id} was already used. An order may already have been placed from it — check the open ` +
        "orders before previewing another one, so the account does not end up with two.",
    );
  }
  if (now() > Date.parse(slot.ticket.expiresAt)) {
    throw new StockbitError(
      "invalid_param",
      `Order ticket ${id} expired at ${slot.ticket.expiresAt}. It was priced against a market that has moved ` +
        "since; run order_preview again and show the user the new numbers.",
    );
  }
  if (expectedKind && slot.ticket.kind !== expectedKind) {
    throw new StockbitError(
      "invalid_param",
      `Ticket ${id} is a ${slot.ticket.kind} ticket and this tool redeems ${expectedKind} tickets. Nothing ` +
        "was sent.",
    );
  }
  const failed = slot.ticket.checks.filter((check) => !check.ok);
  if (failed.length) {
    throw new StockbitError(
      "invalid_param",
      `Order ticket ${id} cannot be placed: ${failed.map((c) => `${c.name} — ${c.detail}`).join("; ")}`,
    );
  }
  // Marked spent BEFORE the caller sends anything. See the module note.
  slot.consumedAt = now();
  return slot.ticket;
}
