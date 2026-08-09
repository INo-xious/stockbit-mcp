/**
 * Candlestick pattern detection over daily bars.
 *
 * Pure functions on `Bar[]`, the same shape as `levels()` in `src/core/indicators.ts`, so a
 * detection drops straight into the chart's marker annotations. Costs nothing upstream: any caller
 * that already has bars already has everything this needs.
 *
 * ## Four decisions, each of which is wrong in an obvious-looking way
 *
 * **Prior trend is part of the pattern, not decoration.** A hammer and a hanging man are the *same
 * candle*. So are an inverted hammer and a shooting star. The only thing separating a bullish
 * reversal from a bearish one is what price did before it. A detector that reports the shape and
 * calls it the signal will find bullish reversals at the top of every rally, confidently. So
 * `trendAt` gates every reversal pattern, and `ignoreContext` exists but is off.
 *
 * **Thresholds scale with the bar's own range, never with a percentage of price.** A body worth
 * 0.1% of price is an ordinary session on a Rp 10,000 bank and a physically impossible one on a
 * Rp 50 stock whose tick is Rp 1. Every test here is a ratio of body to range or shadow to body, so
 * the same shape scores the same at any price level.
 *
 * **Zero-range bars are skipped explicitly.** IDX auto-rejection produces sessions where
 * `high === low === close`, which is 0/0 in every ratio in this file. On small caps that is a
 * weekly occurrence, not an edge case, and `NaN` propagating into a confidence score would surface
 * as a silently missing detection rather than as an error.
 *
 * **`confidence` scores the SHAPE, and nothing else.** It measures how closely this instance matches
 * the textbook proportions. It is not a probability that the pattern works, it is not backtested,
 * and it says nothing about what happened next. If you want to know whether a pattern is worth
 * acting on, that is what `backtest` is for.
 */
import type { Bar } from "../core/bars.js";
import { atr } from "../core/indicators.js";

export type PatternId =
  | "doji"
  | "hammer"
  | "inverted_hammer"
  | "shooting_star"
  | "hanging_man"
  | "marubozu"
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "piercing_line"
  | "dark_cloud_cover"
  | "bullish_harami"
  | "bearish_harami"
  | "morning_star"
  | "evening_star"
  | "three_white_soldiers"
  | "three_black_crows";

export type PatternDirection = "bullish" | "bearish" | "indecision";
export type TrendContext = "uptrend" | "downtrend" | "range";

export interface Detection {
  pattern: PatternId;
  label: string;
  /** Index of the bar that COMPLETES the pattern, so it aligns with any series over the same bars. */
  index: number;
  date: string;
  direction: PatternDirection;
  /** Bars the pattern spans, ending at `index`. */
  bars: number;
  /** The prior trend this was read against — the thing that makes a reversal mean anything. */
  context: TrendContext;
  /**
   * 0–1: how closely this instance matches the textbook proportions.
   *
   * NOT a probability. See the module note.
   */
  confidence: number;
  /** The measured ratios the score came from, so a reader can disagree with the scoring. */
  detail: Record<string, number>;
}

export interface PatternOptions {
  /** Restrict to these patterns. Default: all. */
  only?: PatternId[];
  /** Bars used to judge the prior trend. Default 5. */
  trendLookback?: number;
  /** Drop detections below this. Default 0.5 — under that the shape is barely the shape. */
  minConfidence?: number;
  /** Report reversal patterns even where the prior trend does not support them. Default false. */
  ignoreContext?: boolean;
  /** Only consider the last N bars. Default: all. */
  since?: number;
}

/* ------------------------------------ bar geometry ------------------------------------ */

const body = (b: Bar): number => Math.abs(b.close - b.open);
const range = (b: Bar): number => b.high - b.low;
const upperShadow = (b: Bar): number => b.high - Math.max(b.open, b.close);
const lowerShadow = (b: Bar): number => Math.min(b.open, b.close) - b.low;
const isUp = (b: Bar): boolean => b.close > b.open;
const isDown = (b: Bar): boolean => b.close < b.open;

/** A session with no range at all — IDX auto-rejection, or simply no trading. */
const isDegenerate = (b: Bar): boolean => range(b) <= 0;

/** Clamp to 0–1 and round, so a score never leaves this module as 1.0000000002 or -0. */
const score = (value: number): number => Number(Math.min(1, Math.max(0, value)).toFixed(3));

/**
 * The prior trend at `i`, from the sign of the least-squares slope of the preceding closes,
 * measured against the bar's own volatility rather than against a fixed percentage.
 *
 * Slope alone would call a 0.2% drift a downtrend on a quiet stock and miss a real one on a noisy
 * one. Dividing by ATR asks the only question that matters: is this move large relative to how much
 * this stock normally moves?
 */
