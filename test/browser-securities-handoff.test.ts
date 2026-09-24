import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env.STOCKBIT_FORCE_FILE_STORE = "1";
const storeDir = mkdtempSync(join(tmpdir(), "stockbit-browser-securities-test-"));
process.env.STOCKBIT_STORE_DIR = storeDir;

import { persistCapturedLogin, type CapturedLoginResponse } from "../src/auth/login.ts";
import { ensureFresh, resetSession } from "../src/auth/session.ts";
import { clearAccessCache, readAccessCache } from "../src/auth/accesscache.ts";
import { getStore, resetStoreCache } from "../src/auth/store.ts";
import { verifySecuritiesSession } from "../src/auth/tradinglogin.ts";

function jwt(expiresAt: number, purpose: string): string {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({ exp: expiresAt, purpose })}.fixture`;
}
const expiry = Math.floor(Date.now() / 1000) + 3600;
const access = jwt(expiry, "securities-access");
const refresh = jwt(expiry + 86400, "securities-refresh");
const originalFetch = globalThis.fetch;

function response(data: unknown = { access_token: access, refresh_token: refresh }): CapturedLoginResponse {
  return { url: "https://carina.stockbit.com/auth/v2/login", status: 200, body: JSON.stringify({ data }) };
}

beforeEach(() => {
  delete process.env.STOCKBIT_NO_ACCESS_CACHE;
  resetSession();
  clearAccessCache();
  for (const slot of ["main", "securities", "eipo"] as const) getStore(slot).clear();
  globalThis.fetch = (async () => { throw new Error("Unexpected network request in handoff test"); }) as typeof fetch;
});
after(() => {
  delete process.env.STOCKBIT_NO_ACCESS_CACHE;
  globalThis.fetch = originalFetch;
  rmSync(storeDir, { recursive: true, force: true });
});

test("browser securities capture hands access to the next process without refreshing", async () => {
  persistCapturedLogin(refresh, "securities", response());
  assert.equal(getStore("securities").get(), refresh);
  assert.equal(await ensureFresh("securities"), access, "the capturing CLI uses the observed access token");
  assert.equal(readAccessCache("securities", refresh)?.expiresAt, expiry);
  assert.equal(readAccessCache("securities", "a-different-refresh"), null, "another account cannot reuse this access");

  resetSession("securities");
  resetStoreCache();
  const calls: string[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    assert.equal(String(url), "https://carina.stockbit.com/portfolio/v2/list");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${access}`);
    return new Response(JSON.stringify({ data: { result: [] } }), { status: 200 });
  }) as typeof fetch;
  await verifySecuritiesSession();
  assert.deepEqual(calls, ["https://carina.stockbit.com/portfolio/v2/list"], "no /auth/refresh request");
});

test("base64 browser response handoff keeps explicit access expiry", async () => {
  const expiresAt = expiry + 120;
  const observed = response({ access_token: access, refresh_token: refresh, expires_at: expiresAt });
  observed.body = Buffer.from(observed.body).toString("base64");
  observed.base64Encoded = true;
  persistCapturedLogin(refresh, "securities", observed);
  resetSession("securities");
  assert.equal(await ensureFresh("securities"), access);
  assert.equal(readAccessCache("securities", refresh)?.expiresAt, expiresAt);
});

test("missing or unusable access preserves refresh-only capture", () => {
  for (const observed of [
    undefined,
    response({ refresh_token: refresh }),
    response({ access_token: access, refresh_token: "different-refresh" }),
    response({ access_token: access, refresh_token: refresh, expires_at: 1 }),
    { ...response(), body: "non-JSON refresh-only envelope" },
    { ...response(), status: 401 },
    { ...response(), url: "https://exodus.stockbit.com/login/v6/social" },
  ]) {
    persistCapturedLogin(refresh, "securities", observed);
    assert.equal(getStore("securities").get(), refresh);
    assert.equal(readAccessCache("securities", refresh), null);
  }
});

test("main captures retain refresh-only precedence even when access is observed", () => {
  persistCapturedLogin(refresh, "main", response());
  assert.equal(getStore("main").get(), refresh);
  assert.equal(getStore("securities").get(), null);
  assert.equal(readAccessCache("main", refresh), null);
  assert.equal(readAccessCache("securities", refresh), null);
});

test("browser securities handoff honors the disk cache opt-out", async () => {
  process.env.STOCKBIT_NO_ACCESS_CACHE = "1";
  persistCapturedLogin(refresh, "securities", response());
  assert.equal(await ensureFresh("securities"), access);
  delete process.env.STOCKBIT_NO_ACCESS_CACHE;
  assert.equal(readAccessCache("securities", refresh), null);
});
