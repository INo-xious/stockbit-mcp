/**
 * Encoding and decoding what Stockbit stores for a Chartbit chart.
 *
 * ## Two payloads, one envelope
 *
 * A saved chart is two things stored separately — the LAYOUT (panes, studies, chart properties) and
 * the DRAWINGS (the line tools on it). TradingView's charting library persists them through
 * separate adapter methods and Stockbit's `saveload_separate_drawings_storage` feature flag keeps
 * them apart on the server too. Reading only the layout and reporting "you have drawn nothing"
 * would be wrong in a way the user could check at a glance.
 *
 * Both travel in the same envelope: `normalizeSeriesIds(JSON)` → a ZIP holding one `layout.json`,
 * deflated at level 9 → base64. That envelope lives in `src/core/zipjson.ts`, shared with the
 * account-wide chart-settings blob, and its round-trip test is what makes a read-back comparison on
 * a write path mean anything.
 *
 * ## The series-id substitution, and why it is applied here too
 *
 * Stockbit's client rewrites two generated series ids to a placeholder before saving, with an
 * unanchored global `String.replace` — see `src/core/layoutcodec.ts` for the hazard that creates
 * and the check that refuses to trigger it. Reproduced faithfully rather than improved: a
 * comparison against what the server stored has to match what their client would have sent, or
 * every verification fails for reasons that are ours rather than the user's.
 *
 * ## Reading drawings is not the same as writing them
 *
 * `decodeDrawings` projects the stored line tools into something a model can reason about —
 * a type, its points as `{time, price}`, its symbol and text. That projection is LOSSY and is for
 * reading only. `encodeDrawings` takes whole line-tool states, never projected ones, because the
 * `state` schema of a `LineToolTrendLine` is TradingView's and this project has never seen it in
 * full. Composing one from field names that looked right is exactly how a save silently corrupts a
 * user's chart; the honest scope is round-tripping what the server already gave us, and building
 * new drawings through the widget in the browser (ADR-0005), which owns that schema.
 */
import { decodeZipJson, encodeZipJson, MAX_ENCODED_CHARS } from "../core/zipjson.js";
import { corruptingLiterals, normalizeSeriesIds, SERIES_ID_PLACEHOLDER } from "../core/layoutcodec.js";
import { StockbitError } from "../http/errors.js";

export { MAX_ENCODED_CHARS } from "../core/zipjson.js";

/* --------------------------------- layout content --------------------------------- */

/**
 * Decode a stored layout blob.
 *
 * Returns `null` for an empty blob — the layout genuinely has no stored content — and throws for a
 * blob that is present but undecodable. Those are different answers and only one of them means
 * "nothing saved".
 */
export function decodeLayoutContent(encoded: string | null | undefined): unknown {
  if (!encoded) return null;
  try {
    return decodeZipJson(encoded);
  } catch (err) {
    throw new StockbitError(
      "schema_drift",
      `A stored chart layout could not be decoded: ${err instanceof Error ? err.message : String(err)}. ` +
        "It was present, so this is not an empty chart.",
    );
  }
}

/**
 * Encode a layout for saving, the way Stockbit's own client would.
 *
 * Throws when the payload contains a literal the substitution would silently rewrite outside an id
 * position. `allowLossy` accepts Stockbit's behaviour anyway, for a caller who has read the hazard
 * note and wants byte-parity with their client regardless.
 */
export function encodeLayoutContent(layout: unknown, options: { allowLossy?: boolean } = {}): string {
  const serialized = JSON.stringify(layout);
  if (serialized === undefined) {
    throw new StockbitError("invalid_param", "This layout is not serialisable, so it cannot be saved.");
  }
  if (!options.allowLossy) {
    const suspicious = corruptingLiterals(serialized).filter((id) => {
      const asId = new RegExp(`"id"\\s*:\\s*"${id}"`, "g");
      const total = (serialized.match(new RegExp(id, "g")) ?? []).length;
      const asIdCount = (serialized.match(asId) ?? []).length;
      return total > asIdCount;
    });
    if (suspicious.length > 0) {
      throw new StockbitError(
        "invalid_param",
        `Saving would corrupt this chart: ${suspicious.join(", ")} appears outside an id position and ` +
          `Stockbit rewrites it to "${SERIES_ID_PLACEHOLDER}" with an unanchored replace. ` +
          "Pass allow_lossy to send it anyway.",
      );
    }
  }
  return encodeForWire(normalizeSeriesIds(serialized));
}

/** The last two steps of the envelope, shared by layouts and drawings. */
function encodeForWire(normalizedJson: string): string {
  let value: unknown;
  try {
    value = JSON.parse(normalizedJson);
  } catch {
    throw new StockbitError("invalid_param", "Normalised content was not valid JSON, so it was not sent.");
  }
  const encoded = encodeZipJson(value);
  if (encoded.length > MAX_ENCODED_CHARS) {
    throw new StockbitError(
      "invalid_param",
      `The encoded chart is ${encoded.length} characters, past Stockbit's own ${MAX_ENCODED_CHARS}-character ` +
        "client limit. Sending it would be truncated server-side rather than rejected.",
    );
  }
  return encoded;
}

/* -------------------------------- drawings content -------------------------------- */

