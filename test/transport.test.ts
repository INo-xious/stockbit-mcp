/**
 * The ADR-0002 boundary tests.
 *
 * Two halves, and the second is the one that matters. A permitted-route test proves the policy
 * accepts the right list; it does not prove every request goes through the policy. Before M0,
 * `src/auth/session.ts` called `fetch` with a bearer outside `src/http/` entirely — a route test
 * would have passed straight over that hole. So the bypass guards below read the source tree and
 * fail if any module other than the transport builds a credentialed request.
 *
 * ## What changed when a second and third host arrived
 *
 * "The approved origin" is now three approved origins carrying three different credentials, and
 * that turns a new class of mistake into a real risk: a carina path reachable on exodus, or an
 * exodus path reachable with the trading token. Neither fails loudly on the wire — carina answers a
 * foreign path with a well-formed 404 envelope that reads exactly like "this symbol has no data".
 * So the snapshot is per host, `isPermitted` is asserted to be host-scoped in both directions, and
 * every route's auth kind is checked against its host.
 */
// Isolate the token store BEFORE importing modules that read it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-transport-test-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTHENTICATED_ORIGIN,
  ORIGINS,
  ROUTES,
  SEGMENT_NAMES,
  authenticatedRequest,
  buildUrl,
  domainOf,
  isPermitted,
  isRefreshRoute,
  permittedRequests,
  resolvePath,
  type Host,
  type RouteName,
} from "../src/http/transport.ts";
import { StockbitError } from "../src/http/errors.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const EXODUS = ORIGINS.exodus;
const CARINA = ORIGINS.carina;
const SEKURITAS = ORIGINS.sekuritas;

/* --------------------------- the permitted set, asserted --------------------------- */

test("the permitted request set on EXODUS is exactly this list", () => {
  // Locked deliberately: adding a route must show up as a change to this assertion, so a new
  // authenticated request shape cannot land without a reviewer seeing it.
  assert.deepEqual(permittedRequests("exodus"), [
    "DELETE /chartbit/charts/:layoutId",
    "DELETE /chartbit/settings/:templateName",
    "GET /analyst-ratings/:symbol",
    "GET /analyst-ratings/:symbol/consensus",
    "GET /auth/eipo/webview/link",
    "GET /chartbit/chart-drawings",
    "GET /chartbit/charts",
    "GET /chartbit/charts/:layoutId",
    "GET /chartbit/drawings",
    "GET /chartbit/initial/:symbol",
    "GET /chartbit/settings",
    "GET /chartbit/settings/:templateName",
    "GET /chartbit/studies",
    "GET /chartbit/version",
    "GET /charts/:symbol",
    "GET /charts/:symbol/daily",
    "GET /company-price-feed/historical/summary/:symbol",
    "GET /company-price-feed/market-time/session",
    "GET /company-price-feed/price-performance/:symbol",
    "GET /company-price-feed/prices",
    "GET /company-price-feed/prices/:symbol/market",
    "GET /company-price-feed/prices/close",
    "GET /company-price-feed/seasonality/:symbol",
    "GET /company-price-feed/v2/orderbook/companies/:symbol",
    "GET /comparison/:symbol/industries",
    "GET /comparison/:symbol/ratios",
    "GET /comparison/:symbol/templates",
    "GET /comparison/metrics",
    "GET /comparison/templates",
    "GET /corpaction",
    "GET /corpaction/:actionType",
    "GET /corpaction/:symbol/stock_conversion",
    "GET /corpaction/status",
    "GET /earnings",
    "GET /emitten-metadata/shareholders/:symbol/chart",
    "GET /emitten-metadata/subsidiary/:symbol",
    "GET /emitten/:symbol/contact",
    "GET /emitten/:symbol/info",
    "GET /emitten/:symbol/profile",
    "GET /emitten/classification",
    "GET /emitten/classification/company",
    "GET /emitten/hotlist/:moverType",
    "GET /emitten/indexes/:indexCode",
    "GET /emitten/sectors",
    "GET /emitten/trending",
    "GET /emitten/v2/:emittenType/:symbol/fin-items",
    "GET /emitten/v2/:emittenType/:symbol/info",
    "GET /emitten/v3/sector/:sectorId/company",
    "GET /findata-view/company/financial",
    "GET /findata-view/marketdetectors/brokers",
    "GET /fundachart/metrics",
    "GET /fundachart/templates",
    "GET /insider/company/majorholder",
    "GET /insider/majorholder/ownership",
    "GET /insider/shareholding/companies/:symbol",
    "GET /insider/shareholding/composition/companies/:symbol",
    "GET /insider/shareholding/investors/:insiderId",
    "GET /insider/shareholding/network",
    "GET /keystats/:symbol",
    "GET /keystats/ratio/v1/:symbol",
    "GET /marketdetectors/:symbol",
    "GET /order-trade/broker/activity",
    "GET /order-trade/broker/distribution",
    "GET /order-trade/broker/top",
    "GET /order-trade/market-mover",
    "GET /order-trade/order-queue",
    "GET /order-trade/running-trade",
    "GET /order-trade/running-trade/chart/:symbol",
    "GET /order-trade/running-trade/group",
    "GET /order-trade/top-stock",
    "GET /order-trade/trade-book",
    "GET /order-trade/trade-book/chart",
    "GET /order-trade/underwriters",
    "GET /order-trade/underwriters/:underwriterCode/ipo-performance",
    "GET /paywall/eligibility/check",
    "GET /research/categories",
    "GET /research/indicator/new",
    "GET /screener/favorites",
    "GET /screener/finitem-watchlist",
    "GET /screener/metric",
    "GET /screener/preset",
    "GET /screener/templates",
    "GET /screener/templates/:templateId",
    "GET /screener/universe",
    "GET /search",
    "GET /search/v2",
    "GET /sekuritas/auth/token",
    "GET /stream/non-login/user/:username",
    "GET /stream/v3",
    "GET /stream/v3/post/:postId",
    "GET /stream/v3/symbol/:symbol",
    "GET /stream/v3/symbol/:symbol/pinned",
    "GET /user-setting/configurations",
    "GET /watchlist",
    "GET /watchlist/:watchlistId",
    "GET /watchlist/:watchlistId/symbols",
    "GET /watchlist/search/company",
    "POST /chartbit/chart-drawings",
    "POST /chartbit/charts",
    "POST /chartbit/settings",
    "POST /emitten-metadata/shareholders/token",
    "POST /login/refresh",
    "POST /screener/templates",
    "POST /stream/v3/trending",
    "PUT /chartbit/charts/:layoutId",
    "PUT /chartbit/settings/:templateName",
  ]);
});

