/**
 * `analyze` tests.
 *
 * Every one runs against constructed pillars or a fake `AnalyzeDeps` — no network, no token, no
 * clock. The module takes its dependencies for the same reason `scan` does, and these tests are
 * what that choice buys.
 *
 * The cases worth naming, because each one guards a decision that could plausibly be "simplified"
 * back into a bug:
 *
 *   - a MISSING pillar must not become a neutral vote (it would silently drag every lean to zero);
 *   - an UNREADABLE timeframe must not dilute the ones that were readable;
 *   - confidence must never exceed 90, and must fall when evidence is removed;
 *   - the fetches must stay SEQUENTIAL — a `Promise.all` here is what killed the session token on
 *     2026-08-05, and nothing else in the type system would notice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISCLAIMER,
  LEAN_THRESHOLD,
  PILLAR_WEIGHTS,
  analyze,
  brokerFlowPillar,
  excessConcentration,
  findNumber,
  freshnessPoints,
  patternPillar,
  scoreAnalysis,
  trendPillar,
  valuationPillar,
  type AnalyzeDeps,
  type Pillar,
  type PillarName,
} from "../src/analysis/analyze.ts";
import type { Bar, BarSeries } from "../src/core/bars.ts";
import type { BrokerSummary } from "../src/core/marketdetectors.ts";
import type { PriceBands } from "../src/core/pricefeed.ts";
import type { AlignmentReport, Timeframe, TimeframeReading } from "../src/analysis/timeframe.ts";
import { detectPatterns } from "../src/analysis/patterns.ts";
import { StockbitError } from "../src/http/errors.ts";

const ANCHOR = Date.parse("2026-08-07T00:00:00Z");
const NOW = new Date("2026-08-07T09:00:00Z");

function dateAt(offsetFromEnd: number, total: number): string {
  return new Date(ANCHOR - (total - 1 - offsetFromEnd) * 86_400_000).toISOString().slice(0, 10);
}

/** Bars with real bodies, so nothing is accidentally a doji. */
function bars(count: number, opts: { start?: number; step?: number; netForeign?: number; value?: number } = {}): Bar[] {
  const start = opts.start ?? 1000;
  const step = opts.step ?? 5;
  return Array.from({ length: count }, (_, i) => {
    const open = start + i * step;
    const close = open + step * 0.6;
    return {
      date: dateAt(i, count),
      open,
      high: Math.max(open, close) + 3,
      low: Math.min(open, close) - 3,
      close,
      average: (open + close) / 2,
      volume: 1000,
      value: opts.value ?? 1e9,
      frequency: 100,
      change: close - open,
      changePercent: 0,
      foreignBuy: 0,
      foreignSell: 0,
      netForeign: opts.netForeign ?? 0,
    };
  });
}

function brokerSummary(buy: number[], sell: number[]): BrokerSummary {
  return {
    symbol: "TEST",
    buyers: buy.map((v, i) => ({ code: `B${i}`, netLots: v / 1000, netValueIdr: v })),
    sellers: sell.map((v, i) => ({ code: `S${i}`, netLots: v / 1000, netValueIdr: v })),
  };
}

const NO_BANDS: PriceBands = {
  symbol: "TEST",
  ara: null,
  arb: null,
  nextAra: null,
  nextArb: null,
  foreignBuy: null,
  foreignSell: null,
  foreignNet: null,
  found: [],
  missing: ["ara", "arb"],
};

function reading(
  tf: Timeframe,
  trend: TimeframeReading["trend"],
  evidence: Partial<TimeframeReading["evidence"]> = {},
): TimeframeReading {
  return {
    timeframe: tf,
    label: tf === "D" ? "Daily" : tf === "W" ? "Weekly" : "Monthly",
    bars: 100,
    sourceSessions: 500,
    droppedPartial: false,
    lastDate: "2026-08-07",
    lastClose: 1000,
    trend,
    evidence: {
      fastMa: 990,
      slowMa: 980,
      closeVsSlowMaPct: 2,
      rsi: 55,
      macdHistogram: 1,
      ...evidence,
    },
    periods: { fast: 20, slow: 50, rsi: 14 },
    unavailable: [],
  };
}

function report(timeframes: TimeframeReading[]): AlignmentReport {
  const score = timeframes.reduce((a, r) => a + (r.trend === "up" ? 1 : r.trend === "down" ? -1 : 0), 0);
  return { symbol: "TEST", timeframes, score, aligned: false, verdict: "constructed", limits: [] };
}

function pillar(name: PillarName, score: number | null, status: Pillar["status"] = "ok"): Pillar {
  return {
    name,
    label: name,
    declaredWeight: PILLAR_WEIGHTS[name],
    effectiveWeight: 0,
    status,
    score,
    reason: "constructed",
    evidence: {},
    notes: status === "degraded" ? ["constructed degradation"] : [],
  };
}

/* ------------------------------------- broker flow ------------------------------------- */

test("foreign money entering scores positive, leaving scores negative", () => {
  const inflow = brokerFlowPillar({
    summary: null,
    bars: bars(30, { netForeign: 2e7, value: 1e9 }),
    bands: NO_BANDS,
  });
  const outflow = brokerFlowPillar({
    summary: null,
    bars: bars(30, { netForeign: -2e7, value: 1e9 }),
    bands: NO_BANDS,
  });

  assert.ok((inflow.score as number) > 0, `expected positive, got ${inflow.score}`);
  assert.ok((outflow.score as number) < 0, `expected negative, got ${outflow.score}`);
  assert.equal(inflow.score, -(outflow.score as number));
});

