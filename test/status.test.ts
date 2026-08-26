/**
 * The report a user reads when nothing is working.
 *
 * Three properties, and each exists because of a specific way this could be worse than useless:
 *
 *   1. **It answers on an empty store.** The state it is most needed in is the broken one. A
 *      `status` that throws when there is no credential directory tells a new user nothing at all,
 *      which is exactly when they need it.
 *   2. **It never carries a token.** It decodes the stored JWT to read one number out of it. A tool
 *      result is text a model relays and a client may log, so the whole serialised report is
 *      checked for anything JWT-shaped rather than each field being trusted.
 *   3. **`nextStep` is one instruction, and it is the right one.** A list of things you could try
 *      is what the error messages already were.
 */
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-status-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;
delete process.env.STOCKBIT_TRADING;

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { collectStatus, formatStatus, loginStarted, loginFinished, resetLoginStatus } from "../src/status.ts";
import { getStore, resetStoreCache } from "../src/auth/store.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

beforeEach(() => {
  resetLoginStatus();
  delete process.env.STOCKBIT_TRADING;
});

/** A syntactically real JWT with the given `exp`. Signature is nonsense; nothing here verifies it. */
function fakeJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "test", exp: expSeconds })}.c2lnbmF0dXJl`;
}

/** Anything that looks like a JWT. Deliberately loose — a partial leak is still a leak. */
const JWT_SHAPED = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

function clearAllSlots(): void {
  for (const slot of ["main", "securities", "eipo"] as const) {
    try {
      getStore(slot).clear();
    } catch {
      /* nothing stored */
    }
  }
  resetStoreCache();
}

test("an empty store produces a report, not an exception", async () => {
  clearAllSlots();
  const report = await collectStatus({ now: new Date("2026-08-25T03:00:00Z") });

  assert.equal(report.auth.main.stored, false);
  assert.equal(report.auth.securities.stored, false);
  assert.equal(report.auth.eipo.stored, false);
  assert.equal(report.server.name, "stockbit");
  assert.match(report.server.version, /^\d+\.\d+\.\d+/);
  assert.ok(report.checks.length > 0);
});

test("with no session at all, nextStep names login and nothing else", async () => {
  clearAllSlots();
  const report = await collectStatus();
  assert.match(report.nextStep, /log me into Stockbit/);
  assert.match(report.nextStep, /stockbit-auth login/);
  assert.doesNotMatch(report.nextStep, /trading-login/, "one instruction, not a menu");
});

test("a store that cannot be read is a failed check, not a crash", async () => {
  clearAllSlots();
  const saved = process.env.STOCKBIT_STORE_DIR;
  // A path whose parent is a file, so any read or write under it fails.
  process.env.STOCKBIT_STORE_DIR = join(STORE, "not-a-dir", "deeper");
  try {
    resetStoreCache();
    const report = await collectStatus();
    assert.equal(report.auth.main.stored, false);
    assert.ok(report.nextStep.length > 0);
  } finally {
    process.env.STOCKBIT_STORE_DIR = saved;
    resetStoreCache();
  }
});

test("a store that will not say whether it holds a credential must not advise logging in", async () => {
  // The bug this prevents, end to end: a locked login Keychain answers every read with a non-zero
  // exit, `get()` returns null, `status` reports "not set", and `nextStep` tells the user to log in
  // again — which on macOS means overwriting a credential that was never in doubt. "I could not
  // find out" and "there is nothing here" are different answers and must produce different advice.
  clearAllSlots();
  const store = getStore("main");
  const realReadState = store.readState.bind(store);
  (store as unknown as { readState: () => string }).readState = () => "unavailable";
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.unreadable, true, "the report must say the answer is unknown");
    assert.equal(report.auth.main.stored, false, "and must not claim a credential is present either");
    assert.match(
      report.nextStep,
      /Keychain/i,
      "nextStep must point at the Keychain, not at logging in",
    );
    assert.doesNotMatch(
      report.nextStep,
      /stockbit-auth login/,
      "advising a re-login here destroys a credential that may be perfectly good",
    );
    assert.match(formatStatus(report), /UNREADABLE/, "the terminal rendering must not read as 'not set'");
    assert.ok(
      report.checks.some((c) => c.name === "credential store (main)" && c.status === "warn"),
      "and it is a warning, because something really is wrong",
    );
  } finally {
    (store as unknown as { readState: unknown }).readState = realReadState;
  }
});

test("a stored token yields an expiry and never the token", async () => {
  clearAllSlots();
  mkdirSync(STORE, { recursive: true });
  const inSevenDays = Math.floor(Date.now() / 1000) + 7 * 86400;
  const token = fakeJwt(inSevenDays);
  getStore("main").set(token);
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.stored, true);
    assert.ok(
      report.auth.main.expiresInDays !== undefined && Math.abs(report.auth.main.expiresInDays - 7) < 0.1,
      `expected ~7 days, got ${report.auth.main.expiresInDays}`,
    );
    assert.notEqual(report.auth.main.expired, true);

    const serialised = JSON.stringify(report);
    assert.doesNotMatch(serialised, JWT_SHAPED, "the report carried something JWT-shaped");
    assert.ok(!serialised.includes(token));
    assert.doesNotMatch(formatStatus(report), JWT_SHAPED);
  } finally {
    clearAllSlots();
  }
});

test("an expired token says so rather than reporting a negative countdown as health", async () => {
  clearAllSlots();
  getStore("main").set(fakeJwt(Math.floor(Date.now() / 1000) - 86400));
  try {
    const report = await collectStatus();
    assert.equal(report.auth.main.expired, true);
    assert.match(report.nextStep, /log/i, "an expired session needs the same next step as a missing one");
    assert.ok(report.checks.some((c) => c.name === "market-data session" && c.status === "fail"));
  } finally {
    clearAllSlots();
  }
});

test("STOCKBIT_TRADING=off is reported as env-off, with the reason", async () => {
  clearAllSlots();
  process.env.STOCKBIT_TRADING = "off";
  try {
    const report = await collectStatus();
    assert.equal(report.trading.enabled, false);
    assert.equal(report.trading.source, "env-off");
    assert.match(report.trading.reason, /environment/i);
  } finally {
    delete process.env.STOCKBIT_TRADING;
  }
});

test("the live check is explicitly not run unless it is asked for", async () => {
  clearAllSlots();
  const report = await collectStatus();
  const live = report.checks.find((c) => c.name === "live check");
  assert.ok(live);
  assert.equal(live.status, "warn");
  assert.match(live.detail, /Not run/);
});

test("a login in progress is reported, and forgotten when it finishes", async () => {
  clearAllSlots();
  loginStarted(new Date("2026-08-25T02:00:00Z"));
  let report = await collectStatus();
  assert.equal(report.login.inProgress, true);
  assert.equal(report.login.startedAt, "2026-08-25T02:00:00.000Z");

  loginFinished("captured");
  report = await collectStatus();
  assert.equal(report.login.inProgress, false);
  assert.equal(report.login.lastResult, "captured");
});

test("the terminal rendering says the same things as the structure", async () => {
  clearAllSlots();
  const report = await collectStatus({ now: new Date("2026-08-25T03:00:00Z") });
  const text = formatStatus(report);
  assert.ok(text.includes(report.server.version));
  assert.ok(text.includes(report.nextStep));
  assert.ok(text.includes(report.market.phase));
});
