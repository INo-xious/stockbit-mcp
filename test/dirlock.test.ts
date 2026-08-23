/**
 * The shared mkdir lock.
 *
 * Three call sites depend on the same two properties: a second holder cannot take a held lock, and
 * a lock abandoned by a dead process does not wedge the feature forever. What each caller does with
 * a null return differs and is asserted where that decision lives, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDirLock } from "../src/util/dirlock.ts";

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
