/**
 * The shared access-token cache.
 *
 * It exists because minting an access token SPENDS a rotation of the refresh token, so N clients
 * each minting their own is N rotations of a credential only one of them can hold at a time — for a
 * token that is good for 24 hours and that all of them could have used.
 *
 * Three properties carry the whole feature and each has a specific way of being worse than useless:
 *
 *   1. **An entry is bound to the refresh token that minted it.** Without that, logging in as a
 *      second account leaves the first account's access token on disk and every request goes out as
 *      the wrong person for a day.
 *   2. **`forceRefresh` clears it.** Without that, the token that just 401'd is re-hydrated from
 *      disk on the very next call, and the session 401s forever having "refreshed" each time.
 *   3. **Skew is applied at comparison, never baked in.** Otherwise changing the skew only affects
 *      tokens minted afterwards, which is the kind of half-applied setting nobody can debug.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-accesscache-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  accessCachePath,
  clearAccessCache,
  readAccessCache,
  writeAccessCache,
} from "../src/auth/accesscache.ts";
import { tokenFingerprint } from "../src/auth/fingerprint.ts";

after(() => {
  delete process.env.STOCKBIT_NO_ACCESS_CACHE;
  rmSync(STORE, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.STOCKBIT_NO_ACCESS_CACHE;
  clearAccessCache();
});

const REFRESH = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJyZWZyZXNoIn0.sig";
const OTHER_REFRESH = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbm90aGVyLWFjY291bnQifQ.sig";
const ACCESS = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2Nlc3MifQ.sig";
const FUTURE = Math.floor(Date.now() / 1000) + 86_400;

test("a cached token round-trips, with its raw expiry", () => {
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  const got = readAccessCache("main", REFRESH);
  assert.equal(got?.token, ACCESS);
  assert.equal(
    got?.expiresAt,
    FUTURE,
    "the expiry is stored RAW — the skew is applied at every comparison, never baked in",
  );
});

test("the cache file is owner-only", { skip: process.platform === "win32" ? "NTFS cannot express POSIX mode 0o600" : false }, () => {
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  assert.equal(statSync(accessCachePath()).mode & 0o777, 0o600);
});

test("one file holds all three domains, and they do not collide", () => {
  // One file rather than three: three means three fsyncs for no benefit, and makes logout three
  // truncations instead of one.
  writeAccessCache("main", `${ACCESS}-main`, FUTURE, REFRESH);
  writeAccessCache("securities", `${ACCESS}-sec`, FUTURE, REFRESH);
  writeAccessCache("eipo", `${ACCESS}-eipo`, FUTURE, REFRESH);
  assert.equal(readAccessCache("main", REFRESH)?.token, `${ACCESS}-main`);
  assert.equal(readAccessCache("securities", REFRESH)?.token, `${ACCESS}-sec`);
  assert.equal(readAccessCache("eipo", REFRESH)?.token, `${ACCESS}-eipo`);
});

test("an entry minted from a DIFFERENT refresh token is a miss", () => {
  // The failure this prevents: the user logs in as a second account, the store now holds account
  // B's refresh token, and account A's access token is still on disk and still unexpired. Every
  // request would go out as account A for up to a day, with nothing anywhere saying so.
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  assert.equal(readAccessCache("main", REFRESH)?.token, ACCESS, "the same credential is a hit");
  assert.equal(
    readAccessCache("main", OTHER_REFRESH),
    null,
    "a different credential must be a miss — one wasted refresh is always the safe answer",
  );
});

test("the cache holds a fingerprint, never the refresh token", () => {
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  const raw = readAccessCache("main", REFRESH)!;
  assert.equal(raw.from, tokenFingerprint(REFRESH));
  assert.doesNotMatch(raw.from, /^eyJ/, "a fingerprint must not be JWT-shaped");
  assert.equal(REFRESH.includes(raw.from.replace("sha256:", "")), false, "and not a substring of the token");
  assert.equal(raw.from.replace("sha256:", "").length, 8, "eight hex characters — 32 bits, not a credential");
});

test("clearing one domain leaves the others", () => {
  writeAccessCache("main", `${ACCESS}-main`, FUTURE, REFRESH);
  writeAccessCache("securities", `${ACCESS}-sec`, FUTURE, REFRESH);
  clearAccessCache("main");
  assert.equal(readAccessCache("main", REFRESH), null);
  assert.equal(readAccessCache("securities", REFRESH)?.token, `${ACCESS}-sec`);
});

test("clearing everything leaves nothing readable", () => {
  // What `logout` relies on. An access token left on disk is a working bearer credential for up to
  // a day, so a logout that leaves one is not a logout.
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  writeAccessCache("eipo", ACCESS, FUTURE, REFRESH);
  clearAccessCache();
  assert.equal(readAccessCache("main", REFRESH), null);
  assert.equal(readAccessCache("eipo", REFRESH), null);
});

test("a corrupt cache reads as empty rather than throwing", () => {
  // Tampered, truncated, key mismatch, moved machines. The only cost of an unreadable cache is one
  // refresh, so there is nothing here worth an exception on a request path.
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  writeFileSync(accessCachePath(), Buffer.from("not a ciphertext at all, but long enough to try"));
  assert.doesNotThrow(() => readAccessCache("main", REFRESH));
  assert.equal(readAccessCache("main", REFRESH), null);
  // And it recovers: a corrupt file must not wedge the cache permanently.
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  assert.equal(readAccessCache("main", REFRESH)?.token, ACCESS);
});

test("a missing cache file is simply a miss", () => {
  clearAccessCache();
  rmSync(accessCachePath(), { force: true });
  assert.equal(existsSync(accessCachePath()), false);
  assert.equal(readAccessCache("main", REFRESH), null);
});

test("STOCKBIT_NO_ACCESS_CACHE=1 disables BOTH directions", () => {
  // Both, not just the read: a user who opts out because they do not want an access token on disk
  // must not find one there anyway.
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  process.env.STOCKBIT_NO_ACCESS_CACHE = "1";
  assert.equal(readAccessCache("main", REFRESH), null, "reads are off");

  clearAccessCache();
  writeAccessCache("main", ACCESS, FUTURE, REFRESH);
  delete process.env.STOCKBIT_NO_ACCESS_CACHE;
  assert.equal(readAccessCache("main", REFRESH), null, "and nothing was written while it was off");
});

test("writing never throws, even when the directory is gone", () => {
  // It runs after a refresh that has already succeeded. A cache that cannot be written is a cache
  // miss next time, never a reason to fail a request that worked.
  const saved = process.env.STOCKBIT_STORE_DIR;
  process.env.STOCKBIT_STORE_DIR = join(STORE, "not-a-dir-at-all", "deeper");
  try {
    assert.doesNotThrow(() => writeAccessCache("main", ACCESS, FUTURE, REFRESH));
    assert.doesNotThrow(() => clearAccessCache());
    assert.doesNotThrow(() => readAccessCache("main", REFRESH));
  } finally {
    process.env.STOCKBIT_STORE_DIR = saved;
  }
});
