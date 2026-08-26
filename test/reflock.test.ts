// Isolate the store BEFORE importing anything that reads it — the lock lives beside it.
import { mkdtempSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-lock-"));

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  acquireRefreshLock,
  REFRESH_LOCK_TIMEOUT_MS,
  STALE_MS,
  withCredentialLock,
} from "../src/auth/reflock.ts";
import { RATE } from "../src/config.ts";
import {
  CREDENTIAL_COOKIE,
  clearWebSession,
  saveWebSession,
  type WebSession,
} from "../src/auth/websession.ts";
import { getStore } from "../src/auth/store.ts";
import { ensureFresh, forceRefresh, hasStoredSession, resetSession } from "../src/auth/session.ts";
import { clearAccessCache, readAccessCache, writeAccessCache } from "../src/auth/accesscache.ts";
import { setTimeout as sleep } from "node:timers/promises";
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

/* ------------------------------ the arithmetic ------------------------------ */

test("both lock timings exceed the worst case a legitimate holder can take", () => {
  // `refreshOnce` issues one request bounded by `requestTimeoutMs`, and a 401 makes it re-read the
  // store and issue a second — inside the same lock. So two full request timeouts is the worst case
  // BEFORE anything has gone wrong.
  //
  // This assertion exists so that raising `RATE.requestTimeoutMs` breaks a test rather than the
  // behaviour. The old values (wait 10 s, stale at 30 s, against a 40 s worst case) failed both
  // halves of it, and the symptom — a slow-but-healthy holder having its lock broken out from under
  // it, then both processes rotating — looks nothing like a timeout bug.
  const worstCase = 2 * RATE.requestTimeoutMs;
  assert.ok(
    STALE_MS > worstCase,
    `STALE_MS (${STALE_MS}) must exceed 2 x requestTimeoutMs (${worstCase}), or a holder that is ` +
      "merely slow has its lock broken as if it had crashed",
  );
  assert.ok(
    REFRESH_LOCK_TIMEOUT_MS > worstCase,
    `REFRESH_LOCK_TIMEOUT_MS (${REFRESH_LOCK_TIMEOUT_MS}) must exceed 2 x requestTimeoutMs ` +
      `(${worstCase}), or a caller queued behind a healthy refresh gives up and refreshes in ` +
      "parallel — the exact collision the lock exists to prevent",
  );
});

test("the acquisition timeout outlives the staleness threshold, so a crashed holder is recoverable", () => {
  // `acquireDirLock` only breaks a stale lock WHILE IT IS STILL WAITING. A waiter whose timeout is
  // shorter than staleMs therefore can never break one: it gives up first, and so does the next
  // caller, and the lock a crashed process left behind wedges every refresh until a human deletes
  // it. The old pair had exactly that hole.
  assert.ok(
    REFRESH_LOCK_TIMEOUT_MS > STALE_MS,
    `REFRESH_LOCK_TIMEOUT_MS (${REFRESH_LOCK_TIMEOUT_MS}) must exceed STALE_MS (${STALE_MS})`,
  );
});

/* --------------------------- withCredentialLock --------------------------- */

test("withCredentialLock runs the write while holding the lock, and releases it after", async () => {
  let heldDuring: boolean | null = null;
  const result = await withCredentialLock("main", () => {
    heldDuring = existsSync(LOCK);
    return "written";
  });
  assert.equal(result, "written", "the callback's value is returned to the caller");
  assert.equal(heldDuring, true, "the lock must be held while the write runs");
  assert.equal(existsSync(LOCK), false, "the lock must be released afterwards");
});

test("withCredentialLock releases the lock even when the write throws", async () => {
  await assert.rejects(
    () =>
      withCredentialLock("main", () => {
        throw new Error("keychain refused");
      }),
    /keychain refused/,
  );
  assert.equal(existsSync(LOCK), false, "a throwing write must not leak the lock");
});

test("withCredentialLock proceeds when the lock cannot be taken", async () => {
  // Documented policy, and the opposite of `syncStoreFromBrowser`'s: for every caller of this
  // helper the alternative is refusing to do what the user just asked — refusing to store a token
  // they pasted, refusing to log out — and a possible clobber is better than that.
  const held = await acquireRefreshLock(1000);
  assert.ok(held, "hold the lock so the helper cannot take it");
  let ran = false;
  const result = await withCredentialLock("main", () => {
    ran = true;
    return 42;
  }, 200);
  assert.equal(ran, true, "a null lock must not skip the write");
  assert.equal(result, 42);
  held!();
});

/* --------------------- never lose a rotated refresh token --------------------- */

/** Run `fn` with the store's `set` replaced, restoring it even if the assertion throws. */
async function withStoreSet(writes: (token: string) => void, fn: () => Promise<void>): Promise<void> {
  const store = getStore();
  const real = store.set.bind(store);
  (store as unknown as { set: (t: string) => void }).set = writes;
  try {
    await fn();
  } finally {
    (store as unknown as { set: unknown }).set = real;
  }
}

