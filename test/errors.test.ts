import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHttpError, StockbitError } from "../src/http/errors.ts";

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

test("toResult is a safe compact shape", () => {
  const r = new StockbitError("auth", "nope", { status: 401 }).toResult();
  assert.deepEqual(r, { success: false, error: "nope", kind: "auth", status: 401 });
});
