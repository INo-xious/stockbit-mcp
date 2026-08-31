/**
 * The session-health journal.
 *
 * It exists because you cannot prove a refresh token is live without spending it, and spending it
 * ends the user's website session. So the project stops inferring validity and records it: every
 * refresh already knows the answer, and writing it down is what lets `status` report a revoked
 * session at **zero requests**.
 *
 * Two properties carry it, and one of them is a security property:
 *
 *   1. **The file holds no token.** It is plaintext, it is written on every refresh, and
 *      `SECURITY.md` asks vulnerability reporters to paste `status` output into a public issue.
 *      A "just the first few characters" fingerprint would be a token prefix, which is a token.
 *   2. **`failing` is bound to the token that is there now.** Without the fingerprint check, a
 *      recorded failure is just an old error message, and `status` would tell a user to log in
 *      again over a token they replaced ten minutes ago.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-health-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearSessionHealth,
  lastEventFor,
  lastEventForToken,
  readHealthJournal,
  recordRefreshFailure,
  recordRefreshOk,
  sessionHealthPath,
  slotHealthState,
} from "../src/auth/health.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));
beforeEach(() => clearSessionHealth());

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDAsInN1YiI6InNlY3JldC1zdWJqZWN0In0.a-real-looking-signature";
const REPLACED = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDAsInN1YiI6InJlcGxhY2VkIn0.another-signature";

/* ------------------------------ the secret rule ------------------------------ */

test("the journal contains nothing JWT-shaped and no substring of any token", () => {
  // The whole file, not a field at a time: the point is that nothing anywhere in it is a
  // credential, and asserting per-field would miss a token that arrived through `reason`.
  recordRefreshOk("main", TOKEN);
  recordRefreshFailure("securities", REPLACED, 401, `Refresh failed for https://exodus.stockbit.com/login/refresh?token=${TOKEN}`);

  const raw = readFileSync(sessionHealthPath(), "utf8");
  assert.doesNotMatch(raw, /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./, "nothing JWT-shaped may appear");

  // And no substring either — a prefix of a token is a token.
  for (const token of [TOKEN, REPLACED]) {
    for (let len = 12; len <= token.length; len += 7) {
      assert.equal(
        raw.includes(token.slice(0, len)),
        false,
        `a ${len}-character prefix of the token leaked into the journal`,
      );
    }
    assert.equal(raw.includes(token.split(".")[2]), false, "the signature must not appear either");
  }
});

