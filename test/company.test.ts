/**
 * Company identity: profile, contact, subsidiaries, shareholders, classification, membership,
 * search, and the full info row `quote` narrows.
 *
 * None of these endpoints has been observed live, so the bodies below are shaped to be *plausible
 * and inconsistent with each other* on purpose — one wraps its rows in `data.result`, one in
 * `data.companies`, one under a key this code has never heard of, one is a bare array, and one is an
 * object with no array in it at all. That is the whole risk of wiring eleven unprobed routes: an
 * assumption about where the rows live turns a populated response into a confident empty list. The
 * assertions here are on the URL that actually went out and on `source`, which is the field that
 * tells "the endpoint said zero" apart from "this code could not find them".
 */
// Isolate the token store before importing anything that reads it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-company-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { StockbitError } from "../src/http/errors.ts";
import { registerCompanyTools } from "../src/tools/company.ts";
import type { Definer, ToolHandler } from "../src/tools/_define.ts";
import {
  CLASSIFICATION_SCOPES,
  INDEX_MEMBERS_MAX_LIMIT,
  SEARCH_VARIANTS,
  companyOverview,
  getClassification,
  getCompanyProfile,
  getContact,
  getIndexMembers,
  getSectorCompanies,
  getShareholders,
  getSubsidiaries,
  search,
} from "../src/core/company.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* --------------------------------- the fake wire --------------------------------- */

/** The quote row, with everything `getQuote` throws away still on it. */
const INFO = {
  data: {
    id: "59",
    symbol: "BBRI",
    name: "Bank Rakyat Indonesia (Persero) Tbk.",
    price: "3810",
    percentage: "0.26",
    orderbook: { bid: { price: "3800", volume: "1000" } },
    indexes: [{ code: "LQ45" }, { code: "IDX30" }],
    catalogs: [{ id: 3, name: "Bank" }],
    // Present-but-null and present-but-empty are different things, and both are exercised here.
    uma: null,
    notation: [],
    corp_action: { dividend: { ex_date: "2026-04-02" } },
    is_margin: true,
    day_trade_eligible: false,
    marginable_status: "MARGIN_ACTIVE",
  },
};

/**
 * Issue #37 REPORTS this shareholder shape; it is not a capture, and `emitten/{symbol}/profile`
 * has no recorded live row. A rounded magnitude string under an ambiguous unit, beside a clamped
 * percentage that disagrees with it — 3,242,500 of 40.69 B is about 0.0080%, not `<0.0001%`. Both
 * must survive byte-identical: the assertion below is what pins that nothing here is recomputed.
 */
const PROFILE = {
  data: {
    description: "Banking",
    listing_date: "2003-11-10",
    shareholder_director_commissioner: [{ name: "DIRECTOR ONE", value: "3.24 M", percentage: "<0.0001%" }],
  },
};
const CONTACT = { data: { address: "Jl. Jenderal Sudirman Kav 44-46", website: "bri.co.id" } };
const TYPED_INFO_COMPANY = { data: { emitten_type: "company", items: 42 } };
const TYPED_INFO_BANK = { data: { emitten_type: "bank", items: 51 } };
const FIN_ITEMS = { data: { result: [{ id: 1, name: "Revenue" }] } };

/** Rows under `data.result`, plus a sibling that must survive as `extra`. */
const SUBSIDIARIES = { data: { result: [{ name: "BRI Danareksa", ownership: "67%" }], total: 1 } };
/** An envelope with no array anywhere: the shape that must NOT read as "no subsidiaries". */
const SUBSIDIARIES_UNKNOWN = { data: { message: "not available", meta: {} } };
/** A genuine zero. */
const SUBSIDIARIES_EMPTY = { data: [] };

const SHAREHOLDER_TOKEN = { data: { data: { token: "sh-token-9f3" } } };
const SHAREHOLDERS = { data: { chart: [{ name: "Government", percentage: 53.19 }], total: 1 } };

/**
 * The shape this endpoint really answers with, read off a live account on 2026-09-01.
 *
 * Series, not rows — which is why `rows`/`source` report a miss on it — and note `timeframe` names
 * its values `year` while holding a MONTH COUNT. That trap is the reason `value_year` was validated
 * as a calendar year for as long as it was.
 */