test("concentrated buying against diffuse selling reads bullish", () => {
  // One broker takes almost everything on the buy side; the sell side is spread over many.
  const concentrated = brokerFlowPillar({
    summary: brokerSummary([900, 50, 30, 10, 10], [200, 200, 200, 200, 200]),
    bars: bars(30),
    bands: NO_BANDS,
  });
  const diffuse = brokerFlowPillar({
    summary: brokerSummary([200, 200, 200, 200, 200], [900, 50, 30, 10, 10]),
    bars: bars(30),
    bands: NO_BANDS,
  });

  assert.ok((concentrated.score as number) > 0);
  assert.ok((diffuse.score as number) < 0);
});

/* --- regression: the top-3 share has a 3/n floor, so raw shares measure broker COUNT --- */

test("two perfectly uniform sides of DIFFERENT sizes score ~0, not ±100", () => {
  // Both sides moved exactly the same money and neither has any concentration at all. Before the
  // floor correction this returned +100 purely because one side had fewer brokers.
  const uniform = (n: number, each: number) => Array.from({ length: n }, () => each);
  const p = brokerFlowPillar({
    summary: brokerSummary(uniform(5, 1_000_000_000), uniform(40, 125_000_000)),
    bars: [],
    bands: null,
  });

  assert.equal(p.score, 0, `count imbalance alone must not move the score, got ${p.score}`);
  assert.equal(p.evidence.buyConcentration, 0);
  assert.equal(p.evidence.sellConcentration, 0);
});

test("the genuinely more concentrated side sets the sign, whatever the broker counts", () => {
  // 6 buyers whose top 3 hold 55% (barely above their 50% floor) against 40 sellers whose top 3
  // hold 45% (far above their 7.5% floor). The sellers are unambiguously the concentrated side.
  const buyers = [22, 22, 11, 15, 15, 15];
  const sellers = [20, 15, 10, ...Array.from({ length: 37 }, () => 55 / 37)];
  const p = brokerFlowPillar({ summary: brokerSummary(buyers, sellers), bars: [], bands: null });

  assert.ok((p.score as number) < 0, `expected bearish, got ${p.score}`);
});

test("a side of three or fewer brokers is refused, not read as maximally concentrated", () => {
  const p = brokerFlowPillar({
    summary: brokerSummary([100, 100, 100], [50, 50, 50, 50, 50, 50]),
    bars: bars(30, { netForeign: 1e7 }),
    bands: null,
  });

  assert.equal(p.evidence.concentrationRead, false);
  assert.match(p.notes.join(" "), /1\.0 by arithmetic and measures nothing/);
  assert.equal(p.status, "degraded");
});

test("a side with no net value at all is refused rather than scored as zero concentration", () => {
  const p = brokerFlowPillar({
    summary: brokerSummary([0, 0, 0, 0], [50, 50, 50, 50]),
    bars: bars(30, { netForeign: 1e7 }),
    bands: null,
  });

  assert.equal(p.evidence.concentrationRead, false);
  assert.match(p.notes.join(" "), /no net value at all/);
});

test("lopsided broker counts are flagged even though the bias is divided out", () => {
  const p = brokerFlowPillar({
    summary: brokerSummary([100, 50, 20, 10], [30, 30, 30, 30, 30, 30, 30, 30, 30, 30]),
    bars: bars(30, { netForeign: 1e7 }),
    bands: null,
  });
  assert.match(p.notes.join(" "), /lopsided \(4 buyers vs 10 sellers\)/);
});

test("excessConcentration reports the raw share and the floor-corrected excess separately", () => {
  assert.equal(excessConcentration([{ netValueIdr: 1 }, { netValueIdr: 1 }, { netValueIdr: 1 }]), null);
  const uniform = excessConcentration(Array.from({ length: 10 }, () => ({ netValueIdr: 5 })));
  assert.equal(uniform?.share, 0.3);
  assert.equal(uniform?.excess, 0);

  const total = excessConcentration([
    { netValueIdr: 100 },
    ...Array.from({ length: 9 }, () => ({ netValueIdr: 0.0001 })),
  ]);
  assert.ok((total?.excess ?? 0) > 0.99, "one broker holding the whole side must approach 1");
});

test("a floor-locked session degrades the flow pillar instead of reading as bearish", () => {
  const series = bars(30, { netForeign: -2e7 });
  const last = series[series.length - 1];
  const bands: PriceBands = { ...NO_BANDS, arb: last.close, found: ["arb"], missing: [] };

  const locked = brokerFlowPillar({ summary: brokerSummary([100], [100]), bars: series, bands });

  assert.equal(locked.status, "degraded");
  assert.match(locked.notes.join(" "), /FLOOR-LOCKED/);
  assert.match(locked.notes.join(" "), /not as bearish/);
});

test("no readable sub-signal makes the flow pillar missing, never zero", () => {
  const p = brokerFlowPillar({ summary: null, bars: [], bands: null });
  assert.equal(p.status, "missing");
  assert.equal(p.score, null);
});

/* ---------------------------------------- trend ---------------------------------------- */

