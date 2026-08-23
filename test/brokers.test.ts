// Isolate the token store before importing anything that reads it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-brokers-"));

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import {
  buildActivityParams,
  getBandarDetector,
  getBrokerActivity,
  getBrokerDirectory,
  getBrokerTop,
} from "../src/core/brokers.ts";
import { getBrokerSummary } from "../src/core/marketdetectors.ts";
import { registerBrokerTools } from "../src/tools/brokers.ts";
import type { Definer, ToolHandler } from "../src/tools/_define.ts";
import { StockbitError } from "../src/http/errors.ts";
import { HOSTS } from "../src/config.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* --------------------------------- fixtures --------------------------------- */

/**
 * Three directory rows spelled three ways on purpose: the one key set the projection expects, a
 * second plausible one, and a row it cannot read at all. A projection that only ever meets rows it
 * understands proves nothing about a route nobody has observed.
 */
const DIRECTORY_BODY = {
  data: {
    result: [
      { code: "YP", name: "Mirae Asset Sekuritas Indonesia", group: "LOKAL" },
      { broker_code: "CC", broker_name: "Mandiri Sekuritas" },
      { id: 41, description: "unreadable row" },
    ],
    total: 3,
  },
};

const ACTIVITY_BODY = {
  data: {
    list: [
      { symbol: "BBRI", net_value: "445525972000", total_volume: "1200" },
      { stock_code: "TLKM", net_value: "-2000000" },
      { unexpected: 1 },
    ],
  },
};

const TOP_BODY = {
  data: [
    { code: "AK", name: "UBS Sekuritas Indonesia", total_value: "9912000000" },
    { something_else: true },
  ],
};

/**
 * A broker summary whose wire order is NOT the sorted order (YP, CC, XL by value: 100k, 500k,
 * 400k). The bandar reading must sort it, and must not sort the cached summary in place.
 */
const SUMMARY_BODY = {
  data: {
    broker_summary: {
      symbol: "BBRI",
      brokers_buy: [
        { netbs_broker_code: "YP", type: "Lokal", blot: "10", bval: "100000", freq: "5" },
        { netbs_broker_code: "CC", type: "Lokal", blot: "50", bval: "500000" },
        { netbs_broker_code: "XL", type: "Asing", blot: "40", bval: "400000" },
      ],
      brokers_sell: [
        { netbs_broker_code: "BK", type: "Asing", slot: "60", sval: "600000" },
        { netbs_broker_code: "DX", type: "Pemerintah", slot: "40", sval: "400000" },
      ],
    },
    bandar_detector: { verdict: "whatever Stockbit calls it" },
    from: "2026-08-03",
    to: "2026-08-03",
  },
};

/** Same shape with nothing on the sell side — the case where a share must be null, not 0. */
const SUMMARY_ONE_SIDED = {
  data: {
    broker_summary: {
      symbol: "TLKM",
      brokers_buy: [{ netbs_broker_code: "YP", blot: "10", bval: "100000" }],
      brokers_sell: [],
    },
    from: "2026-08-03",
    to: "2026-08-03",
  },
};

/* ---------------------------------- the wire ---------------------------------- */

const realFetch = globalThis.fetch;
const seenUrls: string[] = [];
const requests = { directory: 0, activity: 0, top: 0, summary: 0 };

/** What the next activity call should answer with. Lets one test drive an empty/odd envelope. */
let activityBody: unknown = ACTIVITY_BODY;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function lastUrl(fragment: string): URL {
  const found = [...seenUrls].reverse().find((u) => u.includes(fragment));
  assert.ok(found, `no request matching ${fragment} was made`);
  return new URL(found);
}

/** The path as segments, so an exact assertion needs no literal path string. */
function segments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.includes("login/refresh")) {
      return json({ data: { access_token: farFutureJwt() } });
    }
    if (u.includes("marketdetectors/brokers")) {
      requests.directory++;
      return json(DIRECTORY_BODY);
    }
    if (u.includes("broker/activity")) {
      requests.activity++;
      return json(activityBody);
    }
    if (u.includes("broker/top")) {
      requests.top++;
      return json(TOP_BODY);
    }
    if (u.includes("marketdetectors/TLKM")) {
      requests.summary++;
      return json(SUMMARY_ONE_SIDED);
    }
    if (u.includes("marketdetectors/")) {
      requests.summary++;
      return json(SUMMARY_BODY);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  clearCache();
  seenUrls.length = 0;
  activityBody = ACTIVITY_BODY;
  requests.directory = 0;
  requests.activity = 0;
  requests.top = 0;
  requests.summary = 0;
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

/* --------------------------------- directory --------------------------------- */

test("directory: sends page and limit on the declared path, defaulting to 1/150", async () => {
  await getBrokerDirectory();
  const url = lastUrl("marketdetectors/brokers");
  assert.equal(url.origin, HOSTS.exodus);
  assert.deepEqual(segments(url), ["findata-view", "marketdetectors", "brokers"]);
  assert.equal(url.searchParams.get("page"), "1");
  assert.equal(url.searchParams.get("limit"), "150");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["limit", "page"]);
});

