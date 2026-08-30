/**
 * The drip loop: 120,000 requests, politely, resumably, and stoppable at any moment.
 *
 * Every dependency is injected. That is not ceremony — it is what lets the entire control flow of a
 * three-week backfill (throttling, the kill switch, the market-hours guard, the circuit breaker,
 * checkpointing, verification failure) be tested in milliseconds against fakes, with no network and
 * no clock. The one thing this loop must never do is behave differently under test than in
 * production, so production wires the real functions into the same shape.
 *
 * ## Four ways it stops, all deliberate
 *
 * - **kill-file** — the operator's stop button. Checked before every request, so the worst case
 *   between "touch the file" and "stopped" is one in-flight request.
 * - **market hours** — this account's session is also the one the interactive tools use, and the
 *   refresh token is single-use. Backfilling during trading hours competes with real use and, on
 *   2026-08-29, concurrent refreshes locked the account out. Off-hours by default.
 * - **request budget** — a night's ration, so an unattended run cannot decide to spend the whole
 *   backfill in one sitting.
 * - **circuit breaker** — consecutive failures mean something systemic (token dead, network gone,
 *   endpoint changed). Continuing would hammer an unofficial API while broken, which is how an
 *   account gets flagged. Stop and alert instead.
 *
 * Isolated failures are different: one bad symbol-day does not abort a run. It is recorded, skipped,
 * and left un-checkpointed so the next pass retries it.
 */
import type { WorkItem } from "./planner.js";
import type { WindowVerdict } from "./verify.js";

export type StopReason =
  | "complete"
  | "killed"
  | "market-open"
  | "budget-spent"
  | "too-many-failures"
  | "aborted";

export interface ProgressEvent {
  item: WorkItem;
  index: number;
  total: number;
  outcome: "ok" | "verify-failed" | "error";
  detail?: string;
}

export interface RunnerDeps {
  /** Perform the request. Throws on transport failure. */
  fetch(item: WorkItem): Promise<unknown>;
  /** Assert the response is the window that was asked for. */
  verify(item: WorkItem, payload: unknown): WindowVerdict;
  /** Write the raw response to the raw zone. Must be durable before `markDone`. */
  persist(item: WorkItem, payload: unknown): Promise<void>;
  /** Append the item's key to the checkpoint. Only ever called after a successful persist. */
  markDone(item: WorkItem): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  /** True when the operator's kill-file is present. */
  killed(): boolean;
  isTradingHours(now: Date): boolean;
  onProgress?(event: ProgressEvent): void;
  /** Injectable for deterministic tests. */
  random?(): number;
}

export interface RunnerOptions {
  items: readonly WorkItem[];
  /** Base delay between requests. */
  rateMs: number;
  /** Uniform extra delay in [0, jitterMs) — a perfectly regular pulse is a fingerprint. */
  jitterMs?: number;
  offHoursOnly?: boolean;
  maxRequests?: number;
  maxConsecutiveFailures?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  attempted: number;
  succeeded: number;
  failed: number;
  stoppedBecause: StopReason;
  failures: { key: string; reason: string }[];
  /** Items never reached — the remainder for the next run. */
  remaining: number;
}

const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export async function run(opts: RunnerOptions, deps: RunnerDeps): Promise<RunResult> {
  const items = opts.items;
  const jitter = opts.jitterMs ?? 0;
  const budget = opts.maxRequests ?? Number.POSITIVE_INFINITY;
  const breaker = opts.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const random = deps.random ?? Math.random;

  const failures: { key: string; reason: string }[] = [];
  let attempted = 0;
  let succeeded = 0;
  let consecutiveFailures = 0;
  let stoppedBecause: StopReason = "complete";
  let index = 0;

  for (; index < items.length; index++) {
    const item = items[index];

    // Every stop condition is checked BEFORE the request, so the loop can never spend one more
    // request than it was allowed to.
    if (opts.signal?.aborted) { stoppedBecause = "aborted"; break; }
    if (deps.killed()) { stoppedBecause = "killed"; break; }
    if (attempted >= budget) { stoppedBecause = "budget-spent"; break; }
    if (opts.offHoursOnly && deps.isTradingHours(deps.now())) { stoppedBecause = "market-open"; break; }

    // Throttle before every request except the first: a run that resumes should not burst.
    if (attempted > 0) {
      await deps.sleep(opts.rateMs + Math.floor(random() * (jitter + 1)));
    }

    attempted++;
    try {
      const payload = await deps.fetch(item);
      const verdict = deps.verify(item, payload);

      if (!verdict.ok) {
        // Verification failure is never checkpointed. Wrong-window data is worse than missing data,
        // because missing data is visible and wrong data is not.
        consecutiveFailures++;
        failures.push({ key: item.key, reason: `${verdict.reason} (${verdict.observed})` });
        deps.onProgress?.({ item, index, total: items.length, outcome: "verify-failed", detail: verdict.reason });
      } else {
        await deps.persist(item, payload);
        await deps.markDone(item);
        succeeded++;
        consecutiveFailures = 0;
        deps.onProgress?.({ item, index, total: items.length, outcome: "ok", detail: verdict.note });
      }
    } catch (err) {
      consecutiveFailures++;
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ key: item.key, reason });
      deps.onProgress?.({ item, index, total: items.length, outcome: "error", detail: reason });
    }

    if (consecutiveFailures >= breaker) {
      stoppedBecause = "too-many-failures";
      index++;                                   // this item was attempted; do not recount it
      break;
    }
  }

  return {
    attempted,
    succeeded,
    failed: failures.length,
    stoppedBecause,
    failures,
    remaining: Math.max(0, items.length - index),
  };
}