test("an unreadable timeframe abstains — it does not dilute the readable ones", () => {
  const withUnreadable = trendPillar(
    report([
      reading("D", "up"),
      reading("W", "up"),
      reading("M", "flat", { fastMa: null, slowMa: null, closeVsSlowMaPct: null }),
    ]),
  );
  const withGenuineFlat = trendPillar(report([reading("D", "up"), reading("W", "up"), reading("M", "flat")]));

  // Two up votes out of two readable must beat two out of three.
  assert.ok(
    (withUnreadable.score as number) > (withGenuineFlat.score as number),
    `abstention ${withUnreadable.score} should exceed genuine-flat ${withGenuineFlat.score}`,
  );
  assert.equal(withUnreadable.evidence.timeframesRead, 2);
  assert.equal(withUnreadable.evidence.timeframesAbstained, 1);
  assert.equal(withUnreadable.status, "degraded");
  assert.match(withUnreadable.notes.join(" "), /not counted as neutral/);

  // The reason must describe what the pillar COUNTED. Reusing alignment()'s verdict said "every
  // timeframe points up" in the same payload that reported two of them abstaining.
  assert.match(withUnreadable.reason, /Of the 2 timeframes with readable moving averages/);
  assert.match(withUnreadable.reason, /Monthly abstained/);
  assert.ok(!/Monthly up/.test(withUnreadable.reason), "an abstaining timeframe must not be quoted as a vote");
});

test("a trend nobody could read is missing, not neutral", () => {
  const p = trendPillar(
    report([reading("D", "flat", { fastMa: null, slowMa: null }), reading("W", "flat", { fastMa: null, slowMa: null })]),
  );
  assert.equal(p.status, "missing");
  assert.equal(p.score, null);

  assert.equal(trendPillar(null).status, "missing");
});

test("all timeframes down scores negative, all up scores positive", () => {
  const down = trendPillar(
    report([
      reading("D", "down", { closeVsSlowMaPct: -4 }),
      reading("W", "down", { closeVsSlowMaPct: -4 }),
      reading("M", "down", { closeVsSlowMaPct: -4 }),
    ]),
  );
  const up = trendPillar(report([reading("D", "up"), reading("W", "up"), reading("M", "up")]));

  assert.ok((down.score as number) < -50);
  assert.ok((up.score as number) > 50);
});

/* --------------------------------------- patterns --------------------------------------- */

test("too few bars makes the pattern pillar missing", () => {
  assert.equal(patternPillar(bars(6)).status, "missing");
});

test("no qualifying pattern is a real neutral reading, not a missing one", () => {
  const p = patternPillar(bars(60));
  assert.equal(p.status, "ok");
  assert.equal(p.score, 0);
  assert.match(p.notes.join(" "), /genuine neutral evidence/);
});

test("a detected bullish reversal pushes the pattern pillar positive", () => {
  // A downtrend, then a bar whose body engulfs the previous one — the textbook bullish engulfing.
  const series = bars(40, { start: 2000, step: -8 });
  const prev = series[series.length - 2];
  const last = series[series.length - 1];
  prev.open = 1700;
  prev.close = 1680;
  prev.high = 1710;
  prev.low = 1670;
  last.open = 1670;
  last.close = 1720;
  last.high = 1730;
  last.low = 1660;

  // Assert the precondition rather than assuming it: if the fixture stops triggering the detector,
  // this test must fail loudly instead of passing vacuously.
  const detections = detectPatterns(series, { since: 10, minConfidence: 0.6 });
  assert.ok(
    detections.some((d) => d.direction === "bullish"),
    `fixture produced no bullish detection: ${JSON.stringify(detections.map((d) => d.pattern))}`,
  );

  assert.ok((patternPillar(series).score as number) > 0);
});

/* -------------------------------------- valuation -------------------------------------- */

test("findNumber digs a named metric out of an unmapped payload", () => {
  const payload = { data: { valuation: [{ label: "x" }, { PER: "12.5", PBV: { value: "1,200.5" } }] } };
  assert.equal(findNumber(payload, ["per"]), 12.5);
  assert.equal(findNumber(payload, ["pbv"]), 1200.5);
  assert.equal(findNumber(payload, ["nothing_like_this"]), null);
});

test("an empty string is absent, not zero", () => {
  assert.equal(findNumber({ per: "" }, ["per"]), null);
});

test("findNumber survives a cycle", () => {
  const a: Record<string, unknown> = { name: "a" };
  a.self = a;
  assert.equal(findNumber(a, ["per"]), null);
});

/**
 * Build a payload in the shape Stockbit ACTUALLY returns.
 *
 * These fixtures used to be flat (`{ per: 6, pbv: 0.8 }`) and every test passed, because the parser
 * made the same wrong assumption. The real payload nests named items, so valuation was `missing` for
 * every stock on the live API while the suite stayed green. Fixtures written from the same belief as
 * the code cannot falsify that belief — this helper exists so the shape is stated in exactly one
 * place and a future test cannot quietly reintroduce the flat one.
 *
 * `wrap` selects between the two real row shapes: keystats flattens, ratios nests under `fitem`.
 */
function finPayload(items: Record<string, string | number>, wrap: "flat" | "fitem" = "fitem"): unknown {
  return {
    closure_fin_items_results: [
      {
        fin_name_results: Object.entries(items).map(([name, value]) =>
          wrap === "flat"
            ? { fitem_name: name, fitem_value: String(value) }
            : { fitem: { id: "0", name, value: String(value) } },
        ),
      },
    ],
  };
}

