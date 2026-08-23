/**
 * Chart geometry: pivots that remember WHEN they happened, and the lines you can draw through them.
 *
 * ## Why this exists separately from `src/core/indicators.ts`
 *
 * `levels()` there finds pivot clusters and throws the timing away. That is fine for "is 3,600
 * resistance" and useless for anything you can draw: a trend line is defined by two points in time,
 * and a level worth marking on a chart has a first touch and a last touch. The index of each pivot
 * was computed and discarded on the next line.
 *
 * So this module keeps the anchors, and `levels()` is re-expressed on top of it with byte-identical
 * output — its existing tests are the check that the rewrite changed nothing.
 *
 * ## What a trend line here is, and what it is not
 *
 * It is the best straight line through same-kind pivots, scored by how many of them it actually
 * touches, then by recency, then by fit. It is **not** a claim about the future. Two points define
 * a line and any two pivots will produce one; what makes a line worth showing is that a third and
 * fourth pivot landed on it, and that price has not closed through it since. Both are enforced
 * rather than assumed — a line price has closed decisively through is rejected outright, because
 * "broken support" drawn as support is worse than no line at all. That is the same mistake
 * `levels()` made in its first version, where every old pivot low was labelled support on a stock
 * that had fallen through all of them.
 *
 * Everything here is pure: bars in, geometry out. Nothing draws, nothing fetches.
 */
import type { Bar } from "../core/bars.js";
import type { Level } from "../core/indicators.js";
import type { Annotation } from "../render/candles.js";

const round = (n: number, dp = 4): number => Number(n.toFixed(dp));

/* ----------------------------------- pivots ----------------------------------- */

export interface Pivot {
  /** Index into the bar array. */
  index: number;
  /** The bar's date, so a caller can anchor a drawing without carrying the array. */
  date: string;
  price: number;
  /** `high` for a swing high, `low` for a swing low. */
  kind: "high" | "low";
}

/**
 * Swing highs and lows.
 *
 * A pivot is a bar whose high (or low) is not beaten by any bar within `lookback` on either side.
 * The `>=` / `<=` comparison includes the bar itself, so a flat top produces a pivot at each bar of
 * the plateau rather than none — under strict inequality a doubled top registers nothing, which is
 * exactly the shape a trader most wants marked.
 *
 * Returned in chronological order. Fewer than `lookback * 2 + 1` bars yields nothing: a window that
 * does not fit cannot confirm a pivot, and reporting the highest of five bars as a swing high would
 * be a guess wearing a name.
 */
export function pivots(bars: Bar[], lookback = 5): Pivot[] {
  if (!Number.isInteger(lookback) || lookback < 1) {
    throw new Error(`pivot lookback must be a positive integer, got ${lookback}`);
  }
  if (bars.length < lookback * 2 + 1) return [];

  const out: Pivot[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const window = bars.slice(i - lookback, i + lookback + 1);
    if (window.every((b) => bars[i].high >= b.high)) {
      out.push({ index: i, date: bars[i].date, price: bars[i].high, kind: "high" });
    }
    if (window.every((b) => bars[i].low <= b.low)) {
      out.push({ index: i, date: bars[i].date, price: bars[i].low, kind: "low" });
    }
  }
  return out;
}

/* ----------------------------------- levels ----------------------------------- */

export interface AnchoredLevel extends Level {
  /** Date of the earliest pivot in the cluster. */
  firstTouch: string;
  /** Date of the most recent one. A level last tested two years ago is not the same proposition. */
  lastTouch: string;
  /** Every pivot that clusters here, in order. */
  pivots: Pivot[];
}

/**
 * Support and resistance, with the timing kept.
 *
 * Two decisions carried over from `indicators.ts`, both of which were wrong in its first version
 * and were fixed against live data:
 *
 * **`kind` is decided by where price is NOW**, not by whether the pivot was a high or a low. BBRI
 * fell from about 4,000 to 3,020 over a year, and labelling every old pivot low as "support"
 * reported three levels above the market as the floor. What makes a level support is that price is
 * above it.
 *
 * **Clustering ignores which kind a pivot was.** A price that has acted as both ceiling and floor
 * is a stronger level, not two unrelated weak ones, and clustering per-kind split exactly the
 * levels most worth seeing.
 */
