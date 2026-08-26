/**
 * The JavaScript that runs INSIDE the Stockbit chart page.
 *
 * Every one of these is a string constant with no template interpolation. That is not a style
 * choice: arguments reach the page only as `JSON.stringify`d values appended by `evaluate.ts`, so
 * there is no path by which a symbol, a label, or a colour becomes executable code in a page that
 * holds the user's live session. A dollar-brace interpolation anywhere in this file would open
 * exactly that path, and the guard in `test/chartbit.test.ts` greps for one — mechanically, over the
 * whole file, which is why even the prose here spells it out rather than quoting it.
 *
 * The same guard is why no string here begins with a slash: the transport's first-path-segment
 * check reads a quoted leading slash as a call site declaring its own route, and it is right to.
 *
 * ## What the page actually exposes
 *
 * `window.tvWidget` is **an object keyed by widget key**, not the widget itself — Stockbit renders
 * more than one chart context and stores them together. Every script below resolves the key first.
 * Reaching for `window.tvWidget.activeChart()` returns undefined, which reads as "the chart is not
 * ready yet" and then times out, which is a long way from the truth.
 *
 * The chart itself renders in an iframe, but the widget handle lives on the top-level window, so
 * these run in the main frame.
 */

/** Resolve the widget handle. Shared prologue; every script below assumes `w` is the widget. */
const PROLOGUE = `
  var bag = window.tvWidget;
  if (!bag) return { ready: false, reason: "no-widget" };
  var key = Object.keys(bag).find(function (k) { return bag[k]; });
  if (!key) return { ready: false, reason: "no-widget-key" };
  var w = bag[key];
  if (!w || typeof w.activeChart !== "function") return { ready: false, reason: "widget-not-initialised" };
  var chart;
  try {
    chart = w.activeChart();
  } catch (e) { return { ready: false, reason: "widget-booting" }; }
  if (!chart) return { ready: false, reason: "no-active-chart" };
`;

/**
 * Wrap a body as an IIFE returning a value, so `Runtime.evaluate` gets one expression.
 *
 * Bodies are concatenated rather than interpolated, throughout this file. An interpolation would put
 * the sequence the guard forbids into the source even where the value being interpolated is one of
 * our own constants, and a guard that has to reason about which interpolations are safe is not a
 * mechanical guard any more.
 */
function script(body: string): string {
  return "(function () {" + body + "})()";
}

/**
 * Is the page a logged-in chart yet?
 *
 * Reports the states separately, because they need different messages. A signed-out Stockbit chart
 * renders an EMPTY WHITE BODY — no login wall, no text — so "blank" and "still loading" are
 * indistinguishable from a screenshot and must be distinguished here.
 *
 * `textContent`, NOT `innerText`. `innerText` is defined in terms of RENDERED text, so it returns ""
 * for a document that has not been laid out — and this page reaches exactly that state. Measured: a
 * chart page carrying 2,335 characters of server-rendered markup across 8 elements reported
 * `innerText.length === 0`, which this script called `blank`, which the driver reported as "the
 * session is not signed in". The session was fine. The page had simply rendered nothing because
 * every API call behind it was being answered with 401, and a layout-dependent probe cannot tell
 * those apart. `textContent` is layout-independent and can.
 *
 * `shellOnly` is that newly visible state: real markup, zero height. It means the document arrived
 * and the app could not paint — in practice a stale browser session whose XHRs are all 401ing. It is
 * worth its own message because the fix is "log in again", while `blank` means something never
 * arrived at all.
 *
 * `hasChart` alone is not "ready": `activeChart()` returns a real object as soon as the widget shell
 * mounts, well before the datafeed has delivered a single bar. A screenshot or a shape taken on
 * `hasChart` alone lands on a chart that reads as ready and paints nothing. `hasBars` closes that gap
 * by asking the series itself, which is `false` until Stockbit's price/daily response has actually
 * landed — the wrapping try/catch is because `getSeries` is a further widget-internal call this
 * script has no control over, and "not ready yet" must never be confused with "the page threw".
 */
export const READINESS = script(`
  var path = String(location.pathname || "");
  var loggedOut = path.indexOf("login") >= 0;
  var bodyText = (document.body && document.body.textContent ? document.body.textContent : "").trim();
  var bodyHeight = 0;
  try {
    bodyHeight = document.body ? Math.round(document.body.getBoundingClientRect().height) : 0;
  } catch (e) { bodyHeight = 0; }
  var bag = window.tvWidget;
  var key = bag ? Object.keys(bag).find(function (k) { return bag[k]; }) : undefined;
  var w = key ? bag[key] : undefined;
  var chart;
  try {
    chart = w && typeof w.activeChart === "function" ? w.activeChart() : undefined;
  } catch (e) { chart = undefined; }
  var hasBars = false;
  try {
    var series = chart && chart.getSeries ? chart.getSeries() : null;
    hasBars = Boolean(series && !series.isLoading() && series.barsCount() > 0);
  } catch (e) { hasBars = false; }
  var sym = null;
  try {
    sym = chart && typeof chart.symbol === "function" ? String(chart.symbol()) : null;
  } catch (e) { sym = null; }
  return {
    loggedOut: loggedOut,
    blank: !loggedOut && bodyText.length === 0,
    shellOnly: !loggedOut && bodyText.length > 0 && bodyHeight === 0,
    widgetKey: key || null,
    hasChart: Boolean(chart),
    hasBars: hasBars,
    symbol: sym,
    readyState: document.readyState
  };
`);

