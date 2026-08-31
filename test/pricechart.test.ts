/**
 * `price_chart`'s summary: what it says was drawn, and whether that is true.
 *
 * The tool merges its OWN auto-detected pivot levels into the same array as the caller's
 * annotations before rendering, and used to report one `levelsDrawn` over both. A caller that
 * passed two levels was told three — issue #24 — so the one number it is asked for ("did my
 * drawings land?") was the one it could not answer, and trend, zone and marker were not counted at
 * all. These assert the two counts stay apart and that nothing is skipped in silence.
 *
 * Everything is offline: the bars come from a stubbed fetch, the SVG is written to a temp dir, and
 * `open_in_stockbit: false` keeps the user's browser out of it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const STORE = mkdtempSync(join(tmpdir(), "stockbit-pricechart-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { ROWS_PER_PAGE } from "../src/core/bars.ts";
import { registerTools } from "../src/tools/register.ts";
import { resolveToolProfile } from "../src/tools/_profile.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/** A fixed calendar so a date can be named in a test without arithmetic. Newest first on the wire. */
const DATES = ["2026-03-06", "2026-03-05", "2026-03-04", "2026-03-03", "2026-03-02"];
const ROWS = DATES.map((date, i) => ({
  date,
  open: 1000 + i,
  high: 1010 + i,
  low: 990 + i,
  close: 1005 + i,
  average: 1002 + i,
  volume: 5000 + i,
  value: 1e9 + i,
  frequency: 300 + i,
}));

/**
 * A longer fixture, shaped so the tool detects levels of its OWN: 23 sessions, two equal troughs at
 * 940 with one peak between them.
 *
 * `levelsWithAnchors` confirms nothing below `lookback * 2 + 1` = 11 bars, so on the 5-bar fixture
 * above `autoLevels` is provably 0 and every assertion about it is `=== 0` — which cannot tell
 * "counted apart from the caller's" from "not counted at all". Here the two troughs cluster into
 * one level with 2 touches and the single peak is dropped by the handler's `touches >= 2` filter,
 * so exactly one auto level is expected.
 *
 * The 80-point range on a ~1,000 price also makes a squashed price scale measurable: an invented
 * coordinate at 0 costs the candles most of the 340px price panel.
 */
const SHAPED_LOWS = [
  1000, 990, 980, 970, 960, 950, 940, 950, 960, 970, 980, 990, 980, 970, 960, 950, 940, 950, 960, 970, 980, 990, 1000,
];
/** Newest first, the way the wire orders it. Chronologically 2026-02-01 → 2026-02-23. */
const SHAPED_ROWS = SHAPED_LOWS.map((low, i) => ({
  date: `2026-02-${String(i + 1).padStart(2, "0")}`,
  open: low + 5,
  high: low + 20,
  low,
  close: low + 15,
  average: low + 10,
  volume: 5000,
  value: 1e9,
  frequency: 300,
})).reverse();

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Swapped by the empty-window test; every other test wants the fixture above. */
let rows: unknown[] = ROWS;

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text?: string; data?: string }>;
  isError?: boolean;
}>;

/** The handler AND the shape the SDK would have parsed against before calling it. */
const tools = new Map<string, { shape: z.ZodRawShape; handler: Handler }>();

before(() => {
  getStore().set("REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    if (u.includes("/login/refresh")) return json({ data: { access_token: farFutureJwt() } });
    if (u.includes("/company-price-feed/historical/summary/")) {
      const page = Number(new URL(u).searchParams.get("page") ?? "1");
      const slice = rows.slice((page - 1) * ROWS_PER_PAGE, page * ROWS_PER_PAGE);
      // `pagedBars` stops dead on a page with no `next_page`, so a fixture longer than one page has
      // to offer one — otherwise 23 sessions arrive as their newest 12 and the pivots vanish.
      const more = rows.length > page * ROWS_PER_PAGE;
      return json({ data: { result: slice, paginate: more ? { next_page: page + 1 } : {} } });
    }
    return json({ message: "unexpected" }, 404);
  }) as typeof fetch;

  const server = {
    registerTool: (name: string, config: { inputSchema: z.ZodRawShape }, cb: Handler) => {
      tools.set(name, { shape: config.inputSchema, handler: cb });
    },
  } as unknown as McpServer;
  registerTools(server, { profile: resolveToolProfile("all").profile });
});

