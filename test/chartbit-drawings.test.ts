/**
 * `chartbit_drawings` — the endpoint that answered 400 to everything.
 *
 * A 2026-08-31 field report called it three ways (no arguments, `{symbol}`, and `{symbol,
 * layout_id}` with a layout id that `chartbit_layouts` had just returned on the same credential)
 * and got `400 "Silahkan Periksa permintaan"` every time. Nothing this server returned carried a
 * chart id, so there was no fourth thing to try.
 *
 * The id was in fact inside a payload the server already reads: a decoded layout carries
 * `charts: [{ …, "chartId": "1" }]`, recorded in `docs/research/chartbit-layout-format.md`. These
 * tests pin the derivation and the two refusals, which is everything about this fix that can be
 * settled without a live call. Whether `layout_id` + `chart_id` is the pair the endpoint wants is
 * NOT settled here and cannot be — that needs a capture.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-drawings-"));

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { chartIdFromLayout, getChartDrawings } from "../src/chartbit/api.ts";
import { encodeDrawings, encodeLayoutContent } from "../src/chartbit/codec.ts";
import { StockbitError } from "../src/http/errors.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/**
 * A layout with one chart, in the shape `docs/research/chartbit-layout-format.md` records.
 *
 * That shape is real but INCOMPLETE — see REAL_NESTING below. Both are kept, because the walker
 * has to read a layout of either depth and this is the cheaper of the two to read.
 */
const ONE_CHART = {
  layout: "s",
  charts: [
    {
      panes: [{ sources: [{ type: "MainSeries", id: "_seriesId" }] }],
      timezone: "Asia/Jakarta",
      chartId: "7",
    },
  ],
};

/**
 * What a layout stored on a real account actually looks like, read live on 2026-09-01.
 *
 * THREE objects deep, not one. The documented shape is the innermost of them, so a reader written
 * against the doc finds no `charts` key on any real layout and derives nothing — which is exactly
 * what the first version of this fix did, and it looked correct until it met a real account.
 */
const REAL_NESTING = {
  id: "53e5877c-64f5-471b-82a9-e572db648ad1-3355424",
  name: "Bandarmology",
  resolution: "1D",
  symbol: "IHSG",
  content: {
    id: "53e5877c-64f5-471b-82a9-e572db648ad1-3355424",
    name: "Bandarmology",
    symbol: "IHSG",
    // A JSON STRING, not an object. It maps chart id -> the symbol that chart shows.
    charts_symbols: '{"1":{"symbol":"IHSG"}}',
    content: { name: "Bandarmology", layout: "s", charts: [{ chartId: "1", timezone: "Asia/Jakarta" }] },
  },
};

/** Two charts on different symbols, so only the symbol map can say which one is meant. */
const TWO_CHARTS = {
  content: {
    charts_symbols: '{"1":{"symbol":"IHSG"},"2":{"symbol":"BBRI"}}',
    content: { charts: [{ chartId: "1" }, { chartId: "2" }] },
  },
};

