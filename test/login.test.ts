import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRefresh, tokenUrlAllowed } from "../src/auth/login.ts";
import { securitiesTokenUrlAllowed } from "../src/auth/capture.ts";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjIwMDAwMDAwMDB9.sig-part";

test("extractRefresh finds a top-level `refresh` JWT (the /login/v6/social shape)", () => {
  assert.equal(extractRefresh({ access: "x", refresh: JWT }), JWT);
});

test("extractRefresh finds a nested refresh_token JWT", () => {
  assert.equal(extractRefresh({ data: { data: { refresh_token: JWT } } }), JWT);
});

test("extractRefresh finds token_data.refresh.token from a real login response", () => {
  assert.equal(
    extractRefresh({
      login: {
        token_data: {
          access: { token: "access-token", expired_at: "2026-08-02T18:28:27Z" },
          refresh: { token: JWT, expired_at: "2026-08-08T18:28:27Z" },
        },
      },
    }),
    JWT,
  );
});

test("extractRefresh ignores non-JWT and unrelated fields", () => {
  assert.equal(extractRefresh({ refresh: "not-a-jwt", wskey: "abc123" }), null);
  assert.equal(extractRefresh({ token: JWT }), null); // `token`, not refresh — skip
  assert.equal(extractRefresh("string"), null);
  assert.equal(extractRefresh(null), null);
});

test("extractRefresh handles cyclic objects safely", () => {
  const o: Record<string, unknown> = { a: 1 };
  o.self = o;
  assert.equal(extractRefresh(o), null);
});

test("tokenUrlAllowed accepts main-session token sources", () => {
  assert.equal(tokenUrlAllowed("https://exodus.stockbit.com/login/v6/social"), true);
  assert.equal(tokenUrlAllowed("https://exodus.stockbit.com/login/v6/username"), true);
  assert.equal(tokenUrlAllowed("https://exodus.stockbit.com/login/v3/username/browser"), true);
  assert.equal(
    tokenUrlAllowed("https://exodus.stockbit.com/login/v4/new-device/prompt/verify"),
    true,
  );
  assert.equal(tokenUrlAllowed("wss://wssocial.stockbit.com/socket"), true);
});

test("tokenUrlAllowed rejects securities and E-IPO token sources", () => {
  assert.equal(
    tokenUrlAllowed("https://api-sekuritas.stockbit.com/partner/eipo/access_token"),
    false,
  );
  assert.equal(tokenUrlAllowed("https://carina.stockbit.com/auth/refresh"), false);
  assert.equal(tokenUrlAllowed("https://exodus.stockbit.com/login/v4/otp/verify"), false);
});

test("securitiesTokenUrlAllowed and tokenUrlAllowed never overlap", () => {
  // Two slots, two predicates, no overlap. A carina token stored in the market-data slot would
  // refresh into a token exodus does not accept, and the failure would arrive hours later as an
  // unexplained 401 far from its cause.
  const securities = [
    "https://carina.stockbit.com/auth/v2/login",
    "https://carina.stockbit.com/auth/refresh",
  ];
  const main = [
    "https://exodus.stockbit.com/login/v6/username",
    "https://exodus.stockbit.com/login/v6/social",
  ];
  for (const url of securities) {
    assert.equal(securitiesTokenUrlAllowed(url), true, url);
    assert.equal(tokenUrlAllowed(url), false, `${url} must never be stored as a MAIN session`);
  }
  for (const url of main) {
    assert.equal(tokenUrlAllowed(url), true, url);
    assert.equal(securitiesTokenUrlAllowed(url), false, `${url} is not a trading session`);
  }
});

test("securitiesTokenUrlAllowed rejects everything that is not a carina session response", () => {
  for (const url of [
    "https://carina.stockbit.com/auth/pin/validate", // validates a PIN; issues nothing
    "https://carina.stockbit.com/portfolio/v2/list",
    "https://api-sekuritas.stockbit.com/partner/eipo/access_token",
    "https://evil.test/carina.stockbit.com/auth/refresh".replace("evil.test/", "evil.test/x/"),
    "https://exodus.stockbit.com/auth/v2/login",
  ]) {
    assert.equal(securitiesTokenUrlAllowed(url), false, url);
  }
});
