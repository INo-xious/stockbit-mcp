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

/**
 * How long a dead slot is kept after it expires, so `take()` can still tell a user WHICH thing went
 * wrong.
 *
 * Evicting on consumption would be wrong: the "already used — an order may already have been placed
 * from it" message exists precisely because a spent ticket must not be mistaken for one that never
 * existed, and that message is the one standing between a person and a duplicate order. So eviction
 * waits until well past the point where either answer means the same thing in practice.
 */
const SLOT_RETENTION_MS = TICKET_TTL_MS * 5;

/**
 * Drop slots nothing can say anything useful about any more.
 *
 * The map used to grow for the life of the process: nothing ever called `delete`, `peek` and `take`
 * only *tested* expiry, and `clearTickets()` is tests-only. Every preview in a long session left a
 * whole ticket behind — its checks, its warnings, a copy of the policy in force, a market snapshot.
 * Bounded now by the retention window rather than by uptime.
 */
function evictStale(at: number): void {
  for (const [id, slot] of slots) {
    if (at > Date.parse(slot.ticket.expiresAt) + SLOT_RETENTION_MS) slots.delete(id);
  }
}

/** Store a ticket and return it unchanged, so a caller can `return issue(build(...))`. */
export function issue<T extends TicketBase>(ticket: T): T {
  // Swept here rather than on a timer: a timer would keep the process alive, and the only moment
  // the map can grow is this one.
  evictStale(now());
  slots.set(ticket.id, { ticket, consumedAt: null });
  return ticket;
}

/** How many slots are held. Tests only — the leak this bounds is invisible from the outside. */
export function slotCount(): number {
  return slots.size;
}

/**
 * Look at a ticket without spending it.
 *
 * Returns undefined for an id that was never issued, for one that has expired, and for one that has
 * already been SPENT — a caller inspecting a ticket wants to know it is still good, and all three
 * lead to the same next step. Every caller follows a miss with `take()`, which then says which of
 * the three it was.
 *
 * The spent case was added with ADR-0010 and is not cosmetic. Since the human is now asked before
 * the ticket is taken, a `peek` that admitted a consumed ticket meant a model retrying `order_buy`
 * put the dialog in front of the person a SECOND time, asking them to approve an order that had
 * already reached the exchange — and only then refused. Being asked twice about one order is how a
 * person ends up believing they have two.
 */
export function peek(id: string): TicketBase | undefined {
  const slot = slots.get(id);
  if (!slot) return undefined;
  if (slot.consumedAt !== null) return undefined;
  if (now() > Date.parse(slot.ticket.expiresAt)) return undefined;
  return slot.ticket;
}

/**
 * The refusal a ticket's own failed checks earn, or null when nothing blocks it.
 *
 * Exported so a caller can ask the question WITHOUT spending the ticket. `passGates` uses it to
 * refuse a doomed ticket before it puts a dialog in front of a person: `take()` would refuse a
 * moment later with this exact sentence, and asking someone to approve an order that cannot be
 * placed whatever they answer is not a confirmation, it is a nuisance. One implementation so the
 * early refusal and the real one can never disagree about what blocks an order.
 */
export function blockingCheck(ticket: TicketBase): string | null {
  const failed = ticket.checks.filter((check) => !check.ok);
  if (!failed.length) return null;
  return `Order ticket ${ticket.id} cannot be placed: ${failed.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
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
  const blocked = blockingCheck(slot.ticket);
  if (blocked) throw new StockbitError("invalid_param", blocked);
  // Marked spent BEFORE the caller sends anything. See the module note.
  slot.consumedAt = now();
  return slot.ticket;
}
