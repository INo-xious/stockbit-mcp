/**
 * `analyze` — the synthesis layer, and an honest account of what a synthesis can be.
 *
 * ## Why this module exists at all
 *
 * Every other tool here answers one question from one source. `deep_dive` fetches five of them in a
 * row, but the workflow engine is deliberately computation-free — it can sequence tools and cannot
 * weigh them, and `src/workflows/builtin.ts` says so on purpose. So nothing in this project has ever
 * turned "here are six readings" into "here is what they say together". That is the whole job here.
 *
 * ## Confidence is not a probability, and the type name is the first place that has to be true
 *
 * `confidence` on this report measures **the quality and agreement of the evidence** — how much of
 * it we got, whether it points one way, how far from neutral the composite sits, and how fresh the
 * data is. It is emphatically **not** the probability that the price goes the way the lean says.
 * Nothing in this data source could support such a number, and a scale that runs to 100 invites the
 * reader to believe otherwise, so this one **stops at 90** by construction: the four components sum
 * to 30 + 30 + 20 + 10.
 *
 * There is a second, sharper reason to be careful with the word here. `Detection.confidence` in
 * `./patterns.ts` already means something else entirely — how closely a candle matches its textbook
 * proportions — and that module is emphatic that it is not a probability either. Those two numbers
 * must never be added, averaged, or otherwise mixed. Pattern confidence is used **only** as a
 * within-pillar weight in `patternPillar`, and never reaches `Confidence.value`.
 *
 * ## "No" and "not enough data to say" are different answers
 *
 * `alert_check` distinguishes `condition-false` from `warming-up`; `timeframe.read` returns `null`
 * rather than an RSI computed from a window that has not converged; `extractBands` reports a field
 * as missing rather than as zero. The same rule governs every pillar below: a pillar that could not
 * be read is `missing`, contributes **no** score, and its weight is redistributed across the
 * pillars that were read — while costing confidence. A missing pillar never lands as a neutral
 * vote, because "we could not see it" and "we looked and it was balanced" are not the same claim
 * and averaging them together silently converts one into the other.
 *
 * ## What this cannot do
 *
 * Two of the pillars a serious equity read would want are not scored here, and the reason has
 * changed since this was written:
 *
 *   - **Analyst consensus and price targets.** The routes now exist (see `analyst_ratings`), but
 *     folding a consensus into this score needs the wire shape observed first — a target price read
 *     from a field nobody has looked at is a number with a decimal point and no meaning.
 *   - **Peer-relative valuation.** `ratios` answers "what is BBRI's PBV" and this pillar cannot ask
 *     "and is that cheap for a bank". The industry aggregate is now reachable through
 *     `peer_comparison`; until its shape is confirmed live, `valuationPillar` still scores against
 *     absolute bands, which is genuinely weak for banks, property and any cyclical — and it says
 *     so, in the pillar and in `limits`, rather than letting a reader mistake a band for a
 *     benchmark.
 *
 * Community sentiment is fetched and **reported, not scored**. Turning ~30 Indonesian-language
 * retail posts into a directional number needs a classifier this project does not have; a keyword
 * tally would be noise wearing a label, which is the exact failure the rest of this codebase is
 * arranged to avoid.
 */
import type { Bar, BarSeries } from "../core/bars.js";
import type { BrokerSummary, BrokerSummaryPeriod } from "../core/marketdetectors.js";
import type { PriceBands } from "../core/pricefeed.js";
import type { StreamPost } from "../core/stream.js";
import { StockbitError } from "../http/errors.js";
import { alignment, type AlignmentReport } from "./timeframe.js";
import { detectPatterns } from "./patterns.js";

/* ---------------------------------------- shape ---------------------------------------- */

export type Lean = "bullish" | "neutral" | "bearish";
export type PillarStatus = "ok" | "degraded" | "missing";
export type ConfidenceLabel = "low" | "medium" | "high";

export interface Pillar {
  name: PillarName;
  label: string;
  /** The weight this pillar carries when every pillar is readable. */
  declaredWeight: number;
  /** After redistributing the weight of anything `missing`. Zero when this pillar is missing. */
  effectiveWeight: number;
  status: PillarStatus;
  /** −100…+100. `null` when `missing` — never 0, which would be a reading. */
  score: number | null;
  /** Why the score is what it is, in one sentence a human can check. */
  reason: string;
  /** The measured inputs the score came from, so a reader can disagree with the scoring. */
  evidence: Record<string, unknown>;
  /** Anything that qualifies this pillar — degradations, fallbacks, absent sub-signals. */
  notes: string[];
}

export interface ConfidenceComponents {
  /** 0–30. How much of the declared weight was actually readable. */
  completeness: number;
  /** 0–30. Whether the readable pillars point the same way. */
  agreement: number;
  /** 0–20. How far the composite sits from neutral. */
  strength: number;
  /** 0–10. How recent the price data is. */
  freshness: number;
}

export interface Confidence {
  /** 0–90. Evidence quality, NOT a probability of price direction. Capped by construction. */
  value: number;
  label: ConfidenceLabel;
  components: ConfidenceComponents;
  /** Every pillar that could not be read, and why. */
  missing: string[];
  /** The observations that would most move this verdict. */
  wouldChange: string[];
}

export interface AnalysisContext {
  /** Community posts are counted and dated, never scored. See the module note. */
  sentiment: { posts: number; latest: string | null; note: string } | null;
  bands: PriceBands | null;
  lastClose: number | null;
  priceDate: string | null;
}

export interface AnalysisReport {
  symbol: string;
  /** The date of the most recent session actually used, not the wall clock. */
  asOf: string | null;
  lean: Lean;
  /** −100…+100, the effective-weighted sum of the pillars. */
  score: number;
  confidence: Confidence;
  pillars: Pillar[];
  context: AnalysisContext;
  /** Conditions that change how the numbers should be read. */
  warnings: string[];
  /** What this report structurally cannot say. Always populated. */
  limits: string[];
  cost: { pagesFetched: number; upstreamRequests: number; elapsedMs: number };
  disclaimer: string;
}

export type PillarName = "brokerFlow" | "trend" | "patterns" | "valuation";

/**
 * Declared weights.
 *
 * Broker flow leads because it is the only pillar no other tool in the world can serve — it is the
 * reason this server exists — and because it reports positioning rather than restating price.
 * Trend follows. Valuation is third and would be higher if it had a peer denominator; scored
 * against absolute bands it earns less. Patterns are last: they are short-horizon, and their own
 * module refuses to claim they predict anything.
 */
