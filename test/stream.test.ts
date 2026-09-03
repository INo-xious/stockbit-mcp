/**
 * Stream, news and research.
 *
 * Every assertion about a request reads the URL the code actually produced out of `seen`, and every
 * expected path comes from `resolvePath` — the route table itself — rather than from a literal
 * retyped here. A test that checked a params-building helper would have passed while the call site
 * sent something else entirely, and the path spelling is the route table's to own.
 */
// Isolate the token store before importing anything that reads it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-stream-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { resolvePath } from "../src/http/transport.ts";
import { StockbitError } from "../src/http/errors.ts";
import {
  REPORT_TYPES,
  STREAM_CATEGORIES,
  getNews,
  getPinnedPosts,
  getPost,
  getSentimentStream,
  getStream,
  getSymbolStream,
  getTrendingStream,
  getUserStream,
} from "../src/core/stream.ts";
import { getResearchCategories, getResearchIndicator } from "../src/core/research.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { makeDefiner, type ToolHandler } from "../src/tools/_define.ts";
import { registerStreamTools } from "../src/tools/stream.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/** Paths, asked of the route table rather than retyped. */
const P = {
  refresh: resolvePath("loginRefresh"),
  all: resolvePath("streamAll"),
  bbri: resolvePath("streamSymbol", { symbol: "BBRI" }),
  tlkm: resolvePath("streamSymbol", { symbol: "TLKM" }),
  pinned: resolvePath("streamSymbolPinned", { symbol: "BBRI" }),
  post: resolvePath("streamPost", { postId: "15731234" }),
  user: resolvePath("streamUser", { username: "budi.trader" }),
  trending: resolvePath("streamTrending"),
  categories: resolvePath("researchCategories"),
  indicator: resolvePath("researchIndicator"),
};

/**
 * A page shaped like the one route in this family that has been seen live.
 *
 * Deliberately awkward in three ways that have bitten this codebase before: `stream_id` arrives as a
 * number on one row and a string on the next, the second row has no `content_original` and no
 * `username`, and a row carries its own `source` key — which must not be confused with the page's
 * `source`, nor be lost.
 */
const PAGE = {
  message: "ok",
  data: {
    stream: [
      {
        stream_id: 15731234,
        content: "BBRI cetak laba bersih…",
        content_original: "$BBRI cetak laba bersih Rp 15,4 T",
        created_at: "2026-08-24 09:12:03",
        user: { username: "budi.trader", fullname: "Budi Santoso" },
        total_likes: 12,
        source: { name: "Kontan", url: "https://kontan.co.id/x" },
      },
      {
        stream_id: "15731200",
        content: "IHSG dibuka menguat",
        created_at: "2026-08-24 09:01:00",
        user: { fullname: "Sari Investor" },
      },
    ],
  },
};

interface Seen {
  url: URL;
  method: string;
  body?: unknown;
}

const realFetch = globalThis.fetch;
let seen: Seen[] = [];
/** Per-test response overrides, keyed by pathname. Anything else gets `PAGE`. */
let bodies = new Map<string, unknown>();

/** Requests that were not the session refresh — what an "it never reached the wire" test counts. */
function calls(pathname?: string): Seen[] {
  return seen.filter((r) => r.url.pathname !== P.refresh && (pathname === undefined || r.url.pathname === pathname));
}

function last(): Seen {
  const found = calls().at(-1);
  assert.ok(found, "no request was made");
  return found;
}

