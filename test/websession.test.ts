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
  WEB_SESSION_LIFETIME_HOURS,
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

test("health is age-based, and says so at both boundaries", () => {
  clearWebSession();
  assert.equal(webSessionHealth().present, false, "no stored session is reported as absent");

  saveWebSession(session([cookie("v", { name: "SESSIONID" })], new Date(Date.now() - 3_600_000).toISOString()));
  const young = webSessionHealth();
  assert.equal(young.present, true);
  assert.equal(young.likelyValid, true);
  assert.match(young.hint, /can still end sooner/, "likelyValid is a floor, never a promise");

  const past = WEB_SESSION_LIFETIME_HOURS + 1;
  saveWebSession(
    session([cookie("v", { name: "SESSIONID" })], new Date(Date.now() - past * 3_600_000).toISOString()),
  );
  const old = webSessionHealth();
  assert.equal(old.present, true);
  assert.equal(old.likelyValid, false);
  assert.match(old.hint, /fresh login/);
});

test("health never throws, whatever is on disk", () => {
  clearWebSession();
  assert.doesNotThrow(() => webSessionHealth());
});

/* -------------------------- the DO-NOT block stands -------------------------- */

test("nothing in this module writes CLI tokens back into credentialStorage", async () => {
  // Built, measured, rejected: the site's own JWTs carry a dvc/ses device binding the CLI cannot
  // reproduce, so planting CLI tokens overwrites a working profile with credentials the site
  // refuses. The record of that lives in a comment, and comments do not fail builds — this does.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(fileURLToPath(new URL("../src/auth/websession.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(
    /setCookies[\s\S]{0,200}credentialStorage/.test(code),
    false,
    "writing the CLI's tokens into credentialStorage logs the browser profile out",
  );
});