export const PILLAR_WEIGHTS: Record<PillarName, number> = {
  brokerFlow: 0.35,
  trend: 0.3,
  valuation: 0.2,
  patterns: 0.15,
};

/** |score| at or above this is a lean rather than a shrug. */
export const LEAN_THRESHOLD = 25;

export const DISCLAIMER =
  "An evidence summary, not financial advice and not a price prediction. `confidence` measures how " +
  "complete and internally consistent the evidence is — it is NOT the probability that the price " +
  "moves the way `lean` points, and it stops at 90 because no reading of this data could justify " +
  "more.";

/* --------------------------------------- helpers --------------------------------------- */

const clamp = (v: number, lo = -100, hi = 100): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, dp = 2): number => Number(v.toFixed(dp));
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * Coerce the several shapes this API uses for one number.
 *
 * Deliberately a local copy rather than an import: `numberish` in `src/core/pricefeed.ts` is
 * module-private, and the one rule that matters is shared by both — an empty string is **absent**,
 * because `Number("")` is `0` and a free zero is exactly the wrong answer for a ratio.
 */
function numberish(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "").trim();
    if (cleaned === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if ("value" in rec) return numberish(rec.value);
    if ("raw" in rec) return numberish(rec.raw);
  }
  return null;
}

const normalizeKey = (k: string): string => k.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Find a number by key name anywhere in an unmapped payload.
 *
 * `getKeystats` and `getRatios` return `unknown` on purpose — the objects are large, nested and
 * were never exhaustively mapped. Rather than assert a shape that has not been observed, this walks
 * the tree for a key the caller names and reports failure honestly when nothing matches, which is
 * what turns the valuation pillar `missing` instead of inventing a score from a default.
 *
 * Depth-bounded and cycle-safe: these payloads are ~50KB of unknown structure.
 */
export function findNumber(payload: unknown, candidates: string[]): number | null {
  const wanted = new Set(candidates.map(normalizeKey));
  const seen = new Set<object>();

  const walk = (node: unknown, depth: number): number | null => {
    if (depth > 8 || node === null || typeof node !== "object") return null;
    if (seen.has(node as object)) return null;
    seen.add(node as object);

    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = walk(item, depth + 1);
        if (hit !== null) return hit;
      }
      return null;
    }

    const rec = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(rec)) {
      if (wanted.has(normalizeKey(key))) {
        const n = numberish(value);
        if (n !== null) return n;
      }
    }
    for (const value of Object.values(rec)) {
      const hit = walk(value, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };

  return walk(payload, 0);
}

/** Score a value against ordered bands. First band whose ceiling is not exceeded wins. */
function band(value: number, bands: Array<[ceiling: number, score: number]>, above: number): number {
  for (const [ceiling, score] of bands) if (value <= ceiling) return score;
  return above;
}

/* --------------------------------------- pillars --------------------------------------- */

export interface BrokerFlowInput {
  summary: BrokerSummary | null;
  bars: Bar[];
  bands: PriceBands | null;
  /** Sessions of foreign flow to read. Default 20. */
  window?: number;
}

/**
 * Positioning: who is on the other side, and is money entering or leaving.
 *
 * Two sub-signals, deliberately not three:
 *
 *   1. **Foreign net flow as a share of traded value**, from the daily bars. Both figures are IDR
 *      on the same rows, so the ratio is dimensionless and comparable across a Rp 500 stock and a
 *      Rp 10,000 one. This is the more trustworthy half — the bar schema is mapped and asserted.
 *   2. **Concentration asymmetry**, from the broker summary. The reason a raw buy-versus-sell
 *      imbalance is NOT used: in `NET` mode the two sides are the same trades seen from opposite
 *      ends, so they very nearly cancel and the "imbalance" is noise around zero. What does carry
 *      information is whether accumulation is concentrated in a few hands while distribution is
 *      diffuse — the classic bandarmology read — so this compares how concentrated each side is.
 *
 * **The top-3 share cannot be used raw, and the first version of this module did exactly that.**
 * A top-3 share over `n` brokers has a structural floor of `3/n`: a perfectly uniform side of five
 * brokers scores 0.60 and a perfectly uniform side of forty scores 0.075, with no concentration
 * anywhere in either. Differencing two raw shares therefore measures *which side has fewer brokers*
 * — and in `NET` mode the two sides are genuinely different sizes, so that is the normal case, not
 * an edge case. Measured on the shipped code before this fix: five uniform buyers against forty
 * uniform sellers scored **+100**, the maximum bullish reading, from an artifact; and a side that
 * was genuinely the more concentrated one could come out with the wrong sign. So the floor is
 * divided out here, and a side of three or fewer brokers — where the share is 1.0 by arithmetic and
 * says nothing — is refused rather than scored.
 *
 * **The floor-lock guard.** When a stock sits at its auto-rejection floor, every broker on both
 * sides fills at one price and the accumulation/distribution split carries no information at all.
 * That is a real state on IDX, not an edge case, and it is recorded in this project's own notes as
 * having produced a confident-looking reading from a degenerate session. Detected here, the pillar
 * is downgraded to `degraded` and says why.
 */
/**
 * How concentrated one side of the book is, with the arithmetic floor divided out.
 *
 * `share` is the raw top-3 share and is reported for transparency; `excess` is the number to score
 * on. `null` means the question cannot be asked — either nothing traded, or there are three or
 * fewer brokers, where the share is 1.0 by construction and carries no information at all.
 */
export function excessConcentration(
  rows: Array<{ netValueIdr: number }>,
): { share: number; excess: number } | null {
  const magnitudes = rows.map((r) => Math.abs(r.netValueIdr)).sort((a, b) => b - a);
  const total = sum(magnitudes);
  if (total <= 0) return null;

  const n = magnitudes.length;
  if (n <= 3) return null;

  const share = sum(magnitudes.slice(0, 3)) / total;
  const floor = 3 / n; // what a perfectly uniform side of this size scores
  return { share, excess: clamp((share - floor) / (1 - floor), 0, 1) };
}