test("directory: projects code/name, names the key each came from, and keeps the raw row", async () => {
  const dir = await getBrokerDirectory({ limit: 3 });

  assert.equal(dir.rowsFrom, "result");
  assert.deepEqual(dir.dataKeys, ["result", "total"]);
  assert.equal(dir.count, 3);

  assert.equal(dir.brokers[0].code, "YP");
  assert.equal(dir.brokers[0].name, "Mirae Asset Sekuritas Indonesia");
  assert.deepEqual(dir.brokers[0].readFrom, { code: "code", name: "name" });
  // Nothing is dropped: a field the projection has no opinion about survives on the raw row.
  assert.equal(dir.brokers[0].row.group, "LOKAL");

  assert.equal(dir.brokers[1].code, "CC");
  assert.deepEqual(dir.brokers[1].readFrom, { code: "broker_code", name: "broker_name" });

  // The row nothing could be read from is reported as unmapped rather than silently dropped, and
  // its keys are handed back so the wrong guess can be corrected without another live probe.
  assert.equal(dir.brokers[2].code, undefined);
  assert.deepEqual(dir.unmapped, { count: 1, sampleKeys: ["id", "description"] });
});

test("directory: a different limit is a different cache entry", async () => {
  await getBrokerDirectory({ limit: 150 });
  await getBrokerDirectory({ limit: 150 });
  assert.equal(requests.directory, 1, "identical arguments must be served from cache");

  await getBrokerDirectory({ limit: 20 });
  assert.equal(requests.directory, 2, "a narrower page must not be answered from the wide one");
  assert.equal(lastUrl("marketdetectors/brokers").searchParams.get("limit"), "20");
});

test("directory: a rejected page size never reaches the wire", async () => {
  await assert.rejects(() => getBrokerDirectory({ limit: 0 }), (e: unknown) => {
    assert.ok(e instanceof StockbitError);
    assert.equal(e.kind, "invalid_param");
    return true;
  });
  await assert.rejects(() => getBrokerDirectory({ page: "second" }), StockbitError);
  assert.equal(requests.directory, 0);
});

/* ---------------------------------- activity ---------------------------------- */

test("activity: market_type and investor_type REPEAT on the wire, never comma-joined", async () => {
  await getBrokerActivity({
    brokerCode: "yp",
    period: "LAST_7_DAYS",
    // The duplicate is deliberate: it must collapse, not repeat.
    marketTypes: ["REGULER", "NEGO", "REGULER"],
    investorTypes: ["FOREIGN", "DOMESTIC"],
    sortBy: "net_value",
    limit: 20,
  });

  const url = lastUrl("broker/activity");
  assert.equal(url.origin, HOSTS.exodus);
  assert.deepEqual(segments(url), ["order-trade", "broker", "activity"]);

  assert.deepEqual(url.searchParams.getAll("market_type"), [
    "MARKET_TYPE_REGULER",
    "MARKET_TYPE_NEGO",
  ]);
  assert.deepEqual(url.searchParams.getAll("investor_type"), [
    "INVESTOR_TYPE_FOREIGN",
    "INVESTOR_TYPE_DOMESTIC",
  ]);
  // A joined list is read as one unknown value and answered NARROWER, with a 200. Assert on the
  // encoded URL, which is what the server actually receives.
  assert.ok(!url.search.includes("%2C"), `comma-joined parameters in ${url.search}`);
  assert.ok(!url.search.includes(","), `raw comma in ${url.search}`);

  assert.equal(url.searchParams.get("broker_code"), "YP");
  assert.equal(url.searchParams.get("period"), "TB_PERIOD_LAST_7_DAYS");
  assert.equal(url.searchParams.get("sort_by"), "SORT_BY_NET_VALUE");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.has("page"), false, "an omitted page must be absent, not empty");
});

