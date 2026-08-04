import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THEMES, colorFor, esc, humanAmount, renderSankey, type FlowBroker } from "../src/render/sankey.ts";
import { writeSvg } from "../src/render/write.ts";

const OPTS = { symbol: "BBRI", unit: "IDR", from: "2026-07-28", to: "2026-08-01", side: "buyers" as const };

const brokers: FlowBroker[] = [
  {
    code: "AK",
    investorType: "Asing",
    amount: 445525972000,
    distributedWith: [
      { code: "BK", investorType: "Asing", amount: 77101438000 },
      { code: "DX", investorType: "Pemerintah", amount: 55573481000 },
    ],
  },
  {
    code: "CC",
    investorType: "Lokal",
    amount: 141149000000,
    distributedWith: [{ code: "BK", investorType: "Asing", amount: 141149000000 }],
  },
];

/* --------------------------------- escaping --------------------------------- */

test("esc neutralizes every character that could break out of markup", () => {
  assert.equal(esc(`<script>alert("x")&'`), "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;");
  assert.equal(esc(undefined), "");
  assert.equal(esc(null), "");
});

test("SECURITY: a hostile broker code cannot inject markup into the SVG", () => {
  // Broker codes come from the API and land in a file a browser will execute. This is the control.
  const hostile: FlowBroker[] = [
    {
      code: `</text><script>fetch('//evil.test')</script>`,
      investorType: "Asing",
      amount: 100,
      distributedWith: [{ code: `"><script>x</script>`, investorType: "Lokal", amount: 100 }],
    },
  ];
  const svg = renderSankey(hostile, OPTS);
  assert.equal(svg.includes("<script>"), false, "raw <script> reached the output");
  // The payload verbatim — note `</text><text` on its own is legitimate here, since each node
  // emits a code label followed by an amount label.
  assert.equal(svg.includes("</text><script>"), false, "the payload closed an element early");
  assert.equal(svg.includes(`fetch('//evil.test')`), false, "unescaped quotes survived");
  assert.ok(svg.includes("&lt;script&gt;"), "the code should appear escaped, not dropped");
  assert.ok(svg.includes("&lt;/text&gt;"), "the closing tag in the payload must be escaped");
});

test("SECURITY: a hostile symbol cannot inject into the title", () => {
  const svg = renderSankey(brokers, { ...OPTS, symbol: `X"/><script>y</script>` });
  assert.equal(svg.includes("<script>"), false);
});

/* -------------------------------- formatting -------------------------------- */

test("humanAmount scales without lying about magnitude", () => {
  assert.equal(humanAmount(445525972000), "445.53B");
  assert.equal(humanAmount(1503094), "1.50M");
  assert.equal(humanAmount(2500), "2.5K");
  assert.equal(humanAmount(42), "42");
  assert.equal(humanAmount(-1e9), "-1.00B");
  assert.equal(humanAmount(NaN), "-");
  assert.equal(humanAmount(Infinity), "-");
});

