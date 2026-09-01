/**
 * The one lock that serialises everything which drives `~/.stockbit/browser-profile`.
 *
 * Two browsers on one profile is not a slow login, it is a broken one. The documented cost, from
 * the incident that made `reap_orphans` exist: eleven orphaned browser processes, a manual `pkill`,
 * and a `SingletonLock` left in the profile that refused every later login until it was deleted by
 * hand. So every participant that can open a login window takes this lock first, and a holder is
 * refused rather than queued.
 *
 * ## Why the rule lives here rather than at the call sites
 *
 * It used to live at two of them, as two copies of `LOGIN_LOCK_STALE_MS` — with a comment on the
 * second explaining that the duplication was deliberate because nothing under `src/auth/` may
 * depend on `src/tools/`. That direction is right, and this module keeps it: `src/tools/system.ts`,
 * `src/auth/relogin.ts` and `bin/stockbit-auth.ts` may all depend on `src/auth/`, and none of them
 * depends on another. What was wrong was the NUMBER of copies. `bin/stockbit-auth.ts` was about to
 * become a third, and three hand-kept copies of a staleness budget is a rule that will drift — a
 * participant using a longer budget than its peers breaks a lock somebody is still legitimately
 * holding, which is the exact failure the budget exists to prevent.
 *
 * What is deliberately NOT here is the refusal MESSAGE. Each caller names a different likely holder
 * (a terminal, a second client, this very server mid-recovery) and a different next step, and one
 * shared sentence would have to be vague about both. The lock is one rule; the sentence is three.
 */
import { acquireDirLock, type DirLockRelease } from "../util/dirlock.js";
import { stockbitPath } from "../paths.js";

/**
 * How long the login lock is held before it is assumed to belong to a dead process.
 *
 * Generous because the operation is: the `login` tool gives a human fifteen minutes to type, and
 * the CLI uses the same ceiling. Twenty minutes is long enough that a real login is never broken as
 * stale, and short enough that a machine killed mid-login is not locked out until someone reboots.
 */
export const LOGIN_LOCK_STALE_MS = 20 * 60_000;

/**
 * Take the login lock, or report that someone else holds it. Never queues.
 *
 * `timeoutMs: 0` is part of the rule, not a tuning choice. Waiting is wrong for all three callers:
 * a queued MCP tool call is a client timeout, a queued recovery is a hung tool call, and a queued
 * CLI is a terminal that looks hung with no window to explain itself. The answer a caller needs is
 * "no", immediately, with a sentence naming what to go and finish.
 *
 * Returns the release function, or null when the lock is held. Release is idempotent.
 */
export function acquireLoginLock(): Promise<DirLockRelease | null> {
  return acquireDirLock(stockbitPath("login.lock"), { staleMs: LOGIN_LOCK_STALE_MS, timeoutMs: 0 });
}
