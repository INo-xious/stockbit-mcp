/**
 * The operations a caller actually asks for: open a chart, draw on it, look at it, save it.
 *
 * Everything here composes the four modules beside it — `session` (which browser, which tab),
 * `evaluate` (how a script reaches the page), `shapes` (what a drawing becomes) and `store` (what we
 * put there). Each call opens a session, does its work, and closes; the browser itself survives when
 * `chartbit.keepBrowserOpen` is on, which is the default, so the second call is fast and the user
 * keeps looking at one window.
 *
 * ## Why drawing needs no confirmation, and clearing everything does
 *
 * ADR-0005: a drawing is additive, visible, session-local and undoable in the user's own UI with
 * ctrl-Z. Requiring `confirm: true` for it would train a caller to pass `confirm` reflexively, which
 * is exactly what devalues it on the operations that matter. `clear({scope: "all"})` is the
 * opposite — it deletes hand-drawn analysis that this project never saw and cannot restore — so it
 * requires confirmation, and `clear({scope: "ours"})` does not, because it works from a list of ids
 * we created.
 *
 * ## The save is Stockbit's, and the verification is ours
 *
 * `saveChartToServer` hands the widget's own state to Stockbit's own adapter. This project does not
 * compose a save payload, because TradingView's line-tool schema is the library's. What it does do
 * is read the drawings back over REST afterwards and check the new tools are there — the adapter
 * resolves without saying what the server did, and "the call returned" is not "it was stored".
 */
import { StockbitError } from "../http/errors.js";
import { normalizeSymbol } from "../symbol.js";
import { ChartbitSession, type ChartTab } from "./session.js";
import { evaluateInPage } from "./evaluate.js";
import {
  CREATE_SHAPE,
  CREATE_STUDY,
  LIST_SHAPES,
  PLACEHOLDERS,
  REMOVE_ALL_SHAPES,
  REMOVE_SHAPES,
  SAVE_CHART,
  SET_VIEW,
} from "./page-scripts.js";
import {
  studyRequest,
  toShapeRequests,
  type DrawableAnnotation,
  type ShapeContext,
} from "./shapes.js";
import {
  addOurDrawings,
  forgetOurDrawings,
  loadOurDrawings,
  setOurDrawings,
  type OurDrawing,
} from "./store.js";
import { getChartDrawings } from "./api.js";

/** Chart types the widget accepts, by the name a caller would use. Values are TradingView's. */
export const CHART_TYPES = {
  bar: 0,
  candle: 1,
  line: 2,
  area: 3,
  heikinAshi: 8,
  hollowCandle: 9,
  baseline: 10,
} as const;

export type ChartTypeName = keyof typeof CHART_TYPES;
export const CHART_TYPE_NAMES = Object.keys(CHART_TYPES) as ChartTypeName[];

export interface OpenChartOptions {
  symbol: string;
  resolution?: string;
  chartType?: ChartTypeName;
  headless?: boolean;
}

interface PageResult {
  ready: boolean;
  reason?: string;
  widgetKey?: string | null;
}

/** Turn a page script's "not ready" answer into an error that names which part was missing. */
function requireReady<T extends PageResult>(result: T | undefined, what: string): T {
  if (!result) {
    throw new StockbitError("upstream", `The chart page returned nothing while ${what}.`);
  }
  if (!result.ready) {
    throw new StockbitError(
      "upstream",
      `The chart was not ready while ${what} (${result.reason ?? "unknown"}). ` +
        "This usually means the page navigated or the widget was torn down mid-operation.",
    );
  }
  return result;
}

async function withChart<T>(
  options: { symbol: string; headless?: boolean },
  work: (tab: ChartTab, session: ChartbitSession) => Promise<T>,
): Promise<T> {
  const { session, tab } = await ChartbitSession.open({ symbol: options.symbol, headless: options.headless });
  try {
    return await work(tab, session);
  } finally {
    await session.close();
  }
}