export function levelsWithAnchors(bars: Bar[], lookback = 5, tolerancePct = 1.5): AnchoredLevel[] {
  if (bars.length < lookback * 2 + 1) return [];
  const found = pivots(bars, lookback);

  const clusters: Array<{ price: number; members: Pivot[] }> = [];
  for (const pivot of found) {
    const hit = clusters.find((c) => Math.abs(c.price - pivot.price) / c.price <= tolerancePct / 100);
    if (hit) {
      // Keep the running mean so a level is where the pivots actually sit, not where the first one did.
      hit.price = round((hit.price * hit.members.length + pivot.price) / (hit.members.length + 1), 2);
      hit.members.push(pivot);
    } else {
      clusters.push({ price: round(pivot.price, 2), members: [pivot] });
    }
  }

  const reference = bars[bars.length - 1].close;
  return clusters
    .map((c) => {
      const ordered = [...c.members].sort((a, b) => a.index - b.index);
      return {
        price: c.price,
        touches: c.members.length,
        kind: (c.price <= reference ? "support" : "resistance") as Level["kind"],
        firstTouch: ordered[0].date,
        lastTouch: ordered[ordered.length - 1].date,
        pivots: ordered,
      };
    })
    .sort((a, b) => b.touches - a.touches || b.price - a.price);
}

/**
 * The un-anchored levels, for callers that only want the price and the count.
 *
 * Identical output to the original `levels()` in `src/core/indicators.ts`, which is what
 * `test/indicators.test.ts` asserts. It stays exported from there; this is the same computation
 * with the anchors dropped, so the two can never disagree.
 */
export function levels(bars: Bar[], lookback = 5, tolerancePct = 1.5): Level[] {
  return levelsWithAnchors(bars, lookback, tolerancePct).map(({ price, touches, kind }) => ({
    price,
    touches,
    kind,
  }));
}

/* --------------------------------- trend lines --------------------------------- */

export interface TrendLine {
  /** Resistance is fitted through swing HIGHS; support through swing LOWS. */
  kind: "support" | "resistance";
  fromDate: string;
  fromPrice: number;
  toDate: string;
  toPrice: number;
  /** Price change per BAR along the line. Positive is rising. */
  slopePerBar: number;
  /** How many pivots sit on the line within tolerance, including the two that defined it. */
  touches: number;
  /** Coefficient of determination of the touching pivots against the line. 1 is a perfect fit. */
  r2: number;
  /** The line's value at the most recent bar — where it sits today. */
  priceNow: number;
  /** Index of the last bar the line was fitted through; it is extended to the series end. */
  lastPivotIndex: number;
}

export interface TrendLineOptions {
  lookback?: number;
  /** A pivot within this percentage of the line counts as a touch. */
  tolerancePct?: number;
  /** Reject a line with fewer touches than this. Two is just "any two points". */
  minTouches?: number;
  /** How many lines to return, best first. */
  limit?: number;
}

interface Candidate extends TrendLine {
  members: Pivot[];
}

/** Line value at a bar index, from two anchor points. */
function valueAt(a: Pivot, b: Pivot, index: number): number {
  const slope = (b.price - a.price) / (b.index - a.index);
  return a.price + slope * (index - a.index);
}

/**
 * Fit trend lines through same-kind pivots.
 *
 * Every pair of pivots of one kind defines a candidate line; each candidate is then scored by how
 * many OTHER pivots of that kind sit on it within tolerance. Two rejections do most of the work:
 *
 *   - a line with fewer than `minTouches` pivots on it is not a trend line, it is a pair of points;
 *   - a line price has **closed decisively through** since its last anchor is rejected, because a
 *     broken line drawn as if it still held is worse than no line. "Decisively" is one tolerance
 *     band beyond the line, so a single wick or a marginal close does not discard an otherwise good
 *     line.
 *
 * Ranked by touches, then recency of the last anchor, then fit. Touches first because a line tested
 * four times is a different proposition from one tested three times, however tidy the third one's
 * arithmetic.
 */