beforeEach(() => {
  rows = ROWS;
  clearCache();
});

after(() => {
  globalThis.fetch = realFetch;
  getStore().clear();
  resetSession();
  clearCache();
  rmSync(STORE, { recursive: true, force: true });
});

interface Summary {
  autoLevels: number;
  annotationsDrawn: { level: number; zone: number; trend: number; marker: number };
  annotationsNotDrawn: Array<{ index: number; kind: string; reason: string }>;
  sessions: number;
  [key: string]: unknown;
}

/**
 * Draw a chart and return its summary block. The SVG itself goes to the temp store.
 *
 * Arguments are parsed through the tool's OWN registered zod shape before the handler sees them,
 * exactly as the MCP SDK does. That is not ceremony: the schema is where `z.coerce.number()` lives,
 * so `price: null` only becomes a number on this path. A test that called the handler with a
 * hand-built object would be testing a shape the wire can never produce, and would have missed the
 * null-reads-as-zero defect entirely.
 */
async function chart(args: Record<string, unknown>): Promise<{ summary: Summary; isError: boolean; svg: string }> {
  const entry = tools.get("price_chart");
  assert.ok(entry, "price_chart is not registered");
  const parsed = z.object(entry.shape).parse({
    symbol: "BBRI",
    open_in_stockbit: false,
    save_path: join(STORE, "chart.svg"),
    ...args,
  });
  const result = await entry.handler(parsed as Record<string, unknown>);
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  const image = result.content.find((c) => c.type === "image")?.data ?? "";
  return {
    summary: JSON.parse(text).data as Summary,
    isError: result.isError === true,
    svg: Buffer.from(image, "base64").toString("utf8"),
  };
}

/* ------------------------------- the reported bug ------------------------------- */

test("the caller's levels are counted apart from the ones this tool detected itself", async () => {
  const { summary } = await chart({
    annotations: [
      { kind: "level", price: 1001 },
      { kind: "level", price: 1009 },
    ],
  });
  assert.equal(summary.annotationsDrawn.level, 2, "exactly what the caller passed, whatever the tool added");
  // Pinned, not `>= 0`. `levelsWithAnchors` returns nothing below `2 * lookback + 1` bars and this
  // fixture has 5 against a lookback of 5, so the tool provably detects none here — which makes 0
  // the assertion that the caller's two did NOT leak into this number, the whole of issue #24.
  assert.equal(summary.autoLevels, 0, "and the tool's own pivots are reported on their own line");
  assert.deepEqual(summary.annotationsNotDrawn, []);
  assert.equal(
    (summary as Record<string, unknown>).levelsDrawn,
    undefined,
    "the merged count is gone rather than kept beside its replacement",
  );
});

test("turning the tool's own levels off does not change the caller's count", async () => {
  const on = await chart({ show_levels: true, annotations: [{ kind: "level", price: 1001 }] });
  const off = await chart({ show_levels: false, annotations: [{ kind: "level", price: 1001 }] });
  assert.equal(on.summary.annotationsDrawn.level, 1);
  assert.equal(off.summary.annotationsDrawn.level, 1);
  assert.equal(off.summary.autoLevels, 0, "and `show_levels: false` really is zero, not absent");
});

test("every kind is counted, not only levels", async () => {
  const { summary } = await chart({
    show_levels: false,
    annotations: [
      { kind: "level", price: 1001 },
      { kind: "zone", from: 995, to: 1000 },
      { kind: "trend", from_date: "2026-03-02", from_price: 1000, to_date: "2026-03-06", to_price: 1010 },
      { kind: "marker", date: "2026-03-04", label: "earnings" },
    ],
  });
  assert.deepEqual(summary.annotationsDrawn, { level: 1, zone: 1, trend: 1, marker: 1 });
  assert.deepEqual(summary.annotationsNotDrawn, []);
});