/* ------------------------------------- open / set ------------------------------------- */

export interface ChartState {
  symbol: string;
  resolution: string | null;
  widgetKey: string | null;
  notes: string[];
}

/** Open the chart page for a symbol, optionally changing resolution or chart type. */
export async function openChart(options: OpenChartOptions): Promise<ChartState> {
  const symbol = normalizeSymbol(options.symbol);
  return withChart({ symbol, headless: options.headless }, async (tab, session) => {
    if (options.resolution || options.chartType) {
      const view = await evaluateInPage<PageResult & { symbol: string | null; resolution: string | null }>(
        tab.cdp,
        tab.sessionId,
        SET_VIEW,
        {
          substitutions: {
            [PLACEHOLDERS.viewRequest]: {
              resolution: options.resolution ?? null,
              chartType: options.chartType ? CHART_TYPES[options.chartType] : null,
              symbol: null,
            },
          },
        },
      );
      const ready = requireReady(view, "changing the chart view");
      return { symbol, resolution: ready.resolution, widgetKey: ready.widgetKey ?? null, notes: session.notes };
    }
    return { symbol, resolution: null, widgetKey: tab.widgetKey, notes: session.notes };
  });
}

/* --------------------------------------- drawing --------------------------------------- */

export interface DrawResult {
  symbol: string;
  /** How many shapes the widget actually created. */
  drawn: number;
  /** Requests the widget accepted but returned no id for — created nothing, and says so. */
  failed: Array<{ kind: string; label?: string; shape: string }>;
  /** Removed first, when `replace` was set. */
  replaced: number;
  ours: OurDrawing[];
  notes: string[];
}

export interface DrawOptions {
  symbol: string;
  annotations: DrawableAnnotation[];
  /** Anchor date for tools that carry no time of their own — normally the latest bar. */
  anchorDate: string;
  /** Remove this project's previous drawings on this symbol first. Never touches the user's own. */
  replace?: boolean;
  style?: ShapeContext["style"];
  headless?: boolean;
}

/**
 * Draw a set of annotations on the real chart.
 *
 * A request the widget accepted but returned no id for is reported as FAILED rather than counted:
 * `createShape` answers `null` for a malformed point set instead of throwing, and counting those as
 * drawn is how a caller ends up telling a user about six levels when four are on screen.
 */
export async function drawAnnotations(options: DrawOptions): Promise<DrawResult> {
  const symbol = normalizeSymbol(options.symbol);
  // Mapped before the browser opens: a bad annotation should fail without launching anything.
  const requests = toShapeRequests(options.annotations, { anchorDate: options.anchorDate, style: options.style });

  return withChart({ symbol, headless: options.headless }, async (tab, session) => {
    let replaced = 0;
    if (options.replace) {
      const previous = loadOurDrawings(symbol);
      if (previous.length) {
        const result = await evaluateInPage<PageResult & { removed: number; missing: string[] }>(
          tab.cdp,
          tab.sessionId,
          REMOVE_SHAPES,
          { substitutions: { [PLACEHOLDERS.shapeIds]: previous.map((d) => d.tvEntityId) } },
        );
        replaced = requireReady(result, "removing previous drawings").removed;
      }
      setOurDrawings(symbol, []);
    }

    const created: OurDrawing[] = [];
    const failed: DrawResult["failed"] = [];
    const at = new Date().toISOString();

    // Sequential. The widget mutates shared chart state on every call, and the ids come back one at
    // a time; issuing them concurrently would interleave mutations for no gain on a local page.
    for (const request of requests) {
      const result = await evaluateInPage<PageResult & { id: string | null }>(tab.cdp, tab.sessionId, CREATE_SHAPE, {
        substitutions: { [PLACEHOLDERS.shapeRequest]: { points: request.points, options: request.options } },
      });
      const ready = requireReady(result, `drawing a ${request.shape}`);
      if (ready.id) {
        created.push({
          tvEntityId: String(ready.id),
          kind: request.ours.kind,
          label: request.ours.label,
          shape: request.shape,
          at,
        });
      } else {
        failed.push({ kind: request.ours.kind, label: request.ours.label, shape: request.shape });
      }
    }

    const ours = created.length ? addOurDrawings(symbol, created) : loadOurDrawings(symbol);
    return { symbol, drawn: created.length, failed, replaced, ours, notes: session.notes };
  });
}

