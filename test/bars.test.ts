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
import { toBar } from "../src/core/bars.ts";
import { StockbitError } from "../src/http/errors.ts";
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
/** A per-test row set, for tests asserting on how a wire VALUE is read rather than on the walk. */
let rowsOverride: unknown[] | undefined;

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
      // A per-test row set, for the tests that assert on how a wire VALUE is read rather than on
      // the walk. One page, no next_page.
      if (rowsOverride !== undefined) {
        return json({ data: { result: rowsOverride, paginate: {} } });
      }
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
  rowsOverride = undefined;
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

test("a field the response did not carry is null on the bar, never zero", () => {
  // The rule this whole projection turns on: "no foreign participation today" and "the response
  // said nothing about foreign flow" are different answers, and `?? 0` made them the same bytes.
  // `analyze` read the first from rows that meant the second.
  const bar = toBar({ date: "2026-08-24", open: 100, high: 110, low: 90, close: 105 });
  assert.equal(bar.netForeign, null);
  assert.equal(bar.foreignBuy, null);
  assert.equal(bar.foreignSell, null);
  assert.equal(bar.volume, null);
  assert.equal(bar.value, null);
  assert.equal(bar.frequency, null);
  assert.equal(bar.change, null);
  assert.equal(bar.changePercent, null);
});

test("an EMPTY field on the wire is absent, which is where the zero used to be manufactured", async () => {
  // The one that matters, and the one `toBar`-only tests cannot reach. `z.coerce.number()` is
  // `Number()`, and `Number("")`/`Number(null)`/`Number("  ")`/`Number(false)`/`Number([])` are all
  // 0 — so with coercion in the schema the absence was destroyed BEFORE `toBar` ran, and every
  // consumer downstream saw a confident zero. This goes through the real wire path.
  rowsOverride = [
    {
      date: day(0),
      open: 1000, high: 1010, low: 990, close: 1005,
      volume: "", value: null, frequency: "  ", change: false,
      change_percentage: [], foreign_buy: ",", foreign_sell: null, net_foreign: " , ",
    },
  ];
  const series = await getBars({ symbol: "BBRI", bars: 1 });
  const bar = series.bars[0];

  assert.equal(bar.volume, null, "an empty string is not the number zero");
  assert.equal(bar.value, null);
  assert.equal(bar.frequency, null, "and neither is whitespace");
  assert.equal(bar.change, null);
  assert.equal(bar.changePercent, null);
  assert.equal(bar.foreignBuy, null);
  assert.equal(bar.foreignSell, null);
  assert.equal(bar.netForeign, null, "the field this whole rule exists for");
  assert.equal(bar.close, 1005, "and the price is untouched");
});

test("a row with an unreadable PRICE is refused, never returned with a price of zero", async () => {
  // A statistic this row did not carry is absent; a PRICE it did not carry makes the row unusable.
  // `z.coerce.number().parse(null)` is 0, and a close of 0 is not a quiet degradation: an alert
  // rule `close < 100` fires on it, `backtest` divides by an entry price of zero, and the chart
  // collapses its axis. One bad bar poisons every indicator over the series containing it.
  // "," and " , " are in this list deliberately. They have non-space content, so a guard written
  // as "trim, then check empty, then strip separators" lets them through — they become "" during
  // the strip and `Number("")` is 0. That is the fourth time this family of empties has defeated a
  // check on this branch, so the check now strips FIRST.
  for (const bad of [null, "", "  ", false, [], "abc", ",", " , ", ",,,"] as unknown[]) {
    rowsOverride = [{ date: day(0), open: 1000, high: 1010, low: 990, close: bad, volume: 1200 }];
    clearCache();
    await assert.rejects(
      () => getBars({ symbol: "BBRI", bars: 1 }),
      (err: unknown) => err instanceof StockbitError && err.kind === "schema_drift" && /close/.test(err.message),
      `a close of ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test("a real zero PRICE is still a price, because zero is a value the wire can mean", async () => {
  // The rule is what the value IS. A numeric 0 was sent; refusing it would be this server
  // overriding the response rather than declining to invent one.
  rowsOverride = [{ date: day(0), open: 0, high: 0, low: 0, close: 0, volume: 1 }];
  const series = await getBars({ symbol: "BBRI", bars: 1 });
  assert.equal(series.bars[0].close, 0);
});

test("a thousands-separated wire number is read, not reported as unreadable", async () => {
  rowsOverride = [
    { date: day(0), open: 1000, high: 1010, low: 990, close: 1005, volume: "1,234", net_foreign: "-2,500" },
  ];
  const series = await getBars({ symbol: "BBRI", bars: 1 });
  assert.equal(series.bars[0].volume, 1234);
  assert.equal(series.bars[0].netForeign, -2500);
});

test("a real zero on the wire is kept as a real zero", () => {
  // The other edge. Absence is not the only thing a zero can mean, and a session that genuinely
  // saw no foreign flow must still be able to say so.
  const bar = toBar({ date: "2026-08-24", open: 100, high: 110, low: 90, close: 105, net_foreign: 0, volume: 0 });
  assert.equal(bar.netForeign, 0);
  assert.equal(bar.volume, 0);
});

test("a missing VWAP still falls back to the close, which is an approximation and not an invention", () => {
  // `average` is deliberately NOT in the group above: the close is a stand-in for the same
  // quantity on a session with no separate VWAP. There is no such stand-in for a foreign flow.
  assert.equal(toBar({ date: "2026-08-24", open: 100, high: 110, low: 90, close: 105 }).average, 105);
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

test("`to` without `from` returns a FULL window ending at `to`, not a remnant of one", async () => {
  // The walk can only be entered at today, so a window ending in the past is reached by paging back
  // through sessions that are then discarded. Counting every row collected — including the discarded
  // ones — satisfied the request long before it held enough rows inside the window: this asked for
  // 24 sessions and got 4, and reported `truncated: false` while doing it. Every indicator computed
  // from those 4 bars would have been quietly wrong rather than absent.
  const series = await getBars({ symbol: "BBRI", to: day(20), bars: 24 });

  assert.equal(series.bars.length, 24, "the full requested count must be inside the window");
  assert.equal(series.bars[series.bars.length - 1].date, day(20), "the newest bar is `to` itself");
  assert.equal(series.bars[0].date, day(43), "and the window extends back 24 sessions from there");
  assert.equal(series.truncated, false);
  assert.ok(series.bars.every((b) => b.date <= day(20)), "nothing after `to` may survive");
});

test("`to` without `from` still reports truncation honestly when history runs out", async () => {
  // The fake market has 96 sessions. Asking for 50 ending at the 70th-oldest cannot be satisfied,
  // and the honest answer is a short series that says so — not a silent one.
  const series = await getBars({ symbol: "BBRI", to: day(70), bars: 50 });

  assert.ok(series.bars.length < 50, "the data to satisfy this does not exist");
  assert.equal(series.bars[series.bars.length - 1].date, day(70));
  assert.ok(series.bars.every((b) => b.date <= day(70)));
});
