/**
 * The website session: the fourth credential, and the one that turned out to be carrying the third.
 *
 * This module had no test at all, which is how `readCredentialStorage` came to be missing for so
 * long: the blob was written to disk once per chart call, encrypted, and never read, and nothing
 * anywhere asserted that anyone could read it.
 *
 * Most of what is here is rejection cases. The cookie is attacker-influenced content as far as this
 * process is concerned — it is whatever a web page put in a browser profile — and every one of these
 * inputs must produce `null` rather than an exception, because the reader runs inside a `finally`
 * on the chart path and inside a login capture, and throwing in either turns a success into a
 * failure.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-websession-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  CREDENTIAL_COOKIE,
  clearWebSession,
  isStockbitCookieHost,
  loadWebSession,
  readCredentialStorage,
  saveWebSession,
  sessionAgeHours,
  webSessionHealth,
  webSessionLaunchBlocker,
  readSessionAccessToken,
  alignStoredCredential,
  type StoredCookie,
  type WebSession,
} from "../src/auth/websession.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

/** A syntactically real JWT. The signature is nonsense; nothing here verifies it. */
function jwt(claims: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "test", ...claims })}.c2ln`;
}

function cookie(value: string, over: Partial<StoredCookie> = {}): StoredCookie {
  return {
    name: CREDENTIAL_COOKIE,
    value,
    domain: ".stockbit.com",
    path: "/",
    ...over,
  };
}

function session(cookies: StoredCookie[], capturedAt = new Date().toISOString()): WebSession {
  return { capturedAt, cookies, origins: [] };
}

/** The observed cookie shape, URL-encoded the way the browser stores it. */
function credentialStorage(state: Record<string, unknown>, encodings = 1): string {
  let text = JSON.stringify({ state, version: 0 });
  for (let i = 0; i < encodings; i++) text = encodeURIComponent(text);
  return text;
}

/* ------------------------------- round trip ------------------------------- */

test("a captured session survives a save and load unchanged", () => {
  const original = session([cookie("v", { name: "SESSIONID", httpOnly: true, secure: true })]);
  original.origins.push({ origin: "https://stockbit.com", local: [["k", "v"], ["k2", "v2"]] });
  saveWebSession(original);
  assert.deepEqual(loadWebSession(), original);
});

test("the stored session is owner-only on disk", { skip: process.platform === "win32" ? "NTFS cannot express POSIX mode 0o600" : false }, () => {
  saveWebSession(session([cookie("v", { name: "SESSIONID" })]));
  assert.equal(statSync(join(STORE, "websession.enc")).mode & 0o777, 0o600);
});

test("a cleared session reads as no session, not as a corrupt one", () => {
  saveWebSession(session([cookie("v", { name: "SESSIONID" })]));
  clearWebSession();
  assert.equal(loadWebSession(), null);
});

test("a session with no cookies is nothing to restore", () => {
  saveWebSession(session([]));
  assert.equal(loadWebSession(), null, "cookies are the part that authenticates; without them there is no session");
});

/* -------------------------------- host rule -------------------------------- */

test("cookie hosts are matched as hosts, not as substrings", () => {
  assert.equal(isStockbitCookieHost("stockbit.com"), true);
  assert.equal(isStockbitCookieHost(".stockbit.com"), true);
  assert.equal(isStockbitCookieHost("exodus.stockbit.com"), true);
  assert.equal(isStockbitCookieHost("STOCKBIT.COM"), true);
  // The ones that matter: a name that merely CONTAINS the host is not the host.
  assert.equal(isStockbitCookieHost("evil.test"), false);
  assert.equal(isStockbitCookieHost("stockbit.com.evil.test"), false);
  assert.equal(isStockbitCookieHost("notstockbit.com"), false);
});

/* ------------------------- readCredentialStorage ------------------------- */

test("the browser's refresh token is read out of the credentialStorage cookie", () => {
  const refresh = jwt({ exp: 2_000_000_000, iat: 1_700_000_000 });
  const blob = credentialStorage({ access: jwt({ exp: 1 }), refresh, user: { id: 1, name: "someone" } });
  assert.equal(readCredentialStorage(session([cookie(blob)])), refresh);
});

test("a double-encoded cookie is read too", () => {
  // Observed in the wild, and the reason the decode is a loop that stops on a successful parse
  // rather than a fixed number of passes: a JSON body legitimately contains `%` inside string
  // values, so decoding once more than necessary corrupts it.
  const refresh = jwt({ exp: 2_000_000_000 });
  const blob = credentialStorage({ access: jwt(), refresh }, 2);
  assert.equal(readCredentialStorage(session([cookie(blob)])), refresh);
});

test("an unencoded cookie is read too", () => {
  const refresh = jwt({ exp: 2_000_000_000 });
  const blob = credentialStorage({ refresh }, 0);
  assert.equal(readCredentialStorage(session([cookie(blob)])), refresh);
});

test("no credentialStorage cookie means no token", () => {
  assert.equal(readCredentialStorage(session([cookie("x", { name: "SESSIONID" })])), null);
  assert.equal(readCredentialStorage(session([])), null);
});

test("a credentialStorage cookie on another host is ignored", () => {
  // The reader is public and must not depend on its caller having filtered the capture. A token
  // from an attacker-controlled origin is the one thing this predicate exists to keep out.
  const blob = credentialStorage({ refresh: jwt({ exp: 2_000_000_000 }) });
  assert.equal(readCredentialStorage(session([cookie(blob, { domain: "evil.test" })])), null);
  assert.equal(readCredentialStorage(session([cookie(blob, { domain: "stockbit.com.evil.test" })])), null);
});

test("a malformed percent escape is no token, not an exception", () => {
  // `decodeURIComponent` throws on this. The reader runs inside a `finally` on the chart path,
  // where an exception turns a drawing that succeeded into an error.
  assert.equal(readCredentialStorage(session([cookie("%zz")])), null);
  assert.equal(readCredentialStorage(session([cookie("%")])), null);
});

test("a cookie that is not JSON at all is no token, and terminates", () => {
  // Decoding a value with nothing to decode returns the same string; without the no-progress check
  // the loop would spin for its full bound on every ordinary junk value.
  assert.equal(readCredentialStorage(session([cookie("hello")])), null);
  assert.equal(readCredentialStorage(session([cookie("")])), null);
});

test("valid JSON with no refresh field is no token", () => {
  const blob = credentialStorage({ access: jwt({ exp: 2_000_000_000 }), user: { id: 1 } });
  assert.equal(
    readCredentialStorage(session([cookie(blob)])),
    null,
    "the access token must never be mistaken for the refresh token — they go to different places",
  );
});

test("a refresh field that is not JWT-shaped is no token", () => {
  const blob = credentialStorage({ refresh: "not-a-jwt-at-all" });
  assert.equal(readCredentialStorage(session([cookie(blob)])), null);
});

test("a refresh nested where the envelope has moved is still found", () => {
  // `extractRefresh` is the fallback behind the explicit `state.refresh` path, because this
  // envelope has moved across API versions before and a hard-coded path does not survive that.
  const refresh = jwt({ exp: 2_000_000_000 });
  const blob = encodeURIComponent(JSON.stringify({ state: { auth: { refresh: { token: refresh } } } }));
  assert.equal(readCredentialStorage(session([cookie(blob)])), refresh);
});

/* ------------------------------- health ------------------------------- */

test("session age is reported, and an unreadable timestamp is null rather than a guess", () => {
  const fresh = session([cookie("v")], new Date(Date.now() - 3_600_000).toISOString());
  const age = sessionAgeHours(fresh);
  assert.ok(age !== null && age > 0.9 && age < 1.1, `expected ~1h, got ${age}`);
  assert.equal(sessionAgeHours(session([cookie("v")], "not a date")), null);
});

/* ---------------------- health: the refresh token, not the clock ---------------------- */

/**
 * The bug these replace.
 *
 * `webSessionHealth` used to answer "is the stored session younger than 24 hours", and `withChart`
 * refused to launch a browser whenever it said no. But 24 hours is the ACCESS token's life; the
 * REFRESH token in the same cookie runs about a week and the SPA spends it on boot. So every session
 * older than a day was reported as aged out and the user was sent back to a login on a credential
 * with days left — daily, indefinitely.
 *
 * The test that stood here asserted exactly that behaviour ("health is age-based, and says so at
 * both boundaries"), which is why the defect survived four rounds of adversarial review: it was
 * pinned in place by a passing test. These pin the three states instead, and the property that
 * matters most — **unknown must never block.**
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A cookie carrying a token pair with explicit expiries, the shape the live site uses. */
function pairCookie(accessMsFromNow: number, refreshMsFromNow: number, encodings = 1): StoredCookie {
  return cookie(
    credentialStorage(
      {
        access: { token: jwt({ exp: Math.floor((Date.now() + accessMsFromNow) / 1000) }), expired_at: new Date(Date.now() + accessMsFromNow).toISOString() },
        refresh: { token: jwt({ exp: Math.floor((Date.now() + refreshMsFromNow) / 1000) }), expired_at: new Date(Date.now() + refreshMsFromNow).toISOString() },
        user: { id: 1, username: "tester" },
      },
      encodings,
    ),
  );
}

test("a 25-hour-old session with 6 days left on its refresh token is usable", () => {
  // THE regression. Under the old age-vs-24h rule this returned likelyValid:false and the chart
  // refused to open on a session that would have worked and renewed itself.
  clearWebSession();
  saveWebSession(session([pairCookie(HOUR, 6 * DAY)], new Date(Date.now() - 25 * HOUR).toISOString()));

  const health = webSessionHealth();
  assert.equal(health.present, true);
  assert.equal(health.likelyValid, true, "a live refresh token means usable, regardless of age");
  assert.equal(health.expired, false);
  assert.equal(health.basis, "refresh-token");
  assert.equal(webSessionLaunchBlocker(), null, "nothing may stop the browser launching");
  assert.ok(health.refreshHoursLeft !== null && health.refreshHoursLeft > 5 * 24);
  assert.doesNotMatch(health.hint, /aged out/i);
  assert.doesNotMatch(health.hint, /fresh login/i, "a usable session must not demand a login");
});

test("an expired access token is reported but is not fatal", () => {
  // Normal after any night: access lapsed, refresh alive. The page re-mints on load.
  clearWebSession();
  saveWebSession(session([pairCookie(-6 * HOUR, 5 * DAY)], new Date(Date.now() - 30 * HOUR).toISOString()));

  const health = webSessionHealth();
  assert.equal(health.likelyValid, true);
  assert.equal(webSessionLaunchBlocker(), null);
  assert.ok(health.accessHoursLeft !== null && health.accessHoursLeft < 0, "access is expired");
  assert.match(health.hint, /access token/i, "the lapsed access token should be explained, not hidden");
});

test("a session whose REFRESH token has expired is the one thing that blocks a launch", () => {
  clearWebSession();
  saveWebSession(session([pairCookie(-7 * DAY, -1 * DAY)], new Date(Date.now() - 8 * DAY).toISOString()));

  const health = webSessionHealth();
  assert.equal(health.expired, true);
  assert.equal(health.likelyValid, false);

  const blocker = webSessionLaunchBlocker();
  assert.ok(blocker, "a provably dead session must fail fast rather than burn a readiness wait");
  assert.match(blocker, /stockbit-auth login/, "the message must name the fix");
  assert.match(blocker, /separate credential|unaffected/i, "and must not imply the REST tools are broken");
});

test("an unreadable credential is UNKNOWN, and unknown never blocks", () => {
  // The inversion that gave the original bug away: a MISSING store was allowed through while a
  // readable old one was refused. Unknown must behave like missing — go and look.
  clearWebSession();
  saveWebSession(session([cookie("not-json-at-all")], new Date(Date.now() - 100 * HOUR).toISOString()));

  const health = webSessionHealth();
  assert.equal(health.present, true);
  assert.equal(health.expired, false, "unreadable is not dead");
  assert.equal(health.likelyValid, false, "nor is it provably alive");
  assert.equal(health.basis, "unknown");
  assert.equal(webSessionLaunchBlocker(), null, "unknown must not stop a launch");
});

test("no stored session at all: absent, and still no blocker", () => {
  clearWebSession();
  const health = webSessionHealth();
  assert.equal(health.present, false);
  assert.equal(health.basis, "absent");
  assert.equal(webSessionLaunchBlocker(), null, "the profile may be signed in on its own");
});

test("a bare-JWT cookie is judged from the token's own exp", () => {
  // The shape this module's header documents. Both shapes must reach a verdict.
  clearWebSession();
  saveWebSession(
    session([
      cookie(
        credentialStorage({
          access: jwt({ exp: Math.floor((Date.now() + HOUR) / 1000) }),
          refresh: jwt({ exp: Math.floor((Date.now() + 5 * DAY) / 1000) }),
        }),
      ),
    ]),
  );
  const health = webSessionHealth();
  assert.equal(health.basis, "refresh-token");
  assert.equal(health.likelyValid, true);
});

test("the health report never carries a token", () => {
  clearWebSession();
  saveWebSession(session([pairCookie(HOUR, 6 * DAY)]));
  const serialised = JSON.stringify(webSessionHealth());
  assert.equal(/eyJ|\.c2ln/.test(serialised), false, "a token leaked into the report");
});

test("health never throws, whatever is on disk", () => {
  clearWebSession();
  assert.doesNotThrow(() => webSessionHealth());
});

/* -------------------- propagating a rotation, and refusing to mint one -------------------- */

/**
 * The prohibition this replaces was a source grep asserting nothing writes into the cookie at all.
 *
 * That rule was drawn from an experiment that planted CLI tokens into a CLEAN Chrome profile — which
 * varies the tokens and every device cookie at once, and so cannot tell a rejected token from an
 * unrecognised browser. Measured since: the CLI and the browser hold THE SAME token strings, and a
 * rotated pair inherits the retired pair's `ses`/`dvc`, so propagating a rotation is not minting.
 *
 * A grep cannot express the difference. These do: the write happens ONLY when the cookie holds the
 * pair that was just retired, and only when the binding is inherited. Both negatives are what keep
 * a live session safe, so they matter more than the positive case.
 */

const BOUND = { ses: "session-abc", dvc: "device-xyz" };
const OLD_REFRESH = jwt({ data: BOUND, jti: "gen-1" });
const OLD_ACCESS = jwt({ data: BOUND, jti: "gen-1", exp: Math.floor((Date.now() + HOUR) / 1000) });
const NEW_REFRESH = jwt({ data: BOUND, jti: "gen-2" });
const NEW_ACCESS = jwt({ data: BOUND, jti: "gen-2", exp: Math.floor((Date.now() + DAY) / 1000) });
const nowSec = () => Math.floor(Date.now() / 1000);

function storeHolding(access: string, refresh: string, encodings = 1): void {
  clearWebSession();
  saveWebSession(
    session([
      cookie(
        credentialStorage(
          {
            access: { token: access, expired_at: new Date(Date.now() + HOUR).toISOString() },
            refresh: { token: refresh, expired_at: new Date(Date.now() + 6 * DAY).toISOString() },
          },
          encodings,
        ),
      ),
      cookie("keep-me", { name: "gen-websocket" }),
    ]),
  );
}

test("a rotation is carried into the cookie when the cookie holds the pair that was retired", () => {
  storeHolding(OLD_ACCESS, OLD_REFRESH);

  const result = alignStoredCredential(OLD_REFRESH, {
    access: NEW_ACCESS,
    accessExpiresAt: nowSec() + 24 * 3600,
    refresh: NEW_REFRESH,
    refreshExpiresAt: nowSec() + 7 * 24 * 3600,
  });

  assert.equal(result, "aligned");
  assert.equal(readCredentialStorage(loadWebSession()!), NEW_REFRESH, "the browser must end up on the new pair");
  assert.equal(readSessionAccessToken(loadWebSession()!)?.token, NEW_ACCESS);
});

test("a cookie on a DIFFERENT generation is left alone — this process did not retire it", () => {
  // The dangerous case, and the one the old prohibition was really about. The browser rotated on its
  // own; overwriting here would destroy a live session rather than repair a dead one.
  const someoneElses = jwt({ data: BOUND, jti: "gen-99" });
  storeHolding(someoneElses, someoneElses);

  const result = alignStoredCredential(OLD_REFRESH, { access: NEW_ACCESS, accessExpiresAt: nowSec() + 3600 });

  assert.equal(result, "different-generation");
  assert.equal(readCredentialStorage(loadWebSession()!), someoneElses, "the cookie must still hold its own pair");
});

test("a new pair that lost the device binding is refused — that would be minting, not rotating", () => {
  storeHolding(OLD_ACCESS, OLD_REFRESH);
  const foreign = jwt({ data: { ses: "other", dvc: "other" }, jti: "gen-2" });

  const result = alignStoredCredential(OLD_REFRESH, { access: foreign, accessExpiresAt: nowSec() + 3600 });

  assert.equal(result, "binding-mismatch");
  assert.equal(readSessionAccessToken(loadWebSession()!)?.token, OLD_ACCESS, "nothing may be written");
});

test("the rest of the session survives the write — it is one cookie, not a replacement", () => {
  storeHolding(OLD_ACCESS, OLD_REFRESH);
  alignStoredCredential(OLD_REFRESH, { access: NEW_ACCESS, accessExpiresAt: nowSec() + 3600, refresh: NEW_REFRESH });

  const after = loadWebSession()!;
  assert.equal(after.cookies.length, 2, "no cookie may be dropped");
  assert.equal(after.cookies.find((c) => c.name === "gen-websocket")?.value, "keep-me");
});

test("the cookie is re-encoded as many times as it was decoded", () => {
  // Writing single-encoded JSON over a double-encoded value parses here and not in the browser.
  storeHolding(OLD_ACCESS, OLD_REFRESH, 2);
  assert.equal(
    alignStoredCredential(OLD_REFRESH, { access: NEW_ACCESS, accessExpiresAt: nowSec() + 3600, refresh: NEW_REFRESH }),
    "aligned",
  );
  assert.equal(readCredentialStorage(loadWebSession()!), NEW_REFRESH, "a double-encoded cookie must round-trip");
});

test("alignment never throws, whatever it is handed", () => {
  clearWebSession();
  assert.equal(alignStoredCredential("anything", { access: "x", accessExpiresAt: 0 }), "no-session");

  clearWebSession();
  saveWebSession(session([cookie("not-json")]));
  assert.equal(alignStoredCredential("anything", { access: "x", accessExpiresAt: 0 }), "unreadable");
});

/* ------------------- the store must not move backwards ------------------- */

test("a capture carrying an OLDER credential is dropped — it would undo a rotation", () => {
  clearWebSession();
  saveWebSession(session([pairCookie(20 * HOUR, 6 * DAY)]));
  const current = readSessionAccessToken(loadWebSession()!)?.token;

  saveWebSession(session([pairCookie(2 * HOUR, 6 * DAY)]));

  assert.equal(readSessionAccessToken(loadWebSession()!)?.token, current, "the newer credential must survive");
});

test("a capture with NO credential is dropped rather than blanking a good session", () => {
  clearWebSession();
  saveWebSession(session([pairCookie(20 * HOUR, 6 * DAY)]));
  const current = readSessionAccessToken(loadWebSession()!)?.token;

  saveWebSession(session([cookie("x", { name: "SESSIONID" })]));

  assert.equal(readSessionAccessToken(loadWebSession()!)?.token, current);
});

test("a newer credential is accepted — the guard must not freeze the session", () => {
  clearWebSession();
  saveWebSession(session([pairCookie(2 * HOUR, 6 * DAY)]));
  saveWebSession(session([pairCookie(24 * HOUR, 7 * DAY)]));

  const left = webSessionHealth().accessHoursLeft;
  assert.ok(left !== null && left > 20, "the newer credential must win");
});

test("allowOlder is the explicit escape hatch, so nothing is permanently stuck", () => {
  clearWebSession();
  saveWebSession(session([pairCookie(20 * HOUR, 6 * DAY)]));
  saveWebSession(session([pairCookie(1 * HOUR, 6 * DAY)]), { allowOlder: true });

  const left = webSessionHealth().accessHoursLeft;
  assert.ok(left !== null && left < 2, "an explicit older write must land");
});
