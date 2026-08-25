/**
 * Chartbit: the codec, the shape mapping, the local record, and the page scripts.
 *
 * Two layers, and the split is deliberate.
 *
 * **Offline** — always runs. The codec round-trip, the annotation-to-shape mapping, the local
 * drawing store, and the mechanical guards. This is where the mistakes actually are: which tool
 * name, how many points, epoch seconds versus milliseconds. None of it needs a browser, so none of
 * it is allowed to be skipped on a machine that has none.
 *
 * **Against a real page** — skipped when no drivable browser exists. A `node:http` fixture serves a
 * page that installs a fake `window.tvWidget` recording every call, and the REAL page scripts run
 * against it through the REAL CDP client. That proves two things nothing else can: that the scripts
 * are valid JavaScript, and that placeholder substitution reaches the page as data. Modelled on the
 * capture self-test in `src/auth/doctor.ts`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-chartbit-test-"));

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CDP } from "../src/auth/cdp.ts";
import { launchDebuggableBrowser } from "../src/auth/launch.ts";
import { findBrowser } from "../src/auth/browsers.ts";
import { removeDirWithRetry } from "../src/auth/tempdir.ts";
import { evaluateInPage, substitute } from "../src/chartbit/evaluate.ts";
import {
  CREATE_SHAPE,
  CREATE_STUDY,
  LIST_SHAPES,
  PLACEHOLDERS,
  READINESS,
  REMOVE_SHAPES,
  SAVE_CHART,
  SET_VIEW,
} from "../src/chartbit/page-scripts.ts";
import { DEFAULT_STYLE, studyRequest, toShapeRequest, toShapeRequests } from "../src/chartbit/shapes.ts";
import {
  decodeDrawings,
  decodeLayoutContent,
  encodeDrawings,
  encodeLayoutContent,
  normalizeDrawingSymbol,
} from "../src/chartbit/codec.ts";
import { addOurDrawings, forgetOurDrawings, loadOurDrawings, setOurDrawings } from "../src/chartbit/store.ts";
import { epochSeconds } from "../src/core/dates.ts";
import { StockbitError } from "../src/http/errors.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/* ======================================= the codec ======================================= */

const LAYOUT = {
  charts: [{ panes: [{ sources: [{ type: "MainSeries", id: "_seriesId" }] }], timezone: "Asia/Jakarta" }],
  layout: "s",
};

test("a layout round-trips through encode and decode", () => {
  assert.deepEqual(decodeLayoutContent(encodeLayoutContent(LAYOUT)), LAYOUT);
});

test("an empty blob decodes to null; a broken one throws", () => {
  // "You have no saved chart" and "we could not read your saved chart" are different answers, and
  // only one of them is a fact about the account.
  assert.equal(decodeLayoutContent(""), null);
  assert.equal(decodeLayoutContent(null), null);
  assert.throws(
    () => decodeLayoutContent(Buffer.from("definitely not a zip").toString("base64")),
    (err: unknown) => err instanceof StockbitError && /could not be decoded/.test(err.message),
  );
});

test("a layout that Stockbit's substitution would corrupt is refused", () => {
  // The substitution is an unanchored global replace. A layout whose own TEXT contains one of the
  // series-id literals comes back subtly rewritten and nothing reports it.
  const hostile = { charts: [{ panes: [{ sources: [{ type: "Note", state: { text: "see D4LkIE for detail" } }] }] }] };
  assert.throws(
    () => encodeLayoutContent(hostile),
    (err: unknown) => err instanceof StockbitError && /would corrupt/.test(err.message),
  );
  // And the escape hatch works, for a caller who has read why.
  assert.ok(encodeLayoutContent(hostile, { allowLossy: true }).length > 0);
});

test("a series id in an id POSITION is not treated as corruption", () => {
  // Rewriting a real generated series id is the substitution doing its job; refusing that would
  // make every genuine layout unsaveable.
  const ordinary = { charts: [{ panes: [{ sources: [{ type: "MainSeries", id: "D4LkIE" }] }] }] };
  assert.ok(encodeLayoutContent(ordinary).length > 0);
});