test("a rotated token that cannot be written is kept, not thrown away", async () => {
  // The failure this prevents: `store.set` throws (locked Keychain, denied ACL prompt, EPERM from
  // an antivirus holding the temp file), the exception propagates, and the rotated token is lost
  // PERMANENTLY — the one it replaced was retired server-side the instant this pair was issued.
  // A transient disk error used to cost a forced interactive re-login.
  const stale = jwt(2000000000, "pre-rotation");
  const rotated = jwt(2000000000, "rotated");
  serverToken = stale;
  presented.length = 0;
  resetSession();

  let writeAttempts = 0;
  await withStoreSet(
    () => {
      writeAttempts++;
      throw new Error("Keychain write failed");
    },
    async () => {
      await withStoredTokens(
        () => stale,
        async () => {
          const access = await forceRefresh();
          assert.ok(access, "the access token must still be returned — it is valid for 24 hours");
          assert.equal(writeAttempts, 2, "the write is retried once before giving up");
        },
      );
    },
  );

  // The rotated token is now held in memory. The next refresh must present IT, not the spent copy
  // still sitting in the store.
  serverToken = rotated;
  presented.length = 0;
  resetSession();
  await withStoredTokens(
    () => stale,
    async () => {
      await forceRefresh();
      assert.deepEqual(
        [...presented],
        [rotated],
        "the in-memory rotated token must be presented instead of the spent stored one",
      );
    },
  );
});

test("a rotated token held in memory is dropped once the store moves on", async () => {
  // Without this, a token kept in memory after a failed write would shadow a credential the user
  // had just deliberately replaced — `bootstrap`, `login` and `logout` all write the store directly.
  const stale = jwt(2000000000, "before");
  const rotated = jwt(2000000000, "rotated");
  const pasted = jwt(2000000000, "what-the-user-just-bootstrapped");

  serverToken = stale;
  presented.length = 0;
  resetSession();
  await withStoreSet(
    () => {
      throw new Error("Keychain write failed");
    },
    async () => {
      await withStoredTokens(
        () => stale,
        async () => {
          await forceRefresh();
        },
      );
    },
  );

  // The user runs `bootstrap`. The store now holds something the in-memory copy never superseded.
  serverToken = pasted;
  presented.length = 0;
  resetSession();
  await withStoredTokens(
    () => pasted,
    async () => {
      await forceRefresh();
      assert.deepEqual(
        [...presented],
        [pasted],
        "the store is authoritative once it stops holding what the in-memory copy superseded",
      );
    },
  );
  assert.notEqual(rotated, pasted, "the two tokens must differ for this test to mean anything");
});

test("the 401 retry is bounded at one, even when the store keeps changing", async () => {
  // The re-read has to differ for the retry to fire, so in principle it terminates on its own. "In
  // principle" is doing the work there: the failure mode of being wrong is unbounded recursion
  // inside a HELD lock, issuing a request per level, while every other process waits on it.
  serverToken = jwt(2000000000, "never-matches");
  presented.length = 0;
  resetSession();

  let reads = 0;
  await withStoredTokens(
    () => jwt(2000000000, `moving-target-${reads++}`),
    async () => {
      await assert.rejects(() => forceRefresh(), StockbitError);
      assert.equal(presented.length, 2, "one request plus exactly one retry, never more");
    },
  );
});

/* --------------------- the 401 self-heal from the web session --------------------- */

/** A stored web session whose credentialStorage cookie carries `refresh`. */
function browserSessionHolding(refresh: string): WebSession {
  return {
    capturedAt: new Date().toISOString(),
    cookies: [
      {
        name: CREDENTIAL_COOKIE,
        value: encodeURIComponent(JSON.stringify({ state: { refresh }, version: 0 })),
        domain: ".stockbit.com",
        path: "/",
      },
    ],
    origins: [],
  };
}

test("a 401 recovers from the stored web session instead of declaring the session dead", async () => {
  // THE bug, end to end. Loading a Stockbit page boots the SPA, the SPA refreshes, and the family
  // rotates — so the browser holds token N+1 while the store still holds N. The very next
  // market-data call presents N and gets a 401, and the user is told to log in again.
  //
  // The rotated token was never out of reach: the chart path already captures the browser session
  // on the way out, and that blob carries the new token in the credentialStorage cookie. This is a
  // file read — no browser, no network, nothing interactive — and it turns the fatal error into a
  // hiccup nobody sees.
  const spent = jwt(2000000000, "spent-by-the-browser");
  const fromBrowser = jwt(2100000000, "what-the-browser-rotated-to");
  serverToken = fromBrowser;
  presented.length = 0;
  resetSession();

  const store = getStore();
  store.set(spent);
  saveWebSession(browserSessionHolding(fromBrowser));

  try {
    const access = await forceRefresh();
    assert.ok(access, "the refresh must succeed rather than reporting a dead session");
    assert.deepEqual(
      [...presented],
      [spent, fromBrowser],
      "the retry must present the token the browser rotated to",
    );
    // Not `fromBrowser`: the retry SUCCEEDED, and a successful refresh rotates again — so the store
    // ends up holding what the server issued on the retry. What matters is that it moved off the
    // spent token, which is the thing that was 401ing.
    assert.notEqual(store.get(), spent, "the store must no longer hold the token the browser spent");
  } finally {
    clearWebSession();
    store.clear();
    resetSession();
  }
});