test("the permitted request set on CARINA is exactly this list", () => {
  // The trading host: the unlock chain, and the account reads that describe money. Every row is a
  // GET except the four that manage the session itself — the order writes are a separate increment
  // and have to edit this list, and ORDER_WRITES below, to arrive.
  assert.deepEqual(permittedRequests("carina"), [
    "GET /account",
    "GET /balance/cash",
    "GET /balance/cash/info",
    "GET /formula/v2",
    "GET /history/detail",
    "GET /history/performance/portfolio/:performanceKind",
    "GET /history/performance/trade",
    "GET /history/realized",
    "GET /history/realized/detail",
    "GET /history/v3",
    "GET /order/v2/detail",
    "GET /order/v2/list",
    "GET /portfolio/v2/detail",
    "GET /portfolio/v2/list",
    "GET /portfolio/v2/summary",
    "GET /stock/tradable",
    "GET /trading/info",
    "GET /v2/sub-account/list",
    "POST /auth/logout",
    "POST /auth/pin/validate",
    "POST /auth/refresh",
    "POST /auth/v2/login",
    "POST /order/v2/amend",
    "POST /order/v2/buy",
    "POST /order/v2/cancel",
    "POST /order/v2/sell",
  ]);
});

test("every carina route is a GET unless it is named as a session or an order route", () => {
  // Two claims in one. A non-GET that is not on either list below would be a write arriving as an
  // ordinary row — the bulk-amend and bulk-cancel endpoints exist on this host and have no tool, no
  // argument for one, and therefore no route. And a route here carrying the MAIN token would be the
  // market-data credential sent to the brokerage, presented somewhere it was never issued for.
  const session = new Set(["carinaAuthLogin", "carinaAuthLogout", "carinaAuthPinValidate", "carinaAuthRefresh"]);
  const orders = new Set(["orderBuy", "orderSell", "orderAmend", "orderCancel"]);
  // The two token-exchange rows are the exception and are asserted by name: the login carries no
  // credential of ours because it is what mints one, and the refresh carries the refresh token in
  // the BODY rather than a header. Both are spelled out so a third exception cannot arrive quietly.
  assert.equal(ROUTES.carinaAuthLogin.auth, "none");
  assert.equal(ROUTES.carinaAuthRefresh.auth, "refreshSecurities");

  for (const [name, route] of Object.entries(ROUTES)) {
    if (route.host !== "carina") continue;
    if (name !== "carinaAuthLogin" && name !== "carinaAuthRefresh") {
      assert.equal(route.auth, "securities", `${name} must carry the securities credential, not ${route.auth}`);
    }
    if (session.has(name) || orders.has(name)) continue;
    assert.equal(route.method, "GET", `${name} is a ${route.method} on carina and is on neither named list`);
  }
});

test("the permitted request set on API-SEKURITAS is exactly this list", () => {
  assert.deepEqual(permittedRequests("sekuritas"), [
    "GET /partner/refresh_token",
    "POST /partner/eipo/access_token",
  ]);
});

/* ------------------------------- the write classes ------------------------------- */

/**
 * Every non-GET route, sorted into named classes, each citing the ADR that admitted it.
 *
 * This is the tripwire. Before ADR-0003 the whole list read `["loginRefresh"]`, and editing it is
 * the deliberate act that lets a mutation into the project — which is what it is for. The classes
 * exist so that "a new write appeared" is not one undifferentiated fact: a session refresh, a chart
 * save and an order are three different arguments, and each has to be made in its own place.
 */