export function brokerFlowPillar(input: BrokerFlowInput): Pillar {
  const notes: string[] = [];
  const evidence: Record<string, unknown> = {};
  const window = input.window ?? 20;
  const recent = input.bars.slice(-window);

  const parts: Array<{ score: number; weight: number }> = [];

  /* -- 1. foreign net flow relative to what actually traded -- */
  const tradedValue = sum(recent.map((b) => b.value));
  const netForeign = sum(recent.map((b) => b.netForeign));
  if (recent.length >= 5 && tradedValue > 0) {
    const ratio = netForeign / tradedValue;
    // A net foreign take of 10% of everything that traded over a month is a very large flow; that
    // is the point where this saturates.
    const score = clamp(ratio * 1000);
    parts.push({ score, weight: 0.55 });
    evidence.foreignNetIdr = round(netForeign, 0);
    evidence.tradedValueIdr = round(tradedValue, 0);
    evidence.foreignShareOfValuePct = round(ratio * 100, 3);
    evidence.sessionsRead = recent.length;
  } else {
    notes.push(
      `Foreign flow not read: needs 5 sessions with traded value, saw ${recent.length}.`,
    );
  }

  /* -- 2. concentration asymmetry from the broker summary -- */
  const s = input.summary;
  let concentrationRead = false;
  if (s && s.buyers.length > 0 && s.sellers.length > 0) {
    const buy = excessConcentration(s.buyers);
    const sell = excessConcentration(s.sellers);
    if (buy !== null && sell !== null) {
      // Both terms are floor-corrected, so 0 means "as evenly spread as this many brokers can be"
      // and 1 means "one broker is the whole side". The difference lives in −1…+1; ×150 saturates
      // at a two-thirds gap, which is already a very lopsided book.
      const score = clamp((buy.excess - sell.excess) * 150);
      parts.push({ score, weight: 0.45 });
      evidence.buyConcentration = round(buy.excess, 3);
      evidence.sellConcentration = round(sell.excess, 3);
      evidence.top3BuyerSharePct = round(buy.share * 100, 1);
      evidence.top3SellerSharePct = round(sell.share * 100, 1);
      evidence.brokersBuy = s.buyers.length;
      evidence.brokersSell = s.sellers.length;
      if (s.from || s.to) evidence.brokerWindow = { from: s.from, to: s.to };
      concentrationRead = true;

      // The floor correction removes the count bias from the number; it does not make a lopsided
      // comparison as trustworthy as a balanced one, so say when the sides are very different sizes.
      const [fewer, more] = [s.buyers.length, s.sellers.length].sort((a, b) => a - b);
      if (more >= fewer * 2) {
        notes.push(
          `Broker counts are lopsided (${s.buyers.length} buyers vs ${s.sellers.length} sellers). The ` +
            "count bias is divided out, but a concentration comparison is weakest across sides this uneven.",
        );
      }
    } else {
      const why =
        buy === null && sell === null
          ? "both sides"
          : buy === null
            ? "the buy side"
            : "the sell side";
      notes.push(
        `Broker concentration not read: ${why} had three or fewer brokers, or no net value at all. ` +
          "A top-3 share over three brokers is 1.0 by arithmetic and measures nothing.",
      );
    }
  } else {
    notes.push(
      s
        ? "Broker concentration not read: the summary returned one side empty, which is normal on a non-trading day."
        : "Broker summary unavailable.",
    );
  }

  if (parts.length === 0) {
    return {
      name: "brokerFlow",
      label: "Broker flow & positioning",
      declaredWeight: PILLAR_WEIGHTS.brokerFlow,
      effectiveWeight: 0,
      status: "missing",
      score: null,
      reason: "Neither foreign flow nor broker concentration could be read.",
      evidence,
      notes,
    };
  }

  const totalWeight = sum(parts.map((p) => p.weight));
  const score = round(clamp(sum(parts.map((p) => p.score * p.weight)) / totalWeight));

  const foreignRead = evidence.foreignShareOfValuePct !== undefined;
  evidence.foreignFlowRead = foreignRead;
  evidence.concentrationRead = concentrationRead;

  if (parts.length === 1) notes.push("Only one of two sub-signals was readable.");

  /* -- the floor-lock guard -- */
  // Pushed LAST on purpose. This is the loudest caveat the module has, and a reader scanning a
  // truncated list must not have it displaced by a milder note appended after it.
  let status: PillarStatus = parts.length === 2 ? "ok" : "degraded";
  const last = input.bars[input.bars.length - 1];
  const arb = input.bands?.arb ?? null;
  if (last && arb !== null && Math.abs(last.close - arb) < 1e-9) {
    status = "degraded";
    notes.push(
      `FLOOR-LOCKED: the last close (${last.close}) sits exactly on the auto-rejection floor (${arb}). ` +
        "Every broker on both sides fills at one price, so accumulation-versus-distribution carries no " +
        "information in this state. Read this pillar as unreliable, not as bearish.",
    );
  }

  // The sentence names the window each half actually used. Attributing a broker-summary reading to
  // the bar window would be a quiet lie, and with no bars at all it read "over the last 0 sessions".
  const direction = score > 10 ? "money entering" : score < -10 ? "money leaving" : "roughly balanced";
  const over = foreignRead
    ? `over the last ${recent.length} sessions`
    : concentrationRead
      ? `from broker concentration over ${describeWindow(s)}`
      : "";

  return {
    name: "brokerFlow",
    label: "Broker flow & positioning",
    declaredWeight: PILLAR_WEIGHTS.brokerFlow,
    effectiveWeight: 0,
    status,
    score,
    reason: `Positioning looks ${direction}${over ? ` ${over}` : ""}.`,
    evidence,
    notes,
  };
}

function describeWindow(s: BrokerSummary | null): string {
  if (s?.from && s.to) return `${s.from} to ${s.to}`;
  return "the requested broker window";
}

/**
 * Trend, taken from the existing multi-timeframe report rather than a new classifier.
 *
 * `AlignmentReport.score` is a vote per timeframe in −3…+3, and it needs two corrections before it
 * can be weighed against anything else:
 *
 *   - **It is not normalised.** Its range depends on how many timeframes were asked for, so a
 *     two-timeframe report and a three-timeframe one are not on the same scale.
 *   - **`flat` is ambiguous.** A timeframe contributes 0 both when the trend is genuinely flat and
 *     when the moving averages could not be computed at all. Only the second is an abstention, and
 *     it is distinguishable: `read()` leaves `evidence.fastMa`/`slowMa` null in that case. Counting
 *     an unreadable monthly as "neutral evidence" would quietly dilute a real daily-plus-weekly
 *     signal toward zero.
 *
 * So the denominator here is the number of timeframes whose averages actually resolved, and a
 * report where none did is `missing` rather than neutral.
 */
