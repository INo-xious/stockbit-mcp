/**
 * Chartbit tools: reading the user's saved charts, and drawing on the real one.
 *
 * Two halves with different mechanics and different risks, and the tool descriptions say which is
 * which, because a caller that cannot tell them apart will use the wrong one:
 *
 *   - REST (`chartbit_layouts`, `chartbit_layout`, `chartbit_drawings`, `chartbit_templates`) reads
 *     what Stockbit has stored. No browser, works headless, and shows what is SAVED.
 *   - The driver (`chartbit_open`, `chartbit_draw`, `chartbit_analyze`, `chartbit_clear`,
 *     `chartbit_screenshot`, `chartbit_save`, `chartbit_shapes`) works the chart page in the user's
 *     own logged-in browser and shows what is ON SCREEN.
 *
 * Those can differ, and the difference is not a bug: a drawing exists on the chart the moment it is
 * made and reaches the server when the page's autosave fires or `chartbit_save` asks it to.
 */
import { z } from "zod";
import * as api from "../chartbit/api.js";
import * as driver from "../chartbit/driver.js";
import { STUDY_NAMES } from "../chartbit/shapes.js";
import { CHART_TYPE_NAMES } from "../chartbit/driver.js";
import { channel, fitTrendLines, geometryToAnnotations, levelsWithAnchors } from "../analysis/geometry.js";
import { getBars } from "../core/bars.js";
import { runImageTool, runTool } from "./_format.js";
import { writeChartPng } from "../render/write.js";
import type { Definer } from "./_define.js";

/** Display cap for a stored blob. A byte-exact read is a different, uncached accessor. */
const LAYOUT_PREVIEW_BYTES = 4_000;

