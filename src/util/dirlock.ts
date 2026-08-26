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
/**
 * Whether a release may remove the lock directory. Pure, and exported, because the interesting case
 * cannot be reached from a cross-platform test otherwise: it needs `writeFileSync` to fail, and the
 * only portable ways to arrange that are not portable at all.
 *
 * Four cases, and the last two are the ones that have been got wrong:
 *
 *   - the token reads back as ours     -> remove; the ordinary path
 *   - it reads back as someone else's  -> leave it; we were broken as stale and that directory
 *                                        belongs to whoever replaced us
 *   - no token, and OUR write landed   -> leave it. This is the window between another holder's
 *                                        `mkdir` and its write, and removing then takes a lock that
 *                                        was just legitimately acquired. (Unless the directory is
 *                                        gone entirely, in which case removing costs nothing.)
 *   - no token, and our write FAILED   -> remove. The absence is most likely our own, and we are
 *                                        the one caller that must always be able to release this.
 *
 * That last line is a judgement between two unlikely things, and it is worth saying which way it
 * goes. Answering "not ours" leaks the lock deterministically every time an owner write fails
 * (ENOSPC, EROFS, a directory mode that does not permit it) — and a leaked lock is not free: every
 * other process waits out the staleness threshold and then refreshes UNLOCKED, which is the double
 * rotation this module exists to prevent. Answering "ours" can only misfire if our write failed AND
 * we were broken as stale AND the replacement is inside its own sub-millisecond mkdir->write
 * window. A certain fault beats a compound improbable one.
 */
export function releaseDecision(o: {
  owner: string;
  ownerWritten: boolean;
  readOwner: string | null;
  dirExists: boolean;
}): boolean {
  if (o.readOwner !== null) return o.readOwner === o.owner;
  return o.ownerWritten ? !o.dirExists : true;
}

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
      // Whether the token actually landed, because the release below cannot work it out afterwards
      // and gets the opposite answer if it guesses. A write here can fail for ordinary reasons —
      // ENOSPC, EROFS, a directory mode that does not permit it — and without this flag such a
      // holder could never remove its own lock again.
      let ownerWritten = false;
      try {
        writeFileSync(ownerFile, owner);
        ownerWritten = true;
      } catch {
        /* recorded, not ignored; see `ownerWritten` in the release below */
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          // Which of the four cases this is, and why each goes the way it does, is in
          // `releaseDecision` above — where it can be asserted.
          let readOwner: string | null;
          try {
            readOwner = readFileSync(ownerFile, "utf8");
          } catch {
            readOwner = null;
          }
          const mine = releaseDecision({
            owner,
            ownerWritten,
            readOwner,
            dirExists: readOwner !== null || existsSync(path),
          });
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