test("drawings decode from plain JSON and from the zip envelope alike", () => {
  // Which form the GET returns has not been confirmed on this account, and guessing wrong would
  // report a chart full of drawings as empty.
  const stored = {
    sources: [
      {
        key: "abc",
        value: {
          type: "LineToolHorzLine",
          symbol: "IDX:BBRI",
          state: { points: [{ time_t: 1_767_225_600, price: 3600 }], linecolor: "#f85149", text: "resistance" },
        },
      },
    ],
    groups: [],
  };
  for (const content of [JSON.stringify(stored), encodeDrawings({ sources: stored.sources })]) {
    const { drawings } = decodeDrawings(content);
    assert.equal(drawings.length, 1);
    assert.equal(drawings[0].type, "LineToolHorzLine");
    assert.equal(drawings[0].symbol, "BBRI", "IDX:BBRI must be normalised the way Stockbit's client does");
    assert.deepEqual(drawings[0].points, [{ time: 1_767_225_600, price: 3600 }]);
    assert.equal(drawings[0].color, "#f85149");
    assert.equal(drawings[0].text, "resistance");
  }
});

test("drawings decode accepts both `time_t` and `time` on a point", () => {
  // Serialized TradingView state uses time_t; the live API uses time. Picking one returns an empty
  // anchor for the other, which renders as a drawing with no position.
  const withTime = { sources: [{ key: "k", value: { type: "T", state: { points: [{ time: 100, price: 5 }] } } }] };
  assert.deepEqual(decodeDrawings(withTime).drawings[0].points, [{ time: 100, price: 5 }]);
});

test("an already-decoded object is accepted as-is", () => {
  const { drawings, stored } = decodeDrawings({ sources: [], groups: [] });
  assert.deepEqual(drawings, []);
  assert.deepEqual(stored.sources, []);
});

test("garbage drawings content throws rather than reading as an empty chart", () => {
  assert.throws(
    () => decodeDrawings("!!! not json and not base64 zip !!!"),
    (err: unknown) => err instanceof StockbitError && /not empty/.test(err.message),
  );
});

test("the drawings save payload carries the four fields Stockbit's own client sends", () => {
  const encoded = encodeDrawings({
    sources: [{ key: "a", value: { type: "X" } }],
    deletedSources: [{ key: "gone", symbol: "BBRI" }],
  });
  const decoded = decodeLayoutContent(encoded) as Record<string, unknown>;
  assert.deepEqual(Object.keys(decoded).sort(), ["deleted_groups", "deleted_sources", "groups", "sources"]);
  assert.deepEqual(decoded.deleted_sources, [{ key: "gone", symbol: "BBRI" }]);
});

test("normalizeDrawingSymbol strips the exchange prefix and leaves a bare ticker alone", () => {
  assert.equal(normalizeDrawingSymbol("IDX:BBRI"), "BBRI");
  assert.equal(normalizeDrawingSymbol("BBRI"), "BBRI");
});

/* ==================================== shape mapping ==================================== */

const CONTEXT = { anchorDate: "2026-08-24" };
const ANCHOR = epochSeconds("2026-08-24");

test("every point is epoch SECONDS", () => {
  // A millisecond value places the shape about fifty thousand years out, which renders as nothing
  // at all rather than as an error.
  const requests = toShapeRequests(
    [
      { kind: "level", price: 3600 },
      { kind: "trend", fromDate: "2026-01-02", fromPrice: 100, toDate: "2026-08-24", toPrice: 200 },
      { kind: "marker", date: "2026-05-05", price: 150, label: "earnings" },
    ],
    CONTEXT,
  );
  for (const request of requests) {
    for (const point of request.points) {
      assert.ok(point.time < 4_000_000_000, `${point.time} looks like milliseconds, not seconds`);
      assert.ok(Number.isInteger(point.time));
    }
  }
  assert.equal(requests[0].points[0].time, ANCHOR, "a level is anchored to the date it was given");
  assert.equal(requests[1].points[0].time, epochSeconds("2026-01-02"));
});