export function trendPillar(report: AlignmentReport | null): Pillar {
  const base: Omit<Pillar, "status" | "score" | "reason"> = {
    name: "trend",
    label: "Trend & timeframe alignment",
    declaredWeight: PILLAR_WEIGHTS.trend,
    effectiveWeight: 0,
    evidence: {},
    notes: [],
  };

  if (!report) {
    return { ...base, status: "missing", score: null, reason: "No price history to read a trend from." };
  }

  const readable = report.timeframes.filter(
    (t) => t.evidence.fastMa !== null && t.evidence.slowMa !== null,
  );
  const unreadable = report.timeframes.filter(
    (t) => t.evidence.fastMa === null || t.evidence.slowMa === null,
  );
  const notes = unreadable.map(
    (t) => `${t.label} abstains — its moving averages need more bars than ${t.bars} (not counted as neutral).`,
  );

  if (readable.length === 0) {
    return {
      ...base,
      status: "missing",
      score: null,
      reason: "No timeframe had enough bars for its moving averages.",
      notes,
      evidence: { timeframesRead: 0, limits: report.limits },
    };
  }

  const votes = sum(readable.map((t) => (t.trend === "up" ? 1 : t.trend === "down" ? -1 : 0)));
  const voteScore = (votes / readable.length) * 100;

  // Distance from the slow average adds magnitude to what is otherwise a coarse three-valued vote.
  // Daily is used because it is the only timeframe guaranteed to have resolved when any did.
  const daily = readable.find((t) => t.timeframe === "D");
  const stretch = daily?.evidence.closeVsSlowMaPct ?? null;
  const stretchScore = stretch === null ? null : clamp(stretch * 5);

  const score = round(
    clamp(stretchScore === null ? voteScore : voteScore * 0.75 + stretchScore * 0.25),
  );

  // The reason is rebuilt rather than reusing `report.verdict`. That sentence counts a timeframe
  // whose trend came from `alignment`'s short-EMA fallback as a real vote, so on a thin series it
  // reads "every timeframe points up" while this pillar is simultaneously reporting two of them as
  // abstaining — two true statements that flatly contradict each other in one payload.
  const named = readable.map((t) => `${t.label} ${t.trend}`).join(", ");
  const abstained = unreadable.map((t) => t.label).join(", ");
  const direction = votes === readable.length ? "all point up" : votes === -readable.length ? "all point down" : "disagree";
  const reason =
    `Of the ${readable.length} timeframe${readable.length === 1 ? "" : "s"} with readable moving averages, ` +
    `they ${direction} (${named}).` +
    (abstained ? ` ${abstained} abstained — not enough bars, and not counted as neutral.` : "");

  return {
    ...base,
    status: unreadable.length > 0 ? "degraded" : "ok",
    score,
    reason,
    notes,
    evidence: {
      timeframesRead: readable.length,
      timeframesAbstained: unreadable.length,
      votes,
      aligned: report.aligned,
      dailyCloseVsSlowMaPct: stretch,
      perTimeframe: report.timeframes.map((t) => ({
        timeframe: t.label,
        trend: t.trend,
        bars: t.bars,
        rsi: t.evidence.rsi,
        macdHistogram: t.evidence.macdHistogram,
      })),
    },
  };
}

/**
 * Recent candlestick evidence.
 *
 * `Detection.confidence` is used here **as a within-pillar weight only** — it measures how closely
 * a candle matched its textbook proportions, which is a fair way to rank two detections against
 * each other and is not a probability of anything. It must not propagate into `Confidence.value`;
 * see the module note.
 *
 * Recency is weighted linearly across the window because a reversal signal eight sessions old has
 * already had eight sessions to be wrong.
 */
export function patternPillar(bars: Bar[], sinceBars = 10): Pillar {
  const base: Omit<Pillar, "status" | "score" | "reason"> = {
    name: "patterns",
    label: "Candlestick patterns",
    declaredWeight: PILLAR_WEIGHTS.patterns,
    effectiveWeight: 0,
    evidence: {},
    notes: [],
  };

  if (bars.length < 10) {
    return { ...base, status: "missing", score: null, reason: `Needs 10 bars to read patterns, saw ${bars.length}.` };
  }

  // A window of zero makes `detectPatterns` sweep nothing and return [], which is indistinguishable
  // from "swept the window and found nothing" — and the second is a neutral reading while the first
  // is no reading at all. Refuse rather than fabricate the neutral.
  if (!Number.isFinite(sinceBars) || sinceBars < 1) {
    return {
      ...base,
      status: "missing",
      score: null,
      reason: `A pattern window of ${sinceBars} scans no sessions, so there is nothing to read.`,
    };
  }

  // Selected by RECENCY, not by `topPatterns`, whose sort is by shape confidence with index only as
  // a tiebreaker — it was written as a chart-marker cap. Applied here it could drop today's reversal
  // in favour of five older candles that happened to be geometrically tidier, which is the opposite
  // of what a pillar weighted on recency wants.
  const all = detectPatterns(bars, { since: sinceBars, minConfidence: 0.6 });
  const detections = [...all].sort((a, b) => b.index - a.index).slice(0, 5);
  const lastIndex = bars.length - 1;

  if (detections.length === 0) {
    return {
      ...base,
      status: "ok",
      score: 0,
      reason: `No qualifying candlestick pattern in the last ${sinceBars} sessions.`,
      notes: ["An absent pattern is genuine neutral evidence here, not a missing reading."],
      evidence: { detections: 0, window: sinceBars },
    };
  }

  let weighted = 0;
  let weight = 0;
  for (const d of detections) {
    const age = lastIndex - d.index;
    const recency = Math.max(0.2, 1 - age / Math.max(1, sinceBars));
    const w = d.confidence * recency;
    const sign = d.direction === "bullish" ? 1 : d.direction === "bearish" ? -1 : 0;
    weighted += sign * w;
    weight += w;
  }

  const score = weight > 0 ? round(clamp((weighted / weight) * 100)) : 0;
  const named = detections
    .map((d) => `${d.label} (${d.direction}, ${d.date})`)
    .join("; ");

  return {
    ...base,
    status: "ok",
    score,
    reason: `${detections.length} pattern${detections.length === 1 ? "" : "s"} in the last ${sinceBars} sessions: ${named}.`,
    notes: [
      "Pattern confidence measures shape fidelity, not the odds the pattern works — it is used only " +
        "to rank detections inside this pillar.",
    ],
    evidence: {
      window: sinceBars,
      detections: detections.map((d) => ({
        pattern: d.pattern,
        label: d.label,
        date: d.date,
        direction: d.direction,
        context: d.context,
        shapeConfidence: d.confidence,
      })),
    },
  };
}