test("a 401 with nothing newer in the web session still fails, and says how to recover", async () => {
  // The self-heal must not turn a genuinely dead credential into a retry loop, or a revoked session
  // becomes a hang instead of a message.
  const dead = jwt(2000000000, "genuinely-revoked");
  serverToken = jwt(2000000000, "something-else-entirely");
  presented.length = 0;
  resetSession();

  const store = getStore();
  store.set(dead);
  saveWebSession(browserSessionHolding(dead));

  try {
    await assert.rejects(
      () => forceRefresh(),
      (err: unknown) => {
        assert.ok(err instanceof StockbitError);
        assert.equal(err.status, 401);
        assert.match(err.message, /stockbit-auth login/);
        return true;
      },
    );
    assert.equal(presented.length, 1, "the same token in both places is not a reason to retry");
  } finally {
    clearWebSession();
    store.clear();
    resetSession();
  }
});

/* ------------------------ the shared access-token cache ------------------------ */

/** What the fake server rotates TO on every successful refresh. */
const ROTATED = jwt(2000000000, "rotated");

test("a second process uses the shared access token instead of spending another rotation", async () => {
  // The cost being avoided is not a request. Minting an access token SPENDS a rotation of a
  // credential only one process can hold at a time, and there are normally several processes:
  // Claude Code, Claude Desktop, a daemon, a CLI. Each one minting its own retires the others'.
  const first = jwt(2000000000, "first");
  const store = getStore();
  store.set(first);
  serverToken = first;
  presented.length = 0;
  resetSession();
  clearAccessCache();

  try {
    await ensureFresh();
    assert.equal(presented.length, 1, "the first process refreshes");
    assert.equal(store.get(), ROTATED, "and the rotation lands on disk");
    assert.ok(readAccessCache("main", ROTATED), "the access token is shared, keyed to the ROTATED token");

    // A second process: same disk, no in-memory state of its own.
    resetSession();
    const token = await ensureFresh();
    assert.ok(token, "the second process gets a token");
    assert.equal(presented.length, 1, "and did NOT spend a second rotation");
  } finally {
    clearAccessCache();
    store.clear();
    resetSession();
  }
});

test("forceRefresh does not re-hydrate the token that just failed", async () => {
  // The single most important line in the feature. forceRefresh runs BECAUSE the token in hand was
  // rejected — and that same token is on disk, shared with every other process. Without the clear,
  // the next ensureFresh reads the dead token straight back and the session 401s forever, having
  // "refreshed" every time.
  const first = jwt(2000000000, "before-force");
  const store = getStore();
  store.set(first);
  serverToken = first;
  presented.length = 0;
  resetSession();
  clearAccessCache();

  try {
    await ensureFresh();
    assert.equal(presented.length, 1);
    assert.ok(readAccessCache("main", ROTATED), "there is now a cached token to re-hydrate from");

    serverToken = ROTATED;
    await forceRefresh();
    assert.equal(presented.length, 2, "forceRefresh must go to the wire, never to the cache");
  } finally {
    clearAccessCache();
    store.clear();
    resetSession();
  }
});

test("the loser of a lock race gets the winner's token rather than a second rotation", async () => {
  // This is the double-checked read, and it is the whole feature rather than an optimisation on it.
  // Without the re-read after acquiring the lock, both processes miss the cache, both queue, and the
  // second refreshes anyway — a wasted rotation, which is exactly what the cache exists to prevent.
  const stored = jwt(2000000000, "race");
  const sharedAccess = jwt(2000000000, "minted-by-the-other-process");
  const store = getStore();
  store.set(stored);
  serverToken = stored;
  presented.length = 0;
  resetSession();
  clearAccessCache();

  const held = await acquireRefreshLock(2_000, "main");
  assert.ok(held, "stand in for the process that is already refreshing");
  try {
    const queued = ensureFresh();
    await sleep(60); // let it miss the cache and block on the lock

    // The other process finishes and shares its token, exactly as `refreshOnce` does.
    writeAccessCache("main", sharedAccess, Math.floor(Date.now() / 1000) + 86_400, stored);
    held!();

    assert.equal(await queued, sharedAccess, "the queued caller must adopt the shared token");
    assert.equal(presented.length, 0, "and must not have issued a request at all");
  } finally {
    held!();
    clearAccessCache();
    store.clear();
    resetSession();
  }
});

