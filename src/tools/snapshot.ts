/**
 * The tool surface as six fields per tool, rendered identically for the generator and the test.
 *
 * `scripts/gen-surface-snapshot.ts` writes what this returns; `test/surface-snapshot.test.ts`
 * compares it to what is committed. Both call THIS function rather than each building their own
 * projection, because a snapshot whose writer and reader sort or serialise differently fails on a
 * machine rather than on a change — and a test that fails for reasons unrelated to the code is a
 * test people learn to re-run instead of read.
 *
 * The same argument applies to the comparator below: `localeCompare` is ICU- and locale-dependent,
 * and CI runs three operating systems. A plain code-unit comparison is the same everywhere.
 */
import { describeSurface } from "./surface.js";
import type { Evidence, Family } from "./_define.js";

/** One tool, reduced to the facts that must not change by accident. */
export interface SurfaceSnapshotEntry {
  name: string;
  family: Family;
  evidence: Evidence;
  kind: "read" | "write";
  /** Argument names the schema demands, in declaration order. */
  required: string[];
  /** Argument names the schema accepts, in declaration order. */
  optional: string[];
}

/**
 * Project the full surface — every tool, no profile.
 *
 * Sorted by name rather than left in registration order, and that is the load-bearing choice: the
 * phases this snapshot exists to guard MOVE tools between files, which changes registration order
 * by design. A snapshot in registration order would go red on every move and say nothing about
 * whether the moved tool arrived intact.
 */
export function surfaceSnapshot(): SurfaceSnapshotEntry[] {
  return describeSurface()
    .tools.map((tool) => ({
      name: tool.name,
      family: tool.family,
      evidence: tool.evidence,
      kind: tool.kind,
      required: tool.inputs.filter((i) => i.required).map((i) => i.name),
      optional: tool.inputs.filter((i) => !i.required).map((i) => i.name),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The committed file's exact bytes: two-space JSON with a trailing newline, so a diff reads one tool at a time. */
export function renderSurfaceSnapshot(): string {
  return `${JSON.stringify(surfaceSnapshot(), null, 2)}\n`;
}
