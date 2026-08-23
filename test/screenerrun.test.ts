/**
 * Ad-hoc screener runs and the watchlist reads beside them.
 *
 * The load-bearing test in this file is the first one. Running a screen and saving one are the same
 * endpoint separated by a single body field, so "this tool creates nothing" is a claim about one
 * character on the wire — and the only honest way to hold it is to read that character out of the
 * request that actually went out, for every input a caller could supply.
 *
 * None of these routes has been observed live. The response fixtures are therefore shaped like the
 * sibling endpoints that HAVE been (`data.calcs` from the saved-screen GET, `data.result` from the
 * watchlist detail), and the tests assert that a payload which does NOT match is reported as
 * unlocated rather than flattened into an empty answer.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-screenerrun-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import {
  SCREEN_OPERATORS,
  buildScreenBody,
  findRows,
  getScreenerFavorites,
  getScreenerFinItems,
  getWatchlistSymbolList,
  runScreen,
  searchCompanies,
  watchlistScope,
  type ScreenRule,
} from "../src/core/screenerrun.ts";
import { registerScreenerTools } from "../src/tools/screener.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* --------------------------------- fixtures --------------------------------- */

/** Shaped like the saved-screen GET, which is the only run response anyone has seen. */
const RUN = {
  message: "ok",
  data: {
    calcs: [
      {
        company: { country: "ID", exchange: "IDX", id: "451", name: "Voksel Electric Tbk.", symbol: "VOKS" },
        results: [{ display: "35.00%", id: 15629, name: "Return 1Y", value: 0.35 }],
      },
      { company: { symbol: "BBRI", name: "Bank Rakyat Indonesia", id: "59" }, results: [] },
    ],
  },
};

const FAVORITES = { data: [{ id: "5951939", name: "Cari Akum", type: "TEMPLATE_TYPE_CUSTOM" }] };
const FINITEMS = { data: { result: [{ id: "1010", name: "Total Revenue" }] } };
const SYMBOLS = { data: { symbols: ["BBRI", "aadi", "not a ticker", { symbol: "ADRO" }] } };
const SEARCH = { data: { result: [{ symbol: "BBRI", name: "Bank Rakyat Indonesia (Persero) Tbk." }] } };

/* ------------------------------- the fake wire ------------------------------- */

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
let sent: Sent[] = [];
/** Swapped per-test where a test needs a different payload from the same route. */
let runResponse: unknown = RUN;
let symbolsResponse: unknown = SYMBOLS;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });
    sent.push({
      url: u,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (u.includes("/screener/templates")) return json(runResponse);
    if (u.includes("/screener/favorites")) return json(FAVORITES);
    if (u.includes("/screener/finitem-watchlist")) return json(FINITEMS);
    if (u.includes("/watchlist/search/company")) return json(SEARCH);
    if (u.includes("/symbols")) return json(symbolsResponse);
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;
});

beforeEach(() => {
  sent = [];
  runResponse = RUN;
  symbolsResponse = SYMBOLS;
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
});

const path = (entry: Sent) => new URL(entry.url).pathname;
const only = (): Sent => {
  assert.equal(sent.length, 1, `expected exactly one request, got ${sent.length}`);
  return sent[0];
};

const RULES: ScreenRule[] = [
  { metric: "1234", operator: ">", value: 10 },
  { metric: "5678", operator: "<=", value: "2.5" },
];

/* ================================ the save flag ================================ */

test("an ad-hoc run POSTs save 0 on the real request body", async () => {
  await runScreen(RULES);
  const request = only();
  assert.equal(request.method, "POST");
  assert.equal(path(request), "/screener/templates");
  const body = request.body as Record<string, unknown>;
  assert.equal(body.save, "0", "save 0 runs the screen; save 1 would CREATE one on the account");
  assert.notEqual(body.save, "1");
});

