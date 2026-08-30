import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRefresh, isLoginPage, timeoutMessage, tokenUrlAllowed } from "../src/auth/login.ts";
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

/* ------------------------- the already-signed-in ladder ------------------------- */

test("a Stockbit URL is recognised as the login form or as the signed-in app", () => {
  // This one predicate decides whether the ladder fires at all, so it gets the awkward inputs.
  assert.equal(isLoginPage("https://stockbit.com/login"), true);
  assert.equal(isLoginPage("https://stockbit.com/login/"), true);
  assert.equal(isLoginPage("https://stockbit.com/login?next=%2Fsymbol%2FBBRI"), true);
  assert.equal(isLoginPage("https://stockbit.com/login#otp"), true);
  assert.equal(isLoginPage("https://stockbit.com/LOGIN"), true, "the path is matched case-insensitively");

  assert.equal(isLoginPage("https://stockbit.com/"), false);
  assert.equal(isLoginPage("https://stockbit.com/symbol/BBRI"), false);
  assert.equal(
    isLoginPage("https://stockbit.com/loginhelp"),
    false,
    "a path that merely STARTS WITH /login is not the login form — the boundary has to be a separator",
  );
  assert.equal(isLoginPage("not a url"), false, "an unparsable URL is not the login form");
});

test("a login timeout names where the page actually was, and the lever that fits", () => {
  // The old message was the same sentence for all three, which is true and useless: still on the
  // form, already signed in, and never reached Stockbit need three different next steps.
  const signedIn = timeoutMessage("https://stockbit.com/symbol/BBRI", 900_000);
  assert.match(signedIn, /already signed in/);
  assert.match(signedIn, /--switch-account/);
  assert.match(signedIn, /stockbit\.com\/symbol\/BBRI/, "it must say where the page actually was");
  assert.doesNotMatch(signedIn, /--fresh-profile/, "fresh-profile does not fix an already-signed-in browser");

  const onForm = timeoutMessage("https://stockbit.com/login", 900_000);
  assert.match(onForm, /--fresh-profile/);
  assert.doesNotMatch(onForm, /--switch-account/, "switch-account does not fix a form nobody filled in");

  const nowhere = timeoutMessage(null, 900_000);
  assert.match(nowhere, /import-har/);
  assert.match(nowhere, /No Stockbit page was open/);

  for (const m of [signedIn, onForm, nowhere]) {
    assert.match(m, /~15 minute/, "the message must say how long it actually waited");
  }
});

test("the login ladder never enables a CDP domain to clear cookies", async () => {
  // ADR-0005 restricts the CHARTBIT driver to Page and Runtime, and its test only greps
  // src/chartbit/ — so this file would not trip it either way. Matching the restraint is the
  // decision, and a decision that only lives in a comment is not one.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(fileURLToPath(new URL("../src/auth/login.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(
    code.includes("Network.clearBrowserCookies"),
    false,
    "clearing is done with Storage.clearDataForOrigin, which needs no Network domain",
  );
  assert.ok(code.includes("Storage.clearDataForOrigin"), "and that is the call it uses");
  assert.ok(code.includes("Storage.clearCookies"), "with a browser-wide fallback for builds without it");
});

test("the already-signed-in harvest can only ever fill the MAIN slot", async () => {
  // `harvestFromBrowser` reads `credentialStorage` out of the stockbit.com web session, so what it
  // returns is a MARKET-DATA credential by construction. `trading-login --browser` passed
  // slot: "securities", the tier accepted that main token for it, and the CLI printed "Trading
  // session captured" — the 401 only surfaced on the test refresh afterwards, leaving a poisoned
  // securities slot behind. The `slot` guard was one-directional: it kept a carina token out of
  // main and left the reverse wide open. This is an inner closure, so the invariant is pinned the
  // way the CDP-domain one above is.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const source = readFileSync(fileURLToPath(new URL("../src/auth/login.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const line = code.split("\n").find((l) => l.includes("!harvestTried"));
  assert.ok(line, "the harvest tier still exists");
  assert.match(
    line,
    /options\.slot/,
    "the harvest tier must test the target slot: it can only honestly fill `main`",
  );
});
