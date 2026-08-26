/**
 * The shared mkdir lock.
 *
 * Three call sites depend on the same two properties: a second holder cannot take a held lock, and
 * a lock abandoned by a dead process does not wedge the feature forever. What each caller does with
 * a null return differs and is asserted where that decision lives, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDirLock, releaseDecision } from "../src/util/dirlock.ts";

const DIR = mkdtempSync(join(tmpdir(), "stockbit-dirlock-test-"));
const opts = { staleMs: 30_000, timeoutMs: 300, pollMs: 20 };

test("a held lock blocks a second holder, and releasing frees it", async () => {
  const path = join(DIR, "a.lock");
  const release = await acquireDirLock(path, opts);
  assert.ok(release, "the first acquire must succeed");
  assert.equal(await acquireDirLock(path, opts), null, "a held lock must not be handed out twice");
  release!();
  assert.equal(existsSync(path), false, "release must remove the directory");
  const again = await acquireDirLock(path, opts);
  assert.ok(again, "the lock must be takeable again");
  again!();
});

test("releasing twice is not an error", async () => {
  const release = await acquireDirLock(join(DIR, "b.lock"), opts);
  release!();
  release!();
});

test("a lock older than staleMs is broken rather than waited on", async () => {
  // The holder crashed. Leaving the lock forever would make every future attempt fail, which is
  // worse than the race the lock protects against.
  const path = join(DIR, "c.lock");
  const held = await acquireDirLock(path, opts);
  assert.ok(held);
  const old = new Date(Date.now() - opts.staleMs - 5_000);
  utimesSync(path, old, old);
  const taken = await acquireDirLock(path, opts);
  assert.ok(taken, "a stale lock must be breakable");
  taken!();
});

test("the parent directory is created if it does not exist", async () => {
  // A first-ever run has no ~/.stockbit; failing to lock because of that would break the very first
  // refresh rather than the hundredth.
  const path = join(DIR, "nested", "deeper", "d.lock");
  const release = await acquireDirLock(path, opts);
  assert.ok(release);
  release!();
});

test(
  "the parent directory is created owner-only",
  { skip: process.platform === "win32" ? "NTFS cannot express POSIX mode 0o700" : false },
  async () => {
    // The lock is often the FIRST thing written under `~/.stockbit` on a fresh machine — `bootstrap`
    // and `login` both take it before they store anything. Without an explicit mode, `mkdirSync`
    // used the process umask and left the directory at 0755, and every credential file written into
    // it afterwards sat somewhere any user on the box could list. The files are 0600 either way;
    // the directory was the part that was wrong.
    const parent = join(mkdtempSync(join(tmpdir(), "stockbit-dirlock-mode-")), "made-by-the-lock");
    const release = await acquireDirLock(join(parent, "d.lock"), opts);
    assert.ok(release, "the lock must be takeable in a directory that did not exist");
    assert.equal(
      statSync(parent).mode & 0o777,
      0o700,
      "a directory created on the way to taking the lock must be owner-only",
    );
    release!();
  },
);

test("a holder broken as stale cannot delete the lock that replaced it", async () => {
  // `release()` used to remove the directory unconditionally. Sequence: A takes the lock and is
  // slow; B waits, sees it is stale, breaks it and takes its own; A finishes and deletes B's — and
  // C walks straight in while B is still working. One stale break did not cost one collision, it
  // dropped mutual exclusion entirely for the following critical section.
  const path = join(DIR, "stale-handoff.lock");
  const a = await acquireDirLock(path, opts);
  assert.ok(a, "A takes the lock");

  // A is now slow enough to look dead.
  const old = new Date(Date.now() - opts.staleMs - 5_000);
  utimesSync(path, old, old);

  const b = await acquireDirLock(path, opts);
  assert.ok(b, "B breaks the stale lock and takes its own");

  a!(); // A finishes, late.
  assert.equal(existsSync(path), true, "A must not have deleted B's lock");
  assert.equal(await acquireDirLock(path, opts), null, "and C must still be locked out");

  b!();
  assert.equal(existsSync(path), false, "B's own release still works");
});

test("a late release does not remove a lock whose owner file has not been written yet", async () => {
  // The window between another holder's `mkdir` and its `writeFileSync(owner)`. Reading the owner
  // file throws ENOENT there, and treating that as "must be mine" deletes a lock that was just
  // legitimately acquired — narrower than the unconditional delete it replaced, but the same bug.
  const path = join(DIR, "owner-gap.lock");
  const a = await acquireDirLock(path, opts);
  assert.ok(a, "A takes the lock");

  const old = new Date(Date.now() - opts.staleMs - 5_000);
  utimesSync(path, old, old);
  const b = await acquireDirLock(path, opts);
  assert.ok(b, "B breaks the stale lock and takes its own");

  // B is mid-acquisition: the directory exists, the owner file does not yet.
  rmSync(join(path, "owner"), { force: true });

  a!(); // A's late release lands in that window.
  assert.equal(existsSync(path), true, "A must not delete a lock it cannot prove is not B's");

  // B's own release is a no-op here too, and that is correct rather than a second bug: the test
  // deleted B's owner file, so B is in the same position A was — holding a directory it cannot
  // prove is still its own. Asserted so the sequence ends with a claim instead of trailing off.
  b!();
  assert.equal(existsSync(path), true, "with its token deleted out from under it, B cannot prove ownership either");
});

test("a release never removes a directory it cannot positively identify as its own", () => {
  // This rule has now been got wrong twice, in opposite directions, so it is pinned exhaustively.
  //
  // The second attempt removed the directory whenever OUR OWN owner write had failed, reasoning
  // that the missing token was probably ours. It is not: every cause of an owner-write failure
  // (ENOSPC, EROFS, a directory mode that does not permit it) belongs to the directory or the
  // filesystem, not to one process — so if our write failed, the next holder's write fails too, its
  // token never appears, and the late release deletes a lock somebody is actively holding. That is
  // a lock THEFT, and unlike a leak it does not age out: two processes rotate the refresh token, or
  // two orders for the same symbol go in flight.
  //
  // A holder whose owner write fails no longer becomes a holder — `acquireDirLock` removes the
  // directory it just made and returns null — so this function has nothing left to trade off.
  assert.equal(
    releaseDecision({ owner: "a", readOwner: null, dirExists: true }),
    false,
    "no token to read: the directory belongs to a holder mid-acquisition, and must be left alone",
  );

  // The two identifiable cases.
  assert.equal(releaseDecision({ owner: "a", readOwner: "a", dirExists: true }), true);
  assert.equal(
    releaseDecision({ owner: "a", readOwner: "b", dirExists: true }),
    false,
    "we were broken as stale; that directory belongs to whoever replaced us",
  );

  // And removing something that is not there costs nothing.
  assert.equal(releaseDecision({ owner: "a", readOwner: null, dirExists: false }), true);
});
