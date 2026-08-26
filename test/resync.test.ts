/**
 * The ordering rule, and the lock policy around it.
 *
 * The temptation this file exists to guard against is "the browser always wins". It is wrong, and
 * it is wrong in a way that is invisible until someone loses a session: three in-repo paths leave
 * the store legitimately AHEAD of the browser — `login --verify` and `bootstrap --verify` both call
 * `forceRefresh()` after the capture, `import-har` imports a token of unknown vintage, and any
 * second process refreshing while a chart is open does the same. A directional rule walks the store
 * backwards in all three.
 *
 * So every rung is asserted here, including the ones that refuse to act.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-resync-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decideAdoption, syncStoreFromBrowser } from "../src/auth/resync.ts";
import { CREDENTIAL_COOKIE, type StoredCookie, type WebSession } from "../src/auth/websession.ts";
import { getStore } from "../src/auth/store.ts";
import { acquireRefreshLock } from "../src/auth/reflock.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));
beforeEach(() => getStore("main").clear());

const NOW = 1_800_000_000;

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.c2ln`;
}

/** JWT-shaped enough for `looksLikeJwt`, but its payload is not JSON — so nothing can be read out. */
const OPAQUE = "eyJhbGciOiJub25lIn0.bm90LWpzb24tYXQtYWxs.c2ln";

function webSession(refresh: string | null, extra: Partial<StoredCookie> = {}): WebSession {
  const cookies: StoredCookie[] = [];
  if (refresh !== null) {
    cookies.push({
      name: CREDENTIAL_COOKIE,
      value: encodeURIComponent(JSON.stringify({ state: { access: jwt({ exp: 1 }), refresh }, version: 0 })),
      domain: ".stockbit.com",
      path: "/",
      ...extra,
    });
  }
  return { capturedAt: new Date().toISOString(), cookies, origins: [] };
}

/* ------------------------------ the ordering rule ------------------------------ */

test("an empty store adopts a live browser token — the Keychain-was-wiped recovery", () => {
  // This rung earns its place on its own. Today it forces a full interactive re-login for a
  // credential that is sitting on disk in the browser's cookie.
  const browser = jwt({ exp: NOW + 86_400 });
  assert.deepEqual(decideAdoption(browser, null, NOW), { adopted: true, reason: "adopted" });
});

test("an empty store does NOT adopt a dead or unreadable token", () => {
  // Turning "no session" into "a broken session" is worse than leaving it empty: the user would be
  // told they have a credential, and every call would fail somewhere further away from the cause.
  assert.deepEqual(decideAdoption(jwt({ exp: NOW - 1 }), null, NOW), {
    adopted: false,
    reason: "browser-expired",
  });
  assert.deepEqual(decideAdoption(OPAQUE, null, NOW), { adopted: false, reason: "unparsable" });
  assert.deepEqual(decideAdoption(jwt({ sub: "no-exp" }), null, NOW), {
    adopted: false,
    reason: "indeterminate",
  });
});

test("identical tokens write nothing", () => {
  const same = jwt({ exp: NOW + 86_400 });
  assert.deepEqual(decideAdoption(same, same, NOW), { adopted: false, reason: "same" });
});

test("a dead browser token is never adopted over a live stored one", () => {
  const dead = jwt({ exp: NOW - 60, iat: NOW - 1 });
  const live = jwt({ exp: NOW + 86_400, iat: NOW - 10_000 });
  // Note the iat says the browser's is NEWER. Expiry still wins: a newer dead token is still dead.
  assert.deepEqual(decideAdoption(dead, live, NOW), { adopted: false, reason: "browser-expired" });
});

test("iat orders issuance when both carry one, in both directions", () => {
  const older = jwt({ iat: NOW - 10_000, exp: NOW + 86_400 });
  const newer = jwt({ iat: NOW - 10, exp: NOW + 86_400 });
  assert.deepEqual(decideAdoption(newer, older, NOW), { adopted: true, reason: "adopted" });
  assert.deepEqual(decideAdoption(older, newer, NOW), { adopted: false, reason: "store-newer" });
});

