/**
 * Chartbit over REST — reading and writing the user's saved charts without a browser.
 *
 * This is the headless half of ADR-0005. The other half drives the real chart page over CDP, which
 * is the only way to *compose* a drawing, because TradingView's line-tool schema belongs to the
 * widget. What lives here is everything that does not need the widget: listing layouts, reading a
 * layout and its drawings as analysis context, and persisting a payload that came off one of those
 * reads.
 *
 * ## The write apparatus is ADR-0003's, unchanged
 *
 * A layout write OVERWRITES and Stockbit offers no undo, so the failure that matters is not "the
 * write errored" — that one is obvious and recoverable. It is "the write succeeded and put
 * something wrong there", which is silent and permanent. Every guard below is one ADR-0003 names:
 * snapshot before touching anything, per-call confirmation, verify by reading back, roll back on
 * mismatch, log every attempt, refuse a payload we do not recognise.
 *
 * The one thing that changed is the target. ADR-0003 was written against the per-symbol layout
 * pair, which turned out to be a server-side stub — it accepted every valid body and stored
 * nothing. This is where the chart page's own save adapter points.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { deleteJson, getJson, postJson, putJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { normalizeSymbol } from "../symbol.js";
import { cached, invalidateCache, parseOr } from "../core/_util.js";
import { CACHE } from "../config.js";
import { acquireDirLock } from "../util/dirlock.js";
import {
  decodeDrawings,
  decodeLayoutContent,
  encodeDrawings,
  encodeLayoutContent,
  normalizeDrawingSymbol,
  type Drawing,
  type StoredSource,
} from "./codec.js";
import { stockbitDir } from "../paths.js";

function backupDir(): string {
  return join(stockbitDir(), "layout-backups");
}

/** Where every Chartbit mutation attempt is recorded, whatever its outcome. */
export function chartbitLogPath(): string {
  return join(stockbitDir(), "layout-mutations.log");
}

/** A lock older than this belongs to a process that died mid-write. */
const WRITE_LOCK_STALE_MS = 60_000;

/**
 * One append-only line per mutation attempt.
 *
 * Returns whether it succeeded. Not rethrowing is right — a failed log must not mask the outcome of
 * the write it describes — but silently swallowing it would advertise an audit entry that does not
 * exist, so callers report `logged: false` instead.
 */
