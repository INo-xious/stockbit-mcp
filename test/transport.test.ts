/**
 * The ADR-0002 boundary tests.
 *
 * Two halves, and the second is the one that matters. A permitted-route test proves the policy
 * accepts the right list; it does not prove every request goes through the policy. Before M0,
 * `src/auth/session.ts` called `fetch` with a bearer outside `src/http/` entirely — a route test
 * would have passed straight over that hole. So the bypass guard below reads the source tree and
 * fails if any module other than the transport builds a credentialed request.
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
  ROUTES,
  authenticatedRequest,
  buildUrl,
  isPermitted,
  permittedRequests,
  resolvePath,
} from "../src/http/transport.ts";
import { StockbitError } from "../src/http/errors.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/* --------------------------- the permitted set, asserted --------------------------- */

test("the permitted request set is exactly this list", () => {
  // Locked deliberately: adding a route must show up as a change to this assertion, so a new
  // authenticated request shape cannot land without a reviewer seeing it.
  assert.deepEqual(permittedRequests(), [
    // Chartbit READS only. ADR-0002 rejects Chartbit writes and keeps its reads in scope; the test
    // below asserts every declared Chartbit route is a GET and that no write path is reachable.
    "GET /chartbit/:symbol/layout",
    "GET /chartbit/initial/:symbol",
    "GET /chartbit/template",
    "GET /chartbit/version",
    "GET /company-price-feed/historical/summary/:symbol",
    "GET /company-price-feed/price-performance/:symbol",
    "GET /company-price-feed/prices/close",
    "GET /company-price-feed/v2/orderbook/companies/:symbol",
    "GET /emitten/:symbol/info",
    "GET /emitten/hotlist/:moverType",
    "GET /emitten/sectors",
    "GET /emitten/trending",
    "GET /findata-view/company/financial",
    "GET /keystats/:symbol",
    "GET /keystats/ratio/v1/:symbol",
    "GET /marketdetectors/:symbol",
    // Broker Distribution. Served by the order-trade service and takes its symbol as a query
    // parameter rather than a path segment, so there is no `:symbol` here.
    "GET /order-trade/broker/distribution",
    "GET /paywall/eligibility/check",
    // The screener, all READS. Running a saved screen is a plain GET — an earlier research pass
    // assumed a POST and concluded this needed its own ADR; it does not. Creating or saving a
    // screen is account state and is deliberately absent.
    "GET /screener/metric",
    "GET /screener/preset",
    "GET /screener/templates",
    "GET /screener/templates/:templateId",
    "GET /screener/universe",
    "GET /stream/v3/symbol/:symbol",
    "GET /user-setting/configurations",
    // The user's own watchlists. Reads only: adding to or removing from a list is account state.
    "GET /watchlist",
    "GET /watchlist/:watchlistId",
    "POST /chartbit/:symbol/layout",
    "POST /chartbit/template",
    "POST /login/refresh",
  ]);
});

test("the permitted writes are exactly these three", () => {
  // This assertion is the tripwire. Before ADR-0003 it read `["loginRefresh"]`, and editing it is
  // the deliberate act that lets a mutation into the project — which is what it is for. A write
  // beyond session refresh and chart persistence needs the argument made again, not a quiet edit.
  const writes = Object.entries(ROUTES).filter(([, route]) => route.method !== "GET");
  assert.deepEqual(
    writes.map(([name]) => name).sort(),
    ["chartbitSaveLayout", "chartbitSaveTemplate", "loginRefresh"],
    "a new non-GET route is a change of posture, not a feature (ADR-0002, ADR-0003)",
  );
  assert.equal(buildUrl("loginRefresh"), `${AUTHENTICATED_ORIGIN}/login/refresh`);
  assert.equal(buildUrl("chartbitSaveLayout", { symbol: "BBRI" }), `${AUTHENTICATED_ORIGIN}/chartbit/BBRI/layout`);
  assert.equal(buildUrl("chartbitSaveTemplate"), `${AUTHENTICATED_ORIGIN}/chartbit/template`);
});

test("every write touches ONLY the session or the user's chart", () => {
  // The property that survived ADR-0003: mutation is confined to chart persistence. Nothing here
  // may post to a portfolio, an order, a watchlist, a profile, or the settings blob.
  const allowed = ["/login/refresh", "/chartbit/:symbol/layout", "/chartbit/template"];
  for (const [name, route] of Object.entries(ROUTES)) {
    if (route.method === "GET") continue;
    assert.ok(
      allowed.includes(route.template),
      `${name} (${route.method} ${route.template}) mutates something no ADR has approved`,
    );
  }
  // The settings blob holds the user's real chart configuration and is READ-ONLY here.
  assert.equal(isPermitted("POST", `${AUTHENTICATED_ORIGIN}/user-setting/configurations`), false);
  // Deleting a named layout destroys it; only creating one was approved.
  assert.equal(isPermitted("DELETE", `${AUTHENTICATED_ORIGIN}/chartbit/template/mine`), false);
});