test("iat is preferred over exp when both are present, and is never required", () => {
  // `iat` on these tokens is UNVERIFIED — it may not be there at all — which is exactly why it is
  // preferred when both carry one rather than required. This asserts the preference: the two rungs
  // disagree here, and iat is the one that decides.
  const browser = jwt({ iat: NOW - 10, exp: NOW + 100 });
  const stored = jwt({ iat: NOW - 10_000, exp: NOW + 999_999 });
  assert.deepEqual(
    decideAdoption(browser, stored, NOW),
    { adopted: true, reason: "adopted" },
    "iat says the browser's is newer; exp would have said the opposite",
  );
});

test("exp orders issuance when iat is missing, in both directions", () => {
  // The inference this rests on: rotation is Observed to issue a FRESH window, so a later exp means
  // a later issue. That step is an inference, not a measurement, which is why it sits below iat.
  const sooner = jwt({ exp: NOW + 3_600 });
  const later = jwt({ exp: NOW + 86_400 });
  assert.deepEqual(decideAdoption(later, sooner, NOW), { adopted: true, reason: "adopted" });
  assert.deepEqual(decideAdoption(sooner, later, NOW), { adopted: false, reason: "store-newer" });
});

test("equal expiries are not an ordering, so the store is left alone", () => {
  const a = jwt({ exp: NOW + 86_400, jti: "a" });
  const b = jwt({ exp: NOW + 86_400, jti: "b" });
  assert.deepEqual(decideAdoption(a, b, NOW), { adopted: false, reason: "store-newer" });
});

test("a readable browser token replaces an unreadable stored one", () => {
  assert.deepEqual(decideAdoption(jwt({ exp: NOW + 86_400 }), OPAQUE, NOW), {
    adopted: true,
    reason: "adopted",
  });
});

test("two tokens that cannot be ordered leave the store alone", () => {
  // Refusing is the only answer that cannot make things worse.
  assert.deepEqual(decideAdoption(OPAQUE, `${OPAQUE}2`, NOW), { adopted: false, reason: "indeterminate" });
  assert.deepEqual(decideAdoption(jwt({ sub: "a" }), jwt({ sub: "b" }), NOW), {
    adopted: false,
    reason: "indeterminate",
  });
});

test("capturedAt is not an input to the decision", () => {
  // It records when the cookie was READ, not when the token was issued, so a stale capture of a
  // fresh token would order exactly wrong. The signature is the proof: there is nowhere to pass it.
  assert.equal(decideAdoption.length, 3, "browser, stored, now — and nothing else");
});

/* --------------------------------- end to end --------------------------------- */

test("the browser's rotated token reaches the store", async () => {
  const browser = jwt({ exp: NOW + 86_400, iat: NOW - 10 });
  getStore("main").set(jwt({ exp: NOW + 3_600, iat: NOW - 10_000 }));
  const result = await syncStoreFromBrowser(webSession(browser), { nowSeconds: NOW });
  assert.deepEqual(result, { adopted: true, reason: "adopted" });
  assert.equal(getStore("main").get(), browser);
});

test("identical tokens do not write AT ALL — no fsync, no Keychain prompt", async () => {
  // Asserted by making a write impossible rather than by counting calls: this runs once per chart
  // tool call, and on macOS a redundant write is a Keychain round trip every single time.
  const same = jwt({ exp: NOW + 86_400 });
  const store = getStore("main");
  store.set(same);
  const realSet = store.set.bind(store);
  (store as unknown as { set: (t: string) => void }).set = () => {
    throw new Error("wrote when it should not have");
  };
  try {
    const result = await syncStoreFromBrowser(webSession(same), { nowSeconds: NOW });
    assert.deepEqual(result, { adopted: false, reason: "same" });
  } finally {
    (store as unknown as { set: unknown }).set = realSet;
  }
});

test("a capture with no credentialStorage cookie is a no-op with a name for it", async () => {
  assert.deepEqual(await syncStoreFromBrowser(webSession(null), { nowSeconds: NOW }), {
    adopted: false,
    reason: "no-cookie",
  });
  assert.deepEqual(await syncStoreFromBrowser(null, { nowSeconds: NOW }), {
    adopted: false,
    reason: "no-cookie",
  });
});