const PER = "Current PE Ratio (TTM)";
const PBV = "Current Price to Book Value";
const ROE = "Return on Equity (TTM)";
const DER = "Debt to Equity Ratio (Quarter)";

test("cheap fundamentals score above expensive ones", () => {
  const cheap = valuationPillar({}, finPayload({ [PER]: 6, [PBV]: 0.8, [ROE]: 25, [DER]: 0.3 }));
  const expensive = valuationPillar({}, finPayload({ [PER]: 60, [PBV]: 8, [ROE]: -5, [DER]: 4 }));

  assert.ok((cheap.score as number) > 0, `cheap scored ${cheap.score}`);
  assert.ok((expensive.score as number) < 0, `expensive scored ${expensive.score}`);
  assert.equal(cheap.status, "ok");
});

test("both real row shapes are read — keystats flattens, ratios nests under fitem", () => {
  // The two endpoints disagree about the row shape. Reading only one of them is the bug that made
  // valuation vanish, so both must be pinned.
  const nested = valuationPillar({}, finPayload({ [PER]: 6, [PBV]: 0.8, [ROE]: 25, [DER]: 0.3 }, "fitem"));
  const flat = valuationPillar(finPayload({ [PER]: 6, [PBV]: 0.8, [ROE]: 25, [DER]: 0.3 }, "flat"), {});
  assert.equal(nested.evidence.per, 6);
  assert.equal(flat.evidence.per, 6, "the keystats row shape must parse too");
  assert.equal(flat.score, nested.score);
});

test("presentation in the value is parsed, and a dash means absent rather than zero", () => {
  // Values arrive as display strings: "17.30%", "1,390.55". A literal "-" means the metric does not
  // apply to this issuer — a bank has no inventory turnover — and zero would score as excellent.
  const p = valuationPillar({}, finPayload({ [PER]: "8.00", [ROE]: "17.30%", [PBV]: "1,234.50", [DER]: "-" }));
  assert.equal(p.evidence.roe, 17.3, "a percent suffix must be stripped, not parsed as NaN");
  assert.equal(p.evidence.pbv, 1234.5, "a thousands separator must not truncate the number");
  assert.equal(p.evidence.der, undefined, "a dash must not become 0");
  assert.match(p.notes.join(" "), /Not found in the payload: DER/);
});

test("a loss-making company is not treated as infinitely cheap", () => {
  const loss = valuationPillar({}, finPayload({ [PER]: -12 }));
  assert.ok((loss.score as number) < 0);
});

test("a thin valuation read is degraded, not passed off as a full one", () => {
  const thin = valuationPillar({}, finPayload({ [PER]: 10 }));
  assert.equal(thin.status, "degraded");
  assert.match(thin.notes.join(" "), /Not found in the payload: PBV, ROE, DER/);

  const full = valuationPillar({}, finPayload({ [PER]: 10, [PBV]: 1, [ROE]: 15, [DER]: 0.5 }));
  assert.equal(full.status, "ok");
});

test("ratios win over keystats when both carry the same metric", () => {
  // Two sibling unmapped endpoints are searched with the same names; the precedence must be pinned,
  // not left to whichever argument happens to be first.
  const p = valuationPillar(finPayload({ [PER]: 60 }, "flat"), finPayload({ [PER]: 6 }));
  assert.equal(p.evidence.per, 6);
});

test("the IHSG median is reported as context and never folded into the score", () => {
  // It is the only peer reference in the payload, but it is the whole market rather than a sector,
  // so letting it move the score would quietly change what the absolute bands mean.
  const withMedian = valuationPillar({}, finPayload({ [PER]: 8, "IHSG PE Ratio TTM (Median)": 7.99 }));
  const without = valuationPillar({}, finPayload({ [PER]: 8 }));

  assert.equal(withMedian.evidence.marketPerMedian, 7.99);
  assert.equal(withMedian.score, without.score, "context must not move the score");
  assert.match(withMedian.notes.join(" "), /in line with the IHSG median/);
  assert.match(withMedian.notes.join(" "), /does not feed the score/);
});

test("no locatable metric makes valuation missing, and it always says it has no peer denominator", () => {
  const p = valuationPillar({ unrelated: true }, { alsoUnrelated: 1 });
  assert.equal(p.status, "missing");
  assert.equal(p.score, null);
  assert.match(p.notes.join(" "), /ABSOLUTE bands, not peers/);
});

/* ------------------------------------- composition ------------------------------------- */

const CONTEXT = { sentiment: null, bands: null, lastClose: 1000, priceDate: "2026-08-07" };

test("a missing pillar contributes nothing and its weight is redistributed", () => {
  const out = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 80), pillar("trend", 80), pillar("valuation", null, "missing"), pillar("patterns", 80)],
    context: CONTEXT,
    now: NOW,
  });

  const valuation = out.pillars.find((p) => p.name === "valuation")!;
  assert.equal(valuation.effectiveWeight, 0);

  const live = out.pillars.filter((p) => p.status !== "missing");
  assert.equal(round(live.reduce((a, p) => a + p.effectiveWeight, 0)), 1);
  // Everything readable said +80, so the composite must still be +80 — not dragged toward zero.
  assert.equal(out.score, 80);
  assert.equal(out.lean, "bullish");
});

