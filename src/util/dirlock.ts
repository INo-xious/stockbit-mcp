/**
 * A cross-process advisory lock built on `mkdir`.
 *
 * Three places in this project need the same thing: serialise an operation across the several
 * processes that run this server at once (Claude Code and Claude Desktop each spawn one, a watch
 * daemon is a third, any CLI invocation a fourth). Token refresh needs it because the refresh token
 * rotates; a chart save needs it so two writers do not snapshot each other's pre-state; an order
 * needs it so the same ticket cannot be spent twice.
 *
 * `mkdir` is the primitive because it is atomic on every platform — unlike "check, then create",
 * which has a window between the two halves. A directory also carries an mtime, which is how a lock
 * abandoned by a process that died mid-operation is recognised and broken instead of wedging the
 * feature forever.
 *
 * ## What the callers do NOT share
 *
 * Whether failing to acquire is fatal. `src/auth/reflock.ts` and `src/core/layoutwrite.ts` proceed
 * anyway — a possible clobber beats a guaranteed outage, and both have a read-back that would catch
 * it. `src/trading/orders.ts` refuses, because a duplicated order has no read-back that can undo it.
 * That decision belongs to the caller and is deliberately not encoded here: this module reports
 * whether it got the lock and says nothing about what that should mean.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface DirLockOptions {
  /** A lock older than this belongs to a process that died holding it, and is broken. */
  staleMs: number;
  /** How long to wait for the holder to release before giving up. */
  timeoutMs: number;
  /** Retry interval while waiting. */
  pollMs?: number;
}

/** Release a held lock. Idempotent — calling it twice is not an error. */
export type DirLockRelease = () => void;

/** Age of the lock at `path` in ms, or null when there is none (or it cannot be stat'ed). */
function lockAge(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Try to take the lock directory at `path`, waiting up to `timeoutMs`.
 *
 * Returns a release function, or `null` when the lock could not be taken. A null return is a fact,
 * not an error: see the module note on why the two existing callers treat it differently.
 */
export async function acquireDirLock(
  path: string,
  { staleMs, timeoutMs, pollMs = 120 }: DirLockOptions,
): Promise<DirLockRelease | null> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      // The parent must exist before the lock can; creating it here means a first-ever run does not
      // fail on a missing `~/.stockbit`.
      //
      // Owner-only, matching `store.ts`. Without the mode, a lock taken before any credential was
      // ever written — which is the ordinary order on a fresh machine, because `bootstrap` locks
      // before it stores, and so does every refresh — creates `~/.stockbit` at 0755, and every
      // credential file written into it afterwards sits in a directory anyone on the box can list.
      // The files themselves are still 0600; the directory is the part that was wrong. (The login
      // capture is the one credential write that deliberately takes no lock — see `reflock.ts`.)
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // mkdir is atomic and fails if the directory exists — the test-then-create race does not exist
      // here, which is the whole reason for using a directory rather than a file.
      mkdirSync(path);
      // An owner token, not just a pid. `release()` used to delete the directory unconditionally,
      // which is wrong the moment a stale break happens: A takes the lock and is slow, B breaks it
      // as stale and takes its own, then A finishes and deletes B's — and C walks straight in while
      // B is still working. One stale break did not cost one collision, it dropped mutual exclusion
      // entirely for the next critical section. Reading the token back before removing means a
      // holder can only ever delete its own lock.
      //
      // A pid alone would not do: pids are reused, and two runs of the same script can share one.
      const owner = `${process.pid}.${randomBytes(8).toString("hex")}`;
      const ownerFile = join(path, "owner");
      try {
        writeFileSync(ownerFile, owner);
      } catch {
        /* best effort; the release below falls back to removing only if it cannot tell */
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          // Three cases, and the middle one is the reason this is not a one-liner.
          //
          //   - the token reads back as ours          -> remove; this is the ordinary path
          //   - it reads back as someone else's       -> leave it; we were broken as stale and that
          //                                              directory belongs to whoever replaced us
          //   - there is no token but the directory   -> ALSO leave it. That is the window between
          //     is there                                 another holder's `mkdir` and its write,
          //                                              and removing then takes a lock that was
          //                                              just legitimately acquired.
          //
          // Only a directory that is gone entirely, or one we cannot stat at all, falls through to
          // the unconditional remove — and removing something that is not there costs nothing.
          let mine: boolean;
          try {
            mine = readFileSync(ownerFile, "utf8") === owner;
          } catch {
            mine = !existsSync(path);
          }
          if (mine) rmSync(path, { recursive: true, force: true });
        } catch {
          /* a lock we cannot remove will be broken as stale */
        }
      };
    } catch {
      const age = lockAge(path);
      if (age !== null && age > staleMs) {
        // The holder crashed or was killed mid-operation. Leaving the lock forever would make every
        // future attempt fail, which is worse than the race it protects against.
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          /* someone else got there first */
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      await delay(pollMs);
    }
  }
}
