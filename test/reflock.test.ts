// Isolate the store BEFORE importing anything that reads it — the lock lives beside it.
import { mkdtempSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-lock-"));

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { acquireRefreshLock, STALE_MS } from "../src/auth/reflock.ts";
import { getStore } from "../src/auth/store.ts";
import { forceRefresh, resetSession } from "../src/auth/session.ts";
import { StockbitError } from "../src/http/errors.ts";

const LOCK = join(process.env.STOCKBIT_STORE_DIR!, "refresh.lock");

function jwt(exp: number, tag = "x"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp, tag })}.sig`;
}

/* ---------------------------------- the lock ---------------------------------- */

test("the lock is exclusive while held and reusable after release", async () => {
  const release = await acquireRefreshLock(1000);
  assert.ok(release, "first acquire should succeed");
  assert.ok(existsSync(LOCK), "the lock should exist on disk for other processes to see");

  const contended = await acquireRefreshLock(300);
  assert.equal(contended, null, "a second acquire must not succeed while the lock is held");

  release!();
  assert.equal(existsSync(LOCK), false, "release should remove the lock");

  const again = await acquireRefreshLock(1000);
  assert.ok(again, "the lock should be reusable once released");
  again!();
});

test("releasing twice is harmless", async () => {
  const release = await acquireRefreshLock(1000);
  release!();
  release!();
  assert.equal(existsSync(LOCK), false);
});

test("a stale lock from a dead process is broken rather than wedging refresh forever", async () => {
  // A crash mid-refresh would otherwise leave the lock in place and make every future refresh
  // fail — worse than the race the lock exists to prevent.
  const release = await acquireRefreshLock(1000);
  assert.ok(release);
  const old = new Date(Date.now() - STALE_MS - 5000);
  utimesSync(LOCK, old, old);

  const taken = await acquireRefreshLock(2000);
  assert.ok(taken, "a lock older than STALE_MS must be breakable");
  taken!();
});

test("failing to acquire is not fatal — the caller may proceed", async () => {
  // Documented behaviour: a possible clobber beats a guaranteed outage.
  const held = await acquireRefreshLock(1000);
  const result = await acquireRefreshLock(200);
  assert.equal(result, null, "returns null rather than throwing");
  held!();
});

/* ------------------------- rotation race, end to end ------------------------- */

const realFetch = globalThis.fetch;
/** The one refresh token the fake server currently accepts. Anything else is a superseded copy. */
let serverToken = "";
/** Tokens presented, in order, so a test can assert which one the retry used. */
const presented: string[] = [];

before(() => {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("/login/refresh")) return new Response("not found", { status: 404 });
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    const token = auth.replace("Bearer ", "");
    presented.push(token);

    if (token !== serverToken) {
      return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 });
    }
    return new Response(
      JSON.stringify({
        data: { access_token: jwt(2000000000, "access"), refresh_token: jwt(2000000000, "rotated") },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
});

/** Run `fn` with the store's `get` stubbed, restoring it even if the assertion throws. */
async function withStoredTokens(reads: () => string | null, fn: () => Promise<void>): Promise<void> {
  const store = getStore();
  const real = store.get.bind(store);
  (store as unknown as { get: () => string | null }).get = reads;
  try {
    await fn();
  } finally {
    (store as unknown as { get: unknown }).get = real;
  }
}

test("a token superseded by another process is retried with the rotated one, not surfaced as a lockout", async () => {
  // The observed failure: this process reads token A, another process refreshes and rotates the
  // store to token B, and A is rejected. Re-reading the store and retrying once turns what was a
  // forced manual re-login into a hiccup.
  const stale = jwt(2000000000, "stale");
  const rotated = jwt(2000000000, "rotated-by-the-other-process");
  serverToken = rotated;
  presented.length = 0;
  resetSession();

  await withStoredTokens(
    // Keyed on requests sent, not on reads: `ensureFresh` reads the store once before refreshing at
    // all, so a read counter would hand the stale copy to the pre-check and never to the wire. The
    // other process's rotation lands while this one's first request is in flight.
    () => (presented.length === 0 ? stale : rotated),
    async () => {
      const token = await forceRefresh();
      assert.ok(token, "refresh should ultimately succeed");
      // Snapshot: an AssertionError holds a live reference, and a later test would rewrite it.
      assert.deepEqual([...presented], [stale, rotated], "the retry must present the token now on disk");
    },
  );
});

test("a genuinely dead token fails with an actionable message rather than retrying forever", async () => {
  // Same 401, different cause: the store has not moved, so there is nothing to retry with. The
  // retry must not loop, and the message must name the command that fixes it.
  const dead = jwt(2000000000, "dead");
  serverToken = jwt(2000000000, "something-else");
  presented.length = 0;
  resetSession();

  await withStoredTokens(
    () => dead,
    async () => {
      await assert.rejects(
        () => forceRefresh(),
        (err: unknown) => {
          assert.ok(err instanceof StockbitError);
          assert.equal(err.status, 401);
          assert.equal(err.kind, "auth");
          assert.match(err.message, /stockbit-auth login/, "the error must say how to recover");
          return true;
        },
      );
      assert.equal(presented.length, 1, "an unchanged store must not trigger a retry");
    },
  );
});

test("the refresh goes out as the declared loginRefresh route, not a hand-rolled fetch", async () => {
  // This call is the single write ADR-0002 permits; it must travel the policed transport like
  // everything else, or the boundary is decorative.
  const token = jwt(2000000000, "route-check");
  serverToken = token;
  presented.length = 0;
  resetSession();
  let seenUrl = "";
  let seenMethod = "";
  const stub = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seenUrl = String(url);
    seenMethod = String(init?.method ?? "GET");
    return stub(url as string, init);
  }) as typeof fetch;

  await withStoredTokens(
    () => token,
    async () => {
      await forceRefresh();
    },
  );

  globalThis.fetch = stub;
  assert.equal(seenMethod, "POST");
  assert.match(seenUrl, /^https:\/\/exodus\.stockbit\.com\/login\/refresh$/);
});
