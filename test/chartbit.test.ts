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
import {
  DEFAULT_STYLE,
  normalizeAnnotationKeys,
  studyRequest,
  toShapeRequest,
  toShapeRequests,
} from "../src/chartbit/shapes.ts";
import {
  decodeDrawings,
  decodeLayoutContent,
  encodeDrawings,
  encodeLayoutContent,
  normalizeDrawingSymbol,
} from "../src/chartbit/codec.ts";
import { addOurDrawings, forgetOurDrawings, loadOurDrawings, setOurDrawings } from "../src/chartbit/store.ts";
import {
  DRIVER_LOCK_WAIT_MS,
  driverLockState,
  resetDriverLock,
  withDriverLock,
} from "../src/chartbit/lock.ts";
import { reconcileOurDrawings } from "../src/chartbit/reconcile.ts";
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

/* ====================== the ledger tells the truth about the chart (#14) ====================== */

/**
 * `ours` used to be the local record returned verbatim, as though it described the chart.
 *
 * In the field that produced a result listing fourteen entities for a chart holding nine: five
 * annotations were lost when the page reloaded, and the next draw went on reporting them. The
 * entity ids were observed at creation; the present-tense claim "these are on the chart now" never
 * was.
 */
const LEDGER = [
  { tvEntityId: "e1", kind: "level", shape: "horizontal_line", at: "2026-08-24T00:00:00.000Z" },
  { tvEntityId: "e2", kind: "trend", shape: "trend_line", at: "2026-08-24T00:00:00.000Z" },
  { tvEntityId: "e3", kind: "zone", shape: "rectangle", at: "2026-08-24T00:00:00.000Z" },
];

test("a recorded drawing the chart no longer holds is reported gone, not listed as present", () => {
  const r = reconcileOurDrawings(LEDGER, ["e1", "e3"]);
  assert.equal(r.reconciled, true);
  assert.equal(r.onChart, 2);
  assert.deepEqual(
    r.ours.map((d) => [d.tvEntityId, d.presence]),
    [
      ["e1", "on-chart"],
      ["e2", "gone"],
      ["e3", "on-chart"],
    ],
  );
  assert.deepEqual(r.gone.map((d) => d.tvEntityId), ["e2"]);
});

test("reconciling never shortens the ledger", () => {
  // The record is the only thing separating this server's drawings from the user's own hand-drawn
  // analysis. Prune on one bad reading and an orphan can only be removed with `clear scope:"all"` —
  // the operation that needs confirmation precisely because it destroys work we have never seen.
  const r = reconcileOurDrawings(LEDGER, []);
  assert.equal(r.ours.length, LEDGER.length, "every recorded entry survives the check");
  assert.equal(r.gone.length, 3);
  assert.equal(r.onChart, 0);
});

test("an unreadable chart is UNCONFIRMED, which is not the same as an empty one", () => {
  // The distinction the whole design turns on. `[]` says the chart holds nothing, which would mark
  // every drawing gone; `null` says we did not look, and inventing "gone" from that would report a
  // loss that never happened.
  const unread = reconcileOurDrawings(LEDGER, null, "the page would not answer");
  assert.equal(unread.reconciled, false);
  // ABSENT, not zero. Zero here is a measurement — "the chart holds none of them" — and it is the
  // most alarming thing this type can say; reporting it for a chart nobody looked at is the
  // "never invent a number" rule broken on the one field that matters most.
  assert.equal(unread.onChart, undefined);
  assert.equal("onChart" in unread, false, "the key itself must be absent, not set to undefined");
  assert.deepEqual(unread.gone, [], "nothing may be called gone on a reading that was never taken");
  assert.ok(unread.ours.every((d) => d.presence === "unconfirmed"));
  assert.equal(unread.note, "the page would not answer");

  const empty = reconcileOurDrawings(LEDGER, []);
  assert.equal(empty.reconciled, true);
  assert.equal(empty.gone.length, 3);
  assert.equal(empty.note, undefined);
});