const SESSION_WRITES = [
  // Mutate session state only. No account data is touched by any of these.
  "carinaAuthLogin",
  "carinaAuthLogout",
  "carinaAuthPinValidate",
  "carinaAuthRefresh",
  "eipoAccessToken",
  "loginRefresh",
];

/**
 * ADR-0003, as amended. Chart persistence, on the endpoints Stockbit's own save adapter uses.
 *
 * The per-symbol pair this ADR was originally written against turned out to be a server-side stub —
 * it accepted every valid body and stored nothing — and has been removed along with the module and
 * the tools that called it. These are where the chart page actually saves.
 */
const CHARTBIT_WRITES = [
  "chartbitChartCreate",
  "chartbitChartDelete",
  "chartbitChartUpdate",
  "chartbitDrawingsSave",
  "chartbitSettingDelete",
  "chartbitSettingUpdate",
  "chartbitSettingsCreate",
];

/**
 * ADR-0004. The four routes that move money.
 *
 * Four, and only these four. `/order/v2/amend/bulk`, `/order/v2/bulk-cancel` and the whole
 * day-trade family exist on this host and are deliberately absent: each would need its own argument
 * about what a confirmation means when one "yes" covers several orders, and none has been made.
 */
const ORDER_WRITES = ["orderAmend", "orderBuy", "orderCancel", "orderSell"];

/** ADR-0004. e-IPO subscription orders, under the same trading switch. Empty until that increment. */
const EIPO_ORDER_WRITES: string[] = [];

/** ADR-0006. Watchlist and screener edits. Empty until that increment. */
const ACCOUNT_WRITES: string[] = [];

/**
 * POSTs that read.
 *
 * A verb is not a posture: Stockbit uses POST for several pure reads because the query does not fit
 * in a URL. They are listed separately so "this is a POST" never has to mean "this mutates", and so
 * that a genuine write cannot hide in the crowd by being called a read-shaped one.
 */
const READ_SHAPED_POSTS = [
  // The shareholder chart's one-shot access token: minted, used by the very next GET, creates
  // nothing.
  "shareholdersToken",
  // An ad-hoc screen. The body carries Stockbit's own `save: "0"` — evaluate, do not persist — and
  // `buildScreenBody` hard-codes it with a unit test on that exact value. Saving is a separate,
  // confirm-gated tool.
  "screenerRun",
  // Trending posts. The date/cursor triple does not fit in a URL, so Stockbit's client posts it.
  "streamTrending",
];

test("every non-GET route belongs to exactly one named write class", () => {
  const declared = [
    ...SESSION_WRITES,
    ...CHARTBIT_WRITES,
    ...ORDER_WRITES,
    ...EIPO_ORDER_WRITES,
    ...ACCOUNT_WRITES,
    ...READ_SHAPED_POSTS,
  ].sort();
  assert.deepEqual(
    new Set(declared).size,
    declared.length,
    "a route named in two classes means two different arguments claim the same mutation",
  );

  const actual = Object.entries(ROUTES)
    .filter(([, route]) => route.method !== "GET")
    .map(([name]) => name)
    .sort();
  assert.deepEqual(
    actual,
    declared,
    "a new non-GET route is a change of posture, not a feature — put it in a class and cite its ADR",
  );
});

test("the session writes touch the session and nothing else", () => {
  // The property ADR-0002 protects, restated now that there are three credential chains: everything
  // in this class mints, renews, validates or ends a token. None of it can move money or edit
  // account data, and the paths are the proof.
  const allowed = [
    "/login/refresh",
    "/auth/v2/login",
    "/auth/refresh",
    "/auth/pin/validate",
    "/auth/logout",
    "/partner/eipo/access_token",
  ];
  for (const name of SESSION_WRITES) {
    assert.ok(
      allowed.includes(ROUTES[name as RouteName].template),
      `${name} is filed as a session write but its path is not one`,
    );
  }
  assert.equal(buildUrl("loginRefresh"), `${EXODUS}/login/refresh`);
  assert.equal(buildUrl("carinaAuthLogin"), `${CARINA}/auth/v2/login`);
  assert.equal(buildUrl("eipoAccessToken"), `${SEKURITAS}/partner/eipo/access_token`);
});

test("the chart writes touch only the user's chart", () => {
  // Every one of these is under `/chartbit`. Nothing in this class can reach a portfolio, an order,
  // a watchlist, a profile or the settings blob — which is the property ADR-0003 was written to keep
  // true while opening one door.
  for (const name of CHARTBIT_WRITES) {
    const route = ROUTES[name as RouteName];
    assert.ok(
      route.template.startsWith("/chartbit/"),
      `${name} (${route.method} ${route.template}) mutates something outside the chart`,
    );
  }
  assert.equal(buildUrl("chartbitChartUpdate", { layoutId: "42" }), `${EXODUS}/chartbit/charts/42`);
  assert.equal(buildUrl("chartbitDrawingsSave"), `${EXODUS}/chartbit/chart-drawings`);
});