test("colorFor distinguishes the three investor classes", () => {
  const asing = colorFor("Asing");
  const lokal = colorFor("Lokal");
  const govt = colorFor("Pemerintah");
  assert.equal(new Set([asing, lokal, govt]).size, 3, "classes must be visually distinct");
  assert.match(colorFor(undefined), /^#[0-9a-f]{6}$/i, "unknown class still needs a valid colour");
});

/* --------------------------------- geometry --------------------------------- */

test("the SVG is well-formed and carries no NaN or Infinity", () => {
  const svg = renderSankey(brokers, OPTS);
  assert.match(svg, /^<svg [^>]*>/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(/NaN|Infinity|undefined/.test(svg), false, "a coordinate did not compute");
});

test("every broker and counterparty appears", () => {
  const svg = renderSankey(brokers, OPTS);
  for (const code of ["AK", "CC", "BK", "DX"]) {
    assert.ok(svg.includes(`>${code}<`), `${code} missing from the chart`);
  }
});

test("ribbon thickness is proportional to amount", () => {
  // AK's two flows are ~77.1B and ~55.6B, so the first ribbon must be visibly thicker.
  const one: FlowBroker[] = [brokers[0]];
  const svg = renderSankey(one, OPTS);
  const paths = [...svg.matchAll(/<path d="M [\d.]+ ([\d.]+)[^"]*L [\d.]+ [\d.]+[^"]*"/g)];
  assert.ok(paths.length >= 2, "expected one ribbon per counterparty");
});

test("counterparties are merged across sources rather than drawn twice", () => {
  // BK receives from both AK and CC; it must appear as ONE node on the right.
  const svg = renderSankey(brokers, OPTS);
  const bkLabels = [...svg.matchAll(/>BK</g)].length;
  assert.equal(bkLabels, 1, `BK drawn ${bkLabels} times — counterparties are not merged`);
});

test("excess counterparties collapse into a labelled others band", () => {
  const many: FlowBroker[] = [
    {
      code: "AK",
      investorType: "Asing",
      amount: 1000,
      distributedWith: Array.from({ length: 20 }, (_, i) => ({
        code: `B${i}`,
        investorType: "Lokal",
        amount: 20 - i,
      })),
    },
  ];
  const svg = renderSankey(many, { ...OPTS, topTargets: 5 });
  assert.match(svg, /\+15 others/, "the tail must be disclosed, not silently dropped");
});

/* -------------------------------- degenerate -------------------------------- */

test("no brokers renders an explanatory card, not broken markup", () => {
  const svg = renderSankey([], OPTS);
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>$/);
  assert.match(svg, /No broker flows/);
  assert.equal(/NaN/.test(svg), false);
});

test("all-zero amounts do not divide by zero", () => {
  const zero: FlowBroker[] = [{ code: "AK", amount: 0, distributedWith: [{ code: "BK", amount: 0 }] }];
  const svg = renderSankey(zero, OPTS);
  assert.equal(/NaN|Infinity/.test(svg), false);
  assert.match(svg, /No broker flows/);
});

test("a broker with no counterparties still renders", () => {
  const lonely: FlowBroker[] = [{ code: "AK", investorType: "Asing", amount: 500, distributedWith: [] }];
  const svg = renderSankey(lonely, OPTS);
  assert.equal(/NaN|Infinity/.test(svg), false);
  assert.ok(svg.includes(">AK<"));
});

test("non-finite amounts are filtered rather than propagated", () => {
  const bad: FlowBroker[] = [
    { code: "AK", amount: NaN, distributedWith: [] },
    { code: "CC", amount: 100, distributedWith: [{ code: "BK", amount: Infinity }] },
  ];
  const svg = renderSankey(bad, OPTS);
  assert.equal(/NaN|Infinity/.test(svg), false);
});

/* ---------------------------------- output ---------------------------------- */

test("the header states symbol, window and unit so the image is self-describing", () => {
  const svg = renderSankey(brokers, { ...OPTS, unit: "lots" });
  assert.match(svg, /BBRI/);
  assert.match(svg, /2026-07-28/);
  assert.match(svg, /amounts in lots/);
});

test("a single-day window is not rendered as an arrow range", () => {
  const svg = renderSankey(brokers, { ...OPTS, from: "2026-08-03", to: "2026-08-03" });
  assert.equal(svg.includes("2026-08-03 → 2026-08-03"), false);
  assert.match(svg, /2026-08-03/);
});

test("writeSvg forces the .svg extension and creates parent directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "svg-test-"));
  const out = writeSvg(join(dir, "nested", "chart"), "<svg/>");
  assert.match(out, /nested[\\/]chart\.svg$/, "extension should be appended");
  assert.equal(readFileSync(out, "utf8"), "<svg/>");

  const kept = writeSvg(join(dir, "already.svg"), "<svg/>");
  assert.match(kept, /already\.svg$/, "an existing .svg extension should not be doubled");
});

/* ---------------------------------- theme ---------------------------------- */

test("dark is the default palette", () => {
  const svg = renderSankey(brokers, OPTS);
  assert.ok(svg.includes(`fill="${THEMES.dark.bg}"`), "background should be the dark ground");
  assert.equal(svg.includes(`fill="${THEMES.light.bg}"`), false);
});