test("no argument a caller can supply changes the save flag", async () => {
  // The point of the hard-coding is that there is no input to reach it, so the assertion has to be
  // made over inputs rather than over the one call above. Every one of these is a plausible attempt
  // by a model that read "save" somewhere and tried to set it.
  const hostile: Array<{ rules: ScreenRule[]; watchlistId?: string }> = [
    { rules: [{ metric: "save", operator: "=", value: "1" }] },
    { rules: [{ metric: "1234", operator: "=", value: 1 }], watchlistId: "1" },
    { rules: [{ metric: '{"save":"1"}', operator: ">", value: '1","save":"1' }] },
    { rules: [{ metric: "save", operator: "=", value: 1 }, { metric: "save", operator: "=", value: "1" }] },
  ];
  for (const attempt of hostile) {
    clearCache();
    sent = [];
    const result = await runScreen(attempt.rules, {
      scope: attempt.watchlistId ? watchlistScope(attempt.watchlistId) : undefined,
    });
    const body = only().body as Record<string, unknown>;
    assert.equal(body.save, "0", `save was altered by ${JSON.stringify(attempt)}`);
    assert.equal(result.request.save, "0", "and the body reported back is the body that went out");
  }
});

test("buildScreenBody takes no parameter that could carry a save value", () => {
  // Structural, and deliberately so: an added third parameter is the shape this whole file guards
  // against, and it would otherwise pass every behavioural test above until someone passed it.
  assert.equal(buildScreenBody.length, 2, "expected exactly (rules, scope)");
  const body = buildScreenBody(RULES, watchlistScope("5455717"));
  assert.equal(body.save, "0");
  // Called through a signature that pretends there is a third argument, the way a future caller
  // would: it must be ignored, not adopted.
  const sneaky = buildScreenBody as unknown as (r: readonly ScreenRule[], s?: unknown, save?: string) => { save: string };
  assert.equal(sneaky(RULES, undefined, "1").save, "0");
});

/* ================================ the rule grammar ================================ */

test("the operator list is the five comparisons, and there is no OR", () => {
  assert.deepEqual([...SCREEN_OPERATORS], [">", "<", ">=", "<=", "="]);
  assert.equal((SCREEN_OPERATORS as readonly string[]).includes("or"), false);
});

test("an OR-shaped operator is refused instead of being reinterpreted as AND", async () => {
  for (const operator of ["or", "OR", "||", "!=", "all"]) {
    await assert.rejects(
      () => runScreen([{ metric: "1234", operator: operator as never, value: 1 }]),
      /invalid operator/i,
    );
  }
  assert.equal(sent.length, 0, "a rejected screen must not reach the wire");
});

test("a screen with no rules is refused rather than run over the entire market", async () => {
  await assert.rejects(() => runScreen([]), /at least one rule/);
  assert.equal(sent.length, 0);
});

test("an empty or non-finite value is refused, because an empty value would screen for zero", async () => {
  // Number("") is 0. A rule that reached the wire with an empty value would be a filter for zero
  // wearing the name of the metric the caller actually asked about.
  await assert.rejects(() => runScreen([{ metric: "1234", operator: ">", value: "   " }]), /must not be empty/);
  await assert.rejects(() => runScreen([{ metric: "1234", operator: ">", value: NaN }]), /finite/);
  await assert.rejects(() => runScreen([{ metric: "   ", operator: ">", value: 1 }]), /metric/);
  assert.equal(sent.length, 0);
});

test("values are stringified and rules keep the order they were given", async () => {
  await runScreen(RULES);
  const body = only().body as { rules: Array<Record<string, unknown>> };
  assert.deepEqual(body.rules, [
    { metric: "1234", operator: ">", value: "10" },
    { metric: "5678", operator: "<=", value: "2.5" },
  ]);
});

/* ================================== the scope ================================== */

test("a watchlist scope is the documented pair, and it replaces nothing else in the body", async () => {
  assert.deepEqual(watchlistScope("5455717"), { scope: "wl", scopeID: "5455717" });
  await runScreen(RULES, { scope: watchlistScope("5455717") });
  const body = only().body as Record<string, unknown>;
  assert.equal(body.scope, "wl");
  assert.equal(body.scopeID, "5455717");
  assert.equal(body.save, "0");
});

test("an unscoped screen sends no scope keys at all rather than empty ones", async () => {
  await runScreen(RULES);
  const body = only().body as Record<string, unknown>;
  assert.equal("scope" in body, false);
  assert.equal("scopeID" in body, false);
});

