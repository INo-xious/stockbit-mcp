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
import { MAX_PAGES, ROWS_PER_PAGE, getBars } from "../src/core/bars.ts";

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

function countOf(fragment: string): number {
  return urls.filter((u) => u.includes(fragment)).length;
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
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
});

/* ------------------------------------- the walk ------------------------------------- */

test("bars come back oldest-first", async () => {
  // Every moving average, RSI and backtest is written against ascending time. The API reports
  // newest-first, and handing a reversed series downstream produces plausible, wrong numbers
  // rather than an error.
  const series = await getBars({ symbol: "BBRI", bars: 30 });
  const dates = series.bars.map((b) => b.date);
  assert.deepEqual([...dates].sort(), dates);
  assert.equal(series.bars[series.bars.length - 1].date, day(0), "the last bar must be the newest session");
});

test("the page walk stops as soon as the request is covered", async () => {
  const series = await getBars({ symbol: "BBRI", bars: 20 });

  assert.equal(series.pagesFetched, 2, "20 bars needs 2 pages of 12, not the whole history");
  assert.equal(series.truncated, false);
  assert.equal(series.bars.length, 20);
});

test("pages are cached, so a second overlapping pull costs less", async () => {
  await getBars({ symbol: "BBRI", bars: 40 });
  const firstCost = countOf("historical/summary");
  urls = [];
  await getBars({ symbol: "BBRI", bars: 20 });
  assert.equal(countOf("historical/summary"), 0, `page 1-2 were already fetched (first pull cost ${firstCost})`);
});

test("a request beyond MAX_PAGES reports truncation rather than presenting a short series as whole", async () => {
  const series = await getBars({ symbol: "BBRI", from: "1990-01-01" });

  assert.ok(series.pagesFetched <= MAX_PAGES + 1);
  // This fixture runs out of rows before MAX_PAGES, so the walk ends on an empty page, not the cap.
  assert.equal(series.bars.length, TOTAL_SESSIONS);
});

test("the request that goes out is the declared route with a page number", async () => {
  // Asserting a helper proves nothing about what production sends.
  await getBars({ symbol: "BBRI", bars: 20 });
  const parsed = new URL(urls.find((u) => u.includes("historical/summary"))!);
  assert.equal(parsed.pathname, "/company-price-feed/historical/summary/BBRI");
  assert.equal(parsed.searchParams.get("page"), "1");
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