test("activity: omitted filters are absent parameters, not empty ones", async () => {
  await getBrokerActivity({ brokerCode: "CC", marketTypes: [] });
  const url = lastUrl("broker/activity");
  assert.deepEqual([...url.searchParams.keys()], ["broker_code"]);
  assert.equal(url.searchParams.get("broker_code"), "CC");
});

test("activity: projects the traded symbol and leaves the figures in the raw row", async () => {
  const activity = await getBrokerActivity({ brokerCode: "YP" });

  assert.equal(activity.brokerCode, "YP");
  assert.deepEqual(activity.request, { broker_code: "YP" });
  assert.equal(activity.rowsFrom, "list");
  assert.equal(activity.count, 3);

  assert.equal(activity.rows[0].symbol, "BBRI");
  assert.deepEqual(activity.rows[0].readFrom, { symbol: "symbol" });
  // Deliberately NOT renamed: the value field's wire name is unverified, so it stays in `row`.
  assert.equal(activity.rows[0].row.net_value, "445525972000");
  assert.equal(activity.rows[1].symbol, "TLKM");
  assert.deepEqual(activity.rows[1].readFrom, { symbol: "stock_code" });
  assert.equal(activity.rows[2].symbol, undefined);
  assert.deepEqual(activity.unmapped, { count: 1, sampleKeys: ["unexpected"] });
});

test("activity: a null data block is an empty result, and says it found no array", async () => {
  activityBody = { data: null };
  const activity = await getBrokerActivity({ brokerCode: "ZZ" });
  assert.deepEqual(activity.rows, []);
  assert.equal(activity.count, 0);
  assert.equal(activity.rowsFrom, null, "an empty answer must be distinguishable from a missed one");
  assert.deepEqual(activity.dataKeys, []);
});

test("activity: an envelope with no array reports what it did carry instead of claiming zero rows", async () => {
  activityBody = { data: { message: "no activity", total: 0 } };
  const activity = await getBrokerActivity({ brokerCode: "ZY" });
  assert.equal(activity.count, 0);
  assert.equal(activity.rowsFrom, null);
  assert.deepEqual(activity.dataKeys, ["message", "total"]);
});

test("activity: a scalar under data is drift, not an empty page", async () => {
  activityBody = { data: "unavailable" };
  await assert.rejects(() => getBrokerActivity({ brokerCode: "ZX" }), (e: unknown) => {
    assert.ok(e instanceof StockbitError);
    assert.equal(e.kind, "schema_drift");
    return true;
  });
});

test("activity: rejected arguments never reach the wire", async () => {
  await assert.rejects(() => getBrokerActivity({ brokerCode: "TOOLONG" }), StockbitError);
  await assert.rejects(() => getBrokerActivity({ brokerCode: "YP/../x" }), StockbitError);
  // A plausible misspelling of a board. It must fail here rather than be sent and ignored.
  await assert.rejects(() => getBrokerActivity({ brokerCode: "YP", marketTypes: ["REGULAR"] }), StockbitError);
  await assert.rejects(() => getBrokerActivity({ brokerCode: "YP", period: "LAST_30_DAYS" }), StockbitError);
  await assert.rejects(() => getBrokerActivity({ brokerCode: "YP", sortBy: "net value" }), StockbitError);
  assert.equal(requests.activity, 0);
});

test("activity: the built parameters keep the lists as arrays, with no round-trip", () => {
  const params = buildActivityParams({
    brokerCode: "yp",
    marketTypes: ["REGULER", "NEGO"],
    investorTypes: ["FOREIGN"],
  });
  // An array is what the transport turns into repeated keys; a string here would be the joined
  // form the server answers narrower rather than rejecting.
  assert.deepEqual(params.market_type, ["MARKET_TYPE_REGULER", "MARKET_TYPE_NEGO"]);
  assert.deepEqual(params.investor_type, ["INVESTOR_TYPE_FOREIGN"]);
  assert.equal(params.broker_code, "YP");
  assert.equal(params.period, undefined);
  assert.equal(params.sort_by, undefined);
});