/** Query parameters as a plain object, with repeated keys collected into an array. */
function query(req: Seen = last()): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of req.url.searchParams) {
    const prev = out[k];
    if (prev === undefined) out[k] = v;
    else out[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = new URL(String(url));
    const raw = init?.body;
    seen.push({
      url: u,
      method: init?.method ?? "GET",
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    });
    if (u.pathname === P.refresh) {
      return new Response(JSON.stringify({ data: { access_token: farFutureJwt() } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const body = bodies.has(u.pathname) ? bodies.get(u.pathname) : PAGE;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

beforeEach(() => {
  seen = [];
  bodies = new Map();
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

/* ---------------------------------- the wire ---------------------------------- */

test("WIRE: stream sends every filter it was given, and nothing it was not", async () => {
  await getStream({
    category: "STREAM_CATEGORY_REPORTS",
    reportType: "REPORT_TYPE_DIVIDEN",
    keyword: "dividen",
    fromDate: "2026-08-01",
    toDate: "2026-08-24",
    limit: 5,
    lastStreamId: "15731000",
    lastReply: "42",
    watchlistIds: ["6252652", "14011590"],
  });

  const req = last();
  assert.equal(req.url.pathname, P.all);
  assert.equal(req.method, "GET");
  assert.deepEqual(query(), {
    category: "STREAM_CATEGORY_REPORTS",
    report_type: "REPORT_TYPE_DIVIDEN",
    keyword: "dividen",
    from_date: "2026-08-01",
    to_date: "2026-08-24",
    limit: "5",
    last_stream_id: "15731000",
    last_reply: "42",
    // Repeated, not comma-joined. If this ever has to change, it changes here and on the wire.
    watchlist_ids: ["6252652", "14011590"],
  });
});

test("WIRE: an omitted filter is ABSENT from the URL, not an empty parameter", async () => {
  await getStream();
  assert.equal(last().url.pathname, P.all);
  assert.equal(last().url.search, "");
});

test("WIRE: the per-symbol stream uppercases the ticker and carries the filters", async () => {
  await getSymbolStream("bbri", { category: "STREAM_CATEGORY_NEWS", limit: 2 });
  assert.equal(last().url.pathname, P.bbri);
  assert.deepEqual(query(), { category: "STREAM_CATEGORY_NEWS", limit: "2" });
});

test("WIRE: news is the NEWS category on the symbol route with a symbol, market-wide without", async () => {
  await getNews({ symbol: "BBRI", keyword: "laba" });
  assert.equal(last().url.pathname, P.bbri);
  assert.deepEqual(query(), { category: "STREAM_CATEGORY_NEWS", keyword: "laba" });

  clearCache();
  await getNews({ limit: 3 });
  assert.equal(last().url.pathname, P.all);
  assert.deepEqual(query(), { category: "STREAM_CATEGORY_NEWS", limit: "3" });
});

test("WIRE: pinned takes no parameters at all", async () => {
  await getPinnedPosts("BBRI");
  assert.equal(last().url.pathname, P.pinned);
  assert.equal(last().url.search, "");
});

test("WIRE: the user stream sends the cursor and limit, and the handle as a path segment", async () => {
  await getUserStream("budi.trader", { limit: 10, lastStreamId: "15731000" });
  assert.equal(last().url.pathname, P.user);
  assert.deepEqual(query(), { limit: "10", last_stream_id: "15731000" });

  clearCache();
  await getUserStream("budi.trader");
  assert.equal(last().url.search, "");
});

test("WIRE: trending is a POST that always carries a date, and no key nobody supplied", async () => {
  await getTrendingStream({ date: "2026-08-24", limit: 4 });
  const req = last();
  assert.equal(req.url.pathname, P.trending);
  assert.equal(req.method, "POST");
  assert.equal(req.url.search, "");
  assert.deepEqual(req.body, { date: "2026-08-24", limit: 4 });

  clearCache();
  await getTrendingStream();
  // NOT `{}`. This used to assert an empty body, and that assertion was pinning a defect: the
  // endpoint answers 400 "Silakan periksa konten anda" without a date, so trending never returned
  // anything. Settled live on 2026-08-29. The default is today in WIB, so it is checked by shape
  // rather than by value — a hard-coded date here would start failing tomorrow.
  const body = last().body as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ["date"], "a date, and nothing the caller did not ask for");
  assert.match(String(body.date), /^\d{4}-\d{2}-\d{2}$/);
});

test("WIRE: a post is fetched by numeric id with no query string", async () => {
  bodies.set(P.post, { data: PAGE.data.stream[0] });
  await getPost("15731234");
  assert.equal(last().url.pathname, P.post);
  assert.equal(last().url.search, "");
});

test("WIRE: research sends the symbol only when it has one", async () => {
  bodies.set(P.categories, { data: [{ id: 1, name: "Makro" }] });
  bodies.set(P.indicator, { data: { total: 0 } });

  await getResearchCategories();
  assert.equal(last().url.pathname, P.categories);
  assert.equal(last().url.search, "");

  await getResearchIndicator("bbri");
  assert.equal(last().url.pathname, P.indicator);
  assert.deepEqual(query(), { symbol: "BBRI" });

  await getResearchIndicator();
  assert.equal(last().url.search, "");
});

/* --------------------------------- projection --------------------------------- */

test("rows are projected and the untouched wire object rides along", async () => {
  const page = await getStream();

  assert.equal(page.source, "data.stream");
  assert.equal(page.items.length, 2);
  assert.deepEqual(
    page.items.map((i) => ({ id: i.id, content: i.content, createdAt: i.createdAt, author: i.author })),
    [
      {
        id: "15731234",
        // content_original wins over the truncated content.
        content: "$BBRI cetak laba bersih Rp 15,4 T",
        createdAt: "2026-08-24 09:12:03",
        author: "budi.trader",
      },
      {
        id: "15731200",
        content: "IHSG dibuka menguat",
        createdAt: "2026-08-24 09:01:00",
        // No username on this row: the full name is the fallback.
        author: "Sari Investor",
      },
    ],
  );

  // Nothing the wire sent is lost, including a row-level `source` that must not be confused with the
  // page's own `source` field.
  const raw = page.items[0].raw as Record<string, unknown>;
  assert.equal(raw.total_likes, 12);
  assert.deepEqual(raw.source, { name: "Kontan", url: "https://kontan.co.id/x" });
});

test("the cursor is the last row's id, and it is taken AFTER the client-side slice", async () => {
  const full = await getStream();
  assert.equal(full.nextCursor, "15731200");

  clearCache();
  const one = await getStream({ limit: 1 });
  assert.equal(one.items.length, 1);
  // Not the id of a row the caller was never shown, which would skip it on the next page.
  assert.equal(one.nextCursor, "15731234");
});

test("a bare array under data is recognised, and where it was found is reported", async () => {
  bodies.set(P.all, { data: [{ stream_id: 7, content: "hi" }] });
  const page = await getStream();
  assert.equal(page.source, "data");
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, "7");
});

test("a post detail is read whether it arrives as an object or as a one-row list", async () => {
  bodies.set(P.post, { data: PAGE.data.stream[0] });
  const direct = await getPost("15731234");
  assert.equal(direct.source, "data");
  assert.equal(direct.post?.id, "15731234");
  assert.equal((direct.raw as Record<string, unknown>).total_likes, 12);

  clearCache();
  bodies.set(P.post, { data: { stream: [PAGE.data.stream[1]] } });
  const wrapped = await getPost("15731234");
  assert.equal(wrapped.source, "data.stream");
  assert.equal(wrapped.post?.id, "15731200");
});

test("research rows are returned untouched, with no field renamed away", async () => {
  bodies.set(P.categories, { data: [{ category_id: 3, name: "Makro", icon_url: "https://x/y.png" }] });
  const list = await getResearchCategories();
  assert.equal(list.source, "data");
  assert.deepEqual(list.rows, [{ category_id: 3, name: "Makro", icon_url: "https://x/y.png" }]);

  bodies.set(P.indicator, { data: { total_new: 2, last_seen: "2026-08-20" } });
  const indicator = await getResearchIndicator("BBRI");
  assert.equal(indicator.symbol, "BBRI");
  assert.deepEqual(indicator.data, { total_new: 2, last_seen: "2026-08-20" });
});

/* ------------------------- empty is not the same as unreadable ------------------------- */

test("an empty list is an empty page, not an error", async () => {
  bodies.set(P.all, { data: { stream: [] } });
  const page = await getStream({ keyword: "zzzz" });
  // `source` is what says the endpoint answered and had nothing, rather than answering oddly.
  assert.equal(page.source, "data.stream");
  assert.deepEqual(page.items, []);
  assert.equal(page.nextCursor, null);
  assert.equal("unrecognized" in page, false);
});

test("a null data block is reported as unrecognised, with the body attached", async () => {
  bodies.set(P.all, { data: null });
  const page = await getStream();
  assert.equal(page.source, null);
  assert.deepEqual(page.items, []);
  assert.deepEqual(page.unrecognized, { data: null });
});

test("a shape with no list anywhere is unrecognised rather than silently empty", async () => {
  bodies.set(P.all, { data: { pagination: { next: null } } });
  const page = await getStream();
  assert.equal(page.source, null);
  assert.deepEqual(page.unrecognized, { pagination: { next: null } });
});

test("research with no recognisable list says so instead of returning no categories", async () => {
  bodies.set(P.categories, { data: { message: "none" } });
  const list = await getResearchCategories();
  assert.equal(list.source, null);
  assert.deepEqual(list.rows, []);
  assert.deepEqual(list.unrecognized, { message: "none" });
});

test("a post that could not be located is null, not an empty object", async () => {
  bodies.set(P.post, { data: null });
  const detail = await getPost("15731234");
  assert.equal(detail.post, null);
  assert.equal(detail.source, null);
});

test("the sentiment accessor still THROWS when no post list is found", async () => {
  bodies.set(P.bbri, { data: { pagination: {} } });
  await assert.rejects(
    () => getSentimentStream("BBRI"),
    (err: unknown) => err instanceof StockbitError && err.kind === "schema_drift",
  );
});

/* --------------------------------- validation --------------------------------- */

async function rejectsWithoutRequest(fn: () => Promise<unknown>, field: string): Promise<void> {
  const before = calls().length;
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof StockbitError, `${field}: expected a StockbitError`);
    assert.equal(err.kind, "invalid_param", `${field}: wrong error kind`);
    return true;
  });
  assert.equal(calls().length, before, `${field}: a rejected value still reached the wire`);
}

test("a rejected argument never reaches the wire", async () => {
  // Warm the session so the refresh request cannot be mistaken for the request under test.
  await getStream();

  await rejectsWithoutRequest(() => getStream({ category: "NEWS" }), "category (unprefixed)");
  await rejectsWithoutRequest(() => getStream({ reportType: "REPORT_TYPE_NOPE" }), "report_type");
  await rejectsWithoutRequest(() => getStream({ fromDate: "2026-02-30" }), "from_date (not a real day)");
  await rejectsWithoutRequest(() => getStream({ toDate: "20260824" }), "to_date (compact form)");
  await rejectsWithoutRequest(
    () => getStream({ fromDate: "2026-08-24", toDate: "2026-08-01" }),
    "inverted range",
  );
  await rejectsWithoutRequest(() => getStream({ limit: 0 }), "limit 0");
  await rejectsWithoutRequest(() => getStream({ limit: 2.5 }), "fractional limit");
  await rejectsWithoutRequest(() => getStream({ watchlistIds: ["6252652", "../etc"] }), "watchlist id");
  await rejectsWithoutRequest(() => getSymbolStream("BB RI"), "symbol");
  await rejectsWithoutRequest(() => getTrendingStream({ date: "24-08-2026" }), "trending date");
  await rejectsWithoutRequest(() => getPost("post-15731234"), "post id");
  await rejectsWithoutRequest(() => getUserStream("budi trader"), "username");
  await rejectsWithoutRequest(() => getResearchIndicator("BB RI"), "research symbol");
});

test("every declared enum value is accepted", async () => {
  for (const category of STREAM_CATEGORIES) {
    clearCache();
    await getStream({ category });
    assert.equal(query().category, category);
  }
  for (const reportType of REPORT_TYPES) {
    clearCache();
    await getStream({ category: "STREAM_CATEGORY_REPORTS", reportType });
    assert.equal(query().report_type, reportType);
  }
});

/* ----------------------------------- caching ----------------------------------- */

test("the cache key distinguishes two different argument sets", async () => {
  await getStream({ limit: 1 });
  await getStream({ limit: 2 });
  assert.equal(calls(P.all).length, 2, "a differing limit must not be served from cache");

  await getStream({ limit: 1 });
  assert.equal(calls(P.all).length, 2, "an identical query must be served from cache");

  await getStream({ keyword: "laba", limit: 1 });
  assert.equal(calls(P.all).length, 3, "a differing keyword must not be served from cache");

  await getSymbolStream("BBRI");
  await getSymbolStream("TLKM");
  assert.equal(calls(P.bbri).length, 1);
  assert.equal(calls(P.tlkm).length, 1);
});

test("the research indicator is cached per symbol", async () => {
  bodies.set(P.indicator, { data: { total_new: 1 } });
  await getResearchIndicator("BBRI");
  await getResearchIndicator("BBRI");
  assert.equal(calls(P.indicator).length, 1);
  await getResearchIndicator("TLKM");
  assert.equal(calls(P.indicator).length, 2);
});

/**
 * The bug this file was opened to fix.
 *
 * The old key was `stream:${symbol}` while the answer depended on `limit`, so asking for 5 and then
 * for 50 returned five rows twice. The fix is not a longer key: the full page is cached and the
 * slice happens after, so the second call is BOTH served from cache and correct.
 */
test("asking for more rows after asking for fewer returns more, from one request", async () => {
  const few = await getSentimentStream("BBRI", 1);
  assert.equal(few.length, 1);

  const more = await getSentimentStream("BBRI", 50);
  assert.equal(more.length, 2, "the second caller was served the first caller's slice");
  assert.equal(calls(P.bbri).length, 1, "the page should have been cached, not re-fetched");
});

test("the sentiment accessor's request is unchanged: no query string, lean rows", async () => {
  const posts = await getSentimentStream("BBRI");
  assert.equal(last().url.pathname, P.bbri);
  assert.equal(last().url.search, "");
  assert.deepEqual(Object.keys(posts[0]).sort(), ["author", "content", "createdAt", "id"]);
});

test("a post that carries its replies under `stream` returns the POST, not the first reply", async () => {
  bodies.set(P.post, { data: { ...PAGE.data.stream[0], stream: [PAGE.data.stream[1]] } });
  const detail = await getPost("15731234");
  assert.equal(detail.source, "data");
  assert.equal(detail.post?.id, "15731234", "the reply list was mistaken for the post");
});

test("the user route's own spellings map, not just its content", async () => {
  // /stream/non-login/user/:username sends `postid`, `created` and a FLAT username — where the
  // per-symbol route sends `stream_id`, `created_at` and a nested `user`. Settled live on
  // 2026-08-29: before this, a user row matched ONE of the four named fields out of sixty wire
  // keys, and the other three read as absent rather than as "spelled differently here".
  clearCache();
  bodies.set(P.user, {
    data: [
      {
        postid: 35259019,
        content: "EMAS: Rugi Bersih US$14,9",
        content_original: "EMAS: Rugi Bersih US$14,9",
        created: "2026-08-28 19:53:36",
        username: "Stockbit",
        fullname: "Stockbit Official",
      },
    ],
  });
  const page = await getUserStream("budi.trader");
  assert.equal(page.items.length, 1);
  const item = page.items[0];
  assert.equal(item.id, "35259019");
  assert.equal(item.createdAt, "2026-08-28 19:53:36");
  assert.equal(item.author, "Stockbit");
  assert.ok(item.content?.startsWith("EMAS"));
});

/* ------------------------------ the tool layer: include_raw ------------------------------ */

/**
 * The five page tools, reached the way `workflow_run` reaches them.
 *
 * Registered against the same `define.family("stream", { evidence: "projected" })` the real server
 * uses, so a tool that opted out of that default is exercised with the options it really ships with.
 * Everything above this line calls the core readers directly; `raw` is stripped in the TOOL, so a
 * core-level test cannot see this change at all.
 */
function streamHandlers(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const server = { registerTool: () => ({ enable() {}, disable() {}, remove() {} }) } as unknown as McpServer;
  registerStreamTools(makeDefiner(server, handlers).family("stream", { evidence: "projected" }));
  return handlers;
}

/** Unwrap the JSON text block a tool result carries, the way `invokeTool` does. */
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = streamHandlers().get(name);
  assert.ok(handler, `${name} is not registered as a read`);
  const result = (await handler(args)) as { content: { type: string; text: string }[]; isError?: boolean };
  const parsed = JSON.parse(result.content[0].text) as { success: boolean; data: Record<string, unknown> };
  assert.equal(parsed.success, true, `${name} failed: ${result.content[0].text.slice(0, 200)}`);
  return parsed.data;
}

const PAGE_TOOLS: [string, Record<string, unknown>][] = [
  ["stream", { symbol: "BBRI" }],
  ["news", { symbol: "BBRI" }],
  ["stream_trending", {}],
  ["stream_pinned", { symbol: "BBRI" }],
  ["stream_user", { username: "budi.trader" }],
];

for (const [name, args] of PAGE_TOOLS) {
  test(`${name} omits raw by default and returns it when asked`, async () => {
    const lean = await call(name, args);
    const items = lean.items as Record<string, unknown>[];
    assert.ok(items.length > 0, "the fixture must actually return rows or this proves nothing");
    for (const item of items) {
      assert.ok(!("raw" in item), `${name} returned a row still carrying raw`);
    }

    const full = await call(name, { ...args, include_raw: true });
    const fullItems = full.items as Record<string, unknown>[];
    assert.equal(fullItems.length, items.length);
    for (const item of fullItems) {
      assert.ok("raw" in item, `${name} with include_raw=true must return the wire object`);
    }
  });
}

test("stripping raw leaves every projected field and the cursor untouched", async () => {
  const lean = await call("stream", { symbol: "BBRI" });
  const full = await call("stream", { symbol: "BBRI", include_raw: true });

  assert.equal(lean.source, full.source);
  assert.equal(lean.nextCursor, full.nextCursor, "nextCursor is taken from `id`, which is never stripped");
  assert.notEqual(lean.nextCursor, null, "the premise: this fixture does produce a cursor");

  const strip = (rows: Record<string, unknown>[]) => rows.map(({ raw: _raw, ...rest }) => rest);
  assert.deepEqual(lean.items, strip(full.items as Record<string, unknown>[]), "raw is the ONLY difference");
});

test("a field the row did not carry is absent from the JSON a model reads", async () => {
  // Scoped to what this can actually prove. An earlier version of this comment claimed it caught a
  // strip rewritten as `{ id: item.id, content: item.content, ... }` — it does not: that produces
  // `author: undefined`, and JSON.stringify drops undefined keys, so the text block is identical
  // either way. What IS worth pinning is the end state a model sees: the four projected names never
  // appear as null or empty strings just because the wire did not carry them.
  bodies.set(P.bbri, { data: { stream: [{ stream_id: 9, content: "cuma isi" }] } });
  const lean = await call("stream", { symbol: "BBRI" });
  const row = (lean.items as Record<string, unknown>[])[0];
  assert.deepEqual(Object.keys(row).sort(), ["content", "id"], "only what the wire actually carried");
  assert.ok(!("author" in row), "an unmapped field is absent, never null and never an empty string");
  assert.ok(!("createdAt" in row));
});

test("include_raw=true after a default call still gets raw — the cached page was not stripped", async () => {
  // These pages are memoised (`cached(requestKey("stream:symbol", ...))`), and `cached()` hands
  // every caller the SAME object. A `delete item.raw` instead of a copy would strip the wire object
  // out of the cached page, so this second call — which explicitly asked for raw — would be told,
  // with no error at all, that it does not exist.
  const lean = await call("stream", { symbol: "BBRI" });
  assert.ok(!("raw" in (lean.items as Record<string, unknown>[])[0]), "the premise: the first call was lean");

  const full = await call("stream", { symbol: "BBRI", include_raw: true });
  const first = (full.items as Record<string, unknown>[])[0];
  assert.ok("raw" in first, "the cached page must still carry raw for a later caller who asks");
  assert.equal((first.raw as Record<string, unknown>).total_likes, 12, "and it must be the whole wire object");
});

test("unrecognized survives the strip — it is how `empty` and `unreadable` stay different", async () => {
  // src/instructions.ts tells the model that a null `source` means NOT PARSED rather than none, and
  // `unrecognized` is the payload it reads to find out what arrived instead. Stripping rows must
  // never touch it, and must not invent it on a page that parsed.
  bodies.set(P.bbri, { data: { unexpected: "a shape this code has not seen" } });
  const odd = await call("stream", { symbol: "BBRI" });
  assert.equal(odd.source, null);
  assert.deepEqual(odd.items, []);
  assert.ok("unrecognized" in odd, "the body must survive so a reader can see what came instead");
  assert.deepEqual(odd.unrecognized, { unexpected: "a shape this code has not seen" });

  // Back to the ordinary fixture: the override and the cache both have to go, or this second call
  // re-reads the same unreadable body and proves nothing.
  bodies.delete(P.bbri);
  clearCache();
  const normal = await call("stream", { symbol: "BBRI" });
  assert.equal(normal.source, "data.stream", "the premise: this page parsed");
  assert.ok(!("unrecognized" in normal), "and it must not be invented on a page that parsed");
});

test("a row too broken to project survives the strip as an empty row, not as a dropped one", async () => {
  // `projectItem` answers a non-object row with `{ raw: row }` and nothing else, because raw is the
  // only honest thing to say about it. Stripping that leaves `{}` — thin, but it keeps the ROW, so
  // `items.length` still says how many rows the page held. Losing it would under-report the page.
  bodies.set(P.bbri, { data: { stream: ["not an object", { stream_id: 4 }] } });
  const lean = await call("stream", { symbol: "BBRI" });
  const rows = lean.items as Record<string, unknown>[];
  assert.equal(rows.length, 2, "the unreadable row is still counted");
  assert.deepEqual(rows[0], {});
  assert.deepEqual(rows[1], { id: "4" });

  const full = await call("stream", { symbol: "BBRI", include_raw: true });
  assert.equal((full.items as Record<string, unknown>[])[0].raw, "not an object", "include_raw still shows it");
});

test("include_raw is only honoured for a literal true", async () => {
  // `workflow_run` hands recipe inputs to handlers without the zod schema, so a recipe can deliver
  // the STRING "false". `=== true` is what makes that harmless; `Boolean(x)` would not be.
  for (const value of ["false", "true", 1, 0, null, undefined]) {
    const data = await call("stream", { symbol: "BBRI", include_raw: value });
    const items = data.items as Record<string, unknown>[];
    assert.ok(!("raw" in items[0]), `include_raw=${JSON.stringify(value)} must not be read as yes`);
  }
});

test("stream_post_detail still returns raw, and has no include_raw to turn it off", async () => {
  // It returns ONE object, not a page, and `raw` is the whole `data` block. The shared PENDING_NOTE
  // used to promise raw for both; splitting it is why this assertion exists.
  const handlers = streamHandlers();
  const result = (await handlers.get("stream_post_detail")!({ post_id: "15731234" })) as {
    content: { text: string }[];
  };
  const parsed = JSON.parse(result.content[0].text) as { success: boolean; data: Record<string, unknown> };
  assert.equal(parsed.success, true);
  assert.ok("raw" in parsed.data, "the detail tool's raw is unconditional");
  assert.ok("raw" in (parsed.data.post as Record<string, unknown>), "and so is its post's");
});
