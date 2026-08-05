// Isolate the token store before importing anything that reads it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-bars-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/index.ts";
import { MAX_PAGES, ROWS_PER_PAGE, chartbitTrustState, getBars, resetChartbitTrust } from "../src/core/bars.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* ---------------------------------- the fake market ---------------------------------- */

const ANCHOR = Date.parse("2026-08-05T00:00:00Z");
const TOTAL_SESSIONS = 96;

/** Session `i` sessions ago. i=0 is the newest. */
function day(i: number): string {
  return new Date(ANCHOR - i * 86_400_000).toISOString().slice(0, 10);
}

/** Newest-first, exactly as both endpoints report it. Prices are distinct per session. */
const ALL_ROWS = Array.from({ length: TOTAL_SESSIONS }, (_, i) => ({
  date: day(i),
  open: 1000 + i,
  high: 1010 + i,
  low: 990 + i,
  close: 1005 + i,
  average: 1002 + i,
  volume: 5000 + i,
  value: 1e9 + i,
  frequency: 300 + i,
  change: 5,
  change_percentage: 0.5,
  foreign_buy: 100,
  foreign_sell: 90,
  net_foreign: 10,
}));

const realFetch = globalThis.fetch;

/** Every request URL that went out, so a test asserts what production actually asked for. */
let urls: string[] = [];
/** Knobs each test sets to drive a specific failure. */
let chartbitStatus = 200;
/** Rewrites the Chartbit body — the seam for shape drift and disagreement tests. */
let chartbitBody: (rows: typeof ALL_ROWS) => unknown = (rows) => ({ data: { result: rows } });

function countOf(fragment: string): number {
  return urls.filter((u) => u.includes(fragment)).length;
}

function lastUrl(fragment: string): URL {
  const found = [...urls].reverse().find((u) => u.includes(fragment));
  assert.ok(found, `no request to ${fragment} was made`);
  return new URL(found);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

before(() => {
  getStore().set("REFRESH");
  resetSession();

  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);

    if (u.includes("/login/refresh")) {
      return json({ data: { access_token: farFutureJwt() } });
    }

    if (u.includes("/chartbit/")) {
      if (chartbitStatus !== 200) return json({ message: "nope" }, chartbitStatus);
      const q = new URL(u).searchParams;
      const from = q.get("from") ?? "0000-00-00";
      const to = q.get("to") ?? "9999-99-99";
      const rows = ALL_ROWS.filter((r) => r.date >= from && r.date <= to);
      return json(chartbitBody(rows));
    }

    if (u.includes("/company-price-feed/historical/summary/")) {
      const page = Number(new URL(u).searchParams.get("page") ?? "1");
      const slice = ALL_ROWS.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);
      const more = page * ROWS_PER_PAGE < ALL_ROWS.length;
      return json({ data: { result: slice, paginate: more ? { next_page: String(page + 1) } : {} } });
    }

    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;
});

beforeEach(() => {
  urls = [];
  chartbitStatus = 200;
  chartbitBody = (rows) => ({ data: { result: rows } });
  clearCache();
  resetChartbitTrust();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
});

/* -------------------------------- the fast path works -------------------------------- */

test("a bar pull costs one range request plus one verification, not a page walk", async () => {
  const series = await getBars({ symbol: "BBRI", bars: 60 });

  assert.equal(series.source, "chartbit");
  assert.equal(series.bars.length, 60);
  assert.equal(countOf("/chartbit/"), 1, "the whole range should be one request");
  assert.equal(countOf("historical/summary"), 1, "page 1 only, as the control for verification");
  assert.equal(chartbitTrustState(), "trusted");
});

test("the range request asks for the window it needs, with the pager's limit lifted", async () => {
  await getBars({ symbol: "BBRI", bars: 10 }); // settle the verdict; a `to`-bounded call defers it
  await getBars({ symbol: "BBRI", from: "2026-06-01", to: "2026-08-05" });
  const url = lastUrl("/chartbit/");

  assert.equal(url.pathname, "/chartbit/BBRI/price/daily");
  assert.equal(url.searchParams.get("from"), "2026-06-01");
  assert.equal(url.searchParams.get("to"), "2026-08-05");
  assert.equal(url.searchParams.get("limit"), "0", "limit=0 is what makes it one request instead of 42");
});

test("once verified, later pulls skip the control request entirely", async () => {
  await getBars({ symbol: "BBRI", bars: 30 });
  urls = [];
  clearCache(); // trust survives a cache clear; it is a fact about the API, not about a response

  const again = await getBars({ symbol: "BBRI", bars: 40 });
  assert.equal(again.source, "chartbit");
  assert.equal(countOf("historical/summary"), 0, "verification is once per process, not once per call");
  assert.equal(countOf("/chartbit/"), 1);
});

