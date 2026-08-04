/**
 * Broker-distribution flow diagram, rendered as SVG.
 *
 * The data is inherently bipartite — each top broker has a list of counterparties it traded against
 * — so a Sankey-style flow reads it directly: sources on the left, counterparties on the right,
 * ribbon thickness proportional to the amount that moved. A table of the same numbers makes you
 * reconstruct that mentally; the picture is the point.
 *
 * ## Why SVG, and why no dependency
 *
 * This project ships two runtime dependencies on purpose. A raster renderer (`canvas`, `sharp`,
 * `puppeteer`, `resvg`) means a native build, tens of megabytes, and a platform matrix — a steep
 * price for drawing a few hundred shapes. SVG is a string: this module has no imports beyond the
 * types it needs, opens in any browser, and scales without loss.
 *
 * ## Escaping is a security control here, not tidiness
 *
 * Broker codes and investor types arrive from Stockbit's API and are interpolated into markup that
 * a browser will execute. Every interpolated value goes through `esc()`. Losing that turns a hostile
 * or merely malformed API response into script execution in whatever opens the file.
 */

export interface FlowParty {
  code: string;
  investorType?: string;
  amount: number;
}

export interface FlowBroker extends FlowParty {
  distributedWith: FlowParty[];
}

export interface SankeyOptions {
  symbol: string;
  /** "IDR" or "lots" — shown in the header and on labels. */
  unit: string;
  from?: string;
  to?: string;
  /**
   * Each counterparty's TRUE total, by code.
   *
   * Without this a seller's bar would be labelled with only the flow from the buyers drawn — for
   * TPIA that was 374.54B against a real total of 615.57B, i.e. 61%, and 16% for a thinner broker.
   * The bar shows the seller's whole position; the ribbons explain the part attributable to the
   * buyers on the left, so a partially-filled bar is information, not a rendering fault.
   */
  targetTotals?: Map<string, number>;
  /** Max source brokers to draw. */
  topSources?: number;
  /** Max counterparties to draw; the remainder collapse into an "others" band. */
  topTargets?: number;
  /**
   * Max ribbons drawn per source broker; the rest of that source's flow merges into one band.
   *
   * Without this the chart is a hairball: 8 sources against ~50 counterparties each is 400 curves,
   * and at that density the ribbons stop encoding anything a reader can follow. The tail is still
   * represented — as a single band per source — so nothing is silently dropped.
   */
  maxFlowsPerSource?: number;
  width?: number;
  /** Palette. Defaults to dark. */
  theme?: ThemeName;
  /** Market board, echoed into the subtitle so the reader knows what was included. */
  board?: string;
}

/** Escape text for inclusion in SVG markup. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ThemeName = "dark" | "light";

export interface Theme {
  bg: string;
  title: string;
  muted: string;
  rule: string;
  /** Ribbon alpha — dark needs more to read against a low-luminance background. */
  ribbonAlpha: number;
  asing: string;
  lokal: string;
  pemerintah: string;
  unknown: string;
  /** Column-header accents. Buying and selling are opposite roles; colour says so at a glance. */
  buyer: string;
  seller: string;
}

/**
 * Palettes.
 *
 * Dark is the default: these charts are read next to terminals and editors, and the hues are picked
 * for contrast against a dark ground (the light theme's #2563eb/#059669 go muddy there, which is
 * exactly the failure that makes a chart unreadable rather than merely ugly).
 */
export const THEMES: Record<ThemeName, Theme> = {
  dark: {
    bg: "#0d1117",
    title: "#e6edf3",
    muted: "#8b949e",
    rule: "#21262d",
    ribbonAlpha: 0.34,
    asing: "#58a6ff",
    lokal: "#3fb950",
    pemerintah: "#e3b341",
    unknown: "#8b949e",
    buyer: "#3fb950",
    seller: "#f85149",
  },
  light: {
    bg: "#ffffff",
    title: "#111827",
    muted: "#6b7280",
    rule: "#e5e7eb",
    ribbonAlpha: 0.22,
    asing: "#2563eb",
    lokal: "#059669",
    pemerintah: "#d97706",
    unknown: "#6b7280",
    buyer: "#059669",
    seller: "#dc2626",
  },
};