export function registerChartbitTools(define: Definer): void {
  /* ---------------------------------- REST reads ---------------------------------- */

  define.read(
    "chartbit_layouts",
    "List the chart layouts saved on the Stockbit account: id, name, symbol, resolution and when " +
      "each was last saved.\n" +
      "This is what Stockbit has STORED. What is currently on screen in the user's browser can " +
      "differ — a drawing reaches the server when the page autosaves or `chartbit_save` asks it to.\n" +
      "An empty list means no layout has ever been saved on this account, not that charting is " +
      "unavailable.",
    {},
    async () => runTool(async () => ({ layouts: await api.listChartLayouts() })),
  );

  define.read(
    "chartbit_layout",
    "Read one saved chart layout by id: its panes, studies and chart properties, decoded.\n" +
      "TRUNCATED for display above " +
      LAYOUT_PREVIEW_BYTES +
      " bytes of encoded content; the full value is only used internally by the save path, which " +
      "reads it byte-exactly. Do not reconstruct a layout from what this returns and then save it.\n" +
      "`decodeError` means the account holds something this server could not read. That is NOT an " +
      "empty chart, and reporting it as one would be wrong in a way the user can check at a glance.",
    { layout_id: z.string().describe("Layout id from chartbit_layouts") },
    async (a) =>
      runTool(async () => {
        const layout = await api.getChartLayout(a.layout_id as string);
        const truncated = layout.encodedLength > LAYOUT_PREVIEW_BYTES;
        return {
          ...layout,
          layout: truncated ? undefined : layout.layout,
          truncated,
          truncatedNote: truncated
            ? `The stored layout is ${layout.encodedLength} encoded bytes and is omitted here rather than ` +
              "shown in part. A partial layout that looked whole is the failure this avoids."
            : undefined,
        };
      }),
  );

  define.read(
    "chartbit_drawings",
    "What the user has actually DRAWN on a chart, as stored by Stockbit: each line tool with its " +
      "type, its anchor points as {time, price}, and its text.\n" +
      "This is analysis context. Levels the user drew by hand are a statement about what they think " +
      "matters, and reading them before offering an opinion is the difference between advice and " +
      "noise.\n" +
      "All three filters are optional; passing none returns what the account has for the default " +
      "chart. Times are UNIX seconds. An empty list means nothing is saved for that chart.",
    {
      symbol: z.string().optional().describe("IDX ticker, e.g. BBRI"),
      layout_id: z.string().optional().describe("Layout id from chartbit_layouts"),
      chart_id: z.string().optional().describe("Chart id within the layout"),
    },
    async (a) =>
      runTool(async () => {
        const result = await api.getChartDrawings({
          symbol: a.symbol as string | undefined,
          layoutId: a.layout_id as string | undefined,
          chartId: a.chart_id as string | undefined,
        });
        // The raw stored sources are omitted from the tool result: they are TradingView state
        // objects, several KB each, and a caller has no use for them. The write path reads them
        // itself.
        return {
          symbol: result.symbol,
          layoutId: result.layoutId,
          chartId: result.chartId,
          count: result.drawings.length,
          drawings: result.drawings.map(({ raw: _raw, ...drawing }) => drawing),
        };
      }),
  );

  define.read(
    "chartbit_templates",
    "The saved chart, study and drawing templates on the account — the named presets the user has " +
      "made in Stockbit's own chart UI.\n" +
      "Read-only. Useful for knowing what the user has set up before suggesting they configure " +
      "something they already have.",
    {},
    async () => runTool(() => api.listChartbitTemplates()),
  );

  /* ---------------------------------- REST writes ---------------------------------- */

  define.write(
    "chartbit_layout_save",
    "REPLACE a saved chart layout on the Stockbit account. This OVERWRITES — Stockbit does not " +
      "merge, version, or offer an undo.\n" +
      "Requires `confirm: true` on every call. Do NOT set it on the user's behalf: ask them, in " +
      "plain words, naming the layout that will be replaced, and pass it only after they agree to " +
      "that specific write.\n" +
      "Before writing it snapshots the current content to disk, and after writing it reads back and " +
      "compares. If they differ it restores the snapshot and reports that it did. Every attempt is " +
      "appended to a mutation log.\n" +
      "SCOPE: this persists a layout obtained from `chartbit_layout` (optionally modified). It " +
      "cannot compose new drawings — use `chartbit_draw`, which works through the chart's own widget " +
      "and lets Stockbit's save adapter do the encoding.\n" +
      "`verified: false` means the account may not hold what you intended; read `rolledBack` and " +
      "tell the user plainly rather than reporting success.",
    {
      layout_id: z.string().describe("Layout id whose content will be REPLACED"),
      layout: z.unknown().describe("The layout object to persist, normally from chartbit_layout"),
      confirm: z.boolean().describe("Must be true. The user must have agreed to this specific write."),
      allow_lossy: z
        .boolean()
        .optional()
        .describe("Accept Stockbit's series-id substitution rewriting content that is not an id. Default false."),
    },
    async (a) =>
      runTool(async () => {
        const result = await api.saveChartLayout({
          layoutId: a.layout_id as string,
          layout: a.layout,
          confirm: a.confirm as boolean,
          allowLossy: a.allow_lossy as boolean | undefined,
        });
        return { ...result, ...describeSave(result) };
      }),
  );

  define.write(
    "chartbit_drawings_save",
    "REPLACE the drawings stored for a chart. Overwrites the stored set for that chart.\n" +
      "Requires `confirm: true`. Snapshots first, verifies by reading back, and logs the attempt.\n" +
      "The `sources` you pass must be line-tool states that came OUT of `chartbit_drawings` for this " +
      "account, or out of the chart widget itself. Do not compose one: TradingView's line-tool schema " +
      "is the library's, and a state object built from field names that looked right is how a save " +
      "silently corrupts someone's chart. To create NEW drawings use `chartbit_draw`.",
    {
      layout_id: z.string().describe("Layout id"),
      chart_id: z.string().describe("Chart id within the layout"),
      symbol: z.string().optional().describe("IDX ticker, for the read-back"),
      sources: z
        .array(z.object({ key: z.string(), value: z.unknown() }))
        .describe("Line-tool states, exactly as read from chartbit_drawings"),
      deleted_keys: z.array(z.string()).optional().describe("Keys of drawings to remove server-side"),
      confirm: z.boolean().describe("Must be true. The user must have agreed to this specific write."),
    },
    async (a) =>
      runTool(async () => {
        const result = await api.saveChartDrawings({
          layoutId: a.layout_id as string,
          chartId: a.chart_id as string,
          symbol: a.symbol as string | undefined,
          sources: a.sources as Array<{ key: string; value: unknown }>,
          deletedSources: ((a.deleted_keys as string[] | undefined) ?? []).map((key) => ({ key })),
          confirm: a.confirm as boolean,
        });
        return { ...result, ...describeSave(result) };
      }),
  );

  define.write(
    "chartbit_layout_delete",
    "DELETE a saved chart layout. Stockbit has no undo for this.\n" +
      "Requires `confirm: true`. The layout's content is snapshotted to disk first, and the snapshot " +
      "path is returned — after this runs, that file is the only copy that exists.",
    {
      layout_id: z.string().describe("Layout id to delete"),
      confirm: z.boolean().describe("Must be true. The user must have agreed to deleting this layout."),
    },
    async (a) =>
      runTool(() =>
        api.deleteChartLayout({ layoutId: a.layout_id as string, confirm: a.confirm as boolean }),
      ),
    { destructiveHint: true, idempotentHint: true },
  );

  /* --------------------------------- the live chart --------------------------------- */

  define.read(
    "chartbit_open",
    "Open a symbol's Chartbit page in the user's own logged-in browser, and optionally set the " +
      "timeframe or chart type.\n" +
      "This drives a REAL browser window the user can see. It needs `stockbit-auth login` to have " +
      "run, because a Chromium profile only holds a session in the browser that created it — a " +
      "signed-out Stockbit chart renders a blank white page rather than a login prompt, so a wrong " +
      "browser looks like a broken feature.\n" +
      "Reuses the tab that is already showing that symbol rather than opening another.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      resolution: z
        .string()
        .optional()
        .describe('Chart resolution as the widget names it: "1D", "1W", "60" for hourly'),
      chart_type: z.enum(CHART_TYPE_NAMES as [string, ...string[]]).optional().describe("Chart style"),
      headless: z.boolean().optional().describe("Run without a visible window. Cloudflare often blanks headless."),
    },
    async (a) =>
      runTool(() =>
        driver.openChart({
          symbol: a.symbol as string,
          resolution: a.resolution as string | undefined,
          chartType: a.chart_type as driver.ChartTypeName | undefined,
          headless: a.headless as boolean | undefined,
        }),
      ),
  );

  define.write(
    "chartbit_draw",
    "Draw levels, zones, trend lines, channels and markers on the user's REAL Stockbit chart.\n" +
      "No `confirm` is required, and that is deliberate: a drawing is additive, immediately visible, " +
      "and undoable in the user's own chart with ctrl-Z or `chartbit_clear`. Requiring confirmation " +
      "here would train a caller to pass it reflexively, which is what devalues it on the operations " +
      "that can actually lose something.\n" +
      "`anchor_date` is the date tools without a time of their own are pinned to — normally the most " +
      "recent bar. `replace: true` removes THIS server's previous drawings on that symbol first; it " +
      "never touches anything the user drew.\n" +
      "Drawings persist when Stockbit's page autosaves, or immediately if you call `chartbit_save`.\n" +
      "`failed` lists requests the widget accepted but created nothing for — those are NOT on the " +
      "chart, so do not report them to the user as drawn.\n" +
      "`ours` is everything this server has recorded drawing on this symbol, and each entry carries " +
      "`presence`: \"on-chart\" if the live chart still holds it, \"gone\" if it does not, and " +
      "\"unconfirmed\" if the chart could not be enumerated. `onChart` counts the confirmed ones and " +
      "`gone` lists the rest — a drawing can disappear because the page reloaded before a save, or " +
      "because the user deleted it, and neither is an error. Report `onChart`, never `ours.length`.\n" +
      "Entries are never removed by this check: the record is the only thing distinguishing this " +
      "server's drawings from the user's own, so a single bad reading must not be able to destroy it.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      annotations: z
        .array(z.record(z.unknown()))
        .describe(
          'Annotations: {kind:"level",price,label?} | {kind:"zone",from,to,label?} | ' +
            '{kind:"trend",from_date,from_price,to_date,to_price,label?} | ' +
            '{kind:"marker",date,price?,label,above?} | ' +
            '{kind:"channel",from_date,from_price,to_date,to_price,offset,label?} | ' +
            '{kind:"vline",date,label?} | ' +
            '{kind:"fib",from_date,from_price,to_date,to_price,label?} — from/to are the START and ' +
            'END of the move being retraced (swing low then swing high for an up-move); the tool ' +
            'derives its own levels. ' +
            'This is the SAME shape price_chart takes, so an array can be drawn locally to check ' +
            'the geometry and then passed here unchanged. The camelCase spelling (fromDate, ' +
            'fromPrice, toDate, toPrice) is also accepted; passing both spellings of one coordinate ' +
            'with different values is an error rather than a silent choice between them.',
        ),
      anchor_date: z.string().describe("YYYY-MM-DD to anchor time-less tools to, normally the latest bar"),
      replace: z.boolean().optional().describe("Remove this server's previous drawings on this symbol first"),
      headless: z.boolean().optional(),
    },
    async (a) =>
      runTool(() =>
        driver.drawAnnotations({
          symbol: a.symbol as string,
          annotations: a.annotations as never,
          anchorDate: a.anchor_date as string,
          replace: a.replace as boolean | undefined,
          headless: a.headless as boolean | undefined,
        }),
      ),
    // Additive and reversible in the user's own UI, so not destructive — saying otherwise would be
    // inaccurate, and an annotation nobody believes is worse than none.
    { destructiveHint: false, idempotentHint: false },
  );

  define.write(
    "chartbit_clear",
    "Remove drawings from the user's real chart.\n" +
      'scope "ours" removes only what this server drew, working from a local record of the entity ' +
      "ids it created — it cannot touch the user's own work, and needs no confirmation.\n" +
      'scope "all" removes EVERYTHING on the chart, including analysis the user drew by hand that ' +
      "this server has never seen and cannot restore. It requires `confirm: true`.\n" +
      "`alreadyGone` lists drawings this server had recorded that the chart no longer has — normally " +
      "because the user deleted them, which is not an error.",
    {
      symbol: z.string().describe("IDX ticker"),
      scope: z.enum(["ours", "all"]).describe('"ours" is safe; "all" deletes the user\'s own drawings too'),
      confirm: z.boolean().optional().describe('Required for scope "all"'),
      headless: z.boolean().optional(),
    },
    async (a) =>
      runTool(() =>
        driver.clearDrawings({
          symbol: a.symbol as string,
          scope: a.scope as "ours" | "all",
          confirm: a.confirm as boolean | undefined,
          headless: a.headless as boolean | undefined,
        }),
      ),
  );

  define.read(
    "chartbit_shapes",
    "Every drawing currently on the user's chart, with the ones this server created marked `ours`.\n" +
      "The LIVE view, read out of the chart widget — `chartbit_drawings` reads what is SAVED. If they " +
      "differ, the chart has unsaved changes.\n" +
      "`kind` narrows to one annotation kind and `ours_only` to this server's drawings; a chart with " +
      "many shapes otherwise returns a very long list. An unrecognised `kind` is an error rather than " +
      "a filter that quietly matches everything.",
    {
      symbol: z.string().describe("IDX ticker"),
      kind: z
        .string()
        .optional()
        .describe("Only this kind: level | zone | trend | fib | channel | vline | marker. Omit for all."),
      ours_only: z.boolean().optional().describe("Only the drawings this server made"),
      headless: z.boolean().optional(),
    },
    async (a) =>
      runTool(() =>
        driver.listShapes({
          symbol: a.symbol as string,
          kind: a.kind as string | undefined,
          oursOnly: a.ours_only as boolean | undefined,
          headless: a.headless as boolean | undefined,
        }),
      ),
  );

  define.read(
    "chartbit_screenshot",
    "A PNG of the user's chart exactly as it looks right now, including their own drawings, studies " +
      "and theme.\n" +
      "This is Stockbit's real chart, not a rendering — use it to show the user what a change did, " +
      "or to read a chart whose configuration this server cannot otherwise see.",
    { symbol: z.string().describe("IDX ticker"), headless: z.boolean().optional() },
    async (a) =>
      runImageTool(async () => {
        const shot = await driver.screenshotChart({
          symbol: a.symbol as string,
          headless: a.headless as boolean | undefined,
        });
        const path = writeChartPng(shot.symbol, shot.base64);
        return {
          base64: shot.base64,
          mimeType: "image/png",
          summary: { symbol: shot.symbol, path, notes: shot.notes },
        };
      }),
  );

  define.write(
    "chartbit_save",
    "Ask Stockbit to persist the chart now, rather than waiting for its autosave, then check over " +
      "the API that it did.\n" +
      "`saved` is what the page's own save adapter reported; `verifiedDrawings` is how many drawings " +
      "a fresh read of the account found afterwards. A `null` there means the check could not be " +
      "made — which is NOT the same as nothing being saved, and must not be reported as such.",
    {
      symbol: z.string().describe("IDX ticker"),
      layout_id: z.string().optional().describe("Layout id, to scope the verification read"),
      chart_id: z.string().optional().describe("Chart id, to scope the verification read"),
      headless: z.boolean().optional(),
    },
    async (a) =>
      runTool(() =>
        driver.saveChart({
          symbol: a.symbol as string,
          layoutId: a.layout_id as string | undefined,
          chartId: a.chart_id as string | undefined,
          headless: a.headless as boolean | undefined,
        }),
      ),
    { destructiveHint: false, idempotentHint: true },
  );

  define.write(
    "chartbit_study",
    "Add an indicator to the user's real chart.\n" +
      "Only the studies named in the schema can be added: `createStudy` takes a name that goes " +
      "straight into the charting library, and an unrecognised one is a silent no-op there — a " +
      "caller asking for a misspelt indicator would be told it worked.",
    {
      symbol: z.string().describe("IDX ticker"),
      study: z.enum(STUDY_NAMES as [string, ...string[]]).describe("Indicator to add"),
      headless: z.boolean().optional(),
    },
    async (a) =>
      runTool(() =>
        driver.addStudy({
          symbol: a.symbol as string,
          study: a.study as string,
          headless: a.headless as boolean | undefined,
        }),
      ),
    { destructiveHint: false, idempotentHint: false },
  );

  /* ------------------------------------ analysis ------------------------------------ */

  define.write(
    "chartbit_analyze",
    "Find the structure in a symbol's price history — support and resistance with the dates they " +
      "were tested, trend lines with how many pivots they actually touch, and a channel if there is " +
      "one — and optionally draw all of it on the user's real chart.\n" +
      "A trend line here is not a forecast. It is reported with its touch count and fit, and a line " +
      "price has closed decisively through is discarded rather than shown, because broken support " +
      "drawn as support is worse than no line.\n" +
      "With `draw: false` (the default) this reads and computes only — no browser opens.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce.number().optional().describe("How many daily bars to analyse (default 250)"),
      lookback: z.coerce.number().optional().describe("Pivot lookback in bars (default 5)"),
      min_touches: z.coerce.number().optional().describe("Reject trend lines with fewer touches (default 3)"),
      draw: z.boolean().optional().describe("Draw the result on the user's real Stockbit chart"),
      replace: z.boolean().optional().describe("When drawing, remove this server's previous drawings first"),
      headless: z.boolean().optional(),
    },
    async (a) =>
      runTool(async () => {
        const series = await getBars({ symbol: a.symbol as string, bars: (a.bars as number) ?? 250 });
        const bars = series.bars;
        if (bars.length === 0) {
          return { symbol: series.symbol, bars: 0, note: "No price history was returned, so there is nothing to fit." };
        }
        const lookback = (a.lookback as number) ?? 5;
        const options = { lookback, minTouches: (a.min_touches as number) ?? 3 };
        const anchoredLevels = levelsWithAnchors(bars, lookback);
        const trendLines = fitTrendLines(bars, options);
        const found = channel(bars, options);
        const annotations = geometryToAnnotations({ levels: anchoredLevels.slice(0, 6), trendLines, channel: found });

        const geometry = {
          symbol: series.symbol,
          bars: bars.length,
          from: bars[0].date,
          to: bars[bars.length - 1].date,
          lastClose: bars[bars.length - 1].close,
          levels: anchoredLevels,
          trendLines,
          channel: found,
        };

        if (!a.draw) return { ...geometry, drawn: false };

        const drawn = await driver.drawAnnotations({
          symbol: series.symbol,
          annotations,
          anchorDate: bars[bars.length - 1].date,
          replace: a.replace as boolean | undefined,
          headless: a.headless as boolean | undefined,
        });
        return { ...geometry, drawn: true, draw: drawn };
      }),
    { destructiveHint: false, idempotentHint: false },
  );
}

