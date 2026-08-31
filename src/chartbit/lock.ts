/**
 * One chart operation at a time.
 *
 * Every driver tool drives the SAME browser window. `ChartbitSession.open` finds the running
 * browser through `~/.stockbit/chartbit-driver.json` and attaches to it, and `openChartTab` is
 * find-or-create on an exact URL match — so two calls for one symbol do not get a tab each, they
 * get the same tab and take turns mutating it. Nothing serialised them.
 *
 * That is not a theoretical race. The MCP SDK dispatches without awaiting — `_onrequest` ends in
 * `Promise.resolve().then(() => handler(...))` and returns void — so two tool calls arriving
 * together genuinely interleave inside one process. Issuing `chartbit_save` and
 * `chartbit_screenshot` at the same moment did exactly that in the field: the page reloaded, five
 * unsaved annotations were lost, and the local ledger went on reporting them.
 *
 * ## Why an in-process mutex and not `acquireDirLock`
 *
 * The dir lock is the right tool for a short, bounded critical section — `src/chartbit/api.ts`
 * uses it for REST writes. It is the wrong size here for one specific reason: it has no heartbeat.
 * Its staleness deadline is fixed when the lock is taken, so a correct `staleMs` would have to
 * exceed the whole hold — and `drawAnnotations` evaluates one page script PER ANNOTATION, so its
 * hold is unbounded in the number of annotations. There is no correct constant. Worse, breaking a
 * lock wrongly does not raise an error; it silently restores the exact race being fixed.
 *
 * A dir lock would also be the wrong SHAPE: it serialises across processes, and the collision that
 * was actually observed is two tool calls in one server.
 *
 * ## What this deliberately does not cover
 *
 * Two servers — Claude Code and Claude Desktop each spawn one — still share the browser, and
 * `session.ts`'s header says that is the designed configuration. This mutex does nothing about
 * them. Cross-process serialisation is a separate, larger change (the launch path needs it more
 * than the drive path does), and shipping the in-process half first fixes the collision that was
 * reported without pretending to fix the one that was not.
 *
 * It also does not, on its own, prove #14 solved. Serialising removes the interleaving; whether
 * that alone prevents the observed page reload is not established by anything in this tree, which
 * is why the ledger is made to reconcile rather than trusted to stay correct.
 */
import { StockbitError } from "../http/errors.js";

/**
 * How long a queued call waits before giving up.
 *
 * Deliberately UNDER the MCP SDK's own `DEFAULT_REQUEST_TIMEOUT_MSEC` of 60 s. A longer wait would
 * be unreachable in the only way that matters: the client gives up at 60 s and cancels, so a
 * message crafted at 180 s is written to a caller that stopped listening two minutes earlier. A
 * wait that outlives the listener is indistinguishable from a hang.
 *
 * The cost is real and accepted: a legitimately long hold — many annotations, a slow page — can
 * make the queued call fail with "still busy" while the first call is still working correctly. That
 * is a retryable, self-explaining failure, which beats a client-side timeout carrying no reason.
 */
export const DRIVER_LOCK_WAIT_MS = 45_000;

/** The ticket a holder must present to release. Identity, not a name — two calls can share a name. */
type Ticket = symbol;

interface Holder {
  ticket: Ticket;
  what: string;
  since: number;
}

interface Waiter {
  what: string;
  ticket: Ticket;
  resolve: (ticket: Ticket) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

let holder: Holder | null = null;
const waiting: Waiter[] = [];

/** FIFO: the call that queued first is the call that runs next. Starvation is not a fair queue. */
function grant(next: Waiter): void {
  clearTimeout(next.timer);
  holder = { ticket: next.ticket, what: next.what, since: Date.now() };
  next.resolve(next.ticket);
}

function waitMessage(what: string, held: Holder | null, waited: number): string {
  const seconds = Math.round(waited / 1000);
  // Names the CURRENT holder, and says so in those words. After a handoff the call blocking us is
  // not the one we originally queued behind, and claiming otherwise would be inventing a cause.
  const busy = held ? `; the chart is currently busy with ${held.what}` : "";
  return (
    `Gave up waiting ${seconds}s to start ${what}. Chart tools share ONE browser window and run ` +
    `one at a time, because two of them driving the same window is what loses drawings${busy}. ` +
    "Nothing was changed. Retry when the other chart call has finished, and prefer issuing chart " +
    "tools one after another rather than together."
  );
}

/**
 * Run `fn` with exclusive use of the chart browser.
 *
 * @param what a short present-participle phrase naming the operation, for the wait message.
 */
export async function withDriverLock<T>(
  what: string,
  fn: () => Promise<T>,
  waitTimeoutMs: number = DRIVER_LOCK_WAIT_MS,
): Promise<T> {
  const ticket = await acquire(what, waitTimeoutMs);
  try {
    return await fn();
  } finally {
    release(ticket);
  }
}

function acquire(what: string, waitTimeoutMs: number): Promise<Ticket> {
  const ticket = Symbol(what);
  if (!holder) {
    holder = { ticket, what, since: Date.now() };
    return Promise.resolve(ticket);
  }
  const queuedAt = Date.now();
  return new Promise<Ticket>((resolve, reject) => {
    const waiter: Waiter = {
      what,
      ticket,
      resolve,
      reject,
      timer: setTimeout(() => {
        const at = waiting.indexOf(waiter);
        // Already granted — `grant` cleared this timer, so reaching here at all would be a bug.
        if (at < 0) return;
        waiting.splice(at, 1);
        reject(new StockbitError("upstream", waitMessage(what, holder, Date.now() - queuedAt)));
      }, waitTimeoutMs),
    };
    waiting.push(waiter);
  });
}

/**
 * Hand the lock on, but only if the caller actually holds it.
 *
 * The ownership check is not ceremony. Without it, a release from a call whose lock had already
 * been reset or stolen would clear whatever `holder` happens to be — including a DIFFERENT call
 * that is mid-flight — and the next arrival would walk straight in beside it. That is the failure
 * this module exists to prevent, reintroduced by its own cleanup path.
 */
function release(ticket: Ticket): void {
  if (holder?.ticket !== ticket) return;
  const next = waiting.shift();
  if (!next) {
    holder = null;
    return;
  }
  grant(next);
}

/**
 * Whether a chart operation is running, and which.
 *
 * Used by the tests today. Named and exported rather than reached for through module state because
 * "is the chart busy, and with what" is the question a queued caller's error already answers, and
 * the same answer belongs on `status` the day someone wants it there.
 */
export function driverLockState(): { busy: boolean; what?: string; heldForMs?: number; queued: number } {
  return {
    busy: holder !== null,
    ...(holder ? { what: holder.what, heldForMs: Date.now() - holder.since } : {}),
    queued: waiting.length,
  };
}

/**
 * Drop the lock and fail everything queued. TESTS ONLY.
 *
 * Exported so a test file can leave the module clean for the next one; a leaked holder would make
 * an unrelated test hang for the full wait rather than fail. Waiters are REJECTED rather than
 * granted, because a reset means "whatever was running is no longer accounted for" — handing the
 * window to a queued call at that moment is the collision, not the recovery.
 */
export function resetDriverLock(): void {
  holder = null;
  while (waiting.length) {
    const waiter = waiting.shift();
    if (!waiter) break;
    clearTimeout(waiter.timer);
    waiter.reject(new StockbitError("upstream", "The chart driver lock was reset."));
  }
}