/* ---------------------------------------- studies ---------------------------------------- */

/** Add an indicator to the chart. The name is checked against a closed list before it is sent. */
export async function addStudy(options: {
  symbol: string;
  study: string;
  inputs?: Array<string | number>;
  headless?: boolean;
}): Promise<{ symbol: string; study: string; id: string | null; notes: string[] }> {
  const symbol = normalizeSymbol(options.symbol);
  const request = studyRequest(options.study, options.inputs ?? []);
  return withChart({ symbol, headless: options.headless }, async (tab, session) => {
    const result = await evaluateInPage<PageResult & { id: string | null }>(tab.cdp, tab.sessionId, CREATE_STUDY, {
      substitutions: { [PLACEHOLDERS.studyRequest]: request },
    });
    const ready = requireReady(result, `adding the ${options.study} study`);
    return { symbol, study: request.name, id: ready.id ? String(ready.id) : null, notes: session.notes };
  });
}

/* ---------------------------------------- clearing ---------------------------------------- */

export interface ClearResult {
  symbol: string;
  scope: "ours" | "all";
  removed: number;
  /** Ids we had recorded that the chart no longer has — the user deleted them by hand. */
  alreadyGone: string[];
  notes: string[];
}

/**
 * Remove drawings.
 *
 * `ours` works from the local record of entity ids this project created, so it cannot touch the
 * user's own work. `all` calls the widget's `removeAllShapes`, which deletes everything on the
 * chart including analysis nobody here has seen — hence `confirm`.
 */
export async function clearDrawings(options: {
  symbol: string;
  scope: "ours" | "all";
  confirm?: boolean;
  headless?: boolean;
}): Promise<ClearResult> {
  const symbol = normalizeSymbol(options.symbol);

  if (options.scope === "all" && options.confirm !== true) {
    throw new StockbitError(
      "invalid_param",
      `Refusing to clear EVERY drawing on ${symbol}'s chart without confirm: true. That includes work the ` +
        'user drew by hand, which this server never saw and cannot restore. Use scope "ours" to remove only ' +
        "what this server drew.",
    );
  }

  return withChart({ symbol, headless: options.headless }, async (tab, session) => {
    if (options.scope === "all") {
      const result = await evaluateInPage<PageResult & { before: number; after: number }>(
        tab.cdp,
        tab.sessionId,
        REMOVE_ALL_SHAPES,
      );
      const ready = requireReady(result, "clearing every drawing");
      setOurDrawings(symbol, []);
      return {
        symbol,
        scope: "all" as const,
        removed: ready.before - ready.after,
        alreadyGone: [],
        notes: session.notes,
      };
    }

    const previous = loadOurDrawings(symbol);
    if (!previous.length) {
      return { symbol, scope: "ours" as const, removed: 0, alreadyGone: [], notes: session.notes };
    }
    const result = await evaluateInPage<PageResult & { removed: number; missing: string[] }>(
      tab.cdp,
      tab.sessionId,
      REMOVE_SHAPES,
      { substitutions: { [PLACEHOLDERS.shapeIds]: previous.map((d) => d.tvEntityId) } },
    );
    const ready = requireReady(result, "clearing this server's drawings");
    forgetOurDrawings(
      symbol,
      previous.map((d) => d.tvEntityId),
    );
    return {
      symbol,
      scope: "ours" as const,
      removed: ready.removed,
      alreadyGone: ready.missing,
      notes: session.notes,
    };
  });
}

