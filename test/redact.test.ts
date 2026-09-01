import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, redactValue, redactError, PIN_RE, TELEGRAM_BOT_TOKEN_RE } from "../src/redact.ts";

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


/* ------------------------------------------------------------------ *
 * The bare `token=` query parameter.
 *
 * The e-IPO refresh is the one route in this project that puts a credential in a URL
 * (src/http/routes/sekuritas.ts, auth: "refreshEipo"). `redactValue` has always dropped `token` as
 * an object key; the STRING path had no rule for it, and a URL is a string. Exposure depended
 * entirely on the token happening to be JWT-shaped — and the securities_token case above proves
 * this project already knows these tokens can be opaque.
 * ------------------------------------------------------------------ */

const OPAQUE = "a1b2c3d4e5f6g7h8i9j0klmnopqrstuv";
const REFRESH_URL = `https://sekuritas.stockbit.com/partner/refresh_token?token=${OPAQUE}`;

test("an opaque token in a ?token= query parameter is redacted", () => {
  const out = redact(REFRESH_URL);
  assert.ok(!out.includes(OPAQUE), `leaked: ${out}`);
  assert.ok(out.includes("[REDACTED]"));
  assert.ok(out.startsWith("https://sekuritas.stockbit.com/partner/refresh_token?token="));
});

test("the URL is still redacted when quoted inside an error message", () => {
  // transport.ts's "Blocked by request policy" builds exactly this, and StockbitError redacts.
  const out = redact(`Blocked by request policy: GET ${REFRESH_URL}`);
  assert.ok(!out.includes(OPAQUE), `leaked: ${out}`);
});

test("a bare token key is redacted in JSON too, not only in a query string", () => {
  assert.ok(!redact(`{"token":"${OPAQUE}"}`).includes(OPAQUE));
  assert.ok(!redact(`token: ${OPAQUE}`).includes(OPAQUE));
  assert.ok(!redact(`https://x/?a=1&token=${OPAQUE}&b=2`).includes(OPAQUE));
});

test("the bare-token rule does not disturb the underscored token names", () => {
  // `_` is a word character, so `\btoken` cannot match inside these five. Each must still be
  // masked exactly once, by its own pattern, with no doubled MASK.
  for (const key of ["refresh_token", "access_token", "login_token", "securities_token"]) {
    const out = redact(`${key}=opaque-value&x=1`);
    assert.equal(out, `${key}=[REDACTED]&x=1`, key);
  }
});

test("a Telegram bot token is redacted by shape, inside the URL that carries it", () => {
  // The Bot API puts the token in the PATH, so there is no key to match on and no word boundary
  // before the digits — the reason TELEGRAM_BOT_TOKEN_RE is deliberately unanchored on the left.
  // Synthetic, and deliberately so: the shape is what this test needs, and the value that used to
  // sit here was the sample token out of Telegram's own Bot API documentation — real-looking enough
  // that a reader had to stop and work out whose it was. Its two sibling fixtures
  // (`telegram.test.ts`, `health.test.ts`) were already obviously fake; this one is now too.
  const bot = "123456789:AAHnot_a_real_token_only_for_tests_00";
  const out = redact(`fetch failed: https://api.telegram.org/bot${bot}/sendMessage`);
  assert.ok(!out.includes(bot), `leaked: ${out}`);
  assert.ok(out.includes("[REDACTED]"));

  assert.ok(new RegExp(TELEGRAM_BOT_TOKEN_RE.source).test(bot));
  // A timestamp has two digits after the colon; a JWT uses dots. Neither is a bot token.
  assert.equal(new RegExp(TELEGRAM_BOT_TOKEN_RE.source).test("12:30"), false);
});