test("each annotation kind maps to the tool it should", () => {
  const cases: Array<[Parameters<typeof toShapeRequest>[0], string, number]> = [
    [{ kind: "level", price: 100 }, "horizontal_line", 1],
    [{ kind: "zone", from: 100, to: 120 }, "rectangle", 2],
    [{ kind: "trend", fromDate: "2026-01-02", fromPrice: 1, toDate: "2026-08-24", toPrice: 2 }, "trend_line", 2],
    [{ kind: "marker", date: "2026-08-24", price: 10, label: "x" }, "arrow_up", 1],
    [
      { kind: "channel", fromDate: "2026-01-02", fromPrice: 1, toDate: "2026-08-24", toPrice: 2, offset: -5 },
      "parallel_channel",
      3,
    ],
    [{ kind: "vline", date: "2026-08-24" }, "vertical_line", 1],
  ];
  for (const [annotation, shape, points] of cases) {
    const request = toShapeRequest(annotation, CONTEXT);
    assert.equal(request.shape, shape, `${annotation.kind} must map to ${shape}`);
    assert.equal(request.options.shape, shape, "the options must name the same tool as the request");
    assert.equal(request.points.length, points, `${shape} takes ${points} point(s)`);
  }
});

test("a marker's direction follows `above`, because the wrong arrow reads as the opposite signal", () => {
  assert.equal(toShapeRequest({ kind: "marker", date: "2026-08-24", price: 1, label: "x" }, CONTEXT).shape, "arrow_up");
  assert.equal(
    toShapeRequest({ kind: "marker", date: "2026-08-24", price: 1, label: "x", above: true }, CONTEXT).shape,
    "arrow_down",
  );
  // With no price there is nothing to point at, so it becomes a text label.
  assert.equal(toShapeRequest({ kind: "marker", date: "2026-08-24", label: "x" }, CONTEXT).shape, "text");
});

test("a channel's third point is the parallel, offset from the second", () => {
  const request = toShapeRequest(
    { kind: "channel", fromDate: "2026-01-02", fromPrice: 100, toDate: "2026-08-24", toPrice: 80, offset: -20 },
    CONTEXT,
  );
  assert.equal(request.points[1].price, 80);
  assert.equal(request.points[2].price, 60);
  assert.equal(request.points[2].time, request.points[1].time, "the parallel is anchored at the same time");
});

test("colours come from the shared style, and a caller can override them", () => {
  assert.equal(toShapeRequest({ kind: "level", price: 1 }, CONTEXT).options.overrides.linecolor, DEFAULT_STYLE.neutral);
  assert.equal(
    toShapeRequest({ kind: "level", price: 1, color: "#123456" }, CONTEXT).options.overrides.linecolor,
    "#123456",
  );
  assert.equal(
    toShapeRequest({ kind: "level", price: 1 }, { ...CONTEXT, style: { neutral: "#abcdef" } }).options.overrides
      .linecolor,
    "#abcdef",
  );
});

test("an unmapped annotation kind throws rather than being skipped", () => {
  // A caller that asked for six drawings and silently got five would report six.
  assert.throws(
    () => toShapeRequest({ kind: "fibonacci" } as never, CONTEXT),
    (err: unknown) => err instanceof StockbitError && /not drawn/.test(err.message),
  );
});

test("an invalid date is refused before anything is drawn", () => {
  assert.throws(() => toShapeRequest({ kind: "vline", date: "24-08-2026" }, CONTEXT), /YYYY-MM-DD/);
  assert.throws(() => toShapeRequest({ kind: "vline", date: "2026-02-30" }, CONTEXT), /not a real calendar date/);
});

test("only whitelisted studies can be added", () => {
  // `createStudy` with an unknown name is a silent no-op in the charting library, so a caller
  // asking for a misspelt indicator would be told it worked.
  assert.equal(studyRequest("rsi").name, "Relative Strength Index");
  assert.throws(() => studyRequest("Bolinger Bands"), /Unknown study/);
  assert.throws(() => studyRequest("rsi; evil()"), /Unknown study/);
});

/* ================================== the local record ================================== */

