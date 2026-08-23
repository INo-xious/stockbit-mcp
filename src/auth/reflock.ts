/**
 * A cross-process lock around token refresh.
 *
 * ## Why this is necessary and not defensive padding
 *
 * The refresh token **rotates**: every successful refresh mints a new one and invalidates the one
 * that was presented. That is fine for a single process — `session.ts` coalesces concurrent
 * refreshes into one in-flight promise — but the store is a file on disk shared by every process
 * that runs this server, and there is normally more than one:
 *
 *   - Claude Code and Claude Desktop each spawn their own `stockbit-mcp`;
 *   - a watch daemon would be a third;
 *   - any CLI invocation is a fourth.
 *
 * Two of them refreshing at once produces a lockout, not a retry. The server issues token2 to the
 * first and token3 to the second, invalidating token2 in the process. Whichever write lands last
 * wins the file — and if that is token2, the store now holds a token the server has already
 * superseded. Every subsequent refresh 401s and the user must log in again by hand.
 *
 * This was observed, not theorised: a stored token issued three minutes earlier, with seven days
 * left on its expiry, was rejected outright.
 *
 * ## Approach
 *
 * The lock mechanism lives in `src/util/dirlock.ts`, shared with the chart-layout and order write
 * paths. What stays here is the policy: **one lock directory per token domain**, and best-effort
 * acquisition — a stale lock from a crashed process is broken rather than wedging the server
 * forever, and failing to acquire is not fatal, because a possible clobber is better than a
 * guaranteed outage.
 *
 * Per domain matters now that there are three (main, securities, e-IPO): a securities refresh
 * queued behind an exodus refresh would serialise two operations that cannot interfere, and
 * `trading-login` would appear to hang for no reason.
 *
 * The lock alone is not the whole fix. `session.ts` also re-reads the store after a failed refresh,
 * since another process may legitimately have rotated the token while this one was waiting.
 */
import { join } from "node:path";
import { acquireDirLock } from "../util/dirlock.js";
import { fileDir } from "./store.js";

/** A lock older than this is assumed to belong to a dead process. */
export const STALE_MS = 30_000;
const POLL_MS = 120;

/** Lock names by token domain. `main` keeps its historical name so an in-flight lock survives an upgrade. */
const LOCK_NAMES = {
  main: "refresh.lock",
  securities: "securities-refresh.lock",
  eipo: "eipo-refresh.lock",
} as const;

/** The token domains that hold their own refresh lock. Mirrors `TokenDomain` in `session.ts`. */
export type LockDomain = keyof typeof LOCK_NAMES;

function lockPath(domain: LockDomain): string {
  return join(fileDir(), LOCK_NAMES[domain]);
}

/**
 * Try to take a domain's refresh lock, waiting up to `timeoutMs`.
 *
 * Returns a release function, or null if the lock could not be taken. A null return is not an
 * error: the caller refreshes anyway, accepting the small clobber risk rather than failing.
 */
export async function acquireRefreshLock(
  timeoutMs = 10_000,
  domain: LockDomain = "main",
): Promise<(() => void) | null> {
  return acquireDirLock(lockPath(domain), { staleMs: STALE_MS, timeoutMs, pollMs: POLL_MS });
}
