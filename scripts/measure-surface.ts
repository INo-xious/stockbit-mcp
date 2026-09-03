#!/usr/bin/env node
/**
 * What a model pays to look at this server, measured rather than estimated.
 *
 * Every claim in the token-diet work — "descriptions are a fifth of a turn's context", "a 5y chart
 * series does not fit in a client's result window" — is a number, and a number nobody can reproduce
 * is an opinion. This script is the instrument those numbers come from, so a later phase can say
 * "79,612 to 44,180" and anyone can check it by running one command:
 *
 *     node --import tsx scripts/measure-surface.ts
 *
 * ## What it measures, and why that exact shape
 *
 * `tools/list` is measured as `JSON.stringify(tools)` over the array a real `Client` gets back over
 * an in-memory transport — every tool object exactly as the SDK sends it. That is deliberate and it
 * is the only honest shape: every tool carries an `execution` key the SDK adds and an `annotations`
 * and `_meta` pair THIS repo attaches in `_define.ts`, and a projection that drops them would report
 * a surface 8K smaller than the one a client actually receives. Only the SDK's part is out of this
 * project's hands; the other two are ours and are simply not editable by a description diet. The
 * component totals (descriptions, input schemas, names) are printed beside it so a later phase can
 * see WHICH part it moved, but the headline is the whole array.
 *
 * The server is asked, not imitated. `describeSurface()` could answer most of this without a
 * transport, but it would answer for the recorder rather than for the client — and the gap between
 * those two is exactly where a regression would hide.
 *
 * ## Deterministic
 *
 * No timestamps, no wall-clock, no iteration over an unordered map: two runs of the same tree print
 * identical bytes. `src/toolsdoc.ts` makes the same promise for the same reason — output that
 * changes on its own teaches everyone to ignore a diff.
 *
 * ## Offline
 *
 * Registration builds descriptions and closures; it opens no file and reads no credential
 * (`src/tools/surface.ts` says so and `test/tools.test.ts` holds it to it). The update check is
 * switched off below anyway, because a script that measures a surface must not be able to touch the
 * network to do it.
 */
process.env.STOCKBIT_NO_UPDATE_CHECK ??= "1";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";
import { parseToolProfile } from "../src/tools/_profile.js";
import type { Bar } from "../src/core/bars.js";

/** Chars per token. The proxy this project's plan uses; it is not a tokenizer. */
const CHARS_PER_TOKEN = 4;

const int = (n: number): string => n.toLocaleString("en-US");
const tok = (chars: number): string => `~${(chars / CHARS_PER_TOKEN / 1000).toFixed(1)}K tok`;

interface Measured {
  label: string;
  tools: Tool[];
  /** The headline: what a client receives, byte for byte. */
  listChars: number;
  descriptionChars: number;
  schemaChars: number;
  nameChars: number;
  instructionChars: number;
}

/**
 * Ask a real server, over the transport a real client uses.
 *
 * `isDefault` is not cosmetic. The instructions say "registers the core profile, the default"
 * instead of "STOCKBIT_TOOLS=core is set" depending on it, and those two sentences are different
 * lengths — measuring the wrong one under-reports the default install by 215 chars.
 */
