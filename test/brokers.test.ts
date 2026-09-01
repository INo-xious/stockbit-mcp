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
  BROKER_PERIODS,
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

/**
 * The envelope `brokerActivity` was measured returning on 2026-09-01, with no `period` sent:
 * `data = {broker_activity_transaction, from, to, broker_code, broker_name}`.
 *
 * The row KEYS inside it were not recorded, so they are still spelled three ways here — the one the
 * projection expects, a second plausible one, and a row it cannot read at all. The container is
 * measured; what sits in it is not, and the fixture says which is which.
 */
const ACTIVITY_BODY = {
  data: {
    broker_activity_transaction: [
      { symbol: "BBRI", net_value: "445525972000", total_volume: "1200" },
      { stock_code: "TLKM", net_value: "-2000000" },
      { unexpected: 1 },
    ],
    from: "2026-09-01",
    to: "2026-09-01",
    broker_code: "YP",
    broker_name: "Sekuritas Contoh Satu",
  },
};

/**
 * The shape `brokerTop` was measured returning on 2026-09-01: rows under `data.list`, provenance
 * under `data.date`, and every figure a PLAIN numeric string rather than the `{raw, formatted}`
 * pair the rest of this API sends.
 *
 * Two properties of it are load-bearing and deliberate.
 *
 * It is ASCENDING by `total_value`, because the endpoint is — the biggest house is sent LAST, which
 * is the whole defect. Any test that asserts a descending order off this fixture is asserting that
 * the sort actually ran.
 *
 * `net_value`, `buy_value` and `sell_value` carry DISTINCT values, because they do live. A field
 * report claimed all three were `"0"` on every row; the live reading contradicted it, so a fixture
 * of zeroes here would quietly re-install the bug it would then look like it was testing.
 */
const TOP_BODY = {
  data: {
    list: [
      {
        code: "ZR",
        name: "Sekuritas Contoh Kecil",
        investor_type: "ALL",
        total_value: "22485000",
        net_value: "-15025000",
        buy_value: "3730000",
        sell_value: "18755000",
        total_volume: "2200",
        total_frequency: "17",
        group: "LOKAL",
      },
      {
        code: "CC",
        name: "Sekuritas Contoh Menengah",
        investor_type: "ALL",
        total_value: "9912000000",
        net_value: "1200000000",
        buy_value: "5556000000",
        sell_value: "4356000000",
        total_volume: "410000",
        total_frequency: "3011",
        group: "LOKAL",
      },
      {
        code: "AK",
        name: "Sekuritas Contoh Besar",
        investor_type: "ALL",
        total_value: "5636360451396",
        net_value: "-88000000000",
        buy_value: "2774180225698",
        sell_value: "2862180225698",
        total_volume: "9100000",
        total_frequency: "120455",
        group: "ASING",
      },
      // A row that IS a row — it has a code — whose ranking figure will not parse. "1,234" is 1234
      // under one Indonesian convention and 1.234 under the other, so it is refused, and a broker
      // with no readable rank must not be given one.
      { code: "XL", name: "Sekuritas Contoh Tak Terbaca", total_value: "1,234", net_value: "" },
      { something_else: true },
    ],
    date: { from: "2026-09-01", to: "2026-09-01", idx: "2026-09-01" },
  },
};

/**
 * The permissive envelope, kept alive on purpose: `data` as a bare array, with no `date` beside it.
 * Only `data.list` was measured, and a reader that stopped accepting the alternatives would be
 * narrowing itself on the strength of one reading.
 */
const TOP_BARE_ARRAY_BODY = {
  data: [
    { code: "AK", name: "Sekuritas Contoh Besar", total_value: "9912000000" },
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

/** The same for the league table, so the measured shape and the permissive one both get a run. */
let topBody: unknown = TOP_BODY;

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
      return json(topBody);
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
  topBody = TOP_BODY;
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
  assert.equal(url.searchParams.get("sort_by"), "SORT_BY_NET_VALUE");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.has("page"), false, "an omitted page must be absent, not empty");
  assert.equal(url.searchParams.has("period"), false, "this endpoint 400s on every value of it");
});

