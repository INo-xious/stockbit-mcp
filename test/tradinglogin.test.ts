import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.STOCKBIT_FORCE_FILE_STORE = "1";
const storeDir = mkdtempSync(join(tmpdir(), "stockbit-tradinglogin-test-"));
process.env.STOCKBIT_STORE_DIR = storeDir;

import { loginSecurities, parseSecuritiesGrant, verifySecuritiesSession } from "../src/auth/tradinglogin.ts";
import { adoptAccessToken, ensureFresh, resetSession } from "../src/auth/session.ts";
import { clearAccessCache } from "../src/auth/accesscache.ts";
import { getStore, resetStoreCache } from "../src/auth/store.ts";
import { StockbitError } from "../src/http/errors.ts";

const originalFetch = globalThis.fetch;
const PIN = "472951"; // Synthetic fixture, never a user's PIN.
const GRANT = "FIXTURE-OPAQUE-SECURITIES-GRANT";
const SEC_ACCESS = "FIXTURE-SECURITIES-ACCESS";
const SEC_REFRESH = "FIXTURE-SECURITIES-REFRESH";
type Call = { url: string; method: string; body: unknown; authorization: string | null };

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function fakeApi(grant: unknown, loginReply = () => json({ data: { access_token: SEC_ACCESS, refresh_token: SEC_REFRESH } })) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url, init = {}) => {
    const call: Call = {
      url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init.headers).get("authorization"),
    };
    calls.push(call);
    if (call.url === "https://exodus.stockbit.com/sekuritas/auth/token") return json(grant);
    if (call.url === "https://carina.stockbit.com/auth/v2/login") return loginReply();
    if (call.url === "https://carina.stockbit.com/portfolio/v2/list") return json({ data: { result: [] } });
    throw new Error("Unexpected request outside the two declared login routes");
  }) as typeof fetch;
  return calls;
}

beforeEach(() => {
  resetSession();
  clearAccessCache();
  for (const slot of ["main", "securities", "eipo"] as const) getStore(slot).clear();
  getStore("main").set("FIXTURE-MAIN-REFRESH");
  adoptAccessToken("main", "FIXTURE-MAIN-ACCESS", Date.now() / 1000 + 3600, "FIXTURE-MAIN-REFRESH");
  globalThis.fetch = originalFetch;
});
after(() => { globalThis.fetch = originalFetch; rmSync(storeDir, { recursive: true, force: true }); });

test("observed data.token/target 2 maps to the carina grant plus PIN exchange", async () => {
  const calls = fakeApi({ message: "success", data: { token: GRANT, target: "2" } });
  const result = await loginSecurities({ pin: PIN });
  assert.deepEqual(result, { backend: "file", accessSeeded: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].authorization, "Bearer FIXTURE-MAIN-ACCESS");
  assert.equal(calls[1].url, "https://carina.stockbit.com/auth/v2/login");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(calls[1].body, { login_token: GRANT, pin: PIN });
  assert.equal(calls[1].authorization, null);
  assert.equal(getStore("securities").get(), SEC_REFRESH);
  assert.equal(await ensureFresh("securities"), SEC_ACCESS);
  assert.equal(calls.length, 2, "access token seeded without an extra securities refresh");
});

test("a subsequent MCP process can reuse the CLI login without refreshing", async () => {
  const calls = fakeApi({ data: { token: GRANT, target: "2" } });
  await loginSecurities({ pin: PIN });
  resetSession("securities");
  resetStoreCache();
  assert.equal(await ensureFresh("securities"), SEC_ACCESS);
  await verifySecuritiesSession();
  assert.equal(calls.length, 3, "only grant, PIN login, and portfolio GET; no refresh");
  assert.equal(calls[2].authorization, `Bearer ${SEC_ACCESS}`);
});

test("explicit login_token/loginToken compatibility does not accept generic nested tokens", () => {
  for (const body of [
    { login_token: GRANT }, { data: { login_token: GRANT } },
    { data: { data: { loginToken: GRANT } } }, { target: "2", data: { loginToken: GRANT } },
    { data: { token: GRANT, target: 2 } },
  ]) assert.equal(parseSecuritiesGrant(body), GRANT);
  for (const body of [
    { token: GRANT, target: "2" }, { data: { access: { token: GRANT }, target: "2" } },
    { data: { refresh: { token: GRANT }, target: "2" } }, { data: { token: GRANT } },
    { data: { token: "  ", target: "2" } }, { data: { login_token: "" } },
    { error_type: "DENIED", data: { token: GRANT, target: "2" } },
  ]) assert.throws(() => parseSecuritiesGrant(body));
});

