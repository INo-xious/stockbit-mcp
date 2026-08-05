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
 * A lock directory (`mkdir` is atomic on every platform, unlike "check then create") serialises
 * refreshes across processes. It is best-effort by design: a stale lock from a crashed process is
 * broken after `STALE_MS` rather than wedging the server forever, and failing to acquire is not
 * fatal — the caller proceeds, because a possible clobber is better than a guaranteed outage.
 *
 * The lock alone is not the whole fix. `session.ts` also re-reads the store after a failed refresh,
 * since another process may legitimately have rotated the token while this one was waiting.
 */
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileDir } from "./store.js";

/** A lock older than this is assumed to belong to a dead process. */
export const STALE_MS = 30_000;
const POLL_MS = 120;

function lockPath(): string {
  return join(fileDir(), "refresh.lock");
}

/** Age of the current lock in ms, or null if there is none. */
function lockAge(): number | null {
  try {
    return Date.now() - statSync(lockPath()).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Try to take the refresh lock, waiting up to `timeoutMs`.
 *
 * Returns a release function, or null if the lock could not be taken. A null return is not an
 * error: the caller refreshes anyway, accepting the small clobber risk rather than failing.
 */
export async function acquireRefreshLock(timeoutMs = 10_000): Promise<(() => void) | null> {
  const path = lockPath();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      // mkdir is atomic and fails if the directory exists — the test-then-create race does not
      // exist here, which is the whole reason for using a directory rather than a file.
      mkdirSync(path);
      try {
        writeFileSync(join(path, "pid"), String(process.pid));
      } catch {
        /* informational only */
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* a lock we cannot remove will be broken as stale */
        }
      };
    } catch {
      const age = lockAge();
      if (age !== null && age > STALE_MS) {
        // The holder crashed or was killed mid-refresh. Leaving the lock forever would make every
        // future refresh fail, which is worse than the race it protects against.
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* someone else got there first */
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      await delay(POLL_MS);
    }
  }
}