test("removing evidence can only lower confidence", () => {
  const full = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 60), pillar("trend", 60), pillar("valuation", 60), pillar("patterns", 60)],
    context: CONTEXT,
    now: NOW,
  });
  const thinner = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 60), pillar("trend", 60), pillar("valuation", null, "missing"), pillar("patterns", 60)],
    context: CONTEXT,
    now: NOW,
  });

  assert.ok(
    thinner.confidence.components.completeness < full.confidence.components.completeness,
    "a missing pillar must cost completeness",
  );
  assert.ok(thinner.confidence.value < full.confidence.value);
  assert.equal(thinner.confidence.missing.length, 1);
});

test("confidence never exceeds 90, however good the evidence is", () => {
  const out = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 100), pillar("trend", 100), pillar("valuation", 100), pillar("patterns", 100)],
    context: CONTEXT,
    now: NOW,
  });

  assert.equal(out.confidence.value, 90);
  assert.equal(out.confidence.label, "high");
  assert.equal(out.score, 100);
  assert.match(out.disclaimer, /NOT the probability/);
  assert.equal(out.disclaimer, DISCLAIMER);
});

test("pillars that disagree cost agreement, not completeness", () => {
  const agree = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 70), pillar("trend", 70), pillar("valuation", 70), pillar("patterns", 70)],
    context: CONTEXT,
    now: NOW,
  });
  const split = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 70), pillar("trend", -70), pillar("valuation", 70), pillar("patterns", -70)],
    context: CONTEXT,
    now: NOW,
  });

  assert.equal(split.confidence.components.completeness, agree.confidence.components.completeness);
  assert.ok(split.confidence.components.agreement < agree.confidence.components.agreement);
});

/* --- regression: agreement must not award its maximum to a lone pillar --- */

test("one meaningful pillar cannot establish agreement, however loud it is", () => {
  const lone = scoreAnalysis({
    symbol: "TEST",
    // Only brokerFlow says anything; the rest are readable but sub-threshold.
    pillars: [pillar("brokerFlow", 100), pillar("trend", 2), pillar("valuation", 0), pillar("patterns", -1)],
    context: CONTEXT,
    now: NOW,
  });
  const unanimous = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 100), pillar("trend", 100), pillar("valuation", 100), pillar("patterns", 100)],
    context: CONTEXT,
    now: NOW,
  });

  assert.ok(
    lone.confidence.components.agreement < 30,
    `a single meaningful pillar must not score full agreement, got ${lone.confidence.components.agreement}`,
  );
  assert.ok(lone.confidence.components.agreement < unanimous.confidence.components.agreement);
  assert.equal(unanimous.confidence.components.agreement, 30);
});

test("adding a meaningful pillar can never LOWER agreement", () => {
  const one = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 40), pillar("trend", 1), pillar("valuation", 0), pillar("patterns", 0)],
    context: CONTEXT,
    now: NOW,
  });
  const two = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 40), pillar("trend", 40), pillar("valuation", 0), pillar("patterns", 0)],
    context: CONTEXT,
    now: NOW,
  });

  assert.ok(two.confidence.components.agreement >= one.confidence.components.agreement);
});

test("mirror-image evidence gets identical confidence — there is no bullish default", () => {
  // Composite lands exactly on 0 in both. The old code substituted a +1 reference sign, which gave
  // the bullish arrangement more agreement than its exact mirror.
  const mk = (a: number, b: number) =>
    scoreAnalysis({
      symbol: "TEST",
      pillars: [pillar("brokerFlow", a), pillar("trend", b), pillar("valuation", a), pillar("patterns", b)],
      context: CONTEXT,
      now: NOW,
    });

  const up = mk(60, -60);
  const down = mk(-60, 60);
  assert.deepEqual(up.confidence.components, down.confidence.components);
  assert.equal(up.confidence.value, down.confidence.value);
});

test("evidence that cancels exactly scores no agreement", () => {
  const split = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 60), pillar("trend", -60), pillar("valuation", 60), pillar("patterns", -60)],
    context: CONTEXT,
    now: NOW,
  });
  // brokerFlow .35 + valuation .20 = .55 up against trend .30 + patterns .15 = .45 down.
  assert.ok(split.confidence.components.agreement < 10, `got ${split.confidence.components.agreement}`);
});

test("a degraded pillar is counted at half completeness", () => {
  const ok = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 50), pillar("trend", 50), pillar("valuation", 50), pillar("patterns", 50)],
    context: CONTEXT,
    now: NOW,
  });
  const degraded = scoreAnalysis({
    symbol: "TEST",
    pillars: [
      pillar("brokerFlow", 50, "degraded"),
      pillar("trend", 50),
      pillar("valuation", 50),
      pillar("patterns", 50),
    ],
    context: CONTEXT,
    now: NOW,
  });

  // Assert the HALF, not merely "less" — which would hold for any factor in [0, 1).
  const lostWeight = PILLAR_WEIGHTS.brokerFlow * 0.5;
  assert.equal(
    degraded.confidence.components.completeness,
    Number((ok.confidence.components.completeness - lostWeight * 30).toFixed(1)),
  );
  assert.match(degraded.warnings.join(" "), /degraded/);
});