export function fitTrendLines(bars: Bar[], options: TrendLineOptions = {}): TrendLine[] {
  const lookback = options.lookback ?? 5;
  const tolerancePct = options.tolerancePct ?? 1;
  const minTouches = options.minTouches ?? 3;
  const limit = options.limit ?? 4;

  const all = pivots(bars, lookback);
  const lastIndex = bars.length - 1;
  const candidates: Candidate[] = [];

  for (const kind of ["high", "low"] as const) {
    const group = all.filter((p) => p.kind === kind);
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (b.index === a.index) continue;

        const members = group.filter((p) => {
          const expected = valueAt(a, b, p.index);
          if (expected <= 0) return false;
          return Math.abs(p.price - expected) / expected <= tolerancePct / 100;
        });
        if (members.length < minTouches) continue;

        // Rejected if price has closed decisively through the line after its last anchor. For a
        // resistance line that means a close above it; for support, a close below.
        const lastMember = members[members.length - 1];
        const broken = bars.slice(lastMember.index + 1).some((bar, offset) => {
          const at = valueAt(a, b, lastMember.index + 1 + offset);
          if (at <= 0) return false;
          const margin = (at * tolerancePct) / 100;
          return kind === "high" ? bar.close > at + margin : bar.close < at - margin;
        });
        if (broken) continue;

        const slope = (b.price - a.price) / (b.index - a.index);
        const first = members[0];
        const last = members[members.length - 1];
        candidates.push({
          kind: kind === "high" ? "resistance" : "support",
          fromDate: first.date,
          fromPrice: round(valueAt(a, b, first.index), 2),
          toDate: bars[lastIndex].date,
          toPrice: round(valueAt(a, b, lastIndex), 2),
          slopePerBar: round(slope, 6),
          touches: members.length,
          r2: round(fitQuality(members, a, b), 4),
          priceNow: round(valueAt(a, b, lastIndex), 2),
          lastPivotIndex: last.index,
          members,
        });
      }
    }
  }

  // Two pairs from the same set of pivots describe the same line. Collapse them so a four-touch
  // line does not occupy every slot in the result as six near-identical rows.
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.members.map((m) => m.index).join(",")}`;
    const existing = unique.get(key);
    if (!existing || candidate.r2 > existing.r2) unique.set(key, candidate);
  }

  return [...unique.values()]
    .sort((a, b) => b.touches - a.touches || b.lastPivotIndex - a.lastPivotIndex || b.r2 - a.r2)
    .slice(0, limit)
    .map(({ members: _members, ...line }) => line);
}

/** R² of the touching pivots against the fitted line. 1 means every touch is exact. */
function fitQuality(members: Pivot[], a: Pivot, b: Pivot): number {
  if (members.length < 2) return 1;
  const mean = members.reduce((sum, p) => sum + p.price, 0) / members.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of members) {
    const predicted = valueAt(a, b, p.index);
    ssRes += (p.price - predicted) ** 2;
    ssTot += (p.price - mean) ** 2;
  }
  // A perfectly horizontal set of touches has no variance to explain; the fit is exact by
  // construction, and reporting 0 would rank a flawless flat line last.
  if (ssTot === 0) return ssRes === 0 ? 1 : 0;
  return Math.max(0, 1 - ssRes / ssTot);
}

/* ----------------------------------- channels ----------------------------------- */

export interface Channel {
  /** The better-tested of the two boundaries. */
  primary: TrendLine;
  /** A line parallel to `primary`, offset to the furthest opposite-kind pivot. */
  parallel: TrendLine;
  /** Vertical distance between the two, at the most recent bar. */
  widthNow: number;
  /** Where the latest close sits between them: 0 at the lower line, 1 at the upper. */
  positionInChannel: number;
}

/**
 * A channel: the best trend line, plus a parallel through the furthest pivot of the other kind.
 *
 * Returns `null` rather than a degenerate channel when there is no fitted line, or no opposite-kind
 * pivot to offset to. A "channel" with one boundary is a trend line, and returning it under the
 * other name would let a caller report a structure that is not there.
 */
export function channel(bars: Bar[], options: TrendLineOptions = {}): Channel | null {
  const lines = fitTrendLines(bars, options);
  if (lines.length === 0) return null;
  const primary = lines[0];

  const lookback = options.lookback ?? 5;
  const oppositeKind = primary.kind === "resistance" ? "low" : "high";
  const opposite = pivots(bars, lookback).filter((p) => p.kind === oppositeKind);
  if (opposite.length === 0) return null;

  const lastIndex = bars.length - 1;
  const firstIndex = bars.findIndex((bar) => bar.date === primary.fromDate);
  if (firstIndex < 0) return null;
  const slope = primary.slopePerBar;
  const lineAt = (index: number): number => primary.fromPrice + slope * (index - firstIndex);

  // The furthest pivot in the direction the channel opens: for a resistance primary, the low that
  // sits furthest BELOW the line.
  let furthest = opposite[0];
  let furthestGap = Math.abs(furthest.price - lineAt(furthest.index));
  for (const pivot of opposite) {
    const gap = Math.abs(pivot.price - lineAt(pivot.index));
    if (gap > furthestGap) {
      furthest = pivot;
      furthestGap = gap;
    }
  }

  const offset = furthest.price - lineAt(furthest.index);
  const parallel: TrendLine = {
    kind: primary.kind === "resistance" ? "support" : "resistance",
    fromDate: primary.fromDate,
    fromPrice: round(primary.fromPrice + offset, 2),
    toDate: primary.toDate,
    toPrice: round(primary.toPrice + offset, 2),
    slopePerBar: slope,
    // The parallel is DERIVED, not fitted: it is anchored by exactly one pivot and claiming more
    // would overstate it.
    touches: 1,
    r2: 1,
    priceNow: round(primary.priceNow + offset, 2),
    lastPivotIndex: furthest.index,
  };

  const upper = Math.max(primary.priceNow, parallel.priceNow);
  const lower = Math.min(primary.priceNow, parallel.priceNow);
  const width = upper - lower;
  const close = bars[lastIndex].close;
  return {
    primary,
    parallel,
    widthNow: round(width, 2),
    positionInChannel: width === 0 ? 0 : round((close - lower) / width, 4),
  };
}

/* --------------------------------- to annotations --------------------------------- */

export interface GeometryInput {
  levels?: AnchoredLevel[];
  trendLines?: TrendLine[];
  channel?: Channel | null;
}

/**
 * Turn geometry into the annotation union the chart renderer and the Chartbit driver both consume.
 *
 * One conversion, two destinations: the SVG in `src/render/candles.ts` and the real TradingView
 * chart in the user's browser. Keeping it single means a level drawn on the rendered chart and the
 * same level drawn on Stockbit's chart cannot drift apart.
 */
export function geometryToAnnotations(input: GeometryInput): Annotation[] {
  const out: Annotation[] = [];

  for (const level of input.levels ?? []) {
    out.push({
      kind: "level",
      price: level.price,
      // The label carries the evidence, because a bare horizontal line invites more confidence than
      // the data supports.
      label: `${level.kind} ${level.price} (${level.touches}x, last ${level.lastTouch})`,
    });
  }

  for (const line of input.trendLines ?? []) {
    out.push({
      kind: "trend",
      fromDate: line.fromDate,
      fromPrice: line.fromPrice,
      toDate: line.toDate,
      toPrice: line.toPrice,
      label: `${line.kind} trend (${line.touches}x, r2 ${line.r2})`,
    });
  }

  if (input.channel) {
    for (const line of [input.channel.primary, input.channel.parallel]) {
      out.push({
        kind: "trend",
        fromDate: line.fromDate,
        fromPrice: line.fromPrice,
        toDate: line.toDate,
        toPrice: line.toPrice,
        label: `channel ${line.kind}`,
      });
    }
  }

  return out;
}