/**
 * One line tool as stored, before projection.
 *
 * `value` is TradingView's own state object. It is carried verbatim through every read and write in
 * this module; nothing here composes one.
 */
export interface StoredSource {
  key: string;
  value: unknown;
}

export interface StoredDrawings {
  sources: StoredSource[];
  groups: unknown[];
  /** Present on a save payload; Stockbit's client sends them to delete server-side. */
  deleted_sources?: Array<{ key: string; symbol?: string }>;
  deleted_groups?: unknown[];
}

/** A line tool, projected into something a model can read. LOSSY — never a save payload. */
export interface Drawing {
  /** TradingView's entity key. Stable across reads; the handle for deleting exactly this one. */
  key: string;
  /** The tool kind, e.g. `LineToolHorzLine`. `unknown` when the state carries no type. */
  type: string;
  /** Anchor points in chart coordinates. Empty for a tool whose points could not be read. */
  points: Array<{ time: number; price: number }>;
  /** The symbol the tool is pinned to, normalised: TradingView stores `IDX:BBRI`. */
  symbol?: string;
  text?: string;
  color?: string;
  /** Everything the projection did not name, so an unmapped field is visible rather than lost. */
  raw?: unknown;
}

/** `IDX:BBRI` → `BBRI`. Stockbit's own client does this before comparing. */
export function normalizeDrawingSymbol(symbol: string): string {
  const colon = symbol.lastIndexOf(":");
  return colon >= 0 ? symbol.slice(colon + 1) : symbol;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function projectPoints(state: Record<string, unknown> | undefined): Array<{ time: number; price: number }> {
  const points = state?.points;
  if (!Array.isArray(points)) return [];
  return points
    .map((point) => {
      const p = asRecord(point);
      // TradingView uses `time_t` in serialized state and `time` in the live API. Accept both
      // rather than picking one and returning an empty anchor for the other.
      const time = p?.time_t ?? p?.time;
      const price = p?.price ?? p?.value;
      return typeof time === "number" && typeof price === "number" ? { time, price } : null;
    })
    .filter((p): p is { time: number; price: number } => p !== null);
}

/**
 * Project the stored drawings into readable line tools.
 *
 * `content` may arrive already-decoded (the GET appears to answer with plain JSON) or as the
 * base64-ZIP the POST takes. Both are accepted because which one comes back is a wire fact that has
 * not been confirmed on this account, and guessing wrong would report a chart full of drawings as
 * empty. A string that is neither JSON nor a decodable archive throws.
 */
export function decodeDrawings(content: unknown): { drawings: Drawing[]; stored: StoredDrawings } {
  const decoded = typeof content === "string" ? decodeDrawingsString(content) : content;
  const record = asRecord(decoded);
  const sources = Array.isArray(record?.sources) ? (record!.sources as StoredSource[]) : [];
  const groups = Array.isArray(record?.groups) ? (record!.groups as unknown[]) : [];

  const drawings = sources.map((source): Drawing => {
    const value = asRecord(source?.value);
    const state = asRecord(value?.state);
    const symbol = typeof value?.symbol === "string" ? normalizeDrawingSymbol(value.symbol) : undefined;
    const text = typeof state?.text === "string" ? state.text : undefined;
    const color =
      typeof state?.linecolor === "string"
        ? state.linecolor
        : typeof state?.color === "string"
          ? state.color
          : undefined;
    return {
      key: typeof source?.key === "string" ? source.key : "",
      type: typeof value?.type === "string" ? value.type : "unknown",
      points: projectPoints(state),
      ...(symbol ? { symbol } : {}),
      ...(text ? { text } : {}),
      ...(color ? { color } : {}),
      raw: value ?? source?.value,
    };
  });

  return { drawings, stored: { sources, groups } };
}

/** Decode a drawings `content` string, accepting either plain JSON or the base64-ZIP envelope. */
function decodeDrawingsString(content: string): unknown {
  if (!content) return { sources: [], groups: [] };
  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new StockbitError("schema_drift", "Stored drawings looked like JSON but did not parse.");
    }
  }
  try {
    return decodeZipJson(trimmed);
  } catch (err) {
    throw new StockbitError(
      "schema_drift",
      `Stored drawings could not be decoded as JSON or as a ZIP archive: ` +
        `${err instanceof Error ? err.message : String(err)}. They were present, so this chart is not empty.`,
    );
  }
}

/**
 * Build the `content` value for a drawings save.
 *
 * Takes whole stored sources, never projected `Drawing`s — see the module note. Every `value` it
 * sends came off a read of this account's own chart, or out of the browser widget that owns the
 * schema.
 */
export function encodeDrawings(payload: {
  sources: StoredSource[];
  groups?: unknown[];
  deletedSources?: Array<{ key: string; symbol?: string }>;
  deletedGroups?: unknown[];
}): string {
  const body: StoredDrawings = {
    sources: payload.sources,
    groups: payload.groups ?? [],
    deleted_sources: payload.deletedSources ?? [],
    deleted_groups: payload.deletedGroups ?? [],
  };
  const serialized = JSON.stringify(body);
  if (serialized === undefined) {
    throw new StockbitError("invalid_param", "These drawings are not serialisable, so nothing was sent.");
  }
  return encodeForWire(normalizeSeriesIds(serialized));
}