test("EVERY note of a degraded pillar reaches warnings — the floor-lock caveat cannot be displaced", () => {
  // Both conditions fire: the stock is floor-locked AND only one sub-signal was readable. Promoting
  // only the last note buried the floor-lock explanation behind the milder one.
  const series = bars(30, { netForeign: -2e7 });
  const last = series[series.length - 1];
  const flow = brokerFlowPillar({
    summary: null, // forces "only one of two sub-signals"
    bars: series,
    bands: { ...NO_BANDS, arb: last.close, found: ["arb"], missing: [] },
  });

  assert.ok(flow.notes.length >= 2, "this fixture must produce more than one note");
  const out = scoreAnalysis({
    symbol: "TEST",
    pillars: [flow, pillar("trend", 10), pillar("valuation", 10), pillar("patterns", 10)],
    context: CONTEXT,
    now: NOW,
  });

  assert.match(out.warnings.join(" "), /FLOOR-LOCKED/);
  assert.match(out.warnings.join(" "), /not as bearish/);
});

test("when nothing could be read the report says so instead of shrugging neutrally", () => {
  const out = scoreAnalysis({
    symbol: "TEST",
    pillars: [
      pillar("brokerFlow", null, "missing"),
      pillar("trend", null, "missing"),
      pillar("valuation", null, "missing"),
      pillar("patterns", null, "missing"),
    ],
    context: { ...CONTEXT, priceDate: null },
    now: NOW,
  });

  assert.equal(out.score, 0);
  assert.equal(out.lean, "neutral");
  assert.match(out.warnings.join(" "), /absence of evidence, not a balanced verdict/);
  assert.equal(out.confidence.components.completeness, 0);
  assert.ok(out.confidence.value < 40);
  assert.equal(out.confidence.label, "low");
});

test("the neutral band is honoured on both sides", () => {
  const mk = (score: number) =>
    scoreAnalysis({
      symbol: "TEST",
      pillars: [pillar("brokerFlow", score), pillar("trend", score), pillar("valuation", score), pillar("patterns", score)],
      context: CONTEXT,
      now: NOW,
    }).lean;

  assert.equal(mk(LEAN_THRESHOLD), "bullish");
  assert.equal(mk(LEAN_THRESHOLD - 1), "neutral");
  assert.equal(mk(-LEAN_THRESHOLD), "bearish");
  assert.equal(mk(-(LEAN_THRESHOLD - 1)), "neutral");
});

test("stale price data costs freshness and is flagged without being called an error", () => {
  assert.equal(freshnessPoints("2026-08-07", NOW).points, 10);
  assert.equal(freshnessPoints("2026-08-04", NOW).points, 8);
  assert.equal(freshnessPoints("2026-08-01", NOW).points, 5);
  assert.equal(freshnessPoints("2026-07-20", NOW).points, 2);
  // Past a month there is nothing fresh left to credit.
  assert.equal(freshnessPoints("2026-01-05", NOW).points, 0);
  assert.equal(freshnessPoints(null, NOW).points, 0);

  const stale = scoreAnalysis({
    symbol: "TEST",
    pillars: [pillar("brokerFlow", 50), pillar("trend", 50), pillar("valuation", 50), pillar("patterns", 50)],
    context: { ...CONTEXT, priceDate: "2026-07-20" },
    now: NOW,
  });
  assert.match(stale.warnings.join(" "), /expected, not an error/);
});

/* ------------------------------------ orchestration ------------------------------------ */

interface FakeOptions {
  throwFor?: Set<string>;
  barCount?: number;
  /** Throw the real shape a dead token produces, rather than a generic Error. */
  authFailure?: boolean;
  truncated?: boolean;
}

function fakeDeps(opts: FakeOptions = {}) {
  const calls: string[] = [];
  // Arguments are recorded, not just call names — otherwise no request option is proven to reach
  // its source and every default could be silently wrong.
  const seen: { barCount?: number; brokerPeriod?: string; sentimentLimit?: number } = {};
  let inFlight = 0;
  let peakInFlight = 0;

  const guard = async <T>(name: string, produce: () => T): Promise<T> => {
    calls.push(name);
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    await Promise.resolve();
    await Promise.resolve();
    inFlight--;
    if (opts.throwFor?.has(name)) {
      throw opts.authFailure
        ? new StockbitError(
            "auth",
            "Refresh failed (HTTP 401) — the stored refresh token is no longer valid. Run `stockbit-auth login` to re-authenticate.",
            { status: 401 },
          )
        : new Error(`${name} exploded`);
    }
    return produce();
  };

  const deps: AnalyzeDeps = {
    bars: (symbol, count) =>
      guard("bars", (): BarSeries => {
        seen.barCount = count;
        return {
          symbol,
          bars: bars(opts.barCount ?? 120, { netForeign: 1e7 }),
          truncated: opts.truncated ?? false,
          pagesFetched: 10,
        };
      }),
    brokerSummary: (_symbol, period) =>
      guard("brokerSummary", () => {
        seen.brokerPeriod = period;
        return brokerSummary([500, 100, 50, 30, 20], [200, 150, 120, 100, 80]);
      }),
    priceBands: (symbol) => guard("priceBands", () => ({ ...NO_BANDS, symbol })),
    // Real shapes: keystats flattens its rows, ratios nests them under `fitem`.
    keystats: () => guard("keystats", () => finPayload({ [PER]: 10, [PBV]: 1.2 }, "flat")),
    ratios: () => guard("ratios", () => finPayload({ [ROE]: 18, [DER]: 0.6 })),
    sentiment: (_symbol, limit) =>
      guard("sentiment", () => {
        seen.sentimentLimit = limit;
        return [{ id: "1", createdAt: "2026-08-07", content: "hi" }];
      }),
    now: () => NOW,
  };

  return { deps, calls, seen, peak: () => peakInFlight };
}