const realFetch = globalThis.fetch;
let seenUrls: string[] = [];
/** Set by a test that needs a layout other than the one-chart default. */
let layoutContent: string | null = null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function lastUrl(fragment: string): URL {
  const found = [...seenUrls].reverse().find((u) => u.includes(fragment));
  assert.ok(found, `no request was made to ${fragment}`);
  return new URL(found);
}

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });
    if (u.includes("/chartbit/chart-drawings")) {
      return json({ data: { content: encodeDrawings({ sources: [], groups: [] }) } });
    }
    if (u.includes("/chartbit/charts/")) {
      return json({ data: { content: layoutContent ?? encodeLayoutContent(ONE_CHART) } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  seenUrls = [];
  layoutContent = null;
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------- the derivation itself ------------------------------- */

test("the chart id comes out of a decoded layout", () => {
  assert.equal(chartIdFromLayout(ONE_CHART), "7");
  // TradingView writes it as a string, but a number is the same id and refusing it would fail a
  // read over a JSON type rather than over anything that matters.
  assert.equal(chartIdFromLayout({ charts: [{ chartId: 1 }] }), "1");
});

test("the chart id is found at the depth a REAL layout keeps it, not just the documented one", () => {
  // The regression that matters. A reader that only looks at the top level returns undefined for
  // every layout on every real account, and its unit tests all pass, because the fixture was
  // copied from a doc that recorded the innermost object.
  assert.equal(chartIdFromLayout(REAL_NESTING), "1");
  assert.equal(chartIdFromLayout(REAL_NESTING, "IHSG"), "1", "the symbol it actually shows");
});

test("ONE chart is not automatically the caller's chart", () => {
  // REAL_NESTING is the account's real Bandarmology layout: a single chart showing IHSG. Deriving
  // its id for a caller who asked about BBRI would answer with IHSG's hand-drawn levels under
  // `symbol: "BBRI"` — the same confusion the multi-chart branch refuses to create, reached by the
  // easy path instead.
  assert.equal(chartIdFromLayout(REAL_NESTING, "BBRI"), undefined);
});

test("a single-chart layout that names no symbol is still derivable", () => {
  // The older flat shape carries no `charts_symbols`. Refusing a layout that never claimed a
  // symbol would help nobody, so the mismatch check only fires when the layout actually says.
  assert.equal(chartIdFromLayout(ONE_CHART, "BBRI"), "7");
});

test("the symbol map is matched case-insensitively and past the exchange prefix", () => {
  const lower = { content: { charts_symbols: '{"1":{"symbol":"idx:bbri"}}', content: { charts: [{ chartId: "1" }] } } };
  assert.equal(chartIdFromLayout(lower, "BBRI"), "1");
});

test("a multi-chart layout is resolved by the layout's own symbol map", () => {
  // Each chart has its own drawing store, so this is not cosmetic: the wrong id answers with a
  // different chart's lines and looks entirely successful doing it.
  assert.equal(chartIdFromLayout(TWO_CHARTS, "BBRI"), "2");
  assert.equal(chartIdFromLayout(TWO_CHARTS, "IHSG"), "1");
  // No symbol to go on, or a symbol the map does not name: nothing, rather than the first chart.
  assert.equal(chartIdFromLayout(TWO_CHARTS), undefined);
  assert.equal(chartIdFromLayout(TWO_CHARTS, "TLKM"), undefined);
});

test("a layout that names no chart derives nothing, rather than picking one", () => {
  assert.equal(chartIdFromLayout({ charts: [] }), undefined);
  assert.equal(chartIdFromLayout({ charts: [{}] }), undefined);
  assert.equal(chartIdFromLayout(null), undefined);
  assert.equal(chartIdFromLayout({}), undefined);
  // A `content` chain that never reaches a charts array must terminate, not spin.
  assert.equal(chartIdFromLayout({ content: { content: { content: {} } } }), undefined);
});

/* --------------------------------- what goes on the wire --------------------------------- */

test("a layout id is enough: the chart id is read out of the layout and sent", async () => {
  const result = await getChartDrawings({ layoutId: "8801", symbol: "bbri" });

  // Two requests, in order: the layout, then the drawings addressed by what it carried.
  assert.equal(lastUrl("/chartbit/charts/").pathname, "/chartbit/charts/8801");
  const url = lastUrl("/chartbit/chart-drawings");
  assert.equal(url.searchParams.get("chart_id"), "7", "the id from the layout, not the layout id");
  assert.equal(url.searchParams.get("layout_id"), "8801");
  assert.equal(url.searchParams.get("symbol"), "BBRI");

  assert.equal(result.chartId, "7");
  // The caller has to be able to tell a derived id from one they gave, or they cannot judge the
  // answer when the endpoint still refuses it.
  assert.equal(result.chartIdDerived, true);
});

test("an explicit chart id is used as given and costs no extra request", async () => {
  const result = await getChartDrawings({ layoutId: "8801", chartId: "3" });
  assert.equal(lastUrl("/chartbit/chart-drawings").searchParams.get("chart_id"), "3");
  assert.ok(!seenUrls.some((u) => u.includes("/chartbit/charts/")), "the layout was not read");
  assert.equal(result.chartIdDerived, false);
});

/* ------------------------------------ the refusals ------------------------------------ */

test("a call with nothing to derive from is refused, not sent to be 400ed", async () => {
  await assert.rejects(
    () => getChartDrawings(),
    (error: unknown) => {
      assert.ok(error instanceof StockbitError);
      assert.equal(error.kind, "invalid_param");
      // The message must name the way OUT. "Needs a chart id" alone is where the reporter was
      // already stuck: no tool on this server yields one.
      assert.match(error.message, /layout_id/);
      assert.match(error.message, /chartbit_layouts/);
      return true;
    },
  );
  // `{symbol}` alone was one of the three combinations measured to 400. It derives nothing either.
  await assert.rejects(() => getChartDrawings({ symbol: "BBRI" }), StockbitError);
  assert.equal(seenUrls.filter((u) => u.includes("/chartbit/")).length, 0, "nothing reached the host");
});

test("a multi-chart layout asks for chart_id instead of guessing which chart", async () => {
  // Two charts and a symbol the map does not name — the case where choosing would be a guess.
  layoutContent = encodeLayoutContent(TWO_CHARTS);
  await assert.rejects(
    () => getChartDrawings({ layoutId: "8802", symbol: "TLKM" }),
    (error: unknown) => {
      assert.ok(error instanceof StockbitError);
      assert.match(error.message, /chart_id/);
      assert.match(error.message, /8802/);
      // The symbol it could not place belongs in the message; without it the caller cannot tell
      // this apart from the layout being unreadable.
      assert.match(error.message, /TLKM/);
      return true;
    },
  );
  assert.ok(!seenUrls.some((u) => u.includes("chart-drawings")), "no request built on a guessed id");
});

test("a symbol the map DOES name resolves, and the request carries that chart's id", async () => {
  layoutContent = encodeLayoutContent(TWO_CHARTS);
  const result = await getChartDrawings({ layoutId: "8802", symbol: "BBRI" });
  assert.equal(result.chartId, "2", "chart 2 is the one showing BBRI");
  assert.equal(lastUrl("/chartbit/chart-drawings").searchParams.get("chart_id"), "2");
});

test("an empty layout is a refusal, not a chart with no drawings", async () => {
  // The difference matters: "this layout stores nothing under any chart id I can name" and "this
  // chart has no drawings on it" are different answers, and the second one would be an invention.
  layoutContent = "";
  await assert.rejects(() => getChartDrawings({ layoutId: "8803" }), StockbitError);
});
