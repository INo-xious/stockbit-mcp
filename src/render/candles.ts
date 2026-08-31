/**
 * Candlestick price chart with indicator overlays, sub-panels and an annotation layer.
 *
 * The reason this exists rather than a link to Stockbit's own chart: an assistant answering
 * "is BBRI breaking out?" should be able to *show* the evidence it reasoned from, in the same reply,
 * with the levels it used drawn on it. A screenshot of someone else's chart cannot carry the
 * annotations, and a table of closes is not a chart.
 *
 * ## Panels
 *
 * Price on top, then optionally volume, then optionally one oscillator (RSI or MACD). Panels share
 * one time axis and one x-mapping, so a spike in volume lines up with the bar that caused it. Each
 * panel gets its own y-scale — putting RSI (0-100) and price (thousands) on one axis makes both
 * unreadable.
 *
 * ## Annotations are the "drawing" surface
 *
 * Horizontal levels, trend lines, zones, and markers are declarative inputs rather than a mutation
 * of anything at Stockbit. That distinction is deliberate: ADR-0002 forbids mutating account data,
 * and Stockbit's saved chart drawings are account data. Drawing *on our own render* gives the same
 * analytical value with none of the write surface.
 */
import type { Bar } from "../core/bars.js";
import type { Series } from "../core/indicators.js";
import { esc, humanAmount, THEMES, type ThemeName } from "./theme.js";

export interface Overlay {
  /** Shown in the legend. */
  label: string;
  series: Series;
  color?: string;
  dashed?: boolean;
}

export type Annotation =
  | { kind: "level"; price: number; label?: string; color?: string; dashed?: boolean }
  | { kind: "zone"; from: number; to: number; label?: string; color?: string }
  | { kind: "trend"; fromDate: string; fromPrice: number; toDate: string; toPrice: number; label?: string; color?: string }
  | { kind: "marker"; date: string; price?: number; label: string; color?: string; above?: boolean };

/**
 * The bars that actually reach the plot: a non-finite close cannot be positioned.
 *
 * Exported alongside `barIndexOn` because anything that REPORTS what was drawn has to ask the same
 * two questions the drawing asks, of the same array. A caller filtering `opts.bars` while this
 * filters something else is how a count starts disagreeing with the picture it describes.
 */
export function plottedBars(bars: Bar[]): Bar[] {
  return bars.filter((b) => Number.isFinite(b.close));
}

/**
 * The bar a dated annotation lands on — the first on or after `date` — or -1 when the series ends
 * before it. A date before the first bar snaps to bar 0; only a date past the last one has no home.
 */
export function barIndexOn(bars: Bar[], date: string): number {
  return bars.findIndex((b) => b.date >= date);
}

export interface SubPanel {
  /** Panel heading, e.g. "RSI(14)". */
  label: string;
  series: Array<{ label: string; series: Series; color?: string }>;
  /** Histogram drawn behind the lines, e.g. MACD's. */
  histogram?: Series;
  /** Horizontal guides, e.g. RSI 30/70. */
  guides?: number[];
  /** Fix the scale (RSI is always 0-100); otherwise it is derived from the data. */
  range?: [number, number];
}

export interface CandleChartOptions {
  symbol: string;
  bars: Bar[];
  title?: string;
  subtitle?: string;
  overlays?: Overlay[];
  subPanels?: SubPanel[];
  annotations?: Annotation[];
  showVolume?: boolean;
  width?: number;
  /** Price-panel height. Volume and sub-panels are added below it. */
  priceHeight?: number;
  theme?: ThemeName;
}

const PALETTE = ["#58a6ff", "#e3b341", "#bc8cff", "#39c5cf", "#f778ba", "#7ee787"];