export function trendAt(bars: Bar[], i: number, lookback = 5): TrendContext {
  const start = i - lookback;
  if (start < 0) return "range";

  const window = bars.slice(start, i);
  if (window.length < 2) return "range";

  const n = window.length;
  const meanX = (n - 1) / 2;
  const meanY = window.reduce((a, b) => a + b.close, 0) / n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    num += (k - meanX) * (window[k].close - meanY);
    den += (k - meanX) ** 2;
  }
  if (den === 0) return "range";
  const slope = num / den;

  // ATR over whatever history is available up to i, so the threshold is in the stock's own units.
  const volSeries = atr(bars.slice(0, i + 1), Math.min(14, Math.max(2, i)));
  const vol = volSeries[volSeries.length - 1] ?? meanY * 0.01;
  const perBarMove = slope * (n - 1);
  const threshold = (vol || meanY * 0.01) * 0.75;

  if (perBarMove > threshold) return "uptrend";
  if (perBarMove < -threshold) return "downtrend";
  return "range";
}

/* -------------------------------------- detectors -------------------------------------- */

interface Hit {
  direction: PatternDirection;
  confidence: number;
  detail: Record<string, number>;
}

interface PatternDef {
  label: string;
  /** Bars the pattern spans, ending at the index passed to `detect`. */
  bars: number;
  /** Which prior trends make this pattern meaningful. Empty means any. */
  requires: TrendContext[];
  detect(bars: Bar[], i: number): Hit | null;
}

/** A body this small relative to its range is a doji whatever else it is. */
const DOJI_BODY_RATIO = 0.1;

export const PATTERNS: Record<PatternId, PatternDef> = {
  doji: {
    label: "Doji",
    bars: 1,
    requires: [],
    detect: (bars, i) => {
      const b = bars[i];
      const r = range(b);
      const ratio = body(b) / r;
      if (ratio > DOJI_BODY_RATIO) return null;
      return { direction: "indecision", confidence: score(1 - ratio / DOJI_BODY_RATIO), detail: { bodyToRange: Number(ratio.toFixed(4)) } };
    },
  },

  hammer: {
    label: "Hammer",
    bars: 1,
    // Same candle as a hanging man. Only the prior trend separates them, which is why `requires`
    // is not optional metadata.
    requires: ["downtrend"],
    detect: (bars, i) => longLowerShadow(bars[i], "bullish"),
  },

  hanging_man: {
    label: "Hanging Man",
    bars: 1,
    requires: ["uptrend"],
    detect: (bars, i) => longLowerShadow(bars[i], "bearish"),
  },

  inverted_hammer: {
    label: "Inverted Hammer",
    bars: 1,
    requires: ["downtrend"],
    detect: (bars, i) => longUpperShadow(bars[i], "bullish"),
  },

  shooting_star: {
    label: "Shooting Star",
    bars: 1,
    requires: ["uptrend"],
    detect: (bars, i) => longUpperShadow(bars[i], "bearish"),
  },

  marubozu: {
    label: "Marubozu",
    bars: 1,
    requires: [],
    detect: (bars, i) => {
      const b = bars[i];
      const r = range(b);
      const bodyRatio = body(b) / r;
      if (bodyRatio < 0.9) return null;
      return {
        direction: isUp(b) ? "bullish" : "bearish",
        confidence: score((bodyRatio - 0.9) / 0.1),
        detail: { bodyToRange: Number(bodyRatio.toFixed(4)) },
      };
    },
  },

  bullish_engulfing: {
    label: "Bullish Engulfing",
    bars: 2,
    requires: ["downtrend"],
    detect: (bars, i) => engulfing(bars, i, "bullish"),
  },

  bearish_engulfing: {
    label: "Bearish Engulfing",
    bars: 2,
    requires: ["uptrend"],
    detect: (bars, i) => engulfing(bars, i, "bearish"),
  },

  piercing_line: {
    label: "Piercing Line",
    bars: 2,
    requires: ["downtrend"],
    detect: (bars, i) => {
      const [prev, cur] = [bars[i - 1], bars[i]];
      if (!isDown(prev) || !isUp(cur)) return null;
      if (cur.open >= prev.close) return null; // must open below the prior close
      const midpoint = (prev.open + prev.close) / 2;
      if (cur.close <= midpoint || cur.close >= prev.open) return null;
      const penetration = (cur.close - prev.close) / (prev.open - prev.close);
      return {
        direction: "bullish",
        confidence: score((penetration - 0.5) / 0.5),
        detail: { penetration: Number(penetration.toFixed(4)) },
      };
    },
  },

  dark_cloud_cover: {
    label: "Dark Cloud Cover",
    bars: 2,
    requires: ["uptrend"],
    detect: (bars, i) => {
      const [prev, cur] = [bars[i - 1], bars[i]];
      if (!isUp(prev) || !isDown(cur)) return null;
      if (cur.open <= prev.close) return null; // must open above the prior close
      const midpoint = (prev.open + prev.close) / 2;
      if (cur.close >= midpoint || cur.close <= prev.open) return null;
      const penetration = (prev.close - cur.close) / (prev.close - prev.open);
      return {
        direction: "bearish",
        confidence: score((penetration - 0.5) / 0.5),
        detail: { penetration: Number(penetration.toFixed(4)) },
      };
    },
  },

  bullish_harami: {
    label: "Bullish Harami",
    bars: 2,
    requires: ["downtrend"],
    detect: (bars, i) => harami(bars, i, "bullish"),
  },

  bearish_harami: {
    label: "Bearish Harami",
    bars: 2,
    requires: ["uptrend"],
    detect: (bars, i) => harami(bars, i, "bearish"),
  },

  morning_star: {
    label: "Morning Star",
    bars: 3,
    requires: ["downtrend"],
    detect: (bars, i) => star(bars, i, "bullish"),
  },

  evening_star: {
    label: "Evening Star",
    bars: 3,
    requires: ["uptrend"],
    detect: (bars, i) => star(bars, i, "bearish"),
  },

  three_white_soldiers: {
    label: "Three White Soldiers",
    bars: 3,
    requires: ["downtrend", "range"],
    detect: (bars, i) => soldiers(bars, i, "bullish"),
  },

  three_black_crows: {
    label: "Three Black Crows",
    bars: 3,
    requires: ["uptrend", "range"],
    detect: (bars, i) => soldiers(bars, i, "bearish"),
  },
};