test("LIST_SHAPES reports a widget it cannot ask as NOT-READY, never as an empty chart", () => {
  // The bug this closes: the script opened `chart.getAllShapes ? chart.getAllShapes() : []`, so a
  // widget without that API answered `{ready: true, shapes: []}` — indistinguishable from a chart
  // holding nothing. Once drawAnnotations began reconciling against this list, that turned "the
  // widget cannot be asked" into the positive claim "every drawing you just made is gone".
  //
  // Asserted on the SOURCE because the failing state needs a widget missing one method, which the
  // fixture deliberately provides. The prologue's other four guards all report a reason; this was
  // the only one that answered with a fabricated reading.
  assert.match(LIST_SHAPES, /typeof chart\.getAllShapes !== "function"/);
  assert.match(LIST_SHAPES, /ready: false, reason: "no-getAllShapes"/);
  assert.doesNotMatch(
    LIST_SHAPES,
    /chart\.getAllShapes \? chart\.getAllShapes\(\) : \[\]/,
    "a missing API must not fall back to an empty list",
  );
});

test("ids are compared as strings, since the widget's are not guaranteed to be", () => {
  const numeric = [{ tvEntityId: "7", kind: "level", shape: "horizontal_line", at: "x" }];
  assert.equal(reconcileOurDrawings(numeric, [7 as unknown as string]).onChart, 1);
});

test("an empty ledger reconciles cleanly rather than erroring", () => {
  const r = reconcileOurDrawings([], ["e9"]);
  assert.deepEqual(r.ours, []);
  assert.deepEqual(r.gone, []);
  assert.equal(r.onChart, 0);
  assert.equal(r.reconciled, true);
});

/* ============================== the driver mutex (#15) ============================== */

/** Every .ts under a directory, recursively. */
function allSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return allSourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Chart tools share ONE browser window, and nothing serialised them.
 *
 * The MCP SDK dispatches without awaiting, so two tool calls arriving together genuinely interleave
 * in one process. Issuing `chartbit_save` and `chartbit_screenshot` at the same moment did exactly
 * that in the field: the page reloaded and five unsaved drawings were lost.
 *
 * These exercise the primitive directly. The driver cannot be exercised without a browser, so what
 * connects the two is the source scan at the bottom — the property that makes ONE lock enough.
 */