const OWNERSHIP_CHART = {
  data: {
    last_update: "3 Aug 26",
    timeframe: [
      { year: "5 Bulan", value: 5 },
      { year: "1 Tahun", value: 12 },
    ],
    legend: [
      {
        color: "#8250a3",
        item_name: "Local",
        chart_data: [
          { date: "Jun 26", value: 72.59, unix_date: "1782752400" },
          { date: "Jul 26", value: 73.13, unix_date: "1785430800" },
        ],
      },
      {
        color: "#00ab6b",
        item_name: "Foreign",
        // A hole, to prove an unreadable figure is absent rather than zero.
        chart_data: [{ date: "Jun 26", value: 27.41, unix_date: "1782752400" }, { date: "Jul 26" }],
      },
    ],
  },
};

const CLASSIFICATION_TAXONOMY = { data: [{ id: 1, name: "Financials" }] };
const CLASSIFICATION_COMPANY = { data: { companies: [{ symbol: "BBRI", classification: "Banks" }] } };

/** Rows under a key this code knows, one of which carries no ticker. */
const INDEX_MEMBERS = {
  data: {
    companies: [{ symbol: "BBRI", last: "3810" }, { symbol: "BBCA", last: "8100" }, { name: "no ticker here" }],
    total: 3,
  },
};
const SECTOR_COMPANIES = { data: [{ symbol: "BBRI" }, { symbol: "BMRI" }] };

/** Two buckets. Only one becomes `rows`; losing the other silently is the failure being guarded. */
const SEARCH_V2 = { data: { result: [{ symbol: "BBRI" }, { username: "investor_joe" }], people: [{ username: "x" }] } };
const SEARCH_LEGACY = { data: [{ symbol: "BBRI" }] };

const realFetch = globalThis.fetch;
interface Call {
  method: string;
  url: string;
  /** Recorded because WHERE a credential is presented is the whole shareholders bug. */
  headers: Record<string, string>;
}
let calls: Call[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * The path without its leading slash.
 *
 * Written this way so the src-tree guard that forbids route paths at a call site can never be
 * widened onto this file and start failing on its own assertions.
 */
function pathOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

function query(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

/** Every request except the session refresh, which is plumbing rather than a call under test. */
function wire(): Call[] {
  return calls.filter((c) => !c.url.includes("login/refresh"));
}

/**
 * A per-test payload override, consulted before the fixed routing below.
 *
 * Most tests here assert on the REQUEST and share one payload table. A few assert on a ROW SHAPE
 * and each needs its own; this lets one test swap one payload rather than standing up a second
 * fetch stub that would drift from this one. Returning undefined falls through to the table.
 */
let override: ((path: string) => unknown) | undefined;

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      method: init?.method ?? "GET",
      url: u,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
    });
    const path = pathOf(u);
    if (path.includes("login/refresh")) return json({ data: { access_token: farFutureJwt() } });

    const overridden = override?.(path);
    if (overridden !== undefined) return json(overridden);

    if (path.endsWith("/profile")) return json(PROFILE);
    if (path.endsWith("/contact")) return json(path.includes("ZERO") ? { data: null } : CONTACT);
    if (path.includes("emitten/v2/") && path.endsWith("/info")) {
      return json(path.includes("/bank/") ? TYPED_INFO_BANK : TYPED_INFO_COMPANY);
    }
    if (path.endsWith("/fin-items")) return json(FIN_ITEMS);
    if (path.includes("subsidiary/")) {
      if (path.endsWith("NONE")) return json(SUBSIDIARIES_UNKNOWN);
      if (path.endsWith("ZERO")) return json(SUBSIDIARIES_EMPTY);
      return json(SUBSIDIARIES);
    }
    if (path.endsWith("shareholders/token")) return json(SHAREHOLDER_TOKEN);
    if (path.includes("shareholders/") && path.endsWith("/chart")) {
      // The refusal the field hit, verbatim. DENY serves it under the 401 the reporter annotated;
      // DENY400 serves the SAME refusal under a status nobody has recorded, because the status is
      // the weaker half of that observation.
      const refusal = { message: "rpc error: code = Unauthenticated desc = WebViewToken.FromContext: User Not Found" };
      if (path.includes("/DENY400/")) return json(refusal, 400);
      if (path.includes("/DENY/")) return json(refusal, 401);
      if (path.includes("/CHART/")) return json(OWNERSHIP_CHART);
      return json(SHAREHOLDERS);
    }
    if (path.endsWith("classification/company")) return json(CLASSIFICATION_COMPANY);
    if (path.endsWith("emitten/classification")) return json(CLASSIFICATION_TAXONOMY);
    if (path.includes("emitten/indexes/")) return json(INDEX_MEMBERS);
    if (path.includes("/sector/") && path.endsWith("/company")) return json(SECTOR_COMPANIES);
    if (path.endsWith("search/v2")) return json(SEARCH_V2);
    if (path.endsWith("search")) return json(SEARCH_LEGACY);
    if (path.endsWith("/info")) return json(path.includes("ZERO") ? { data: null } : INFO);
    return json({ message: `unexpected ${path}` }, 404);
  }) as typeof fetch;
});

