/**
 * Three sessions, kept genuinely apart.
 *
 * The properties asserted here are the ones whose absence would show up hours later as an
 * unexplained 401:
 *
 *   - a securities read must present the SECURITIES token, never the market-data one;
 *   - refreshing one domain must not disturb another, in memory or on disk;
 *   - the trading PIN must exist only in the request that consumes it;
 *   - `STOCKBIT_ACCESS_TOKEN` must remain main-only, because an environment variable that could
 *     seed a trading session would be exactly the hole ADR-0004 closes.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-session-test-"));

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { ensureFresh, forceRefresh, hasStoredSession, resetSession } from "../src/auth/session.ts";
import { loginSecurities, logoutSecurities } from "../src/auth/tradinglogin.ts";
import { getJson } from "../src/http/client.ts";
import { StockbitError } from "../src/http/errors.ts";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

function jwt(expSecondsFromNow: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) + expSecondsFromNow })}.sig`;
}

interface Call {
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
}

/** Record every request and answer from a table keyed by URL substring. */
function fakeApi(routes: Array<[string, (call: Call) => Response]>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: unknown, init: RequestInit = {}) => {
    const call: Call = {
      url: String(url),
      method: init.method ?? "GET",
      authorization: new Headers(init.headers).get("authorization"),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const [needle, respond] of routes) {
      if (call.url.includes(needle)) return respond(call);
    }
    return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
  }) as typeof fetch;
  return calls;
}

