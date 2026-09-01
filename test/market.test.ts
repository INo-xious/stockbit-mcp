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
import { MARKET_MOVER_VIEWS } from "../src/http/transport.ts";
import {
  CHART_TIMEFRAMES,
  RUNNING_TRADE_MAX_LIMIT,
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

test("raw reads the SAME route as the projection it exists to diagnose", async () => {
  // This test used to assert the opposite, and the assertion was the bug. `raw` read
  // /charts/:symbol while getSeriesBars reads /charts/:symbol/daily, and the two do not share a
  // timeframe vocabulary — measured 2026-09-01, /charts/:symbol REFUSES `1w` with 400 "Kurun waktu
  // tidak valid" and answers `{chart_points: []}` for everything else. So the escape hatch could
  // not reproduce the payload it is for: `1w` errored and `1m` came back empty, and a caller read
  // that emptiness as "the drift is gone".
  //
  // `raw: true` must differ from the projected call in exactly one way — that nothing is projected.
  responder = () => ({ data: { anything: true } });
  const raw = await getChartRaw("BBRI", "ytd");
  const url = lastUrl("/charts/");
  assert.equal(url.pathname, "/charts/BBRI/daily", "the same route getSeriesBars reads");
  assert.deepEqual(query(url), ["is_include_previous_historical=true", "timeframe=ytd"]);
  assert.deepEqual(raw, { anything: true });
});

test("raw and the projection request byte-identical URLs", async () => {
  // The property the test above states in prose, asserted directly: if these ever diverge again,
  // the escape hatch is describing a different request from the one that failed.
  responder = () => CHART_POINTS;
  await getSeriesBars("BBRI", "1y");
  const projected = lastUrl("/charts/");
  clearCache();
  seenUrls = [];
  await getChartRaw("BBRI", "1y");
  const rawUrl = lastUrl("/charts/");
  assert.equal(rawUrl.pathname, projected.pathname);
  assert.deepEqual(query(rawUrl), query(projected));
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

test("a limit past the endpoint's own cap is refused, and the message says why it is pointless", async () => {
  // 200 and 3000 came back byte-identical in the field, and the 2026-08-28 probe measured the
  // response capped at 100. Sending 3000 costs a round trip to be handed the same first 100 rows
  // with nothing marking the truncation — which is how a caller asking about the close gets the
  // opening auction and never learns it.
  await assert.rejects(
    () => getRunningTrade({ symbol: "BBRI", limit: RUNNING_TRADE_MAX_LIMIT + 1 }),
    (error: unknown) => {
      assert.ok(error instanceof StockbitError);
      assert.equal(error.kind, "invalid_param");
      assert.match(error.message, /between 1 and 100/);
      // Naming the cap is not enough on its own: the caller's real question is "then how do I see
      // the close", and the answer is that this route cannot, at any limit.
      assert.match(error.message, /session open/);
      assert.match(error.message, /broker_flow_intraday/);
      return true;
    },
  );
  assert.equal(requests, 0, "the refusal happens before the request is built");
});

test("the cap is a boundary, not a ban — the largest reachable limit still goes out", async () => {
  await getRunningTrade({ symbol: "BBRI", limit: RUNNING_TRADE_MAX_LIMIT });
  assert.deepEqual(query(lastUrl("/running-trade")), ["limit=100", "order_by=1", "symbols=BBRI"]);
});

test("order_by is sent as asked, and a value measured to be refused never reaches the wire", async () => {
  await getRunningTrade({ symbol: "BBRI", orderBy: 2 });
  assert.deepEqual(query(lastUrl("/running-trade")), ["order_by=2", "symbols=BBRI"]);

  // The tool layer casts an incoming number to 1|2|3, so the type does not stop a 4 at runtime.
  // 0 and 4 were both measured refused upstream; spending a round trip to be told so is waste.
  await assert.rejects(
    () => getRunningTrade({ symbol: "BBRI", orderBy: 4 as 1 | 2 | 3 }),
    (error: unknown) => {
      assert.ok(error instanceof StockbitError);
      assert.equal(error.kind, "invalid_param");
      assert.match(error.message, /order_by must be one of 1, 2, 3/);
      return true;
    },
  );
  assert.equal(requests, 1, "only the valid call went out");
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
  assert.deepEqual(await getTradeBook({ groupBy: "PRICE" }), null);
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
  await getTradeBook({
    symbol: "BBRI",
    mode: "BIG_MONEY",
    dataModes: ["EXCLUDE_PRE", "EXCLUDE_POST"],
    groupBy: "PRICE",
  });
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
  await getTradeBook({ symbol: "BBRI", dataModes: [], groupBy: "PRICE" });
  assert.deepEqual(query(lastUrl("/trade-book")), ["group_by=PRICE", "symbol=BBRI"]);
});

test("trade book refuses the call the endpoint would refuse, and says the value is not guessed", async () => {
  // Every call this project could make before `group_by` existed came back
  // 400 {"error":"Group by is required"} — with `mode` set and with `mode` omitted alike. There
  // was no argument combination that worked, which is what made this a dead tool rather than an
  // awkward one.
  await assert.rejects(
    () => getTradeBook({ symbol: "BBRI", mode: "OVERALL", limit: 100 }),
    (error: unknown) => {
      assert.ok(error instanceof StockbitError);
      assert.equal(error.kind, "invalid_param");
      assert.match(error.message, /group_by/);
      // "Required" on its own leaves the caller guessing at a vocabulary. This client has since
      // measured one, so the refusal has to hand over the value that works — otherwise it is a
      // wall rather than an answer.
      assert.match(error.message, /group_by=1/);
      // And it must not overstate what that afternoon settled: 2 was accepted but answered empty.
      assert.match(error.message, /not established/);
      return true;
    },
  );
  assert.equal(requests, 0, "nothing was spent finding out what is already known");
});

test("group_by goes out verbatim — no prefix is invented for a vocabulary nobody has seen", async () => {
  // `mode` and `data_mode` are prefixed because their enums were read off the wire. This one was
  // not, so sending TRADE_BOOK_GROUP_BY_price would be inventing a filter and reading the narrower
  // answer it produced as the whole one.
  await getTradeBook({ symbol: "BBRI", groupBy: "  price  " });
  assert.equal(lastUrl("/trade-book").searchParams.get("group_by"), "price");
});

test("a blank group_by is refused, not sent as an empty parameter", async () => {
  await assert.rejects(
    () => getTradeBook({ symbol: "BBRI", groupBy: "   " }),
    (error: unknown) => error instanceof StockbitError && error.kind === "invalid_param",
  );
  assert.equal(requests, 0);
});

test("trade book chart is a different route, and is not held to the table's rule", async () => {
  // The 400 was only ever seen from the table endpoint. Requiring group_by here as well would be
  // this client inventing a rule for a route it has never called.
  await getTradeBook({ symbol: "BBRI", chart: true });
  const url = lastUrl("/trade-book/chart");
  assert.equal(url.pathname, "/order-trade/trade-book/chart");
  assert.equal(url.searchParams.get("group_by"), null);
});

/* ============================ movers, top stocks, queue ============================ */

test("movers and top stocks send only what was asked for", async () => {
  await getMarketMovers();
  assert.deepEqual(query(lastUrl("/market-mover")), []);
  await getMarketMovers({ limit: 10 });
  assert.deepEqual(query(lastUrl("/market-mover")), ["limit=10"]);
  await getTopStocks(5);
  const url = lastUrl("/top-stock");
  assert.equal(url.pathname, "/order-trade/top-stock");
  assert.deepEqual(query(url), ["limit=5"]);
  assert.equal(requests, 3, "three distinct argument sets, three requests");
});

/* ------------------------------- the movers surface ------------------------------- */

/**
 * One `mover_list` row in the shape measured live on 2026-09-01, plus one key this projection does
 * not know so `unmappedKeys` has something to catch.
 */
const MOVER_PAYLOAD = {
  data: {
    mover_list: [
      {
        stock_detail: { code: "AAAA", name: "Alpha Tbk", icon_url: "", has_uma: false },
        price: 1250,
        change: { value: 40, percentage: 3.31 },
        value: { raw: "477705146500", formatted: "477.7B" },
        volume: { raw: "3545526000", formatted: "3.5B" },
        frequency: { raw: "12043", formatted: "12,043" },
        net_foreign_buy: { raw: "1200000", formatted: "1.2M" },
        net_foreign_sell: { raw: "800000", formatted: "800K" },
        net_buy: { raw: "400000", formatted: "400K" },
        net_sell: { raw: "0", formatted: "0" },
        iepiev_detail: {
          iep: { raw: "1260", formatted: "1,260" },
          iev: { raw: "5000", formatted: "5,000" },
          ieval: { raw: "0", formatted: "-" },
          iep_change: { raw: "0.8", formatted: "0.80%" },
          iep_change_prev: { raw: "0", formatted: "0.00%" },
          iep_price_diff: { raw: "10", formatted: "10" },
          iep_prev_price_diff: { raw: "0", formatted: "0" },
        },
        big_money_net_value: { raw: "999", formatted: "999" },
        market_cap: null,
        a_key_this_projection_does_not_know: 1,
      },
    ],
    mover_type: "MOVER_TYPE_TOP_GAINER",
    is_show_net_foreign: true,
    net_foreign_updated_at: "2026-09-01",
    net_foreign_session_info: {
      raw: 2,
      formatted: "Updated 01 Sep 2026",
      date: "2026-09-01",
      is_last_session: true,
    },
    // Measured to be all zeros on every call regardless of what is sent. It must NOT be projected.
    pagination: { page: 0, limit: 0, has_next: false, has_prev: false },
  },
};

test("a mover view is sent as its wire member and read back from the ECHO", async () => {
  responder = () => MOVER_PAYLOAD;
  const result = await getMarketMovers({ view: "topGainer" });

  // The friendly name never reaches the wire.
  assert.deepEqual(query(lastUrl("/market-mover")), ["mover_type=MOVER_TYPE_TOP_GAINER"]);
  // `view` is the server's echo, `requested` is what we asked for. They are separate on purpose.
  assert.equal(result.view, "MOVER_TYPE_TOP_GAINER");
  assert.equal(result.requested, "topGainer");
  assert.equal(result.rowsFrom, "mover_list");
  assert.equal(result.count, 1);
});

test("the echo is reported even when it disagrees with what was requested", async () => {
  // The failure this guards: an endpoint that silently serves its default. `view` must describe
  // what came back, so reading `requested` instead would hide exactly this.
  responder = () => ({ ...MOVER_PAYLOAD, data: { ...MOVER_PAYLOAD.data, mover_type: "MOVER_TYPE_TOP_VALUE" } });
  const result = await getMarketMovers({ view: "topGainer" });
  assert.equal(result.requested, "topGainer");
  assert.equal(result.view, "MOVER_TYPE_TOP_VALUE", "the echo, not the request");
});

test("a mover row is projected with readFrom, unmappedKeys and the raw row", async () => {
  responder = () => MOVER_PAYLOAD;
  const [row] = (await getMarketMovers({ view: "topGainer" })).rows;

  assert.equal(row.symbol, "AAAA");
  assert.equal(row.name, "Alpha Tbk");
  assert.equal(row.price, 1250);
  assert.equal(row.change, 40);
  assert.equal(row.changePercent, 3.31);
  // The {raw, formatted} shape: reading these with Number() once produced NaN for 100 symbols and
  // looked like a dead market, which is why readRaw exists and why this asserts the number.
  assert.equal(row.value, 477705146500);
  assert.equal(row.volume, 3545526000);
  assert.equal(row.frequency, 12043);
  assert.equal(row.netForeignBuy, 1200000);
  assert.equal(row.netForeignSell, 800000);

  assert.equal(row.readFrom.symbol, "stock_detail.code");
  assert.equal(row.readFrom.value, "value");
  assert.equal(row.readFrom.changePercent, "change.percentage");

  assert.deepEqual(row.unmappedKeys, ["a_key_this_projection_does_not_know"]);
  assert.equal(row.row.price, 1250, "the raw row is kept whole");
});

test("iepIev is projected from the field, because IEP/IEV is not a view", async () => {
  responder = () => MOVER_PAYLOAD;
  const [row] = (await getMarketMovers({ view: "topGainer" })).rows;
  assert.equal(row.iepIev?.iep, 1260);
  assert.equal(row.iepIev?.iev, 5000);
  assert.equal(row.iepIev?.iepChange, 0.8);
  assert.equal(row.readFrom.iepIev, "iepiev_detail");
});

test("a row with no iepiev_detail reports it absent rather than zeroed", async () => {
  responder = () => ({ data: { ...MOVER_PAYLOAD.data, mover_list: [{ stock_detail: { code: "BBBB" } }] } });
  const [row] = (await getMarketMovers({ view: "topGainer" })).rows;
  assert.equal(row.iepIev, undefined, "absent, not a block of zeros");
  assert.equal(row.value, undefined, "a figure that was not on the wire is absent, not 0");
  assert.equal(row.readFrom.value, undefined);
});

test("foreign provenance is carried, and the dead pagination block is not", async () => {
  responder = () => MOVER_PAYLOAD;
  const result = await getMarketMovers({ view: "topGainer" });
  assert.deepEqual(result.foreign, {
    isShown: true,
    updatedAt: "2026-09-01",
    sessionDate: "2026-09-01",
    isLastSession: true,
    sessionLabel: "Updated 01 Sep 2026",
  });
  // Measured all-zeros on every call including truncated ones, so passing it through would be
  // inventing an answer about whether more rows exist.
  assert.equal("pagination" in result, false);
});

test("every settled view is sendable and nothing else is", async () => {
  responder = () => MOVER_PAYLOAD;
  const expected: Record<string, string> = {
    topGainer: "MOVER_TYPE_TOP_GAINER",
    topLoser: "MOVER_TYPE_TOP_LOSER",
    topValue: "MOVER_TYPE_TOP_VALUE",
    topVolume: "MOVER_TYPE_TOP_VOLUME",
    topFrequency: "MOVER_TYPE_TOP_FREQUENCY",
    netForeignBuy: "MOVER_TYPE_NET_FOREIGN_BUY",
    netForeignSell: "MOVER_TYPE_NET_FOREIGN_SELL",
    bigMoneyNetValue: "MOVER_TYPE_BIG_MONEY_NET_VALUE",
  };
  assert.deepEqual(MARKET_MOVER_VIEWS.slice().sort(), Object.keys(expected).sort());
  for (const [friendly, wire] of Object.entries(expected)) {
    clearCache();
    await getMarketMovers({ view: friendly as never });
    assert.deepEqual(query(lastUrl("/market-mover")), [`mover_type=${wire}`]);
  }
});

test("an unsettled view is refused locally, and IEP/IEV is named as the reason", async () => {
  // Every IEP/IEV spelling was refused upstream on 2026-09-01, so shipping it as a member would
  // tell the caller the server accepts a value nobody has seen it accept.
  await assert.rejects(
    () => getMarketMovers({ view: "iepIev" as never }),
    (e: unknown) => e instanceof StockbitError && /IEP\/IEV/.test((e as Error).message),
  );
  assert.equal(requests, 0, "refused locally, without a round trip");
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

test("prices_batch sends the ONE symbol and reads the numeric series", async () => {
  // The measured payload: bare numbers under `data.prices`, not records. locateRows looks for
  // arrays of RECORDS and correctly declines to bind this, so without the series field the result
  // was `rows: []` / `dataPath: null` — indistinguishable from "this symbol has no prices".
  responder = () => ({ data: { prices: [3280, 3290, 3300] } });
  const batch = await getPricesBatch(["bbri"]);

  const url = lastUrl("/company-price-feed/prices");
  assert.equal(url.pathname, "/company-price-feed/prices");
  assert.deepEqual(query(url), ["stock_code=BBRI"], "uppercased, and one symbol only");
  assert.deepEqual(batch.requested, ["BBRI"]);
  assert.deepEqual(batch.series, [3280, 3290, 3300]);
  assert.equal(batch.seriesPath, "data.prices");
  assert.equal(batch.dataPath, null, "there are no records here, and pretending otherwise would lie");
  // A series came back for the one symbol asked for, so it is not missing.
  assert.deepEqual(batch.missing, []);
});

test("a numeric series is distinguished from a genuinely empty answer", async () => {
  // The distinction this whole field exists for. Same `rows: []` in both cases; different meaning.
  responder = () => ({ data: { prices: [] } });
  const empty = await getPricesBatch(["BBRI"]);
  assert.equal(empty.series, null, "an empty array is not a series");
  assert.deepEqual(empty.missing, ["BBRI"], "nothing came back, so the symbol is unanswered");
});

test("prices_batch refuses more than one symbol, because this route does not batch", async () => {
  // Settled 2026-09-01: comma-joining returns an EMPTY list and the repeated-key form answers
  // 400 "too many values for field stock_code". Sending it anyway would return an empty result
  // that reads as "these symbols have no prices" — a claim about the market, not the request.
  await assert.rejects(
    () => getPricesBatch(["BBRI", "TLKM"]),
    (err: unknown) => err instanceof StockbitError && /takes ONE symbol/.test(err.message),
  );
  await assert.rejects(
    () => getPricesBatch(["BBRI", "TLKM", "ASII"]),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(requests, 0, "refused locally, without a round trip");
});

test("prices_batch de-duplicates before counting, so one symbol twice is still one symbol", async () => {
  responder = () => ({ data: { prices: [3280] } });
  const batch = await getPricesBatch(["bbri", "BBRI"]);
  assert.deepEqual(batch.requested, ["BBRI"]);
  assert.deepEqual(query(lastUrl("/company-price-feed/prices")), ["stock_code=BBRI"]);
});

test("prices_batch finds the ticker whatever key it lives under", async () => {
  // The key the symbol arrives under has not been observed, so matching is on values, not names.
  responder = () => ({ data: { result: [{ code: "bbri", price: "4,250" }] } });
  const batch = await getPricesBatch(["BBRI"]);
  assert.deepEqual(batch.found, ["BBRI"]);
  assert.deepEqual(batch.missing, []);
  assert.equal(batch.dataPath, "data.result");
});

test("prices_batch keeps the payload when no rows can be located", async () => {
  responder = () => ({ data: { message: "no data" } });
  const batch = await getPricesBatch(["BBRI"]);
  assert.deepEqual(batch.rows, []);
  assert.deepEqual(batch.missing, ["BBRI"]);
  assert.equal(batch.dataPath, null);
  assert.deepEqual(batch.raw, { message: "no data" });
});

test("prices_batch refuses an empty list before the wire", async () => {
  await assert.rejects(
    () => getPricesBatch([]),
    (err: unknown) => err instanceof StockbitError && err.kind === "invalid_param",
  );
  assert.equal(requests, 0);
});

test("the prices_batch cache key follows the symbol", async () => {
  await getPricesBatch(["BBRI"]);
  await getPricesBatch(["BBRI"]);
  assert.equal(requests, 1);
  await getPricesBatch(["TLKM"]);
  assert.equal(requests, 2, "a different symbol is a different answer");
});

/* --------------------------------- market prices --------------------------------- */

test("price_market refuses without a request, because the route cannot be called", async () => {
  // Measured 2026-09-01: /company-price-feed/prices/:symbol/market answers 400 with NO parameters
  // at all, and with every board spelling and parameter name tried. A bare call being refused is
  // what settles it — if sending nothing is also an error, no argument combination is the fix.
  await assert.rejects(
    () => getMarketPrices({ symbol: "BBRI" }),
    (err: unknown) => err instanceof StockbitError && /cannot be called/.test(err.message),
  );
  assert.equal(requests, 0, "no round trip is spent to be told the request is invalid");
});

test("price_market names orderbook as the thing that actually answers", async () => {
  // The workaround is the point of the refusal: orderbook.market_data[] already carries the
  // per-board split, so a caller is redirected rather than left with a dead tool.
  await assert.rejects(
    () => getMarketPrices({ symbol: "BBRI", date: "2026-08-03", boards: ["REGULER"] }),
    (err: unknown) => err instanceof StockbitError && /orderbook/.test(err.message),
  );
  assert.equal(requests, 0);
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