test("our drawings are recorded, merged and forgotten by id", () => {
  setOurDrawings("BBRI", []);
  addOurDrawings("BBRI", [{ tvEntityId: "e1", kind: "level", shape: "horizontal_line", at: "now" }]);
  addOurDrawings("BBRI", [{ tvEntityId: "e2", kind: "trend", shape: "trend_line", at: "now" }]);
  assert.deepEqual(loadOurDrawings("BBRI").map((d) => d.tvEntityId), ["e1", "e2"]);

  // Adding the same id twice must not duplicate it: `clear ours` would then try to remove it twice
  // and report a phantom missing entity.
  addOurDrawings("BBRI", [{ tvEntityId: "e1", kind: "level", shape: "horizontal_line", at: "now" }]);
  assert.equal(loadOurDrawings("BBRI").length, 2);

  forgetOurDrawings("BBRI", ["e1"]);
  assert.deepEqual(loadOurDrawings("BBRI").map((d) => d.tvEntityId), ["e2"]);
});

test("one symbol's record does not touch another's", () => {
  setOurDrawings("BBRI", [{ tvEntityId: "b1", kind: "level", shape: "horizontal_line", at: "now" }]);
  setOurDrawings("TLKM", [{ tvEntityId: "t1", kind: "level", shape: "horizontal_line", at: "now" }]);
  assert.deepEqual(loadOurDrawings("BBRI").map((d) => d.tvEntityId), ["b1"]);
  assert.deepEqual(loadOurDrawings("TLKM").map((d) => d.tvEntityId), ["t1"]);
});

test("a symbol with no record reads as empty rather than throwing", () => {
  assert.deepEqual(loadOurDrawings("ANTM"), []);
});

/* ================================ substitution safety ================================ */

test("substitution puts values INSIDE a JSON literal, never outside one", () => {
  // This is the property that makes the page scripts safe: a label cannot become code in a page
  // holding the user's live Stockbit session.
  const hostile = '"; window.stolen = document.cookie; //';
  const out = substitute("var x = SHAPE_REQUEST;", { SHAPE_REQUEST: { text: hostile } });
  assert.equal(out, `var x = ${JSON.stringify({ text: hostile })};`);
  assert.ok(out.includes("\\\""), "the quotes in the payload must be escaped, not closed");
  assert.equal(out.includes("window.stolen = document.cookie;\n"), false);
  // And it is valid JavaScript that assigns an object, rather than running anything.
  const value = new Function(`${out} return x;`)() as { text: string };
  assert.equal(value.text, hostile);
});

test("substitution is anchored on word boundaries", () => {
  // An unbounded replace would also rewrite a longer identifier containing the placeholder.
  const out = substitute("var a = SHAPE_IDS; var b = SHAPE_IDS_EXTRA;", { SHAPE_IDS: [1, 2] });
  assert.ok(out.includes("var a = [1,2];"));
  assert.ok(out.includes("SHAPE_IDS_EXTRA"), "a longer identifier must be left alone");
});

test("an undefined substitution becomes null, not the literal `undefined`", () => {
  // `undefined` is not valid JSON and would be a bare identifier in the page — a ReferenceError at
  // best and a shadowed variable at worst.
  assert.equal(substitute("var x = VIEW_REQUEST;", { VIEW_REQUEST: undefined }), "var x = null;");
});

/* ================================= mechanical guards ================================= */

function chartbitFiles(): string[] {
  const dir = join(SRC, "chartbit");
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((full) => statSync(full).isFile() && full.endsWith(".ts"));
}

test("the page scripts contain no template interpolation", () => {
  // Arguments reach the page only as JSON. An interpolation anywhere in that file would be a path
  // by which caller text becomes executable code in a page holding the user's session.
  const source = readFileSync(join(SRC, "chartbit", "page-scripts.ts"), "utf8");
  assert.equal(source.includes("${"), false, "page-scripts.ts must have no interpolation, in code or in prose");
});