test("a non-numeric watchlist id is refused before anything is sent", () => {
  // The id goes in a BODY, so no path-segment validator sees it. Nothing else would catch this.
  for (const bad of ["", "abc", "12a", "../6252652", "6252652;1", "6.2e6"]) {
    assert.throws(() => watchlistScope(bad), /numeric id/, bad);
  }
  assert.equal(sent.length, 0);
  assert.deepEqual(watchlistScope(" 6252652 "), { scope: "wl", scopeID: "6252652" }, "padding is trimmed");
});

/* ================================ the projection ================================ */

test("matches are projected, and a metric cell is passed through whole", async () => {
  const result = await runScreen(RULES);
  assert.equal(result.foundAt, "data.calcs");
  assert.equal(result.count, 2);
  assert.equal(result.matches?.[0].symbol, "VOKS");
  assert.equal(result.matches?.[0].companyId, "451");
  assert.deepEqual(result.matches?.[0].metrics, [
    // `value` survives: naming a subset of the cell would drop the raw number and leave only the
    // formatted string, which is exactly the loss `getSectors` documents.
    { display: "35.00%", id: "15629", name: "Return 1Y", value: 0.35 },
  ]);
  assert.deepEqual(result.matches?.[1].metrics, [], "a match with no projected columns is still a match");
  assert.equal(result.unprojected, 0);
});

test("an empty result set is an empty result, not an error and not a null", async () => {
  runResponse = { data: { calcs: [] } };
  const result = await runScreen(RULES);
  assert.deepEqual(result.matches, []);
  assert.equal(result.count, 0);
  assert.equal(result.foundAt, "data.calcs");
  assert.equal("raw" in result, false, "nothing to diagnose: the rows were found and there were none");
});

test("a response whose rows are not where we look is reported as unlocated, NOT as zero matches", async () => {
  for (const payload of [{ data: null }, { data: {} }, { message: "ok" }, { data: { total: 0 } }]) {
    clearCache();
    runResponse = payload;
    const result = await runScreen(RULES);
    assert.equal(result.matches, null, `${JSON.stringify(payload)} must not read as "nothing matched"`);
    assert.equal(result.count, null);
    assert.equal(result.foundAt, null);
    assert.deepEqual(result.raw, payload, "the payload comes back so the real shape can be reported");
  }
});

test("a row with no ticker is counted and sampled rather than silently dropped", async () => {
  runResponse = { data: { calcs: [{ company: { symbol: "BBRI" } }, { rank: 2, results: [] }] } };
  const result = await runScreen(RULES);
  assert.equal(result.count, 1);
  assert.equal(result.unprojected, 1);
  assert.deepEqual(result.unprojectedSample, { rank: 2, results: [] });
});

test("findRows says WHERE it found the rows, and null when it did not", () => {
  assert.deepEqual(findRows(["BBRI"]), { rows: ["BBRI"], foundAt: "data" });
  assert.deepEqual(findRows({ result: [1] }), { rows: [1], foundAt: "data.result" });
  assert.deepEqual(findRows({ total: 0 }), { rows: null, foundAt: null });
  assert.deepEqual(findRows(null), { rows: null, foundAt: null });
});

/* =============================== limit and caching =============================== */

test("limit trims the answer without touching the request, and count stays the true total", async () => {
  const full = await runScreen(RULES);
  assert.equal(full.count, 2);
  assert.equal(full.truncated, false);

  const trimmed = await runScreen(RULES, { limit: 1 });
  assert.equal(trimmed.matches?.length, 1);
  assert.equal(trimmed.count, 2, "count is what matched, not what was returned");
  assert.equal(trimmed.truncated, true);
  // The limit is applied here, not on the wire, so it cannot have changed the request — and the
  // cache is keyed on the request alone, which is why the second call cost nothing.
  assert.equal(sent.length, 1);
});

test("a limit below 1 is refused before the request rather than clamped", async () => {
  await assert.rejects(() => runScreen(RULES, { limit: 0 }), /Invalid limit/);
  await assert.rejects(() => runScreen(RULES, { limit: -5 }), /Invalid limit/);
  assert.equal(sent.length, 0);
});