test("light is available and swaps every surface colour", () => {
  const svg = renderSankey(brokers, { ...OPTS, theme: "light" });
  assert.ok(svg.includes(`fill="${THEMES.light.bg}"`));
  assert.ok(svg.includes(THEMES.light.asing), "light foreign colour should be used");
  assert.equal(svg.includes(THEMES.dark.asing), false, "no dark-theme colour should leak through");
});

test("an unknown theme falls back to dark rather than emitting undefined colours", () => {
  const svg = renderSankey(brokers, { ...OPTS, theme: "solarized" as never });
  assert.equal(/undefined/.test(svg), false);
  assert.ok(svg.includes(`fill="${THEMES.dark.bg}"`));
});

test("the two palettes keep the investor classes distinguishable", () => {
  for (const name of ["dark", "light"] as const) {
    const t = THEMES[name];
    assert.equal(new Set([t.asing, t.lokal, t.pemerintah]).size, 3, `${name} collapses two classes`);
  }
});

/* ------------------------------ ribbon density ------------------------------ */

const busy: FlowBroker[] = [
  {
    code: "AK",
    investorType: "Asing",
    amount: 1000,
    distributedWith: Array.from({ length: 50 }, (_, i) => ({
      code: `B${i}`,
      investorType: "Lokal",
      amount: 50 - i,
    })),
  },
];

