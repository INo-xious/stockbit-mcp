// Isolate the token store before importing anything that reads it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-market-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { StockbitError } from "../src/http/errors.ts";
import {
  CHART_TIMEFRAMES,
  PRICES_BATCH_MAX,
  getChartRaw,
  getMarketMovers,
  getMarketPrices,
  getMarketSession,
  getOrderQueue,
  getPricesBatch,
  getRunningTrade,
  getRunningTradeChart,
  getSeriesBars,
  getTopStocks,
  getTradeBook,
  keyFor,
  locateRows,
  normalizeChartTimeframe,
  normalizeSortKey,
} from "../src/core/market.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

const realFetch = globalThis.fetch;
let seenUrls: string[] = [];
/** How many non-auth requests went out, so a test can prove a cache HIT or MISS. */
let requests = 0;
/** What the fake API answers. Each test that cares sets its own. */
let responder: (url: string) => unknown = () => ({ data: [] });

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/login/refresh")) {
      return new Response(JSON.stringify({ data: { access_token: farFutureJwt() } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    seenUrls.push(u);
    requests++;
    return new Response(JSON.stringify(responder(u)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

beforeEach(() => {
  seenUrls = [];
  requests = 0;
  responder = () => ({ data: [] });
  // Every test states its own request count, so it must start from an empty cache.
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

/** The last request whose URL contains `fragment`, parsed. Fails the test when there was none. */
function lastUrl(fragment: string): URL {
  const found = [...seenUrls].reverse().find((u) => u.includes(fragment));
  assert.ok(found, `no request was made to ${fragment}; saw ${JSON.stringify(seenUrls)}`);
  return new URL(found);
}

/** Query parameters as a sorted list of `key=value`, so an ABSENT parameter is provable. */
function query(url: URL): string[] {
  return [...url.searchParams.entries()].map(([k, v]) => `${k}=${v}`).sort();
}

/* ================================ chart series ================================ */

/** Epoch seconds, string OHLCV, one unmapped extra key — the defensive-read cases in one body. */
const CHART_POINTS = {
  data: {
    chart: [
      // 2026-08-24 07:00 WIB.
      { time: 1787529600, open: "4,200", high: "4,300", low: "4,150", close: "4,250", volume: "1200", foo: 1 },
      { time: 1787443200, open: "4,100", high: "4,260", low: "4,090", close: "4,200", volume: "900", foo: 2 },
    ],
  },
};

test("chart series sends the lowercase timeframe and no previous-historical flag", async () => {
  responder = () => CHART_POINTS;
  await getSeriesBars("bbri", "1Y");

  const url = lastUrl("/charts/");
  assert.equal(url.pathname, "/charts/BBRI/daily");
  assert.deepEqual(query(url), ["timeframe=1y"]);
});

test("ytd and 1w carry is_include_previous_historical, the others do not", async () => {
  responder = () => CHART_POINTS;
  for (const tf of ["ytd", "1w"]) {
    clearCache();
    await getSeriesBars("BBRI", tf);
    assert.deepEqual(
      query(lastUrl("/charts/")),
      ["is_include_previous_historical=true", `timeframe=${tf}`],
      tf,
    );
  }
  for (const tf of ["1m", "3m", "1y", "3y", "5y"]) {
    clearCache();
    await getSeriesBars("BBRI", tf);
    assert.deepEqual(query(lastUrl("/charts/")), [`timeframe=${tf}`], tf);
  }
});

test("an unknown timeframe is refused and never reaches the wire", async () => {
  // The values earlier probes actually sent. Each returns 200-with-empty upstream, which is why
  // passing them through would be indistinguishable from a symbol with no history.
  for (const bad of ["1D", "daily", "D", "DAILY", "TIMEFRAME_DAILY", "6m", ""]) {
    await assert.rejects(
      () => getSeriesBars("BBRI", bad),
      (err: unknown) =>
        err instanceof StockbitError &&
        err.kind === "invalid_param" &&
        CHART_TIMEFRAMES.every((tf) => err.message.includes(tf)),
      bad,
    );
  }
  assert.equal(requests, 0, "a rejected timeframe must not produce a request");
});

test("timeframe normalization accepts case and whitespace but nothing else", () => {
  assert.equal(normalizeChartTimeframe(" YTD "), "ytd");
  assert.equal(normalizeChartTimeframe("1Y"), "1y");
  assert.throws(() => normalizeChartTimeframe("1d"), StockbitError);
});

test("points project onto Bar, oldest first, whatever the encoding", async () => {
  responder = () => CHART_POINTS;
  const series = await getSeriesBars("BBRI", "1y");

  assert.equal(series.source, "charts");
  assert.equal(series.symbol, "BBRI");
  assert.equal(series.timeframe, "1y");
  assert.equal(series.dataPath, "data.chart");
  // Newest-first on the wire, ascending here: every indicator downstream assumes ascending time.
  assert.deepEqual(series.bars.map((b) => b.date), ["2026-08-23", "2026-08-24"]);
  assert.equal(series.from, "2026-08-23");
  assert.equal(series.to, "2026-08-24");
  // Thousands separators stripped, strings coerced.
  assert.deepEqual(series.bars[1], {
    date: "2026-08-24",
    open: 4200,
    high: 4300,
    low: 4150,
    close: 4250,
    average: 4250,
    volume: 1200,
    // null, not 0. The fixture carries no value/frequency/change/foreign fields, and a zero here
    // would be this projection asserting that nothing traded and no foreigner moved — a claim
    // about the session rather than about the payload, and one no caller could see through.
    value: null,
    frequency: null,
    change: null,
    changePercent: null,
    foreignBuy: null,
    foreignSell: null,
    netForeign: null,
  });
  assert.equal(series.mapped.date, "time");
  assert.equal(series.mapped.close, "close");
  assert.deepEqual(series.extraKeys, ["foo"]);
  assert.ok(series.unmapped.includes("value"), "value was not in the payload and must be reported");
  assert.ok(!series.unmapped.includes("volume"));
  // OHLC and volume were all mapped, so there is no "flat candles" warning. The seven fields this
  // fixture does not carry are named in the other one — they used to be zero-filled in silence,
  // which is what made `warnings: []` look right here.
  assert.equal(series.warnings.length, 1);
  assert.doesNotMatch(series.warnings[0] ?? "", /flat/, "the candles are real, not synthesised from close");
  assert.match(series.warnings[0] ?? "", /No usable value\/frequency/);
  assert.equal(series.sample.foo, 1, "the raw first point is returned for shape discovery");
});

test("an ISO date and numeric OHLCV project the same way", async () => {
  responder = () => ({
    data: [{ date: "2026-08-24", open: 100, high: 110, low: 90, close: 105, volume: 7 }],
  });
  const series = await getSeriesBars("BBRI", "1m");
  assert.equal(series.dataPath, "data");
  assert.deepEqual(series.bars[0]?.date, "2026-08-24");
  assert.equal(series.bars[0]?.high, 110);
  assert.equal(series.mapped.date, "date");
});

test("an instant is filed under the Jakarta session date, not the UTC one", async () => {
  // Midnight WIB on 2026-08-24 is 17:00Z the day before. Formatting in UTC would file the whole
  // series one session early, which produces plausible, wrong indicator values rather than an error.
  responder = () => ({ data: [{ time: "2026-08-23T17:00:00Z", close: 1 }] });
  assert.equal((await getSeriesBars("BBRI", "1m")).bars[0]?.date, "2026-08-24");

  clearCache();
  // Epoch milliseconds for the same instant.
  responder = () => ({ data: [{ time: 1787504400000, close: 1 }] });
  assert.equal((await getSeriesBars("BBRI", "1m")).bars[0]?.date, "2026-08-24");

  clearCache();
  // A zone-less wall clock already states a local date and must be taken as written.
  responder = () => ({ data: [{ time: "2026-08-23T17:00:00", close: 1 }] });
  assert.equal((await getSeriesBars("BBRI", "1m")).bars[0]?.date, "2026-08-23");
});

test("a close-only payload is usable but says every candle is synthetic", async () => {
  responder = () => ({ data: { result: [{ date: "2026-08-24", close: 105 }] } });
  const series = await getSeriesBars("BBRI", "1m");
  assert.equal(series.bars[0]?.open, 105);
  assert.ok(series.unmapped.includes("open"));
  assert.ok(series.unmapped.includes("volume"));
  assert.equal(series.warnings.length, 2);
  assert.match(series.warnings[0] ?? "", /flat/);
  // The second warning now names EVERY field that arrived unusable, not volume alone — the other
  // seven zero-filled in complete silence before.
  assert.match(series.warnings[1] ?? "", /not 'the figure was zero'/);
  assert.match(series.warnings[1] ?? "", /volume/);
  assert.match(series.warnings[1] ?? "", /netForeign/);
  assert.equal(series.bars[0]?.volume, null, "and the bar says absent rather than zero");
  assert.equal(series.bars[0]?.netForeign, null);
});

test("a field present but EMPTY on every bar warns too, which is the observed daily payload", async () => {
  // The reason the old check was wrong. `keyIn` accepts an empty string as present, so `unmapped`
  // stayed clean and the volume warning never fired at all — while every bar reported volume 0.
  // /charts/:symbol/daily is documented as sending open/high/low/volume exactly this way.
  responder = () => ({
    data: { result: [{ date: "2026-08-24", close: 105, volume: "", value: "", net_foreign: "" }] },
  });
  const series = await getSeriesBars("BBRI", "1m");
  assert.ok(!series.unmapped.includes("volume"), "the KEY is present — that was never the question");
  assert.equal(series.bars[0]?.volume, null, "but no usable value arrived, so it is absent");
  assert.ok(
    series.warnings.some((w) => /volume/.test(w) && /not 'the figure was zero'/.test(w)),
    "and the caller is told, which is what did not happen before",
  );
});

test("an empty series is raised, not returned, so the caller falls back deliberately", async () => {
  responder = () => ({ data: { chart: [] } });
  await assert.rejects(
    () => getSeriesBars("BBRI", "1y"),
    (err: unknown) =>
      err instanceof StockbitError && err.kind === "not_found" && /zero points/.test(err.message),
  );
});

test("an unrecognisable payload is schema_drift, never an empty array", async () => {
  responder = () => ({ data: { message: "ok" } });
  await assert.rejects(
    () => getSeriesBars("BBRI", "1y"),
    (err: unknown) => err instanceof StockbitError && err.kind === "schema_drift",
  );

  clearCache();
  // Points with no recognisable close field.
  responder = () => ({ data: [{ date: "2026-08-24", price: 100 }] });
  await assert.rejects(
    () => getSeriesBars("BBRI", "1y"),
    (err: unknown) => err instanceof StockbitError && /close/.test(err.message),
  );
});

test("one bad point refuses the whole series rather than returning a hole", async () => {
  responder = () => ({
    data: [
      { date: "2026-08-24", close: 105 },
      { date: "2026-08-25", close: "" },
    ],
  });
  await assert.rejects(
    () => getSeriesBars("BBRI", "1y"),
    (err: unknown) => err instanceof StockbitError && /point 1/.test(err.message),
  );
});

test("locateRows prefers a populated array over an incidental empty one", () => {
  const found = locateRows({ tags: [], meta: { points: [{ a: 1 }] } });
  assert.equal(found?.path, "data.meta.points");
  assert.equal(locateRows({ tags: [] })?.path, "data.tags");
  assert.equal(locateRows({ note: "none" }), null);
});

test("the chart cache key distinguishes symbol and timeframe", async () => {
  responder = () => CHART_POINTS;
  await getSeriesBars("BBRI", "1y");
  await getSeriesBars("BBRI", "1y");
  assert.equal(requests, 1, "identical arguments must be served from cache");
  await getSeriesBars("BBRI", "3y");
  await getSeriesBars("TLKM", "1y");
  assert.equal(requests, 3, "a different timeframe or symbol is a different answer");
});

test("raw reads the sibling chart route, not the daily one", async () => {
  responder = () => ({ data: { anything: true } });
  const raw = await getChartRaw("BBRI", "ytd");
  const url = lastUrl("/charts/");
  assert.equal(url.pathname, "/charts/BBRI");
  assert.deepEqual(query(url), ["is_include_previous_historical=true", "timeframe=ytd"]);
  assert.deepEqual(raw, { anything: true });
});

/* ================================ running trade ================================ */

test("running trade sends nothing the caller did not ask for", async () => {
  await getRunningTrade();
  const url = lastUrl("/running-trade");
  assert.equal(url.pathname, "/order-trade/running-trade");
  // order_by is the one exception to "send nothing the caller did not ask for": the endpoint
  // returns 400 {"key":"OrderBy","error":"OrderBy is a required field"} without it, so there is no
  // useful "unset" state to preserve. Measured against the live endpoint 2026-08-28.
  assert.deepEqual(query(url), ["order_by=1"], "only the required field is sent");
});

test("running trade filters are prefixed with the wire vocabulary", async () => {
  await getRunningTrade({ symbol: "bbri", action: "BUY", limit: 25 });
  const url = lastUrl("/running-trade");
  // `symbols` is PLURAL. The singular form is accepted and silently ignored — asking for BRMS
  // returned ZONE and WINE rows — which is worse than an error because the answer looks right.
  assert.deepEqual(query(url), [
    "action_type=RUNNING_TRADE_ACTION_TYPE_BUY",
    "limit=25",
    "order_by=1",
    "symbols=BBRI",
  ]);
});

test("grouped is a different route, not a query parameter", async () => {
  await getRunningTrade({ grouped: true, symbol: "BBRI" });
  const url = lastUrl("/running-trade/group");
  assert.equal(url.pathname, "/order-trade/running-trade/group");
  assert.deepEqual(query(url), ["order_by=1", "symbols=BBRI"]);
});

test("the running-trade cache key includes every argument", async () => {
  await getRunningTrade({ symbol: "BBRI", limit: 5 });
  await getRunningTrade({ symbol: "BBRI", limit: 5 });
  assert.equal(requests, 1);
  // The bug this guards: a key of `runningTrade:BBRI` serves the 5-row answer to this call.
  await getRunningTrade({ symbol: "BBRI", limit: 50 });
  assert.equal(requests, 2);
  await getRunningTrade({ symbol: "BBRI", limit: 50, action: "SELL" });
  assert.equal(requests, 3);
  await getRunningTrade({ symbol: "BBRI", limit: 50, grouped: true });
  assert.equal(requests, 4, "the grouped route is a different answer");
});

test("a null data block is an empty answer, not a throw", async () => {
  responder = () => ({ data: null });
  assert.equal(await getRunningTrade(), null);
  assert.deepEqual(await getTradeBook(), null);
  clearCache();
  responder = () => ({});
  assert.equal(await getMarketSession(), null);
});

test("an empty rows array comes back as an empty array", async () => {
  responder = () => ({ data: [] });
  assert.deepEqual(await getRunningTrade({ symbol: "BBRI" }), []);
});

test("a non-integer limit is refused before the wire", async () => {
  for (const bad of [0, -5, 2.5, Number.NaN]) {
    await assert.rejects(
      () => getRunningTrade({ limit: bad }),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      String(bad),
    );
  }
  assert.equal(requests, 0);
});

test("the intraday chart takes the symbol as a path segment", async () => {
  responder = () => ({ data: { series: [{ t: 1 }] } });
  await getRunningTradeChart("bbri");
  const url = lastUrl("/running-trade/chart");
  assert.equal(url.pathname, "/order-trade/running-trade/chart/BBRI");
  assert.deepEqual(query(url), []);
});

test("an invalid symbol never reaches the wire", async () => {
  await assert.rejects(
    () => getRunningTradeChart("../admin"),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  await assert.rejects(
    () => getOrderQueue({ symbol: "BB RI" }),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(requests, 0);
});

/* ================================== trade book ================================== */

test("trade book prefixes mode and repeats data_mode", async () => {
  await getTradeBook({ symbol: "BBRI", mode: "BIG_MONEY", dataModes: ["EXCLUDE_PRE", "EXCLUDE_POST"] });
  const url = lastUrl("/trade-book");
  assert.equal(url.pathname, "/order-trade/trade-book");
  // Repeated keys, not a comma-joined value: this API reads only the first item of a joined list
  // and answers 200, which returns a confidently narrower result instead of an error.
  assert.deepEqual(url.searchParams.getAll("data_mode"), [
    "TRADE_BOOK_DATA_MODE_EXCLUDE_PRE",
    "TRADE_BOOK_DATA_MODE_EXCLUDE_POST",
  ]);
  assert.equal(url.searchParams.get("mode"), "TRADE_BOOK_MODE_BIG_MONEY");
});

test("an empty data_modes list sends no parameter at all", async () => {
  await getTradeBook({ symbol: "BBRI", dataModes: [] });
  assert.deepEqual(query(lastUrl("/trade-book")), ["symbol=BBRI"]);
});

test("trade book chart is a different route", async () => {
  await getTradeBook({ symbol: "BBRI", chart: true });
  assert.equal(lastUrl("/trade-book/chart").pathname, "/order-trade/trade-book/chart");
});

/* ============================ movers, top stocks, queue ============================ */

test("movers and top stocks send only what was asked for", async () => {
  await getMarketMovers();
  assert.deepEqual(query(lastUrl("/market-mover")), []);
  await getMarketMovers(10);
  assert.deepEqual(query(lastUrl("/market-mover")), ["limit=10"]);
  await getTopStocks(5);
  const url = lastUrl("/top-stock");
  assert.equal(url.pathname, "/order-trade/top-stock");
  assert.deepEqual(query(url), ["limit=5"]);
  assert.equal(requests, 3, "three distinct argument sets, three requests");
});

test("order queue prefixes the sort key and does not double it", async () => {
  await getOrderQueue({ symbol: "bbri", sortBy: "lot", limit: 20 });
  const url = lastUrl("/order-queue");
  assert.equal(url.pathname, "/order-trade/order-queue");
  // `stock_code`, not `symbol`. Settled against the live endpoint on 2026-08-29: every other
  // spelling returns 400 "Stock code is required", so this tool had never returned data.
  assert.deepEqual(query(url), ["limit=20", "sort_by=SORT_BY_LOT", "stock_code=BBRI"]);

  assert.equal(normalizeSortKey("SORT_BY_QUEUE"), "SORT_BY_QUEUE");
  assert.equal(normalizeSortKey("price"), "SORT_BY_PRICE");
  // The known list is partial, so an unlisted but well-formed key must be allowed through.
  assert.equal(normalizeSortKey("total_value"), "SORT_BY_TOTAL_VALUE");
  for (const bad of ["", "lot desc", "lot;drop", "-lot"]) {
    assert.throws(() => normalizeSortKey(bad), StockbitError, bad);
  }
});

test("market session takes no arguments and is cached", async () => {
  responder = () => ({ data: { session: "SESSION_1" } });
  assert.deepEqual(await getMarketSession(), { session: "SESSION_1" });
  await getMarketSession();
  const url = lastUrl("/market-time/session");
  assert.equal(url.pathname, "/company-price-feed/market-time/session");
  assert.deepEqual(query(url), []);
  assert.equal(requests, 1);
});

/* ============================= batch and market prices ============================= */

test("batch prices join the symbols and report which ones came back", async () => {
  responder = () => ({
    data: [
      { symbol: "BBRI", last: 4250 },
      { symbol: "TLKM", last: 3010 },
    ],
  });
  const batch = await getPricesBatch(["bbri", "TLKM", "asii", "BBRI"]);

  const url = lastUrl("/company-price-feed/prices");
  assert.equal(url.pathname, "/company-price-feed/prices");
  assert.deepEqual(query(url), ["stock_code=BBRI,TLKM,ASII"], "de-duplicated, uppercased, joined");
  assert.deepEqual(batch.requested, ["BBRI", "TLKM", "ASII"]);
  assert.deepEqual(batch.found, ["BBRI", "TLKM"]);
  // The failure this exists to make visible: a wrong multi-value encoding answers 200 with fewer
  // rows than asked for, and without this the short list looks like a complete answer.
  assert.deepEqual(batch.missing, ["ASII"]);
  assert.equal(batch.dataPath, "data");
  assert.equal(batch.rows.length, 2);
});

test("batch prices find the ticker whatever key it lives under", async () => {
  // The key the symbol arrives under has not been observed, so matching is on values, not names.
  responder = () => ({ data: { result: [{ code: "bbri", price: "4,250" }] } });
  const batch = await getPricesBatch(["BBRI", "TLKM"]);
  assert.deepEqual(batch.found, ["BBRI"]);
  assert.deepEqual(batch.missing, ["TLKM"]);
  assert.equal(batch.dataPath, "data.result");
});

test("batch prices keep the payload when no rows can be located", async () => {
  responder = () => ({ data: { message: "no data" } });
  const batch = await getPricesBatch(["BBRI"]);
  assert.deepEqual(batch.rows, []);
  assert.deepEqual(batch.missing, ["BBRI"]);
  assert.equal(batch.dataPath, null);
  assert.deepEqual(batch.raw, { message: "no data" });
});

test("batch prices refuse an empty or oversized list before the wire", async () => {
  await assert.rejects(
    () => getPricesBatch([]),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  const many = Array.from({ length: PRICES_BATCH_MAX + 1 }, (_, i) => `SYM${i}`);
  await assert.rejects(
    () => getPricesBatch(many),
    (err: unknown) => err instanceof StockbitError && /at most 50/.test(err.message),
  );
  assert.equal(requests, 0);
});

test("the batch cache key follows the symbol list", async () => {
  await getPricesBatch(["BBRI", "TLKM"]);
  await getPricesBatch(["BBRI", "TLKM"]);
  assert.equal(requests, 1);
  await getPricesBatch(["BBRI"]);
  assert.equal(requests, 2, "a different symbol list is a different answer");
});

test("market prices validate the date and pass boards through unprefixed", async () => {
  await getMarketPrices({ symbol: "bbri", date: "2026-08-03", boards: ["reguler", "NEGO"] });
  const url = lastUrl("/market");
  assert.equal(url.pathname, "/company-price-feed/prices/BBRI/market");
  assert.equal(url.searchParams.get("date"), "2026-08-03");
  // No MARKET_BOARD_ / MARKET_TYPE_ prefix is added: this repo carries two incompatible board
  // vocabularies already and which, if either, applies here is unknown.
  assert.deepEqual(url.searchParams.getAll("boards"), ["REGULER", "NEGO"]);
});

test("market prices omit date and boards when they were not given", async () => {
  await getMarketPrices({ symbol: "BBRI" });
  assert.deepEqual(query(lastUrl("/market")), []);
});

test("a bad date or board is refused before the wire", async () => {
  for (const date of ["2026/08/03", "20260803", "2026-02-30"]) {
    await assert.rejects(
      () => getMarketPrices({ symbol: "BBRI", date }),
      (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
      date,
    );
  }
  await assert.rejects(
    () => getMarketPrices({ symbol: "BBRI", boards: ["reguler; drop"] }),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(requests, 0);
});

test("the market-prices cache key includes the symbol, the date and the boards", async () => {
  await getMarketPrices({ symbol: "BBRI", date: "2026-08-03" });
  await getMarketPrices({ symbol: "BBRI", date: "2026-08-03" });
  assert.equal(requests, 1);
  // The symbol is a path segment, not a query parameter — a key built only from the query would
  // serve BBRI's session to a caller asking about TLKM.
  await getMarketPrices({ symbol: "TLKM", date: "2026-08-03" });
  assert.equal(requests, 2);
  await getMarketPrices({ symbol: "BBRI", date: "2026-08-04" });
  assert.equal(requests, 3);
  await getMarketPrices({ symbol: "BBRI", date: "2026-08-04", boards: ["NEGO"] });
  assert.equal(requests, 4);
});


/* ------------------------------------------------------------------ *
 * The cache key is injective.
 *
 * `Object.entries(params).sort()` with no comparator orders the [key, value] PAIRS by their default
 * string coercion — that is, by "key,value" rather than by key. It happened to be deterministic, so
 * nothing broke, but the line did something other than what it read as, and a key that sorts on its
 * own value is one route argument away from surprising someone.
 * ------------------------------------------------------------------ */

test("keyFor sorts by key, so the same params in any order give one key", () => {
  const a = keyFor("quote", { symbol: "BBRI", limit: 10, period: "1D" });
  const b = keyFor("quote", { period: "1D", limit: 10, symbol: "BBRI" });
  assert.equal(a, b, "argument order must not create a second cache entry");
});

test("keyFor separates param sets that a value-aware sort could tie", () => {
  // Both of these coerce their single entry to the string "a,b,c".
  const one = keyFor("quote", { a: "b,c" });
  const two = keyFor("quote", { "a,b": "c" });
  assert.notEqual(one, two, "two different requests must never share a cache entry");

  // And a different value is always a different key.
  assert.notEqual(keyFor("quote", { limit: 5 }), keyFor("quote", { limit: 50 }));
  assert.notEqual(keyFor("quote", { limit: 5 }), keyFor("orderbook", { limit: 5 }));
});

test("the daily chart carries its close in `value`, and empty OHL is reported as flat", async () => {
  // The live /charts/:symbol/daily payload, verbatim in shape: no `close` key at all, and
  // open/high/low/volume present but EMPTY. Before 2026-08-29 this threw "no recognisable close
  // field"; the arithmetic that identifies `value` as the price is change/value = percentage,
  // 20/2930 = 0.68%.
  responder = () => ({
    data: {
      chart: [
        { date: "1785171600000", formatted_date: "2026-07-28", value: "2930", percentage: "-0.68", change: -20, open: "", high: "", low: "", volume: "" },
        { date: "1785258000000", formatted_date: "2026-07-29", value: "2950", percentage: "0.68", change: 20, open: "", high: "", low: "", volume: "" },
      ],
    },
  });
  const series = await getSeriesBars("bbri", "1m");
  assert.equal(series.mapped.close, "value", "the close is read from `value`");
  assert.equal(series.bars.length, 2);
  assert.equal(series.bars[0].close, 2930);
  // Present-but-empty must be as loud as absent: every candle here is flat.
  assert.ok(
    series.warnings.some((w) => /open\/high\/low/.test(w)),
    "a flat series must say so even when the keys were present and empty",
  );
});