test("activity: `period` is REFUSED with an explanation, not dropped on the way to the wire", async () => {
  // Measured 2026-09-01: every one of the ten BROKER_PERIODS members answers 400 here, as do eight
  // other spellings, while sending none answers 200 with rows. The control that makes that a fact
  // about `period` and not about the call: unknown keys (`tb_period`, `periode`) answer 200 and are
  // ignored, so a 400 is a RECOGNISED field refusing a value. There is no spelling left to find.
  //
  // Refused rather than silently dropped, because a filter the caller asked for and did not get is
  // worse than one that errors: they would read rows for a window they never chose.
  await assert.rejects(
    () => getBrokerActivity({ brokerCode: "YP", period: "LAST_1_DAY" }),
    (e: unknown) => {
      assert.ok(e instanceof StockbitError);
      assert.equal(e.kind, "invalid_param");
      assert.match(e.message, /no period filter/i);
      // The message has to say where the window IS, or refusing it just loses the caller a window.
      assert.match(e.message, /from.*to|`from`\/`to`/);
      return true;
    },
  );
  // The member its sibling accepts is refused here too — that pairing is the finding, so assert it.
  await assert.rejects(() => getBrokerActivity({ brokerCode: "YP", period: "YEAR_TO_DATE" }), StockbitError);
  assert.equal(requests.activity, 0, "a refused parameter must cost no request");
});

test("activity: BROKER_PERIODS is untouched — broker_distribution still uses it", async () => {
  // The fix is "stop sending it HERE", not "delete the vocabulary". broker_distribution accepts
  // TB_PERIOD_LAST_1_DAY on this same list, and narrowing the constant would break that route to
  // fix this one.
  assert.ok(BROKER_PERIODS.includes("LAST_1_DAY"));
  assert.equal(BROKER_PERIODS.length, 10);
  // And it is still live on the route that takes it.
  await getBrokerTop({ period: "LAST_1_DAY" });
  assert.equal(lastUrl("broker/top").searchParams.get("period"), "TB_PERIOD_LAST_1_DAY");
});

test("activity: omitted filters are absent parameters, not empty ones", async () => {
  await getBrokerActivity({ brokerCode: "CC", marketTypes: [] });
  const url = lastUrl("broker/activity");
  assert.deepEqual([...url.searchParams.keys()], ["broker_code"]);
  assert.equal(url.searchParams.get("broker_code"), "CC");
});

test("activity: binds to the measured row container and carries the window beside it", async () => {
  const activity = await getBrokerActivity({ brokerCode: "YP" });

  // `broker_activity_transaction` is the container the live call answered with. It used to be
  // absent from ROW_CONTAINERS, so this tool returned `rowsFrom: null, count: 0` while `dataKeys`
  // showed the array sitting right there.
  assert.equal(activity.rowsFrom, "broker_activity_transaction");
  assert.equal(activity.count, 3);
  assert.deepEqual(activity.dataKeys, [
    "broker_activity_transaction",
    "from",
    "to",
    "broker_code",
    "broker_name",
  ]);

  // With no period to choose, `from`/`to` are the ONLY thing dating these rows, and they were
  // being read out of the envelope and thrown away.
  assert.equal(activity.from, "2026-09-01");
  assert.equal(activity.to, "2026-09-01");
});

test("activity: a window the response did not carry is absent, never today's date", async () => {
  activityBody = { data: { broker_activity_transaction: [{ symbol: "BBRI" }] } };
  const activity = await getBrokerActivity({ brokerCode: "YP" });
  assert.equal(activity.count, 1);
  assert.equal("from" in activity, false, "an unstated window is absent, not defaulted");
  assert.equal("to" in activity, false);

  // An empty string is Stockbit's "no value here" across this API, and must read the same way.
  clearCache();
  activityBody = { data: { broker_activity_transaction: [], from: "", to: "   " } };
  const blank = await getBrokerActivity({ brokerCode: "CC" });
  assert.equal("from" in blank, false);
  assert.equal("to" in blank, false);
});