/* ------------------- regressions found by review, not by the gate ------------------- */

test("a rotated token survives a store that CANNOT BE READ, not just one that moved on", async () => {
  // The bug: `currentRefreshToken` compared `get()` against `supersedes`, and `get()` returns null
  // for two different facts — "nothing there" and "I could not look". A locked Keychain is the
  // second, and it is the SAME condition that made the write fail and created the in-memory copy in
  // the first place. So the token was rescued and then discarded milliseconds later, and the user
  // was told to log in again for a credential this process was holding.
  const spent = jwt(2000000000, "spent");
  const rotated = jwt(2000000000, "rotated");
  serverToken = spent;
  presented.length = 0;
  resetSession();
  clearAccessCache();

  const store = getStore();
  store.set(spent);

  // The write fails, so the rotated token is kept in memory.
  const realSet = store.set.bind(store);
  (store as unknown as { set: (t: string) => void }).set = () => {
    throw new Error("Keychain write failed");
  };
  try {
    await forceRefresh();
  } finally {
    (store as unknown as { set: unknown }).set = realSet;
  }

  // Now the store goes UNREADABLE — a locked Keychain answers null to every read.
  const realGet = store.get.bind(store);
  const realReadState = store.readState.bind(store);
  (store as unknown as { get: () => string | null }).get = () => null;
  (store as unknown as { readState: () => string }).readState = () => "unavailable";
  try {
    assert.equal(hasStoredSession("main"), true, "the process still holds a usable credential");

    serverToken = rotated;
    presented.length = 0;
    resetSession();
    clearAccessCache();
    await forceRefresh();
    assert.deepEqual(
      [...presented],
      [rotated],
      "it must still present the rescued token rather than reporting no session",
    );
  } finally {
    (store as unknown as { get: unknown }).get = realGet;
    (store as unknown as { readState: unknown }).readState = realReadState;
    clearAccessCache();
    store.clear();
    resetSession();
  }
});

test("forceRefresh reaches the wire even with a warm cache", async () => {
  // `ensureFresh` consults the shared cache before the wire; `forceRefresh` must not, or every
  // caller that refreshes to PROVE something proves nothing. (`status`'s `live: true` is that
  // caller, and `test/status.test.ts` covers it end to end.)
  //
  // Note what this does NOT cover: `DomainState.skipCacheOnce`. In one process `clearAccessCache`
  // already empties the file, so this passes with or without that guard — it exists for the
  // cross-process case where another process restores the snapshot it read before the clear, which
  // a single-process test cannot construct. Asserting otherwise here would be coverage theatre.
  const token = jwt(2000000000, "warm-cache");
  const store = getStore();
  store.set(token);
  serverToken = token;
  resetSession();
  clearAccessCache();

  try {
    await ensureFresh();
    presented.length = 0;
    resetSession();

    // A warm cache: a plain ensureFresh must NOT go to the wire...
    await ensureFresh();
    assert.equal(presented.length, 0, "precondition: the cache is warm and ensureFresh uses it");

    // ...and forceRefresh must, whatever the cache says.
    serverToken = jwt(2000000000, "rotated");
    store.set(serverToken);
    await forceRefresh();
    assert.equal(presented.length, 1, "forceRefresh must actually refresh, or `--verify` proves nothing");
  } finally {
    clearAccessCache();
    store.clear();
    resetSession();
  }
});

test("an access token minted from another account is not reused after the store changes", async () => {
  // A running server holds `current` for up to 24 hours. If the user runs
  // `stockbit-auth login --switch-account` in a terminal, the store gains account B's refresh token
  // — and the server, which never re-checked, kept answering as account A with nothing saying so.
  // The disk cache was hardened against exactly this; the in-memory copy was not.
  const accountA = jwt(2000000000, "account-a");
  const accountB = jwt(2000000000, "account-b");
  const store = getStore();
  store.set(accountA);
  serverToken = accountA;
  resetSession();
  clearAccessCache();

  try {
    await ensureFresh();
    presented.length = 0;

    // The rotation from that refresh is what the store now holds; simulate the terminal replacing
    // it wholesale with a different account's credential.
    store.set(accountB);
    serverToken = accountB;
    clearAccessCache();

    await ensureFresh();
    assert.equal(
      presented.length,
      1,
      "the in-memory token was minted from another credential, so it must not be reused",
    );
    assert.deepEqual([...presented], [accountB], "and the new account's credential is what goes out");
  } finally {
    clearAccessCache();
    store.clear();
    resetSession();
  }
});