async function measure(label: string, profileName: string | undefined, isDefault: boolean): Promise<Measured> {
  const profile = profileName === undefined ? undefined : parseToolProfile(profileName);
  const server = createServer({ profile, profileIsDefault: isDefault });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stockbit-measure", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const { tools } = await client.listTools();
    return {
      label,
      tools,
      listChars: JSON.stringify(tools).length,
      descriptionChars: tools.reduce((sum, t) => sum + (t.description?.length ?? 0), 0),
      schemaChars: tools.reduce((sum, t) => sum + JSON.stringify(t.inputSchema).length, 0),
      nameChars: tools.reduce((sum, t) => sum + t.name.length, 0),
      instructionChars: (client.getInstructions() ?? "").length,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function report(m: Measured): void {
  const n = m.tools.length;
  console.log(`\n## ${m.label} — ${n} tools`);
  console.log(`  tools/list JSON       ${int(m.listChars).padStart(9)} chars  (${tok(m.listChars)})`);
  console.log(`  instructions          ${int(m.instructionChars).padStart(9)} chars  (${tok(m.instructionChars)})`);
  console.log(`  ── of tools/list ──`);
  console.log(`  descriptions          ${int(m.descriptionChars).padStart(9)} chars  (avg ${int(Math.round(m.descriptionChars / n))}/tool)`);
  console.log(`  input schemas         ${int(m.schemaChars).padStart(9)} chars`);
  console.log(`  names                 ${int(m.nameChars).padStart(9)} chars`);
  // The remainder: this repo's own `annotations` and `_meta`, the SDK's `execution`, and JSON
  // punctuation. Only `execution` belongs to the SDK — but none of the three shrinks when a
  // description does, and naming the total stops a later phase budgeting against what it cannot move.
  const envelope = m.listChars - m.descriptionChars - m.schemaChars - m.nameChars;
  console.log(
    `  envelope + JSON        ${int(envelope).padStart(9)} chars  (our annotations and _meta, the SDK's execution, and JSON quoting — none of it editable by a description)`,
  );
}

/** The 15 that cost the most to look at. The description diet's target list. */
function largest(m: Measured, count = 15): void {
  const rows = [...m.tools]
    .map((t) => ({ name: t.name, chars: t.description?.length ?? 0 }))
    // Name as the tiebreak, so equal-length descriptions cannot reorder between runs.
    .sort((a, b) => b.chars - a.chars || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, count);
  console.log(`\n  largest ${count} descriptions in ${m.label}:`);
  for (const row of rows) console.log(`    ${row.name.padEnd(24)} ${int(row.chars).padStart(6)} chars`);
}

/**
 * What one `chart_series` answer costs, without a Stockbit account.
 *
 * Simulated, and the simulation is stated rather than implied — a reader has to be able to tell
 * which parts of this number are the wire and which are this file's assumptions. The bar shape is
 * the one the DAILY route actually sends (`src/core/market.ts`): a date, five prices that are all
 * the close because open/high/low arrive empty, and eight fields that arrive empty and are
 * therefore null rather than zero. That is the CHEAPEST real bar; a route that filled those eight
 * would cost about 27 more compact chars each.
 *
 * So this is a FLOOR for a series of this length, not a typical value, and it is printed as one.
 * The metadata is left empty for the same reason: the real daily route emits two long warnings and
 * a populated `sample`, worth about another 900 chars, and folding a variable amount of prose into
 * a figure about bar count would make the figure mean two things at once.
 */
function chartPayload(bars: number): unknown {
  const rows: Bar[] = [];
  for (let i = 0; i < bars; i += 1) {
    // A fixed date and a fixed price: this measures the SHAPE, and a varying value would only add
    // noise that changes with the bar count. Four-digit prices are the common IDX case.
    rows.push({
      date: "2021-09-03",
      open: 4000,
      high: 4000,
      low: 4000,
      close: 4000,
      average: 4000,
      volume: null,
      value: null,
      frequency: null,
      change: null,
      changePercent: null,
      foreignBuy: null,
      foreignSell: null,
      netForeign: null,
    });
  }
  // The envelope `runTool` wraps every result in. It matters: `bars` sits two levels down, and
  // pretty-printing indents every one of those lines by six spaces.
  return {
    success: true,
    data: {
      symbol: "BBRI",
      timeframe: "5y",
      source: "charts",
      bars: rows,
      barsTotal: rows.length,
      from: rows[0]?.date,
      to: rows[rows.length - 1]?.date,
      dataPath: "data.chart",
      mapped: {},
      unmapped: [],
      extraKeys: [],
      warnings: [],
      sample: {},
    },
  };
}

function reportChart(bars: number): void {
  const payload = chartPayload(bars);
  const pretty = JSON.stringify(payload, null, 2).length;
  const compact = JSON.stringify(payload).length;
  const saved = ((1 - compact / pretty) * 100).toFixed(1);
  console.log(
    `  ${String(bars).padStart(5)} bars   pretty ${int(pretty).padStart(9)} (${tok(pretty)})` +
      `   compact ${int(compact).padStart(9)} (${tok(compact)})   −${saved}%`,
  );
}

console.log("stockbit-mcp surface measurement");
console.log(`(tokens are chars/${CHARS_PER_TOKEN} — a proxy, not a tokenizer)`);

// `core` is measured as the DEFAULT, because that is how almost every install runs it.
const core = await measure("core (the default profile)", "core", true);
const all = await measure("all", "all", false);

report(core);
report(all);
largest(core);
largest(all);

console.log("\n## one chart_series result, simulated — a FLOOR, not a typical value");
console.log("  assumes: the daily-route bar (date + 5 four-digit prices + 8 nulls), empty warnings/sample,");
console.log('  and dataPath "data.chart" — the value test/market.test.ts asserts for this route.');
console.log("  plan.md's baseline table (466,560 / 273,971) predates `barsTotal` and assumed a 17-char");
console.log("  dataPath. At 1,250 bars that is +16 pretty and +10 compact — `barsTotal` costs 17 compact");
console.log("  chars and the shorter, observed dataPath gives 7 back. Not drift.");
reportChart(200);
reportChart(1250);

console.log(
  `\nheadline: core tools/list ${int(core.listChars)} chars + ${int(core.instructionChars)} instructions; ` +
    `all ${int(all.listChars)} chars.`,
);