/** Colour by investor class. Stockbit labels these in Indonesian. */
export function colorFor(investorType?: string, theme: Theme = THEMES.dark): string {
  const t = (investorType ?? "").toLowerCase();
  if (t.startsWith("asing")) return theme.asing; // foreign
  if (t.startsWith("lokal")) return theme.lokal; // local
  if (t.startsWith("pemerintah")) return theme.pemerintah; // government
  return theme.unknown;
}

/** Compact IDR/lots for a label: 1_234_567_890 -> "1.23B". */
export function humanAmount(n: number): string {
  const abs = Math.abs(n);
  if (!Number.isFinite(n)) return "-";
  if (abs >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

interface Node {
  code: string;
  investorType?: string;
  total: number;
  y: number;
  h: number;
}

/**
 * Build the diagram.
 *
 * Degenerate inputs are handled by drawing an explanatory card rather than emitting broken markup:
 * an empty broker list (weekend, holiday, or an un-traded symbol) and an all-zero total both
 * produce a readable "no flows" image instead of a division by zero.
 */
export function renderSankey(brokers: FlowBroker[], opts: SankeyOptions): string {
  const th = THEMES[opts.theme ?? "dark"] ?? THEMES.dark;
  const W = opts.width ?? 1080;
  const PAD = 28;
  const HEADER = 108;
  const FOOTER = 34;
  const COL_W = 128;
  const GAP = 9;
  const title = `${opts.symbol} — broker distribution`;
  const range = opts.from && opts.to ? (opts.from === opts.to ? opts.from : `${opts.from} → ${opts.to}`) : "";
  // Which role each column holds. The API gives "top buyers and who they bought FROM" or "top
  // sellers and who they sold TO", so the left role flips with `side` and the right is its opposite.
  // Always buyers -> sellers, matching Stockbit's own layout. One canonical direction means a
  // reader never has to work out which way round a given chart is.
  const leftRole = "Buyer";
  const rightRole = "Seller";
  const sideLabel = "who the top buyers bought FROM";

  const sources = brokers
    .filter((b) => Number.isFinite(b.amount))
    .slice(0, Math.max(1, opts.topSources ?? 8));

  /* ------------------------------- degenerate ------------------------------- */
  const grandTotal = sources.reduce((s, b) => s + Math.abs(b.amount), 0);
  if (sources.length === 0 || grandTotal <= 0) {
    const H = HEADER + 90;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: no flows">`,
      `<rect width="${W}" height="${H}" fill="${th.bg}"/>`,
      header(title, range, sideLabel, opts.unit, W, th),
      `<text x="${W / 2}" y="${HEADER + 44}" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="15" fill="${th.muted}">No broker flows for this window — expected on a weekend, a public holiday, or an untraded symbol.</text>`,
      `</svg>`,
    ].join("\n");
  }

  /* ---------------------------------- flows ---------------------------------- */
  /*
   * Decide every ribbon FIRST, then size the nodes from exactly that set.
   *
   * The earlier version did the opposite — it sized target nodes from one population (counterparties
   * ranked past `topTargets`) while routing ribbons from another (each source's flows past
   * `maxFlowsPerSource`). Those are different pools, so ribbons overflowed the bar they terminated
   * in and ran off the bottom of the canvas, kept counterparties received no ribbon at all, and when
   * nothing happened to be globally dropped the folded tail was discarded in silence.
   *
   * Deriving the bars from the ribbons makes that class of disagreement unrepresentable: a node's
   * height IS the sum of what lands on it.
   */
  const OTHERS = " others";
  const keepPerSource = Math.max(1, opts.maxFlowsPerSource ?? 6);

  interface Drawn {
    src: number;
    target: string;
    investorType?: string;
    amount: number;
  }
  const drawn: Drawn[] = [];
  /** Distinct counterparties folded into the others band, for an honest "+N" label. */
  const foldedCodes = new Set<string>();

  sources.forEach((b, i) => {
    const ranked = b.distributedWith
      .filter((c) => Number.isFinite(c.amount) && c.amount !== 0)
      .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));

    for (const c of ranked.slice(0, keepPerSource)) {
      drawn.push({ src: i, target: c.code, investorType: c.investorType, amount: Math.abs(c.amount) });
    }
    const tail = ranked.slice(keepPerSource);
    const tailAmount = tail.reduce((s, c) => s + Math.abs(c.amount), 0);
    if (tailAmount > 0) {
      for (const c of tail) foldedCodes.add(c.code);
      drawn.push({ src: i, target: OTHERS, amount: tailAmount });
    }
  });

  // Rank counterparties by the flow actually drawn to them, then fold everything past `topTargets`
  // into the SAME bucket — so a node is never left on the canvas with nothing arriving at it.
  const drawnTotals = (): Map<string, { investorType?: string; total: number }> => {
    const m = new Map<string, { investorType?: string; total: number }>();
    for (const d of drawn) {
      const cur = m.get(d.target) ?? { investorType: d.investorType, total: 0 };
      cur.total += d.amount;
      m.set(d.target, cur);
    }
    return m;
  };

  const targetLimit = Math.max(1, opts.topTargets ?? 12);
  const realRanked = [...drawnTotals().entries()]
    .filter(([code]) => code !== OTHERS)
    .sort((a, b) => b[1].total - a[1].total);
  const keptCodes = new Set(realRanked.slice(0, targetLimit).map(([code]) => code));
  for (const [code] of realRanked.slice(targetLimit)) foldedCodes.add(code);
  for (const d of drawn) {
    if (d.target !== OTHERS && !keptCodes.has(d.target)) d.target = OTHERS;
  }

  // Recomputed AFTER folding, so every node equals the ribbons that land on it.
  const finalTotals = drawnTotals();
  const othersLabel = `+${foldedCodes.size} others`;

  // A node is sized by the counterparty's true total where known, but never below the flow drawn
  // into it — the max() is what keeps ribbons from overflowing their bar if the two ever disagree.
  const trueTotal = (code: string, drawnAmount: number) =>
    Math.max(drawnAmount, opts.targetTotals?.get(code) ?? 0);

  const targetEntries = [...finalTotals.entries()]
    .filter(([code]) => code !== OTHERS)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([code, v]) => ({ code, investorType: v.investorType, total: trueTotal(code, v.total) }))
    .sort((a, b) => b.total - a.total);
  // The others band keeps the drawn amount: its members are, by definition, the ones not worth
  // resolving individually, and inflating it to their true totals would dwarf the real nodes.
  const othersTotal = finalTotals.get(OTHERS)?.total ?? 0;
  if (othersTotal > 0) {
    targetEntries.push({ code: othersLabel, investorType: undefined, total: othersTotal });
  }

  /** Per-source sum of drawn flow — the denominator that makes ribbons fill their source bar. */
  const srcFlowSum = new Map<number, number>();
  for (const d of drawn) srcFlowSum.set(d.src, (srcFlowSum.get(d.src) ?? 0) + d.amount);

  const srcTotal = sources.reduce((s, b) => s + Math.abs(b.amount), 0) || 1;
  const tgtTotal = targetEntries.reduce((s, t) => s + t.total, 0) || 1;

  // Height is driven by the busier column so neither is cramped.
  const rows = Math.max(sources.length, targetEntries.length);
  const bodyH = Math.max(220, rows * 42);
  const H = HEADER + bodyH + FOOTER;

  const stack = (items: Array<{ total: number }>, total: number): Array<{ y: number; h: number }> => {
    const usable = bodyH - GAP * Math.max(0, items.length - 1);
    let y = HEADER;
    return items.map((it) => {
      const h = Math.max(3, (Math.abs(it.total) / total) * usable);
      const out = { y, h };
      y += h + GAP;
      return out;
    });
  };

  const srcPos = stack(sources.map((s) => ({ total: s.amount })), srcTotal);
  const tgtPos = stack(targetEntries, tgtTotal);

  const srcNodes: Node[] = sources.map((s, i) => ({
    code: s.code,
    investorType: s.investorType,
    total: Math.abs(s.amount),
    ...srcPos[i],
  }));
  const tgtNodes: Node[] = targetEntries.map((t, i) => ({
    code: t.code,
    investorType: t.investorType,
    total: t.total,
    ...tgtPos[i],
  }));

  const xL = PAD + COL_W;
  const xR = W - PAD - COL_W;

  /* -------------------------------- ribbons -------------------------------- */
  // Each side keeps its own running offset so ribbons stack inside their node rather than overlapping.
  const srcCursor = new Map<string, number>();
  const tgtCursor = new Map<string, number>();
  const tgtIndex = new Map(tgtNodes.map((n) => [n.code, n]));

  const ribbons: string[] = [];
  for (const d of drawn) {
    const sn = srcNodes[d.src];
    const label = d.target === OTHERS ? othersLabel : d.target;
    const tn = tgtIndex.get(label);
    // Unreachable: every drawn flow's target is in `targetEntries` by construction. Kept as a loud
    // no-op rather than a silent drop, which is precisely how the previous version lost flow.
    if (!sn || !tn) continue;

    // Source ribbons are scaled by that source's own drawn total, not the broker's headline amount:
    // a broker's counterparties need not sum to it, and dividing by the wrong denominator is what
    // let ribbons spill past their bar.
    const sh = (d.amount / (srcFlowSum.get(d.src) || 1)) * sn.h;
    const tgtH = (d.amount / (tn.total || 1)) * tn.h;
    const sy = sn.y + (srcCursor.get(sn.code) ?? 0);
    const ty = tn.y + (tgtCursor.get(tn.code) ?? 0);
    srcCursor.set(sn.code, (srcCursor.get(sn.code) ?? 0) + sh);
    tgtCursor.set(tn.code, (tgtCursor.get(tn.code) ?? 0) + tgtH);

    const mx = (xL + xR) / 2;
    const path = [
      `M ${xL} ${sy.toFixed(1)}`,
      `C ${mx} ${sy.toFixed(1)}, ${mx} ${ty.toFixed(1)}, ${xR} ${ty.toFixed(1)}`,
      `L ${xR} ${(ty + tgtH).toFixed(1)}`,
      `C ${mx} ${(ty + tgtH).toFixed(1)}, ${mx} ${(sy + sh).toFixed(1)}, ${xL} ${(sy + sh).toFixed(1)}`,
      "Z",
    ].join(" ");
    ribbons.push(
      `<path d="${path}" fill="${colorFor(d.investorType ?? sn.investorType, th)}" fill-opacity="${th.ribbonAlpha}"><title>${esc(sn.code)} → ${esc(label)}: ${esc(humanAmount(d.amount))} ${esc(opts.unit)}</title></path>`,
    );
  }

  /* --------------------------------- nodes --------------------------------- */
  const nodeMarkup = (n: Node, x: number, anchorRight: boolean, explained = 1): string => {
    const c = colorFor(n.investorType, th);
    const labelX = anchorRight ? x - 10 : x + 10;
    const anchor = anchorRight ? "end" : "start";
    const mid = n.y + n.h / 2;
    const rectX = x - (anchorRight ? 0 : 10);

    /*
     * A counterparty's bar is its TOTAL, but the ribbons only carry the flow from the buyers drawn.
     * Rendering one solid bar therefore leaves blank space under the ribbons that reads as a
     * rendering fault rather than as meaning.
     *
     * So the bar is drawn twice: the whole total dimmed, and the explained portion at full strength
     * on top. The lighter section is then visibly "sold to someone not shown" instead of a gap, and
     * the hover title says so in numbers.
     */
    const covered = Math.max(0, Math.min(1, explained));
    const coveredH = n.h * covered;
    const title =
      covered >= 0.999
        ? `${esc(n.code)}: ${esc(humanAmount(n.total))} ${esc(opts.unit)}`
        : `${esc(n.code)}: ${esc(humanAmount(n.total))} ${esc(opts.unit)} total · ${esc(humanAmount(n.total * covered))} from the brokers shown`;

    const parts = [
      `<rect x="${rectX}" y="${n.y.toFixed(1)}" width="10" height="${n.h.toFixed(1)}" rx="2" fill="${c}" fill-opacity="${covered >= 0.999 ? 1 : 0.3}"><title>${title}</title></rect>`,
    ];
    if (covered < 0.999 && coveredH > 0.5) {
      parts.push(
        `<rect x="${rectX}" y="${n.y.toFixed(1)}" width="10" height="${coveredH.toFixed(1)}" rx="2" fill="${c}"><title>${title}</title></rect>`,
      );
    }
    const TWO_LINE_MIN = 26;
    const ONE_LINE_MIN = 11;
    if (n.h >= TWO_LINE_MIN) {
      parts.push(
        `<text x="${labelX}" y="${(mid - 1).toFixed(1)}" text-anchor="${anchor}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13" font-weight="600" fill="${th.title}">${esc(n.code)}</text>`,
        `<text x="${labelX}" y="${(mid + 13).toFixed(1)}" text-anchor="${anchor}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="${th.muted}">${esc(humanAmount(n.total))}</text>`,
      );
    } else if (n.h >= ONE_LINE_MIN) {
      parts.push(
        `<text x="${labelX}" y="${(mid + 4).toFixed(1)}" text-anchor="${anchor}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" font-weight="600" fill="${th.title}">${esc(n.code)}</text>`,
      );
    }
    return parts.join("");
  };

  const legend = [
    ["Asing", th.asing],
    ["Lokal", th.lokal],
    ["Pemerintah", th.pemerintah],
  ]
    .map(([label, c], i) => {
      const x = PAD + i * 108;
      const y = HEADER + bodyH + 20;
      return `<rect x="${x}" y="${y - 9}" width="10" height="10" rx="2" fill="${c}"/><text x="${x + 15}" y="${y}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="${th.muted}">${esc(label)}</text>`;
    })
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">`,
    `<rect width="${W}" height="${H}" fill="${th.bg}"/>`,
    header(title, range, sideLabel, opts.unit, W, th, { left: leftRole, right: rightRole, xL: xL - 10, xR, y: HEADER - 14 }, opts.board),
    `<g>${ribbons.join("")}</g>`,
    `<g>${srcNodes.map((n) => nodeMarkup(n, xL - 10, true)).join("")}</g>`,
    `<g>${tgtNodes.map((n) => nodeMarkup(n, xR, false, (finalTotals.get(n.code === othersLabel ? OTHERS : n.code)?.total ?? n.total) / (n.total || 1))).join("")}</g>`,
    legend,
    `<text x="${W - PAD}" y="${HEADER + bodyH + 20}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="${th.muted}" opacity="0.75">Unofficial Stockbit data · not financial advice</text>`,
    `</svg>`,
  ].join("\n");
}