test("every declared route builds a URL the policy accepts", () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    const segments = { symbol: "BBRI", moverType: "topGainer", watchlistId: "6252652", templateId: "5951939" };
    const url = buildUrl(name as keyof typeof ROUTES, segments);
    assert.ok(
      isPermitted(route.method, url),
      `${route.method} ${url} was built by the transport but rejected by its own policy`,
    );
  }
});

test("the ONLY writable Chartbit path is the layout, and only by POST", () => {
  // ADR-0003 opened exactly one door. Everything around it stays shut, including verbs on the very
  // path we now POST to — DELETE on a layout would destroy it rather than replace it.
  assert.equal(isPermitted("POST", `${AUTHENTICATED_ORIGIN}/chartbit/BBRI/layout`), true);

  for (const method of ["PUT", "PATCH", "DELETE"]) {
    assert.equal(
      isPermitted(method, `${AUTHENTICATED_ORIGIN}/chartbit/BBRI/layout`),
      false,
      `${method} on a layout is not what ADR-0003 approved`,
    );
  }
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    // `/chartbit/template` is deliberately absent here — its GET is permitted and its writes are
    // asserted separately below.
    for (const path of ["/chartbit/layouts", "/chartbit/1.1/charts", "/chartbit/BBRI/drawings"]) {
      assert.equal(isPermitted(method, `${AUTHENTICATED_ORIGIN}${path}`), false, `${method} ${path} must be rejected`);
    }
  }
  // The template LIST is readable; writing or deleting a template would mutate account data and has
  // no ADR behind it. Same for the settings blob, which holds the user's real chart configuration.
  assert.equal(isPermitted("GET", `${AUTHENTICATED_ORIGIN}/chartbit/template`), true);
  assert.equal(isPermitted("POST", `${AUTHENTICATED_ORIGIN}/chartbit/template`), true, "creating a named layout is approved");
  assert.equal(isPermitted("DELETE", `${AUTHENTICATED_ORIGIN}/chartbit/template/mine`), false, "deleting one is not");
  assert.equal(isPermitted("GET", `${AUTHENTICATED_ORIGIN}/user-setting/configurations`), true);
  assert.equal(isPermitted("POST", `${AUTHENTICATED_ORIGIN}/user-setting/configurations`), false);
});

