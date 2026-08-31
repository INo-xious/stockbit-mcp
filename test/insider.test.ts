// Isolate the token store before importing anything that reads it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-insider-"));

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
// This module only — ../src/core/index.ts would pull in every other family.
import {
  INSIDER_ACTION_TYPES,
  INSIDER_SOURCE_TYPES,
  INSIDER_TRANSACTIONS_LIMIT_CEILING,
  buildInsiderTransactionParams,
  buildShareholdingNetworkParams,
  getInsiderOwnership,
  getInsiderTransactions,
  getOwnershipComposition,
  getShareholdingCompanies,
  getShareholdingInvestors,
  getShareholdingNetwork,
} from "../src/core/insider.ts";
import { StockbitError } from "../src/http/errors.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* --------------------------------- fixtures --------------------------------- */

/** Shaped like the rows Stockbit's insider table reads: wrapped values, comma-grouped strings. */
const BUY_ROW = {
  id: 12345,
  date: "2026-08-14",
  symbol: "BBRI",
  name: "Sunarso",
  badges: ["SHAREHOLDER_BADGE_DIREKTUR"],
  action_type: "ACTION_TYPE_BUY",
  changes: { value: "1,500,000", formatted_value: "1.5M", percentage: "0.01" },
  previous: { value: "12,000,000", percentage: "0.08" },
  current: { value: "13,500,000", percentage: "0.09" },
  price_formatted: "4,150",
  broker_detail: { code: "YP", group: "BROKER_GROUP_LOCAL" },
  nationality: "NATIONALITY_TYPE_LOCAL",
  data_source: { type: "SOURCE_TYPE_IDX" },
};

/** The same shape with holes in it: empty strings where the buy row has numbers. */
const SPARSE_ROW = {
  id: "77",
  date: "2026-08-10",
  symbol: "BBRI",
  name: "PT Contoh Sejahtera",
  action_type: "ACTION_TYPE_CROSS",
  changes: { value: "-2,000", percentage: "-0.02" },
  previous: { value: "", percentage: "" },
  current: { value: "0", percentage: "0" },
  price_formatted: "0",
  broker_detail: { code: "", group: "BROKER_GROUP_UNSPECIFIED" },
  data_source: {},
};

const realFetch = globalThis.fetch;
const seenUrls: string[] = [];
/** Per-route request counts, so a test can prove a cache hit rather than infer it. */
const counts: Record<string, number> = {};

/** What the next matching response should be. Set by the test that needs a non-default body. */
let nextBody: unknown;
let nextStatus = 200;

function bump(name: string): void {
  counts[name] = (counts[name] ?? 0) + 1;
}

function lastUrl(fragment: string): URL {
  const found = [...seenUrls].reverse().find((u) => u.includes(fragment));
  assert.ok(found, `no request was made to ${fragment}`);
  return new URL(found);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.includes("/login/refresh")) {
      return json({ data: { access_token: farFutureJwt() } });
    }
    const routes: Array<[string, string]> = [
      ["/insider/company/majorholder", "transactions"],
      ["/insider/majorholder/ownership", "ownership"],
      ["/insider/shareholding/companies/", "companies"],
      ["/insider/shareholding/investors/", "investors"],
      ["/insider/shareholding/network", "network"],
      ["/insider/shareholding/composition/companies/", "composition"],
    ];
    // Composition's path contains the companies one, so the longest match wins.
    const hit = routes
      .filter(([fragment]) => u.includes(fragment))
      .sort((a, b) => b[0].length - a[0].length)[0];
    if (!hit) return new Response("not found", { status: 404 });

    bump(hit[1]);
    const body = nextBody;
    const status = nextStatus;
    nextBody = undefined;
    nextStatus = 200;
    if (body !== undefined) return json(body, status);

    switch (hit[1]) {
      case "transactions":
        return json({ data: { movement: [BUY_ROW, SPARSE_ROW], is_more: true }, message: "OK" });
      case "ownership":
        return json({
          data: {
            insider_name: "Sunarso",
            nationality: "NATIONALITY_TYPE_LOCAL",
            ownership: [
              { symbol: "BBRI", company_name: "Bank Rakyat Indonesia", is_more: false, recent: [BUY_ROW] },
            ],
          },
        });
      case "companies":
        return json({
          data: {
            id: 460,
            symbol: "BBRI",
            name: "Bank Rakyat Indonesia",
            report_date: "2026-07-31",
            holders: [
              {
                investor: { id: 9001, name: "Republik Indonesia" },
                shareholding: { total_shares: { raw: 80610976876 }, percentage: { raw: 53.19 } },
              },
            ],
          },
        });
      case "investors":
        return json({
          data: { id: 9001, name: "Republik Indonesia", holdings: [{ company: { symbol: "BBRI" } }] },
        });
      case "network":
        return json({ data: { root_id: "460", nodes: [{ id: "460" }, { id: "9001" }], links: [{ from_id: "9001", to_id: "460" }] } });
      case "composition":
        return json({ data: { periods: [{ period: "2026-07", local: 46.8, foreign: 53.2 }] } });
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;
});

