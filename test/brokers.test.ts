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
  withBrokerNames,
  withBrokerNamesAll,
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
      // NEGATIVE, because that is what the wire sends — see test/fixtures/broker_summary_BBRI.json
      // and the sign note atop src/core/marketdetectors.ts. This fixture used to carry positive
      // sells, which made every assertion below agree with the code and disagree with reality.
      brokers_sell: [
        { netbs_broker_code: "BK", type: "Asing", slot: "-60", sval: "-600000" },
        { netbs_broker_code: "DX", type: "Pemerintah", slot: "-40", sval: "-400000" },
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

/**
 * Figures this server will not parse, beside ones it will.
 *
 * `"n/a"` used to become NaN and poison every total it was summed into; a thousand-separated value
 * is refused rather than guessed at, because the two Indonesian conventions disagree about which
 * separator is the decimal one. Both used to be reported as the number zero.
 */
const SUMMARY_UNREADABLE = {
  data: {
    broker_summary: {
      symbol: "GOTO",
      brokers_buy: [
        { netbs_broker_code: "YP", blot: "10", bval: "1e+5", freq: "" },
        { netbs_broker_code: "CC", blot: "20", bval: "n/a" },
        { netbs_broker_code: "XL", blot: "1,234", bval: "300000" },
        // Only a DECORATIVE field fails here. This row is wholly inside every total.
        { netbs_broker_code: "ZP", blot: "5", bval: "50000", freq: "many" },
      ],
      brokers_sell: [{ netbs_broker_code: "BK", slot: "-5", sval: "-50000" }],
    },
    from: "2026-08-03",
    to: "2026-08-03",
  },
};

/**
 * A buy row that carries no `bval` at all — nothing was refused here, the wire simply did not send
 * it. The broker still cannot enter `buyValueIdr`, so the reading has to say a total is short. It
 * used to say nothing: `netValueIdr` came out at 0, which the description reads as "a complete NET
 * table, both sides are the same trades".
 */
const SUMMARY_ABSENT_FLOW = {
  data: {
    broker_summary: {
      symbol: "ASII",
      brokers_buy: [
        { netbs_broker_code: "YP", blot: "10", bval: "100000" },
        { netbs_broker_code: "CC", blot: "20" },
        { netbs_broker_code: "XL", blot: "30", bval: "300000" },
      ],
      brokers_sell: [{ netbs_broker_code: "BK", slot: "-40", sval: "-400000" }],
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

/** Set non-200 to make the directory route fail, so name resolution's degraded path is exercised. */
let directoryStatus = 200;

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
      if (directoryStatus !== 200) return new Response("upstream is unhappy", { status: directoryStatus });
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
    if (u.includes("marketdetectors/GOTO")) {
      requests.summary++;
      return json(SUMMARY_UNREADABLE);
    }
    if (u.includes("marketdetectors/ASII")) {
      requests.summary++;
      return json(SUMMARY_ABSENT_FLOW);
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
  directoryStatus = 200;
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

test("directory: codes keeps only those houses, and costs no extra request", async () => {
  // The point of the filter: resolving two codes out of a broker_summary used to mean pulling all
  // 112 rows and joining locally. It is applied to the cached directory, so it is the SAME fetch.
  await getBrokerDirectory({ limit: 3 });
  assert.equal(requests.directory, 1);

  const one = await getBrokerDirectory({ limit: 3, codes: ["CC"] });
  assert.equal(requests.directory, 1, "the filter must be served from the cached directory");
  assert.equal(one.count, 1);
  assert.deepEqual(
    one.brokers.map((b) => b.code),
    ["CC"],
  );
  assert.deepEqual(one.filteredTo, ["CC"]);
  assert.deepEqual(one.notFound, [], "an empty notFound is the good answer, and is stated not omitted");
});

test("directory: a code the directory does not carry is NAMED, not silently dropped", async () => {
  const dir = await getBrokerDirectory({ limit: 3, codes: ["YP", "ZZ"] });
  assert.deepEqual(
    dir.brokers.map((b) => b.code),
    ["YP"],
  );
  assert.deepEqual(dir.notFound, ["ZZ"]);
  // The count describes what came back, so it cannot disagree with the list beside it.
  assert.equal(dir.count, dir.brokers.length);
});

test("directory: codes is case-insensitive and deduplicated", async () => {
  const dir = await getBrokerDirectory({ limit: 3, codes: ["cc", "CC", " yp "] });
  assert.deepEqual(dir.filteredTo, ["CC", "YP"], "normalized, deduplicated, in the order asked");
  assert.equal(dir.count, 2);
  assert.deepEqual(dir.notFound, []);
});

test("directory: filtering never mutates the shared cache entry", async () => {
  // `full` is the object every later caller of that cache key receives. Trimming it in place would
  // hand the next caller this caller's filter — the trap getBandarDetector documents when it sorts.
  await getBrokerDirectory({ limit: 3, codes: ["CC"] });
  const all = await getBrokerDirectory({ limit: 3 });
  assert.equal(all.count, 3, "the unfiltered directory must still be whole");
  assert.equal(all.filteredTo, undefined);
  assert.equal(all.notFound, undefined);
  assert.equal(requests.directory, 1, "all of it from one fetch");
});

test("directory: a malformed or empty codes list is refused before the wire", async () => {
  await assert.rejects(
    () => getBrokerDirectory({ codes: ["AK!"] }),
    (e: unknown) => {
      assert.ok(e instanceof StockbitError);
      assert.equal(e.kind, "invalid_param");
      return true;
    },
  );
  // Empty is refused rather than read as "no filter": the two readings are opposite, and guessing
  // is how a caller asking for nothing receives the whole exchange.
  await assert.rejects(() => getBrokerDirectory({ codes: [] }), StockbitError);
  await assert.rejects(() => getBrokerDirectory({ codes: "AK" }), StockbitError);
  assert.equal(requests.directory, 0);
});

/* ------------------------------- resolving names ------------------------------- */

test("names: a code the directory carries gains its house, one absent from it does not", async () => {
  const { rows, resolution } = await withBrokerNames([
    { code: "YP", netValueIdr: 100 },
    { code: "ZZ", netValueIdr: -50 },
  ]);
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.note, undefined);
  assert.equal(rows[0].name, "Mirae Asset Sekuritas Indonesia");
  // Absent, not "unknown": a placeholder would make an unresolved code and a nameless broker read
  // the same, which is the whole reason this project refuses defaults.
  assert.equal(rows[1].name, undefined);
  assert.equal(rows[1].netValueIdr, -50, "the figures are untouched either way");
});

test("names: the join normalizes the row's code, which the wire does not", async () => {
  // The two sides arrive differently normalized. A directory code has passed `isCode` and is upper
  // case by construction; a summary row's `code` is `netbs_broker_code` verbatim off the wire. A
  // raw join would lose the name for a lower-case row and lose it SILENTLY — indistinguishable
  // from a broker the directory has never heard of.
  const { rows } = await withBrokerNames([{ code: "yp" }, { code: " cc " }]);
  assert.equal(rows[0].name, "Mirae Asset Sekuritas Indonesia");
  assert.equal(rows[1].name, "Mandiri Sekuritas");
});

test("names: a directory that cannot be read costs the names, never the numbers", async () => {
  directoryStatus = 500;
  const { rows, resolution } = await withBrokerNames([{ code: "YP", netValueIdr: 100 }]);
  assert.equal(resolution.resolved, false);
  assert.ok(resolution.note, "a failure must say so rather than look like an empty directory");
  assert.match(resolution.note, /not resolved/);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "YP");
  assert.equal(rows[0].name, undefined);
  assert.equal(rows[0].netValueIdr, 100, "the flow figure survives a lookup failure");
});

test("names: the note carries the failure KIND and no URL", async () => {
  directoryStatus = 401;
  const { resolution } = await withBrokerNames([{ code: "YP" }]);
  assert.equal(resolution.resolved, false);
  assert.doesNotMatch(resolution.note ?? "", /https?:\/\//, "a note must not quote the request URL");
  assert.doesNotMatch(resolution.note ?? "", /stockbit\.com/i);
});

test("names: the caller's rows are copied, never written into", async () => {
  const input = [{ code: "YP" }];
  const { rows } = await withBrokerNames(input);
  assert.equal(input[0].name, undefined, "the array handed in must come back unchanged");
  assert.notEqual(rows[0], input[0]);
});

test("names: several row-sets share ONE directory read, even when it fails", async () => {
  // A summary has two sides. Resolving them with two calls is invisible on success — the second is
  // a cache hit — and doubles the damage on failure: two failed requests, and two identical notes
  // of which the caller keeps one.
  directoryStatus = 500;

  // Measured against a ONE-set call rather than against the literal number 1: the HTTP client
  // retries a 500, so the raw request count is the retry budget, not the number of reads. What
  // must hold is that two sides cost the same as one.
  await withBrokerNames([{ code: "YP" }]);
  const oneSet = requests.directory;
  assert.ok(oneSet > 0, "the failing path must actually have tried");

  clearCache();
  requests.directory = 0;
  const out = await withBrokerNamesAll([[{ code: "YP" }], [{ code: "CC" }]]);
  assert.equal(requests.directory, oneSet, "two sides must cost one directory read, not two");
  assert.equal(out.length, 2);
  for (const side of out) {
    assert.equal(side.resolution.resolved, false);
    assert.ok(side.resolution.note);
  }
  assert.equal(out[0].rows[0].code, "YP");
  assert.equal(out[1].rows[0].code, "CC");
});

test("names: the shared read resolves every set on success too", async () => {
  const out = await withBrokerNamesAll([[{ code: "YP" }], [{ code: "CC" }, { code: "ZZ" }]]);
  assert.equal(requests.directory, 1);
  assert.equal(out[0].rows[0].name, "Mirae Asset Sekuritas Indonesia");
  assert.equal(out[1].rows[0].name, "Mandiri Sekuritas");
  assert.equal(out[1].rows[1].name, undefined, "a code the directory lacks still gets no name");
});

test("names: resolving reuses the cached directory rather than fetching per call", async () => {
  await withBrokerNames([{ code: "YP" }]);
  await withBrokerNames([{ code: "CC" }]);
  assert.equal(requests.directory, 1, "the join is free once the directory is warm");
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
  assert.equal(reading.sellValueIdr, -1_000_000, "the sell total carries the wire's sign");
  // Near zero is the CORRECT reading of a complete NET table: both sides are the same trades.
  assert.equal(reading.netValueIdr, 0);
  assert.equal(reading.buyLots, 100);
  assert.equal(reading.sellLots, -100);
  assert.equal(reading.netLots, 0);

  assert.deepEqual(reading.topAccumulators.map((b) => b.code), ["CC", "XL"], "sorted by value, trimmed to top");
  assert.deepEqual(reading.topDistributors.map((b) => b.code), ["BK", "DX"]);
  assert.equal(reading.topAccumulators[0].netValueIdr, 500_000);
  assert.equal(reading.topAccumulators[0].investorType, "Lokal");

  assert.equal(reading.concentration.topBuyerShare, 0.5);
  assert.equal(reading.concentration.top3BuyerShare, 1);
  assert.equal(reading.concentration.buyHerfindahl, 0.25 + 0.16 + 0.01);
  // The sell side has real numbers here. It used to be null on every call, because the shares were
  // divided by a negative total, and the tool description reads a null share to the model as
  // "nothing traded on that side".
  assert.equal(reading.concentration.topSellerShare, 0.6);
  assert.equal(reading.concentration.top3SellerShare, 1);
  assert.equal(reading.concentration.sellHerfindahl, 0.36 + 0.16);
  assert.equal(reading.concentration.buyersListed, 3);
  assert.equal(reading.concentration.sellersListed, 2);
  assert.equal(reading.unreadable, undefined, "every figure in this fixture parses");

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

test("summary: a figure that cannot be read is ABSENT, never zero and never NaN", async () => {
  const summary = await getBrokerSummary({ symbol: "GOTO" });
  const by = new Map(summary.buyers.map((b) => [b.code, b]));

  // E-notation is what this wire actually sends, so it must keep parsing.
  assert.equal(by.get("YP")!.netValueIdr, 100_000);

  // Present but unparseable. `Number("n/a")` is NaN, which serialises to null in JSON and reaches
  // the model as an unexplained absence; `s == null ? 0` reported it as a broker that netted zero.
  assert.equal(by.get("CC")!.netValueIdr, undefined);
  assert.equal(by.get("CC")!.netLots, 20, "the readable field on the same row still comes through");

  // Refused rather than guessed at: "1,234" is 1234 under one convention and 1.234 under the other.
  assert.equal(by.get("XL")!.netLots, undefined);
  assert.equal(by.get("XL")!.netValueIdr, 300_000);

  // An empty string is ABSENT, not unreadable — Stockbit uses "" for "no value here" across this
  // API, and `numberish` in src/core/pricefeed.ts already reads it that way.
  assert.equal(by.get("YP")!.freq, undefined);

  // `freq` feeds no total, so ZP is wholly inside buyValueIdr and buyLots. Counting it in `rows`
  // would tell the model a complete total was short by a broker. The key is still named.
  assert.equal(by.get("ZP")!.netValueIdr, 50_000);
  assert.equal(by.get("ZP")!.freq, undefined);

  assert.deepEqual(summary.unreadable, { buyers: 2, sellers: 0, keys: ["blot", "bval", "freq"] });
});

test("summary: an unreadable DECORATIVE field names its key but costs no total a broker", async () => {
  const summary = await getBrokerSummary({ symbol: "GOTO" });
  const readableValues = summary.buyers.filter((b) => b.netValueIdr !== undefined).length;

  // rows counts brokers a total had to leave out. Three of the four buy rows have a readable bval,
  // and only CC's is missing — so exactly one buy row is a hole in buyValueIdr.
  assert.equal(readableValues, 3);
  assert.ok(summary.unreadable!.keys.includes("freq"), "the key is reported");
  assert.equal(summary.unreadable!.buyers, 2, "CC (bval) and XL (blot) — not ZP, whose freq is cosmetic");
  assert.equal(summary.unreadable!.sellers, 0, "the sell side parsed completely");
});

test("bandar: unreadable rows are left out of the totals, not counted as zero", async () => {
  const reading = await getBandarDetector({ symbol: "GOTO" });

  // 1e+5 + 300000. CC's unreadable bval is excluded; summing it as NaN would make every figure
  // below null, and summing it as 0 would silently deflate the concentration denominators.
  assert.equal(reading.buyValueIdr, 450_000); // YP 1e+5 + XL 300000 + ZP 50000; CC's bval is not readable
  assert.equal(reading.buyLots, 35); // YP 10 + CC 20 + ZP 5; XL's "1,234" is not readable
  assert.equal(reading.sellValueIdr, -50_000);
  assert.equal(reading.netValueIdr, 400_000);

  for (const v of [reading.buyValueIdr, reading.sellValueIdr, reading.netValueIdr, reading.netLots]) {
    assert.ok(Number.isFinite(v), "one unreadable field must not poison a total with NaN");
  }
  for (const share of Object.values(reading.concentration)) {
    assert.ok(share === null || Number.isFinite(share), "no share may be NaN");
  }

  // Still listed — the row exists, it is its figures that could not be read.
  assert.equal(reading.concentration.buyersListed, 4);
  assert.deepEqual(reading.unreadable, { buyers: 2, sellers: 0, keys: ["blot", "bval", "freq"] });
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


test("summary: a flow figure the wire never sent leaves the same hole, and is reported too", async () => {
  const summary = await getBrokerSummary({ symbol: "ASII" });
  const cc = summary.buyers.find((b) => b.code === "CC")!;

  assert.equal(cc.netLots, 20, "the field that WAS sent still parses");
  assert.equal(cc.netValueIdr, undefined, "and the one that was not is absent, not zero");
  assert.deepEqual(summary.unreadable, { buyers: 1, sellers: 0, keys: ["bval"] });
});

test("bandar: a total short by one broker says so, instead of reading as a complete table", async () => {
  const reading = await getBandarDetector({ symbol: "ASII" });

  // 100000 + 300000. CC contributes nothing, because nothing is known about it.
  assert.equal(reading.buyValueIdr, 400_000);
  assert.equal(reading.sellValueIdr, -400_000);

  // A net of exactly zero is the signature of a complete NET table — and here it is NOT one.
  // Refusing to fabricate a zero for a row and then fabricating one for the total silently would
  // be the same mistake one level up, which is why `unreadable` has to be non-empty here.
  assert.equal(reading.netValueIdr, 0);
  assert.deepEqual(reading.unreadable, { buyers: 1, sellers: 0, keys: ["bval"] });

  // The shares are over the same reduced set, so the count and the denominator must not disagree
  // silently either.
  assert.equal(reading.concentration.buyersListed, 3, "three brokers were listed");
  assert.equal(reading.concentration.topBuyerShare, 0.75, "but the share is over the two that count");
  assert.equal(
    reading.concentration.buyersListed - reading.unreadable!.buyers,
    2,
    "listed minus dropped is what every buy-side figure above actually covers",
  );
});