test("activity: the cache key carries every filter, not just the broker", async () => {
  await getBrokerActivity({ brokerCode: "YP", marketTypes: ["REGULER"] });
  await getBrokerActivity({ brokerCode: "YP", marketTypes: ["REGULER"] });
  assert.equal(requests.activity, 1);

  await getBrokerActivity({ brokerCode: "YP", marketTypes: ["ALL"] });
  assert.equal(requests.activity, 2, "a different board must not be served the REGULER answer");

  await getBrokerActivity({ brokerCode: "YP", marketTypes: ["REGULER"], period: "LAST_7_DAYS" });
  assert.equal(requests.activity, 3, "a different window must not be served the earlier answer");
});

/* ------------------------------------ top ------------------------------------ */

test("top: sends only what was asked for, and reads a bare data array", async () => {
  const top = await getBrokerTop({ period: "YEAR_TO_DATE", sortBy: "TOTAL_VALUE" });

  const url = lastUrl("broker/top");
  assert.deepEqual(segments(url), ["order-trade", "broker", "top"]);
  assert.equal(url.searchParams.get("period"), "TB_PERIOD_YEAR_TO_DATE");
  assert.equal(url.searchParams.get("sort_by"), "SORT_BY_TOTAL_VALUE");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["period", "sort_by"]);

  assert.equal(top.rowsFrom, "data");
  assert.equal(top.brokers[0].code, "AK");
  assert.equal(top.brokers[0].name, "UBS Sekuritas Indonesia");
  assert.equal(top.brokers[0].row.total_value, "9912000000");
  assert.deepEqual(top.unmapped, { count: 1, sampleKeys: ["something_else"] });
  assert.deepEqual(top.request, { period: "TB_PERIOD_YEAR_TO_DATE", sort_by: "SORT_BY_TOTAL_VALUE" });
});

test("top: with no arguments it sends no query at all", async () => {
  await getBrokerTop();
  const url = lastUrl("broker/top");
  assert.equal(url.search, "", "an unasked-for filter must not be invented on the caller's behalf");
});

test("top: a different sort is a different cache entry", async () => {
  await getBrokerTop({ sortBy: "NET_VALUE" });
  await getBrokerTop({ sortBy: "NET_VALUE" });
  assert.equal(requests.top, 1);
  await getBrokerTop({ sortBy: "TOTAL_VOLUME" });
  assert.equal(requests.top, 2);
});

/* ------------------------------- bandar detector ------------------------------- */

test("bandar: totals, ordering and concentration come off the broker summary", async () => {
  const reading = await getBandarDetector({ symbol: "bbri", top: 2 });

  // It runs on the summary route; it does not invent a request of its own.
  assert.deepEqual(segments(lastUrl("marketdetectors/BBRI")), ["marketdetectors", "BBRI"]);
  assert.equal(requests.activity + requests.directory + requests.top, 0);

  assert.equal(reading.symbol, "BBRI");
  assert.equal(reading.from, "2026-08-03");
  assert.equal(reading.buyValueIdr, 1_000_000);
  assert.equal(reading.sellValueIdr, 1_000_000);
  // Near zero is the CORRECT reading of a complete NET table: both sides are the same trades.
  assert.equal(reading.netValueIdr, 0);
  assert.equal(reading.buyLots, 100);
  assert.equal(reading.netLots, 0);

  assert.deepEqual(reading.topAccumulators.map((b) => b.code), ["CC", "XL"], "sorted by value, trimmed to top");
  assert.deepEqual(reading.topDistributors.map((b) => b.code), ["BK", "DX"]);
  assert.equal(reading.topAccumulators[0].netValueIdr, 500_000);
  assert.equal(reading.topAccumulators[0].investorType, "Lokal");

  assert.equal(reading.concentration.topBuyerShare, 0.5);
  assert.equal(reading.concentration.top3BuyerShare, 1);
  assert.equal(reading.concentration.buyHerfindahl, 0.25 + 0.16 + 0.01);
  assert.equal(reading.concentration.buyersListed, 3);
  assert.equal(reading.concentration.sellersListed, 2);

  // Stockbit's own block is passed through rather than dropped or parsed.
  assert.deepEqual(reading.stockbitBandarDetector, { verdict: "whatever Stockbit calls it" });
});

test("bandar: does not reorder the cached summary the rest of the process reads", async () => {
  await getBandarDetector({ symbol: "BBRI" });
  const summary = await getBrokerSummary({ symbol: "BBRI" });
  assert.equal(requests.summary, 1, "the reading must reuse the summary's cache entry");
  assert.deepEqual(
    summary.buyers.map((b) => b.code),
    ["YP", "CC", "XL"],
    "the summary must still be in wire order — sorting it in place would corrupt every later reader",
  );
});