test("activity: projects the traded symbol and leaves the figures in the raw row", async () => {
  const activity = await getBrokerActivity({ brokerCode: "YP" });

  assert.equal(activity.brokerCode, "YP");
  assert.deepEqual(activity.request, { broker_code: "YP" });
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
  // A period this vocabulary never had, and one it does — both refused, for the same reason now.
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
  assert.equal(params.sort_by, undefined);
  // Not merely undefined: the key is not built at all, so nothing downstream can resurrect it.
  assert.equal("period" in params, false, "period is never a parameter of this route");
});

test("activity: the cache key carries every filter, not just the broker", async () => {
  await getBrokerActivity({ brokerCode: "YP", marketTypes: ["REGULER"] });
  await getBrokerActivity({ brokerCode: "YP", marketTypes: ["REGULER"] });
  assert.equal(requests.activity, 1);

  await getBrokerActivity({ brokerCode: "YP", marketTypes: ["ALL"] });
  assert.equal(requests.activity, 2, "a different board must not be served the REGULER answer");

  await getBrokerActivity({ brokerCode: "YP", marketTypes: ["REGULER"], sortBy: "TOTAL_VALUE" });
  assert.equal(requests.activity, 3, "a different sort must not be served the earlier answer");
});

/* ------------------------------------ top ------------------------------------ */

test("top: sends only what was asked for, on the declared path", async () => {
  const top = await getBrokerTop({ period: "YEAR_TO_DATE", sortBy: "TOTAL_VALUE" });

  const url = lastUrl("broker/top");
  assert.deepEqual(segments(url), ["order-trade", "broker", "top"]);
  assert.equal(url.searchParams.get("period"), "TB_PERIOD_YEAR_TO_DATE");
  assert.equal(url.searchParams.get("sort_by"), "SORT_BY_TOTAL_VALUE");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["period", "sort_by"]);

  assert.equal(top.rowsFrom, "list");
  assert.deepEqual(top.request, { period: "TB_PERIOD_YEAR_TO_DATE", sort_by: "SORT_BY_TOTAL_VALUE" });
  assert.deepEqual(top.unmapped, { count: 1, sampleKeys: ["something_else"] });
});

test("top: the biggest broker comes FIRST — the endpoint sends them ascending", async () => {
  // The defect, in one assertion. Measured across all 89 live rows: first 22,485,000, last
  // 5,636,360,451,396. A tool whose whole description is "which brokers moved the most" was
  // handing back the smallest house at the top, and the ignored `limit` was the only thing hiding
  // it — nobody ever looked past row three.
  const top = await getBrokerTop();

  assert.deepEqual(
    top.brokers.map((b) => b.code),
    ["AK", "CC", "ZR", "XL", undefined],
    "descending by total_value, with the two unrankable rows last in wire order",
  );
  assert.deepEqual(top.brokers.map((b) => b.totalValue).slice(0, 3), [
    5_636_360_451_396, 9_912_000_000, 22_485_000,
  ]);

  // Said out loud, because a client-side sort the caller cannot see is itself a silent behaviour.
  // No `sort_by` value reverses the order upstream, so this is the only place it can happen.
  assert.deepEqual(top.sortedLocally, {
    by: "total_value",
    direction: "descending",
    appliedLocally: true,
    unsortable: 2,
  });
});

test("top: a row with no readable total_value is kept, ranked LAST, and never given a zero", async () => {
  const top = await getBrokerTop();
  const xl = top.brokers.find((b) => b.code === "XL")!;

  // "1,234" is refused rather than guessed at — 1234 under one Indonesian convention, 1.234 under
  // the other. Absent, not zero: a zero would rank this house dead last on a real figure.
  assert.equal(xl.totalValue, undefined);
  assert.equal(xl.readFrom.totalValue, undefined, "an unread key is not named as a source");
  assert.equal(xl.row.total_value, "1,234", "the raw value is still there to read");
  // An empty string is "no value here", not an unreadable one, and reads the same way: absent.
  assert.equal(xl.netValue, undefined);

  // It sits after every ranked row, in wire order. Sorting it to the top or the bottom by
  // comparator accident would be inventing a position for a broker that has none.
  assert.equal(top.brokers.at(-2)!.code, "XL");
});

