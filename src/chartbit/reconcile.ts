/**
 * Checking the local record of what we drew against what the chart actually holds.
 *
 * `ours` in a `chartbit_draw` result was the verbatim contents of the ledger, returned as though it
 * described the chart. Nothing ever asked the widget. In the field that produced a result listing
 * fourteen entities for a chart holding nine: five annotations were lost when the page reloaded, and
 * the next draw went on reporting them as present.
 *
 * ## The evidence problem, in the project's own words
 *
 * The entity ids WERE observed — `createShape` returns the widget's own id and that is what gets
 * written down. What was never observed is the claim `ours` actually makes, which is present tense:
 * *these are on the chart now*. That is a **Projected** claim, derived from a record and never read
 * back, sitting in a family that declares `evidence: "observed"`. Reading the widget's live entity
 * list makes it **Observed** — the same word the declaration already uses.
 *
 * ## Why this never deletes anything
 *
 * A reconcile that pruned would be one bad reading away from destroying the only thing that
 * separates this server's drawings from the user's own hand-drawn analysis. The widget mid-boot, a
 * tab on another symbol, an enumeration that came back empty for any reason — and the ids are gone,
 * at which point an orphaned drawing can only be removed with `clear scope:"all"`, the operation
 * that requires confirmation precisely because it destroys work this server has never seen.
 *
 * So the ledger is annotated, never trimmed. The cost is a record that grows until a `replace` or a
 * `clear`; the alternative is unremovable orphans, and a note that is out of date must not be able
 * to break the operation it describes.
 *
 * Pure, so it is testable without a browser — which is the whole point, since the browser is the
 * one thing the offline suite cannot have.
 */
import type { OurDrawing } from "./store.js";

/**
 * What is known about one recorded drawing right now.
 *
 * `unconfirmed` is not a third state of the chart; it is the absence of a reading. It means the
 * live entity list could not be obtained, so the honest answer is that we do not know — which is
 * the answer this project gives everywhere else rather than defaulting to the convenient one.
 */
export type Presence = "on-chart" | "gone" | "unconfirmed";

export interface OurDrawingStatus extends OurDrawing {
  presence: Presence;
}

export interface Reconciliation {
  /** The whole ledger, each entry carrying what the chart says about it. Never shortened. */
  ours: OurDrawingStatus[];
  /** Recorded drawings the chart no longer holds. Empty when the reading was clean. */
  gone: OurDrawingStatus[];
  /** How many recorded drawings the chart confirmed. */
  onChart: number;
  /** True when a live reading was taken. False means every `presence` is `unconfirmed`. */
  reconciled: boolean;
  /** Why no reading was taken, when none was. Absent on success. */
  note?: string;
}

/**
 * Compare the ledger against the widget's live entity ids.
 *
 * `liveIds` is null when the chart could not be enumerated — a different thing from an empty chart,
 * and the reason this takes `null` rather than defaulting to `[]`. An empty array says "the chart
 * holds nothing", which would mark every recorded drawing `gone`; null says "we did not look".
 */
export function reconcileOurDrawings(
  ledger: readonly OurDrawing[],
  liveIds: readonly string[] | null,
  note?: string,
): Reconciliation {
  if (liveIds === null) {
    return {
      ours: ledger.map((d) => ({ ...d, presence: "unconfirmed" as const })),
      gone: [],
      onChart: 0,
      reconciled: false,
      ...(note ? { note } : {}),
    };
  }
  const live = new Set(liveIds.map(String));
  const ours = ledger.map((d) => ({
    ...d,
    presence: (live.has(String(d.tvEntityId)) ? "on-chart" : "gone") as Presence,
  }));
  return {
    ours,
    gone: ours.filter((d) => d.presence === "gone"),
    onChart: ours.filter((d) => d.presence === "on-chart").length,
    reconciled: true,
  };
}