beforeEach(() => {
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

/* ---------------------------- the request on the wire ---------------------------- */

test("insider_transactions sends only the parameters it was given", async () => {
  await getInsiderTransactions({ symbol: "bbri" });
  const url = lastUrl("/insider/company/majorholder");
  assert.equal(url.pathname, "/insider/company/majorholder");
  assert.equal(url.searchParams.get("symbol"), "BBRI");
  // Both clients always send a page; 1 is their default.
  assert.equal(url.searchParams.get("page"), "1");
  // Omitted means ABSENT, not empty. Stockbit's own page bundle sends `insider=""`; this does not.
  for (const absent of ["insider", "date_start", "date_end", "limit", "action_type", "source_type"]) {
    assert.equal(url.searchParams.has(absent), false, `${absent} should not have been sent`);
  }
});

test("insider_transactions puts every supplied argument on the wire in its wire spelling", async () => {
  await getInsiderTransactions({
    symbol: "BBRI",
    insider: "12345",
    dateStart: "2026-07-01",
    dateEnd: "2026-07-31",
    page: 3,
    limit: INSIDER_TRANSACTIONS_LIMIT_CEILING,
    actionType: "buy",
    sourceType: "idx",
  });
  const q = lastUrl("/insider/company/majorholder").searchParams;
  assert.equal(q.get("symbol"), "BBRI");
  assert.equal(q.get("insider"), "12345");
  assert.equal(q.get("date_start"), "2026-07-01");
  assert.equal(q.get("date_end"), "2026-07-31");
  assert.equal(q.get("page"), "3");
  assert.equal(q.get("limit"), String(INSIDER_TRANSACTIONS_LIMIT_CEILING));
  // Lowercase in, prefixed enum out.
  assert.equal(q.get("action_type"), "ACTION_TYPE_BUY");
  assert.equal(q.get("source_type"), "SOURCE_TYPE_IDX");
});

test("an already-prefixed enum is not prefixed twice", () => {
  const p = buildInsiderTransactionParams({ actionType: "ACTION_TYPE_CORPACTION" });
  assert.equal(p.action_type, "ACTION_TYPE_CORPACTION");
});

test("an action type outside the known list is sent, not refused", () => {
  // The list is documented as partial; refusing a real-but-unlisted action would make a legitimate
  // query impossible, and the only cost of being wrong is a 400 from the server.
  assert.equal((INSIDER_ACTION_TYPES as readonly string[]).includes("SOMETHING_NEW"), false);
  const p = buildInsiderTransactionParams({ actionType: "something_new" });
  assert.equal(p.action_type, "ACTION_TYPE_SOMETHING_NEW");
  assert.deepEqual([...INSIDER_SOURCE_TYPES], ["UNSPECIFIED", "IDX", "KSEI"]);
});

/* --------------------------------- projection --------------------------------- */

test("insider_transactions projects a row without losing the raw one", async () => {
  const result = await getInsiderTransactions({ symbol: "BBRI" });
  assert.equal(result.rows.length, 2);
  const row = result.rows[0];
  assert.equal(row.insiderId, "12345");
  assert.equal(row.holderName, "Sunarso");
  assert.equal(row.actionType, "ACTION_TYPE_BUY");
  assert.equal(row.sharesChanged, 1_500_000);
  assert.equal(row.changePercent, 0.01);
  assert.equal(row.sharesBefore, 12_000_000);
  assert.equal(row.sharesAfter, 13_500_000);
  assert.equal(row.percentAfter, 0.09);
  assert.equal(row.brokerCode, "YP");
  assert.equal(row.brokerGroup, "BROKER_GROUP_LOCAL");
  assert.equal(row.sourceType, "SOURCE_TYPE_IDX");
  // The raw row survives underneath: these are never re-exported under new names.
  assert.deepEqual(row.badges, ["SHAREHOLDER_BADGE_DIREKTUR"]);
  assert.equal(row.price_formatted, "4,150");
  assert.equal(row.nationality, "NATIONALITY_TYPE_LOCAL");
  assert.deepEqual(row.changes, BUY_ROW.changes);
  assert.equal(result.hasMore, true);
  assert.equal(result.symbol, "BBRI");
  assert.equal(result.page, 1);
});

test("a missing number is absent, and a real zero is zero", async () => {
  const { rows } = await getInsiderTransactions({ symbol: "BBRI" });
  const sparse = rows[1];
  // previous.value was "" — Number("") is 0, which would read as "sold everything".
  assert.equal(sparse.sharesBefore, undefined);
  assert.equal(sparse.percentBefore, undefined);
  // current.value was "0" — a genuine zero holding, and it must survive as 0.
  assert.equal(sparse.sharesAfter, 0);
  assert.equal(sparse.percentAfter, 0);
  assert.equal(sparse.sharesChanged, -2000);
  // An empty broker code is absent; the group beside it is still reported.
  assert.equal(sparse.brokerCode, undefined);
  assert.equal(sparse.brokerGroup, "BROKER_GROUP_UNSPECIFIED");
  // data_source was {} — no source type, and no invented one either.
  assert.equal(sparse.sourceType, undefined);
  assert.equal("sourceType" in sparse, false);
});

test("no rows means an empty list, not a throw", async () => {
  nextBody = { data: null, message: "OK" };
  const result = await getInsiderTransactions({ symbol: "BMRI" });
  assert.deepEqual(result.rows, []);
  assert.equal(result.hasMore, undefined);

  nextBody = { data: { movement: null } };
  const empty = await getInsiderTransactions({ symbol: "BBCA" });
  assert.deepEqual(empty.rows, []);
});

test("an error inside a 200 is an error, not an empty result", async () => {
  // This family reports refusals in the body: Stockbit's own client checks `error`/`error_type`
  // before it looks at `data`. Reading only `data` would report the refusal as "never traded".
  nextBody = { data: null, error: true, error_type: "PERMISSION_DENIED", message: "Feature not available" };
  await assert.rejects(
    () => getInsiderTransactions({ symbol: "TLKM" }),
    (err: unknown) =>
      err instanceof StockbitError && err.message === "Feature not available" && err.errorType === "PERMISSION_DENIED",
  );
});

test("actionFilterHonored reports a filter the server ignored", async () => {
  nextBody = { data: { movement: [BUY_ROW, SPARSE_ROW] } };
  const ignored = await getInsiderTransactions({ symbol: "BBRI", actionType: "BUY" });
  // SPARSE_ROW is a CROSS, so the server did not apply the filter.
  assert.equal(ignored.actionFilterHonored, false);

  nextBody = { data: { movement: [BUY_ROW] } };
  const honored = await getInsiderTransactions({ symbol: "BBRI", actionType: "BUY", page: 2 });
  assert.equal(honored.actionFilterHonored, true);

  // Nothing came back, so nothing could be checked — that is not "the filter worked".
  nextBody = { data: { movement: [] } };
  const nothing = await getInsiderTransactions({ symbol: "BBRI", actionType: "SELL" });
  assert.equal(nothing.actionFilterHonored, undefined);

  // And it is only reported when a filter was actually requested.
  const unfiltered = await getInsiderTransactions({ symbol: "BBRI", page: 9 });
  assert.equal(unfiltered.actionFilterHonored, undefined);
});

/* -------------------------------- rejections -------------------------------- */

test("a half-specified window is refused before the request goes out", async () => {
  const before = counts.transactions ?? 0;
  for (const opts of [{ symbol: "BBRI", dateStart: "2026-07-01" }, { symbol: "BBRI", dateEnd: "2026-07-31" }]) {
    await assert.rejects(
      () => getInsiderTransactions(opts),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
    );
  }
  await assert.rejects(
    () => getInsiderTransactions({ symbol: "BBRI", dateStart: "2026-08-01", dateEnd: "2026-07-01" }),
    (err: unknown) => err instanceof StockbitError && /must not be after/.test(err.message),
  );
  await assert.rejects(
    () => getInsiderTransactions({ symbol: "BBRI", dateStart: "2026/07/01", dateEnd: "2026-07-31" }),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(counts.transactions ?? 0, before, "a rejected argument must never reach the wire");
});

test("a bad symbol, holder id or page never reaches the wire", async () => {
  const before = counts.transactions ?? 0;
  for (const opts of [
    { symbol: "../etc/passwd" },
    { insider: "12 345" },
    { insider: "a".repeat(65) },
    { symbol: "BBRI", page: 0 },
    { symbol: "BBRI", page: 1.5 },
    { symbol: "BBRI", limit: -5 },
    { symbol: "BBRI", limit: INSIDER_TRANSACTIONS_LIMIT_CEILING + 1 },
    { symbol: "BBRI", actionType: "buy; drop" },
  ]) {
    await assert.rejects(
      () => getInsiderTransactions(opts),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      JSON.stringify(opts),
    );
  }
  assert.equal(counts.transactions ?? 0, before);
});

test("a limit over the ceiling names the parameter, the ceiling, and whose ceiling it is", async () => {
  // The upstream 400 for `limit: 50` named no parameter at all, and the call that provoked it
  // carried four candidates (two dates, page, limit). Spending a round trip to learn nothing is
  // the defect; so is implying the 20 is Stockbit's when only this client has ever asserted it.
  const before = counts.transactions ?? 0;
  await assert.rejects(
    () => getInsiderTransactions({ symbol: "BBRI", limit: 50 }),
    (err: unknown) =>
      err instanceof StockbitError &&
      err.kind === "invalid_param" &&
      /\blimit\b/.test(err.message) &&
      err.message.includes(String(INSIDER_TRANSACTIONS_LIMIT_CEILING)) &&
      /this client's ceiling/.test(err.message) &&
      /not a documented upstream maximum/.test(err.message),
  );
  assert.equal(counts.transactions ?? 0, before, "a refused limit must never reach the wire");
});

test("the ceiling binds `limit` alone — `page` walks as far as the caller likes", () => {
  // They share a validator, so the ceiling has to be passed rather than baked in: a paged feed with
  // a capped page number would silently stop at the twentieth page of history.
  assert.equal(buildInsiderTransactionParams({ limit: INSIDER_TRANSACTIONS_LIMIT_CEILING }).limit, 20);
  assert.equal(buildInsiderTransactionParams({ page: 500 }).page, 500);
});

/* ---------------------------------- caching ---------------------------------- */

test("the cache key carries every argument that changes the answer", async () => {
  clearCache();
  const before = counts.transactions ?? 0;

  await getInsiderTransactions({ symbol: "BBRI", page: 1 });
  await getInsiderTransactions({ symbol: "BBRI", page: 1 });
  assert.equal((counts.transactions ?? 0) - before, 1, "the identical query should have been cached");

  // Each of these differs from the first in exactly one argument.
  await getInsiderTransactions({ symbol: "BBRI", page: 2 });
  await getInsiderTransactions({ symbol: "BBCA", page: 1 });
  await getInsiderTransactions({ symbol: "BBRI", page: 1, limit: 20 });
  await getInsiderTransactions({ symbol: "BBRI", page: 1, actionType: "SELL" });
  await getInsiderTransactions({ symbol: "BBRI", page: 1, sourceType: "KSEI" });
  await getInsiderTransactions({ symbol: "BBRI", page: 1, insider: "12345" });
  await getInsiderTransactions({ symbol: "BBRI", page: 1, dateStart: "2026-07-01", dateEnd: "2026-07-31" });
  assert.equal((counts.transactions ?? 0) - before, 8, "each distinct query needs its own request");
});

/* ------------------------------ insider ownership ------------------------------ */

test("insider_ownership sends the holder id and defaults the page", async () => {
  await getInsiderOwnership({ insider: "12345" });
  const url = lastUrl("/insider/majorholder/ownership");
  assert.equal(url.pathname, "/insider/majorholder/ownership");
  assert.equal(url.searchParams.get("insider"), "12345");
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.has("symbol"), false);
  assert.equal(url.searchParams.has("source_type"), false);

  await getInsiderOwnership({ insider: "12345", symbol: "bbri", page: 2, sourceType: "ksei" });
  const q = lastUrl("/insider/majorholder/ownership").searchParams;
  assert.equal(q.get("symbol"), "BBRI");
  assert.equal(q.get("page"), "2");
  assert.equal(q.get("source_type"), "SOURCE_TYPE_KSEI");
});

test("insider_ownership projects positions and their recent rows", async () => {
  const result = await getInsiderOwnership({ insider: "12345" });
  assert.equal(result.insiderId, "12345");
  assert.equal(result.insiderName, "Sunarso");
  assert.equal(result.positions.length, 1);
  const position = result.positions[0];
  assert.equal(position.symbol, "BBRI");
  assert.equal(position.company_name, "Bank Rakyat Indonesia");
  assert.equal(position.hasMore, false);
  assert.equal(position.recent.length, 1);
  assert.equal(position.recent[0].sharesAfter, 13_500_000);
  // The payload's own extras survive.
  assert.equal(result.nationality, "NATIONALITY_TYPE_LOCAL");
});

test("insider_ownership with no holdings returns an empty list", async () => {
  nextBody = { data: { insider_name: "Nobody", ownership: null } };
  const result = await getInsiderOwnership({ insider: "999" });
  assert.deepEqual(result.positions, []);
  assert.equal(result.insiderName, "Nobody");
});

test("insider_ownership rejects a malformed holder id before the wire", async () => {
  const before = counts.ownership ?? 0;
  await assert.rejects(
    () => getInsiderOwnership({ insider: "../../secret" }),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(counts.ownership ?? 0, before);
});

/* -------------------------------- shareholding -------------------------------- */

test("shareholding companies asks for the symbol as a path segment", async () => {
  const result = await getShareholdingCompanies("bbri");
  const url = lastUrl("/insider/shareholding/companies/");
  assert.equal(url.pathname, "/insider/shareholding/companies/BBRI");
  assert.equal(url.search, "");
  assert.equal(result.mode, "companies");
  assert.equal(result.subject, "BBRI");
  assert.equal(result.entriesFrom, "holders");
  assert.equal(result.entryCount, 1);
  // The payload is returned whole rather than projected.
  const data = result.data as Record<string, unknown>;
  assert.equal(data.report_date, "2026-07-31");
});

test("shareholding reports which key the holdings arrived under", async () => {
  // Stockbit's own client reads `holders ?? holdings`; both spellings must be recognised.
  nextBody = { data: { symbol: "BBCA", holdings: [{}, {}, {}] } };
  const alt = await getShareholdingCompanies("BBCA");
  assert.equal(alt.entriesFrom, "holdings");
  assert.equal(alt.entryCount, 3);

  // An empty register is a real answer.
  nextBody = { data: { symbol: "BMRI", holders: [] } };
  const empty = await getShareholdingCompanies("BMRI");
  assert.equal(empty.entriesFrom, "holders");
  assert.equal(empty.entryCount, 0);

  // Neither key present is a DIFFERENT fact from an empty register, and must not read as zero.
  nextBody = { data: { symbol: "TLKM" } };
  const absent = await getShareholdingCompanies("TLKM");
  assert.equal(absent.entriesFrom, null);
  assert.equal(absent.entryCount, null);
});

test("shareholding investors asks for the holder id as a path segment", async () => {
  const result = await getShareholdingInvestors("9001");
  assert.equal(lastUrl("/insider/shareholding/investors/").pathname, "/insider/shareholding/investors/9001");
  assert.equal(result.mode, "investors");
  assert.equal(result.entriesFrom, "holdings");
  assert.equal(result.entryCount, 1);
});

test("shareholding network sends its root and omits the tuning parameters by default", async () => {
  const result = await getShareholdingNetwork({ rootId: "460", rootType: "company" });
  const url = lastUrl("/insider/shareholding/network");
  assert.equal(url.pathname, "/insider/shareholding/network");
  assert.equal(url.searchParams.get("root_id"), "460");
  assert.equal(url.searchParams.get("root_type"), "SHAREHOLDING_NETWORK_NODE_TYPE_COMPANY");
  for (const absent of ["max_depth", "max_edge_per_node", "report_date"]) {
    assert.equal(url.searchParams.has(absent), false, `${absent} should not have been sent`);
  }
  assert.equal(result.entriesFrom, "links");
  assert.equal(result.entryCount, 1);
  assert.equal(result.nodeCount, 2);

  await getShareholdingNetwork({
    rootId: "9001",
    rootType: "INVESTOR",
    maxDepth: 2,
    maxEdgePerNode: 5,
    reportDate: "2026-06-30",
  });
  const q = lastUrl("/insider/shareholding/network").searchParams;
  assert.equal(q.get("root_type"), "SHAREHOLDING_NETWORK_NODE_TYPE_INVESTOR");
  assert.equal(q.get("max_depth"), "2");
  assert.equal(q.get("max_edge_per_node"), "5");
  assert.equal(q.get("report_date"), "2026-06-30");
});

test("shareholding network rejects a malformed root before the wire", async () => {
  const before = counts.network ?? 0;
  for (const opts of [
    { rootId: "460/../x", rootType: "COMPANY" },
    { rootId: "460", rootType: "com pany" },
    { rootId: "460", rootType: "COMPANY", maxDepth: 0 },
    { rootId: "460", rootType: "COMPANY", reportDate: "20260630" },
  ]) {
    await assert.rejects(
      () => getShareholdingNetwork(opts),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      JSON.stringify(opts),
    );
  }
  assert.equal(counts.network ?? 0, before);
  // The builder's own output is what the assertions above are about; prove it directly too.
  assert.deepEqual(buildShareholdingNetworkParams({ rootId: "1", rootType: "investor" }), {
    root_id: "1",
    root_type: "SHAREHOLDING_NETWORK_NODE_TYPE_INVESTOR",
  });
});

test("shareholding caches per subject, not per route", async () => {
  clearCache();
  const before = counts.companies ?? 0;
  await getShareholdingCompanies("BBRI");
  await getShareholdingCompanies("BBRI");
  await getShareholdingCompanies("BBCA");
  assert.equal((counts.companies ?? 0) - before, 2);
});

/* ---------------------------- ownership composition ---------------------------- */

test("ownership_composition sends no period parameters when none were given", async () => {
  const result = await getOwnershipComposition("bbri");
  const url = lastUrl("/insider/shareholding/composition/companies/");
  assert.equal(url.pathname, "/insider/shareholding/composition/companies/BBRI");
  assert.equal(url.search, "");
  assert.equal(result.symbol, "BBRI");
  assert.equal(result.periodStart, undefined);
  // Nothing is renamed: the payload comes back exactly as sent.
  assert.deepEqual(result.data, { periods: [{ period: "2026-07", local: 46.8, foreign: 53.2 }] });
});

test("ownership_composition sends both period ends together", async () => {
  await getOwnershipComposition("BBRI", "2026-01-01", "2026-06-30");
  const q = lastUrl("/insider/shareholding/composition/companies/").searchParams;
  assert.equal(q.get("period_start"), "2026-01-01");
  assert.equal(q.get("period_end"), "2026-06-30");

  const before = counts.composition ?? 0;
  await assert.rejects(
    () => getOwnershipComposition("BBRI", "2026-01-01"),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(counts.composition ?? 0, before, "a half-specified period must not reach the wire");
});

test("ownership_composition distinguishes its two windows in the cache", async () => {
  clearCache();
  const before = counts.composition ?? 0;
  await getOwnershipComposition("BBRI");
  await getOwnershipComposition("BBRI");
  await getOwnershipComposition("BBRI", "2026-01-01", "2026-06-30");
  assert.equal((counts.composition ?? 0) - before, 2);
});