beforeEach(() => {
  calls = [];
  override = undefined;
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

/* -------------------------------- company_overview -------------------------------- */

test("company_overview asks the info route and keeps the blocks the quote projection drops", async () => {
  const overview = await companyOverview("bbri");

  assert.equal(wire().length, 1);
  assert.equal(pathOf(wire()[0].url), "emitten/BBRI/info");
  assert.deepEqual(query(wire()[0].url), {}, "the info route takes no parameters");

  assert.equal(overview.symbol, "BBRI");
  assert.deepEqual(overview.indexes, [{ code: "LQ45" }, { code: "IDX30" }]);
  assert.deepEqual(overview.catalogs, [{ id: 3, name: "Bank" }]);
  assert.deepEqual(overview.corpAction, { dividend: { ex_date: "2026-04-02" } });
  // The rest of the row survives: this is a widening of `quote`, not a different projection.
  assert.equal(overview.price, "3810");
  assert.deepEqual(overview.orderbook, { bid: { price: "3800", volume: "1000" } });
});

test("company_overview reports the eligibility flags under their WIRE names", async () => {
  // The research note recorded that margin / day-trade flags exist and did not record their
  // spellings. Naming them here would ship keys that are always undefined and read as "not
  // eligible"; matching the concept and echoing the real key says only what the payload said.
  const overview = await companyOverview("BBRI");
  assert.deepEqual(overview.eligibility, {
    is_margin: true,
    day_trade_eligible: false,
    marginable_status: "MARGIN_ACTIVE",
  });
});

test("company_overview separates a null block from an empty one", async () => {
  const overview = await companyOverview("BBRI");
  // `uma` is present-and-null, `notation` is present-and-empty. Only the first is a miss.
  assert.deepEqual(overview.found, ["indexes", "catalogs", "notation", "corp_action"]);
  assert.deepEqual(overview.missing, ["uma"]);
  assert.deepEqual(overview.notation, []);
});

test("company_overview on a response with no data reports every block missing, and does not throw", async () => {
  const overview = await companyOverview("ZERO");
  assert.deepEqual(overview.found, []);
  assert.deepEqual(overview.missing, ["indexes", "catalogs", "uma", "notation", "corp_action"]);
  assert.deepEqual(overview.eligibility, {});
  assert.equal(overview.symbol, "ZERO");
});

/* --------------------------------- company_profile --------------------------------- */

test("company_profile makes ONE request by default and returns the body verbatim", async () => {
  const profile = await getCompanyProfile("BBRI");

  assert.deepEqual(wire().map((c) => pathOf(c.url)), ["emitten/BBRI/profile"]);
  // Exact, so it is also the issue #37 pin: a recomputed percentage, a parsed magnitude or any
  // added sibling inside `profile` fails here rather than shipping as if the server had checked it.
  assert.deepEqual(profile, { symbol: "BBRI", profile: PROFILE.data });
  assert.equal("emittenType" in profile, false, "the vocabulary is only reported when it was used");
});

test("company_profile adds only the v2 view that was asked for, under the given emitten type", async () => {
  const profile = await getCompanyProfile("BBRI", { typedInfo: true, emittenType: "Bank" });

  const paths = wire().map((c) => pathOf(c.url)).sort();
  assert.deepEqual(paths, ["emitten/BBRI/profile", "emitten/v2/bank/BBRI/info"]);
  assert.equal(paths.some((p) => p.includes("fin-items")), false, "fin-items was not requested");
  assert.equal(profile.emittenType, "bank", "the type is lowercased to the wire vocabulary");
  assert.deepEqual(profile.typedInfo, TYPED_INFO_BANK.data);
  assert.equal("finItems" in profile, false);
});

test("the typed view is cached per emitten type, not per symbol", async () => {
  // A key of `typedInfo:BBRI` would answer a bank request with the company vocabulary, which is the
  // same class of bug as a limit-less cache key: a plausible answer to a question nobody asked.
  await getCompanyProfile("BBRI", { typedInfo: true });
  await getCompanyProfile("BBRI", { typedInfo: true, emittenType: "bank" });

  const typed = wire().filter((c) => pathOf(c.url).includes("emitten/v2/"));
  assert.deepEqual(typed.map((c) => pathOf(c.url)), ["emitten/v2/company/BBRI/info", "emitten/v2/bank/BBRI/info"]);
});

test("company_profile with both extras fetches fin-items too", async () => {
  const profile = await getCompanyProfile("BBRI", { typedInfo: true, finItems: true });
  const paths = wire().map((c) => pathOf(c.url)).sort();
  assert.deepEqual(paths, [
    "emitten/BBRI/profile",
    "emitten/v2/company/BBRI/fin-items",
    "emitten/v2/company/BBRI/info",
  ]);
  assert.deepEqual(profile.finItems, FIN_ITEMS.data);
});

/* --------------------------------- company_contact --------------------------------- */

test("company_contact returns the body, and null when the issuer publishes none", async () => {
  assert.deepEqual(await getContact("BBRI"), CONTACT.data);
  assert.deepEqual(wire().map((c) => pathOf(c.url)), ["emitten/BBRI/contact"]);

  clearCache();
  assert.equal(await getContact("ZERO"), null, "an absent body is an answer, not an error");
});

/* ------------------------------ company_subsidiaries ------------------------------ */

test("subsidiaries are found under data.result, and the siblings survive as extra", async () => {
  const subs = await getSubsidiaries("BBRI");
  assert.deepEqual(wire().map((c) => pathOf(c.url)), ["emitten-metadata/subsidiary/BBRI"]);
  assert.equal(subs.source, "data.result");
  assert.deepEqual(subs.rows, SUBSIDIARIES.data.result);
  assert.deepEqual(subs.extra, { total: 1 });
});

test("an unlocatable row array is NOT reported as an empty list", async () => {
  // The difference this asserts is the reason `source` exists. Both calls return zero rows; only one
  // of them means the company has no subsidiaries.
  const unknown = await getSubsidiaries("NONE");
  assert.deepEqual(unknown.rows, []);
  assert.equal(unknown.source, null, "null source = this code could not find the rows");
  assert.deepEqual(unknown.extra, SUBSIDIARIES_UNKNOWN.data, "the payload is handed back for diagnosis");

  const empty = await getSubsidiaries("ZERO");
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.source, "data", "a non-null source = the endpoint genuinely returned zero rows");
});

/* ---------------------------------- shareholders ---------------------------------- */

test("the minted token goes in a RAW Authorization header, never on the URL", async () => {
  const held = await getShareholders("BBRI", 12, "all");

  assert.equal(wire().length, 2, "one mint, one read");
  assert.equal(wire()[0].method, "POST");
  assert.equal(pathOf(wire()[0].url), "emitten-metadata/shareholders/token");
  assert.equal(wire()[1].method, "GET");
  assert.equal(pathOf(wire()[1].url), "emitten-metadata/shareholders/BBRI/chart");

  // Captured from Stockbit's own client on 2026-09-01: `?symbol=…&value_year=…&shareholder_type=…`
  // and NO token parameter. Sending one is what made this tool 401 for its whole existence.
  assert.deepEqual(query(wire()[1].url), { symbol: "BBRI", value_year: "12", shareholder_type: "all" });

  // Raw, with no `Bearer` prefix, and INSTEAD of the session bearer rather than beside it. All
  // three of those are the fix; asserting only "there is an authorization header" would pass on
  // the broken version too.
  assert.equal(wire()[1].headers.authorization, "sh-token-9f3");

  assert.equal(held.source, "data.chart", "the single-array fallback found rows under an unknown key");
  assert.deepEqual(held.rows, SHAREHOLDERS.data.chart);
  assert.equal(held.valueYear, 12);
  assert.equal(JSON.stringify(held).includes("sh-token-9f3"), false, "the credential is never returned");
});

test("an omitted shareholders filter is ABSENT from the query, not blank", async () => {
  await getShareholders("BBRI");
  assert.deepEqual(Object.keys(query(wire()[1].url)).sort(), ["symbol"]);
});

test("a nonsense value_year is refused before anything reaches the wire", async () => {
  // It is a count of MONTHS, so the rule is a whole positive number. It used to be "a calendar
  // year between 1990 and 2100", which would have refused 12 — the value Stockbit's own client
  // sends — and accepted 2025, which asks for a 2025-month window.
  await assert.rejects(() => getShareholders("BBRI", 0), /value_year/);
  await assert.rejects(() => getShareholders("BBRI", -12), /value_year/);
  await assert.rejects(() => getShareholders("BBRI", 12.5), /value_year/);
  await assert.rejects(() => getShareholders("BBRI", 12, "   "), /shareholder_type/);
  assert.deepEqual(wire(), [], "no request, and in particular no token minted");

  // And the message has to teach the unit, or the caller retries with another year.
  await assert.rejects(() => getShareholders("BBRI", 0), /MONTHS/);
});

test("the calendar year that used to be required is now accepted as the month count it is", async () => {
  // Not an endorsement of passing 2025 — it is 168 years of months — but the client no longer
  // pretends to know that the endpoint refuses it. The tool description says what the unit is.
  await getShareholders("BBRI", 2025);
  assert.equal(query(wire()[1].url).value_year, "2025");
});

test("the ownership chart is projected into series, and an unreadable percent is ABSENT", async () => {
  const held = await getShareholders("CHART");

  assert.deepEqual(
    held.series?.map((s) => s.name),
    ["Local", "Foreign"],
  );
  assert.deepEqual(held.series?.[0]?.points, [
    { label: "Jun 26", percent: 72.59, unixDate: 1782752400 },
    { label: "Jul 26", percent: 73.13, unixDate: 1785430800 },
  ]);

  // The second Foreign point carries only a label. It must come back as a point with no percent —
  // not as a zero, which would read as "foreign ownership fell to nothing that month".
  const gap = held.series?.[1]?.points?.[1];
  assert.deepEqual(gap, { label: "Jul 26" });
  assert.equal("percent" in (gap ?? {}), false);

  // The endpoint names these `year` while they hold months. Renaming them is the point.
  assert.deepEqual(held.timeframes, [
    { label: "5 Bulan", months: 5 },
    { label: "1 Tahun", months: 12 },
  ]);
  assert.equal(held.lastUpdate, "3 Aug 26");

  // And the raw payload still comes back underneath, so a key the projection does not name is not
  // a key the caller loses — `color`, here.
  assert.equal((held.extra as { legend?: Array<{ color?: string }> })?.legend?.[0]?.color, "#8250a3");
});

test("a payload with no legend reports no series at all, rather than an empty one", async () => {
  // `series: []` would read as "this issuer has no ownership data". Absent says the truth: this
  // response did not carry a legend.
  const held = await getShareholders("BBRI");
  assert.equal(held.series, undefined);
  assert.equal(held.timeframes, undefined);
});

test("the shareholders cache key carries the year and the type", async () => {
  await getShareholders("BBRI", 2024);
  await getShareholders("BBRI", 2025);
  await getShareholders("BBRI", 2025);
  const years = wire()
    .filter((c) => c.method === "GET")
    .map((c) => query(c.url).value_year);
  assert.deepEqual(years, ["2024", "2025"], "the repeat was served from cache; the other year was not");
});

test("a 401 from the chart is reported as a token PLACEMENT failure, not a dead session", async () => {
  // The tool's own description predicted this failure and the prediction fired: 401
  // `WebViewToken.FromContext: User Not Found` on a session where everything else worked. The
  // placement cannot be corrected without a capture, so the one thing this client can do for the
  // caller is stop them debugging their login.
  await assert.rejects(
    () => getShareholders("DENY"),
    (error: unknown) => {
      assert.ok(error instanceof StockbitError);
      assert.equal(error.kind, "auth");
      assert.equal(error.status, 401);
      // Three variants of this call — valid token, no token, junk token — answered identically on
      // 2026-09-01, so the message may not describe the query placement as merely unverified.
      assert.match(error.message, /query parameter/);
      assert.match(error.message, /No value will fix it/);
      // And it must not send the caller off to check their own session, which is fine.
      assert.match(error.message, /not your session/i);
      // A caller who wanted the register still needs an answer, and there is one that works.
      assert.match(error.message, /company_profile/);
      // The upstream text is kept: dropping it would hide a DIFFERENT auth failure behind this
      // diagnosis, and the diagnosis is a strong claim to be making about someone else's 401.
      assert.match(error.message, /WebViewToken\.FromContext/);
      return true;
    },
  );
  // The token was still minted first, so the failure really is the chart refusing it.
  assert.equal(pathOf(wire()[0].url), "emitten-metadata/shareholders/token");
});

test("a 401 here is not retried: a one-shot token the server rejected is spent", async () => {
  // Every other route retries a 401 once, because the refresh in between CHANGES the credential.
  // This route has no token domain, so there is nothing to refresh and the second request would be
  // the first request again — with a token the server has already rejected and consumed.
  await assert.rejects(() => getShareholders("DENY"), StockbitError);
  assert.equal(wire().length, 2, "one mint, one read — not a second read with the spent token");
  assert.equal(wire().filter((c) => c.url.includes("/chart")).length, 1);
});

test("the same refusal under a different status is still diagnosed, because the status is the weak half", async () => {
  // Of the two things the field recorded, the body string was copied out of a response and the
  // 401 beside it is the reporter's annotation — no status for this failure is written down
  // anywhere in this repo. Keying only on the kind would hand the caller the raw gateway string
  // for the very failure this branch exists to explain.
  await assert.rejects(
    () => getShareholders("DENY400"),
    (error: unknown) => {
      assert.ok(error instanceof StockbitError);
      assert.match(error.message, /No value will fix it/);
      assert.match(error.message, /WebViewToken\.FromContext/);
      return true;
    },
  );
});

/* --------------------------------- classification --------------------------------- */

test("classification reads a different path per scope, and caches them apart", async () => {
  assert.deepEqual([...CLASSIFICATION_SCOPES], ["taxonomy", "company"]);

  const taxonomy = await getClassification();
  assert.equal(taxonomy.source, "data");
  assert.deepEqual(taxonomy.rows, CLASSIFICATION_TAXONOMY.data);

  const perCompany = await getClassification("company");
  assert.equal(perCompany.source, "data.companies");
  assert.deepEqual(perCompany.rows, CLASSIFICATION_COMPANY.data.companies);

  await getClassification("taxonomy");
  assert.deepEqual(wire().map((c) => pathOf(c.url)), [
    "emitten/classification",
    "emitten/classification/company",
  ]);
});

/* --------------------------------- index_members --------------------------------- */

test("index_members sends the required limit and reports the tickers it could read", async () => {
  const members = await getIndexMembers(" lq45 ", 100);

  assert.equal(pathOf(wire()[0].url), "emitten/indexes/LQ45");
  assert.deepEqual(query(wire()[0].url), { limit: "100" });
  assert.equal(members.source, "data.companies");
  assert.deepEqual(members.symbols, ["BBRI", "BBCA"]);
  assert.equal(members.rowsWithoutSymbol, 1, "the row with no ticker is counted, not silently dropped");
  assert.equal(members.rows.length, 3);
  assert.deepEqual(members.extra, { total: 3 });
});

test("a limit outside 1..500 never reaches the wire", async () => {
  await assert.rejects(() => getIndexMembers("LQ45", 0), /limit/);
  await assert.rejects(() => getIndexMembers("LQ45", INDEX_MEMBERS_MAX_LIMIT + 1), /limit/);
  await assert.rejects(() => getIndexMembers("LQ45", 10.5), /limit/);
  assert.deepEqual(wire(), []);
});

test("the index_members cache key includes the limit", async () => {
  // The bug this exists to prevent is in the repo's history: a key of `thing:${symbol}` served the
  // 5-row answer to the caller who asked for 50.
  await getIndexMembers("LQ45", 5);
  await getIndexMembers("LQ45", 50);
  await getIndexMembers("LQ45", 5);
  assert.deepEqual(wire().map((c) => query(c.url).limit), ["5", "50"]);
});

/* -------------------------------- sector_companies -------------------------------- */

test("sector_companies takes the numeric sector id", async () => {
  const companies = await getSectorCompanies("5");
  assert.equal(pathOf(wire()[0].url), "emitten/v3/sector/5/company");
  assert.deepEqual(query(wire()[0].url), {});
  assert.equal(companies.source, "data");
  assert.deepEqual(companies.symbols, ["BBRI", "BMRI"]);
  assert.equal(companies.rowsWithoutSymbol, 0);
});

test("a sector NAME is rejected instead of being sent as a path segment", async () => {
  await assert.rejects(() => getSectorCompanies("financials"), /sector id/);
  assert.deepEqual(wire(), []);
});

/* ---------------------------------- symbol_search ---------------------------------- */

test("symbol_search v2 sends every filter it was given and nothing it was not", async () => {
  const hits = await search("bank rakyat", { page: 2, type: "company", insiderCategory: "individual" });

  assert.equal(pathOf(wire()[0].url), "search/v2");
  assert.deepEqual(query(wire()[0].url), {
    keyword: "bank rakyat",
    page: "2",
    type: "company",
    insider_category: "individual",
  });
  assert.equal(hits.source, "data.result");
  assert.deepEqual(hits.symbols, ["BBRI"], "a person row carries no ticker and is not invented one");
  assert.equal(hits.rowsWithoutSymbol, 1);
  assert.deepEqual(
    hits.symbolRows,
    [{ index: 0, symbol: "BBRI", readFrom: "symbol" }],
    "a row that carries `symbol` is still read from it, and says so",
  );
  assert.deepEqual(hits.extra, { people: [{ username: "x" }] }, "the second bucket is not dropped");
});

/*
 * The five below are issue #41. A live `/search/v2` row was reported as
 * `{"id":"DEWA","name":"DEWA","desc":"Darma Henwa Tbk","url":"symbol/DEWA"}` — no `symbol` key at
 * all — so the projection reported all eight rows of a successful search as ticker-less and handed
 * back `symbols: []` from the one tool whose job is turning a name into a ticker.
 */

/** The reported row shape: the ticker in `id`, in `name`, and again in the link. */
const SEARCH_ROWS = {
  data: {
    result: [
      { id: "DEWA", name: "DEWA", desc: "An Issuer Tbk", url: "symbol/DEWA" },
      { id: "DEWAZPCH7A", name: "DEWAZPCH7A", desc: "Call Waran DEWA ZP", url: "symbol/DEWAZPCH7A" },
      { id: "99", name: "somebody", desc: "A Person", url: "user/somebody" },
    ],
  },
};

/** Answer only the v2 search path; everything else falls through to the shared table. */
const searchReplies = (payload: unknown) => (path: string) => (path.endsWith("search/v2") ? payload : undefined);

test("a search row with no `symbol` key is read from its symbol/<TICKER> link", async () => {
  override = searchReplies(SEARCH_ROWS);
  const hits = await search("DEWA");
  assert.deepEqual(hits.symbols, ["DEWA", "DEWAZPCH7A"], "including the structured warrant");
  assert.equal(hits.rowsWithoutSymbol, 1, "and only the person row is counted ticker-less");
  assert.deepEqual(hits.symbolRows, [
    { index: 0, symbol: "DEWA", readFrom: "url" },
    { index: 1, symbol: "DEWAZPCH7A", readFrom: "url" },
  ]);
  assert.equal(hits.rows.length, 3, "nothing is dropped");
});

test("a row linking to a person is never mined for a ticker, even though its id is ticker-shaped", async () => {
  // `isSymbol("99")` is true — digits are in the charset — so without the link gate this row would
  // publish "99" as a stock, and `normalizeSymbol` would then accept it as a URL path segment.
  override = searchReplies({ data: { result: [{ id: "99", name: "somebody", url: "user/somebody" }] } });
  const hits = await search("somebody");
  assert.deepEqual(hits.symbols, []);
  assert.equal(hits.rowsWithoutSymbol, 1);
});

test("a numeric id on a real emitten row does not beat the ticker in its own link", async () => {
  // The reason `id`/`name` are not mined at all: `isSymbol("12345")` is true, so an id-first probe
  // would publish "12345" and discard BBRI from the very same row.
  override = searchReplies({ data: { result: [{ id: "12345", name: "Bank Rakyat Indonesia", url: "symbol/BBRI" }] } });
  const hits = await search("bank");
  assert.deepEqual(hits.symbols, ["BBRI"]);
  assert.deepEqual(hits.symbolRows, [{ index: 0, symbol: "BBRI", readFrom: "url" }]);
});

test("a leading slash on the link is tolerated; anything else is not a ticker", async () => {
  override = searchReplies({
    data: {
      result: [
        { id: "a", url: "/symbol/BBRI" },
        { id: "b", url: "symbol/not a ticker" },
        { id: "c", url: "https://stockbit.com/symbol/GOTO" },
        { id: "d" },
      ],
    },
  });
  const hits = await search("x");
  assert.deepEqual(
    hits.symbols,
    ["BBRI"],
    "a bare `^symbol/` would have made one upstream reformat return the whole bug, silently",
  );
  assert.equal(hits.rowsWithoutSymbol, 3, "an unshaped segment, an absolute URL and a linkless row");
});

test("index_members and sector_companies keep the strict `symbol` rule", async () => {
  // The fence. A probe wide enough for a search row would read a sector's numeric id as a ticker,
  // so the two readers are deliberately separate and this pins that they stayed separate. BOTH
  // membership call sites are exercised: each one calls `symbolsIn` for itself, so either could
  // have been switched to the search reader on its own.
  override = (path) => {
    if (path.includes("/sector/") && path.endsWith("/company")) {
      return { data: [{ id: "9", name: "Energy", url: "sector/9" }] };
    }
    if (path.includes("emitten/indexes/")) {
      return { data: { companies: [{ id: "12345", name: "Bank Rakyat Indonesia", url: "symbol/BBRI" }] } };
    }
    return undefined;
  };

  const sector = await getSectorCompanies("9");
  assert.deepEqual(sector.symbols, [], "no ticker is invented from a sector id or a sector name");
  assert.equal(sector.rowsWithoutSymbol, 1);

  // A row the SEARCH reader would happily take BBRI off, through its `symbol/<TICKER>` link. This
  // reader does not look at links at all, so it reports the row ticker-less rather than mining one.
  const index = await getIndexMembers("LQ45", 10);
  assert.deepEqual(index.symbols, [], "the link rule belongs to `searchSymbolsIn`, not to this one");
  assert.equal(index.rowsWithoutSymbol, 1);
});

test("symbol_search omits absent filters rather than sending them empty", async () => {
  await search("BBRI");
  assert.deepEqual(query(wire()[0].url), { keyword: "BBRI" });
});

test("the legacy search takes only a keyword, and REFUSES the v2 filters", async () => {
  assert.deepEqual([...SEARCH_VARIANTS], ["v2", "legacy"]);

  const hits = await search("BBRI", { variant: "legacy" });
  assert.equal(pathOf(wire()[0].url), "search");
  assert.deepEqual(query(wire()[0].url), { keyword: "BBRI" });
  assert.deepEqual(hits.rows, SEARCH_LEGACY.data);

  calls = [];
  // Ignoring `page` here would return page 1 to a caller paging through results, which reads as the
  // end of the list.
  await assert.rejects(() => search("BBRI", { variant: "legacy", page: 2 }), /legacy/);
  assert.deepEqual(wire(), []);
});

test("a blank keyword and a bad page are refused before the request", async () => {
  await assert.rejects(() => search("   "), /keyword/);
  await assert.rejects(() => search("BBRI", { page: 0 }), /page/);
  assert.deepEqual(wire(), []);
});

test("the search cache key carries the keyword, the variant and the page", async () => {
  await search("BBRI");
  await search("BBRI", { page: 2 });
  await search("BBCA");
  await search("BBRI");
  assert.deepEqual(
    wire().map((c) => `${query(c.url).keyword}:${query(c.url).page ?? "-"}`),
    ["BBRI:-", "BBRI:2", "BBCA:-"],
  );
});

/* ------------------------------- the tool surface ------------------------------- */

/**
 * The registrations themselves.
 *
 * `src/tools/company.ts` is otherwise loaded only by `register.ts`, which pulls in every other
 * family; exercising it through a fake definer keeps this file's blast radius to one module while
 * still proving the handlers are wired to the core functions and not to each other.
 */
const registered = new Map<string, { description: string; shape: Record<string, unknown>; handler: ToolHandler }>();
const registeredWrites: string[] = [];

const definer: Definer = {
  read(name, description, shape, handler) {
    registered.set(name, { description, shape: shape as Record<string, unknown>, handler });
  },
  write(name) {
    registeredWrites.push(name);
  },
  writeNames: () => registeredWrites,
};
registerCompanyTools(definer);

/** Unwrap the JSON text block `runTool` produces. */
async function call(name: string, args: Record<string, unknown>): Promise<{ result: any; isError: boolean }> {
  const tool = registered.get(name);
  assert.ok(tool, `${name} is not registered`);
  const out = (await tool.handler(args)) as { content: Array<{ text: string }>; isError?: boolean };
  return { result: JSON.parse(out.content[0].text), isError: out.isError === true };
}

test("the family registers exactly its nine read tools and no writes", () => {
  assert.deepEqual([...registered.keys()].sort(), [
    "classification",
    "company_contact",
    "company_overview",
    "company_profile",
    "company_subsidiaries",
    "index_members",
    "sector_companies",
    "shareholders",
    "symbol_search",
  ]);
  assert.deepEqual(registeredWrites, [], "nothing here changes account state");
});

test("every tool argument is snake_case and every description says something", () => {
  for (const [name, tool] of registered) {
    for (const arg of Object.keys(tool.shape)) {
      assert.match(arg, /^[a-z][a-z0-9_]*$/, `${name}.${arg} is not snake_case`);
    }
    assert.ok(tool.description.length > 200, `${name} has a description too short to warn anyone`);
  }
});

test("the overview handler reaches the core projection", async () => {
  const { result, isError } = await call("company_overview", { symbol: "BBRI" });
  assert.equal(isError, false);
  assert.equal(result.success, true);
  assert.equal(result.data.symbol, "BBRI");
  assert.deepEqual(result.data.missing, ["uma"]);
});

test("a rejected argument comes back as an error result, not a thrown handler", async () => {
  const { result, isError } = await call("symbol_search", { keyword: "  " });
  assert.equal(isError, true);
  assert.equal(result.success, false);
  assert.equal(result.kind, "invalid_param");
  assert.deepEqual(wire(), []);
});

test("index_members refuses an over-cap limit through the tool as well", async () => {
  const { result, isError } = await call("index_members", { index_code: "LQ45", limit: 501 });
  assert.equal(isError, true);
  assert.equal(result.kind, "invalid_param");
});
