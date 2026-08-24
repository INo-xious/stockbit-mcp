/**
 * The committed tool reference must be what the server would generate right now.
 *
 * A 138-row reference maintained by hand is a reference that is wrong: the old README listed about
 * fifty tools and omitted `analyze`, the most useful one here. Generating it fixes that only if
 * somebody remembers to regenerate — so forgetting is a failing test rather than a document that
 * quietly becomes a historical artefact.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-toolsdoc-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { renderToolsDoc } from "../src/toolsdoc.ts";
import { describeSurface } from "../src/tools/surface.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const DOC = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "TOOLS.md");

/** Compare LF-normalised, so a Windows checkout with `core.autocrlf` does not fail this. */
const lf = (value: string): string => value.replace(/\r\n/g, "\n");

test("docs/TOOLS.md is up to date", async () => {
  assert.ok(existsSync(DOC), "docs/TOOLS.md is missing — run `npm run docs:tools`");
  const committed = lf(readFileSync(DOC, "utf8"));
  const fresh = lf(await renderToolsDoc());
  assert.equal(
    committed,
    fresh,
    "docs/TOOLS.md does not match the current tool surface. Run `npm run docs:tools` and commit the result.",
  );
});

test("rendering twice produces the same bytes", async () => {
  // A generator with a timestamp, or one that iterates an unordered map, would make the freshness
  // test fail at random — which teaches everyone to ignore it.
  const first = await renderToolsDoc();
  const second = await renderToolsDoc();
  assert.equal(first, second);
  assert.doesNotMatch(first, /20\d\d-\d\d-\d\dT/, "no timestamps: they would make every run a diff");
});

test("the header counts agree with the real surface", async () => {
  const surface = describeSurface();
  const doc = await renderToolsDoc();
  const header = doc.match(/\*\*(\d+) tools\*\* \((\d+) read, (\d+) write\) in (\d+) families, (\d+) prompts/);
  assert.ok(header, "the header line is what `npm run smoke` reads its expectations from");

  const [, tools, reads, writes, families, prompts] = header.map(Number);
  assert.equal(tools, surface.tools.length);
  assert.equal(writes, surface.writes.length);
  assert.equal(reads, surface.tools.length - surface.writes.length);
  assert.equal(families, new Set(surface.tools.map((t) => t.family)).size);
  assert.equal(prompts, 8);
});

test("every registered tool appears exactly once", async () => {
  const doc = await renderToolsDoc();
  const surface = describeSurface();
  for (const tool of surface.tools) {
    const occurrences = doc.split(`\`${tool.name}\` |`).length - 1;
    assert.equal(occurrences, 1, `${tool.name} appears ${occurrences} times in the reference`);
  }
});

test("the write tools are marked as writes, and the dangerous ones as destructive", async () => {
  const doc = await renderToolsDoc();
  for (const line of doc.split("\n")) {
    for (const name of ["order_buy", "order_sell", "eipo_order", "watchlist_delete", "logout"]) {
      if (line.startsWith(`| \`${name}\` |`)) {
        assert.match(line, /\| write, destructive \|/, `${name} should be marked destructive`);
      }
    }
    for (const name of ["quote", "analyze", "status", "position_size"]) {
      if (line.startsWith(`| \`${name}\` |`)) assert.match(line, /\| read \|/, `${name} is a read`);
    }
  }
});

test("evidence rides through to the document", async () => {
  const doc = await renderToolsDoc();
  // A carina tool must never appear as Observed here — that is the claim this whole vocabulary
  // exists to keep honest.
  for (const line of doc.split("\n")) {
    if (/^\| `(portfolio|cash_balance|order_preview|orders)` \|/.test(line)) {
      assert.match(line, /\| Projected \|/, `a carina read is Projected until the live gate is run: ${line}`);
    }
  }
  assert.match(doc, /\| Read-back \|/, "the account writes are Read-back and should say so");
});

test("a table cell cannot be broken by a description containing a pipe", async () => {
  // Descriptions are prose written for a model and several of them contain a `|`. An unescaped one
  // silently adds a column, which markdown renders as a mangled row rather than an error — so every
  // row is checked against the width its own table declared.
  const doc = await renderToolsDoc();
  const width = (line: string): number => line.split(/(?<!\\)\|/).length - 2;

  let expected: number | null = null;
  let seenTables = 0;
  for (const line of doc.split("\n")) {
    if (/^\|\s*(Tool|Family|Prompt)\s*\|/.test(line)) {
      expected = width(line);
      seenTables += 1;
      continue;
    }
    if (!line.startsWith("|")) {
      expected = null;
      continue;
    }
    if (/^\|[\s-]+\|/.test(line)) continue; // the ---|--- separator
    assert.ok(expected !== null, `a table row with no header above it: ${line.slice(0, 80)}`);
    assert.equal(
      width(line),
      expected,
      `a row has ${width(line)} cells where its table declared ${expected} — an unescaped pipe: ${line.slice(0, 120)}`,
    );
  }
  assert.ok(seenTables >= 3, `expected the families table, the per-family tables and prompts; saw ${seenTables}`);
});
