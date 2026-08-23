import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactValue, redactError, PIN_RE } from "../src/redact.ts";

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

test("the trading credentials are redacted too", () => {
  // A PIN is six digits and a login_token is not JWT-shaped, so neither is caught by the rules the
  // main session needed. Both are bearer-equivalent for the securities account.
  assert.match(redact('{"pin":"123456","login_token":"abc.def"}'), /"pin":"\[REDACTED\]/);
  assert.match(redact('{"login_token":"opaque-grant-value"}'), /"login_token":"\[REDACTED\]/);
  assert.match(redact("securities_token=opaque-value"), /securities_token=\[REDACTED\]/);
  assert.doesNotMatch(redact('{"pin":"123456"}'), /123456/);
});

test("a PIN under a key is DROPPED, not masked in place", () => {
  // Masking part of six digits would leave the rest searchable; the whole value goes.
  const out = redactValue({ pin: "123456", login_token: "x", securities_token: "y", symbol: "BBRI" }) as Record<
    string,
    unknown
  >;
  assert.equal(out.pin, "[REDACTED]");
  assert.equal(out.login_token, "[REDACTED]");
  assert.equal(out.securities_token, "[REDACTED]");
  assert.equal(out.symbol, "BBRI", "non-secret fields must survive");
});

test("PIN_RE recognises a bare six-digit PIN", () => {
  assert.ok(PIN_RE.test("123456"));
  assert.equal(PIN_RE.test("12345"), false);
});