test("the writes that would matter most are absent, by every verb", () => {
  // Named individually rather than left to the class assertion, because these are the specific
  // things a reader wants to see refused: posting as the user, following someone, day-trade and
  // smart orders (deliberately out of scope), and the settings blob that holds the real chart
  // configuration.
  const forbidden: Array<[string, string, string]> = [
    ["POST", EXODUS, "/stream/write"],
    ["POST", EXODUS, "/stream/like/1"],
    ["POST", EXODUS, "/stream/reply"],
    ["POST", EXODUS, "/stream/follow"],
    ["POST", EXODUS, "/user-setting/configurations"],
    ["POST", CARINA, "/order/day-trade/v1/buy"],
    ["POST", CARINA, "/order/v2/bulk-cancel"],
    ["POST", SEKURITAS, "/smart-order/bracket-order/v1/order"],
    ["DELETE", SEKURITAS, "/smart-order/stop-order/v1/order/1"],
  ];
  for (const [method, origin, path] of forbidden) {
    assert.equal(isPermitted(method, `${origin}${path}`), false, `${method} ${origin}${path} must be rejected`);
  }
});

test("a path on one host is not thereby permitted on another", () => {
  // The failure this prevents is quiet, not loud: carina answers an exodus path with a well-formed
  // 404 envelope, which a parser reads as "this symbol has no data" rather than "wrong host".
  assert.equal(isPermitted("GET", `${CARINA}/emitten/BBRI/info`), false, "a market-data path on the trading host");
  assert.equal(isPermitted("GET", `${EXODUS}/order/v2/list`), false, "a trading path on the market-data host");
  assert.equal(isPermitted("POST", `${EXODUS}/auth/v2/login`), false, "the PIN login is carina's alone");
  assert.equal(isPermitted("POST", `${SEKURITAS}/login/refresh`), false);
  assert.equal(isPermitted("GET", `${SEKURITAS}/keystats/BBRI`), false);
  // And the positive control, so the above is not passing because everything is rejected.
  assert.equal(isPermitted("GET", `${EXODUS}/emitten/BBRI/info`), true);
  assert.equal(isPermitted("POST", `${CARINA}/auth/v2/login`), true);
});

test("every route's auth kind is consistent with its host", () => {
  // A carina route drawing on the market-data token would send the wrong credential to the right
  // place — a 401 at best, and at worst a token presented to a host it was not issued for.
  const allowedByHost: Record<Host, string[]> = {
    exodus: ["main", "refreshMain"],
    carina: ["securities", "refreshSecurities", "none"],
    sekuritas: ["eipo", "refreshEipo", "none"],
  };
  for (const [name, route] of Object.entries(ROUTES)) {
    assert.ok(
      allowedByHost[route.host].includes(route.auth),
      `${name} is on ${route.host} but draws on the ${route.auth} credential`,
    );
  }
});

test("only the three refresh routes carry a refresh credential", () => {
  const refreshRoutes = Object.entries(ROUTES)
    .filter(([, route]) => route.auth.startsWith("refresh"))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(refreshRoutes, ["carinaAuthRefresh", "eipoRefreshToken", "loginRefresh"]);
  for (const name of refreshRoutes) assert.equal(isRefreshRoute(name as RouteName), true);
  // A refresh route must never 401-retry through a refresh: that recurses on a dead token.
  assert.equal(isRefreshRoute("emittenInfo"), false);
});

test("each route's token domain is the one its host's session actually holds", () => {
  assert.equal(domainOf("emittenInfo"), "main");
  assert.equal(domainOf("loginRefresh"), "main");
  assert.equal(domainOf("carinaAuthRefresh"), "securities");
  assert.equal(domainOf("carinaAuthPinValidate"), "securities");
  assert.equal(domainOf("eipoRefreshToken"), "eipo");
  // The two token-exchange endpoints take no credential of OURS — they take a grant, in the body.
  assert.equal(domainOf("carinaAuthLogin"), null);
  assert.equal(domainOf("eipoAccessToken"), null);
});

test("every method in the table is one the client knows how to send", () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    assert.ok(
      ["GET", "POST", "PUT", "DELETE"].includes(route.method),
      `${name} declares method ${route.method}, which no client verb sends`,
    );
  }
});

test("every declared route builds a URL the policy accepts", () => {
  const segments = {
    symbol: "BBRI",
    moverType: "topGainer",
    watchlistId: "6252652",
    templateId: "5951939",
    companyId: "459",
    postId: "12345",
    sectorId: "7",
    insiderId: "88",
    layoutId: "4242",
    brokerCode: "YP",
    underwriterCode: "AI",
    indexCode: "IDX30",
    orderId: "ORD-123_abc",
    username: "someone.here",
    templateName: "My Layout 2",
    emittenType: "company",
    performanceKind: "total-equity",
    actionType: "dividend",
  };
  for (const [name, route] of Object.entries(ROUTES)) {
    const url = buildUrl(name as RouteName, segments);
    assert.ok(
      isPermitted(route.method, url),
      `${route.method} ${url} was built by the transport but rejected by its own policy`,
    );
  }
});