test("the second caller waits for the first, and does not run beside it", async () => {
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const firstInside = new Promise<void>((r) => (releaseFirst = r));

  const a = withDriverLock("A", async () => {
    order.push("a:start");
    await firstInside;
    order.push("a:end");
  });
  // Queued while A is inside. If nothing serialised, "b:start" would land between A's two lines.
  const b = withDriverLock("B", async () => {
    order.push("b:start");
    order.push("b:end");
  });

  await delay(20);
  assert.deepEqual(order, ["a:start"], "B must not have started while A holds the window");
  releaseFirst();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("the lock is released when the work THROWS, not only when it succeeds", async () => {
  // A failed chart call that kept the lock would take the feature down until the process restarted.
  await assert.rejects(() => withDriverLock("boom", async () => { throw new Error("nope"); }), /nope/);
  assert.equal(driverLockState().busy, false);
  let ran = false;
  await withDriverLock("after", async () => { ran = true; });
  assert.ok(ran, "the next caller must be able to take the window");
});

test("waiters are served first-in-first-out", async () => {
  const served: string[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const first = withDriverLock("holder", () => held);
  const queued = ["one", "two", "three"].map((name) =>
    withDriverLock(name, async () => {
      served.push(name);
    }),
  );
  await delay(20);
  release();
  await Promise.all([first, ...queued]);
  assert.deepEqual(served, ["one", "two", "three"], "starvation is not a fair queue");
});

test("a caller that waits too long is told why, and nothing was changed", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const holder = withDriverLock("drawing on BBRI", () => held);
  await assert.rejects(
    () => withDriverLock("screenshotting BBRI", async () => "never", 30),
    (e: unknown) => {
      assert.ok(e instanceof StockbitError);
      assert.match(e.message, /one at a time/);
      assert.match(e.message, /Nothing was changed/);
      // Names the CURRENT holder, and says so in those words — after a handoff the blocking call is
      // not the one we queued behind, and claiming otherwise would invent a cause.
      assert.match(e.message, /currently busy with drawing on BBRI/);
      return true;
    },
  );
  release();
  await holder;
});

test("the wait timeout stays under the MCP SDK's own request timeout", async () => {
  // A longer wait is unreachable in the only way that matters: the client gives up at 60s and
  // cancels, so a message crafted after that is written to a caller that stopped listening.
  const { DEFAULT_REQUEST_TIMEOUT_MSEC } = await import("@modelcontextprotocol/sdk/shared/protocol.js");
  assert.ok(
    DRIVER_LOCK_WAIT_MS < DEFAULT_REQUEST_TIMEOUT_MSEC,
    `${DRIVER_LOCK_WAIT_MS}ms must be under the client's ${DEFAULT_REQUEST_TIMEOUT_MSEC}ms`,
  );
});

test("a stale release cannot hand the window to two callers at once", async () => {
  // Without an ownership check, A's `finally` would clear whatever `holder` happens to be — B, mid
  // flight — and the next arrival walks in beside it. That is the collision this module prevents,
  // reintroduced by its own cleanup path.
  let releaseA: () => void = () => {};
  const aInside = new Promise<void>((r) => (releaseA = r));
  const a = withDriverLock("A", () => aInside);
  await delay(10);

  resetDriverLock(); // A is still running, but no longer recorded as the holder.
  let bRunning = false;
  let releaseB: () => void = () => {};
  const bInside = new Promise<void>((r) => (releaseB = r));
  const b = withDriverLock("B", async () => {
    bRunning = true;
    await bInside;
  });
  await delay(10);
  assert.ok(bRunning, "B took the free lock");

  releaseA(); // A's finally fires a release it no longer owns.
  await a;
  assert.equal(driverLockState().busy, true, "B must still hold the window after A's stale release");
  assert.equal(driverLockState().what, "B");

  releaseB();
  await b;
  assert.equal(driverLockState().busy, false);
});

test("resetDriverLock rejects what is queued rather than granting it", async () => {
  // A reset means "whatever was running is no longer accounted for". Handing the window to a queued
  // call at that moment is the collision, not the recovery.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const holder = withDriverLock("holder", () => held);
  const queued = withDriverLock("queued", async () => "ran");
  await delay(10);
  resetDriverLock();
  await assert.rejects(() => queued, /reset/);
  release();
  await holder;
  resetDriverLock();
});

/**
 * The property that makes ONE lock sufficient, asserted against the source.
 *
 * `withChart` is the only thing that opens a chart session, and no exported driver function calls
 * another — so the mutex has no re-entrant path to deadlock on. Both are invisible at runtime
 * without a browser, and both are one edit away from being false.
 */
test("every chart session is opened inside the lock, and nothing re-enters it", () => {
  const driver = readFileSync(join(SRC, "chartbit", "driver.ts"), "utf8");

  // 1. withChart is the only door. Scanned across the WHOLE of src/, not just this directory:
  // `ChartbitSession` is an exported class with a public static `open`, so any module anywhere
  // could open the browser outside the mutex, and a guard that watched one file would stay green
  // while the property it protects was broken.
  const openers = allSourceFiles(SRC).filter((f) => /ChartbitSession\.open\s*\(/.test(readFileSync(f, "utf8")));
  assert.deepEqual(
    openers.map((f) => f.slice(SRC.length + 1)),
    ["chartbit/driver.ts"],
    "a module that opens a chart session outside driver.ts drives the browser outside the mutex",
  );
  assert.equal((driver.match(/ChartbitSession\.open\s*\(/g) ?? []).length, 1);

  // 2. Every exported driver function goes through withChart, and exactly once each.
  //
  // First close the shape hole: this enumerates `export async function`, so an export written as
  // `export const foo = async () => {…}` that called `evaluateInPage` directly would be invisible
  // here, would not change the `withChart({` count, and would drive the browser outside the mutex
  // with this guard still green. So the FORM of every export is pinned too.
  const exportLines = [...driver.matchAll(/^export .*/gm)].map((m) => m[0]);
  for (const line of exportLines) {
    assert.ok(
      /^export (async function \w+|interface \w+|type \w+|const (CHART_TYPE_NAMES)\b)/.test(line),
      `unexpected export shape in driver.ts — a callable export that is not \`export async function\` ` +
        `would bypass the withChart audit below: ${line.slice(0, 90)}`,
    );
  }

  const exported = [...driver.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual(
    exported.sort(),
    ["addStudy", "clearDrawings", "drawAnnotations", "listShapes", "openChart", "saveChart", "screenshotChart"],
    "a new driver export must be routed through withChart and named here, consciously",
  );
  assert.equal((driver.match(/withChart\(\{/g) ?? []).length, exported.length);

  // 3. No export calls another export — that is what makes a non-reentrant mutex safe here.
  const body = driver.slice(driver.indexOf("export async function"));
  for (const name of exported) {
    const calls = [...body.matchAll(new RegExp(`(?<!function )\\b${name}\\s*\\(`, "g"))];
    assert.equal(calls.length, 0, `${name} is called from inside driver.ts — the mutex would deadlock`);
  }
});

/* --------------------- one annotation array, either tool, either spelling --------------------- */

/**
 * `price_chart` took `from_date`/`from_price`/`to_date`/`to_price` while `chartbit_draw` took
 * `fromDate`/`fromPrice`/`toDate`/`toPrice` — the same conceptual object under two names, so an
 * array could not be moved between them without rewriting every key. That move is the workflow:
 * draw locally to check the geometry, then draw for real on the user's chart.
 */
test("snake_case coordinates draw exactly what camelCase draws", () => {
  const snake = toShapeRequests(
    [{ kind: "trend", from_date: "2026-01-02", from_price: 100, to_date: "2026-08-24", to_price: 200 } as never],
    CONTEXT,
  );
  const camel = toShapeRequests(
    [{ kind: "trend", fromDate: "2026-01-02", fromPrice: 100, toDate: "2026-08-24", toPrice: 200 }],
    CONTEXT,
  );
  assert.deepEqual(snake, camel);
  assert.equal(snake[0].points[0].time, epochSeconds("2026-01-02"));
  assert.equal(snake[0].points[1].price, 200);
});

test("the snake_case spelling works for every two-point kind, not just trend", () => {
  // channel and fib take the same four coordinates, and a mapping that covered only `trend` would
  // leave two kinds behind — the exact half-fix this issue was about.
  const cases = [
    { kind: "channel", from_date: "2026-01-02", from_price: 1, to_date: "2026-08-24", to_price: 2, offset: -5 },
    { kind: "fib", from_date: "2026-01-02", from_price: 1, to_date: "2026-08-24", to_price: 2 },
  ];
  for (const annotation of cases) {
    const [request] = toShapeRequests([annotation as never], CONTEXT);
    assert.equal(request.points[0].time, epochSeconds("2026-01-02"), annotation.kind);
    assert.equal(request.points[1].price, 2, annotation.kind);
  }
});

test("normalizeAnnotationKeys leaves an annotation with neither spelling alone", () => {
  const level = { kind: "level", price: 100 };
  assert.equal(normalizeAnnotationKeys(level), level, "an untouched row is not needlessly copied");
  // And it is not confused by things that are not objects.
  assert.equal(normalizeAnnotationKeys(null), null);
  assert.equal(normalizeAnnotationKeys("nope"), "nope");
});

test("both spellings of ONE coordinate, disagreeing, is refused rather than picked between", () => {
  // Silently preferring one of two contradictory numbers would be guessing a point, which this
  // module refuses everywhere else: a wrong coordinate is a wrong drawing, not a cosmetic miss.
  assert.throws(
    () =>
      toShapeRequests(
        [
          {
            kind: "trend",
            fromDate: "2026-01-02",
            from_date: "2020-01-01",
            fromPrice: 1,
            toDate: "2026-08-24",
            toPrice: 2,
          } as never,
        ],
        CONTEXT,
      ),
    (e: unknown) => {
      assert.ok(e instanceof StockbitError);
      assert.equal(e.kind, "invalid_param");
      assert.match(e.message, /two spellings of ONE coordinate/);
      return true;
    },
  );
});

test("a null alias is 'no value', not a disagreeing one", () => {
  // `annotations` is an open record, so a JSON null reaches the normalizer unfiltered. Treating it
  // as a rival value refuses `{from_date: "…", fromDate: null}` — a caller who spelled it once —
  // by blaming a contradiction that does not exist.
  const [request] = toShapeRequests(
    [
      {
        kind: "trend",
        from_date: "2026-01-02",
        fromDate: null,
        from_price: 1,
        fromPrice: null,
        to_date: "2026-08-24",
        to_price: 2,
      } as never,
    ],
    CONTEXT,
  );
  assert.equal(request.points[0].time, epochSeconds("2026-01-02"));
  assert.equal(request.points[0].price, 1, "the snake_case value must win over a null camelCase one");
});

test("a null on EITHER side is 'no value' — the two halves behave the same", () => {
  // The first cut only handled a null camelCase value, so `{from_date: null, fromDate: "…"}` still
  // threw "they disagree" while its mirror was accepted. Same caller intent, opposite outcome.
  const [request] = toShapeRequests(
    [
      {
        kind: "trend",
        from_date: null,
        fromDate: "2026-01-02",
        from_price: null,
        fromPrice: 1,
        to_date: "2026-08-24",
        to_price: 2,
      } as never,
    ],
    CONTEXT,
  );
  assert.equal(request.points[0].time, epochSeconds("2026-01-02"));
  assert.equal(request.points[0].price, 1);
});

test("-0 and 0 are the same coordinate, not a contradiction", () => {
  // `Object.is(-0, 0)` is false, which produced the self-refuting message "carries both (0) and
  // (0) ... they disagree".
  const [request] = toShapeRequests(
    [
      { kind: "trend", fromDate: "2026-01-02", fromPrice: -0, from_price: 0, toDate: "2026-08-24", toPrice: 2 } as never,
    ],
    CONTEXT,
  );
  assert.equal(request.points[0].price, -0);
});

test("both spellings AGREEING is accepted — it is not a contradiction", () => {
  const [request] = toShapeRequests(
    [
      {
        kind: "trend",
        fromDate: "2026-01-02",
        from_date: "2026-01-02",
        fromPrice: 1,
        from_price: 1,
        toDate: "2026-08-24",
        toPrice: 2,
      } as never,
    ],
    CONTEXT,
  );
  assert.equal(request.points[0].time, epochSeconds("2026-01-02"));
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

      // Wait for the fixture to actually be there before probing it.
      //
      // `Target.createTarget` returns as soon as the target EXISTS, not when it has loaded. Without
      // this the probe could run against a document whose body had not been parsed yet, read an
      // empty `innerText`, and report `blank: true` — failing an assertion about a page state the
      // test had not reached. It looked like a flaky product bug and was a missing wait: the same
      // poll every other browser-driven test in this repo already does, omitted only here. It lost
      // the race more often on a loaded machine, which is exactly when the suite runs.
      let loaded = false;
      for (let i = 0; i < 50 && !loaded; i++) {
        const probe = (await cdp.send(
          "Runtime.evaluate",
          {
            expression:
              "Boolean(document.body && document.body.innerText.trim().length > 0 && window.tvWidget)",
            returnByValue: true,
          },
          attached.sessionId,
          5_000,
        )) as { result?: { value?: boolean } };
        loaded = probe.result?.value === true;
        if (!loaded) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(loaded, "the fixture page never finished loading its body and widget");

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

/* ---------------- Fibonacci retracement ---------------- */

test("a fib retracement maps to TradingView's own tool, not to seven horizontal lines", () => {
  // The distinction matters: the native tool derives its own ratios, keeps them when an endpoint is
  // dragged, and labels each level with ratio and price. Seven computed lines are a photograph.
  const request = toShapeRequest(
    { kind: "fib", fromDate: "2026-07-02", fromPrice: 456, toDate: "2026-08-21", toPrice: 935 },
    CONTEXT,
  );
  assert.equal(request.shape, "fib_retracement");
  assert.equal(request.points.length, 2, "two points, so it goes through createMultipointShape");
  assert.deepEqual(
    request.points.map((p) => p.price),
    [456, 935],
    "from is the START of the move and to its END; reversing them flips the ratios",
  );
});

test("a fib carries NO text property — the tool throws on one", () => {
  // Measured on Stockbit's TradingView v29.6 by probing the live widget: `createMultipointShape`
  // with `text` on a fib_retracement throws "Value is undefined" and draws nothing; the identical
  // call without it succeeds. Every other tool here takes `text`, so this asymmetry needs a test or
  // it gets "fixed" back.
  const request = toShapeRequest(
    { kind: "fib", fromDate: "2026-07-02", fromPrice: 456, toDate: "2026-08-21", toPrice: 935, label: "swing" },
    CONTEXT,
  );
  assert.equal(request.options.text, undefined, "a text property makes the widget throw");
  assert.equal(request.ours.label, "swing", "but the label must survive for `clear scope:ours`");
});

test("a fib shows its prices, because a ratio alone cannot be read against a support level", () => {
  const request = toShapeRequest(
    { kind: "fib", fromDate: "2026-07-02", fromPrice: 456, toDate: "2026-08-21", toPrice: 935 },
    CONTEXT,
  );
  assert.equal(request.options.overrides.showPrices, true);
  assert.equal(request.options.overrides.showCoeffs, true);
});

test("a fib with a missing or non-finite coordinate is refused rather than drawn somewhere", () => {
  // A retracement is defined entirely by its two prices: get one wrong and every level below it is
  // wrong too, quietly and plausibly.
  for (const bad of [
    { kind: "fib", fromDate: "2026-07-02", toDate: "2026-08-21", toPrice: 935 },
    { kind: "fib", fromDate: "2026-07-02", fromPrice: 456, toDate: "2026-08-21" },
    { kind: "fib", fromDate: "2026-07-02", fromPrice: NaN, toDate: "2026-08-21", toPrice: 935 },
    { kind: "fib", fromDate: "2026-07-02", fromPrice: "456", toDate: "2026-08-21", toPrice: 935 },
  ]) {
    assert.throws(() => toShapeRequest(bad as never, CONTEXT), /numeric/i, `${JSON.stringify(bad)} must be refused`);
  }
});

test("zero is a legitimate fib coordinate and must not read as missing", () => {
  assert.doesNotThrow(() =>
    toShapeRequest({ kind: "fib", fromDate: "2026-07-02", fromPrice: 0, toDate: "2026-08-21", toPrice: 935 }, CONTEXT),
  );
});

test("a fib with an unparseable date is refused", () => {
  assert.throws(() =>
    toShapeRequest({ kind: "fib", fromDate: "not-a-date", fromPrice: 1, toDate: "2026-08-21", toPrice: 2 }, CONTEXT),
  );
});

/* ---------------- a zone that can actually be seen ---------------- */

/**
 * The defect: a rectangle whose two corners share one timestamp has zero width, and TradingView
 * renders zero width as nothing. Observed on a real chart — correct prices in `points`, a cheerful
 * `drawn: 1`, an empty `failed`, and an invisible drawing. Every report agreed except the chart.
 *
 * `render/candles.ts` had already decided what a zone is: `x=PAD_L, width=plotW`, a band across the
 * whole plot. These pin the Chartbit side to the same meaning.
 */

test("a zone extends across the chart, because a zero-width rectangle draws nothing", () => {
  const request = toShapeRequest({ kind: "zone", from: 825, to: 860 }, CONTEXT);
  assert.equal(request.shape, "rectangle");
  assert.equal(request.options.overrides.extendLeft, true, "without this the band has no width");
  assert.equal(request.options.overrides.extendRight, true);
});

test("a zone keeps the prices it was given, in the order it was given them", () => {
  const request = toShapeRequest({ kind: "zone", from: 825, to: 860 }, CONTEXT);
  assert.deepEqual(
    request.points.map((p) => p.price),
    [825, 860],
  );
});

test("a labelled zone shows its label; an unlabelled one does not claim to", () => {
  const labelled = toShapeRequest({ kind: "zone", from: 1, to: 2, label: "decision zone" }, CONTEXT);
  assert.equal(labelled.options.text, "decision zone");
  assert.equal(labelled.options.overrides.showLabel, true);
  assert.equal(toShapeRequest({ kind: "zone", from: 1, to: 2 }, CONTEXT).options.overrides.showLabel, false);
});

/* ---------------- a missing coordinate is an error, not a shape ---------------- */

/**
 * What actually happened: a zone was sent with `price`/`price2` instead of `from`/`to`. Both
 * coordinates arrived `undefined`, travelled to the widget untouched, and became a zero-size
 * rectangle anchored at the day's high — reported as drawn. A caller cannot detect that; only a
 * human looking at the chart can, and only if they know what should be there.
 */

for (const [name, annotation] of [
  ["level without a price", { kind: "level" }],
  ["level with a string price", { kind: "level", price: "100" }],
  ["zone sent price/price2 instead of from/to", { kind: "zone", price: 825, price2: 860 }],
  ["zone missing `to`", { kind: "zone", from: 825 }],
  ["trend without prices", { kind: "trend", fromDate: "2026-01-02", toDate: "2026-08-24" }],
  ["trend with a NaN price", { kind: "trend", fromDate: "2026-01-02", fromPrice: NaN, toDate: "2026-08-24", toPrice: 2 }],
  [
    "channel without an offset — it would draw as a single line",
    { kind: "channel", fromDate: "2026-01-02", fromPrice: 1, toDate: "2026-08-24", toPrice: 2 },
  ],
  ["marker with a non-numeric price", { kind: "marker", date: "2026-08-24", price: "10", label: "x" }],
] as Array<[string, unknown]>) {
  test(`refuses to draw: ${name}`, () => {
    assert.throws(
      () => toShapeRequest(annotation as Parameters<typeof toShapeRequest>[0], CONTEXT),
      /numeric/i,
      `${name} must fail loudly rather than draw at an arbitrary price`,
    );
  });
}

test("zero is a legitimate coordinate and must not be mistaken for missing", () => {
  // The obvious way to write this check is falsiness, and it would reject 0.
  assert.doesNotThrow(() => toShapeRequest({ kind: "level", price: 0 }, CONTEXT));
  assert.equal(toShapeRequest({ kind: "level", price: 0 }, CONTEXT).points[0].price, 0);
});

test("a marker with no price at all is still valid — it is a text label on a date", () => {
  const request = toShapeRequest({ kind: "marker", date: "2026-08-24", label: "earnings" }, CONTEXT);
  assert.equal(request.shape, "text");
  assert.equal(request.points[0].price, undefined);
});

test("a negative channel offset still builds — direction is not an error", () => {
  const request = toShapeRequest(
    { kind: "channel", fromDate: "2026-01-02", fromPrice: 100, toDate: "2026-08-24", toPrice: 200, offset: -30 },
    CONTEXT,
  );
  assert.equal(request.points.length, 3);
  assert.equal(request.points[2].price, 170, "the parallel sits at toPrice + offset");
});

test("nothing writes a note through the `notes` getter, which hands out a copy", () => {
  // `get notes()` returns `[...this.warnings]`, so `session.notes.push(...)` compiles, runs, and
  // silently does nothing. It shipped that way: the "applied the stored web session" note — the one
  // line that says whether the stored session was used at all and how old it was — never reached a
  // caller, during exactly the period a session bug was being chased. Use `addNote()`.
  //
  // A grep rather than a behavioural assertion because the failure has no behaviour: the wrong call
  // and the right one are indistinguishable at runtime except by the note not being there.
  const offenders: string[] = [];
  for (const file of chartbitFiles()) {
    const code = stripComments(readFileSync(file, "utf8"));
    if (/\.notes\s*\.\s*(push|pop|splice|shift|unshift)\s*\(/.test(code)) {
      offenders.push(file.slice(SRC.length + 1));
    }
  }
  assert.deepEqual(offenders, [], "mutating `notes` is a no-op — call addNote() instead");
});

test("that guard is not vacuous (negative control)", () => {
  const bad = 'session.notes.push("x");';
  assert.ok(/\.notes\s*\.\s*(push|pop|splice|shift|unshift)\s*\(/.test(stripComments(bad)));
  const good = 'session.addNote("x");';
  assert.equal(/\.notes\s*\.\s*(push|pop|splice|shift|unshift)\s*\(/.test(stripComments(good)), false);
});