/**
 * Strip comments, so a guard about CODE is not tripped by prose explaining the rule.
 *
 * The alternative — wording every comment to avoid the strings it forbids — makes the rule harder
 * to explain in the one place a reader will look for it, and leaves the guard passing for the wrong
 * reason.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN_DOMAINS = ["Network.enable", "Fetch.enable", "Network.getResponseBody", "Fetch.getResponseBody"];

test("the driver never enables the Network or Fetch CDP domains", () => {
  // Those are what the login capture uses to read response bodies. A drawing driver that could see
  // traffic could see the session token, and ADR-0005 already had to argue for a write path the
  // transport's route table cannot inspect.
  const offenders: string[] = [];
  for (const file of chartbitFiles()) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const domain of FORBIDDEN_DOMAINS) {
      if (code.includes(domain)) offenders.push(`${file.slice(SRC.length + 1)}: ${domain}`);
    }
  }
  assert.deepEqual(offenders, [], "the Chartbit driver must not be able to observe network traffic");
});

test("the guard would catch a driver that started watching traffic (negative control)", () => {
  // Proves the guard is not vacuous, and that stripping comments did not strip the code with them.
  const bypass = 'const x = 1;\nawait cdp.send("Network.enable", {}, sessionId);';
  assert.ok(FORBIDDEN_DOMAINS.some((d) => stripComments(bypass).includes(d)));
  const inProse = '/** Never call Network.enable here. */\nconst y = 2;';
  assert.equal(FORBIDDEN_DOMAINS.some((d) => stripComments(inProse).includes(d)), false);
  const inLineComment = '// not Fetch.enable either\nconst z = 3;';
  assert.equal(FORBIDDEN_DOMAINS.some((d) => stripComments(inLineComment).includes(d)), false);
});

/* ============================ the page scripts, for real ============================ */

/**
 * A page that installs a fake `window.tvWidget` recording every call.
 *
 * Keyed by widget key, exactly as Stockbit's own page is — reaching for `window.tvWidget.activeChart()`
 * on the real page returns undefined, and a fixture that did not reproduce that would let the bug
 * through.
 */
const FIXTURE_PAGE = `<!doctype html>
<html><body><div id="chart">chart</div><script>
window.__calls = [];
var record = function (name, args) { window.__calls.push({ name: name, args: args }); };
var shapes = [];
var chart = {
  symbol: function () { return "IDX:BBRI"; },
  resolution: function () { return "1D"; },
  createShape: function (point, options) { record("createShape", [point, options]); shapes.push({ id: "s" + shapes.length, name: options.shape }); return "s" + (shapes.length - 1); },
  createMultipointShape: function (points, options) { record("createMultipointShape", [points, options]); shapes.push({ id: "m" + shapes.length, name: options.shape }); return "m" + (shapes.length - 1); },
  getAllShapes: function () { return shapes.slice(); },
  getShapeById: function (id) { return { getProperties: function () { return { linecolor: "#f85149" }; }, getPoints: function () { return [{ time: 1, price: 2 }]; } }; },
  removeEntity: function (id) { record("removeEntity", [id]); var before = shapes.length; shapes = shapes.filter(function (s) { return s.id !== id; }); if (shapes.length === before) throw new Error("no such entity"); },
  removeAllShapes: function () { record("removeAllShapes", []); shapes = []; },
  setResolution: function (r) { record("setResolution", [r]); },
  setChartType: function (t) { record("setChartType", [t]); },
  setSymbol: function (s) { record("setSymbol", [s]); },
  createStudy: function (name, a, b, inputs) { record("createStudy", [name, inputs]); return "study-1"; }
};
window.tvWidget = { chartbit: {
  activeChart: function () { return chart; },
  saveChartToServer: function (ok) { record("saveChartToServer", []); setTimeout(ok, 5); }
} };
</script></body></html>`;

/**
 * Drive the fixture with the real CDP client and the real page scripts.
 *
 * Skipped when no Chromium-family browser exists. Everything above runs regardless — that split is
 * why this being skipped on a bare CI box is acceptable rather than a hole.
 */
const browser = findBrowser();