/**
 * Read Stockbit's named financial items out of a keystats or ratios payload.
 *
 * These metrics are NOT flat fields. They arrive as a list of named items, and the two endpoints
 * disagree about the shape of a row:
 *
 *   keystats: { fitem_name: "Current PE Ratio (TTM)", fitem_value: "8.00" }
 *   ratios:   { fitem: { name: "Current PE Ratio (TTM)", value: "8.00" } }
 *
 * The first version of this pillar looked up keys called `per` and `pbv`, which cannot match
 * anything here — the names are *values*, not keys. Every stock therefore reported valuation as
 * `missing`, and because "missing" is an honest outcome in this design, nothing looked wrong:
 * BBRI came back with the pillar dropped and its weight redistributed, which is exactly what a
 * genuinely unavailable metric would look like. Only running it against a real bank, whose PE and
 * PBV obviously exist, exposed it. Fixtures cannot catch this class of bug — they encode the shape
 * the author already believed.
 */
function financialItems(payload: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const groups = (payload as { closure_fin_items_results?: unknown[] } | null)?.closure_fin_items_results;
  if (!Array.isArray(groups)) return out;
  for (const group of groups) {
    const rows = (group as { fin_name_results?: unknown[] } | null)?.fin_name_results;
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const row = raw as { fitem_name?: unknown; fitem_value?: unknown; fitem?: { name?: unknown; value?: unknown } };
      const name = typeof row.fitem_name === "string" ? row.fitem_name : row.fitem?.name;
      const value = row.fitem_value ?? row.fitem?.value;
      if (typeof name === "string" && value != null) out.set(name.toLowerCase(), String(value));
    }
  }
  return out;
}

/**
 * Parse one of those values.
 *
 * They are strings carrying presentation: `"17.30%"`, `"1,390.55"`, `"48,988 B"`. A literal `"-"`
 * means the metric does not apply to this issuer — banks have no inventory turnover — and must read
 * as absent rather than as zero, which would score as excellent liquidity.
 */
