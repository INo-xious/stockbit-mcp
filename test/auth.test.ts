// Isolate the token store BEFORE importing modules that read it.
import { chmodSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-test-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { getStore, keychainWriteArgs } from "../src/auth/store.ts";
import { parseRefresh, ensureFresh, resetSession, decodeJwt } from "../src/auth/session.ts";
import { buildUrl } from "../src/http/transport.ts";

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

test("the credential file is replaced atomically and never left world-readable", () => {
  const store = getStore();
  store.set("refresh-original");

  const dir = process.env.STOCKBIT_STORE_DIR!;
  const target = join(dir, "refresh.enc");

  // A rename-based write leaves no temp file behind and does not truncate in place.
  store.set("refresh-rotated");
  assert.equal(store.get(), "refresh-rotated");
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "a temp file survived the write",
  );
  assert.equal(statSync(target).mode & 0o777, 0o600, "the sole credential must be owner-only");

  // A failed write must not destroy the token already there. The rename is the only moment the
  // target changes, so a failure before it leaves the previous value intact — which is the whole
  // reason this is not a truncating in-place write. Forced by making the directory unwritable, so
  // creating the temp file fails for real rather than being simulated.
  if (process.getuid?.() !== 0) {
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => store.set("refresh-never-lands"), /EACCES|EPERM/);
      assert.equal(store.get(), "refresh-rotated", "a failed write destroyed the stored token");
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.endsWith(".tmp")),
      [],
      "a failed write left a temp file behind",
    );
  }

  store.clear();
  assert.equal(store.get(), null);
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith(".tmp")),
    [],
    "clear() must be atomic too",
  );
});

test("Keychain writes preserve the default trusted creator without granting broad access", () => {
  const args = keychainWriteArgs("test-token");
  assert.deepEqual(args, [
    "add-generic-password",
    "-s", "stockbit-mcp",
    "-a", "refresh-token",
    "-U",
    "-w", "test-token",
  ]);
  assert.equal(args.includes("-T"), false, "must not reset the Keychain ACL");
  assert.equal(args.includes("-A"), false, "must not grant unrestricted application access");
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

test("parseRefresh handles nested token_data and ISO access expiry", () => {
  const access = jwt(2000000000);
  const result = parseRefresh({
    data: {
      data: {
        login: {
          token_data: {
            access: { token: access, expired_at: "2026-08-02T18:28:27Z" },
            refresh: { token: "NESTED-REFRESH", expired_at: "2026-08-08T18:28:27Z" },
          },
        },
      },
    },
  });

  assert.equal(result.access, access);
  assert.equal(result.newRefresh, "NESTED-REFRESH");
  assert.equal(result.expiresAt, Math.floor(Date.parse("2026-08-02T18:28:27Z") / 1000));
});

test("parseRefresh finds token objects through unknown response wrappers", () => {
  const access = jwt(2000000000);
  const result = parseRefresh({
    data: {
      result: {
        session: {
          credentials: {
            access: { token: access, expired_at: "2026-08-03T18:28:27Z" },
            refresh: { token: "WRAPPED-REFRESH" },
          },
        },
      },
    },
  });

  assert.equal(result.access, access);
  assert.equal(result.newRefresh, "WRAPPED-REFRESH");
  assert.equal(result.expiresAt, Math.floor(Date.parse("2026-08-03T18:28:27Z") / 1000));
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
    assert.equal(calls[0], buildUrl("loginRefresh"), "goes to the declared loginRefresh route");
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
