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
    "GET /stream/v3/symbol/:symbol",
    "POST /login/refresh",
  ]);
});

test("POST /login/refresh is the only permitted write", () => {
  const writes = Object.entries(ROUTES).filter(([, route]) => route.method !== "GET");
  assert.deepEqual(
    writes.map(([name]) => name),
    ["loginRefresh"],
    "a second non-GET route is a change of posture, not a feature (ADR-0002)",
  );
  assert.equal(buildUrl("loginRefresh"), `${AUTHENTICATED_ORIGIN}/login/refresh`);
});

test("every declared route builds a URL the policy accepts", () => {
  for (const [name, route] of Object.entries(ROUTES)) {
    const segments = { symbol: "BBRI", moverType: "topGainer" };
    const url = buildUrl(name as keyof typeof ROUTES, segments);
    assert.ok(
      isPermitted(route.method, url),
      `${route.method} ${url} was built by the transport but rejected by its own policy`,
    );
  }
});

test("Chartbit is readable and NOT writable", () => {
  // ADR-0002 draws its line at mutation, not at the path prefix: reading the user's own markup is
  // in scope and writing it is the posture change. So the assertion is not "nothing under
  // /chartbit" — it is that every declared Chartbit route is a GET.
  const chartbit = Object.entries(ROUTES).filter(([, r]) => r.template.startsWith("/chartbit/"));
  assert.ok(chartbit.length > 0, "the Chartbit reads should be declared");
  for (const [name, route] of chartbit) {
    assert.equal(route.method, "GET", `${name} writes to Chartbit — that supersedes ADR-0002`);
  }
});

test("no Chartbit WRITE is reachable, whatever the method", () => {
  // The declared reads must not make the write paths reachable as a side effect. A POST to the very
  // path we GET is the case that matters: it would overwrite the user's saved chart.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const path of ["/chartbit/BBRI/layout", "/chartbit/initial/BBRI", "/chartbit/layouts", "/chartbit/BBRI/drawings"]) {
      assert.equal(isPermitted(method, `${AUTHENTICATED_ORIGIN}${path}`), false, `${method} ${path} must be rejected`);
    }
  }
  // And paths we never declared stay closed to GET too.
  for (const path of ["/chartbit/layouts", "/chartbit/1.1/charts", "/chartbit/BBRI/drawings", "/chartbit/BBRI/price/daily"]) {
    assert.equal(isPermitted("GET", `${AUTHENTICATED_ORIGIN}${path}`), false, `GET ${path} must be rejected`);
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