function parseFinValue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "" || text === "-" || text === "N/A") return null;
  const cleaned = text.replace(/,/g, "").replace(/%$/, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** First item whose name matches, in preference order. Names are matched exactly, lowercased. */
function findMetric(sources: Array<Map<string, string>>, names: string[]): number | null {
  for (const name of names) {
    for (const source of sources) {
      const value = parseFinValue(source.get(name.toLowerCase()));
      if (value !== null) return value;
    }
  }
  return null;
}

/**
 * The ratio bands. Ordered ceilings; anything above the last falls through to `above`.
 *
 * `names` are Stockbit's own item labels, in preference order — TTM before annualised, because a
 * trailing twelve months is the more conservative read of a single good quarter.
 */
const VALUATION_METRICS: Array<{
  key: string;
  names: string[];
  score: (v: number) => number;
}> = [
  {
    key: "per",
    names: ["Current PE Ratio (TTM)", "Current PE Ratio (Annualised)", "Forward PE Ratio"],
    // A negative PER means losses, which is information — and it is not "infinitely cheap".
    score: (v) => (v <= 0 ? -40 : band(v, [[8, 60], [15, 25], [25, 0], [40, -30]], -60)),
  },
  {
    key: "pbv",
    names: ["Current Price to Book Value"],
    score: (v) => (v <= 0 ? -30 : band(v, [[1, 50], [2, 20], [4, 0]], -40)),
  },
  {
    key: "roe",
    names: ["Return on Equity (TTM)"],
    score: (v) => band(v, [[0, -50], [10, 0], [20, 25]], 50),
  },
  {
    key: "der",
    // "Debt to Equity Ratio" counts interest-bearing debt only. For a bank that is ~0.01 while
    // Total Liabilities/Equity is ~5.6, because deposits are liabilities and not debt. The narrow
    // measure is the right one for a solvency band; the broad one would score every bank as
    // distressed.
    names: ["Debt to Equity Ratio (Quarter)", "LT Debt/Equity (Quarter)"],
    score: (v) => band(v, [[0.5, 20], [1.5, 0], [3, -20]], -40),
  },
];

/**
 * Valuation, scored against absolute bands — with the weakness stated rather than buried.
 *
 * The right way to do this is relative: a PBV of 1.2 is expensive for a bank and cheap for a
 * consumer name, and Stockbit serves an industry aggregate that would supply the denominator. Those
 * comparison routes are now declared and reachable through the `peer_comparison` tool, but their
 * field names have not been observed against live data, and scoring against a denominator nobody
 * has looked at would be worse than scoring against a stated band. Absolute bands are what remains
 * until then, and they are systematically wrong in a predictable direction for banks, property and
 * cyclicals.
 *
 * The payloads are the other constraint: `getKeystats` and `getRatios` return `unknown` by design,
 * so every metric is looked up by name and a metric that cannot be found is simply not scored. If
 * none are found the pillar is `missing` — never a default.
 */
export function valuationPillar(keystats: unknown, ratios: unknown): Pillar {
  const evidence: Record<string, unknown> = {};
  const notes: string[] = [
    "Scored against ABSOLUTE bands, not peers. Stockbit's industry aggregate is not in this " +
      "server's route table, so 'cheap for a bank' cannot be asked. Treat this pillar as weak for " +
      "banks, property and cyclicals.",
  ];
  const scores: number[] = [];
  const notFound: string[] = [];
  const sources = [financialItems(ratios), financialItems(keystats)];

  // Stockbit ships the index's own median PE in the same payload. It does not feed the score —
  // that would silently change what the bands mean — but it is the one peer reference available
  // here, and it turns "PE 8.0" into "PE 8.0 against a market median of 8.0", which is the
  // comparison the absolute bands cannot make.
  const marketPer = findMetric(sources, ["IHSG PE Ratio TTM (Median)"]);

  for (const metric of VALUATION_METRICS) {
    const value = findMetric(sources, metric.names);
    if (value === null) {
      notFound.push(metric.key.toUpperCase());
      continue;
    }
    const score = metric.score(value);
    evidence[metric.key] = round(value, 3);
    evidence[`${metric.key}Score`] = score;
    scores.push(score);
  }

  if (notFound.length > 0) notes.push(`Not found in the payload: ${notFound.join(", ")}.`);

  const per = typeof evidence.per === "number" ? evidence.per : null;
  if (marketPer !== null) {
    evidence.marketPerMedian = round(marketPer, 3);
    if (per !== null && marketPer > 0) {
      evidence.perVsMarket = round(per / marketPer, 3);
      const stance = per < marketPer * 0.9 ? "below" : per > marketPer * 1.1 ? "above" : "in line with";
      notes.push(
        `PE ${round(per, 2)} is ${stance} the IHSG median of ${round(marketPer, 2)}. ` +
          "This is context only — it does not feed the score, and the index median is not a sector peer group.",
      );
    }
  }

  if (scores.length === 0) {
    return {
      name: "valuation",
      label: "Valuation",
      declaredWeight: PILLAR_WEIGHTS.valuation,
      effectiveWeight: 0,
      status: "missing",
      score: null,
      reason: "No valuation metric could be located in the keystats or ratios payload.",
      evidence,
      notes,
    };
  }

  const score = round(clamp(sum(scores) / scores.length));
  const verdict = score > 20 ? "undemanding" : score < -20 ? "demanding" : "unremarkable";

  return {
    name: "valuation",
    label: "Valuation",
    declaredWeight: PILLAR_WEIGHTS.valuation,
    effectiveWeight: 0,
    // Fewer than half the metrics found is a reading, but a thin one.
    status: scores.length >= 3 ? "ok" : "degraded",
    score,
    reason: `On ${scores.length} of ${VALUATION_METRICS.length} absolute bands, the valuation looks ${verdict}.`,
    evidence,
    notes,
  };
}

/* -------------------------------------- confidence -------------------------------------- */

/**
 * Freshness of the price series, in points out of 10.
 *
 * A stale series is not an error — IDX is shut at weekends and on public holidays, and the rest of
 * this codebase is careful to say so. It does mean the reading describes an older market, which is
 * what this component is for.
 */
export function freshnessPoints(lastDate: string | null, now: Date): { points: number; ageDays: number | null } {
  if (!lastDate) return { points: 0, ageDays: null };
  const then = Date.parse(`${lastDate}T00:00:00Z`);
  if (!Number.isFinite(then)) return { points: 0, ageDays: null };

  // `lastDate` is an IDX session date on the Jakarta calendar, so "today" must be too. Reading the
  // UTC date instead makes the two disagree between 00:00 and 07:00 WIB and understates the age by a
  // day for every user in Indonesia — the hours a pre-market check actually happens. IDX is UTC+7
  // with no daylight saving, so a fixed offset is exact rather than approximate; `src/alerts/daemon.ts`
  // already established that convention.
  const jakartaToday = new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  const today = Date.parse(`${jakartaToday}T00:00:00Z`);
  const ageDays = Math.max(0, Math.round((today - then) / 86_400_000));
  const points = ageDays <= 1 ? 10 : ageDays <= 3 ? 8 : ageDays <= 7 ? 5 : ageDays <= 30 ? 2 : 0;
  return { points, ageDays };
}

/* ---------------------------------------- scoring ---------------------------------------- */

export interface ScoreInputs {
  symbol: string;
  pillars: Pillar[];
  context: AnalysisContext;
  warnings?: string[];
  limits?: string[];
  cost?: { pagesFetched: number; upstreamRequests: number; elapsedMs: number };
  now?: Date;
}

/**
 * Combine the pillars.
 *
 * The weight of anything `missing` is redistributed across what remains, so a report built from
 * three pillars is still on a −100…+100 scale — but the redistribution is recorded in
 * `effectiveWeight` and paid for in `confidence.completeness`, so a thinner report reads as a
 * thinner report rather than as an equally-confident one.
 */
export function scoreAnalysis(inputs: ScoreInputs): AnalysisReport {
  const now = inputs.now ?? new Date();
  const pillars = inputs.pillars.map((p) => ({ ...p }));

  const readable = pillars.filter((p) => p.status !== "missing" && p.score !== null);
  const declaredReadable = sum(readable.map((p) => p.declaredWeight));

  for (const p of pillars) {
    p.effectiveWeight =
      p.status === "missing" || p.score === null || declaredReadable <= 0
        ? 0
        : round(p.declaredWeight / declaredReadable, 4);
  }

  const score = readable.length === 0 ? 0 : round(clamp(sum(readable.map((p) => (p.score as number) * p.effectiveWeight))));
  const lean: Lean = score >= LEAN_THRESHOLD ? "bullish" : score <= -LEAN_THRESHOLD ? "bearish" : "neutral";

  /* -- completeness: how much of the intended evidence we actually got -- */
  // A degraded pillar counts half: it was read, but with a caveat that could invert it.
  const gotWeight = sum(
    readable.map((p) => p.declaredWeight * (p.status === "degraded" ? 0.5 : 1)),
  );
  const totalDeclared = sum(pillars.map((p) => p.declaredWeight)) || 1;
  const completeness = round((gotWeight / totalDeclared) * 30, 1);

  /* -- agreement: do the readable pillars point the same way, and are there enough of them to say -- */
  //
  // This is deliberately NOT "share of meaningful weight matching the composite sign", which is what
  // it was first written as and which failed in three ways at once. That form divided a sum by
  // itself whenever exactly one pillar was meaningful, so a lone pillar scored the full 30 — awarding
  // maximum agreement precisely where there is nothing to agree with. It could also fall to 0, below
  // the floor used for no evidence at all, so *adding* a meaningful pillar could lower confidence.
  // And it needed a reference sign, which `Math.sign(score) || 1` silently made bullish when the
  // composite was exactly 0, giving two mirror-image evidence sets different confidence.
  //
  // Two factors instead, neither needing a reference direction:
  //   - `unanimity`: the weighted net direction over its own total, 1 when every meaningful pillar
  //     points the same way and 0 when they cancel exactly;
  //   - `breadth`: how much of the readable weight is actually saying something. One pillar out of
  //     four cannot establish agreement no matter how loudly it speaks, and this is what stops it.
  //
  // Both are 0 when nothing is meaningful, which is the honest reading — no directional agreement
  // has been established — and it makes the component monotone: meaningful evidence can only raise it.
  const meaningful = readable.filter((p) => Math.abs(p.score as number) >= 10);
  const meaningfulWeight = sum(meaningful.map((p) => p.effectiveWeight));
  const netDirection = sum(meaningful.map((p) => Math.sign(p.score as number) * p.effectiveWeight));
  const unanimity = meaningfulWeight > 0 ? Math.abs(netDirection) / meaningfulWeight : 0;
  const breadth = meaningfulWeight; // readable effective weights sum to 1, so this is already a share
  const agreement = round(unanimity * breadth * 30, 1);

  /* -- strength: distance from neutral, saturating at 60 -- */
  const strength = round(Math.min(1, Math.abs(score) / 60) * 20, 1);

  /* -- freshness -- */
  const fresh = freshnessPoints(inputs.context.priceDate, now);

  const value = Math.round(completeness + agreement + strength + fresh.points);
  const label: ConfidenceLabel = value < 40 ? "low" : value < 65 ? "medium" : "high";

  const missing = pillars
    .filter((p) => p.status === "missing")
    .map((p) => `${p.label}: ${p.reason}`);

  const warnings = [...(inputs.warnings ?? [])];
  for (const p of pillars) {
    // EVERY note of a degraded pillar is promoted, not just the last one. Quoting `notes[last]` made
    // the surfaced warning depend on the order a pillar happened to append in — and the floor-lock
    // caveat, the loudest thing this module says, was being displaced by "only one of two
    // sub-signals was readable" whenever both fired. Ordering is too fragile to carry that.
    if (p.status === "degraded") for (const note of p.notes) warnings.push(`${p.label} is degraded — ${note}`);
  }
  if (readable.length === 0) {
    warnings.push(
      "NO pillar could be read. The lean is neutral because there is nothing to lean on — this is " +
        "an absence of evidence, not a balanced verdict.",
    );
  }
  if (fresh.ageDays !== null && fresh.ageDays > 4) {
    warnings.push(
      `The most recent session is ${fresh.ageDays} days old. On a weekend or holiday run that is ` +
        "expected, not an error, but this reading describes that session and not today.",
    );
  }

  return {
    symbol: inputs.symbol,
    asOf: inputs.context.priceDate,
    lean,
    score,
    confidence: {
      value,
      label,
      components: { completeness, agreement, strength, freshness: fresh.points },
      missing,
      wouldChange: wouldChange(pillars, inputs.context, score),
    },
    pillars,
    context: inputs.context,
    warnings,
    limits: inputs.limits ?? [],
    cost: inputs.cost ?? { pagesFetched: 0, upstreamRequests: 0, elapsedMs: 0 },
    disclaimer: DISCLAIMER,
  };
}

/**
 * The two or three observations that would most move this verdict.
 *
 * Built from the pillars that actually carry weight, so it names something the reader can go and
 * watch rather than a generic caution.
 */
function wouldChange(pillars: Pillar[], context: AnalysisContext, score: number): string[] {
  const out: string[] = [];
  const byWeight = [...pillars].sort((a, b) => b.effectiveWeight - a.effectiveWeight);

  const trend = pillars.find((p) => p.name === "trend");
  const dailyStretch = trend?.evidence.dailyCloseVsSlowMaPct;
  if (trend && trend.effectiveWeight > 0 && typeof dailyStretch === "number" && context.lastClose !== null) {
    const slowMa = context.lastClose / (1 + dailyStretch / 100);
    out.push(
      `A daily close ${dailyStretch >= 0 ? "below" : "back above"} roughly ${Math.round(slowMa)} ` +
        "would flip the daily trend vote.",
    );
  }

  const flow = pillars.find((p) => p.name === "brokerFlow");
  // Only name foreign flow if foreign flow was actually read. The pillar can score from broker
  // concentration alone, and telling a reader to watch an input the same report calls unreadable is
  // worse than saying nothing.
  if (flow && flow.effectiveWeight > 0 && typeof flow.score === "number" && flow.evidence.foreignFlowRead === true) {
    out.push(
      `Foreign net flow turning ${flow.score >= 0 ? "negative" : "positive"} over the next week would ` +
        `move the heaviest pillar (${Math.round(flow.effectiveWeight * 100)}% of the weight).`,
    );
  }

  for (const p of byWeight) {
    if (p.status === "missing") {
      // Deliberately not "would add N points". Restoring a pillar also re-enters agreement and
      // changes the composite, so it can lower confidence as easily as raise it — quoting only the
      // completeness term would promise a floor that does not exist.
      out.push(
        `Restoring ${p.label.toLowerCase()} would return ${Math.round(p.declaredWeight * 30)} completeness ` +
          "points and re-open the agreement and strength terms — which can move confidence either way.",
      );
      break;
    }
  }

  if (Math.abs(score) < LEAN_THRESHOLD) {
    out.push(
      `The composite is ${score}, inside the ±${LEAN_THRESHOLD} neutral band — it would take a ` +
        "meaningful move in one heavy pillar to produce a lean at all.",
    );
  }

  return out.slice(0, 4);
}

/* ------------------------------------- orchestration ------------------------------------- */

export interface AnalyzeDeps {
  bars(symbol: string, count: number): Promise<BarSeries>;
  brokerSummary(symbol: string, period: BrokerSummaryPeriod): Promise<BrokerSummary>;
  priceBands(symbol: string): Promise<PriceBands>;
  keystats(symbol: string): Promise<unknown>;
  ratios(symbol: string): Promise<unknown>;
  sentiment(symbol: string, limit: number): Promise<StreamPost[]>;
  now?(): Date;
}

export interface AnalyzeRequest {
  symbol: string;
  /** Daily sessions to pull. Default 260 (~1 trading year) — enough for weekly, not for monthly RSI. */
  bars?: number;
  /** Broker-summary window. Default LAST_7_DAYS. */
  brokerPeriod?: BrokerSummaryPeriod;
  /** Sessions of candlesticks to read. Default 10. */
  patternWindow?: number;
  /** Skip the sentiment fetch. Default false. */
  includeSentiment?: boolean;
}

interface Attempt<T> {
  value: T | null;
  error: string | null;
  /** The original throw, kept so a total failure can rethrow the real cause rather than a summary. */
  cause: unknown;
}

/** Run one source, converting any failure into a reason string instead of an aborted report. */
async function attempt<T>(label: string, run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { value: await run(), error: null, cause: null };
  } catch (err) {
    return { value: null, error: `${label}: ${err instanceof Error ? err.message : String(err)}`, cause: err };
  }
}