test("bandar: an empty side gives null shares, never a share of zero", async () => {
  const reading = await getBandarDetector({ symbol: "TLKM" });
  assert.equal(reading.sellValueIdr, 0);
  assert.equal(reading.netValueIdr, 100_000);
  assert.deepEqual(reading.topDistributors, []);
  assert.equal(reading.concentration.topSellerShare, null);
  assert.equal(reading.concentration.sellHerfindahl, null);
  assert.equal(reading.concentration.topBuyerShare, 1);
});

test("bandar: an out-of-range `top` is rejected before any request", async () => {
  await assert.rejects(() => getBandarDetector({ symbol: "BBRI", top: 0 }), StockbitError);
  await assert.rejects(() => getBandarDetector({ symbol: "BBRI", top: 51 }), StockbitError);
  assert.equal(requests.summary, 0);
});

/* ------------------------------ the tool surface ------------------------------ */

/** A Definer that records instead of registering, so the tool layer can be driven directly. */
function fakeDefiner(): { definer: Definer; reads: Map<string, ToolHandler>; writes: string[] } {
  const reads = new Map<string, ToolHandler>();
  const writes: string[] = [];
  const definer: Definer = {
    read: (name, _description, _shape, handler) => {
      reads.set(name, handler);
    },
    write: (name) => {
      writes.push(name);
    },
    writeNames: () => [...writes],
  };
  return { definer, reads, writes };
}

test("tools: four reads, no writes, and the arguments the model sends reach the wire", async () => {
  const { definer, reads, writes } = fakeDefiner();
  registerBrokerTools(definer);

  assert.deepEqual([...reads.keys()].sort(), [
    "bandar_detector",
    "broker_activity",
    "broker_top",
    "brokers",
  ]);
  assert.deepEqual(writes, [], "nothing in this family changes anything");

  // Driven through the handler, not the core call, so a stale inline argument object at the call
  // site is caught here rather than shipped.
  const result = await reads.get("broker_activity")!({
    broker_code: "XL",
    market_types: ["REGULER", "NEGO"],
    investor_types: ["FOREIGN"],
    period: "LAST_1_DAY",
    sort_by: "TOTAL_VALUE",
    page: 2,
    limit: 10,
  });
  assert.equal((result as { isError?: boolean }).isError, false);

  const url = lastUrl("broker/activity");
  assert.equal(url.searchParams.get("broker_code"), "XL");
  assert.deepEqual(url.searchParams.getAll("market_type"), ["MARKET_TYPE_REGULER", "MARKET_TYPE_NEGO"]);
  assert.deepEqual(url.searchParams.getAll("investor_type"), ["INVESTOR_TYPE_FOREIGN"]);
  assert.equal(url.searchParams.get("period"), "TB_PERIOD_LAST_1_DAY");
  assert.equal(url.searchParams.get("sort_by"), "SORT_BY_TOTAL_VALUE");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("limit"), "10");
});

test("tools: bandar_detector passes its window and board through to the summary request", async () => {
  const { definer, reads } = fakeDefiner();
  registerBrokerTools(definer);

  await reads.get("bandar_detector")!({
    symbol: "BBRI",
    from: "2026-07-28",
    to: "2026-08-01",
    market_board: "ALL",
    transaction_type: "GROSS",
    investor_type: "FOREIGN",
    limit: 25,
    top: 1,
  });

  const url = lastUrl("marketdetectors/BBRI");
  assert.equal(url.searchParams.get("from"), "2026-07-28");
  assert.equal(url.searchParams.get("to"), "2026-08-01");
  assert.equal(url.searchParams.get("market_board"), "MARKET_BOARD_ALL");
  assert.equal(url.searchParams.get("transaction_type"), "TRANSACTION_TYPE_GROSS");
  assert.equal(url.searchParams.get("investor_type"), "INVESTOR_TYPE_FOREIGN");
  assert.equal(url.searchParams.get("limit"), "25");
  // A window was given, so the preset must NOT also be sent — the API would ignore the dates.
  assert.equal(url.searchParams.has("period"), false);
});

test("tools: a bad broker code comes back as an error result, not a thrown handler", async () => {
  const { definer, reads } = fakeDefiner();
  registerBrokerTools(definer);

  const result = (await reads.get("broker_activity")!({ broker_code: "not a code" })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text) as { kind: string };
  assert.equal(payload.kind, "invalid_param");
  assert.equal(requests.activity, 0);
});
