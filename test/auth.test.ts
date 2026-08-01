// Isolate the token store BEFORE importing modules that read it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-test-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { parseRefresh, ensureFresh, resetSession, decodeJwt } from "../src/auth/session.ts";
import { AUTH } from "../src/config.ts";

/** Build an unsigned JWT with a given exp (seconds). */
function jwt(exp: number, extra: Record<string, unknown> = {}): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp, ...extra })}.sig`;
}

test("file store round-trips and clears", () => {
  const store = getStore();
  assert.equal(store.backend, "file");
  store.set("refresh-abc");
  assert.equal(store.get(), "refresh-abc");
  store.clear();
  assert.equal(store.get(), null);
});

test("parseRefresh extracts access, expiry, and detects rotation", () => {
  const access = jwt(2000000000);
  const p = parseRefresh({ data: { access_token: access, refresh_token: "NEW", expired_at: 123 } });
  assert.equal(p.access, access);
  assert.equal(p.newRefresh, "NEW");
  assert.equal(p.expiresAt, 123);
});

test("parseRefresh falls back to JWT exp when no explicit expiry", () => {
  const access = jwt(1900000000);
  const p = parseRefresh({ access_token: access });
  assert.equal(p.expiresAt, 1900000000);
  assert.equal(p.newRefresh, undefined);
});

test("refresh persists a ROTATED refresh token (or we lock ourselves out)", async () => {
  const store = getStore();
  store.set("OLD-REFRESH");
  resetSession();

  const newAccess = jwt(Math.floor(Date.now() / 1000) + 3600);
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push(String(url));
    // Contract: refresh token is sent in the Authorization header, body is empty.
    const headers = new Headers((init as { headers: HeadersInit }).headers);
    assert.equal(headers.get("authorization"), "Bearer OLD-REFRESH", "sends refresh token in header");
    assert.equal((init as { body?: unknown }).body, undefined, "body is empty");
    // /login/refresh nests as data.data.
    return new Response(
      JSON.stringify({ data: { data: { access_token: newAccess, refresh_token: "ROTATED-REFRESH" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const token = await ensureFresh();
    assert.equal(token, newAccess, "returns the fresh access token");
    assert.equal(calls[0], AUTH.refreshUrl, "calls the configured refresh URL");
    assert.equal(store.get(), "ROTATED-REFRESH", "rotated refresh token was persisted");
  } finally {
    globalThis.fetch = realFetch;
    store.clear();
    resetSession();
  }
});

test("decodeJwt reads the payload", () => {
  assert.equal(decodeJwt(jwt(42))["exp"], 42);
  assert.deepEqual(decodeJwt("not-a-jwt"), {});
});