test("bars come back oldest-first whichever way the endpoint ordered them", async () => {
  // Every moving average, RSI and backtest is written against ascending time. Handing them a
  // reversed series produces plausible, wrong numbers rather than an error.
  for (const reversed of [false, true]) {
    clearCache();
    resetChartbitTrust();
    chartbitBody = (rows) => ({ data: { result: reversed ? [...rows].reverse() : rows } });

    const series = await getBars({ symbol: "BBRI", bars: 20 });
    const dates = series.bars.map((b) => b.date);
    assert.deepEqual([...dates].sort(), dates, `order not normalised (reversed input: ${reversed})`);
    assert.equal(series.bars[series.bars.length - 1].date, day(0), "the last bar must be the newest session");
  }
});

/* ----------------------------- the verification has teeth ----------------------------- */

test("a range that disagrees with the proven endpoint is rejected and never used again", async () => {
  // The failure this guards against is silent: a wrong parser does not throw, it coerces, and every
  // indicator downstream produces confident numbers from a corrupted series.
  chartbitBody = (rows) => ({
    data: { result: rows.map((r, i) => (i === 0 ? { ...r, close: r.close + 999 } : r)) },
  });

  const series = await getBars({ symbol: "BBRI", bars: 30 });

  assert.equal(series.source, "paged", "a disagreeing fast path must not serve the series");
  assert.equal(chartbitTrustState(), "rejected");
  assert.ok(countOf("historical/summary") >= 2, "it should have fallen back to the walk");
  // And the series it did return is the proven one.
  assert.equal(series.bars[series.bars.length - 1].close, ALL_ROWS[0].close);
});

test("a rejected fast path is not retried on later calls", async () => {
  chartbitBody = (rows) => ({ data: { result: rows.map((r) => ({ ...r, close: r.close + 1 })) } });
  await getBars({ symbol: "BBRI", bars: 20 });
  assert.equal(chartbitTrustState(), "rejected");

  urls = [];
  clearCache();
  const series = await getBars({ symbol: "BBRI", bars: 20 });
  assert.equal(series.source, "paged");
  assert.equal(countOf("/chartbit/"), 0, "a rejected endpoint should not be asked again every call");
});

test("an unrecognised response shape falls back instead of guessing at it", async () => {
  for (const body of [
    { data: { something_else: [] } },
    { data: [] },
    { data: { result: [{ date: "2026-08-05" }] } }, // a row missing OHLC is not a bar
    {},
  ]) {
    clearCache();
    resetChartbitTrust();
    chartbitBody = () => body;

    const series = await getBars({ symbol: "BBRI", bars: 20 });
    assert.equal(series.source, "paged", `shape ${JSON.stringify(body)} should not have been trusted`);
    assert.equal(series.bars.length, 20, "the fallback must still answer the question");
  }
});

test("an HTTP failure on the range endpoint falls back rather than surfacing as no data", async () => {
  for (const status of [400, 403, 404, 500]) {
    clearCache();
    resetChartbitTrust();
    chartbitStatus = status;

    const series = await getBars({ symbol: "BBRI", bars: 24 });
    assert.equal(series.source, "paged", `HTTP ${status} should fall back`);
    assert.equal(series.bars.length, 24);
  }
});

test("a window ending in the past defers verification instead of faking it", async () => {
  // Page 1 is always the newest sessions, so it shares no bar with a historical window. "Verifying"
  // against it would compare two different sessions and reject a fast path that is actually fine.
  const series = await getBars({ symbol: "BBRI", from: day(50), to: day(30) });

  assert.equal(series.source, "paged");
  assert.equal(chartbitTrustState(), "unknown", "an untestable call must not settle the verdict either way");
  assert.equal(countOf("/chartbit/"), 0);
  assert.ok(series.bars.length > 0);
  assert.equal(series.bars[0].date, day(50));
  assert.equal(series.bars[series.bars.length - 1].date, day(30));
});

/* -------------------------------- the proven path still -------------------------------- */

test("the page walk stops as soon as the request is covered", async () => {
  chartbitStatus = 404; // force the fallback
  const series = await getBars({ symbol: "BBRI", bars: 20 });

  assert.equal(series.source, "paged");
  assert.equal(series.pagesFetched, 2, "20 bars needs 2 pages of 12, not the whole history");
  assert.equal(series.truncated, false);
});

test("a request beyond MAX_PAGES reports truncation rather than presenting a short series as whole", async () => {
  chartbitStatus = 404;
  const series = await getBars({ symbol: "BBRI", from: "1990-01-01" });

  assert.equal(series.source, "paged");
  assert.ok(series.pagesFetched <= MAX_PAGES + 1);
  // This fixture runs out of rows before MAX_PAGES, so the walk ends on an empty page, not the cap.
  assert.equal(series.bars.length, TOTAL_SESSIONS);
});

test("from/to filter the series and from wins over a bar count", async () => {
  const series = await getBars({ symbol: "BBRI", from: day(20), to: day(5), bars: 3 });
  assert.equal(series.bars[0].date, day(20));
  assert.equal(series.bars[series.bars.length - 1].date, day(5));
  assert.equal(series.from, day(20));
  assert.equal(series.to, day(5));
});

test("from after to is rejected before any request goes out", async () => {
  await assert.rejects(() => getBars({ symbol: "BBRI", from: day(1), to: day(30) }), /must not be after/);
  assert.equal(urls.length, 0, "an impossible range should not cost a request");
});