test("the segment validator table and the segment names agree", () => {
  // A template naming a segment with no validator would throw at call time rather than at review
  // time; a validator nothing uses is dead weight that looks like coverage.
  assert.deepEqual(
    [...SEGMENT_NAMES].sort(),
    [
      "actionType",
      "brokerCode",
      "companyId",
      "emittenType",
      "indexCode",
      "insiderId",
      "layoutId",
      "moverType",
      "orderId",
      "performanceKind",
      "postId",
      "sectorId",
      "symbol",
      "templateId",
      "templateName",
      "underwriterCode",
      "username",
      "watchlistId",
    ],
  );
  const used = new Set(
    Object.values(ROUTES).flatMap((route) =>
      route.template.split("/").filter((p) => p.startsWith(":")).map((p) => p.slice(1)),
    ),
  );
  for (const name of used) {
    assert.ok(SEGMENT_NAMES.includes(name as never), `route template uses :${name} with no validator`);
  }
});

test("the writable Chartbit surface is exactly the charts, drawings and settings triple", () => {
  // The layouts and their drawings are writable; everything else under /chartbit is not, and the
  // retired per-symbol stub is gone entirely rather than left declared as a route that stores nothing.
  assert.equal(isPermitted("PUT", `${EXODUS}/chartbit/charts/42`), true);
  assert.equal(isPermitted("DELETE", `${EXODUS}/chartbit/charts/42`), true);
  assert.equal(isPermitted("POST", `${EXODUS}/chartbit/chart-drawings`), true);
  assert.equal(isPermitted("POST", `${EXODUS}/chartbit/settings`), true);

  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/chartbit/BBRI/layout", "/chartbit/template", "/chartbit/layouts", "/chartbit/BBRI/drawings"]) {
      assert.equal(isPermitted(method, `${EXODUS}${path}`), false, `${method} ${path} must be rejected`);
    }
  }
  // A layout id is a path segment on a bearer-carrying DELETE, so it gets the numeric-id validator
  // rather than anything looser.
  assert.equal(isPermitted("DELETE", `${EXODUS}/chartbit/charts/..`), false);
  assert.equal(isPermitted("DELETE", `${EXODUS}/chartbit/charts/mine`), false);

  // The study and drawing template lists are readable and NOT writable — creating one has no caller.
  assert.equal(isPermitted("GET", `${EXODUS}/chartbit/studies`), true);
  assert.equal(isPermitted("POST", `${EXODUS}/chartbit/studies`), false);
  assert.equal(isPermitted("GET", `${EXODUS}/chartbit/drawings`), true);
  assert.equal(isPermitted("POST", `${EXODUS}/chartbit/drawings`), false);

  // The settings blob holds the user's real chart configuration and stays READ-ONLY.
  assert.equal(isPermitted("GET", `${EXODUS}/user-setting/configurations`), true);
  assert.equal(isPermitted("POST", `${EXODUS}/user-setting/configurations`), false);
});

test("a GET route refuses a body rather than silently dropping it", async () => {
  // A caller passing a body to a read has misunderstood something; hiding that would surface later
  // as data that is quietly wrong.
  await assert.rejects(
    () => authenticatedRequest("chartbitChart", { token: "T", segments: { layoutId: "42" }, body: { x: 1 } }),
    (err: unknown) => err instanceof StockbitError && /cannot carry a body/.test(err.message),
  );
});