test("top: the row figures are projected as numbers, and readFrom names every key", async () => {
  const top = await getBrokerTop();
  const ak = top.brokers[0];

  assert.equal(ak.code, "AK");
  assert.equal(ak.name, "Sekuritas Contoh Besar");
  assert.equal(ak.investorType, "ALL");
  assert.equal(ak.group, "ASING");
  assert.equal(ak.totalValue, 5_636_360_451_396);
  assert.equal(ak.totalVolume, 9_100_000);
  assert.equal(ak.totalFrequency, 120_455);

  // These three are the correction to the 2026-08-31 field report, which recorded them as "0" on
  // every row and called them dead. The live reading has 89 distinct values; they are populated,
  // they are projected normally, and nothing here reports them absent.
  assert.equal(ak.netValue, -88_000_000_000);
  assert.equal(ak.buyValue, 2_774_180_225_698);
  assert.equal(ak.sellValue, 2_862_180_225_698);
  assert.ok(ak.netValue! < 0, "the sign is the wire's: this house was a net seller");

  assert.deepEqual(ak.readFrom, {
    code: "code",
    name: "name",
    investorType: "investor_type",
    totalValue: "total_value",
    netValue: "net_value",
    buyValue: "buy_value",
    sellValue: "sell_value",
    totalVolume: "total_volume",
    totalFrequency: "total_frequency",
    group: "group",
  });
  // Nothing is dropped on the way through, and the strings are still strings underneath.
  assert.equal(ak.row.total_value, "5636360451396");
});

test("top: the session the table covers is carried, not dropped", async () => {
  const top = await getBrokerTop();
  assert.deepEqual(top.date, { from: "2026-09-01", to: "2026-09-01", idx: "2026-09-01" });
});

test("top: `limit` is applied HERE, after the sort, and is never sent", async () => {
  const top = await getBrokerTop({ limit: 2 });

  // The endpoint ignores its own `limit` — the same 89 rows at limit=3 and at limit=5 — so sending
  // it would put a cap in `request` that the server never honoured.
  assert.equal(lastUrl("broker/top").searchParams.has("limit"), false);
  assert.equal("limit" in top.request, false);

  // After the sort, not before: a cap applied to the wire order would return the two SMALLEST.
  assert.deepEqual(
    top.brokers.map((b) => b.code),
    ["AK", "CC"],
  );
  assert.equal(top.count, 2);
  assert.equal(top.countBeforeLimit, 5, "the caller can see what the trim removed");
  assert.equal(top.limitAppliedLocally, 2, "and whose cap it was");
});

test("top: with no limit, nothing claims one was applied", async () => {
  const top = await getBrokerTop();
  assert.equal(top.limitAppliedLocally, undefined);
  assert.equal(top.count, 5);
  assert.equal(top.countBeforeLimit, 5);
});

test("top: trimming never mutates the shared cache entry, and costs no second fetch", async () => {
  // Same trap as getBrokerDirectory's `codes`: `full` is the object every later caller of that key
  // receives, and slicing its `brokers` in place would hand the next caller this caller's cap.
  const two = await getBrokerTop({ limit: 2 });
  assert.equal(two.count, 2);

  const all = await getBrokerTop();
  assert.equal(requests.top, 1, "limit is not on the wire, so it is not in the cache key either");
  assert.equal(all.count, 5, "the untrimmed table must still be whole");
  assert.equal(all.limitAppliedLocally, undefined);

  const three = await getBrokerTop({ limit: 3 });
  assert.equal(requests.top, 1, "a second cap is a second slice, not a second request");
  assert.equal(three.count, 3);
});

test("top: a rejected limit never reaches the fetch", async () => {
  await assert.rejects(() => getBrokerTop({ limit: 0 }), (e: unknown) => {
    assert.ok(e instanceof StockbitError);
    assert.equal(e.kind, "invalid_param");
    return true;
  });
  await assert.rejects(() => getBrokerTop({ limit: "ten" }), StockbitError);
  assert.equal(requests.top, 0);
});