test("analyze composes every source into one report", async () => {
  const { deps, calls } = fakeDeps();
  const out = await analyze({ symbol: "bbri" }, deps);

  assert.equal(out.symbol, "BBRI");
  assert.equal(out.asOf, "2026-08-07");
  assert.equal(out.pillars.length, 4);
  assert.equal(out.pillars.filter((p) => p.status === "missing").length, 0);
  assert.deepEqual(calls, ["bars", "brokerSummary", "priceBands", "keystats", "ratios", "sentiment"]);
  assert.ok(out.cost.upstreamRequests > 0);
});

test("the fetches stay SEQUENTIAL — concurrency here is what killed the session token once", async () => {
  const { deps, peak } = fakeDeps();
  await analyze({ symbol: "BBRI" }, deps);
  assert.equal(peak(), 1, "no two upstream reads may overlap");
});

test("one dead source degrades its pillar and never aborts the report", async () => {
  const { deps } = fakeDeps({ throwFor: new Set(["brokerSummary"]) });
  const out = await analyze({ symbol: "BBRI" }, deps);

  // Foreign flow still resolves from the bars, so the pillar survives in degraded form.
  const flow = out.pillars.find((p) => p.name === "brokerFlow")!;
  assert.equal(flow.status, "degraded");
  assert.match(flow.notes.join(" "), /Broker summary unavailable/);
  assert.equal(out.pillars.length, 4);
});

test("losing the bars costs the pillars that need them, and only those", async () => {
  const { deps } = fakeDeps({ throwFor: new Set(["bars"]) });
  const out = await analyze({ symbol: "BBRI" }, deps);

  // Trend and patterns are pure functions of the price series, so they go missing.
  const missing = out.pillars.filter((p) => p.status === "missing").map((p) => p.name);
  assert.deepEqual(missing.sort(), ["patterns", "trend"]);
  assert.match(out.warnings.join(" "), /bars: bars exploded/);

  // Broker concentration comes from the summary alone, so flow SURVIVES the loss — degraded, with
  // its remaining sub-signal named. Degrading per source rather than per request is the point.
  const flow = out.pillars.find((p) => p.name === "brokerFlow")!;
  assert.equal(flow.status, "degraded");
  assert.match(flow.notes.join(" "), /Foreign flow not read/);

  // Valuation never needed bars either.
  assert.equal(out.pillars.find((p) => p.name === "valuation")!.status, "ok");

  // And the surviving pillars must carry the whole weight between them.
  const live = out.pillars.filter((p) => p.status !== "missing");
  assert.equal(Number(live.reduce((a, p) => a + p.effectiveWeight, 0).toFixed(6)), 1);
});

test("sentiment is reported as a count and never scored", async () => {
  const { deps } = fakeDeps();
  const out = await analyze({ symbol: "BBRI" }, deps);

  assert.equal(out.context.sentiment?.posts, 1);
  assert.match(out.context.sentiment?.note ?? "", /never scored|not scored/);
  assert.ok(!out.pillars.some((p) => p.name === ("sentiment" as PillarName)));
  assert.match(out.limits.join(" "), /never scored/);
});

test("sentiment can be skipped without disturbing anything else", async () => {
  const { deps, calls } = fakeDeps();
  const out = await analyze({ symbol: "BBRI", includeSentiment: false }, deps);

  assert.ok(!calls.includes("sentiment"));
  assert.equal(out.context.sentiment, null);
  assert.equal(out.pillars.filter((p) => p.status === "missing").length, 0);
});

test("a report in which NOTHING could be read is an error, not a neutral verdict", async () => {
  const { deps } = fakeDeps({
    throwFor: new Set(["bars", "brokerSummary", "priceBands", "keystats", "ratios", "sentiment"]),
  });

  // The failure mode this guards against is the one this project already shipped once: a tool that
  // answers success with a confident-looking neutral when in truth it saw nothing at all.
  await assert.rejects(
    () => analyze({ symbol: "BBRI" }, deps),
    (err: Error) => {
      assert.match(err.message, /Nothing could be read|exploded/);
      return true;
    },
  );
});

test("a dead session token surfaces AS an auth error, not as 'no valuation metric found'", async () => {
  const { deps } = fakeDeps({
    throwFor: new Set(["bars", "brokerSummary", "priceBands", "keystats", "ratios", "sentiment"]),
    authFailure: true,
  });

  await assert.rejects(
    () => analyze({ symbol: "BBRI" }, deps),
    (err: unknown) => {
      assert.ok(err instanceof StockbitError, "the original StockbitError must survive");
      assert.equal(err.kind, "auth");
      assert.match(err.message, /stockbit-auth login/);
      return true;
    },
  );
});

test("a partial failure still returns a report — only a total one throws", async () => {
  const { deps } = fakeDeps({ throwFor: new Set(["bars", "brokerSummary"]), authFailure: true });
  const out = await analyze({ symbol: "BBRI" }, deps);
  assert.equal(out.pillars.find((p) => p.name === "valuation")!.status, "ok");
});

