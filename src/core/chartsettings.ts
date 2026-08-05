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
 * A minimal ZIP reader rather than a dependency: the archive has one deflate entry, and the parts of
 * the format that make general unzipping hard — multi-entry central directories, ZIP64, encryption —
 * are not present. It reads the central directory rather than scanning local headers, because a
 * local header may carry sizes of 0 with the real values in a trailing data descriptor.
 */
import { inflateRawSync } from "node:zlib";
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";

const SettingsResponse = z
  .object({ data: z.object({ content: z.string().optional() }).passthrough() })
  .passthrough();

/** End-of-central-directory signature, searched from the tail. */
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;

export interface ZipEntry {
  name: string;
  text: string;
}

/**
 * Read every entry of a single-disk ZIP.
 *
 * Throws rather than returning partial results: a chart configuration decoded from half an archive
 * is worse than an error, because it looks like a configuration.
 */
export function readZip(buffer: Buffer): ZipEntry[] {
  // The EOCD is at the end, after a comment of unknown length, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(offset) !== CENTRAL) throw new Error(`corrupt ZIP: bad central header at ${offset}`);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");

    // Sizes come from the central directory; the local header's may be zero with the real values in
    // a trailing data descriptor. Its variable-length fields still have to be skipped, and they can
    // differ from the central ones.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method !== 0 && method !== 8) throw new Error(`unsupported ZIP compression method ${method} for ${name}`);
    entries.push({ name, text: (method === 8 ? inflateRawSync(data) : data).toString("utf8") });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

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