function logMutation(entry: Record<string, unknown>): boolean {
  try {
    mkdirSync(stockbitDir(), { recursive: true });
    appendFileSync(chartbitLogPath(), `${JSON.stringify(entry)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function writeSnapshot(name: string, contents: string, at: string): string {
  mkdirSync(backupDir(), { recursive: true });
  const path = join(backupDir(), `${name}-${at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, contents, "utf8");
  return path;
}

/* ---------------------------------- reading layouts ---------------------------------- */

const LayoutRow = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    symbol: z.string().optional(),
    resolution: z.string().optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

const LayoutListResponse = z
  .object({ data: z.union([z.array(LayoutRow), z.object({ data: z.array(LayoutRow) }).passthrough()]).nullable().optional() })
  .passthrough();

const LayoutDetailResponse = z
  .object({
    data: z
      .object({
        // The chart page reads `data.data.content`; a flatter envelope is accepted too rather than
        // failing a read over one level of nesting.
        data: z.object({ content: z.string().nullable().optional() }).passthrough().optional(),
        content: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export interface ChartLayoutSummary {
  id: string;
  name?: string;
  symbol?: string;
  resolution?: string;
  savedAt?: string;
  /** Everything the projection did not name. */
  [key: string]: unknown;
}

/** Unwrap `data` or `data.data`, both of which this API uses depending on the endpoint. */
function unwrapList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const inner = (data as { data?: unknown } | null)?.data;
  return Array.isArray(inner) ? (inner as T[]) : [];
}

/** The saved chart layouts on this account. */
export async function listChartLayouts(): Promise<ChartLayoutSummary[]> {
  return cached("chartbit:layouts", CACHE.brokerSummaryTtlMs, async () => {
    const body = await getJson("chartbitCharts");
    const parsed = parseOr(LayoutListResponse, body, "chartbit layouts");
    return unwrapList<z.infer<typeof LayoutRow>>(parsed.data).map((row) => ({
      ...row,
      id: String(row.id ?? ""),
      savedAt: row.timestamp === undefined ? undefined : String(row.timestamp),
    }));
  });
}

/**
 * The exact stored bytes of one layout's content.
 *
 * Separate from the display accessor below, and that separation is the ADR-0003 lesson written
 * down: reading a write path through a *truncating* accessor made every real chart look empty,
 * which snapshotted nothing, failed verification unconditionally, and then "restored" an empty
 * string over the user's drawings. A byte-exact operation gets a byte-exact, uncached read.
 */
async function getLayoutContentRaw(layoutId: string): Promise<string> {
  const body = await getJson("chartbitChart", { segments: { layoutId } });
  const parsed = parseOr(LayoutDetailResponse, body, "chartbit layout");
  return parsed.data?.data?.content ?? parsed.data?.content ?? "";
}

export interface ChartLayout {
  id: string;
  /** Bytes of the stored (encoded) blob. Zero means the layout genuinely holds nothing. */
  encodedLength: number;
  /** The decoded layout, when it could be read. */
  layout: unknown;
  /** Set when the blob was present but could not be decoded — never reported as an empty chart. */
  decodeError?: string;
}

/** One layout, decoded. A decode failure is reported rather than folded into "nothing saved". */
export async function getChartLayout(layoutId: string): Promise<ChartLayout> {
  const content = await getLayoutContentRaw(layoutId);
  if (!content) return { id: layoutId, encodedLength: 0, layout: null };
  try {
    return { id: layoutId, encodedLength: content.length, layout: decodeLayoutContent(content) };
  } catch (err) {
    return {
      id: layoutId,
      encodedLength: content.length,
      layout: null,
      decodeError: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ---------------------------------- reading drawings ---------------------------------- */

const DrawingsResponse = z
  .object({
    data: z
      .object({
        data: z.object({ content: z.unknown() }).passthrough().optional(),
        content: z.unknown().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export interface ChartDrawings {
  layoutId?: string;
  chartId?: string;
  /** True when `chartId` was decoded out of the layout rather than supplied by the caller. */
  chartIdDerived?: boolean;
  symbol?: string;
  /** What the user has actually drawn, projected for reading. */
  drawings: Drawing[];
  /** The stored sources, verbatim. This is what a write may send back; the projection is not. */
  sources: StoredSource[];
  groups: unknown[];
}

export interface DrawingsQuery {
  layoutId?: string;
  chartId?: string;
  symbol?: string;
}

/**
 * The chart id inside a decoded layout, which is the id this endpoint is addressed by.
 *
 * TradingView stores the drawings of each chart in a layout separately — that is what the
 * `saveload_separate_drawings_storage` feature flag on the chart page means — and addresses them
 * by the chart's own id within the layout, not by the layout id. `docs/research/chartbit-layout-format.md`
 * records a real decoded layout carrying `charts: [{ …, "chartId": "1" }]`, so the id this project
 * needed has been sitting inside a payload it already reads.
 *
 * The FIRST chart is taken, and only when the layout holds one. A multi-chart layout offers no way
 * to tell from the recorded format which chart a symbol belongs to — the symbol lives inside the
 * MainSeries state, which is not mapped — and picking one of several would be a guess presented as
 * an answer. The caller is told to pass `chart_id` themselves instead.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Walk the `content` chain to whichever level actually holds the TradingView state.
 *
 * A stored layout read live on 2026-09-01 is THREE objects deep:
 * `{id, name, resolution, symbol, content}` wraps
 * `{…, charts_symbols, content}` wraps the state carrying `charts`. Reading only the top level —
 * which is what `docs/research/chartbit-layout-format.md` documents, because it recorded the
 * innermost object alone — finds nothing on every real layout.
 *
 * Walked rather than indexed at a fixed depth: the two shapes on record differ by two levels
 * already, so hard-coding either one is how this breaks again the next time Stockbit wraps it.
 */
function layoutState(layout: unknown): Record<string, unknown> | undefined {
  let node = asRecord(layout);
  for (let depth = 0; node && depth < 8; depth++) {
    if (Array.isArray(node.charts)) return node;
    const next = asRecord(node.content);
    if (!next) return undefined;
    node = next;
  }
  return undefined;
}

/** `charts_symbols` arrives as a JSON STRING: `{"1":{"symbol":"IHSG"}}`. */
function chartSymbols(layout: unknown): Record<string, { symbol?: unknown }> | undefined {
  let node = asRecord(layout);
  for (let depth = 0; node && depth < 8; depth++) {
    const raw = node.charts_symbols;
    if (typeof raw === "string") {
      try {
        return asRecord(JSON.parse(raw)) as Record<string, { symbol?: unknown }> | undefined;
      } catch {
        return undefined;
      }
    }
    const asObject = asRecord(raw);
    if (asObject) return asObject as Record<string, { symbol?: unknown }>;
    const next = asRecord(node.content);
    if (!next) return undefined;
    node = next;
  }
  return undefined;
}

/**
 * The chart id inside a decoded layout, which is the id this endpoint is addressed by.
 *
 * TradingView stores the drawings of each chart in a layout separately — that is what the
 * `saveload_separate_drawings_storage` feature flag on the chart page means — and addresses them
 * by the chart's own id within the layout, not by the layout id. A layout read live carries
 * `charts: [{ …, "chartId": "1" }]`, so the id this project needed has been sitting inside a
 * payload it already reads.
 *
 * A layout holding SEVERAL charts is resolved by `symbol` when one is given, using the layout's own
 * `charts_symbols` map (`{"1":{"symbol":"IHSG"}}`) — the same thing the chart page uses to know
 * which chart shows what. Without a symbol, or when the map does not name one, nothing is returned
 * rather than picking a chart: each chart has its own drawing store, so guessing would answer with
 * a different chart's lines and look entirely successful doing it.
 */
export function chartIdFromLayout(layout: unknown, symbol?: string): string | undefined {
  const charts = layoutState(layout)?.charts;
  if (!Array.isArray(charts) || charts.length === 0) return undefined;

  const idOf = (chart: unknown): string | undefined => {
    const id = asRecord(chart)?.chartId;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  };

  const wanted = symbol === undefined ? undefined : normalizeSymbol(symbol);
  const symbols = chartSymbols(layout);
  /** What the layout says a chart shows, or undefined when it does not say. */
  const symbolOf = (id: string | undefined): string | undefined => {
    const named = id === undefined ? undefined : symbols?.[id]?.symbol;
    return typeof named === "string" ? normalizeDrawingSymbol(named).toUpperCase() : undefined;
  };

  if (charts.length === 1) {
    const only = idOf(charts[0]);
    const shows = symbolOf(only);
    // A single chart is NOT automatically the caller's chart. The account's real "Bandarmology"
    // layout holds one chart showing IHSG; asking it for BBRI used to derive that chart's id and
    // hand back IHSG's hand-drawn levels under `symbol: "BBRI"` — the exact confusion the
    // multi-chart branch below refuses to create, arrived at through the easy path instead.
    // Checked only when the layout actually names a symbol: the older flat shape carries no map,
    // and refusing everything on a layout that never claimed a symbol would help nobody.
    if (wanted !== undefined && shows !== undefined && shows !== wanted) return undefined;
    return only;
  }

  if (wanted !== undefined) {
    const matches = charts.map(idOf).filter((id) => id !== undefined && symbolOf(id) === wanted);
    // One match or none. Two charts on the same symbol are two different drawing stores and the
    // layout says nothing about which the caller means.
    return matches.length === 1 ? matches[0] : undefined;
  }
  return undefined;
}

/**
 * The line tools on a chart.
 *
 * ## This endpoint answered 400 to every argument this project could send
 *
 * A 2026-08-31 field report called it with no arguments, with `{symbol}`, and with `{symbol,
 * layout_id}` — a layout id taken from `chartbit_layouts`, which succeeded on the same credential
 * at the same moment — and got `400 "Silahkan Periksa permintaan"` every time. The docstring here
 * used to say all three filters were optional because "the endpoint's own client sends different
 * combinations", which was read out of the bundle and is contradicted by every call anyone has
 * made: without a chart id there is no combination that answers.
 *
 * So `chart_id` is derived rather than demanded. Given a `layoutId`, the layout is read and its
 * chart id decoded out of it, which costs one extra request and is the only way this server can
 * produce the value at all — nothing else it returns carries one. Given neither, the call is
 * refused here rather than spent on a 400 whose Indonesian text says nothing actionable.
 *
 * What is still NOT settled: whether `layout_id` + `chart_id` is the pair the endpoint wants. That
 * needs a live call, and until one is made the error says which arguments were tried.
 */
export async function getChartDrawings(query: DrawingsQuery = {}): Promise<ChartDrawings> {
  const symbol = query.symbol ? normalizeSymbol(query.symbol) : undefined;
  const key = `chartbit:drawings:${query.layoutId ?? "-"}:${query.chartId ?? "-"}:${symbol ?? "-"}`;
  return cached(key, CACHE.defaultTtlMs, async () => {
    const chartId = query.chartId ?? (query.layoutId ? await deriveChartId(query.layoutId, symbol) : undefined);
    if (!chartId) {
      throw new StockbitError(
        "invalid_param",
        query.layoutId
          ? `Chart layout ${query.layoutId} does not name one chart to read, so the drawings ` +
            `endpoint cannot be addressed from it${symbol ? ` for ${symbol}` : ""}. Pass chart_id ` +
            `explicitly. A layout holding several charts stores each one's drawings separately, ` +
            `and this happens when the layout's own symbol map names no chart for your symbol, or ` +
            `names more than one — either way, choosing for you would answer with a different ` +
            `chart's lines and look like it worked.`
          : "chartbit drawings needs a chart_id, and the only way to get one is a layout_id: pass " +
            "layout_id (from chartbit_layouts) and the chart id is decoded out of the layout. " +
            "Every call without one has answered 400, including with a valid layout_id and symbol " +
            "alone, so this is refused rather than sent.",
      );
    }
    const body = await getJson("chartbitDrawings", {
      params: { layout_id: query.layoutId, chart_id: chartId, symbol },
    });
    const parsed = parseOr(DrawingsResponse, body, "chartbit drawings");
    const content = parsed.data?.data?.content ?? parsed.data?.content ?? null;
    const { drawings, stored } = decodeDrawings(content);
    return {
      layoutId: query.layoutId,
      chartId,
      /** True when the id was decoded out of the layout rather than supplied by the caller. */
      chartIdDerived: query.chartId === undefined,
      symbol,
      drawings,
      sources: stored.sources,
      groups: stored.groups,
    };
  });
}

/**
 * Read one layout and decode its chart id.
 *
 * A decode failure comes back as `undefined` rather than throwing: the caller's next step is the
 * same either way — say what could not be produced — and a raw decode error here would replace an
 * actionable message with one about zip bytes.
 */
async function deriveChartId(layoutId: string, symbol?: string): Promise<string | undefined> {
  const layout = await getChartLayout(layoutId);
  return chartIdFromLayout(layout.layout, symbol);
}

/* ------------------------------------ templates ------------------------------------ */

const NamedListResponse = z
  .object({ data: z.union([z.array(z.record(z.unknown())), z.record(z.unknown())]).nullable().optional() })
  .passthrough();

/** Chart templates, study templates and drawing templates — three lists, one shape. */
export async function listChartbitTemplates(): Promise<{
  chartTemplates: unknown;
  studyTemplates: unknown;
  drawingTemplates: unknown;
}> {
  return cached("chartbit:templates", CACHE.keystatsTtlMs, async () => {
    // Sequential, not fanned out. Concurrent first calls on a cold session have burned this
    // project's token before: three requests race the same refresh and two of them lose.
    const chartTemplates = parseOr(NamedListResponse, await getJson("chartbitSettings"), "chart templates").data;
    const studyTemplates = parseOr(NamedListResponse, await getJson("chartbitStudies"), "study templates").data;
    const drawingTemplates = parseOr(
      NamedListResponse,
      await getJson("chartbitDrawingTemplates"),
      "drawing templates",
    ).data;
    return { chartTemplates, studyTemplates, drawingTemplates };
  });
}

/* ------------------------------------- the writes ------------------------------------- */

export interface ChartbitSaveResult {
  /** What was written: a layout id, or the drawings key. */
  target: string;
  snapshotPath?: string;
  bytesBefore: number;
  bytesAfter: number;
  verified: boolean;
  verifyError?: string;
  rolledBack?: boolean;
  rollbackVerified?: boolean;
  rollbackFailed?: string;
  /**
   * Set when the outcome is genuinely UNKNOWN: the request errored in a way that may still have
   * been applied (a timeout, a proxy 5xx). Never reported as a clean failure.
   */
  outcomeUnknown?: string;
  logged: boolean;
  at: string;
}

function invalidate(): void {
  invalidateCache("chartbit:");
}

/**
 * Save a layout's content, with the full ADR-0003 apparatus.
 *
 * Throws before sending anything if the request is not one we are willing to make. Once a write has
 * been sent, the return value DESCRIBES what happened rather than throwing — the caller needs the
 * snapshot path and the verification result even when it went wrong, and an exception would throw
 * that away.
 */
export async function saveChartLayout(options: {
  layoutId: string;
  layout: unknown;
  confirm: boolean;
  allowLossy?: boolean;
}): Promise<ChartbitSaveResult> {
  const at = new Date().toISOString();

  if (options.confirm !== true) {
    throw new StockbitError(
      "invalid_param",
      `Refusing to overwrite chart layout ${options.layoutId} without confirm: true. This replaces what the ` +
        "Stockbit account holds and cannot be undone there.",
    );
  }
  // Encoded before the lock is taken: a payload we will refuse should not make another process wait.
  const content = encodeLayoutContent(options.layout, { allowLossy: options.allowLossy });

  const release = await acquireDirLock(join(stockbitDir(), `chartbit-${options.layoutId}.lock`), {
    staleMs: WRITE_LOCK_STALE_MS,
    timeoutMs: 15_000,
    pollMs: 150,
  });
  try {
    return await performLayoutSave(options.layoutId, content, at);
  } finally {
    release?.();
  }
}

async function performLayoutSave(layoutId: string, content: string, at: string): Promise<ChartbitSaveResult> {
  let before: string;
  let snapshotPath: string;
  try {
    before = await getLayoutContentRaw(layoutId);
    snapshotPath = writeSnapshot(`chart-${layoutId}`, before, at);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logMutation({ at, target: layoutId, outcome: "aborted-no-snapshot", error: message });
    throw new StockbitError(
      "upstream",
      `Could not snapshot chart layout ${layoutId}, so the write was not attempted: ${message}`,
    );
  }

  try {
    await putJson("chartbitChartUpdate", { segments: { layoutId }, body: { content } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    invalidate();
    // The request errored — but a timeout, an abort, or a 5xx from a proxy that already forwarded
    // the request can all mean the mutation LANDED. Reporting a clean failure would be a guess.
    let landed: boolean | undefined;
    let after = "";
    try {
      after = await getLayoutContentRaw(layoutId);
      landed = after === content;
    } catch {
      landed = undefined;
    }
    if (landed === false) {
      logMutation({ at, target: layoutId, outcome: "write-failed", snapshotPath, error: message });
      throw err;
    }
    const logged = logMutation({
      at,
      target: layoutId,
      outcome: landed ? "landed-despite-error" : "outcome-unknown",
      snapshotPath,
      bytesBefore: before.length,
      bytesAfter: after.length,
      error: message,
    });
    return {
      target: layoutId,
      snapshotPath,
      bytesBefore: before.length,
      bytesAfter: after.length,
      verified: Boolean(landed),
      outcomeUnknown: landed
        ? undefined
        : `The write errored (${message}) and the layout could not be read back, so it is unknown whether it ` +
          `was applied. The previous layout is at ${snapshotPath}.`,
      logged,
      at,
    };
  }

  invalidate();

  let after = "";
  let verified = false;
  let verifyError: string | undefined;
  try {
    after = await getLayoutContentRaw(layoutId);
    verified = after === content;
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err);
  }

  if (verified) {
    const logged = logMutation({
      at,
      target: layoutId,
      outcome: "ok",
      snapshotPath,
      bytesBefore: before.length,
      bytesAfter: after.length,
    });
    return { target: layoutId, snapshotPath, bytesBefore: before.length, bytesAfter: after.length, verified: true, logged, at };
  }

  // A read-back that THREW says nothing about what the account holds. Rolling back on that basis
  // would be a second blind write, and if the first one was fine it would be the destructive one.
  if (verifyError) {
    const logged = logMutation({
      at,
      target: layoutId,
      outcome: "unverifiable",
      snapshotPath,
      bytesBefore: before.length,
      verifyError,
    });
    return {
      target: layoutId,
      snapshotPath,
      bytesBefore: before.length,
      bytesAfter: 0,
      verified: false,
      verifyError,
      outcomeUnknown:
        `The write was accepted but could not be read back (${verifyError}), so what layout ${layoutId} now ` +
        `holds is unknown. No rollback was attempted, because restoring on an unread state could overwrite a ` +
        `correct write. The previous content is at ${snapshotPath}.`,
      logged,
      at,
    };
  }

  // Nothing to undo when the account already holds the snapshot. Sending a "restore" here would be
  // a pointless write, and when `before` is empty it is a guaranteed failure.
  if (after === before) {
    const logged = logMutation({
      at,
      target: layoutId,
      outcome: "not-persisted",
      snapshotPath,
      bytesBefore: before.length,
      bytesAfter: after.length,
    });
    return {
      target: layoutId,
      snapshotPath,
      bytesBefore: before.length,
      bytesAfter: after.length,
      verified: false,
      rolledBack: true,
      rollbackVerified: true,
      outcomeUnknown:
        `Stockbit accepted the write for layout ${layoutId} and it read back unchanged, so it was not stored. ` +
        "Nothing was altered — the account still holds exactly what it did before.",
      logged,
      at,
    };
  }

  let rollbackFailed: string | undefined;
  let rollbackVerified = false;
  try {
    await putJson("chartbitChartUpdate", { segments: { layoutId }, body: { content: before } });
    invalidate();
    // The restore gets the same scrutiny as the write: a 2xx does not prove the right bytes landed,
    // which is the entire reason the verify step above exists.
    rollbackVerified = (await getLayoutContentRaw(layoutId)) === before;
  } catch (err) {
    rollbackFailed = err instanceof Error ? err.message : String(err);
  }

  const logged = logMutation({
    at,
    target: layoutId,
    outcome: rollbackFailed ? "rollback-failed" : rollbackVerified ? "rolled-back" : "rollback-unverified",
    snapshotPath,
    bytesBefore: before.length,
    bytesAfter: after.length,
    rollbackError: rollbackFailed,
  });

  return {
    target: layoutId,
    snapshotPath,
    bytesBefore: before.length,
    bytesAfter: after.length,
    verified: false,
    rolledBack: !rollbackFailed,
    rollbackVerified,
    rollbackFailed,
    logged,
    at,
  };
}

/**
 * Save a chart's drawings.
 *
 * Additive in shape but destructive in effect: the payload replaces the stored set for that chart,
 * and `deletedSources` is how Stockbit's own client removes a tool. So it carries the same
 * apparatus as the layout write, with one deliberate difference — the read-back compares the SET OF
 * KEYS rather than the bytes. Stockbit's adapter is free to re-serialise what it stored, and a byte
 * comparison against a re-serialised payload would report a correct save as a failure and then roll
 * it back, which is the one outcome worse than not saving.
 */
export async function saveChartDrawings(options: {
  layoutId: string;
  chartId: string;
  symbol?: string;
  sources: StoredSource[];
  groups?: unknown[];
  deletedSources?: Array<{ key: string; symbol?: string }>;
  confirm: boolean;
}): Promise<ChartbitSaveResult> {
  const at = new Date().toISOString();
  const target = `drawings:${options.layoutId}:${options.chartId}`;

  if (options.confirm !== true) {
    throw new StockbitError(
      "invalid_param",
      `Refusing to replace the drawings on chart ${options.chartId} without confirm: true. This overwrites what ` +
        "the user has drawn on their own chart.",
    );
  }

  const content = encodeDrawings({
    sources: options.sources,
    groups: options.groups,
    deletedSources: options.deletedSources,
  });

  const release = await acquireDirLock(join(stockbitDir(), `chartbit-drawings-${options.chartId}.lock`), {
    staleMs: WRITE_LOCK_STALE_MS,
    timeoutMs: 15_000,
    pollMs: 150,
  });
  try {
    const query = { layoutId: options.layoutId, chartId: options.chartId, symbol: options.symbol };

    let before: ChartDrawings;
    let snapshotPath: string;
    try {
      invalidate();
      before = await getChartDrawings(query);
      snapshotPath = writeSnapshot(`drawings-${options.chartId}`, JSON.stringify(before.sources), at);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logMutation({ at, target, outcome: "aborted-no-snapshot", error: message });
      throw new StockbitError(
        "upstream",
        `Could not snapshot the current drawings, so nothing was sent: ${message}`,
      );
    }

    const expected = new Set(options.sources.map((s) => s.key));

    try {
      await postJson("chartbitDrawingsSave", {
        body: { layout_id: options.layoutId, chart_id: options.chartId, content },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      invalidate();
      let landed: boolean | undefined;
      let afterCount = 0;
      try {
        const after = await getChartDrawings(query);
        afterCount = after.sources.length;
        landed = [...expected].every((key) => after.sources.some((s) => s.key === key));
      } catch {
        landed = undefined;
      }
      if (landed === false) {
        logMutation({ at, target, outcome: "write-failed", snapshotPath, error: message });
        throw err;
      }
      const logged = logMutation({
        at,
        target,
        outcome: landed ? "landed-despite-error" : "outcome-unknown",
        snapshotPath,
        bytesBefore: before.sources.length,
        bytesAfter: afterCount,
        error: message,
      });
      return {
        target,
        snapshotPath,
        bytesBefore: before.sources.length,
        bytesAfter: afterCount,
        verified: Boolean(landed),
        outcomeUnknown: landed
          ? undefined
          : `The drawings write errored (${message}) and could not be read back, so it is unknown whether it ` +
            `was applied. The previous drawings are at ${snapshotPath}.`,
        logged,
        at,
      };
    }

    invalidate();

    let verified = false;
    let verifyError: string | undefined;
    let afterCount = 0;
    try {
      const after = await getChartDrawings(query);
      afterCount = after.sources.length;
      // Keys, not bytes: Stockbit's adapter may re-serialise, and a byte comparison would roll back
      // a correct save.
      verified = [...expected].every((key) => after.sources.some((s) => s.key === key));
    } catch (err) {
      verifyError = err instanceof Error ? err.message : String(err);
    }

    const logged = logMutation({
      at,
      target,
      outcome: verified ? "ok" : verifyError ? "unverifiable" : "not-persisted",
      snapshotPath,
      bytesBefore: before.sources.length,
      bytesAfter: afterCount,
      verifyError,
    });

    return {
      target,
      snapshotPath,
      bytesBefore: before.sources.length,
      bytesAfter: afterCount,
      verified,
      verifyError,
      outcomeUnknown: verified
        ? undefined
        : verifyError
          ? `The drawings were accepted but could not be read back (${verifyError}), so the chart's state is ` +
            `unknown. The previous drawings are at ${snapshotPath}.`
          : `Stockbit accepted the drawings and reading them back did not show every one of them. The previous ` +
            `set is at ${snapshotPath}.`,
      logged,
      at,
    };
  } finally {
    release?.();
  }
}

/**
 * Delete a saved layout.
 *
 * Destructive with no undo on Stockbit's side, so the snapshot is taken first and its path is
 * returned whatever happens — it is the only copy that will exist afterwards.
 */
export async function deleteChartLayout(options: {
  layoutId: string;
  confirm: boolean;
}): Promise<{ layoutId: string; snapshotPath?: string; deleted: boolean; logged: boolean; at: string }> {
  const at = new Date().toISOString();
  if (options.confirm !== true) {
    throw new StockbitError(
      "invalid_param",
      `Refusing to delete chart layout ${options.layoutId} without confirm: true. Stockbit has no undo for this.`,
    );
  }

  let snapshotPath: string | undefined;
  try {
    snapshotPath = writeSnapshot(`chart-${options.layoutId}-deleted`, await getLayoutContentRaw(options.layoutId), at);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logMutation({ at, target: options.layoutId, outcome: "aborted-no-snapshot", error: message });
    throw new StockbitError(
      "upstream",
      `Could not snapshot layout ${options.layoutId} before deleting it, so nothing was deleted: ${message}`,
    );
  }

  await deleteJson("chartbitChartDelete", { segments: { layoutId: options.layoutId } });
  invalidate();

  const remaining = await listChartLayouts();
  const deleted = !remaining.some((row) => row.id === options.layoutId);
  const logged = logMutation({
    at,
    target: options.layoutId,
    outcome: deleted ? "deleted" : "delete-not-persisted",
    snapshotPath,
  });
  return { layoutId: options.layoutId, snapshotPath, deleted, logged, at };
}
