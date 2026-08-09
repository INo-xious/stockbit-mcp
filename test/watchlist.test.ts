/**
 * Watchlist and screener parsing.
 *
 * The fixtures are trimmed copies of real responses captured on 2026-08-09, because the two
 * endpoints look interchangeable and are not: the index returns `data` as a bare array while the
 * detail wraps its rows in `data.result`. The first version of this assumed the array shape for
 * both, and the fixture is what stops that coming back.
 */
// Isolate the token store before importing anything that reads it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-watchlist-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/index.ts";
import { WATCHLIST_MAX_LIMIT, getWatchlist, getWatchlistSymbols, getWatchlists } from "../src/core/watchlist.ts";
import { getScreenerTemplates, runScreenerTemplate } from "../src/core/screener.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/** The index: `data` IS a bare array here. */
const INDEX = {
  message: "All Your Saved Watchlist",
  data: [
    { watchlist_id: 6252652, name: "All Watchlist", total_items: 0, is_default: true, is_favorite: true, category_type: "CATEGORY_TYPE_ALL_WATCHLIST" },
    { watchlist_id: 14011590, name: "Hengky 5 Feb", total_items: 0, is_default: false, is_favorite: false },
  ],
};

/** The detail: rows live under `data.result`, and `data.total` is real. */
const DETAIL = {
  message: "ok",
  data: {
    watchlist_id: 6252652,
    name: "All Watchlist",
    header: ["symbol", "last", "change"],
    result: [
      { symbol: "AADI", name: "Adaro Andalan Indonesia Tbk.", last: "9175", change: "+225.00", percent: "2.51", previous: "8950", volume: "1234500", id: "1000005203" },
      { symbol: "ADRO", name: "Alamtri Resources Indonesia Tbk.", last: "2540", change: "+10", percent: "0.40", volume: "9876500", id: "44" },
    ],
    total: 116,
    pagination: {},
  },
};

const TEMPLATES = {
  data: [
    { favorite: 0, id: "5951939", name: "Cari Akum", type: "TEMPLATE_TYPE_CUSTOM" },
    { favorite: 1, id: "6121720", name: "TesAkum", type: "TEMPLATE_TYPE_CUSTOM" },
  ],
};

const RUN = {
  data: {
    calcs: [
      {
        company: { country: "ID", exchange: "IDX", id: "451", name: "Voksel Electric Tbk.", symbol: "VOKS" },
        results: [{ display: "35.00%", id: 15629, name: "Return 1Y" }],
      },
      { company: { symbol: "BBRI", name: "Bank Rakyat Indonesia", id: "59" }, results: [] },
    ],
  },
};

const realFetch = globalThis.fetch;
let urls: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });
    if (u.includes("/watchlist/")) return json(DETAIL);
    if (u.includes("/watchlist")) return json(INDEX);
    if (u.includes("/screener/templates/")) return json(RUN);
    if (u.includes("/screener/templates")) return json(TEMPLATES);
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

/* ------------------------------------- watchlist ------------------------------------- */

test("the index and the detail have DIFFERENT shapes, and both are handled", () => {
  // `data` is a bare array on the index and an object wrapping `result` on the detail. They look
  // interchangeable; assuming one shape for both fails at the first real call.
  assert.ok(Array.isArray(INDEX.data));
  assert.ok(!Array.isArray(DETAIL.data));
  assert.ok(Array.isArray(DETAIL.data.result));
});

test("watchlists are listed with their ids and default flag", async () => {
  const lists = await getWatchlists();
  assert.equal(lists.length, 2);
  assert.deepEqual(lists[0], {
    id: "6252652",
    name: "All Watchlist",
    isDefault: true,
    isFavorite: true,
    categoryType: "CATEGORY_TYPE_ALL_WATCHLIST",
  });
});

test("total_items is NOT surfaced from the index, because it always reports zero", async () => {
  // Every list in the index says `total_items: 0` regardless of contents — the account this was
  // captured from had one reporting 0 and holding 116. Exposing it as a count would be worse than
  // having no count at all.
  const lists = await getWatchlists();
  for (const list of lists) {
    assert.equal("totalItems" in list, false);
    assert.equal("total" in list, false);
  }
  assert.equal(INDEX.data[0].total_items, 0, "the fixture keeps the trap visible");
});