test("a cookie that is present but unreadable is reported as such, not as absent", async () => {
  // The two want different debugging. "no-cookie" means the capture missed; "unparsable" means the
  // shape moved, and someone has to look at it.
  const broken: WebSession = {
    capturedAt: new Date().toISOString(),
    cookies: [{ name: CREDENTIAL_COOKIE, value: "%zz", domain: ".stockbit.com", path: "/" }],
    origins: [],
  };
  assert.deepEqual(await syncStoreFromBrowser(broken, { nowSeconds: NOW }), {
    adopted: false,
    reason: "unparsable",
  });
});

test("failing to take the lock does nothing — the opposite of doRefresh's policy", async () => {
  // doRefresh proceeds without the lock because its alternative is a guaranteed outage. Here the
  // alternative is doing nothing, and doing nothing is safe: the browser still holds a working
  // token and the next chart call offers it again.
  const browser = jwt({ exp: NOW + 86_400 });
  const held = await acquireRefreshLock(1_000, "main");
  assert.ok(held, "hold the lock so the resync cannot take it");
  try {
    const result = await syncStoreFromBrowser(webSession(browser), { nowSeconds: NOW, lockTimeoutMs: 150 });
    assert.deepEqual(result, { adopted: false, reason: "no-lock" });
    assert.equal(getStore("main").get(), null, "and nothing was written");
  } finally {
    held!();
  }
});

test("alreadyLocked skips acquisition, because the lock is not reentrant", async () => {
  // Set only from inside doRefresh's lock. Without it the 401 self-heal would block for its whole
  // timeout and then report no-lock — silently skipping the recovery, in the one situation where it
  // is needed most.
  const browser = jwt({ exp: NOW + 86_400 });
  const held = await acquireRefreshLock(1_000, "main");
  assert.ok(held);
  try {
    const result = await syncStoreFromBrowser(webSession(browser), {
      nowSeconds: NOW,
      alreadyLocked: true,
    });
    assert.deepEqual(result, { adopted: true, reason: "adopted" });
  } finally {
    held!();
  }
});

test("a store that will not say what it holds is never adopted over", async () => {
  // `null` from a locked Keychain is ambiguous, and adopting on it could walk the store backwards
  // over a credential nobody has been able to look at.
  const browser = jwt({ exp: NOW + 86_400 });
  const store = getStore("main");
  const realReadState = store.readState.bind(store);
  (store as unknown as { readState: () => string }).readState = () => "unavailable";
  try {
    assert.deepEqual(await syncStoreFromBrowser(webSession(browser), { nowSeconds: NOW }), {
      adopted: false,
      reason: "store-unavailable",
    });
  } finally {
    (store as unknown as { readState: unknown }).readState = realReadState;
  }
});

test("a failed write is reported, not thrown", async () => {
  // This runs inside a `finally` on the chart path. An exception here turns a drawing that
  // succeeded into an error the user cannot act on.
  const browser = jwt({ exp: NOW + 86_400 });
  const store = getStore("main");
  const realSet = store.set.bind(store);
  (store as unknown as { set: (t: string) => void }).set = () => {
    throw new Error("Keychain write failed");
  };
  try {
    assert.deepEqual(await syncStoreFromBrowser(webSession(browser), { nowSeconds: NOW }), {
      adopted: false,
      reason: "write-failed",
    });
  } finally {
    (store as unknown as { set: unknown }).set = realSet;
  }
});

test("the resync never throws, whatever it is handed", async () => {
  const nonsense = { capturedAt: 1, cookies: null, origins: undefined } as unknown as WebSession;
  const result = await syncStoreFromBrowser(nonsense, { nowSeconds: NOW });
  assert.equal(result.adopted, false);
  assert.ok(typeof result.reason === "string");
});

test("the store is never reset by a resync", async () => {
  // Rotating the REFRESH token does not invalidate the ACCESS token this process holds, and
  // dropping it would force exactly the refresh the resync exists to avoid.
  const source = await import("node:fs").then(({ readFileSync }) =>
    import("node:url").then(({ fileURLToPath }) =>
      readFileSync(fileURLToPath(new URL("../src/auth/resync.ts", import.meta.url)), "utf8"),
    ),
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(code.includes("resetSession"), false, "a resync that resets the session costs a refresh");
});