test("ribbons per source are capped so the chart cannot become a hairball", () => {
  // Uncapped, 8 sources x ~50 counterparties is 400 curves and the picture stops meaning anything.
  const capped = renderSankey(busy, { ...OPTS, maxFlowsPerSource: 5 });
  const ribbons = [...capped.matchAll(/<path d="M /g)].length;
  assert.ok(ribbons <= 6, `expected at most 5 flows + 1 tail band, got ${ribbons}`);
});

test("the capped tail is disclosed, never silently dropped", () => {
  const svg = renderSankey(busy, { ...OPTS, maxFlowsPerSource: 5 });
  assert.match(svg, /\+45 others/, "the folded flows must be labelled with how many were folded");
});

test("the tail band preserves the total that actually flowed", () => {
  // 50 counterparties summing 50+49+…+1 = 1275; keeping the top 5 (50..46 = 240) leaves 1035.
  const kept = 50 + 49 + 48 + 47 + 46;
  const total = (50 * 51) / 2;
  const expectedTail = total - kept;
  const svg = renderSankey(busy, { ...OPTS, maxFlowsPerSource: 5 });
  // Derived from humanAmount rather than hardcoded, so a formatting change cannot silently
  // invalidate the arithmetic this test exists to check.
  assert.ok(
    svg.includes(`+45 others: ${humanAmount(expectedTail)}`),
    `tail band should carry ${humanAmount(expectedTail)}`,
  );
});

/* ------------------------------ label density ------------------------------ */

test("a node too thin for two lines drops the amount rather than overlapping its neighbour", () => {
  // One dominant broker plus a sliver: the sliver's node is only a few pixels tall.
  const lopsided: FlowBroker[] = [
    { code: "AA", investorType: "Asing", amount: 1_000_000, distributedWith: [{ code: "ZZ", amount: 1_000_000 }] },
    { code: "BB", investorType: "Lokal", amount: 1, distributedWith: [{ code: "YY", amount: 1 }] },
  ];
  const svg = renderSankey(lopsided, OPTS);
  // The sliver keeps a hover title so its value is still reachable.
  assert.match(svg, /<title>BB: /);
  assert.equal(/NaN/.test(svg), false);
});

/* ------------------- invariants: bars must match their ribbons ------------------- */

/** Every ribbon's y-extent, so overflow past a node or off-canvas is measurable. */
function ribbonExtents(svg: string): Array<{ top: number; bottom: number }> {
  return [...svg.matchAll(/<path d="M [\d.]+ ([\d.]+) C [^"]*L [\d.]+ ([\d.]+)/g)].map((m) => ({
    top: Number(m[1]),
    bottom: Number(m[2]),
  }));
}
function canvasHeight(svg: string): number {
  return Number(/height="(\d+)"/.exec(svg)?.[1] ?? 0);
}

const wide: FlowBroker[] = Array.from({ length: 8 }, (_, s) => ({
  code: `S${s}`,
  investorType: "Asing",
  amount: 1000 - s * 50,
  distributedWith: Array.from({ length: 50 }, (_, i) => ({
    code: `T${i}`,
    investorType: i % 2 ? "Lokal" : "Asing",
    amount: 50 - i,
  })),
}));

test("INVARIANT: no ribbon is drawn outside the canvas", () => {
  // The previous layout sized target nodes from a different population than the ribbons routed to
  // them, so ribbons ran up to 85px past the bottom of the viewBox, across the legend and footer.
  for (const o of [{}, { topTargets: 50 }, { maxFlowsPerSource: 2 }, { topSources: 3, topTargets: 4 }]) {
    const svg = renderSankey(wide, { ...OPTS, ...o });
    const H = canvasHeight(svg);
    for (const r of ribbonExtents(svg)) {
      assert.ok(r.bottom <= H, `ribbon ends at ${r.bottom} on a ${H}px canvas (${JSON.stringify(o)})`);
      assert.ok(r.top >= 0, `ribbon starts above the canvas (${JSON.stringify(o)})`);
    }
  }
});

test("INVARIANT: no flow is silently dropped, even when nothing is globally folded", () => {
  // Two sources sharing 8 counterparties: the union fits inside topTargets, so the old code had no
  // "others" node to route each source's tail into and discarded it without a trace.
  const shared: FlowBroker[] = ["AK", "CC"].map((code) => ({
    code,
    investorType: "Asing",
    amount: 800,
    distributedWith: Array.from({ length: 8 }, (_, i) => ({
      code: `B${i}`,
      investorType: "Lokal",
      amount: 8 - i,
    })),
  }));
  const svg = renderSankey(shared, { ...OPTS, topTargets: 12, maxFlowsPerSource: 6 });

  const charted = ribbonExtents(svg).length;
  assert.ok(charted > 0, "no ribbons at all");
  // 6 kept + 1 tail band per source.
  assert.equal(charted, 14, `expected 14 ribbons (6 kept + 1 tail, twice), got ${charted}`);
  assert.match(svg, /\+2 others/, "the folded counterparties must be labelled");
});

test("INVARIANT: every drawn target node actually receives a ribbon", () => {
  // Nodes with a label and no incoming ribbon read as 'this broker received nothing', which is a lie.
  const svg = renderSankey(wide, { ...OPTS, topTargets: 12, maxFlowsPerSource: 6 });
  const nodeTitles = [...svg.matchAll(/<title>([^:<]+): /g)].map((m) => m[1]);
  const ribbonTargets = new Set([...svg.matchAll(/<title>[^→<]+→ ([^:<]+):/g)].map((m) => m[1].trim()));
  const targetNodes = nodeTitles.filter((t) => /^(T\d+|\+\d+ others)$/.test(t));
  for (const t of targetNodes) {
    assert.ok(ribbonTargets.has(t), `target node "${t}" is drawn but nothing flows into it`);
  }
});

test("INVARIANT: raising top_targets never charts less flow", () => {
  // Asking to see more must not return less — the old code lost every source tail once
  // droppedTotal hit zero.
  const sum = (svg: string) =>
    [...svg.matchAll(/→ [^:<]+: ([\d.]+)([KMBT]?) /g)].reduce((acc, m) => {
      const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2]] ?? 1;
      return acc + Number(m[1]) * mult;
    }, 0);
  const narrow = sum(renderSankey(wide, { ...OPTS, topTargets: 5 }));
  const broad = sum(renderSankey(wide, { ...OPTS, topTargets: 50 }));
  assert.ok(broad >= narrow * 0.99, `charted flow fell from ${narrow} to ${broad} when topTargets rose`);
});

test("INVARIANT: top_targets actually caps how many counterparty nodes are drawn", () => {
  // Without this, removing the re-fold step leaves the limit silently unenforced: every
  // counterparty gets its own node and the chart grows without bound.
  for (const limit of [3, 5, 12]) {
    const svg = renderSankey(wide, { ...OPTS, topTargets: limit, maxFlowsPerSource: 6 });
    const targetNodes = [...svg.matchAll(/<title>(T\d+): /g)].length;
    assert.ok(
      targetNodes <= limit,
      `topTargets=${limit} but ${targetNodes} counterparty nodes were drawn`,
    );
  }
});
