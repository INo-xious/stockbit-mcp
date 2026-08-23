/**
 * Fundamentals, valuation and analyst ratings.
 *
 * Every assertion here reads the URL production actually produced out of `seenUrls`. Asserting on
 * the helper that builds the params would prove nothing: a mutation that replaced a call site with a
 * stale inline object once left this whole suite green.
 *
 * The routes are unverified against the live API, so the projection tests use bodies shaped the way
 * this API shapes things elsewhere ({raw}/{value} wrappers, thousands separators) rather than the
 * way a schema would like them to be.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-fundamentals-"));

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { StockbitError } from "../src/http/errors.ts";
import {
  extractReadings,
  getAnalystRatings,
  getEarnings,
  getEntitlements,
  getFundachart,
  getPeerComparison,
  getSeasonality,
} from "../src/core/fundamentals.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

const realFetch = globalThis.fetch;
const seenUrls: string[] = [];

/** Substring → canned response. Longest key wins, so a sub-path cannot shadow its parent. */
const replies = new Map<string, { status: number; body: unknown }>();

function reply(match: string, body: unknown, status = 200): void {
  replies.set(match, { status, body });
}

/** Every non-refresh URL requested since the last reset, as parsed URLs. */
function requested(substring: string): URL[] {
  return seenUrls.filter((u) => !u.includes("/login/refresh") && u.includes(substring)).map((u) => new URL(u));
}