test("two different rule sets do not share a cached answer", async () => {
  await runScreen(RULES);
  await runScreen(RULES);
  assert.equal(sent.length, 1, "the same screen twice is one request");

  await runScreen([{ metric: "1234", operator: ">", value: 11 }]);
  assert.equal(sent.length, 2, "a different threshold is a different screen");

  await runScreen(RULES, { scope: watchlistScope("5455717") });
  assert.equal(sent.length, 3, "the same rules over a different universe is a different screen");
});

/* ================================ screener lists ================================ */

test("favorites is a bare GET with no query string, and its rows are returned as they arrive", async () => {
  const favorites = await getScreenerFavorites();
  const request = only();
  assert.equal(request.method, "GET");
  assert.equal(path(request), "/screener/favorites");
  assert.equal(new URL(request.url).search, "", "no optional argument means no empty parameter");
  assert.equal(favorites.foundAt, "data");
  assert.equal(favorites.count, 1);
  assert.deepEqual(favorites.rows, FAVORITES.data);
});

test("the fin-item watchlist reads rows out of data.result", async () => {
  const items = await getScreenerFinItems();
  assert.equal(path(only()), "/screener/finitem-watchlist");
  assert.equal(items.foundAt, "data.result");
  assert.deepEqual(items.rows, FINITEMS.data.result);
});

test("a list route that answers with no list reports null, not an empty list", async () => {
  // Same distinction as the run: "there are none" and "we could not find them" are different
  // answers, and on an unprobed route the second is the likely one.
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });
    sent.push({ url: u, method: init?.method ?? "GET", body: undefined });
    return json({ data: { unexpected: true } });
  }) as typeof fetch;
  try {
    const favorites = await getScreenerFavorites();
    assert.equal(favorites.rows, null);
    assert.equal(favorites.count, null);
    assert.deepEqual(favorites.raw, { data: { unexpected: true } });
  } finally {
    globalThis.fetch = original;
  }
});

/* =============================== watchlist reads =============================== */

test("watchlist symbols hits the id's own symbols path and normalizes the tickers", async () => {
  const list = await getWatchlistSymbolList("6252652");
  assert.equal(path(only()), "/watchlist/6252652/symbols");
  assert.equal(new URL(only().url).search, "");
  assert.deepEqual(list.symbols, ["BBRI", "AADI", "ADRO"], "a lowercase ticker and an object row both resolve");
  assert.equal(list.count, 3);
  assert.equal(list.unprojected, 1, "\"not a ticker\" is counted, not quietly dropped");
  assert.equal(list.unprojectedSample, "not a ticker");
  assert.deepEqual(list.rows, SYMBOLS.data.symbols, "the rows were not all bare strings, so they are kept");
});

test("bare-string rows are not duplicated back as `rows`", async () => {
  symbolsResponse = { data: ["BBRI", "ADRO"] };
  const list = await getWatchlistSymbolList("6252652");
  assert.deepEqual(list.symbols, ["BBRI", "ADRO"]);
  assert.equal("rows" in list, false, "symbols already is the payload");
});

test("an empty watchlist and an unlocatable one are different answers", async () => {
  symbolsResponse = { data: { symbols: [] } };
  const empty = await getWatchlistSymbolList("6252652");
  assert.deepEqual(empty.symbols, []);
  assert.equal(empty.count, 0);

  clearCache();
  symbolsResponse = { data: { count: 0 } };
  const unlocated = await getWatchlistSymbolList("6252652");
  assert.equal(unlocated.symbols, null);
  assert.equal(unlocated.count, null);
  assert.deepEqual(unlocated.raw, { data: { count: 0 } });
});

test("a non-numeric watchlist id is rejected by the transport before the request is built", async () => {
  await assert.rejects(() => getWatchlistSymbolList("6252652/../14011590"), /watchlist id/);
  await assert.rejects(() => getWatchlistSymbolList("abc"), /watchlist id/);
  assert.equal(sent.length, 0);
});

test("two watchlists do not share a cached symbol list", async () => {
  await getWatchlistSymbolList("6252652");
  await getWatchlistSymbolList("6252652");
  assert.equal(sent.length, 1);
  await getWatchlistSymbolList("14011590");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(path), ["/watchlist/6252652/symbols", "/watchlist/14011590/symbols"]);
});