function tokenResponse(access: string, refresh: string): Response {
  return new Response(
    JSON.stringify({ data: { data: { token_data: { access: { token: access }, refresh: { token: refresh } } } } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  resetSession();
  for (const slot of ["main", "securities", "eipo"] as const) getStore(slot).clear();
  globalThis.fetch = realFetch;
});

test("each domain has its own store slot on disk", () => {
  getStore("main").set("MAIN-R");
  getStore("securities").set("SEC-R");
  getStore("eipo").set("EIPO-R");
  assert.equal(getStore("main").get(), "MAIN-R");
  assert.equal(getStore("securities").get(), "SEC-R");
  assert.equal(getStore("eipo").get(), "EIPO-R");
  // Clearing one must not touch the others: `trading-logout` ends trading, not market data.
  getStore("securities").clear();
  assert.equal(getStore("securities").get(), null);
  assert.equal(getStore("main").get(), "MAIN-R", "clearing trading must not log the user out of quotes");
  assert.equal(getStore("eipo").get(), "EIPO-R");
});

test("a securities route presents the securities token, not the market-data one", async () => {
  getStore("main").set("MAIN-R");
  getStore("securities").set("SEC-R");
  const calls = fakeApi([
    ["exodus.stockbit.com/login/refresh", () => tokenResponse(jwt(3600), "MAIN-R2")],
    ["carina.stockbit.com/auth/refresh", () => tokenResponse("SEC-ACCESS", "SEC-R2")],
    ["carina.stockbit.com/auth/logout", () => new Response("{}", { status: 200 })],
  ]);

  const main = await ensureFresh("main");
  const securities = await ensureFresh("securities");
  assert.notEqual(main, securities, "two domains must not share an access token");
  assert.equal(securities, "SEC-ACCESS");

  // The refresh for carina goes in the BODY with no bearer — the one thing that differs from exodus.
  const carinaRefresh = calls.find((c) => c.url.includes("carina.stockbit.com/auth/refresh"))!;
  assert.deepEqual(carinaRefresh.body, { refresh_token: "SEC-R" });
  assert.equal(carinaRefresh.authorization, null);

  // And a carina call afterwards carries the securities access token.
  await logoutSecurities();
  const logout = calls.find((c) => c.url.includes("/auth/logout"))!;
  assert.equal(logout.authorization, "Bearer SEC-ACCESS");
});

test("refreshing one domain leaves the others' in-memory tokens alone", async () => {
  getStore("main").set("MAIN-R");
  getStore("securities").set("SEC-R");
  let mainRefreshes = 0;
  fakeApi([
    [
      "login/refresh",
      () => {
        mainRefreshes++;
        return tokenResponse(jwt(3600), "MAIN-R");
      },
    ],
    ["carina.stockbit.com/auth/refresh", () => tokenResponse(jwt(3600), "SEC-R")],
  ]);

  await ensureFresh("main");
  assert.equal(mainRefreshes, 1);
  await forceRefresh("securities");
  await ensureFresh("main");
  assert.equal(mainRefreshes, 1, "a trading refresh must not invalidate the market-data token");
});

test("resetSession(domain) drops only that domain", async () => {
  getStore("main").set("MAIN-R");
  let mainRefreshes = 0;
  fakeApi([
    [
      "login/refresh",
      () => {
        mainRefreshes++;
        return tokenResponse(jwt(3600), "MAIN-R");
      },
    ],
  ]);
  await ensureFresh("main");
  resetSession("securities");
  await ensureFresh("main");
  assert.equal(mainRefreshes, 1);
  resetSession("main");
  await ensureFresh("main");
  assert.equal(mainRefreshes, 2);
});

test("a missing trading session names the command that creates one", async () => {
  getStore("main").set("MAIN-R");
  fakeApi([["login/refresh", () => tokenResponse(jwt(3600), "MAIN-R")]]);
  await assert.rejects(
    () => ensureFresh("securities"),
    (err: unknown) => {
      assert.ok(err instanceof StockbitError && err.kind === "auth");
      assert.match(err.message, /trading-login/);
      // And it says the PIN is not stored, because that is the question a user asks next.
      assert.match(err.message, /never stored/);
      return true;
    },
  );
  assert.equal(hasStoredSession("securities"), false);
});

test("STOCKBIT_ACCESS_TOKEN seeds the MAIN session only", async () => {
  // An environment variable that could seed a TRADING session would be exactly the hole the
  // "environment can only turn trading off" rule closes.
  const previous = process.env.STOCKBIT_ACCESS_TOKEN;
  process.env.STOCKBIT_ACCESS_TOKEN = jwt(3600);
  try {
    assert.equal(await ensureFresh("main"), process.env.STOCKBIT_ACCESS_TOKEN);
    await assert.rejects(() => ensureFresh("securities"), /trading-login/);
    await assert.rejects(() => ensureFresh("eipo"), /stockbit-auth login/);
  } finally {
    if (previous === undefined) delete process.env.STOCKBIT_ACCESS_TOKEN;
    else process.env.STOCKBIT_ACCESS_TOKEN = previous;
  }
});

/* ------------------------------- the trading unlock ------------------------------- */

test("trading-login exchanges a grant plus the PIN, and stores only the refresh token", async () => {
  getStore("main").set("MAIN-R");
  const calls = fakeApi([
    ["login/refresh", () => tokenResponse(jwt(3600), "MAIN-R")],
    [
      "/sekuritas/auth/token",
      () => new Response(JSON.stringify({ data: { login_token: "GRANT-1" } }), { status: 200 }),
    ],
    ["carina.stockbit.com/auth/v2/login", () => tokenResponse("SEC-ACCESS", "SEC-REFRESH")],
  ]);

  const result = await loginSecurities({ pin: "123456" });
  assert.equal(result.backend, "file");

  const login = calls.find((c) => c.url.includes("/auth/v2/login"))!;
  assert.deepEqual(login.body, { login_token: "GRANT-1", pin: "123456" });
  // The grant is authorised by the market-data session; the PIN is the second factor.
  assert.equal(login.authorization, null, "the PIN login takes a grant, not a bearer of ours");

  // Only the refresh token is persisted. The access token lives in memory and nowhere else.
  assert.equal(getStore("securities").get(), "SEC-REFRESH");
  assert.equal(await ensureFresh("securities"), "SEC-ACCESS", "the access token was seeded, not re-fetched");
  assert.equal(
    calls.filter((c) => c.url.includes("carina.stockbit.com/auth/refresh")).length,
    0,
    "seeding the access token avoids spending the refresh we were just handed",
  );
});

test("the PIN never reaches disk", async () => {
  getStore("main").set("MAIN-R");
  fakeApi([
    ["login/refresh", () => tokenResponse(jwt(3600), "MAIN-R")],
    ["/sekuritas/auth/token", () => new Response(JSON.stringify({ data: { login_token: "G" } }), { status: 200 })],
    ["carina.stockbit.com/auth/v2/login", () => tokenResponse("A", "R")],
  ]);
  await loginSecurities({ pin: "987654" });

  const dir = process.env.STOCKBIT_STORE_DIR!;
  const { readdirSync, readFileSync } = await import("node:fs");
  for (const file of readdirSync(dir)) {
    const full = join(dir, file);
    let contents = "";
    try {
      contents = readFileSync(full, "utf8");
    } catch {
      continue; // a directory (a lock), not a file
    }
    assert.doesNotMatch(contents, /987654/, `${file} contains the trading PIN`);
  }
});

test("a badly-shaped PIN is refused before anything is sent", async () => {
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  await assert.rejects(() => loginSecurities({ pin: "12" }), /4–8 digits/);
  await assert.rejects(() => loginSecurities({ pin: "notdigits" }), /4–8 digits/);
  assert.equal(called, false, "no request should have been attempted");
});

test("an error from the PIN login never echoes the PIN", async () => {
  getStore("main").set("MAIN-R");
  fakeApi([
    ["login/refresh", () => tokenResponse(jwt(3600), "MAIN-R")],
    ["/sekuritas/auth/token", () => new Response(JSON.stringify({ data: { login_token: "G" } }), { status: 200 })],
    [
      "carina.stockbit.com/auth/v2/login",
      () => new Response(JSON.stringify({ message: "PIN salah" }), { status: 400 }),
    ],
  ]);
  await assert.rejects(
    () => loginSecurities({ pin: "555111" }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /555111/);
      return true;
    },
  );
});

test("a Cloudflare challenge is reported as a challenge, not as a wrong PIN", async () => {
  // The natural response to "403 on a PIN login" is to retype the PIN, which is useless here and is
  // how an account gets locked. The header Cloudflare sets says which of the two it is.
  getStore("main").set("MAIN-R");
  getStore("securities").set("SEC-R");
  fakeApi([
    ["login/refresh", () => tokenResponse(jwt(3600), "MAIN-R")],
    ["carina.stockbit.com/auth/refresh", () => tokenResponse("SEC-A", "SEC-R")],
    [
      "carina.stockbit.com/auth/pin/validate",
      () => new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } }),
    ],
  ]);

  await assert.rejects(
    () => getJson("carinaAuthPinValidate"),
    (err: unknown) => {
      assert.ok(err instanceof StockbitError);
      assert.equal(err.kind, "challenge", "a challenge is not an auth failure");
      assert.match(err.message, /--browser/);
      assert.match(err.message, /NOT an entitlement/);
      return true;
    },
  );
});

test("trading-logout ends the session server-side and locally, and survives the server refusing", async () => {
  getStore("main").set("MAIN-R");
  getStore("securities").set("SEC-R");
  fakeApi([
    ["login/refresh", () => tokenResponse(jwt(3600), "MAIN-R")],
    ["carina.stockbit.com/auth/refresh", () => tokenResponse("SEC-A", "SEC-R")],
    ["carina.stockbit.com/auth/logout", () => new Response(JSON.stringify({ message: "nope" }), { status: 500 })],
  ]);

  const result = await logoutSecurities();
  assert.equal(result.cleared, true);
  assert.notEqual(result.remote, "ok", "the server-side logout failed and that is reported");
  assert.equal(getStore("securities").get(), null, "logout must mean the credential is gone from this machine");
  assert.equal(getStore("main").get(), "MAIN-R", "and market data is untouched");
});