/**
 * Refuse to return a report in which nothing could be read.
 *
 * Partial failure degrades; TOTAL failure is an error, and the difference matters more here than
 * anywhere else in this module. A dead session token makes every source throw, and without this
 * the tool would answer `success: true` with `lean: "neutral"` and a confidence of 15 — a result
 * that looks like an analysis and is actually a login prompt. This project has already shipped that
 * exact shape once: `top_movers` returned an empty list forever and was indistinguishable from a
 * working tool because its own description explained the emptiness away.
 *
 * The original error is rethrown rather than summarised, because the caller needs to be told the
 * token is dead — not that "no valuation metric could be located". Explaining a failure with the
 * wrong cause is the other mistake this codebase keeps a record of.
 */
function refuseEmptyReport(pillars: Pillar[], causes: unknown[]): void {
  if (pillars.some((p) => p.status !== "missing")) return;

  const authFailure = causes.find((c) => c instanceof StockbitError && c.kind === "auth");
  if (authFailure) throw authFailure;

  const first = causes.find((c) => c instanceof StockbitError);
  if (first) throw first;

  const reasons = pillars.map((p) => `${p.label}: ${p.reason}`).join(" | ");

  // Nothing threw, so nothing upstream is broken — the symbol simply has too little data to score.
  // Reporting that as `upstream` would name a 5xx-or-network fault that did not happen and imply a
  // transient condition when this one is permanent. `not_found` is the kind `src/http/errors.ts`
  // already defines for "symbol has no data".
  if (causes.every((c) => c == null)) {
    throw new StockbitError(
      "not_found",
      `Every source answered for this symbol, but none of them carried enough data to score. ${reasons}`,
    );
  }

  throw new StockbitError(
    "upstream",
    `Nothing could be read for this symbol, so there is no analysis to report. ${reasons}`,
  );
}