/* --------------------------------- shared shape tests --------------------------------- */

function longLowerShadow(b: Bar, direction: PatternDirection): Hit | null {
  const r = range(b);
  const bodyLen = body(b);
  const lower = lowerShadow(b);
  const upper = upperShadow(b);
  // Textbook: a small body near the top, a lower shadow at least twice the body, little above.
  if (bodyLen === 0 ? lower / r < 0.6 : lower < bodyLen * 2) return null;
  if (upper > bodyLen && upper / r > 0.15) return null;
  const shadowToRange = lower / r;
  if (shadowToRange < 0.5) return null;
  return {
    direction,
    confidence: score((shadowToRange - 0.5) / 0.4),
    detail: {
      lowerShadowToRange: Number(shadowToRange.toFixed(4)),
      bodyToRange: Number((bodyLen / r).toFixed(4)),
      upperShadowToRange: Number((upper / r).toFixed(4)),
    },
  };
}

function longUpperShadow(b: Bar, direction: PatternDirection): Hit | null {
  const r = range(b);
  const bodyLen = body(b);
  const upper = upperShadow(b);
  const lower = lowerShadow(b);
  if (bodyLen === 0 ? upper / r < 0.6 : upper < bodyLen * 2) return null;
  if (lower > bodyLen && lower / r > 0.15) return null;
  const shadowToRange = upper / r;
  if (shadowToRange < 0.5) return null;
  return {
    direction,
    confidence: score((shadowToRange - 0.5) / 0.4),
    detail: {
      upperShadowToRange: Number(shadowToRange.toFixed(4)),
      bodyToRange: Number((bodyLen / r).toFixed(4)),
      lowerShadowToRange: Number((lower / r).toFixed(4)),
    },
  };
}

function engulfing(bars: Bar[], i: number, direction: PatternDirection): Hit | null {
  const [prev, cur] = [bars[i - 1], bars[i]];
  const wantUp = direction === "bullish";
  if (wantUp ? !isDown(prev) || !isUp(cur) : !isUp(prev) || !isDown(cur)) return null;

  const prevTop = Math.max(prev.open, prev.close);
  const prevBottom = Math.min(prev.open, prev.close);
  const curTop = Math.max(cur.open, cur.close);
  const curBottom = Math.min(cur.open, cur.close);
  if (curTop < prevTop || curBottom > prevBottom) return null;

  const prevBody = body(prev);
  const curBody = body(cur);
  // A previous body of zero is a doji, and "engulfing a doji" is not the pattern — every candle
  // engulfs a point. Requiring a real body to engulf is what keeps this meaningful.
  if (prevBody <= 0) return null;
  const ratio = curBody / prevBody;
  if (ratio < 1) return null;
  return {
    direction,
    confidence: score((ratio - 1) / 1.5),
    detail: { bodyRatio: Number(ratio.toFixed(4)) },
  };
}