/**
 * Create one shape.
 *
 * A single-point tool goes through `createShape`, a multi-point one through `createMultipointShape`;
 * TradingView will not accept a two-point request on the single-point call and answers with `null`
 * rather than throwing, which would surface as "drawn" with nothing on the chart.
 *
 * `Promise.resolve(id)` rather than a bare `id`: this library version returns the entity id
 * asynchronously (a Promise), and returning that unresolved into `evaluateInPage` serialises to `{}`
 * over CDP's `returnByValue` — silent, since `{}` is still valid JSON. The id this project then
 * stores as `tvEntityId` is unusable for its one job (`chartbit_clear scope:"ours"` matching it
 * against a later `chart.getAllShapes()`), so cleanup silently no-ops while reporting success and the
 * drawing survives on the user's real chart. `Promise.resolve` also covers an older library that
 * still returns the id synchronously, so this does not have to know which one it is talking to.
 */
export const CREATE_SHAPE = script(PROLOGUE + `
  var req = SHAPE_REQUEST;
  var idOrPromise = req.points.length > 1
    ? chart.createMultipointShape(req.points, req.options)
    : chart.createShape(req.points[0], req.options);
  return Promise.resolve(idOrPromise).then(function (id) {
    return { ready: true, id: id === undefined ? null : id, widgetKey: key };
  });
`);

/** Every shape on the chart, with whatever properties TradingView will hand back. */
export const LIST_SHAPES = script(PROLOGUE + `
  var ids = chart.getAllShapes ? chart.getAllShapes() : [];
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var entry = ids[i];
    var id = entry && entry.id !== undefined ? entry.id : entry;
    var record = { id: id, name: entry && entry.name ? entry.name : null };
    try {
      var handle = chart.getShapeById(id);
      if (handle && typeof handle.getProperties === "function") record.properties = handle.getProperties();
      if (handle && typeof handle.getPoints === "function") record.points = handle.getPoints();
    } catch (err) {
      record.error = String(err);
    }
    out.push(record);
  }
  return { ready: true, shapes: out, widgetKey: key };
`);

/** Remove specific entities by id. Ids come from our own local store, never from a guess. */
export const REMOVE_SHAPES = script(PROLOGUE + `
  var ids = SHAPE_IDS;
  var removed = 0;
  var missing = [];
  for (var i = 0; i < ids.length; i++) {
    try {
      chart.removeEntity(ids[i]);
      removed++;
    } catch (err) {
      missing.push(String(ids[i]));
    }
  }
  return { ready: true, removed: removed, missing: missing, widgetKey: key };
`);

/** Remove EVERY drawing, including ones the user made by hand. Gated behind confirmation upstream. */
export const REMOVE_ALL_SHAPES = script(PROLOGUE + `
  var before = chart.getAllShapes ? chart.getAllShapes().length : 0;
  chart.removeAllShapes();
  var after = chart.getAllShapes ? chart.getAllShapes().length : 0;
  return { ready: true, before: before, after: after, widgetKey: key };
`);

/** Change what the chart is showing: symbol, resolution, chart type. */
export const SET_VIEW = script(PROLOGUE + `
  var view = VIEW_REQUEST;
  if (view.resolution) chart.setResolution(String(view.resolution));
  if (view.chartType !== null && view.chartType !== undefined) chart.setChartType(Number(view.chartType));
  if (view.symbol) chart.setSymbol(String(view.symbol));
  return {
    ready: true,
    symbol: typeof chart.symbol === "function" ? String(chart.symbol()) : null,
    resolution: typeof chart.resolution === "function" ? String(chart.resolution()) : null,
    widgetKey: key
  };
`);

/**
 * Add an indicator by its TradingView study name. The name is whitelisted before it gets here.
 *
 * Same `Promise.resolve` as `CREATE_SHAPE`, and for the same reason: `createStudy` also answers with
 * a Promise in this library version, not the id directly.
 */
export const CREATE_STUDY = script(PROLOGUE + `
  var study = STUDY_REQUEST;
  var idOrPromise = chart.createStudy(String(study.name), false, false, study.inputs || []);
  return Promise.resolve(idOrPromise).then(function (id) {
    return { ready: true, id: id === undefined ? null : id, widgetKey: key };
  });
`);

/**
 * Ask Stockbit's own save adapter to persist the chart.
 *
 * This is what makes drawing durable without this project composing a save payload: the page's
 * adapter serialises the widget's real state and posts it. Our REST read afterwards is the check
 * that it landed, because `saveChartToServer` resolves without telling us what the server did.
 */
export const SAVE_CHART = script(PROLOGUE + `
  if (typeof w.saveChartToServer !== "function") return { ready: true, saved: false, reason: "no-save-adapter" };
  return new Promise(function (resolve) {
    var settled = false;
    var done = function (ok, reason) {
      if (settled) return;
      settled = true;
      resolve({ ready: true, saved: ok, reason: reason || null, widgetKey: key });
    };
    try {
      w.saveChartToServer(function () { done(true); }, function (err) { done(false, String(err)); }, { defaultChartName: null });
    } catch (err) {
      done(false, String(err));
    }
    setTimeout(function () { done(false, "timeout"); }, 15000);
  });
`);

/**
 * Placeholder names substituted by `evaluate.ts`.
 *
 * Substitution happens on the JSON-encoded value, not on raw text, which is what keeps the "no
 * interpolation" property real rather than nominal.
 */
export const PLACEHOLDERS = {
  shapeRequest: "SHAPE_REQUEST",
  shapeIds: "SHAPE_IDS",
  viewRequest: "VIEW_REQUEST",
  studyRequest: "STUDY_REQUEST",
} as const;
