import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactValue, redactError } from "../src/redact.ts";

const JWT =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTYiLCJleHAiOjk5OTk5OTk5OTl9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

test("redacts a bare JWT", () => {
  const out = redact(`token is ${JWT} end`);
  assert.ok(!out.includes(JWT));
  assert.ok(out.includes("[REDACTED]"));
});

test("redacts Authorization: Bearer header", () => {
  const out = redact(`authorization: Bearer ${JWT}`);
  assert.ok(!out.includes(JWT));
});

test("redacts refresh_token in JSON and query", () => {
  assert.ok(!redact(`{"refresh_token":"${JWT}"}`).includes(JWT));
  assert.ok(!redact(`refresh_token=${JWT}&x=1`).includes(JWT));
});

test("redactValue drops sensitive keys in nested objects", () => {
  const v = redactValue({
    ok: true,
    authorization: `Bearer ${JWT}`,
    nested: { refresh_token: JWT, note: `see ${JWT}` },
    list: [JWT, "safe"],
  });
  const s = JSON.stringify(v);
  assert.ok(!s.includes(JWT), "no token substring should survive");
  assert.ok(s.includes("[REDACTED]"));
});

test("redactError scrubs message and stack", () => {
  const err = new Error(`failed with ${JWT}`);
  redactError(err);
  assert.ok(!err.message.includes(JWT));
  assert.ok(!(err.stack ?? "").includes(JWT));
});