/** Nice round gridline steps — 1/2/5 x powers of ten, so labels read as prices not float noise. */
function niceStep(range: number, target = 6): number {
  if (!(range > 0)) return 1;
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function fmtPrice(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString("en-US");
  if (abs >= 10) return n.toFixed(0);
  return n.toFixed(2);
}

/**
 * Render the chart.
 *
 * An empty bar list produces an explanatory card rather than an empty frame, for the same reason the
 * flow diagram does: a weekend or an untraded symbol is a normal answer, not a failure.
 */
export function renderCandles(opts: CandleChartOptions): string {
  const th = THEMES[opts.theme ?? "dark"] ?? THEMES.dark;
  const W = opts.width ?? 1100;
  const PAD_L = 16;
  const PAD_R = 74; // price axis lives here
  const HEADER = 74;
  const FOOTER = 40;
  const bars = plottedBars(opts.bars);
  const title = opts.title ?? `${opts.symbol} — daily`;

  if (bars.length === 0) {
    const H = HEADER + 80;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: no data">`,
      `<rect width="${W}" height="${H}" fill="${th.bg}"/>`,
      `<text x="20" y="34" font-family="ui-sans-serif,system-ui,sans-serif" font-size="18" font-weight="700" fill="${th.title}">${esc(title)}</text>`,
      `<text x="${W / 2}" y="${HEADER + 30}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="14" fill="${th.muted}">No price data for this window — expected on a weekend, a holiday, or an untraded symbol.</text>`,
      `</svg>`,
    ].join("\n");
  }

  const priceH = opts.priceHeight ?? 340;
  const volH = opts.showVolume === false ? 0 : 78;
  const panels = opts.subPanels ?? [];
  const panelH = 92;
  const GAP = 18;
  const H = HEADER + priceH + (volH ? GAP + volH : 0) + panels.length * (GAP + panelH) + FOOTER;

  const plotW = W - PAD_L - PAD_R;
  const n = bars.length;
  // Band per bar; the candle body uses ~70% so neighbours stay visually separate.
  const band = plotW / n;
  const bodyW = Math.max(1, Math.min(11, band * 0.7));
  const xOf = (i: number): number => PAD_L + band * (i + 0.5);

  /* ------------------------------ price scale ------------------------------ */
  // The scale must cover annotations too, or a level line silently lands off-canvas.
  let lo = Math.min(...bars.map((b) => b.low));
  let hi = Math.max(...bars.map((b) => b.high));
  for (const a of opts.annotations ?? []) {
    if (a.kind === "level") { lo = Math.min(lo, a.price); hi = Math.max(hi, a.price); }
    if (a.kind === "zone") { lo = Math.min(lo, a.from, a.to); hi = Math.max(hi, a.from, a.to); }
    if (a.kind === "trend") { lo = Math.min(lo, a.fromPrice, a.toPrice); hi = Math.max(hi, a.fromPrice, a.toPrice); }
    // Only when it is PRESENT: a marker without a price anchors to its own bar's high or low, which
    // the bar loop above already covers. With one, it is a coordinate like any other — left out, a
    // marker priced above every high was positioned against a scale that did not know about it and
    // its arrow was emitted at a negative y, off the canvas, while the summary said it was drawn.
    // And only when it is DRAWN, which is the same `barIndexOn` test the marker loop below uses: a
    // marker dated past the last session draws nothing, so widening the scale to reach its price
    // would shrink every candle for a triangle that is not on the chart. `trend` above is left as
    // it is on purpose: `src/tools/register.ts` states that tradeoff where it hands one over.
    if (a.kind === "marker" && a.price !== undefined && barIndexOn(bars, a.date) >= 0) {
      lo = Math.min(lo, a.price);
      hi = Math.max(hi, a.price);
    }
  }
  for (const o of opts.overlays ?? []) {
    for (const v of o.series) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (hi === lo) { hi += 1; lo -= 1; }
  const padY = (hi - lo) * 0.06;
  lo -= padY;
  hi += padY;
  const priceTop = HEADER;
  const yOf = (p: number): number => priceTop + priceH - ((p - lo) / (hi - lo)) * priceH;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`,
    `<rect width="${W}" height="${H}" fill="${th.bg}"/>`,
    `<text x="20" y="32" font-family="ui-sans-serif,system-ui,sans-serif" font-size="18" font-weight="700" fill="${th.title}">${esc(title)}</text>`,
  ];
  const sub = opts.subtitle ?? `${bars[0].date} → ${bars[n - 1].date}  ·  ${n} sessions`;
  parts.push(
    `<text x="20" y="52" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="${th.muted}">${esc(sub)}</text>`,
  );

  /* ------------------------------ price grid ------------------------------ */
  const step = niceStep(hi - lo);
  for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) {
    const y = yOf(p);
    parts.push(
      `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="${th.rule}" stroke-width="1"/>`,
      `<text x="${W - PAD_R + 6}" y="${(y + 3.5).toFixed(1)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${th.muted}">${esc(fmtPrice(p))}</text>`,
    );
  }

  /* --------------------------------- zones --------------------------------- */
  // Drawn before candles so they read as background, not as something occluding price.
  for (const a of opts.annotations ?? []) {
    if (a.kind !== "zone") continue;
    const y1 = yOf(Math.max(a.from, a.to));
    const y2 = yOf(Math.min(a.from, a.to));
    parts.push(
      `<rect x="${PAD_L}" y="${y1.toFixed(1)}" width="${plotW}" height="${Math.max(1, y2 - y1).toFixed(1)}" fill="${a.color ?? th.asing}" fill-opacity="0.10"/>`,
    );
    if (a.label) {
      parts.push(
        `<text x="${PAD_L + 6}" y="${(y1 + 12).toFixed(1)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${a.color ?? th.asing}">${esc(a.label)}</text>`,
      );
    }
  }

  /* -------------------------------- candles -------------------------------- */
  const up = th.lokal;
  const down = "#f85149";
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const x = xOf(i);
    const rising = b.close >= b.open;
    const c = rising ? up : down;
    const yO = yOf(b.open);
    const yC = yOf(b.close);
    const top = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yC - yO));
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${yOf(b.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${yOf(b.low).toFixed(1)}" stroke="${c}" stroke-width="1"/>`,
      `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${c}"><title>${esc(b.date)}  O ${esc(fmtPrice(b.open))}  H ${esc(fmtPrice(b.high))}  L ${esc(fmtPrice(b.low))}  C ${esc(fmtPrice(b.close))}</title></rect>`,
    );
  }

  /* -------------------------------- overlays -------------------------------- */
  (opts.overlays ?? []).forEach((o, idx) => {
    const color = o.color ?? PALETTE[idx % PALETTE.length];
    // Break the path wherever the series is undefined, so a warm-up gap is not drawn as a line
    // sloping in from nowhere.
    let d = "";
    let pen = false;
    for (let i = 0; i < Math.min(o.series.length, n); i++) {
      const v = o.series[i];
      if (v === null) { pen = false; continue; }
      d += `${pen ? "L" : "M"} ${xOf(i).toFixed(1)} ${yOf(v).toFixed(1)} `;
      pen = true;
    }
    if (d) {
      parts.push(
        `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.5"${o.dashed ? ' stroke-dasharray="4 3"' : ""}/>`,
      );
    }
  });

  /* ------------------------------ annotations ------------------------------ */
  for (const a of opts.annotations ?? []) {
    if (a.kind === "level") {
      const y = yOf(a.price);
      const c = a.color ?? th.pemerintah;
      parts.push(
        `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${W - PAD_R}" y2="${y.toFixed(1)}" stroke="${c}" stroke-width="1.2" stroke-dasharray="${a.dashed === false ? "none" : "6 4"}"/>`,
        `<text x="${W - PAD_R - 4}" y="${(y - 4).toFixed(1)}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${c}">${esc(a.label ?? fmtPrice(a.price))}</text>`,
      );
    }
    if (a.kind === "trend") {
      const i1 = barIndexOn(bars, a.fromDate);
      const i2 = barIndexOn(bars, a.toDate);
      if (i1 >= 0 && i2 >= 0) {
        const c = a.color ?? th.asing;
        parts.push(
          `<line x1="${xOf(i1).toFixed(1)}" y1="${yOf(a.fromPrice).toFixed(1)}" x2="${xOf(i2).toFixed(1)}" y2="${yOf(a.toPrice).toFixed(1)}" stroke="${c}" stroke-width="1.4"/>`,
        );
        if (a.label) {
          parts.push(
            `<text x="${xOf(i2).toFixed(1)}" y="${(yOf(a.toPrice) - 5).toFixed(1)}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${c}">${esc(a.label)}</text>`,
          );
        }
      }
    }
    if (a.kind === "marker") {
      const i = barIndexOn(bars, a.date);
      if (i >= 0) {
        const b = bars[i];
        const c = a.color ?? th.title;
        const above = a.above !== false;
        const py = a.price ?? (above ? b.high : b.low);
        const y = yOf(py) + (above ? -10 : 14);
        const tri = above
          ? `${xOf(i)},${yOf(py) - 3} ${xOf(i) - 4},${yOf(py) - 9} ${xOf(i) + 4},${yOf(py) - 9}`
          : `${xOf(i)},${yOf(py) + 3} ${xOf(i) - 4},${yOf(py) + 9} ${xOf(i) + 4},${yOf(py) + 9}`;
        parts.push(
          `<polygon points="${tri}" fill="${c}"/>`,
          `<text x="${xOf(i).toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" font-weight="600" fill="${c}">${esc(a.label)}</text>`,
        );
      }
    }
  }

  /* --------------------------------- volume --------------------------------- */
  let cursor = priceTop + priceH;
  if (volH) {
    cursor += GAP;
    const maxVol = Math.max(1, ...bars.map((b) => b.volume));
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      const h = (b.volume / maxVol) * volH;
      parts.push(
        `<rect x="${(xOf(i) - bodyW / 2).toFixed(1)}" y="${(cursor + volH - h).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${b.close >= b.open ? up : down}" fill-opacity="0.55"><title>${esc(b.date)}: ${esc(humanAmount(b.volume))} lots</title></rect>`,
      );
    }
    parts.push(
      `<text x="${PAD_L}" y="${(cursor + 10).toFixed(1)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${th.muted}">Volume  ·  peak ${esc(humanAmount(maxVol))} lots</text>`,
    );
    cursor += volH;
  }

  /* ------------------------------- sub-panels ------------------------------- */
  for (const panel of panels) {
    cursor += GAP;
    const top = cursor;
    let pLo: number;
    let pHi: number;
    if (panel.range) {
      [pLo, pHi] = panel.range;
    } else {
      const vals = [
        ...panel.series.flatMap((s) => s.series.filter((v): v is number => v !== null)),
        ...(panel.histogram ?? []).filter((v): v is number => v !== null),
      ];
      pLo = vals.length ? Math.min(...vals) : 0;
      pHi = vals.length ? Math.max(...vals) : 1;
      if (pHi === pLo) { pHi += 1; pLo -= 1; }
    }
    const pY = (v: number): number => top + panelH - ((v - pLo) / (pHi - pLo)) * panelH;

    parts.push(
      `<rect x="${PAD_L}" y="${top}" width="${plotW}" height="${panelH}" fill="none" stroke="${th.rule}" stroke-width="1"/>`,
      `<text x="${PAD_L + 4}" y="${top + 12}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${th.muted}">${esc(panel.label)}</text>`,
    );
    for (const g of panel.guides ?? []) {
      if (g < pLo || g > pHi) continue;
      parts.push(
        `<line x1="${PAD_L}" y1="${pY(g).toFixed(1)}" x2="${W - PAD_R}" y2="${pY(g).toFixed(1)}" stroke="${th.rule}" stroke-width="1" stroke-dasharray="3 3"/>`,
        `<text x="${W - PAD_R + 6}" y="${(pY(g) + 3.5).toFixed(1)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="9" fill="${th.muted}">${esc(String(g))}</text>`,
      );
    }
    if (panel.histogram) {
      const zero = pY(Math.max(pLo, Math.min(pHi, 0)));
      for (let i = 0; i < Math.min(panel.histogram.length, n); i++) {
        const v = panel.histogram[i];
        if (v === null) continue;
        const y = pY(v);
        parts.push(
          `<rect x="${(xOf(i) - bodyW / 2).toFixed(1)}" y="${Math.min(y, zero).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(0.5, Math.abs(zero - y)).toFixed(1)}" fill="${v >= 0 ? up : down}" fill-opacity="0.5"/>`,
        );
      }
    }
    panel.series.forEach((s, idx) => {
      const color = s.color ?? PALETTE[idx % PALETTE.length];
      let d = "";
      let pen = false;
      for (let i = 0; i < Math.min(s.series.length, n); i++) {
        const v = s.series[i];
        if (v === null) { pen = false; continue; }
        d += `${pen ? "L" : "M"} ${xOf(i).toFixed(1)} ${pY(v).toFixed(1)} `;
        pen = true;
      }
      if (d) parts.push(`<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="1.4"/>`);
    });
    cursor += panelH;
  }

  /* -------------------------------- time axis -------------------------------- */
  const ticks = Math.min(8, n);
  for (let t = 0; t < ticks; t++) {
    const i = Math.round((t / Math.max(1, ticks - 1)) * (n - 1));
    parts.push(
      `<text x="${xOf(i).toFixed(1)}" y="${(cursor + 18).toFixed(1)}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${th.muted}">${esc(bars[i].date)}</text>`,
    );
  }

  /* --------------------------------- legend --------------------------------- */
  const legend = (opts.overlays ?? []).map((o, idx) => ({ label: o.label, color: o.color ?? PALETTE[idx % PALETTE.length] }));
  legend.forEach((l, idx) => {
    const x = PAD_L + idx * 96;
    parts.push(
      `<rect x="${x}" y="${HEADER - 16}" width="9" height="3" rx="1" fill="${l.color}"/>`,
      `<text x="${x + 14}" y="${HEADER - 11}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${th.muted}">${esc(l.label)}</text>`,
    );
  });

  parts.push(
    `<text x="${W - PAD_R}" y="${H - 10}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="9" fill="${th.muted}" opacity="0.75">Unofficial Stockbit data · not financial advice</text>`,
    `</svg>`,
  );
  return parts.join("\n");
}
