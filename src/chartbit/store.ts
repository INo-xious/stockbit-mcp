/**
 * A local record of the drawings THIS project put on a chart.
 *
 * ## Why a local file and not just the chart
 *
 * `clear ours` has to be exact. The chart holds the user's own hand-drawn work next to whatever an
 * agent added, and TradingView's entity ids are the only handle that distinguishes them — but they
 * are assigned by the widget at creation time and are not derivable from the annotation afterwards.
 * Without a record, "remove what we drew" degrades into "remove everything that looks like ours",
 * which is a heuristic operating on someone's analysis. So each created entity id is written down
 * with what it was, and removal works from that list.
 *
 * The same record is what lets a later call re-apply a set of levels without duplicating them.
 *
 * ## What it is not
 *
 * Not a cache of the chart's state. The chart is the truth; this is a note of what we contributed.
 * A stale id (the user deleted our line by hand) is expected, and removal reports it as missing
 * rather than failing — a note that has fallen out of date must not block the operation it
 * describes.
 *
 * Written atomically for the reason `src/alerts/store.ts` is: several copies of this server run at
 * once, and a truncating write that loses a race leaves a file that parses as nothing — which would
 * read as "we have drawn nothing", silently.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { normalizeSymbol } from "../symbol.js";

function storeDir(): string {
  return join(process.env.STOCKBIT_STORE_DIR || join(homedir(), ".stockbit"), "chartbit-drawings");
}

function storePath(symbol: string): string {
  return join(storeDir(), `${symbol}.json`);
}

export interface OurDrawing {
  /** TradingView's entity id, as returned by `createShape`. The handle for removing exactly this one. */
  tvEntityId: string;
  /** Which annotation produced it. */
  kind: string;
  label?: string;
  /** The shape name sent to the library, for diagnosis when a drawing does not appear. */
  shape: string;
  /** ISO timestamp. */
  at: string;
  /** Server-side ids, once a save has told us which layout and chart the drawing landed on. */
  layoutId?: string;
  chartId?: string;
}

interface DrawingsFile {
  version: 1;
  symbol: string;
  drawings: OurDrawing[];
}

/** Everything this project has drawn on one symbol's chart, as far as it knows. */
export function loadOurDrawings(symbolInput: string): OurDrawing[] {
  const symbol = normalizeSymbol(symbolInput);
  const path = storePath(symbol);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DrawingsFile;
    return Array.isArray(parsed?.drawings) ? parsed.drawings : [];
  } catch {
    // A mangled file yields nothing rather than throwing: the chart is still the truth, and taking
    // down the drawing tool over a corrupt note would be the wrong trade. It is left in place so it
    // can be inspected.
    return [];
  }
}

function write(symbol: string, drawings: OurDrawing[]): void {
  mkdirSync(storeDir(), { recursive: true, mode: 0o700 });
  const target = storePath(symbol);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const body: DrawingsFile = { version: 1, symbol, drawings };
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Record newly created drawings, keeping what was already there. */
export function addOurDrawings(symbolInput: string, added: OurDrawing[]): OurDrawing[] {
  const symbol = normalizeSymbol(symbolInput);
  const existing = loadOurDrawings(symbol);
  const merged = [...existing, ...added.filter((d) => !existing.some((e) => e.tvEntityId === d.tvEntityId))];
  write(symbol, merged);
  return merged;
}

/** Replace the record wholesale — what `drawAnnotations({replace: true})` does after clearing. */
export function setOurDrawings(symbolInput: string, drawings: OurDrawing[]): void {
  write(normalizeSymbol(symbolInput), drawings);
}

/** Forget specific entity ids, and report what is left. */
export function forgetOurDrawings(symbolInput: string, entityIds: string[]): OurDrawing[] {
  const symbol = normalizeSymbol(symbolInput);
  const remaining = loadOurDrawings(symbol).filter((d) => !entityIds.includes(d.tvEntityId));
  write(symbol, remaining);
  return remaining;
}

/** Attach the server-side ids to everything recorded for a symbol, once a save reveals them. */
export function noteServerIds(symbolInput: string, ids: { layoutId?: string; chartId?: string }): void {
  const symbol = normalizeSymbol(symbolInput);
  const drawings = loadOurDrawings(symbol).map((d) => ({ ...d, ...ids }));
  if (drawings.length) write(symbol, drawings);
}
