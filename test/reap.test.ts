/**
 * Reaping browser processes that hold the saved profile.
 *
 * Field report, 2026-08-31: eleven orphaned browser processes accumulated against
 * `user-data-dir=~/.stockbit/browser-profile` and blocked every later login with
 * "exited immediately without opening a debugging port". Clearing it took a manual `pkill` plus
 * removing a stale `SingletonLock`. Nothing in the server reaped them, because the spawn is not
 * detached and the MCP login is fire-and-forget, so the cleanup attached to the capture promise
 * never ran when that promise was abandoned.
 *
 * The process lister and the killer are injected throughout. CI runs three operating systems with
 * NO browser installed, so a test that needed a real Chromium to exercise this would be a test that
 * never runs on the machines that gate a merge — the blind spot `store.ts` records as having already
 * produced two invisible mistakes.
 */
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-reap-store-"));

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearSingletonFiles,
  holdersOfProfile,
  reapProfileHolders,
  type ProcessRow,
} from "../src/auth/reap.ts";

const PROFILE = mkdtempSync(join(tmpdir(), "stockbit-reap-profile-"));
after(() => {
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(process.env.STOCKBIT_STORE_DIR!, { recursive: true, force: true });
});

/** A process table that never blocks and never sleeps. */
function table(...rows: ProcessRow[]): () => ProcessRow[] {
  return () => rows;
}

const noWait = async (): Promise<void> => {};

/* ---------------------------------- matching ---------------------------------- */

test("matches the exact --user-data-dir, in both spellings", () => {
  const rows = table(
    { pid: 101, command: `/Applications/Chrome --remote-debugging-port=9500 --user-data-dir=${PROFILE} about:blank` },
    { pid: 102, command: `/Applications/Chrome --user-data-dir ${PROFILE}` },
  );
  const found = holdersOfProfile(PROFILE, { list: rows });
  assert.deepEqual(
    found.map((r) => r.pid),
    [101, 102],
  );
});

test("a DIFFERENT profile is not a holder, even under the same browser", () => {
  const rows = table(
    { pid: 201, command: `/Applications/Chrome --user-data-dir=${PROFILE}-other` },
    { pid: 202, command: "/Applications/Chrome" },
    { pid: 203, command: "/Applications/Chrome --user-data-dir=/Users/someone/Library/Chrome" },
  );
  assert.deepEqual(holdersOfProfile(PROFILE, { list: rows }), []);
});

test("an EMPTY profile directory matches nothing — never everything", () => {
  // The failure this guards: `--user-data-dir=` is a prefix of every Chromium this server launches,
  // so a blank directory reaching a substring match would enumerate the whole process table and
  // arrive at `reapProfileHolders` as a request to kill all of them.
  const rows = table(
    { pid: 301, command: "/Applications/Chrome --user-data-dir=/a" },
    { pid: 302, command: "/Applications/Chrome --user-data-dir=/b" },
  );
  assert.deepEqual(holdersOfProfile("", { list: rows }), []);
  assert.deepEqual(holdersOfProfile("   ", { list: rows }), []);
});

test("never matches this process", () => {
  const rows = table({ pid: process.pid, command: `node --user-data-dir=${PROFILE}` });
  assert.deepEqual(holdersOfProfile(PROFILE, { list: rows }), []);
});

/* ---------------------------------- killing ---------------------------------- */

test("SIGTERM first; a process that goes away is never SIGKILLed", async () => {
  const signals: Array<[number, string]> = [];
  let alive = [{ pid: 401, command: `chrome --user-data-dir=${PROFILE}` }];
  const result = await reapProfileHolders(PROFILE, {
    list: () => alive,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGTERM") alive = [];
    },
    wait: noWait,
  });
  assert.deepEqual(signals, [[401, "SIGTERM"]]);
  assert.equal(result.found, 1);
  assert.equal(result.killed, 1);
});

test("a survivor of SIGTERM is SIGKILLed", async () => {
  const signals: Array<[number, string]> = [];
  const stubborn = [{ pid: 501, command: `chrome --user-data-dir=${PROFILE}` }];
  let alive = stubborn;
  const result = await reapProfileHolders(PROFILE, {
    list: () => alive,
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") alive = [];
    },
    wait: noWait,
  });
  assert.deepEqual(signals, [
    [501, "SIGTERM"],
    [501, "SIGKILL"],
  ]);
  assert.equal(result.killed, 1);
});

test("a process that exits between listing and signal is not an error", async () => {
  const result = await reapProfileHolders(PROFILE, {
    list: () => [{ pid: 601, command: `chrome --user-data-dir=${PROFILE}` }],
    kill: () => {
      const err = new Error("no such process") as NodeJS.ErrnoException;
      err.code = "ESRCH";
      throw err;
    },
    wait: noWait,
  });
  // ESRCH is the outcome being asked for, not a failure to report.
  assert.deepEqual(result.errors, []);
});