/** Exactly one request matched `substring`; return it. */
function onlyRequest(substring: string): URL {
  const hits = requested(substring);
  assert.equal(hits.length, 1, `expected exactly one request to ${substring}, saw ${hits.length}`);
  return hits[0];
}

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.includes("/login/refresh")) {
      return new Response(JSON.stringify({ data: { access_token: farFutureJwt() } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const key = [...replies.keys()].sort((a, b) => b.length - a.length).find((k) => u.includes(k));
    if (key === undefined) return new Response("not found", { status: 404 });
    const canned = replies.get(key)!;
    return new Response(JSON.stringify(canned.body), {
      status: canned.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

beforeEach(() => {
  clearCache();
  seenUrls.length = 0;
  replies.clear();
});

/* ---------------------------------- seasonality ---------------------------------- */

const SEASONALITY_BODY = {
  data: {
    symbol: "BBRI",
    months: [
      { month: "Jan", average_return: 1.24, win_rate: 0.7 },
      { month: "Feb", average_return: -0.4, win_rate: 0.4 },
    ],
  },
};

test("WIRE: seasonality sends the symbol as a path segment and both query parameters", async () => {
  reply("/company-price-feed/seasonality/", SEASONALITY_BODY);
  await getSeasonality("bbri", 2024, 5);

  const url = onlyRequest("/company-price-feed/seasonality/");
  assert.equal(url.pathname, "/company-price-feed/seasonality/BBRI");
  assert.equal(url.searchParams.get("year"), "2024");
  assert.equal(url.searchParams.get("back_year"), "5");
});

test("WIRE: an omitted back_year is absent from the query, and year defaults to this year", async () => {
  reply("/company-price-feed/seasonality/", SEASONALITY_BODY);
  await getSeasonality("BBRI");

  const url = onlyRequest("/company-price-feed/seasonality/");
  // Absent, not empty: `back_year=` is a different request from no back_year at all.
  assert.equal(url.searchParams.has("back_year"), false);
  // The endpoint 400s without a year, so one is always sent.
  assert.equal(url.searchParams.get("year"), String(new Date().getFullYear()));
});

test("seasonality returns the payload unprojected and echoes what it sent", async () => {
  reply("/company-price-feed/seasonality/", SEASONALITY_BODY);
  const result = await getSeasonality("BBRI", 2024, 5);

  assert.equal(result.symbol, "BBRI");
  assert.equal(result.year, 2024);
  assert.equal(result.backYear, 5);
  assert.deepEqual(result.data, SEASONALITY_BODY.data);
});

test("seasonality with a null data member returns null rather than throwing", async () => {
  reply("/company-price-feed/seasonality/", { data: null });
  const result = await getSeasonality("BBRI", 2024);
  assert.equal(result.data, null);
  // And the key the caller did not supply is not invented.
  assert.equal("backYear" in result, false);
});

test("an out-of-range seasonality year is rejected before any request is built", async () => {
  reply("/company-price-feed/seasonality/", SEASONALITY_BODY);
  await assert.rejects(
    () => getSeasonality("BBRI", 1899),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  await assert.rejects(
    () => getSeasonality("BBRI", 2024, 0),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(requested("/company-price-feed/seasonality/").length, 0, "a rejected value must not reach the wire");
});

test("the seasonality cache key distinguishes back_year, and repeats hit the cache", async () => {
  reply("/company-price-feed/seasonality/", SEASONALITY_BODY);
  await getSeasonality("BBRI", 2024, 5);
  await getSeasonality("BBRI", 2024, 5);
  assert.equal(requested("/company-price-feed/seasonality/").length, 1, "the repeat should have been cached");

  await getSeasonality("BBRI", 2024, 10);
  const hits = requested("/company-price-feed/seasonality/");
  assert.equal(hits.length, 2, "a different back_year is a different question");
  assert.equal(hits[1].searchParams.get("back_year"), "10");
});

/* ------------------------------------ earnings ------------------------------------ */

const EARNINGS_BODY = { data: { result: [{ symbol: "BBRI", eps_actual: 120, eps_estimate: 115 }], total: 1 } };

test("WIRE: earnings sends every supplied parameter, with order lower-cased", async () => {
  reply("/earnings", EARNINGS_BODY);
  await getEarnings({
    filter: " beat ",
    search: "bank",
    quarter: 2,
    year: 2026,
    sortColumn: 1,
    order: "DESC",
    page: 3,
  });

  const q = onlyRequest("/earnings").searchParams;
  assert.equal(q.get("filter"), "beat", "free text is trimmed before it is sent");
  assert.equal(q.get("search"), "bank");
  assert.equal(q.get("quarter"), "2");
  assert.equal(q.get("year"), "2026");
  assert.equal(q.get("sort_column"), "1");
  assert.equal(q.get("order"), "desc");
  assert.equal(q.get("page"), "3");
});

test("WIRE: earnings with no arguments sends no query string at all", async () => {
  reply("/earnings", EARNINGS_BODY);
  const result = await getEarnings();

  const url = onlyRequest("/earnings");
  assert.equal(url.pathname, "/earnings");
  // Stockbit's defaults are Stockbit's; this module must not smuggle in an empty quarter or page.
  assert.equal(url.search, "", `unexpected query string ${url.search}`);
  assert.deepEqual(result.query, {});
  assert.deepEqual(result.data, EARNINGS_BODY.data);
});

test("bad earnings arguments are rejected before any request is built", async () => {
  reply("/earnings", EARNINGS_BODY);
  const rejected: Array<() => Promise<unknown>> = [
    () => getEarnings({ quarter: 5 }),
    () => getEarnings({ quarter: 1.5 }),
    () => getEarnings({ page: 0 }),
    () => getEarnings({ year: 1899 }),
    () => getEarnings({ search: "   " }),
    () => getEarnings({ order: "sideways" }),
  ];
  for (const call of rejected) {
    await assert.rejects(call, (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param");
  }
  assert.equal(requested("/earnings").length, 0, "a rejected value must not reach the wire");
});

test("the earnings cache key carries every argument", async () => {
  reply("/earnings", EARNINGS_BODY);
  await getEarnings({ page: 1 });
  await getEarnings({ page: 1 });
  assert.equal(requested("/earnings").length, 1, "the repeat should have been cached");

  // The bug this guards is in the repo's history: a key that ignored an argument served page 1 to a
  // caller who asked for page 4.
  await getEarnings({ page: 4 });
  const hits = requested("/earnings");
  assert.equal(hits.length, 2);
  assert.equal(hits[1].searchParams.get("page"), "4");
});

/* -------------------------------- analyst ratings -------------------------------- */

const RATINGS_BODY = { data: { ratings: [{ analyst: "Mandiri Sekuritas", rating: "BUY", target_price: 5600 }] } };
const CONSENSUS_BODY = { data: { buy: 12, hold: 3, sell: 0, target_price: { raw: 5400, formatted: "5,400" } } };

test("WIRE: analyst_ratings calls both the ratings and the consensus path", async () => {
  reply("/analyst-ratings/BBRI", RATINGS_BODY);
  reply("/analyst-ratings/BBRI/consensus", CONSENSUS_BODY);
  const result = await getAnalystRatings("bbri");

  const paths = requested("/analyst-ratings/").map((u) => u.pathname).sort();
  assert.deepEqual(paths, ["/analyst-ratings/BBRI", "/analyst-ratings/BBRI/consensus"]);
  assert.deepEqual(result.ratings, RATINGS_BODY.data);
  assert.deepEqual(result.consensus, CONSENSUS_BODY.data);
  assert.deepEqual(result.failed, []);
});

test("an empty ratings payload is a normal answer, not an error", async () => {
  reply("/analyst-ratings/GOTO", { data: null });
  reply("/analyst-ratings/GOTO/consensus", { data: [] });
  const result = await getAnalystRatings("GOTO");

  assert.equal(result.ratings, null);
  assert.deepEqual(result.consensus, []);
  assert.deepEqual(result.failed, [], "an empty list is not a failure");
});

test("one failed half is reported as failed, not as empty", async () => {
  reply("/analyst-ratings/BBRI", RATINGS_BODY);
  reply("/analyst-ratings/BBRI/consensus", { message: "not found" }, 404);
  const result = await getAnalystRatings("BBRI");

  assert.deepEqual(result.ratings, RATINGS_BODY.data);
  // Absent rather than null: "we could not ask" must not look like "there is no consensus".
  assert.equal("consensus" in result, false);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].side, "analyst consensus");
  assert.equal(result.failed[0].kind, "not_found");
  assert.ok(result.notes.some((n) => n.includes("analyst consensus")));
});

test("when BOTH halves fail the original error is thrown, not an empty success", async () => {
  reply("/analyst-ratings/NONE", { message: "not found" }, 404);
  reply("/analyst-ratings/NONE/consensus", { message: "not found" }, 404);
  await assert.rejects(
    () => getAnalystRatings("NONE"),
    (err: unknown) => err instanceof StockbitError && err.kind === "not_found",
  );
});

/* -------------------------------- peer comparison -------------------------------- */

/** Shaped the way this API shapes things: {raw} wrappers, thousands separators, an empty string. */
const RATIOS_BODY = {
  data: {
    symbol: "BBRI",
    ratios: [
      { name: "Current PE Ratio (TTM)", value: "8.12" },
      { name: "Current Price to Book Value", value: { raw: 1.94, formatted: "1.94x" } },
      { name: "Market Cap", value: "1,234,567" },
      { name: "Return on Equity (TTM)", value: "" },
      { name: "Debt to Equity Ratio (Quarter)", value: 0.31 },
      { name: "Dividend Yield", value: 5.1 },
    ],
    extras: [{ label: "Dividend Yield", value: 5.3 }],
    peers: [{ symbol: "BMRI", ratios: [{ name: "Current PE Ratio (TTM)", value: 9.4 }] }],
  },
};

const INDUSTRIES_BODY = {
  data: {
    industry: "Banks",
    metrics: [
      { name: "Current PE Ratio (TTM)", value: 12.6 },
      { name: "current price to book value", value: { raw: 2.1 } },
      { name: "Market Cap", value: "9,876,543" },
      { name: "Dividend Yield", value: 4.2 },
      { name: "Constituents", value: 47 },
    ],
  },
};

test("WIRE: peer_comparison calls ratios and industries, and NOT the catalogue routes", async () => {
  reply("/comparison/BBRI/ratios", RATIOS_BODY);
  reply("/comparison/BBRI/industries", INDUSTRIES_BODY);
  await getPeerComparison("bbri");

  assert.equal(onlyRequest("/comparison/BBRI/ratios").pathname, "/comparison/BBRI/ratios");
  assert.equal(onlyRequest("/comparison/BBRI/industries").pathname, "/comparison/BBRI/industries");
  // The catalogues are two extra requests that answer a different question; they stay off by default.
  assert.equal(requested("/comparison/metrics").length, 0);
  assert.equal(requested("/comparison/templates").length, 0);
  assert.equal(requested("/comparison/BBRI/templates").length, 0);
});

test("peer_comparison pairs the symbol's ratio with its industry counterpart, unambiguously", async () => {
  reply("/comparison/BBRI/ratios", RATIOS_BODY);
  reply("/comparison/BBRI/industries", INDUSTRIES_BODY);
  const result = await getPeerComparison("BBRI");

  const per = result.paired.find((p) => p.metric === "Current PE Ratio (TTM)");
  assert.ok(per, "the PE ratio should have paired");
  assert.equal(per.symbolValue, 8.12);
  assert.equal(per.industryValue, 12.6);
  // Paths are relative to the payload under `raw`, which is the unwrapped `data` member.
  assert.equal(per.symbolPath.startsWith("ratios["), true, `path was ${per.symbolPath}`);

  // Case and punctuation differ between the two sides; the match is on letters and digits.
  const pbv = result.paired.find((p) => p.metric === "Current Price to Book Value");
  assert.ok(pbv);
  assert.equal(pbv.industryMetric, "current price to book value");
  assert.equal(pbv.symbolValue, 1.94, "a {raw} wrapper is read");
  assert.equal(pbv.industryValue, 2.1);

  const cap = result.paired.find((p) => p.metric === "Market Cap");
  assert.ok(cap);
  assert.equal(cap.symbolValue, 1234567, "thousands separators are stripped");
  assert.equal(cap.industryValue, 9876543);

  // A metric with no industry counterpart is not silently dropped.
  assert.ok(result.symbolOnly.some((r) => r.metric === "Debt to Equity Ratio (Quarter)"));
  assert.ok(result.industryOnly.some((r) => r.metric === "Constituents"));

  // An empty string is absent, never a free zero.
  const roe = result.symbolOnly.find((r) => r.metric === "Return on Equity (TTM)");
  assert.ok(roe);
  assert.equal(roe.value, null);

  // The peer set is attributed and kept out of the pairing.
  assert.equal(result.otherCompanies.length, 1);
  assert.equal(result.otherCompanies[0].owner, "BMRI");
  assert.equal(result.paired.some((p) => p.symbolValue === 9.4), false, "a peer's PE must not pair as the subject's");

  // Two readings share a label on the symbol side, so no pair is invented.
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.ambiguous[0].metric, "Dividend Yield");
  assert.equal(result.ambiguous[0].symbolReadings.length, 2);
  assert.equal(result.ambiguous[0].industryReadings.length, 1);
  assert.equal(result.paired.some((p) => p.metric === "Dividend Yield"), false);

  // Every reading says which wire key it came from, so a pair is checkable against `raw`.
  assert.equal(result.symbolOnly[0].labelKey, "name");
  assert.deepEqual(result.raw?.ratios, RATIOS_BODY.data);
  assert.deepEqual(result.raw?.industries, INDUSTRIES_BODY.data);

  // No verdict, by design.
  assert.equal("verdict" in result, false);
  assert.ok(result.notes.some((n) => n.includes("No verdict is computed")));
});

test("peer_comparison with empty payloads returns empty pairings and says why", async () => {
  reply("/comparison/EMPT/ratios", { data: null });
  reply("/comparison/EMPT/industries", { data: [] });
  const result = await getPeerComparison("EMPT");

  assert.deepEqual(result.paired, []);
  assert.deepEqual(result.symbolOnly, []);
  assert.deepEqual(result.industryOnly, []);
  assert.deepEqual(result.failed, []);
  assert.ok(result.notes.some((n) => n.includes("No metric label appeared on both sides")));
});

test("a failed industries half leaves the ratios half readable and names the loss", async () => {
  reply("/comparison/BBRI/ratios", RATIOS_BODY);
  reply("/comparison/BBRI/industries", { message: "not found" }, 404);
  const result = await getPeerComparison("BBRI");

  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].side, "comparison industries");
  assert.equal(result.industryOnly.length, 0);
  assert.equal("industries" in (result.raw ?? {}), false);
  assert.ok(result.notes.some((n) => n.includes("nothing here is a peer-relative reading")));
});

test("include_raw:false drops raw without poisoning the cached result", async () => {
  reply("/comparison/BBRI/ratios", RATIOS_BODY);
  reply("/comparison/BBRI/industries", INDUSTRIES_BODY);

  const lean = await getPeerComparison("BBRI", { includeRaw: false });
  assert.equal("raw" in lean, false);
  assert.ok(lean.paired.length > 0, "dropping raw must not drop the pairing");

  const full = await getPeerComparison("BBRI");
  assert.deepEqual(full.raw?.ratios, RATIOS_BODY.data, "the cached object must survive the lean variant");
  assert.equal(requested("/comparison/BBRI/ratios").length, 1, "both calls share one cache entry");
});

test("include_catalogues fetches the three catalogue routes, under their own cache key", async () => {
  reply("/comparison/BBRI/ratios", RATIOS_BODY);
  reply("/comparison/BBRI/industries", INDUSTRIES_BODY);
  reply("/comparison/metrics", { data: [{ id: 1, name: "PER" }] });
  reply("/comparison/templates", { data: [] });
  reply("/comparison/BBRI/templates", { data: [{ id: 9, name: "Big banks" }] });

  const result = await getPeerComparison("BBRI", { includeCatalogues: true });
  assert.equal(onlyRequest("/comparison/metrics").pathname, "/comparison/metrics");
  assert.equal(onlyRequest("/comparison/templates").pathname, "/comparison/templates");
  assert.equal(onlyRequest("/comparison/BBRI/templates").pathname, "/comparison/BBRI/templates");
  assert.deepEqual(result.catalogues?.metrics, [{ id: 1, name: "PER" }]);
  assert.deepEqual(result.catalogues?.templates, []);
  assert.deepEqual(result.catalogues?.failed, []);

  // The flag is not part of the main cache key, so it must not be able to serve a catalogue-less
  // answer to a caller that asked for one, or vice versa.
  const without = await getPeerComparison("BBRI");
  assert.equal("catalogues" in without, false);
  assert.equal(requested("/comparison/BBRI/ratios").length, 1);
});

test("the peer_comparison cache key is per symbol", async () => {
  reply("/comparison/BBRI/ratios", RATIOS_BODY);
  reply("/comparison/BBRI/industries", INDUSTRIES_BODY);
  reply("/comparison/BMRI/ratios", RATIOS_BODY);
  reply("/comparison/BMRI/industries", INDUSTRIES_BODY);

  await getPeerComparison("BBRI");
  await getPeerComparison("BMRI");
  assert.equal(requested("/comparison/BBRI/ratios").length, 1);
  assert.equal(requested("/comparison/BMRI/ratios").length, 1);
});

test("extractReadings records the wire keys it matched and never substitutes a zero", () => {
  const readings = extractReadings({
    rows: [
      { metric_name: "PER", raw: "12,5" },
      { title: "Nothing", value: null },
      { name: "Blank", value: "  " },
      { name: "NotAMetric" },
    ],
  });

  const per = readings.find((r) => r.metric === "PER");
  assert.ok(per);
  assert.equal(per.labelKey, "metric_name");
  assert.equal(per.valueKey, "raw");
  assert.equal(per.value, 125, "commas are stripped before parsing");
  assert.equal(per.path, "rows[0]");

  assert.equal(readings.find((r) => r.metric === "Nothing")?.value, null);
  assert.equal(readings.find((r) => r.metric === "Blank")?.value, null);
  // A label with no value key at all is not a reading.
  assert.equal(readings.some((r) => r.metric === "NotAMetric"), false);
});

/* ------------------------------------ fundachart ------------------------------------ */

test("WIRE: fundachart sends metric_name on the metric list and nothing on the templates", async () => {
  reply("/fundachart/metrics", { data: [{ id: 1, name: "Revenue" }] });
  reply("/fundachart/templates", { data: [] });
  const result = await getFundachart();

  const metrics = onlyRequest("/fundachart/metrics");
  assert.equal(metrics.pathname, "/fundachart/metrics");
  assert.equal(metrics.searchParams.get("metric_name"), "fundachart");

  const templates = onlyRequest("/fundachart/templates");
  assert.equal(templates.search, "", `unexpected query string ${templates.search}`);

  assert.deepEqual(result.metrics, [{ id: 1, name: "Revenue" }]);
  assert.deepEqual(result.templates, []);
  assert.deepEqual(result.failed, []);
});

test("fundachart reports a failed half rather than an empty one", async () => {
  reply("/fundachart/metrics", { data: [{ id: 1 }] });
  reply("/fundachart/templates", { message: "nope" }, 403);
  const result = await getFundachart();

  assert.equal("templates" in result, false);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].kind, "auth");
});

/* ----------------------------------- entitlements ----------------------------------- */

const ELIGIBILITY_BODY = {
  features: [
    { feature: "PAYWALL_FEATURE_CHARTBIT", is_eligible: true },
    { feature: "PAYWALL_FEATURE_KEYSTATS", is_eligible: false },
    { feature: "PAYWALL_FEATURE_FINANCIALS" },
  ],
  company: { company: "BBRI", is_eligible: true },
};

test("WIRE: entitlements repeats the features parameter and sends the company", async () => {
  reply("/paywall/eligibility/check", ELIGIBILITY_BODY);
  await getEntitlements(["chartbit", "PAYWALL_FEATURE_KEYSTATS"], "bbri");

  const url = onlyRequest("/paywall/eligibility/check");
  assert.equal(url.pathname, "/paywall/eligibility/check");
  // Repeated keys, not a comma-joined value: that is the form the transport's array support exists
  // for, and the form the broker-activity route proved is required elsewhere on this API.
  assert.deepEqual(url.searchParams.getAll("features"), [
    "PAYWALL_FEATURE_CHARTBIT",
    "PAYWALL_FEATURE_KEYSTATS",
  ]);
  assert.equal(url.searchParams.get("company"), "BBRI");
});

test("WIRE: with no arguments the five known features are asked about and no company is sent", async () => {
  reply("/paywall/eligibility/check", ELIGIBILITY_BODY);
  await getEntitlements();

  const url = onlyRequest("/paywall/eligibility/check");
  assert.deepEqual(url.searchParams.getAll("features"), [
    "PAYWALL_FEATURE_CHARTBIT",
    "PAYWALL_FEATURE_KEYSTATS",
    "PAYWALL_FEATURE_FINANCIALS",
    "PAYWALL_FEATURE_ANALYSIS",
    "PAYWALL_FEATURE_FUNDACHART",
  ]);
  assert.equal(url.searchParams.has("company"), false);
});

test("entitlements distinguishes ineligible from unanswered from no-verdict", async () => {
  reply("/paywall/eligibility/check", ELIGIBILITY_BODY);
  const result = await getEntitlements(
    ["CHARTBIT", "KEYSTATS", "FINANCIALS", "ANALYSIS"],
    "BBRI",
  );

  const byName = new Map(result.features.map((f) => [f.feature, f.eligible]));
  assert.equal(byName.get("PAYWALL_FEATURE_CHARTBIT"), true);
  assert.equal(byName.get("PAYWALL_FEATURE_KEYSTATS"), false);
  // A row with no is_eligible is unknown, not blocked.
  assert.equal(byName.get("PAYWALL_FEATURE_FINANCIALS"), null);
  // A feature the response never mentioned is unknown, not blocked.
  assert.deepEqual(result.unanswered, ["PAYWALL_FEATURE_ANALYSIS"]);
  assert.deepEqual(result.unrequested, []);
  assert.deepEqual(result.company, { symbol: "BBRI", eligible: true });
  assert.ok(result.notes.some((n) => n.includes("PAYWALL_FEATURE_ANALYSIS")));
});

test("entitlements survives a response with no company verdict", async () => {
  reply("/paywall/eligibility/check", { features: [{ feature: "PAYWALL_FEATURE_CHARTBIT", is_eligible: true }] });
  const result = await getEntitlements(["CHARTBIT"]);

  assert.equal("company" in result, false);
  assert.deepEqual(result.unanswered, []);
  assert.ok(result.notes.some((n) => n.includes("No company was supplied")));
});

test("a malformed feature name is rejected before any request is built", async () => {
  reply("/paywall/eligibility/check", ELIGIBILITY_BODY);
  await assert.rejects(
    () => getEntitlements(["chart bit!"]),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(requested("/paywall/eligibility/check").length, 0, "a rejected value must not reach the wire");
});

test("the entitlements cache key distinguishes the feature set and the company", async () => {
  reply("/paywall/eligibility/check", ELIGIBILITY_BODY);
  await getEntitlements(["CHARTBIT"], "BBRI");
  await getEntitlements(["CHARTBIT"], "BBRI");
  assert.equal(requested("/paywall/eligibility/check").length, 1, "the repeat should have been cached");

  await getEntitlements(["CHARTBIT"], "BMRI");
  await getEntitlements(["KEYSTATS"], "BBRI");
  assert.equal(requested("/paywall/eligibility/check").length, 3);
});
