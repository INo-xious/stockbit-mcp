import { test } from "node:test";
import assert from "node:assert/strict";
import { renderCandles } from "../src/render/candles.ts";
import { sma, rsi } from "../src/core/indicators.ts";
import type { Bar } from "../src/core/bars.ts";

/** A synthetic series with a known shape: rises, dips, recovers. */
function series(n = 60): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + Math.sin(i / 6) * 12 + i * 0.3;
    const open = base;
    const close = base + (i % 3 === 0 ? -1.5 : 1.2);
    return {
      date: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, "0")}`,
      open,
      high: Math.max(open, close) + 1.4,
      low: Math.min(open, close) - 1.4,
      close,
      average: (open + close) / 2,
      volume: 1000 + (i % 7) * 250,
      value: 1e9,
      frequency: 100,
      change: close - open,
      changePercent: ((close - open) / open) * 100,
      foreignBuy: 0,
      foreignSell: 0,
      netForeign: 0,
    };
  });
}

const bars = series();
const closes = bars.map((b) => b.close);

/* -------------------------------- structure -------------------------------- */

test("renders well-formed SVG with no unresolved arithmetic", () => {
  const svg = renderCandles({ symbol: "BBRI", bars });
  assert.match(svg, /^<svg [^>]*>/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(/NaN|Infinity|undefined/.test(svg), false, "a coordinate did not compute");
});

test("one candle body per bar, each carrying its OHLC in the hover title", () => {
  const svg = renderCandles({ symbol: "BBRI", bars });
  // Volume bars also carry a dated title, so match on the OHLC form specifically.
  const bodies = svg.split("<title>").filter((t) => /^2026-/.test(t) && t.includes(" O ")).length;
  assert.equal(bodies, bars.length, `expected ${bars.length} candle bodies, got ${bodies}`);
  assert.match(svg, /O \d/, "the title should spell out open/high/low/close");
});

test("an empty series renders an explanatory card rather than an empty frame", () => {
  const svg = renderCandles({ symbol: "BBRI", bars: [] });
  assert.match(svg, /No price data/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(/NaN/.test(svg), false);
});

test("a single bar does not divide by zero on a flat price range", () => {
  const one = [{ ...bars[0], open: 100, high: 100, low: 100, close: 100 }];
  const svg = renderCandles({ symbol: "BBRI", bars: one });
  assert.equal(/NaN|Infinity/.test(svg), false);
});

/* --------------------------------- scaling --------------------------------- */

test("the price scale covers annotations, so a level cannot land off-canvas", () => {
  // Without folding annotations into the scale, a level far outside the price range is drawn
  // outside the plot and simply never seen.
  const svg = renderCandles({
    symbol: "BBRI",
    bars,
    annotations: [{ kind: "level", price: 500, label: "far above" }],
  });
  const H = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 0);
  const levelLine = /<line x1="\d+" y1="([\d.]+)"[^>]*stroke-dasharray="6 4"/.exec(svg);
  assert.ok(levelLine, "the level should be drawn");
  const y = Number(levelLine[1]);
  assert.ok(y >= 0 && y <= H, `level drawn at y=${y} on a ${H}px canvas`);
});

test("a marker's own price widens the scale, so its arrow cannot land off-canvas", () => {
  // The scale loop covered level, zone and trend and skipped marker, so a marker priced above every
  // bar high was positioned against a scale that did not know about it: the arrow was emitted at a
  // large negative y, outside the viewBox, while the caller was told the marker had been drawn.
  const above = Math.max(...bars.map((b) => b.high)) + 300;
  const svg = renderCandles({
    symbol: "BBRI",
    bars,
    annotations: [{ kind: "marker", date: bars[30].date, price: above, label: "spike" }],
  });
  const H = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 0);
  const tri = /<polygon points="[-\d.]+,([-\d.]+) /.exec(svg);
  assert.ok(tri, "the marker should draw its arrow");
  const y = Number(tri[1]);
  assert.ok(y >= 0 && y <= H, `marker drawn at y=${y} on a ${H}px canvas`);
  assert.ok(svg.includes("spike"), "and its label with it");
});

test("overlays also widen the scale", () => {
  const svg = renderCandles({
    symbol: "BBRI",
    bars,
    overlays: [{ label: "silly", series: bars.map(() => 400) }],
  });
  assert.equal(/NaN/.test(svg), false);
  assert.match(svg, /silly/, "the overlay should appear in the legend");
});

/* -------------------------------- overlays -------------------------------- */

test("an overlay's warm-up gap breaks the path instead of sloping in from nowhere", () => {
  // SMA(20) is null for the first 19 bars. A single continuous path would draw a line from the
  // origin into the first real value, inventing a trend that does not exist.
  const svg = renderCandles({ symbol: "BBRI", bars, overlays: [{ label: "SMA 20", series: sma(closes, 20) }] });
  const path = /<path d="(M [^"]*)" fill="none"/.exec(svg);
  assert.ok(path, "expected an overlay path");
  const moves = [...path[1].matchAll(/M /g)].length;
  assert.equal(moves, 1, "a contiguous series should need exactly one move");
  // The path must start after the warm-up, not at bar 0.
  const firstX = Number(/M ([\d.]+)/.exec(path[1])![1]);
  assert.ok(firstX > 100, `overlay starts at x=${firstX}, which is inside the warm-up`);
});

test("a series with an interior gap produces multiple subpaths", () => {
  const gappy = closes.map((v, i) => (i > 20 && i < 30 ? null : v));
  const svg = renderCandles({ symbol: "BBRI", bars, overlays: [{ label: "gappy", series: gappy }] });
  const path = /<path d="(M [^"]*)" fill="none"/.exec(svg)![1];
  assert.ok([...path.matchAll(/M /g)].length >= 2, "a gap must break the line, not bridge it");
});

/* ------------------------------- annotations ------------------------------- */

test("each annotation kind renders", () => {
  const svg = renderCandles({
    symbol: "BBRI",
    bars,
    annotations: [
      { kind: "level", price: 110, label: "resistance" },
      { kind: "zone", from: 95, to: 100, label: "demand" },
      { kind: "trend", fromDate: bars[5].date, fromPrice: 98, toDate: bars[40].date, toPrice: 118, label: "uptrend" },
      { kind: "marker", date: bars[30].date, label: "breakout" },
    ],
  });
  for (const label of ["resistance", "demand", "uptrend", "breakout"]) {
    assert.ok(svg.includes(label), `${label} annotation missing`);
  }
  assert.match(svg, /<polygon points=/, "a marker should draw its arrow");
});

test("an annotation on a date outside the series is skipped, not drawn at a wrong bar", () => {
  const svg = renderCandles({
    symbol: "BBRI",
    bars,
    annotations: [{ kind: "marker", date: "2099-01-01", label: "never" }],
  });
  assert.equal(svg.includes("never"), false, "a marker with no matching bar must not be placed arbitrarily");
});

test("SECURITY: annotation labels and symbols cannot inject markup", () => {
  // Labels are caller-supplied and land in markup a browser executes.
  const svg = renderCandles({
    symbol: `X"/><script>a</script>`,
    bars,
    annotations: [{ kind: "level", price: 110, label: `</text><script>b</script>` }],
  });
  assert.equal(svg.includes("<script>"), false, "raw script tag reached the output");
  assert.ok(svg.includes("&lt;script&gt;"), "it should be escaped, not dropped");
});