test("top: still reads a bare data array, with no provenance to claim", async () => {
  // Only `data.list` was measured. A reader that stopped accepting the alternatives would be
  // narrowing itself on the strength of one reading.
  topBody = TOP_BARE_ARRAY_BODY;
  const top = await getBrokerTop();

  assert.equal(top.rowsFrom, "data");
  assert.equal(top.brokers[0].code, "AK");
  assert.equal(top.brokers[0].totalValue, 9_912_000_000);
  assert.equal(top.date, undefined, "a bare array carries no date, so none is invented");
  assert.deepEqual(top.unmapped, { count: 1, sampleKeys: ["something_else"] });
  assert.equal(top.sortedLocally.unsortable, 1);
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

test("top: `unmapped` describes the row it actually came from, despite the re-sort", async () => {
  // `unmappedOf` walks the raw rows and the projected ones in parallel, so it has to run BEFORE
  // the sort. Counting after would report some other row's keys as the unreadable one's — and the
  // sample keys are the whole diagnostic value of the field.
  const top = await getBrokerTop();
  assert.deepEqual(top.unmapped, { count: 1, sampleKeys: ["something_else"] });
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
    sort_by: "TOTAL_VALUE",
    page: 2,
    limit: 10,
  });
  assert.equal((result as { isError?: boolean }).isError, false);

  const url = lastUrl("broker/activity");
  assert.equal(url.searchParams.get("broker_code"), "XL");
  assert.deepEqual(url.searchParams.getAll("market_type"), ["MARKET_TYPE_REGULER", "MARKET_TYPE_NEGO"]);
  assert.deepEqual(url.searchParams.getAll("investor_type"), ["INVESTOR_TYPE_FOREIGN"]);
  assert.equal(url.searchParams.get("sort_by"), "SORT_BY_TOTAL_VALUE");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.has("period"), false);
});

test("tools: broker_activity still ACCEPTS `period` in its schema, so it can refuse it out loud", async () => {
  const { definer, reads } = fakeDefiner();
  registerBrokerTools(definer);

  // Deliberate: dropping `period` from the shape would have the SDK strip it, and the model would
  // read rows for a window it asked to change without ever learning the ask went nowhere. It
  // reaches the core, which refuses it with an error the model can act on.
  const result = (await reads.get("broker_activity")!({ broker_code: "YP", period: "LAST_1_DAY" })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text) as { kind: string; message?: string; error?: string };
  assert.equal(payload.kind, "invalid_param");
  assert.match(JSON.stringify(payload), /no period filter/i);
  assert.equal(requests.activity, 0);

  // And a spelling the old enum would have bounced reaches the same explanation, rather than a zod
  // error that tells the model only that its value is not in a list it should not be using.
  const nonsense = (await reads.get("broker_activity")!({ broker_code: "YP", period: "daily" })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  assert.equal(nonsense.isError, true);
  assert.match(JSON.stringify(JSON.parse(nonsense.content[0].text)), /no period filter/i);
});

test("tools: broker_top's limit is applied locally and never reaches the wire", async () => {
  const { definer, reads } = fakeDefiner();
  registerBrokerTools(definer);

  const result = await reads.get("broker_top")!({ limit: 1, sort_by: "TOTAL_VALUE" });
  assert.equal((result as { isError?: boolean }).isError, false);

  const url = lastUrl("broker/top");
  assert.equal(url.searchParams.has("limit"), false);
  assert.equal(url.searchParams.get("sort_by"), "SORT_BY_TOTAL_VALUE");

  const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text) as {
    data: {
      brokers: Array<{ code?: string }>;
      limitAppliedLocally?: number;
      countBeforeLimit: number;
      sortedLocally: { direction: string };
    };
  };
  // Asserted through the SERIALISED result, which is what the model actually reads: a correction
  // that survives only inside the core object is one the caller never sees.
  assert.deepEqual(payload.data.brokers.map((b) => b.code), ["AK"], "the biggest, not the first sent");
  assert.equal(payload.data.limitAppliedLocally, 1);
  assert.equal(payload.data.countBeforeLimit, 5);
  assert.equal(payload.data.sortedLocally.direction, "descending");
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
