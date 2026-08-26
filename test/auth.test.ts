// Isolate the token store BEFORE importing modules that read it.
import { chmodSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-test-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { getStore, keychainWriteArgs, keychainWriteArgsWithToken, keychainWriteDecision } from "../src/auth/store.ts";
import {
  refreshLockTimeoutMsForBackend,
  staleMsForBackend,
  worstCaseHoldMsFor,
} from "../src/auth/reflock.ts";
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
  // POSIX permission bits do not exist on NTFS — Node reports 0o666 there no matter what mode was
  // requested, so this assertion can only be made where the platform can honour it. On Windows the
  // credential is protected by the profile directory's ACL plus AES-256-GCM at rest instead.
  if (process.platform !== "win32") {
    assert.equal(statSync(target).mode & 0o777, 0o600, "the sole credential must be owner-only");
  }

  // A failed write must not destroy the token already there. The rename is the only moment the
  // target changes, so a failure before it leaves the previous value intact — which is the whole
  // reason this is not a truncating in-place write. Forced by making the directory unwritable, so
  // creating the temp file fails for real rather than being simulated.
  // Windows is excluded for the same reason as the mode assertion above: chmod cannot revoke write
  // access on NTFS, so the "unwritable directory" this case depends on cannot be constructed.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
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

test("the Keychain write command does not carry the token in argv", () => {
  // A process argument is visible in `ps` to every process running as the same user — and reading
  // it there BYPASSES the Keychain ACL that would otherwise make access prompt. This project
  // already warns about exactly that for the Telegram bot token (docs/FEATURES.md); the credential
  // it exists to guard should not be the exception.
  //
  // `-w` last with no value is what `man security` calls the recommended form: "Put at end of
  // command to be prompted."
  const args = keychainWriteArgs();
  assert.deepEqual(args, [
    "add-generic-password",
    "-s", "stockbit-mcp",
    "-a", "refresh-token",
    "-U",
    "-w",
  ]);
  assert.equal(args.at(-1), "-w", "`-w` must be last, so the value is prompted for and not an argument");

  // Not "does this literal appear" — `keychainWriteArgs` takes no token, so that could never fail.
  // The property that matters is that NOTHING in the args is credential-shaped, which would catch a
  // future edit that put one back.
  assert.equal(
    args.some((a) => /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(a)),
    false,
    "no argument may be JWT-shaped",
  );
  assert.equal(args.length, 7, "seven fixed arguments and nowhere for a value to hide");
});

test("Keychain writes preserve the default trusted creator without granting broad access", () => {
  for (const args of [keychainWriteArgs(), keychainWriteArgsWithToken("test-token")]) {
    assert.equal(args.includes("-T"), false, "must not reset the Keychain ACL");
    assert.equal(args.includes("-A"), false, "must not grant unrestricted application access");
    assert.equal(args.includes("-U"), true, "must update in place rather than replacing the item");
  }
});

test("the argv fallback is still exactly the old command, so it can be trusted when it is needed", () => {
  // Kept deliberately: whether `security` reads a prompted value from a pipe depends on
  // `readpassphrase` finding a controlling terminal, which differs between an MCP server spawned by
  // a client and the same command typed at a shell. `keychainWrite` tries the safe form, reads the
  // value back to confirm it landed, and only falls back here when it did not.
  assert.deepEqual(keychainWriteArgsWithToken("test-token"), [
    "add-generic-password",
    "-s", "stockbit-mcp",
    "-a", "refresh-token",
    "-U",
    "-w", "test-token",
  ]);
});

test("readState tells 'nothing stored' apart from 'could not find out'", () => {
  // On the file backend there is no locked-Keychain equivalent, so this asserts the refinement that
  // does exist: readState agrees with get(), including for a file that is present but unreadable.
  // The Keychain branch's exit-code mapping is not reachable under STOCKBIT_FORCE_FILE_STORE=1 and
  // is asserted by inspection in the comment there.
  const store = getStore();
  store.clear();
  assert.equal(store.readState(), "absent", "a cleared store is absent, not unavailable");
  store.set("eyJhbGciOiJub25lIn0.eyJleHAiOjJ9.sig");
  assert.equal(store.readState(), "present");
  store.clear();
  assert.equal(store.readState(), "absent");
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


test("a Keychain write that was KILLED never falls back to putting the token in argv", () => {
  // The regression this exists to prevent, twice over.
  //
  // `keychainWriteArgsWithToken` spawns `security ... -w <the refresh token>`, where `ps` shows the
  // credential to every process running as this user. Moving the value to stdin was the whole point
  // of that pair of functions -- and both times the guard was written it covered one of the two
  // spawns that can fail to answer and not the other. On a locked Keychain it is the WRITE that
  // raises the unlock dialog first, so the read-back is never even reached; a child killed by the
  // timeout reports `{ status: null }`, and treating that like a refusal walked straight into the
  // fallback. It also bought nothing -- the argv spawn meets the same dialog and fails too, so the
  // only lasting effect was the credential in `ps`.
  assert.equal(keychainWriteDecision(null, null), "fail", "a killed write must not reach argv");

  // A refusal to ACT is not an answer either, and this half was missed the first time round: the
  // read-back branch of the same function already classified 45 (the Keychain is locked and nothing
  // may prompt) and 51 (someone clicked Deny) as non-answers, while the write branch called them
  // definite refusals and sent the token to argv. Same function, same two codes, opposite verdicts
  // -- and the fallback could not have helped in either case, because it meets the same lock and
  // the same prompt.
  assert.equal(keychainWriteDecision(45, null), "fail", "errSecInteractionNotAllowed: locked");
  assert.equal(keychainWriteDecision(51, null), "fail", "errSecAuthFailed: the prompt was declined");

  // What is left for the fallback: `security` ran and refused for some other reason.
  assert.equal(keychainWriteDecision(1, null), "argv");

  // And the read-back half of the same rule.
  assert.equal(keychainWriteDecision(0, { matched: true, status: 0 }), "stdin");
  assert.equal(
    keychainWriteDecision(0, { matched: false, status: null }),
    "stdin-unverified",
    "a read that could not answer is not a read that said no",
  );
  assert.equal(keychainWriteDecision(0, { matched: false, status: 0 }), "argv", "read back a different value");
  assert.equal(keychainWriteDecision(0, { matched: false, status: 44 }), "argv", "genuinely not there");
});

test("the Keychain lock allowance is asserted on both backends, from an offline test", () => {
  // It was not, and the comment claiming it was made that harder to notice. Every test in this repo
  // sets STOCKBIT_FORCE_FILE_STORE=1 before its imports -- it has to, the suite is offline -- so
  // `getStore().backend` is never "keychain" under test and the entire Keychain branch was dead
  // code as far as the suite was concerned. The multiplier could be doubled, or deleted, and the
  // whole suite stayed green.
  //
  // Literals, deliberately. A test that recomputes the formula agrees with the constant rather than
  // with what the lock actually holds.
  assert.equal(staleMsForBackend("file"), 50_000);
  assert.equal(refreshLockTimeoutMsForBackend("file"), 55_000);
  assert.equal(staleMsForBackend("keychain"), 86_000);
  assert.equal(refreshLockTimeoutMsForBackend("keychain"), 91_000);

  // The ordering is the property; the numbers are how it is currently met. A holder must be able to
  // finish before it is judged stale, and a waiter must outlast the staleness threshold or it can
  // never break the lock a crashed process left behind.
  for (const backend of ["file", "keychain"] as const) {
    assert.ok(
      worstCaseHoldMsFor(backend) < staleMsForBackend(backend),
      backend + ": a healthy holder must not be broken as stale",
    );
    assert.ok(
      staleMsForBackend(backend) < refreshLockTimeoutMsForBackend(backend),
      backend + ": a waiter that gives up before the stale threshold can never break a dead lock",
    );
  }
});