/* -------------------------------- sub-panels -------------------------------- */

test("an RSI panel uses a fixed 0-100 scale with its guides drawn", () => {
  const svg = renderCandles({
    symbol: "BBRI",
    bars,
    subPanels: [{ label: "RSI(14)", range: [0, 100], guides: [30, 70], series: [{ label: "RSI", series: rsi(closes, 14) }] }],
  });
  assert.match(svg, /RSI\(14\)/);
  assert.ok(svg.includes(">30<") && svg.includes(">70<"), "guide labels should be drawn");
});

test("panels add height rather than overlapping the price panel", () => {
  const base = renderCandles({ symbol: "BBRI", bars });
  const withPanels = renderCandles({
    symbol: "BBRI",
    bars,
    subPanels: [
      { label: "A", series: [{ label: "a", series: closes }] },
      { label: "B", series: [{ label: "b", series: closes }] },
    ],
  });
  const h = (s: string) => Number(/height="(\d+)"/.exec(s)?.[1] ?? 0);
  assert.ok(h(withPanels) > h(base), "two extra panels must make the canvas taller");
});

test("volume can be turned off and shortens the canvas", () => {
  const withVol = renderCandles({ symbol: "BBRI", bars, showVolume: true });
  const without = renderCandles({ symbol: "BBRI", bars, showVolume: false });
  const h = (s: string) => Number(/height="(\d+)"/.exec(s)?.[1] ?? 0);
  assert.ok(h(without) < h(withVol));
  assert.equal(without.includes("Volume"), false);
});

/* ---------------------------------- theme ---------------------------------- */

test("dark is the default and light swaps the ground", () => {
  assert.match(renderCandles({ symbol: "BBRI", bars }), /fill="#0d1117"/);
  assert.match(renderCandles({ symbol: "BBRI", bars, theme: "light" }), /fill="#ffffff"/);
});

/* ------------------------------ absent volume ------------------------------ */

test("a session whose volume the response did not carry draws no volume bar, and no NaN", () => {
  // `null` used to arrive here as `0`, which drew a full-width bar of minimum height — a picture
  // asserting "nothing traded" about a session the payload said nothing about. And `Math.max` over
  // a null makes the panel's scale NaN, which puts y="NaN" on every rect in it.
  const holed = series(20).map((b, i) => (i === 5 ? { ...b, volume: null } : b));
  const svg = renderCandles({ symbol: "BBRI", bars: holed, showVolume: true });
  const full = renderCandles({ symbol: "BBRI", bars: series(20), showVolume: true });
  const countBars = (s: string): number => (s.match(/lots<\/title><\/rect>/g) ?? []).length;

  assert.ok(!svg.includes("NaN"), "no NaN reaches the emitted SVG");
  assert.equal(countBars(svg), countBars(full) - 1, "exactly the unreadable session is left undrawn");
  assert.match(svg, /Volume/, "and the panel is still drawn for the sessions that were readable");
});

test("a series with no readable volume at all still renders the price chart", () => {
  const svg = renderCandles({
    symbol: "BBRI",
    bars: series(20).map((b) => ({ ...b, volume: null })),
    showVolume: true,
  });
  assert.ok(!svg.includes("NaN"));
  assert.ok(svg.includes("<svg"), "an unreadable volume column is not a reason to fail the whole chart");
});