function header(
  title: string,
  range: string,
  side: string,
  unit: string,
  W: number,
  th: Theme,
  roles?: { left: string; right: string; xL: number; xR: number; y: number },
  board?: string,
): string {
  const sub = [range, side, board, `amounts in ${unit}`].filter(Boolean).join("  ·  ");
  const roleMarkup = roles
    ? [
        `<text x="${roles.xL}" y="${roles.y}" text-anchor="end" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" font-weight="700" letter-spacing="0.6" fill="${roles.left === "Buyer" ? th.buyer : th.seller}">${esc(roles.left.toUpperCase())}</text>`,
        `<text x="${roles.xR}" y="${roles.y}" text-anchor="start" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" font-weight="700" letter-spacing="0.6" fill="${roles.right === "Buyer" ? th.buyer : th.seller}">${esc(roles.right.toUpperCase())}</text>`,
      ].join("")
    : "";
  return [
    `<text x="28" y="36" font-family="ui-sans-serif,system-ui,sans-serif" font-size="19" font-weight="700" fill="${th.title}">${esc(title)}</text>`,
    `<text x="28" y="58" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12" fill="${th.muted}">${esc(sub)}</text>`,
    `<line x1="28" y1="72" x2="${W - 28}" y2="72" stroke="${th.rule}" stroke-width="1"/>`,
    roleMarkup,
  ].join("");
}