test("the page scripts run against a real chart widget", { skip: browser ? false : "no drivable browser" }, async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(FIXTURE_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const profile = mkdtempSync(join(tmpdir(), "stockbit-chartbit-profile-"));

  const launched = await launchDebuggableBrowser({ bin: browser!, profileDir: profile, headless: true });
  const cdp = await CDP.connect(launched.wsUrl);

  try {
    const target = (await cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` })) as {
      targetId: string;
    };
    const attached = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as {
      sessionId: string;
    };
    const sid = attached.sessionId;
    await cdp.send("Page.enable", {}, sid, 5_000).catch(() => {});
    await cdp.send("Runtime.enable", {}, sid, 5_000).catch(() => {});

    // Wait for the fixture's script to install the widget.
    let readiness: { hasChart?: boolean; widgetKey?: string | null } = {};
    for (let i = 0; i < 40 && !readiness.hasChart; i++) {
      readiness = await evaluateInPage(cdp, sid, READINESS);
      if (!readiness.hasChart) await delay(100);
    }
    assert.equal(readiness.hasChart, true, "the fixture must expose a chart");
    assert.equal(readiness.widgetKey, "chartbit", "window.tvWidget is keyed, and the scripts must resolve the key");

    // A one-point tool goes through createShape; a two-point one through createMultipointShape.
    const level = toShapeRequest({ kind: "level", price: 3600, label: "resistance" }, CONTEXT);
    const created = await evaluateInPage<{ ready: boolean; id: string | null }>(cdp, sid, CREATE_SHAPE, {
      substitutions: { [PLACEHOLDERS.shapeRequest]: { points: level.points, options: level.options } },
    });
    assert.equal(created.ready, true);
    assert.ok(created.id, "the widget must return an entity id");

    const trend = toShapeRequest(
      { kind: "trend", fromDate: "2026-01-02", fromPrice: 1, toDate: "2026-08-24", toPrice: 2 },
      CONTEXT,
    );
    await evaluateInPage(cdp, sid, CREATE_SHAPE, {
      substitutions: { [PLACEHOLDERS.shapeRequest]: { points: trend.points, options: trend.options } },
    });

    const calls = await evaluateInPage<Array<{ name: string; args: unknown[] }>>(
      cdp,
      sid,
      "(function () { return window.__calls; })()",
    );
    const names = calls.map((c) => c.name);
    assert.deepEqual(names, ["createShape", "createMultipointShape"], "point count must select the API");

    // The overrides and the epoch reached the page as data.
    const single = calls[0].args as [{ time: number; price: number }, { shape: string; overrides: Record<string, unknown>; text?: string }];
    assert.equal(single[0].time, ANCHOR);
    assert.equal(single[0].price, 3600);
    assert.equal(single[1].shape, "horizontal_line");
    assert.equal(single[1].overrides.linecolor, DEFAULT_STYLE.neutral);
    assert.equal(single[1].text, "resistance");

    // Listing reads properties back through getShapeById.
    const listed = await evaluateInPage<{ ready: boolean; shapes: Array<{ id: string; properties?: unknown }> }>(
      cdp,
      sid,
      LIST_SHAPES,
    );
    assert.equal(listed.shapes.length, 2);
    assert.deepEqual(listed.shapes[0].properties, { linecolor: "#f85149" });

    // Removing a known id succeeds; an unknown one is reported as missing rather than throwing —
    // the user deleting our line by hand must not fail the operation that cleans up after it.
    const removed = await evaluateInPage<{ ready: boolean; removed: number; missing: string[] }>(
      cdp,
      sid,
      REMOVE_SHAPES,
      { substitutions: { [PLACEHOLDERS.shapeIds]: [String(created.id), "never-existed"] } },
    );
    assert.equal(removed.removed, 1);
    assert.deepEqual(removed.missing, ["never-existed"]);

    const view = await evaluateInPage<{ ready: boolean; symbol: string; resolution: string }>(cdp, sid, SET_VIEW, {
      substitutions: { [PLACEHOLDERS.viewRequest]: { resolution: "1W", chartType: 1, symbol: null } },
    });
    assert.equal(view.ready, true);
    assert.equal(view.resolution, "1D", "the fixture reports its own resolution; the call is what matters");

    const study = await evaluateInPage<{ ready: boolean; id: string }>(cdp, sid, CREATE_STUDY, {
      substitutions: { [PLACEHOLDERS.studyRequest]: studyRequest("rsi") },
    });
    assert.equal(study.id, "study-1");

    // The save adapter resolves asynchronously, which is why `awaitPromise` is on.
    const saved = await evaluateInPage<{ ready: boolean; saved: boolean }>(cdp, sid, SAVE_CHART);
    assert.equal(saved.saved, true);

    // A page-side throw becomes a typed error naming the page, not a raw CDP blob.
    await assert.rejects(
      () => evaluateInPage(cdp, sid, '(function () { throw new Error("boom"); })()'),
      (err: unknown) => err instanceof StockbitError && /Chart page threw/.test(err.message),
    );
  } finally {
    cdp.close();
    launched.child.kill();
    server.close();
    await removeDirWithRetry(profile);
  }
});

test(
  "a page with no widget reports why rather than timing out silently",
  { skip: browser ? false : "no drivable browser" },
  async () => {
    // The readiness script distinguishes logged-out, blank and not-yet-loaded, because a signed-out
    // Stockbit chart is an EMPTY WHITE BODY and looks identical to a slow load from a screenshot.
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body></body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const profile = mkdtempSync(join(tmpdir(), "stockbit-chartbit-blank-"));
    const launched = await launchDebuggableBrowser({ bin: browser!, profileDir: profile, headless: true });
    const cdp = await CDP.connect(launched.wsUrl);
    try {
      const target = (await cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` })) as {
        targetId: string;
      };
      const attached = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as {
        sessionId: string;
      };
      await cdp.send("Runtime.enable", {}, attached.sessionId, 5_000).catch(() => {});
      const readiness = await evaluateInPage<{ blank: boolean; hasChart: boolean; loggedOut: boolean }>(
        cdp,
        attached.sessionId,
        READINESS,
      );
      assert.equal(readiness.hasChart, false);
      assert.equal(readiness.blank, true, "an empty body must be reported as blank, not as still loading");
      assert.equal(readiness.loggedOut, false, "this page is blank but not at a login URL");
    } finally {
      cdp.close();
      launched.child.kill();
      server.close();
      await removeDirWithRetry(profile);
    }
  },
);