test("the report always states what it structurally cannot say, INCLUDING the alignment report's own limits", async () => {
  const { deps } = fakeDeps();
  const out = await analyze({ symbol: "BBRI" }, deps);

  const limits = out.limits.join(" ");
  assert.match(limits, /No analyst consensus/);
  assert.match(limits, /absolute bands, not against sector peers/);
  // These come from alignment(), not from this module — a dropped spread would lose them silently.
  assert.match(limits, /Weekly and Monthly here are resampled/);
  assert.match(limits, /No 4H \/ 1H \/ 15m OHLC exists/);
});

test("every request option actually reaches its source, and the defaults are the documented ones", async () => {
  const { deps, seen } = fakeDeps();
  await analyze({ symbol: "BBRI" }, deps);
  assert.equal(seen.barCount, 260);
  assert.equal(seen.brokerPeriod, "LAST_7_DAYS");
  assert.equal(seen.sentimentLimit, 30);

  const custom = fakeDeps();
  await analyze({ symbol: "BBRI", bars: 55, brokerPeriod: "YEAR_TO_DATE" }, custom.deps);
  assert.equal(custom.seen.barCount, 55);
  assert.equal(custom.seen.brokerPeriod, "YEAR_TO_DATE");
});

test("a symbol whose sources all answer but carry no data is not_found, not an upstream fault", async () => {
  const deps: AnalyzeDeps = {
    // Everything succeeds; there is simply nothing to score.
    bars: async (symbol) => ({ symbol, bars: [], truncated: false, pagesFetched: 1 }),
    brokerSummary: async () => ({ symbol: "X", buyers: [], sellers: [] }),
    priceBands: async (symbol) => ({ ...NO_BANDS, symbol }),
    keystats: async () => ({}),
    ratios: async () => ({}),
    sentiment: async () => [],
    now: () => NOW,
  };

  await assert.rejects(
    () => analyze({ symbol: "THIN" }, deps),
    (err: unknown) => {
      assert.ok(err instanceof StockbitError);
      assert.equal(err.kind, "not_found", "nothing threw, so this is not an upstream fault");
      assert.match(err.message, /none of them carried enough data/);
      return true;
    },
  );
});

test("a throw from the PURE layer degrades one pillar instead of aborting the report", async () => {
  const { deps } = fakeDeps();
  // A malformed session date survives the fetch and detonates inside alignment() — `bucketKey`
  // builds a Date from it and `toISOString` throws RangeError on an invalid one. Before the pure
  // layer was wrapped, this killed the whole report including the pillars that never touch dates.
  const poisoned: AnalyzeDeps = {
    ...deps,
    bars: async (symbol) => {
      const rows = bars(120, { netForeign: 1e7 });
      rows[rows.length - 1] = { ...rows[rows.length - 1], date: "not-a-date" };
      return { symbol, bars: rows, truncated: false, pagesFetched: 10 };
    },
  };

  const out = await analyze({ symbol: "BBRI" }, poisoned);

  assert.match(out.warnings.join(" "), /timeframe alignment:/);
  assert.equal(out.pillars.find((p) => p.name === "trend")!.status, "missing");
  // The three pillars that never needed the alignment report must survive.
  assert.equal(out.pillars.filter((p) => p.status !== "missing").length, 3);
});

test("a pattern window that scans nothing is missing, not a fabricated neutral", () => {
  const p = patternPillar(bars(60), 0);
  assert.equal(p.status, "missing");
  assert.equal(p.score, null);
  assert.match(p.reason, /scans no sessions/);
});

test("the pattern pillar reads the MOST RECENT detections, not the geometrically tidiest", () => {
  // Five older bearish detections plus one newer bullish one. Selecting by shape confidence (what
  // topPatterns does — it is a chart-marker cap) would drop the newest entirely.
  const series = bars(40, { start: 2000, step: -8 });
  const engulf = (i: number, bullish: boolean) => {
    const prev = series[i - 1];
    const cur = series[i];
    if (bullish) {
      prev.open = 1700; prev.close = 1680; prev.high = 1710; prev.low = 1670;
      cur.open = 1670; cur.close = 1720; cur.high = 1730; cur.low = 1660;
    } else {
      prev.open = 1680; prev.close = 1700; prev.high = 1710; prev.low = 1670;
      cur.open = 1720; cur.close = 1660; cur.high = 1730; cur.low = 1650;
    }
  };
  engulf(39, true);

  const detections = detectPatterns(series, { since: 10, minConfidence: 0.6 });
  assert.ok(detections.some((d) => d.index === 39), "the newest bar must produce a detection");

  const p = patternPillar(series, 10);
  const dates = (p.evidence.detections as Array<{ date: string }>).map((d) => d.date);
  assert.equal(dates[0], series[39].date, "the newest detection must be first");
});

test("cost counts the reads actually issued, not a fixed five", async () => {
  const withSentiment = fakeDeps();
  const a = await analyze({ symbol: "BBRI" }, withSentiment.deps);
  assert.equal(a.cost.upstreamRequests, 10 + 5);

  const without = fakeDeps();
  const b = await analyze({ symbol: "BBRI", includeSentiment: false }, without.deps);
  assert.equal(b.cost.upstreamRequests, 10 + 4, "a skipped sentiment fetch must not be charged");
});

test("a truncated bar walk is reported rather than passed off as a complete series", async () => {
  const { deps } = fakeDeps({ truncated: true });
  const out = await analyze({ symbol: "BBRI" }, deps);
  assert.match(out.warnings.join(" "), /hit its page ceiling/);
});

function round(v: number): number {
  return Number(v.toFixed(6));
}