function harami(bars: Bar[], i: number, direction: PatternDirection): Hit | null {
  const [prev, cur] = [bars[i - 1], bars[i]];
  const wantUp = direction === "bullish";
  if (wantUp ? !isDown(prev) || !isUp(cur) : !isUp(prev) || !isDown(cur)) return null;

  const prevTop = Math.max(prev.open, prev.close);
  const prevBottom = Math.min(prev.open, prev.close);
  const curTop = Math.max(cur.open, cur.close);
  const curBottom = Math.min(cur.open, cur.close);
  if (curTop > prevTop || curBottom < prevBottom) return null;

  const prevBody = body(prev);
  if (prevBody <= 0) return null;
  const containment = 1 - body(cur) / prevBody;
  if (containment < 0.3) return null;
  return { direction, confidence: score((containment - 0.3) / 0.5), detail: { containment: Number(containment.toFixed(4)) } };
}

function star(bars: Bar[], i: number, direction: PatternDirection): Hit | null {
  const [first, middle, last] = [bars[i - 2], bars[i - 1], bars[i]];
  const wantUp = direction === "bullish";

  if (wantUp ? !isDown(first) || !isUp(last) : !isUp(first) || !isDown(last)) return null;

  // The middle bar is the star: a small body, gapped away from the first.
  const middleBody = body(middle);
  const firstBody = body(first);
  if (firstBody <= 0) return null;
  if (middleBody > firstBody * 0.4) return null;

  const firstMid = (first.open + first.close) / 2;
  const penetration = wantUp ? (last.close - firstMid) / (first.open - firstMid) : (firstMid - last.close) / (firstMid - first.open);
  if (!Number.isFinite(penetration) || penetration <= 0) return null;

  return {
    direction,
    confidence: score(Math.min(1, penetration) * (1 - middleBody / (firstBody * 0.4)) ** 0.5),
    detail: {
      penetration: Number(penetration.toFixed(4)),
      starBodyToFirst: Number((middleBody / firstBody).toFixed(4)),
    },
  };
}

function soldiers(bars: Bar[], i: number, direction: PatternDirection): Hit | null {
  const three = [bars[i - 2], bars[i - 1], bars[i]];
  const wantUp = direction === "bullish";
  if (three.some((b) => (wantUp ? !isUp(b) : !isDown(b)))) return null;

  // Each must open inside the previous body and close beyond its close: a staircase, not a gap run.
  for (let k = 1; k < 3; k++) {
    const prev = three[k - 1];
    const cur = three[k];
    const prevTop = Math.max(prev.open, prev.close);
    const prevBottom = Math.min(prev.open, prev.close);
    if (cur.open < prevBottom || cur.open > prevTop) return null;
    if (wantUp ? cur.close <= prev.close : cur.close >= prev.close) return null;
  }

  const bodies = three.map((b) => body(b) / range(b));
  const weakest = Math.min(...bodies);
  if (weakest < 0.5) return null;
  return {
    direction,
    confidence: score((weakest - 0.5) / 0.4),
    detail: { weakestBodyToRange: Number(weakest.toFixed(4)) },
  };
}

/* -------------------------------------- the sweep -------------------------------------- */

export function detectPatterns(bars: Bar[], opts: PatternOptions = {}): Detection[] {
  const lookback = opts.trendLookback ?? 5;
  const minConfidence = opts.minConfidence ?? 0.5;
  const wanted = opts.only ?? (Object.keys(PATTERNS) as PatternId[]);
  const firstIndex = opts.since === undefined ? 0 : Math.max(0, bars.length - opts.since);

  const out: Detection[] = [];

  for (let i = firstIndex; i < bars.length; i++) {
    for (const id of wanted) {
      const def = PATTERNS[id];
      if (!def) continue;
      if (i < def.bars - 1) continue;

      // A degenerate bar anywhere in the span makes every ratio 0/0. Skipping is not defensive
      // tidiness here — IDX auto-rejection produces these weekly on small caps.
      const span = bars.slice(i - def.bars + 1, i + 1);
      if (span.some(isDegenerate)) continue;

      const hit = def.detect(bars, i);
      if (!hit) continue;

      const context = trendAt(bars, i - def.bars + 1, lookback);
      if (!opts.ignoreContext && def.requires.length > 0 && !def.requires.includes(context)) continue;
      if (hit.confidence < minConfidence) continue;

      out.push({
        pattern: id,
        label: def.label,
        index: i,
        date: bars[i].date,
        direction: hit.direction,
        bars: def.bars,
        context,
        confidence: hit.confidence,
        detail: hit.detail,
      });
    }
  }

  return out;
}

/**
 * The strongest detections, newest first — what a chart or a summary should show.
 *
 * The chart's marker annotations have no collision avoidance and silently drop any marker without a
 * label, so a caller that draws every detection on a 120-bar chart gets an unreadable smear and no
 * warning. Capping here rather than at each call site means every consumer gets the same limit.
 */
export function topPatterns(detections: Detection[], limit = 8): Detection[] {
  return [...detections]
    .sort((a, b) => b.confidence - a.confidence || b.index - a.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index);
}