test("never throws, whatever the killer does", async () => {
  const result = await reapProfileHolders(PROFILE, {
    list: () => [{ pid: 701, command: `chrome --user-data-dir=${PROFILE}` }],
    kill: () => {
      const err = new Error("not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    },
    wait: noWait,
  });
  assert.equal(result.found, 1);
  assert.ok(result.errors.length > 0, "a refused signal is reported, not swallowed");
});

/* ------------------------------ what it reports ------------------------------ */

test("the result carries PIDs and never a command line", async () => {
  // A Chromium argv can carry a URL, and a Stockbit URL can carry a token in its query string.
  const secret = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.zzzz";
  const result = await reapProfileHolders(PROFILE, {
    list: () => [{ pid: 801, command: `chrome --user-data-dir=${PROFILE} https://stockbit.com/?token=${secret}` }],
    kill: () => {},
    wait: noWait,
  });
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(secret), "no token may reach the result");
  assert.ok(!serialised.includes("--user-data-dir"), "no command line may reach the result");
  assert.ok(serialised.includes("801"), "the pid is what a caller may see");
});

/* --------------------------- singleton file cleanup --------------------------- */

beforeEach(() => {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    rmSync(join(PROFILE, name), { force: true });
  }
});

test("reports only the singleton files that were actually there", () => {
  writeFileSync(join(PROFILE, "SingletonCookie"), "1");
  assert.deepEqual(clearSingletonFiles(PROFILE), ["SingletonCookie"]);
  // `rmSync({force:true})` treats a missing path as success, so an unconditional report would have
  // claimed three files were cleared on a profile that had one.
  assert.deepEqual(clearSingletonFiles(PROFILE), []);
});

test("removes a DANGLING SingletonLock — the state a crashed browser leaves", () => {
  // `SingletonLock` is a symlink whose target names a host and a pid. After a crash the target does
  // not exist, and `existsSync` FOLLOWS the link and answers false for exactly this case, so a
  // presence check written with it would skip the one file that matters.
  symlinkSync("some-host-12345", join(PROFILE, "SingletonLock"));
  assert.equal(existsSync(join(PROFILE, "SingletonLock")), false, "precondition: existsSync cannot see it");
  assert.deepEqual(clearSingletonFiles(PROFILE), ["SingletonLock"]);
});

test("a SURVIVING browser keeps its SingletonLock", async () => {
  // `SingletonLock` is what stops a second Chromium attaching to a `user-data-dir` one is already
  // using. Removing it while a browser survived — every kill refused with EPERM, say — does not
  // clean anything up: it clears the way for two browsers to write one profile, which is how the
  // profile gets corrupted rather than merely locked.
  writeFileSync(join(PROFILE, "SingletonLock"), "held by a live browser");
  const result = await reapProfileHolders(PROFILE, {
    list: () => [{ pid: 901, command: `chrome --user-data-dir=${PROFILE}` }],
    kill: () => {
      const err = new Error("not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    },
    wait: noWait,
  });
  assert.equal(result.killed, 0);
  assert.deepEqual(result.clearedLocks, [], "the lock of a living browser must survive");
});

test("killed is not under-reported for a process that dies after SIGKILL", async () => {
  // A signalled process stays in the process table while it unwinds, so a count taken immediately
  // after the signal reports every successful kill as a failure.
  let alive = [{ pid: 902, command: `chrome --user-data-dir=${PROFILE}` }];
  let waits = 0;
  const result = await reapProfileHolders(PROFILE, {
    list: () => alive,
    kill: (_pid, signal) => {
      if (signal === "SIGKILL") {
        // Still listed at this instant; gone once the reaper waits.
        setTimeout(() => {}, 0);
      }
    },
    wait: async () => {
      waits++;
      if (waits === 2) alive = [];
    },
  });
  assert.equal(result.found, 1);
  assert.equal(result.killed, 1);
  assert.deepEqual(result.errors, []);
});

test("SIGTERM alone spares the extra process listings", async () => {
  // Each listing is another PowerShell spawn on Windows, inside a path already retrying a launch.
  let alive = [{ pid: 903, command: `chrome --user-data-dir=${PROFILE}` }];
  let listings = 0;
  await reapProfileHolders(PROFILE, {
    list: () => {
      listings++;
      return alive;
    },
    kill: (_pid, signal) => {
      if (signal === "SIGTERM") alive = [];
    },
    wait: noWait,
  });
  assert.equal(listings, 2, "holders, then survivors — no third pass when SIGTERM was enough");
});

test("clears stale singleton files even when no process holds the profile", async () => {
  writeFileSync(join(PROFILE, "SingletonLock"), "stale");
  const result = await reapProfileHolders(PROFILE, { list: () => [], kill: () => {}, wait: noWait });
  assert.equal(result.found, 0);
  // The observed lockout outlived the processes that caused it: a dangling lock alone is enough to
  // make the next launch hand off to nothing.
  assert.deepEqual(result.clearedLocks, ["SingletonLock"]);
});