test("a write sends its body as JSON and still refuses redirects", async () => {
  const realFetch = globalThis.fetch;
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    seen = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await authenticatedRequest("chartbitChartUpdate", {
      token: "T",
      segments: { layoutId: "42" },
      body: { content: "{}" },
    });
    assert.equal(seen?.method, "PUT");
    assert.equal(seen?.body, JSON.stringify({ content: "{}" }));
    assert.equal(new Headers(seen?.headers).get("content-type"), "application/json");
    // A redirected write would apply the mutation at an origin the policy never approved.
    assert.equal(seen?.redirect, "manual");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* --------------------------- credential placement --------------------------- */

test("carina's refresh carries its token in the BODY and sends no bearer", async () => {
  // This is the one thing about the trading chain that differs from the main session, and getting
  // it wrong is a 401 with nothing in the message to suggest where to look.
  const realFetch = globalThis.fetch;
  let seen: RequestInit | undefined;
  let seenUrl = "";
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    seenUrl = String(url);
    seen = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await authenticatedRequest("carinaAuthRefresh", { token: "RTOK" });
    assert.equal(seenUrl, `${CARINA}/auth/refresh`);
    assert.equal(seen?.body, JSON.stringify({ refresh_token: "RTOK" }));
    assert.equal(new Headers(seen?.headers).get("authorization"), null, "no bearer on this route");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the e-IPO refresh carries its token as a QUERY parameter and sends no bearer", async () => {
  const realFetch = globalThis.fetch;
  let seenUrl = "";
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => {
    seenUrl = String(url);
    seen = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await authenticatedRequest("eipoRefreshToken", { token: "ETOK" });
    assert.equal(new URL(seenUrl).searchParams.get("token"), "ETOK");
    assert.equal(new Headers(seen?.headers).get("authorization"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a token-exchange route sends no credential of ours at all", async () => {
  // `carinaAuthLogin` takes a grant and a PIN in its body. Attaching the market-data bearer would
  // present a token to a host it was never issued for.
  const realFetch = globalThis.fetch;
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    seen = init;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await authenticatedRequest("carinaAuthLogin", { body: { login_token: "G", pin: "000000" } });
    assert.equal(new Headers(seen?.headers).get("authorization"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ------------------------------- what the policy rejects ------------------------------- */

test("the bearer never leaves the approved origins", () => {
  const offOrigin = [
    "https://evil.test/emitten/BBRI/info",
    // Suffix and prefix attacks on a hostname compare that was not origin-parsed.
    "https://exodus.stockbit.com.evil.test/emitten/BBRI/info",
    "https://notexodus.stockbit.com/emitten/BBRI/info",
    "https://carina.stockbit.com.evil.test/auth/refresh",
    "https://stockbit.com/emitten/BBRI/info",
    // The legacy MAS broker backend: real, referenced by the bundle, and deliberately never approved.
    "https://trading.masonline.id/order/v2/buy",
    // Scheme and port are part of the origin.
    "http://exodus.stockbit.com/emitten/BBRI/info",
    "https://exodus.stockbit.com:8443/emitten/BBRI/info",
    // Userinfo pointing the real host at an attacker's.
    "https://exodus.stockbit.com@evil.test/emitten/BBRI/info",
    // Right origin, but credentials embedded in the URL.
    "https://user:pass@exodus.stockbit.com/emitten/BBRI/info",
    "https://user@carina.stockbit.com/auth/refresh",
    "not-a-url",
  ];
  for (const url of offOrigin) {
    assert.equal(isPermitted("GET", url), false, `${url} must not receive a credential`);
    assert.equal(isPermitted("POST", url), false, `${url} must not receive a credential`);
  }
});

test("method is checked per path, not globally", () => {
  // The refresh path is POST-only and the read paths are GET-only; neither generalizes.
  assert.equal(isPermitted("GET", `${EXODUS}/login/refresh`), false);
  assert.equal(isPermitted("POST", `${EXODUS}/emitten/BBRI/info`), false);
  assert.equal(isPermitted("DELETE", `${EXODUS}/emitten/BBRI/info`), false);
  assert.equal(isPermitted("GET", `${CARINA}/auth/refresh`), false);
});

test("unknown and near-miss paths are rejected", () => {
  const rejected = [
    "/",
    "/emitten",
    "/emitten/BBRI",
    "/emitten/BBRI/info/extra",
    "/emitten/BBRI/orders",
    "/keystats",
    "/keystats/ratio/v2/BBRI",
    "/login/refresh/../../portfolio",
    "/marketdetectors",
  ];
  for (const path of rejected) {
    assert.equal(isPermitted("GET", `${EXODUS}${path}`), false, `${path} must be rejected`);
  }
});

test("a dynamic segment cannot widen the path", () => {
  // Each of these is a path the *table* would otherwise seem to allow at `/keystats/:symbol`.
  const hostile = [
    `${EXODUS}/keystats/BBRI/../../login/refresh`,
    `${EXODUS}/keystats/BBRI%2F..%2F..%2Flogin%2Frefresh`,
    `${EXODUS}/keystats/..`,
    `${EXODUS}/keystats/BBRI/%2e%2e`,
    `${EXODUS}/keystats/bbri`, // lowercase never reaches the wire
    `${EXODUS}/keystats/`,
  ];
  for (const url of hostile) {
    assert.equal(isPermitted("GET", url), false, `${url} must be rejected`);
  }
});

test("resolvePath validates and encodes segments rather than interpolating them", () => {
  assert.equal(resolvePath("keystats", { symbol: "BBRI" }), "/keystats/BBRI");
  assert.equal(resolvePath("emittenInfo", { symbol: "bbri" }), "/emitten/BBRI/info");
  assert.equal(resolvePath("orderbook", { symbol: "BUKA-W" }), "/company-price-feed/v2/orderbook/companies/BUKA-W");

  // The pre-M0 bug: `symbol.toUpperCase()` interpolated straight into the template.
  for (const bad of ["../../login/refresh", "BBRI/info", "BBRI?x=1", "BBRI#f", "", "  ", "%2e%2e"]) {
    assert.throws(
      () => resolvePath("keystats", { symbol: bad }),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      `Symbol ${JSON.stringify(bad)} must be rejected, not uppercased into the path`,
    );
  }
});

test("a missing or invalid segment fails before any request is built", () => {
  assert.throws(
    () => resolvePath("keystats", {}),
    (err: unknown) => err instanceof StockbitError && /requires a symbol segment/.test(err.message),
  );
  assert.throws(
    () => resolvePath("emittenHotlist", { moverType: "topFlop" }),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
});

test("a numeric-id segment refuses anything that is not digits", () => {
  // A watchlist or template id goes into the PATH, so a lax validator would be a path-traversal
  // primitive on a bearer-carrying request. The URL parser resolves `..` before `isPermitted` sees
  // it, but the right place to stop this is before the URL is built at all.
  for (const bad of ["../../login", "6252652/../..", "abc", "", "6252652;drop", "-1", "1e3"]) {
    assert.throws(
      () => resolvePath("watchlistDetail", { watchlistId: bad }),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      `watchlistId ${JSON.stringify(bad)} should be refused`,
    );
  }
  assert.equal(resolvePath("watchlistDetail", { watchlistId: "6252652" }), "/watchlist/6252652");
  assert.equal(resolvePath("screenerRunTemplate", { templateId: "5951939" }), "/screener/templates/5951939");
});

test("REGRESSION: the hotlist path carries the spelling Stockbit's own client sends", () => {
  // This project invented `topGainer` for its tool schema and then sent it on the wire. The
  // endpoint answered 200 with an empty list — not 404 — and the tool's own description explained
  // an empty hotlist away as a closed market. So a request that never returned a row looked exactly
  // like a correct one, for the whole life of the tool.
  assert.equal(new URL(buildUrl("emittenHotlist", { moverType: "topGainer" })).pathname, "/emitten/hotlist/topgainer");
  assert.equal(new URL(buildUrl("emittenHotlist", { moverType: "topLoser" })).pathname, "/emitten/hotlist/toploser");
  assert.equal(
    new URL(buildUrl("emittenHotlist", { moverType: "mostActive" })).pathname,
    "/emitten/hotlist/mostactive",
  );

  // `isPermitted` re-validates the path it judges, so the validator has to accept its own output.
  for (const wire of ["topgainer", "toploser", "mostactive"]) {
    assert.equal(isPermitted("GET", `${EXODUS}/emitten/hotlist/${wire}`), true, wire);
  }
});

test("query params are appended, null/undefined dropped, and arrays REPEATED", () => {
  const url = new URL(
    buildUrl("pricesClose", undefined, { symbol: "BBRI", interval: 1, skip: null, gone: undefined }),
  );
  assert.equal(url.pathname, "/company-price-feed/prices/close");
  assert.equal(url.searchParams.get("symbol"), "BBRI");
  assert.equal(url.searchParams.get("interval"), "1");
  assert.equal(url.searchParams.has("skip"), false);
  assert.equal(url.searchParams.has("gone"), false);

  // Repeated, not comma-joined: broker activity reads only the first of a joined list, so the
  // joined form returns a confident, narrower answer rather than an error.
  const repeated = new URL(buildUrl("pricesClose", undefined, { market_type: ["RG", "TN"] }));
  assert.deepEqual(repeated.searchParams.getAll("market_type"), ["RG", "TN"]);
  assert.equal(repeated.search.includes("RG%2CTN"), false);
});

/* ------------------------- redirects are a rejection, not a hop ------------------------- */

test("an authenticated request is sent with redirect following disabled", async () => {
  const realFetch = globalThis.fetch;
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    seen = init;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    await authenticatedRequest("keystats", { token: "T", segments: { symbol: "BBRI" } });
    assert.equal(seen?.redirect, "manual", "undici would otherwise replay the bearer at the new origin");
    assert.equal(new Headers(seen?.headers).get("authorization"), "Bearer T");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a 3xx on an authenticated request throws instead of following", async () => {
  const realFetch = globalThis.fetch;
  for (const status of [301, 302, 303, 307, 308]) {
    globalThis.fetch = (async () =>
      new Response(null, { status, headers: { location: "https://evil.test/steal" } })) as typeof fetch;
    try {
      await assert.rejects(
        () => authenticatedRequest("keystats", { token: "T", segments: { symbol: "BBRI" } }),
        (err: unknown) => {
          assert.ok(err instanceof StockbitError, `HTTP ${status} must throw a StockbitError`);
          assert.equal(err.status, status);
          assert.doesNotMatch(err.message, /evil\.test/, "must not echo an upstream-controlled Location");
          return true;
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test("an empty credential is refused before the request goes out", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("{}");
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => authenticatedRequest("keystats", { token: "", segments: { symbol: "BBRI" } }),
      (err: unknown) => err instanceof StockbitError && err.kind === "auth",
    );
    assert.equal(called, false, "no request should have been attempted");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ----------------------------- the bypass guard (the real one) ----------------------------- */

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/** The sole module permitted to attach a Stockbit credential to a request. */
const TRANSPORT = join(SRC, "http", "transport.ts");
/** The route tables. They declare paths — that is their job — but issue nothing. */
const ROUTE_DIR = join(SRC, "http", "routes");

test("only the transport constructs a bearer credential", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === TRANSPORT) continue;
    const source = readFileSync(file, "utf8");
    // Matches a bearer value being *built* from a variable — not the literal header names that
    // `src/redact.ts` matches on, and not prose in a comment.
    if (/["'`]\s*Bearer\s+\$\{/i.test(source) || /authorization:\s*`Bearer/i.test(source)) {
      offenders.push(file.slice(SRC.length + 1));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these modules build a bearer outside the ADR-0002 boundary; route them through " +
      "authenticatedRequest() instead",
  );
});

test("no module outside the transport calls fetch with a Stockbit host", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === TRANSPORT) continue;
    const source = readFileSync(file, "utf8");
    // Inspect each fetch call's first argument. `src/auth/launch.ts` legitimately fetches the local
    // Chrome DevTools endpoint on 127.0.0.1 with no credential; that must keep passing.
    for (const match of source.matchAll(/\bfetch\s*\(([^,)]*)/g)) {
      const target = match[1];
      if (/stockbit\.com|HOSTS\.|ORIGINS\.|AUTH\.refreshUrl|AUTHENTICATED_ORIGIN/.test(target)) {
        offenders.push(`${file.slice(SRC.length + 1)}: fetch(${target.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a request to a Stockbit host must be issued by src/http/transport.ts so the host/method/path " +
      "policy and the no-redirect rule actually apply",
  );
});

test("the guard would catch a bypass (negative control)", () => {
  // Proves the patterns above are not vacuous — if these stop matching, the guards are asleep.
  const bearerBypass = 'const h = { authorization: `Bearer ${token}` };';
  const fetchBypass = 'await fetch(`${HOSTS.exodus}/portfolio`, { method: "DELETE" });';
  const originBypass = 'await fetch(`${ORIGINS.carina}/order/v2/buy`, { method: "POST" });';
  assert.ok(/["'`]\s*Bearer\s+\$\{/i.test(bearerBypass) || /authorization:\s*`Bearer/i.test(bearerBypass));
  for (const sample of [fetchBypass, originBypass]) {
    assert.ok(
      [...sample.matchAll(/\bfetch\s*\(([^,)]*)/g)].some(([, target]) =>
        /stockbit\.com|HOSTS\.|ORIGINS\.|AUTH\.refreshUrl|AUTHENTICATED_ORIGIN/.test(target),
      ),
      sample,
    );
  }
  // And that the allowed CDP call is not a false positive.
  const cdpCall = "const r = await fetch(`http://127.0.0.1:${port}/json/version`);";
  assert.ok(
    [...cdpCall.matchAll(/\bfetch\s*\(([^,)]*)/g)].every(
      ([, target]) => !/stockbit\.com|HOSTS\.|ORIGINS\.|AUTH\.refreshUrl|AUTHENTICATED_ORIGIN/.test(target),
    ),
  );
});

/**
 * Strip comments, so a guard about CODE is not tripped by prose explaining an endpoint.
 *
 * A path inside a doc comment cannot reach the wire, and the modules that call these routes are
 * exactly the ones that should be naming them in their documentation. The alternative — wording
 * every comment around the strings it forbids — leaves the guard passing for the wrong reason.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Path-shaped string literals in `source`, matched the way the guard below matches them. */
function declaredPaths(source: string): string[] {
  return [...stripComments(source).matchAll(/["'`](\/[a-z0-9][a-z0-9\-/]*)/gi)].map((m) => m[1]);
}

test("no module outside the route tables declares a URL path for a Stockbit route", () => {
  // Catches the shape the M0 refactor removed: a call site holding its own path string, which is how
  // an off-table route reaches the wire even with the bearer correctly centralized. The route files
  // are excluded because declaring paths is precisely their job, and they issue nothing.
  const offenders: string[] = [];
  const routePaths = Object.values(ROUTES).map((route) => route.template.split("/")[1]);
  for (const file of sourceFiles(SRC)) {
    if (file === TRANSPORT || file.startsWith(ROUTE_DIR)) continue;
    for (const path of declaredPaths(readFileSync(file, "utf8"))) {
      if (routePaths.includes(path.split("/")[1])) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${path}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "declare the path in src/http/routes/, not at the call site");
});

test("the path guard reads code, not prose (negative control)", () => {
  // Both halves matter. Without the first this guard could be silently disarmed by the comment
  // stripper; without the second, documenting an endpoint where it is used becomes a test failure,
  // which is how the comments end up saying less than they should.
  assert.deepEqual(declaredPaths('const url = "/portfolio/v2/list";'), ["/portfolio/v2/list"]);
  assert.deepEqual(declaredPaths('/** Reads `/portfolio/v2/list`. */\nconst x = 1;'), []);
  assert.deepEqual(declaredPaths('// see `/order/v2/buy`\nconst y = 2;'), []);
});

test("AUTHENTICATED_ORIGIN still names the market-data host", () => {
  // A dozen call sites and tests say this and mean exodus. It is kept as an alias precisely so that
  // adding two more hosts did not silently repoint them.
  assert.equal(AUTHENTICATED_ORIGIN, ORIGINS.exodus);
  assert.notEqual(ORIGINS.exodus, ORIGINS.carina);
  assert.notEqual(ORIGINS.carina, ORIGINS.sekuritas);
});