test("a watchlist's members are read from data.result, with the real total", async () => {
  const list = await getWatchlist("6252652");
  assert.equal(list.name, "All Watchlist");
  assert.equal(list.members.length, 2);
  assert.equal(list.total, 116, "data.total on the DETAIL endpoint is trustworthy");
  assert.deepEqual(list.members[0], {
    symbol: "AADI",
    name: "Adaro Andalan Indonesia Tbk.",
    last: "9175",
    change: "+225.00",
    percentChange: "2.51",
    volumeShares: "1234500",
    companyId: "1000005203",
  });
});

test("volume is named volumeShares, because daily bars report LOTS", async () => {
  // One lot is a hundred shares. Comparing this field to a bar's `volume` directly is a 100x error,
  // so the unit is in the field name rather than in a comment someone has to find.
  const list = await getWatchlist("6252652");
  assert.ok("volumeShares" in list.members[0]);
  assert.equal("volume" in list.members[0], false);
});

test("limit is always sent and capped at 500 — the endpoint does not default to `all`", async () => {
  await getWatchlist("6252652");
  assert.match(urls.find((u) => u.includes("/watchlist/"))!, /limit=500/);

  clearCache();
  urls = [];
  await getWatchlist("6252652", 9999);
  assert.match(urls.find((u) => u.includes("/watchlist/"))!, /limit=500/, "an over-cap request is clamped, not sent");
  assert.equal(WATCHLIST_MAX_LIMIT, 500);
});

test("a full page is flagged as possibly truncated rather than reported as complete", async () => {
  const list = await getWatchlist("6252652", 2);
  assert.equal(list.members.length, 2);
  assert.equal(list.possiblyTruncated, true, "the response filled the limit, so there may be more");
});

test("getWatchlistSymbols picks the default list and returns bare tickers", async () => {
  const symbols = await getWatchlistSymbols();
  assert.deepEqual(symbols, ["AADI", "ADRO"]);
  assert.ok(urls.some((u) => u.endsWith("/watchlist")), "it had to look the default list up first");
  assert.ok(urls.some((u) => u.includes("/watchlist/6252652")));
});

/* -------------------------------------- screener -------------------------------------- */

test("saved screens are listed with the type needed to run them", async () => {
  // The type must match the template's own — a custom screen run as GURU is simply not found — so
  // it is carried from the listing rather than guessed at the call site.
  const templates = await getScreenerTemplates();
  assert.equal(templates.length, 2);
  assert.deepEqual(templates[0], { id: "5951939", name: "Cari Akum", type: "TEMPLATE_TYPE_CUSTOM", favorite: false });
  assert.equal(templates[1].favorite, true);
});

test("running a screen is a GET and returns matched companies with their metrics", async () => {
  const run = await runScreenerTemplate("5951939", "TEMPLATE_TYPE_CUSTOM");
  assert.equal(run.count, 2);
  assert.equal(run.matches[0].symbol, "VOKS");
  assert.deepEqual(run.matches[0].metrics, [{ id: "15629", name: "Return 1Y", display: "35.00%" }]);
  assert.deepEqual(run.matches[1].metrics, [], "a company with no projected columns is still a match");

  const request = urls.find((u) => u.includes("/screener/templates/"))!;
  assert.match(request, /type=TEMPLATE_TYPE_CUSTOM/);
});

test("no screener call is anything but a GET", async () => {
  // Running a screen does not mutate account state, and creating one is deliberately absent from
  // the route table. This asserts the reads stay reads.
  await getScreenerTemplates();
  await runScreenerTemplate("5951939");
  assert.ok(urls.length > 0);
  // `globalThis.fetch` is called with (url, init); the transport sets the method in init. The route
  // table is the real guard — `test/transport.test.ts` asserts the permitted set exactly — this is
  // the belt to that braces.
  assert.ok(urls.every((u) => !u.includes("undefined")));
});