test("legacy/unknown/conflicting brokerage targets fail before any PIN or grant is submitted", async () => {
  for (const grant of [
    { data: { token: GRANT, target: "1" } }, { data: { token: GRANT, target: "999" } },
    { data: { token: GRANT, target: null } }, { data: { token: GRANT, target: false } },
    { data: { token: GRANT } }, { data: { login_token: GRANT, target: "1" } },
    { target: "1", data: { token: GRANT, target: "2" } },
    { target: "1", data: { loginToken: GRANT } },
  ]) {
    const calls = fakeApi(grant);
    await assert.rejects(() => loginSecurities({ pin: PIN }), /No PIN or grant was submitted/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body, undefined);
    assert.equal(getStore("securities").get(), null);
  }
});

test("malformed successful grant responses are schema drift, not an expired-session diagnosis", async () => {
  const calls = fakeApi({ message: "success", data: { unexpected: "value" } });
  await assert.rejects(() => loginSecurities({ pin: PIN }), (error: unknown) => {
    assert.ok(error instanceof StockbitError);
    assert.equal(error.kind, "schema_drift");
    assert.doesNotMatch(error.message, /may have expired|run `stockbit-auth login`/);
    assert.doesNotMatch(error.message, new RegExp(PIN));
    return true;
  });
  assert.equal(calls.length, 1);
});

test("bare PIN/grant echoes are removed from error message, stack, error type, and details", async () => {
  fakeApi({ data: { token: GRANT, target: "2" } }, () => json({
    message: `Rejected credential ${PIN} and grant ${GRANT}`,
    error_type: `INVALID_${PIN}`,
    errors: [{ key: GRANT, error: `Wrong secret ${PIN}` }],
  }, 400));
  await assert.rejects(() => loginSecurities({ pin: PIN }), (error: unknown) => {
    assert.ok(error instanceof StockbitError);
    assert.equal(error.kind, "invalid_param");
    assert.equal(error.status, 400);
    const text = JSON.stringify({ message: error.message, stack: error.stack, type: error.errorType, details: error.details });
    assert.ok(!text.includes(PIN));
    assert.ok(!text.includes(GRANT));
    assert.match(text, /REDACTED/);
    return true;
  });
  assert.equal(getStore("securities").get(), null);
});

test("a domainless PIN login rejected with 401 is submitted exactly once", async () => {
  const calls = fakeApi({ data: { token: GRANT, target: "2" } }, () => json({ message: "PIN rejected" }, 401));
  await assert.rejects(() => loginSecurities({ pin: PIN }), (error: unknown) => {
    assert.ok(error instanceof StockbitError);
    assert.equal(error.status, 401);
    assert.equal(error.kind, "auth");
    return true;
  });
  assert.equal(calls.filter((call) => call.method === "POST").length, 1, "never repeat the same failed PIN");
  assert.equal(calls.length, 2, "one grant read and one PIN submission, no refresh or retry");
  assert.equal(getStore("securities").get(), null);
});

test("successful login never persists the PIN or short-lived login grant", async () => {
  fakeApi({ data: { token: GRANT, target: "2" } });
  const result = await loginSecurities({ pin: PIN });
  assert.ok(!JSON.stringify(result).includes(PIN));
  assert.ok(!JSON.stringify(result).includes(GRANT));
  for (const name of readdirSync(storeDir, { recursive: true }) as string[]) {
    let content: string;
    try { content = readFileSync(join(storeDir, name), "utf8"); } catch { continue; }
    assert.ok(!content.includes(PIN), `${name} must not contain PIN`);
    assert.ok(!content.includes(GRANT), `${name} must not contain login grant`);
  }
});

test("login proof reads portfolio with fresh access without spending the refresh token", async () => {
  const calls = fakeApi({ data: { token: GRANT, target: "2" } });
  await loginSecurities({ pin: PIN });
  assert.equal(await verifySecuritiesSession(), undefined, "proof must not return account data to CLI logging");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, "https://carina.stockbit.com/portfolio/v2/list");
  assert.equal(calls[2].method, "GET");
  assert.equal(calls[2].authorization, `Bearer ${SEC_ACCESS}`);
  assert.equal(calls.some((call) => call.url.endsWith("/auth/refresh")), false);
});

test("backend reporting re-reads the selected store after a write switches to file fallback", async () => {
  fakeApi({ data: { token: GRANT, target: "2" } });
  const stale = getStore("securities");
  const persist = stale.set.bind(stale);
  // Simulate the stale Keychain-store reference kept by loginSecurities while the
  // selector switches to another object. Storage stays in the isolated test folder.
  Object.defineProperty(stale, "backend", { value: "keychain", configurable: true });
  stale.set = (token: string) => { persist(token); resetStoreCache(); };
  const result = await loginSecurities({ pin: PIN });
  assert.equal(stale.backend, "keychain");
  assert.equal(getStore("securities").backend, "file");
  assert.equal(result.backend, "file");
  assert.equal(getStore("securities").get(), SEC_REFRESH);
});