/* --------------------------- accepted but not drawn --------------------------- */

test("an annotation dated past the plotted window is reported, not counted as drawn", async () => {
  const { summary } = await chart({
    show_levels: false,
    annotations: [
      { kind: "marker", date: "2027-01-04", label: "target" },
      { kind: "trend", from_date: "2026-03-02", from_price: 1000, to_date: "2027-01-04", to_price: 1200 },
    ],
  });
  assert.deepEqual(summary.annotationsDrawn, { level: 0, zone: 0, trend: 0, marker: 0 });
  assert.equal(summary.annotationsNotDrawn.length, 2);
  assert.deepEqual(
    summary.annotationsNotDrawn.map((n) => [n.index, n.kind]),
    [
      [0, "marker"],
      [1, "trend"],
    ],
    "each one by its index in the caller's own array",
  );
  for (const n of summary.annotationsNotDrawn) assert.match(n.reason, /no session on or after 2027-01-04/);
});

test("a malformed annotation is named instead of vanishing", async () => {
  // This ladder used to fall through to nothing at all: a trend missing `to_price` drew nothing and
  // reported nothing, so the summary was silent about an annotation the caller believed had landed.
  const { summary, isError } = await chart({
    show_levels: false,
    annotations: [
      { kind: "trend", from_date: "2026-03-02", from_price: 1000, to_date: "2026-03-06" },
      { kind: "level", price: 1001 },
    ],
  });
  assert.equal(isError, false, "the rest of the chart still renders");
  assert.equal(summary.annotationsDrawn.level, 1);
  assert.equal(summary.annotationsDrawn.trend, 0);
  assert.equal(summary.annotationsNotDrawn.length, 1);
  assert.equal(summary.annotationsNotDrawn[0].index, 0);
  assert.match(summary.annotationsNotDrawn[0].reason, /to_price/);
});

test("a non-finite coordinate is refused rather than drawn as NaN", async () => {
  // `z.coerce.number()` lets 1e999 through as Infinity, and one Infinity in the price scale turns
  // every coordinate on the chart into NaN — a blank SVG that still reports success.
  const { summary, svg } = await chart({ show_levels: false, annotations: [{ kind: "level", price: 1e999 }] });
  assert.equal(summary.annotationsDrawn.level, 0);
  assert.equal(summary.annotationsNotDrawn.length, 1);
  assert.ok(!svg.includes("NaN"), "and no NaN reaches the emitted SVG");
});

test("a marker's price is a coordinate too: a non-finite one is refused, an absent one is fine", async () => {
  // `price` is OPTIONAL on a marker, so this arm cannot simply demand a number — but it is still a
  // coordinate, and the arm used to test only `date` and `label`. An Infinity therefore reached
  // `yOf` and the marker was counted as drawn while its arrow was emitted as
  // `<polygon points="521,-Infinity ...">`, in the returned image and in the file at `savedTo`.
  const { summary, svg } = await chart({
    show_levels: false,
    annotations: [
      { kind: "marker", date: "2026-03-04", label: "X", price: 1e999 },
      { kind: "marker", date: "2026-03-04", label: "ok" },
    ],
  });
  assert.equal(summary.annotationsDrawn.marker, 1, "the one with no price at all still lands");
  assert.deepEqual(
    summary.annotationsNotDrawn.map((n) => [n.index, n.kind]),
    [[0, "marker"]],
    "and the non-finite one is reported rather than drawn",
  );
  assert.match(summary.annotationsNotDrawn[0].reason, /finite `price`/);
  assert.ok(!/Infinity|NaN/.test(svg), "no non-finite coordinate reaches the emitted SVG");
  assert.ok(svg.includes(">ok<"), "the rest of the chart still renders");
});

test("an empty window counts nothing drawn, because the card it renders holds nothing", async () => {
  rows = [];
  const { summary, svg } = await chart({
    show_levels: false,
    annotations: [
      { kind: "level", price: 1001 },
      { kind: "zone", from: 995, to: 1000 },
    ],
  });
  assert.match(svg, /No price data/, "the renderer answered with the explanatory card");
  assert.deepEqual(summary.annotationsDrawn, { level: 0, zone: 0, trend: 0, marker: 0 });
  assert.equal(summary.annotationsNotDrawn.length, 2, "both are reported rather than counted as landed");
});

