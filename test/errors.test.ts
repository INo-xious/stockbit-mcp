import { test } from "node:test";
import assert from "node:assert/strict";
import { kindForStatus, mapHttpError, StockbitError } from "../src/http/errors.ts";

test("maps 400 grpc-gateway envelope to invalid_param with details", () => {
  const e = mapHttpError(400, {
    message: "type mismatch, parameter: orderbookid",
    error_type: "INVALID_PARAMETER",
    errors: [{ key: "type mismatch", error: "orderbookid" }],
  });
  assert.equal(e.kind, "invalid_param");
  assert.equal(e.status, 400);
  assert.equal(e.errorType, "INVALID_PARAMETER");
  assert.equal(e.details?.[0]?.error, "orderbookid");
});

test("maps 401/403 to auth", () => {
  assert.equal(mapHttpError(401, {}).kind, "auth");
  assert.equal(mapHttpError(403, {}).kind, "auth");
});

test("maps 404 and 429 and 5xx", () => {
  assert.equal(mapHttpError(404, "not found").kind, "not_found");
  assert.equal(mapHttpError(429, {}).kind, "rate_limited");
  assert.equal(mapHttpError(503, {}).kind, "upstream");
});

test("kindForStatus is the whole table, and it is the only copy of it", () => {
  // Exported in P7g so `refreshOnce` could stop keeping a second, wrong copy of this rule — it
  // labelled every non-ok refresh response `auth`, which made a 502 look like a revoked session.
  // Asserted directly, not only through `mapHttpError`, because the auth path now calls it on its
  // own and a change made for one caller must be visible to the other.
  assert.equal(kindForStatus(400), "invalid_param");
  assert.equal(kindForStatus(401), "auth");
  assert.equal(kindForStatus(403), "auth");
  assert.equal(kindForStatus(404), "not_found");
  assert.equal(kindForStatus(429), "rate_limited");
  assert.equal(kindForStatus(500), "upstream");
  assert.equal(kindForStatus(502), "upstream");
  // Nothing between the named refusals is guessed at. A 402 or a 418 is `unknown`, which is the
  // honest answer — inventing `auth` for it is how a status nobody has observed starts telling
  // users their session is dead.
  assert.equal(kindForStatus(402), "unknown");
  assert.equal(kindForStatus(418), "unknown");
});

test("toResult is a safe compact shape", () => {
  const r = new StockbitError("auth", "nope", { status: 401 }).toResult();
  assert.deepEqual(r, { success: false, error: "nope", kind: "auth", status: 401 });
});