test("a failure reason is redacted on the way IN, not on the way out", () => {
  // Written once, read many times, including by a human pasting it into an issue. Redacting at read
  // time would leave the secret on disk.
  recordRefreshFailure("main", TOKEN, 401, `boom at https://api.telegram.org/bot123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/sendMessage`);
  const raw = readFileSync(sessionHealthPath(), "utf8");
  assert.equal(raw.includes("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false, "a bot token in a URL must be redacted");
});

test("the journal is owner-only", { skip: process.platform === "win32" ? "NTFS cannot express POSIX mode 0o600" : false }, () => {
  recordRefreshOk("main", TOKEN);
  assert.equal(statSync(sessionHealthPath()).mode & 0o777, 0o600);
});

/* --------------------------------- recording --------------------------------- */

test("a success and a failure are kept apart, per slot", () => {
  recordRefreshOk("main", TOKEN);
  recordRefreshFailure("securities", TOKEN, 401, "HTTP 401");
  const journal = readHealthJournal();
  assert.ok(journal.main?.lastOk, "main recorded a success");
  assert.equal(journal.main?.lastFailure, undefined, "and no failure");
  assert.ok(journal.securities?.lastFailure, "securities recorded a failure");
  assert.equal(journal.securities?.lastFailure?.status, 401);
});

test("a transport failure records no HTTP status", () => {
  // The journal keeps these apart so `status` can tell "Stockbit rejected this" from "the network
  // was down". Only the first means log in again.
  recordRefreshFailure("main", TOKEN, undefined, "fetch failed");
  assert.equal(readHealthJournal().main?.lastFailure?.status, undefined);
});

/* ------------------------------- deriving state ------------------------------- */

test("nothing stored and expired are answered without the journal at all", () => {
  assert.equal(slotHealthState("main", null, false), "not-stored");
  assert.equal(slotHealthState("main", TOKEN, true), "expired");
});

test("a token nothing has been recorded about is unknown, not healthy", () => {
  // The ordinary state on a fresh install. Reporting it as ok would be inventing evidence.
  assert.equal(slotHealthState("main", TOKEN, false), "unknown");
  recordRefreshOk("main", REPLACED);
  assert.equal(
    slotHealthState("main", TOKEN, false),
    "unknown",
    "a success recorded for a DIFFERENT token says nothing about this one",
  );
});

test("a rejection recorded for the token still in the store is `failing`", () => {
  // The case that motivated the whole file: present, unexpired, and refused. Every expiry-based
  // check reports this as healthy.
  recordRefreshFailure("main", TOKEN, 401, "HTTP 401");
  assert.equal(slotHealthState("main", TOKEN, false), "failing");
});

test("a rejection is forgotten once the token has been replaced", () => {
  // Without the fingerprint check this would say "revoked" about a token the user replaced ten
  // minutes ago — advice that destroys a credential that is fine.
  recordRefreshFailure("main", TOKEN, 401, "HTTP 401");
  assert.equal(slotHealthState("main", REPLACED, false), "unknown");
});

test("a success after a failure clears the failing state", async () => {
  recordRefreshFailure("main", TOKEN, 401, "HTTP 401");
  assert.equal(slotHealthState("main", TOKEN, false), "failing");
  await new Promise((r) => setTimeout(r, 5)); // distinct timestamps
  recordRefreshOk("main", TOKEN);
  assert.equal(slotHealthState("main", TOKEN, false), "ok");
});

test("a failure after a success wins, and lastEventFor names it", async () => {
  recordRefreshOk("main", TOKEN);
  await new Promise((r) => setTimeout(r, 5));
  recordRefreshFailure("main", TOKEN, 401, "HTTP 401");
  assert.equal(slotHealthState("main", TOKEN, false), "failing");
  const event = lastEventFor("main");
  assert.equal(event?.status, 401, "the most recent event is the failure");
});

/* ------------------------- one credential at a time ------------------------- */
//
// `slotHealthState` filtered by fingerprint and `lastEventFor` did not, so a caller pairing them —
// `status` — reported a verdict about one credential beside a timestamp and an HTTP status
// belonging to another. Observed in the field as `health: "failing"` with a `lastRefresh` 32
// minutes OLDER than the credential it was describing.

test("lastEventForToken answers only about the token it was given", () => {
  recordRefreshFailure("main", REPLACED, 401, "HTTP 401");
  assert.equal(lastEventForToken("main", TOKEN), null, "nothing is recorded about this one");
  assert.equal(lastEventForToken("main", REPLACED)?.status, 401);
  assert.equal(lastEventForToken("main", null), null, "no token, no claim");
  assert.equal(lastEventForToken("securities", REPLACED), null, "and not about another slot");
});

test("lastEventFor keeps its unfiltered meaning", () => {
  // It is still the right answer for the web session, which has no token to filter by, and for the
  // journal read as a record rather than as a verdict. The fix is an addition, not a signature
  // change — changing it would have broken both callers silently.
  recordRefreshFailure("main", REPLACED, 401, "HTTP 401");
  assert.equal(lastEventFor("main")?.status, 401);
});

test("a success for another credential does not clear this one's rejection", async () => {
  // `failedAfterSuccess` compared a MATCHING failure against an UNFILTERED lastOk, so a success
  // belonging to a token the user no longer holds could out-date this token's own 401 and demote
  // it to `unknown` — the good-news half of the same bug, and the one nobody would have looked at.
  recordRefreshFailure("main", TOKEN, 401, "HTTP 401");
  await new Promise((r) => setTimeout(r, 5));
  recordRefreshOk("main", REPLACED);
  assert.equal(slotHealthState("main", TOKEN, false), "failing");
  assert.equal(lastEventForToken("main", TOKEN)?.status, 401);
});

test("a rejection of another credential does not condemn this one", async () => {
  recordRefreshOk("main", TOKEN);
  await new Promise((r) => setTimeout(r, 5));
  recordRefreshFailure("main", REPLACED, 401, "HTTP 401");
  assert.equal(slotHealthState("main", TOKEN, false), "ok");
  assert.equal(lastEventForToken("main", TOKEN)?.status, undefined);
});

/* --------------------------------- robustness --------------------------------- */

test("a corrupt journal reads as empty and never throws", () => {
  recordRefreshOk("main", TOKEN);
  rmSync(sessionHealthPath(), { force: true });
  writeFileSync(sessionHealthPath(), "{ not json at all");
  assert.doesNotThrow(() => readHealthJournal());
  assert.deepEqual(readHealthJournal(), {});
  assert.equal(slotHealthState("main", TOKEN, false), "unknown");
});

test("recording never throws, even with nowhere to write", () => {
  // It runs beside a refresh that has already succeeded or already failed. Neither outcome may
  // change because a diagnostic file could not be written.
  const saved = process.env.STOCKBIT_STORE_DIR;
  process.env.STOCKBIT_STORE_DIR = join(STORE, "not-a-dir", "deeper");
  try {
    assert.doesNotThrow(() => recordRefreshOk("main", TOKEN));
    assert.doesNotThrow(() => recordRefreshFailure("main", TOKEN, 500, "boom"));
    assert.doesNotThrow(() => clearSessionHealth("main"));
  } finally {
    process.env.STOCKBIT_STORE_DIR = saved;
  }
});

test("clearing one slot leaves the others, and clearing all leaves nothing", () => {
  recordRefreshOk("main", TOKEN);
  recordRefreshOk("eipo", TOKEN);
  clearSessionHealth("main");
  assert.equal(readHealthJournal().main, undefined);
  assert.ok(readHealthJournal().eipo);
  clearSessionHealth();
  assert.deepEqual(readHealthJournal(), {});
});