/* ------------------------ a coordinate the caller did not send ------------------------ */

/*
 * `z.coerce.number()` is `Number()`, and `Number(null)` is 0. So a caller sending
 * `price: null` — "I have no price for this one" — used to have the coordinate 0 invented for it,
 * indistinguishable downstream from a real zero. The two tests below pin both halves of the
 * consequence, and both compare against the SAME chart with the key simply omitted: a byte-identical
 * SVG is the assertion that no phantom coordinate reached the price scale.
 */

test("a null price on a marker means absent, and does not drag the price scale to zero", async () => {
  const withNull = await chart({
    show_levels: false,
    annotations: [{ kind: "marker", date: "2026-03-04", label: "earnings", price: null }],
  });
  const withoutKey = await chart({
    show_levels: false,
    annotations: [{ kind: "marker", date: "2026-03-04", label: "earnings" }],
  });

  assert.equal(withNull.summary.annotationsDrawn.marker, 1, "a marker needs no price, so it still lands");
  assert.deepEqual(withNull.summary.annotationsNotDrawn, []);
  assert.equal(
    withNull.svg,
    withoutKey.svg,
    "byte-identical to the same marker with no price key — a 0 folded into the scale would squash the candles",
  );
});

test("a null price on a level is refused, not drawn at zero", async () => {
  const withNull = await chart({ show_levels: false, annotations: [{ kind: "level", price: null }] });
  const withNone = await chart({ show_levels: false });

  assert.equal(withNull.summary.annotationsDrawn.level, 0, "no price, no level — it is not a level at 0");
  assert.equal(withNull.summary.annotationsNotDrawn.length, 1);
  assert.equal(withNull.summary.annotationsNotDrawn[0].index, 0);
  assert.equal(withNull.svg, withNone.svg, "and the chart is exactly the one with no annotation at all");
});

test("an EXPLICIT zero is still a coordinate and still widens the scale", async () => {
  // The other side of the same rule. Refusing a real 0 would be this server inventing policy; only
  // `null` and `""` change meaning, and this is what stops the fix above from over-reaching.
  const zero = await chart({ show_levels: false, annotations: [{ kind: "level", price: 0 }] });
  const none = await chart({ show_levels: false });

  assert.equal(zero.summary.annotationsDrawn.level, 1);
  assert.deepEqual(zero.summary.annotationsNotDrawn, []);
  assert.notEqual(zero.svg, none.svg, "a level at zero is drawn, and the axis has to reach it");
});

/* ------------------------- the tool's own levels, actually found ------------------------- */

test("the tool's own detected levels are counted in autoLevels and never in the caller's", async () => {
  // Every other assertion about `autoLevels` in this file is `=== 0`, because the 5-bar fixture is
  // below `levelsWithAnchors`'s `lookback * 2 + 1` floor and provably detects nothing. That cannot
  // tell "counted apart" from "not counted at all" — delete `autoLevels++` and those tests stay
  // green. This fixture has 23 sessions with two equal troughs, so the tool finds a level of its
  // own, and the pairing below is the whole of issue #24 in one assertion.
  rows = SHAPED_ROWS;
  const { summary } = await chart({
    show_levels: true,
    annotations: [{ kind: "level", price: 995 }],
  });

  assert.ok(summary.autoLevels > 0, `the tool detected levels of its own (got ${summary.autoLevels})`);
  assert.equal(summary.annotationsDrawn.level, 1, "and the caller's count is exactly what the caller passed");
  assert.deepEqual(summary.annotationsNotDrawn, []);

  rows = SHAPED_ROWS;
  const off = await chart({ show_levels: false, annotations: [{ kind: "level", price: 995 }] });
  assert.equal(off.summary.autoLevels, 0, "switching them off zeroes only the tool's own line");
  assert.equal(off.summary.annotationsDrawn.level, 1, "the caller's stays put");
});