/* ----------------------------------------- reading ----------------------------------------- */

export interface ShapeRecord {
  id: string;
  name: string | null;
  properties?: unknown;
  points?: unknown;
  /** True when this project's local record claims this entity. */
  ours: boolean;
  error?: string;
}

/** Every shape on the chart, with ours marked. The live view, not the saved one. */
export async function listShapes(options: {
  symbol: string;
  headless?: boolean;
}): Promise<{ symbol: string; shapes: ShapeRecord[]; notes: string[] }> {
  const symbol = normalizeSymbol(options.symbol);
  return withChart({ symbol, headless: options.headless }, async (tab, session) => {
    const result = await evaluateInPage<PageResult & { shapes: Array<Omit<ShapeRecord, "ours">> }>(
      tab.cdp,
      tab.sessionId,
      LIST_SHAPES,
    );
    const ready = requireReady(result, "listing drawings");
    const ourIds = new Set(loadOurDrawings(symbol).map((d) => d.tvEntityId));
    return {
      symbol,
      shapes: (ready.shapes ?? []).map((shape) => ({ ...shape, id: String(shape.id), ours: ourIds.has(String(shape.id)) })),
      notes: session.notes,
    };
  });
}

/** A PNG of the chart as it currently looks, base64-encoded. */
export async function screenshotChart(options: {
  symbol: string;
  headless?: boolean;
}): Promise<{ symbol: string; base64: string; notes: string[] }> {
  const symbol = normalizeSymbol(options.symbol);
  return withChart({ symbol, headless: options.headless }, async (tab, session) => {
    const shot = (await tab.cdp.send(
      "Page.captureScreenshot",
      { format: "png", captureBeyondViewport: false },
      tab.sessionId,
      30_000,
    )) as { data?: string };
    if (!shot?.data) {
      throw new StockbitError("upstream", "The chart page returned no screenshot data.");
    }
    return { symbol, base64: shot.data, notes: session.notes };
  });
}

/* ------------------------------------------ saving ------------------------------------------ */

export interface SaveChartResult {
  symbol: string;
  /** What the page's own save adapter reported. */
  saved: boolean;
  reason?: string | null;
  /**
   * Whether reading the drawings back over REST found any. `null` when the read could not be made
   * — which is not the same as "nothing was saved" and is never reported as such.
   */
  verifiedDrawings: number | null;
  verifyError?: string;
  notes: string[];
}

/**
 * Ask Stockbit to persist the chart, then check over REST that it did.
 *
 * The adapter resolves without telling us what the server stored, so "the call returned" is not
 * "it was saved". The REST read is the check. It is reported as a count rather than a boolean
 * because a caller needs to distinguish "the save landed and there are four drawings" from "the read
 * failed and we do not know", and a boolean collapses those.
 */
export async function saveChart(options: {
  symbol: string;
  layoutId?: string;
  chartId?: string;
  headless?: boolean;
}): Promise<SaveChartResult> {
  const symbol = normalizeSymbol(options.symbol);
  return withChart({ symbol, headless: options.headless }, async (tab, session) => {
    const result = await evaluateInPage<PageResult & { saved: boolean; reason: string | null }>(
      tab.cdp,
      tab.sessionId,
      SAVE_CHART,
    );
    const ready = requireReady(result, "saving the chart");

    let verifiedDrawings: number | null = null;
    let verifyError: string | undefined;
    try {
      const stored = await getChartDrawings({ symbol, layoutId: options.layoutId, chartId: options.chartId });
      verifiedDrawings = stored.drawings.length;
    } catch (err) {
      verifyError = err instanceof Error ? err.message : String(err);
    }

    return {
      symbol,
      saved: ready.saved,
      reason: ready.reason,
      verifiedDrawings,
      verifyError,
      notes: session.notes,
    };
  });
}