/**
 * Build one pillar, converting a throw from the PURE layer into a missing pillar.
 *
 * The module's contract is that one dead source degrades rather than aborting, and that contract was
 * only half-kept: every I/O call went through `attempt`, but `alignment()` and the pillar builders
 * ran bare. A throw from any of them — a malformed bar, an unexpected shape — killed the whole
 * report including the three pillars that never touched the offending input, and lost the
 * attribution that would say which one failed.
 */
function safePillar(name: PillarName, label: string, build: () => Pillar): Pillar {
  try {
    return build();
  } catch (err) {
    return {
      name,
      label,
      declaredWeight: PILLAR_WEIGHTS[name],
      effectiveWeight: 0,
      status: "missing",
      score: null,
      reason: `Could not be computed: ${err instanceof Error ? err.message : String(err)}`,
      evidence: {},
      notes: [],
    };
  }
}

/**
 * Fetch everything, then score it.
 *
 * **Per-source degradation is the contract.** One dead source must not abort the report — that is
 * the same rule `alert_check` follows for a dead symbol in a batch and `deep_dive` encodes with
 * `optional: true` on its gated step. Every failure lands in the pillar that needed it, and its
 * reason survives into `confidence.missing`.
 *
 * Requests are issued **sequentially**, and that is deliberate rather than lazy. This project's
 * refresh lock is best-effort under contention, and a fan-out of concurrent first-calls is exactly
 * what invalidated the stored session token on 2026-08-05. Six sequential GETs behind the shared
 * 150 ms limiter is a human-shaped request pattern; the bar pages dominate the wall clock anyway.
 */
export async function analyze(request: AnalyzeRequest, deps: AnalyzeDeps): Promise<AnalysisReport> {
  const now = deps.now?.() ?? new Date();
  const started = Date.now();
  const symbol = request.symbol.trim().toUpperCase();
  const barCount = request.bars ?? 260;
  const warnings: string[] = [];

  const barsResult = await attempt("bars", () => deps.bars(symbol, barCount));
  const series = barsResult.value;
  const bars = series?.bars ?? [];
  if (barsResult.error) warnings.push(barsResult.error);
  if (series?.truncated) {
    warnings.push(
      `The bar walk hit its page ceiling: ${series.pagesFetched} pages for ${bars.length} sessions. ` +
        "Longer-timeframe readings may be thinner than requested.",
    );
  }

  // Counted rather than assumed: the old fixed `+ 5` charged for a sentiment fetch that
  // `include_sentiment: false` never issued, and reported 0 pages when the bar walk threw.
  let singleShotReads = 0;
  const readOnce = <T>(label: string, run: () => Promise<T>): Promise<Attempt<T>> => {
    singleShotReads++;
    return attempt(label, run);
  };

  const summaryResult = await readOnce("broker summary", () =>
    deps.brokerSummary(symbol, request.brokerPeriod ?? "LAST_7_DAYS"),
  );
  const bandsResult = await readOnce("price bands", () => deps.priceBands(symbol));
  const keystatsResult = await readOnce("keystats", () => deps.keystats(symbol));
  const ratiosResult = await readOnce("ratios", () => deps.ratios(symbol));

  let sentiment: AnalysisContext["sentiment"] = null;
  if (request.includeSentiment !== false) {
    const streamResult = await readOnce("sentiment", () => deps.sentiment(symbol, 30));
    if (streamResult.value) {
      const posts = streamResult.value;
      sentiment = {
        posts: posts.length,
        latest: posts[0]?.createdAt ?? null,
        note:
          "Post COUNT only. These are not scored: turning Indonesian-language retail posts into a " +
          "directional number needs a classifier this server does not have, and a keyword tally " +
          "would be noise wearing a label.",
      };
    } else if (streamResult.error) {
      warnings.push(streamResult.error);
    }
  }

  let alignmentReport: AlignmentReport | null = null;
  if (bars.length > 0) {
    try {
      alignmentReport = alignment(bars, { symbol });
    } catch (err) {
      warnings.push(`timeframe alignment: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const pillars: Pillar[] = [
    safePillar("brokerFlow", "Broker flow & positioning", () =>
      brokerFlowPillar({ summary: summaryResult.value, bars, bands: bandsResult.value }),
    ),
    safePillar("trend", "Trend & timeframe alignment", () => trendPillar(alignmentReport)),
    safePillar("valuation", "Valuation", () => valuationPillar(keystatsResult.value, ratiosResult.value)),
    safePillar("patterns", "Candlestick patterns", () => patternPillar(bars, request.patternWindow ?? 10)),
  ];

  refuseEmptyReport(pillars, [
    barsResult.cause,
    summaryResult.cause,
    bandsResult.cause,
    keystatsResult.cause,
    ratiosResult.cause,
  ]);

  const last = bars[bars.length - 1] ?? null;
  const limits = [
    "No analyst consensus or price target exists in this server — that data class is not in the " +
      "route table, so nothing here reflects what analysts forecast.",
    "Valuation is scored against absolute bands, not against sector peers.",
    "Community sentiment is reported as a post count and never scored.",
    ...(alignmentReport?.limits ?? []),
  ];

  if (bandsResult.value && bandsResult.value.missing.length > 0) {
    warnings.push(`Price bands partially unavailable: ${bandsResult.value.missing.join(", ")} not in the payload.`);
  }

  return scoreAnalysis({
    symbol,
    pillars,
    context: {
      sentiment,
      bands: bandsResult.value,
      lastClose: last?.close ?? null,
      priceDate: last?.date ?? null,
    },
    warnings,
    limits,
    cost: {
      pagesFetched: series?.pagesFetched ?? 0,
      // Bar pages plus the single-shot reads actually issued. A failed bar walk reports 0 pages
      // because the count comes back with the series — pages it spent before throwing are not
      // observable from here, so this is a floor, not an exact figure.
      upstreamRequests: (series?.pagesFetched ?? 0) + singleShotReads,
      elapsedMs: Date.now() - started,
    },
    now,
  });
}
