/**
 * When the Keychain refuses a write, the credential must still be kept — and the fact must stick.
 *
 * Field report, v1.2.2 on macOS, 2026-08-30: `login()` captured a session and then threw
 * "Keychain write failed" (a background MCP server cannot display the macOS authorisation prompt).
 * The failure was non-fatal, so the captured token lived in memory for about ninety seconds of real
 * calls and the server then fell back to the STORED refresh token — revoked, because the login had
 * just superseded it. Every later call 401'd. Worse, refresh tokens rotate and are single-use, so
 * each retry SPENT a good token to mint a replacement that was discarded: retrying made it worse.
 *
 * The part these tests exist to protect is not the fallback itself but its STICKINESS. The backend
 * is chosen per process and cached only in memory, so a one-off write to the file store would be
 * invisible to the next process: it would build a Keychain store, read the stale item still sitting
 * there, and report it present. Nothing would ever look at the file.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-storefallback-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  backendFor,
  clearBackendFallback,
  fallenBackSlots,
  recordBackendFallback,
  resetStoreCache,
} from "../src/auth/store.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));
beforeEach(() => {
  for (const slot of ["main", "securities", "eipo"] as const) clearBackendFallback(slot);
  resetStoreCache();
});

/* ------------------------------ backend precedence ------------------------------ */

test("with no fallback recorded, the platform decides", () => {
  assert.equal(backendFor("main", true, {}), "keychain");
  assert.equal(backendFor("main", false, {}), "file");
});

test("a RECORDED fallback outranks a usable Keychain", () => {
  // The whole point. The live credential is in the file store; consulting the Keychain would find
  // the stale item and report it present, which is the bug this fix ends.
  assert.equal(backendFor("main", true, { main: "file" }), "file");
});

test("a fallback is per slot and does not leak to the others", () => {
  const overrides = { main: "file" };
  assert.equal(backendFor("main", true, overrides), "file");
  assert.equal(backendFor("securities", true, overrides), "keychain");
  assert.equal(backendFor("eipo", true, overrides), "keychain");
});

test("an unrecognised marker value is ignored rather than obeyed", () => {
  // A corrupt or hand-edited marker must not be able to invent a third backend.
  assert.equal(backendFor("main", true, { main: "nonsense" }), "keychain");
  assert.equal(backendFor("main", false, { main: "nonsense" }), "file");
});

/* ------------------------------ marker persistence ------------------------------ */

test("a recorded fallback survives into a fresh read", () => {
  assert.deepEqual(fallenBackSlots(), []);
  recordBackendFallback("main");
  assert.deepEqual(fallenBackSlots(), ["main"]);
});

test("the marker is a real file, so the NEXT process sees it too", () => {
  // In-memory stickiness is not enough: the process that fell back usually dies before the one
  // that has to read the credential back.
  recordBackendFallback("main");
  const marker = join(STORE, "backend.json");
  assert.ok(existsSync(marker), "no marker file was written");
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { main: "file" });
});

test("recording twice is idempotent", () => {
  recordBackendFallback("main");
  recordBackendFallback("main");
  assert.deepEqual(fallenBackSlots(), ["main"]);
});

test("several slots can be recorded independently", () => {
  recordBackendFallback("main");
  recordBackendFallback("securities");
  assert.deepEqual(fallenBackSlots().sort(), ["main", "securities"]);
});

test("clearing lets the Keychain be tried again", () => {
  recordBackendFallback("main");
  clearBackendFallback("main");
  assert.deepEqual(fallenBackSlots(), []);
  assert.equal(backendFor("main", true), "keychain");
});

test("clearing a slot that never fell back is a no-op, not an error", () => {
  clearBackendFallback("eipo");
  assert.deepEqual(fallenBackSlots(), []);
});

/* ------------------------------ the wiring ------------------------------ */

const SRC = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

test("a refused Keychain write keeps the credential instead of throwing it away", () => {
  const store = SRC("src/auth/store.ts");
  // The write must be attempted, the failure caught, and the token handed to the file store.
  assert.match(store, /try \{\s*keychainWrite\(token, slot\);/);
  assert.match(store, /fallbackToFile\(slot, token, err\)/);
});

test("the fallback deletes the superseded Keychain item", () => {
  // Leaving it would hand a future reader a revoked token that reports as present — the exact
  // shape of the bug being fixed.
  const store = SRC("src/auth/store.ts");
  const body = store.slice(store.indexOf("function fallbackToFile"));
  assert.match(body.slice(0, 1800), /keychainStore\(slot\)\.clear\(\)/);
});

test("if the file store ALSO fails, the error is raised rather than swallowed", () => {
  // At that point nothing holds the credential, and a login that stored nothing has not succeeded.
  const store = SRC("src/auth/store.ts");
  const body = store.slice(store.indexOf("function fallbackToFile"));
  assert.match(body.slice(0, 1200), /throw new Error\(/);
  assert.match(body.slice(0, 1200), /file store also failed/);
});

test("the downgrade is announced, not silent", () => {
  const store = SRC("src/auth/store.ts");
  assert.match(store, /This is a downgrade/);
  assert.match(store, /stockbit-auth doctor/);
});

/* ------------------------------ status honesty ------------------------------ */

test("the market-data check consults health, not just presence", () => {
  // It reported "Stored." beside "main session: fail" for the SAME credential, because one asked
  // the refresh journal and the other only asked whether a file existed.
  const status = SRC("src/status.ts");
  const block = status.slice(status.indexOf('name: "market-data session"') - 400);
  assert.match(block.slice(0, 1400), /mainRejected/);
  assert.match(block.slice(0, 1400), /REJECTED it the last time it was used/);
});

test("a login that failed to store is surfaced as a failed check", () => {
  // The login tool deliberately returns before the person has finished typing, so it cannot report
  // this at its own call site. `status` is where its closing message sends the user.
  const status = SRC("src/status.ts");
  assert.match(status, /name: "last login"/);
  assert.match(status, /the credential did not land/);
});

test("a store that fell back says so every time status is read", () => {
  const status = SRC("src/status.ts");
  assert.match(status, /name: "credential store"/);
  assert.match(status, /encrypted FILE store, not the Keychain/);
});