test("a GET route refuses a body rather than silently dropping it", async () => {
  // A caller passing a body to a read has misunderstood something; hiding that would surface later
  // as data that is quietly wrong.
  await assert.rejects(
    () => authenticatedRequest("chartbitLayout", { token: "T", segments: { symbol: "BBRI" }, body: { x: 1 } }),
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
    await authenticatedRequest("chartbitSaveLayout", {
      token: "T",
      segments: { symbol: "BBRI" },
      body: { content: "{}" },
    });
    assert.equal(seen?.method, "POST");
    assert.equal(seen?.body, JSON.stringify({ content: "{}" }));
    assert.equal(new Headers(seen?.headers).get("content-type"), "application/json");
    // A redirected POST would apply the mutation at an origin the policy never approved.
    assert.equal(seen?.redirect, "manual");
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ------------------------------- what the policy rejects ------------------------------- */

test("the bearer never leaves the approved origin", () => {
  const offOrigin = [
    "https://evil.test/emitten/BBRI/info",
    // Suffix and prefix attacks on a hostname compare that was not origin-parsed.
    "https://exodus.stockbit.com.evil.test/emitten/BBRI/info",
    "https://notexodus.stockbit.com/emitten/BBRI/info",
    "https://stockbit.com/emitten/BBRI/info",
    // Scheme and port are part of the origin.
    "http://exodus.stockbit.com/emitten/BBRI/info",
    "https://exodus.stockbit.com:8443/emitten/BBRI/info",
    // Userinfo pointing the real host at an attacker's.
    "https://exodus.stockbit.com@evil.test/emitten/BBRI/info",
    // Right origin, but credentials embedded in the URL.
    "https://user:pass@exodus.stockbit.com/emitten/BBRI/info",
    "https://user@exodus.stockbit.com/keystats/BBRI",
    "not-a-url",
  ];
  for (const url of offOrigin) {
    assert.equal(isPermitted("GET", url), false, `${url} must not receive the bearer`);
  }
});

test("method is checked per path, not globally", () => {
  // The refresh path is POST-only and the read paths are GET-only; neither generalizes.
  assert.equal(isPermitted("GET", `${AUTHENTICATED_ORIGIN}/login/refresh`), false);
  assert.equal(isPermitted("POST", `${AUTHENTICATED_ORIGIN}/emitten/BBRI/info`), false);
  assert.equal(isPermitted("DELETE", `${AUTHENTICATED_ORIGIN}/emitten/BBRI/info`), false);
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
    assert.equal(isPermitted("GET", `${AUTHENTICATED_ORIGIN}${path}`), false, `${path} must be rejected`);
  }
});

test("a dynamic segment cannot widen the path", () => {
  // Each of these is a path the *table* would otherwise seem to allow at `/keystats/:symbol`.
  const hostile = [
    `${AUTHENTICATED_ORIGIN}/keystats/BBRI/../../login/refresh`,
    `${AUTHENTICATED_ORIGIN}/keystats/BBRI%2F..%2F..%2Flogin%2Frefresh`,
    `${AUTHENTICATED_ORIGIN}/keystats/..`,
    `${AUTHENTICATED_ORIGIN}/keystats/BBRI?x=1#/../y`.replace("?x=1#/../y", "/%2e%2e"),
    `${AUTHENTICATED_ORIGIN}/keystats/bbri`, // lowercase never reaches the wire
    `${AUTHENTICATED_ORIGIN}/keystats/`,
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
  //
  // The friendly name stays in the schema; only the wire spelling is asserted here.
  assert.equal(new URL(buildUrl("emittenHotlist", { moverType: "topGainer" })).pathname, "/emitten/hotlist/topgainer");
  assert.equal(new URL(buildUrl("emittenHotlist", { moverType: "topLoser" })).pathname, "/emitten/hotlist/toploser");
  assert.equal(
    new URL(buildUrl("emittenHotlist", { moverType: "mostActive" })).pathname,
    "/emitten/hotlist/mostactive",
  );

  // `isPermitted` re-validates the path it judges, so the validator has to accept its own output.
  // Without that, the policy check would reject every hotlist URL the builder produced.
  for (const wire of ["topgainer", "toploser", "mostactive"]) {
    assert.equal(isPermitted("GET", `https://exodus.stockbit.com/emitten/hotlist/${wire}`), true, wire);
  }
});

test("query params are appended, and null/undefined dropped", () => {
  const url = new URL(
    buildUrl("pricesClose", undefined, { symbol: "BBRI", interval: 1, skip: null, gone: undefined }),
  );
  assert.equal(url.pathname, "/company-price-feed/prices/close");
  assert.equal(url.searchParams.get("symbol"), "BBRI");
  assert.equal(url.searchParams.get("interval"), "1");
  assert.equal(url.searchParams.has("skip"), false);
  assert.equal(url.searchParams.has("gone"), false);
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
    // Inspect each fetch call's first argument. `src/auth/login.ts` legitimately fetches the local
    // Chrome DevTools endpoint on 127.0.0.1 with no credential; that must keep passing.
    for (const match of source.matchAll(/\bfetch\s*\(([^,)]*)/g)) {
      const target = match[1];
      if (/stockbit\.com|HOSTS\.|AUTH\.refreshUrl|AUTHENTICATED_ORIGIN/.test(target)) {
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
  assert.ok(/["'`]\s*Bearer\s+\$\{/i.test(bearerBypass) || /authorization:\s*`Bearer/i.test(bearerBypass));
  assert.ok(
    [...fetchBypass.matchAll(/\bfetch\s*\(([^,)]*)/g)].some(([, target]) =>
      /stockbit\.com|HOSTS\.|AUTH\.refreshUrl|AUTHENTICATED_ORIGIN/.test(target),
    ),
  );
  // And that the allowed CDP call is not a false positive.
  const cdpCall = "const r = await fetch(`http://127.0.0.1:${port}/json/version`);";
  assert.ok(
    [...cdpCall.matchAll(/\bfetch\s*\(([^,)]*)/g)].every(
      ([, target]) => !/stockbit\.com|HOSTS\.|AUTH\.refreshUrl|AUTHENTICATED_ORIGIN/.test(target),
    ),
  );
});

test("no module outside the transport declares a URL path for a Stockbit route", () => {
  // Catches the shape this refactor removed: a call site holding its own path string, which is how
  // an off-table route reaches the wire even with the bearer correctly centralized.
  const offenders: string[] = [];
  const routePaths = Object.values(ROUTES).map((route) => route.template.split("/")[1]);
  for (const file of sourceFiles(SRC)) {
    if (file === TRANSPORT) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/["'`](\/[a-z0-9][a-z0-9\-/]*)/gi)) {
      const path = match[1];
      if (routePaths.includes(path.split("/")[1])) {
        offenders.push(`${file.slice(SRC.length + 1)}: ${path}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "declare the path in the transport's ROUTES table, not at the call site");
});