/**
 * A prose sentence per outcome branch, so a caller relaying this to the user repeats the right
 * amount of confidence.
 *
 * The branches are not interchangeable: "restored" is claimed only when the restore was read back
 * and confirmed, and anything less says so.
 */
function describeSave(result: api.ChartbitSaveResult): { message: string; mutationLog?: string; auditGap?: string } {
  const message = result.outcomeUnknown
    ? result.outcomeUnknown
    : result.verified
      ? `${result.target} was replaced and verified (${result.bytesBefore} before, ${result.bytesAfter} after). ` +
        `Previous state saved to ${result.snapshotPath}.`
      : result.rollbackFailed
        ? `The write to ${result.target} did not verify AND the rollback failed (${result.rollbackFailed}). ` +
          `The account may be in an unexpected state — the previous state is at ${result.snapshotPath}.`
        : result.rollbackVerified
          ? `The write to ${result.target} did not verify. The previous state was restored and confirmed. ` +
            "Nothing was left changed."
          : `The write to ${result.target} did not verify. A restore was sent but could NOT be confirmed by ` +
            `reading it back, so the account's state is uncertain — the previous state is at ${result.snapshotPath}.`;

  return {
    message,
    mutationLog: result.logged ? api.chartbitLogPath() : undefined,
    auditGap: result.logged ? undefined : "The mutation could not be written to the audit log.",
  };
}
