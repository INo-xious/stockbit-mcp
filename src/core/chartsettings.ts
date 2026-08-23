/**
 * The user's saved chart configuration — where Stockbit actually keeps it.
 *
 * ## How this was found, and why it matters
 *
 * `GET /chartbit/{symbol}/layout` is the obvious place a saved chart would live, and on this account
 * it is empty for every symbol. `POST` to it answers 200 (`"Retrieved Save Layout"`) and stores
 * nothing — measured with raw JSON, a plain string, and a base64 ZIP, while any other body field is
 * rejected with 400, so `{content}` is definitively the schema and the endpoint simply discards it.
 *
 * The chart configuration is somewhere else entirely: `GET /user-setting/configurations` with
 * `user_setting_type=1`, whose `content` is **base64 of a ZIP containing a single `layout.json`**.
 * On this account that is ~12KB of real TradingView settings — theme, chart properties, drawing
 * toolbar state, the last-used resolution.
 *
 * That is the difference between a chart's *properties* and its *layout*: TradingView's charting
 * library persists them through separate adapter methods, and Stockbit stores them in separate
 * places. Reading the wrong one and reporting "you have no chart configuration" would be wrong in a
 * way the user could not check.
 *
 * ## Decoding
 *
 * The envelope — base64 of a ZIP holding a single `layout.json` — is shared with Chartbit layouts
 * and drawings, so the reader lives in `src/core/zipjson.ts` and is re-exported here for the
 * callers (and the test) that found it at this path first.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { readZip } from "./zipjson.js";

export { readZip, type ZipEntry } from "./zipjson.js";

const SettingsResponse = z
  .object({ data: z.object({ content: z.string().optional() }).passthrough() })
  .passthrough();

export interface ChartSettings {
  /** False when the account has never saved chart settings. */
  hasSettings: boolean;
  /** Bytes of the stored (base64) blob. */
  encodedLength: number;
  /** Names of the files inside the archive. */
  files: string[];
  /** The decoded settings object, when `layout.json` was present and parsed. */
  settings: Record<string, unknown> | null;
  /** A readable digest of the settings a user would recognise. */
  summary: {
    theme?: unknown;
    lastResolution?: unknown;
    drawingToolbarVisible?: unknown;
    /** How many distinct settings keys are stored. */
    keys: number;
  };
  /** Set when the blob was present but could not be decoded — never silently reported as absent. */
  decodeError?: string;
}

/**
 * Read the saved chart configuration.
 *
 * A decode failure is reported rather than folded into "no settings": those are different answers,
 * and only one of them means the user has nothing saved.
 */
export async function getChartSettings(): Promise<ChartSettings> {
  const body = await cached("chartsettings", CACHE.brokerSummaryTtlMs, () =>
    getJson("userSettings", { params: { user_setting_type: "1" } }),
  );
  const content = parseOr(SettingsResponse, body, "chart settings").data.content ?? "";

  if (!content) {
    return { hasSettings: false, encodedLength: 0, files: [], settings: null, summary: { keys: 0 } };
  }

  try {
    const entries = readZip(Buffer.from(content, "base64"));
    const layout = entries.find((e) => e.name === "layout.json") ?? entries[0];
    const settings = layout ? (JSON.parse(layout.text) as Record<string, unknown>) : null;
    return {
      hasSettings: true,
      encodedLength: content.length,
      files: entries.map((e) => e.name),
      settings,
      summary: {
        theme: settings?.["current_theme.name"],
        lastResolution: settings?.["chart.lastUsedTimeBasedResolution"],
        drawingToolbarVisible: settings?.["ChartDrawingToolbarWidget.visible"],
        keys: settings ? Object.keys(settings).length : 0,
      },
    };
  } catch (err) {
    return {
      hasSettings: true,
      encodedLength: content.length,
      files: [],
      settings: null,
      summary: { keys: 0 },
      decodeError: err instanceof Error ? err.message : String(err),
    };
  }
}