test("company search sends the keyword as the only query parameter", async () => {
  const found = await searchCompanies("bank rakyat");
  const request = only();
  assert.equal(request.method, "GET");
  assert.equal(path(request), "/watchlist/search/company");
  assert.deepEqual([...new URL(request.url).searchParams], [["keyword", "bank rakyat"]]);
  assert.equal(found.keyword, "bank rakyat");
  assert.equal(found.foundAt, "data.result");
  assert.deepEqual(found.rows, SEARCH.data.result);
});

test("an empty keyword never reaches the wire", async () => {
  await assert.rejects(() => searchCompanies("   "), /must not be empty/);
  await assert.rejects(() => searchCompanies(""), /must not be empty/);
  assert.equal(sent.length, 0);
});

test("the search cache key is the keyword that was actually sent", async () => {
  await searchCompanies("bbri");
  await searchCompanies(" bbri ");
  assert.equal(sent.length, 1, "the trimmed keyword is what was sent, so it is what is keyed on");
  await searchCompanies("BBRI");
  assert.equal(sent.length, 2, "case is preserved on the wire, so it must not be folded in the key");
});

/* ================================ the tool surface ================================ */

interface Registered {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function registerAll(): { reads: Registered[]; writes: Registered[] } {
  const reads: Registered[] = [];
  const writes: Registered[] = [];
  registerScreenerTools({
    read: (name, description, shape, handler) =>
      void reads.push({ name, description, shape: shape as Record<string, unknown>, handler }),
    write: (name, description, shape, handler) =>
      void writes.push({ name, description, shape: shape as Record<string, unknown>, handler }),
    writeNames: () => writes.map((w) => w.name),
  });
  return { reads, writes };
}

test("the family registers exactly five tools, all of them reads", () => {
  const { reads, writes } = registerAll();
  assert.deepEqual(
    reads.map((r) => r.name).sort(),
    ["screener_favorites", "screener_finitems", "screener_run", "watchlist_search", "watchlist_symbols"],
  );
  // `screener_run` is a POST registered as a read because `read`/`write` in `_define.ts` is about
  // whether account state changes, and it creates nothing. The screen-SAVING tool will be a write.
  assert.deepEqual(writes, []);
});

test("no tool exposes an argument that could reach the save flag", () => {
  const { reads } = registerAll();
  const run = reads.find((r) => r.name === "screener_run")!;
  assert.deepEqual(Object.keys(run.shape).sort(), ["limit", "rules", "watchlist_id"]);
  for (const tool of reads) {
    for (const argument of Object.keys(tool.shape)) {
      assert.equal(/save|persist|template_id/i.test(argument), false, `${tool.name}.${argument}`);
    }
  }
});

test("the run description states the two things a model would otherwise get wrong", () => {
  const { reads } = registerAll();
  const run = reads.find((r) => r.name === "screener_run")!;
  // Both are traps with no other signal: an OR silently reinterpreted returns a plausible answer,
  // and a model that believes running a screen saves it will avoid a tool that is safe to call.
  assert.match(run.description, /NO OR/);
  assert.match(run.description, /Creates NOTHING/);
});

test("calling the tool end to end posts save 0", async () => {
  const { reads } = registerAll();
  const run = reads.find((r) => r.name === "screener_run")!;
  const result = (await run.handler({
    rules: [{ metric: "1234", operator: ">", value: 10 }],
    watchlist_id: "5455717",
    limit: 1,
  })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.notEqual(result.isError, true);
  const body = only().body as Record<string, unknown>;
  assert.equal(body.save, "0");
  assert.equal(body.scopeID, "5455717");
  const payload = JSON.parse(result.content[0].text) as { success: boolean; data: { request: { save: string } } };
  assert.equal(payload.success, true);
  assert.equal(payload.data.request.save, "0");
});

test("a bad tool argument surfaces as an error result, not a request", async () => {
  const { reads } = registerAll();
  const search = reads.find((r) => r.name === "watchlist_search")!;
  const result = (await search.handler({ keyword: "  " })) as { content: Array<{ text: string }>; isError?: boolean };
  assert.equal(result.isError, true);
  assert.match(JSON.parse(result.content[0].text).kind, /invalid_param/);
  assert.equal(sent.length, 0);
});