test(
  "a widget whose activeChart() throws reads as not-ready, it does not propagate the throw",
  { skip: browser ? false : "no drivable browser" },
  async () => {
    // The boot state that broke every cold chartbit call: for roughly the first second the widget
    // answers `typeof activeChart === "function"` while CALLING it still throws from inside
    // TradingView's own bundle. The readiness probe has to read that as "not ready yet". If the
    // throw escapes, `waitForChart` dies on its first poll and never uses its 45s budget at all.
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        "<!doctype html><html><body>chart shell<" +
          "script>window.tvWidget={web:{activeChart:function(){" +
          "throw new TypeError(\"Cannot read properties of undefined (reading 'activeChart')\");}}};<" +
          "/script></body></html>",
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const profile = mkdtempSync(join(tmpdir(), "stockbit-chartbit-throw-"));
    const launched = await launchDebuggableBrowser({ bin: browser!, profileDir: profile, headless: true });
    const cdp = await CDP.connect(launched.wsUrl);
    try {
      const target = (await cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` })) as {
        targetId: string;
      };
      const attached = (await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true })) as {
        sessionId: string;
      };
      await cdp.send("Runtime.enable", {}, attached.sessionId, 5_000).catch(() => {});

      const readiness = await evaluateInPage<{
        blank: boolean;
        hasChart: boolean;
        hasBars: boolean;
        loggedOut: boolean;
        symbol: string | null;
      }>(cdp, attached.sessionId, READINESS);

      assert.equal(readiness.hasChart, false, "a throwing activeChart() is not a chart");
      assert.equal(readiness.hasBars, false);
      assert.equal(readiness.symbol, null);
      assert.equal(readiness.blank, false, "the body has text; this is a boot state, not a signed-out page");
    } finally {
      cdp.close();
      launched.child.kill();
      server.close();
      await removeDirWithRetry(profile);
    }
  },
);

after(() => {
  // Nothing persistent to clean beyond the temp store dir, which the OS sweeps.
});
