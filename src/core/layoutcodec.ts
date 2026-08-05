/**
 * Preparing a Chartbit layout payload — everything the save needs except the sending.
 *
 * The transport declares no Chartbit write and this module issues no request. It exists because the
 * encoding was the unknown that made the write unimplementable, and that unknown is now resolved:
 * see `docs/chartbit-layout-format.md`. Having the payload correct, tested and reviewable *before*
 * any route exists is the order ADR-0002 asks for — a write increment arrives with its apparatus,
 * not as a POST bolted onto a guess.
 *
 * ## The encoding
 *
 * Stockbit's save path is `POST {chartbit}/{symbol}/layout` with `{ content: Fj(JSON.stringify(x)) }`.
 * `Fj` looked like it might be opaque. It is a string substitution:
 *
 *     ["D4LkIE", "7a6YCE"].forEach(id => s = s.replace(new RegExp(id, "g"), "_seriesId"))
 *
 * It rewrites two TradingView-generated series ids to a placeholder so a saved layout is not bound
 * to the series instance that produced it. The stored value is plain JSON.
 *
 * ## The hazard this module refuses to ignore
 *
 * Because that is an unanchored global `String.replace`, any layout whose own content contains
 * `D4LkIE` or `7a6YCE` — inside a drawing's text, a symbol, a note — has those characters silently
 * rewritten to `_seriesId` on save. The user's chart comes back subtly wrong and nothing reports it.
 *
 * That is Stockbit's behaviour and this project cannot change it. What it can do is refuse to be the
 * thing that triggers it: `encodeLayoutForSave` throws when the payload would be corrupted, rather
 * than sending it and hoping. A caller that genuinely wants Stockbit's exact behaviour can call
 * `normalizeSeriesIds` directly.
 */

/** The generated series ids Stockbit's bundle rewrites. Hardcoded there, so hardcoded here. */
export const SERIES_ID_LITERALS = ["D4LkIE", "7a6YCE"] as const;

/** The placeholder they are rewritten to. */
export const SERIES_ID_PLACEHOLDER = "_seriesId";

/**
 * Stockbit's `Fj`, reproduced exactly — including its unanchored global replace.
 *
 * Deliberately faithful rather than improved: this is what the server will have been given by the
 * real client, so a round-trip has to match it or a comparison against a stored layout will differ
 * for reasons that are ours, not the user's.
 */
export function normalizeSeriesIds(serialized: string): string {
  let out = serialized;
  for (const id of SERIES_ID_LITERALS) {
    out = out.replace(new RegExp(id, "g"), SERIES_ID_PLACEHOLDER);
  }
  return out;
}

/**
 * Where a payload contains a literal that the save would silently rewrite.
 *
 * Returns the offending literals. Empty means the encoding is lossless for this payload.
 */
export function corruptingLiterals(serialized: string): string[] {
  return SERIES_ID_LITERALS.filter((id) => serialized.includes(id));
}

/**
 * Build the exact `content` value Stockbit's own client would send.
 *
 * Throws when the substitution would alter content that is not a series id — see the hazard note
 * above. Pass `allowLossy` to accept Stockbit's behaviour anyway.
 */
export function encodeLayoutForSave(layout: unknown, options: { allowLossy?: boolean } = {}): string {
  const serialized = JSON.stringify(layout);
  if (serialized === undefined) throw new Error("layout is not serialisable");

  if (!options.allowLossy) {
    // Check the ORIGINAL series-id occurrences against those that are legitimately ids. We cannot
    // tell them apart structurally, so the honest rule is: if the literal appears anywhere other
    // than as a source id, refuse. Approximated by requiring every occurrence to sit in an `"id"`
    // position, which is where a real generated id lives.
    const suspicious = corruptingLiterals(serialized).filter((id) => {
      const asId = new RegExp(`"id"\\s*:\\s*"${id}"`, "g");
      const total = (serialized.match(new RegExp(id, "g")) ?? []).length;
      const asIdCount = (serialized.match(asId) ?? []).length;
      return total > asIdCount;
    });
    if (suspicious.length > 0) {
      throw new Error(
        `Saving would corrupt this layout: ${suspicious.join(", ")} appears outside an id and Stockbit ` +
          `rewrites it to "${SERIES_ID_PLACEHOLDER}" with an unanchored replace. Pass allowLossy to send anyway.`,
      );
    }
  }

  return normalizeSeriesIds(serialized);
}

/* --------------------------------- composing a layout --------------------------------- */

export interface LayoutOptions {
  /** "light" or "dark". Chartbit stores the theme on each chart. */
  theme?: "light" | "dark";
  /** IANA zone. Chartbit's own templates use Asia/Jakarta. */
  timezone?: string;
  /** Extra sources to place in the main pane, e.g. line tools. */
  sources?: unknown[];
}

/**
 * A minimal, valid Chartbit chart state.
 *
 * Modelled on the templates Stockbit itself ships (`light`, `dark`, `default`, `foreign_flow`,
 * `bandarmology`), reduced to the fields those templates all carry. The main series id is the
 * placeholder, which is what a saved layout contains.
 *
 * **This composes the container, not drawings.** The `state` schema a `LineToolHorzLine` expects is
 * defined by the TradingView charting library, which Stockbit serves only to an authenticated chart
 * page — so it could not be read the way the rest of this was. `sources` is the seam: once that
 * schema is known, line tools drop straight in, and until then this is honest about composing an
 * empty chart rather than pretending to draw.
 */
export function buildLayout(options: LayoutOptions = {}): Record<string, unknown> {
  const theme = options.theme ?? "light";
  return {
    layout: "s",
    charts: [
      {
        panes: [
          {
            sources: [
              { type: "MainSeries", id: SERIES_ID_PLACEHOLDER, zorder: 0, state: { style: 1, visible: true } },
              ...(options.sources ?? []),
            ],
            leftAxisesState: [],
            rightAxisesState: [],
          },
        ],
        chartProperties: { paneProperties: {} },
        version: 3,
        timezone: options.timezone ?? "Asia/Jakarta",
        chartId: "1",
        theme,
        lineToolsGroups: { groups: [] },
        shouldBeSavedEvenIfHidden: true,
        linkingGroup: null,
      },
    ],
    symbolLock: 0,
    intervalLock: 0,
    trackTimeLock: 0,
    dateRangeLock: 0,
    crosshairLock: 1,
    layoutsSizes: { s: [{ percent: 1 }] },
  };
}

/** Shape check for something claiming to be a Chartbit layout, before it is sent anywhere. */
export function isPlausibleLayout(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const layout = value as { charts?: unknown };
  if (!Array.isArray(layout.charts) || layout.charts.length === 0) return false;
  const chart = layout.charts[0] as { panes?: unknown };
  return Array.isArray(chart?.panes) && chart.panes.length > 0;
}
