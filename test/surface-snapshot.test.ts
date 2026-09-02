/**
 * The tool surface must be what it was, unless someone MEANT to change it.
 *
 * The phases this file exists for move roughly sixty tools out of `register.ts` and into their
 * family modules. A move like that does not fail loudly. It fails by one tool arriving under a
 * different family, or inheriting a different evidence word from its new `define.family()` default,
 * or losing an argument in a hand-retyped zod shape — and every one of those still registers, still
 * type-checks, and still passes every other test in this suite.
 *
 * So the surface is frozen BEFORE anything moves. Six fields per tool: name, family, evidence,
 * kind, and the two argument lists. Description and annotations are deliberately absent — see
 * `src/tools/snapshot.ts` for why a snapshot that churned on prose would detect nothing.
 *
 * ## This is a drift detector, not a security assertion
 *
 * It is DERIVED from the code, so it can only say "this changed"; it cannot say "this is right".
 * The claims that must not be derived — which tools write, and what evidence each may claim — stay
 * hand-written in `test/tools.test.ts`, and this file must never be used as a reason to soften them.
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-surface-snapshot-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { renderSurfaceSnapshot, surfaceSnapshot } from "../src/tools/snapshot.ts";
import { describeSurface } from "../src/tools/surface.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "surface.json");

/** Compare LF-normalised, so a Windows checkout with `core.autocrlf` does not fail this. */
const lf = (value: string): string => value.replace(/\r\n/g, "\n");

test("the committed surface snapshot is the surface", () => {
  assert.ok(existsSync(FIXTURE), "test/fixtures/surface.json is missing — run `npm run snapshot:surface`");
  const committed = lf(readFileSync(FIXTURE, "utf8"));
  const fresh = lf(renderSurfaceSnapshot());
  if (committed === fresh) return;

  // A 139-entry byte diff is unreadable, and an unreadable failure is one people re-run rather than
  // read. Name the tools that actually differ first, then fall back to the raw comparison.
  const before = new Map(JSON.parse(committed).map((t: { name: string }) => [t.name, JSON.stringify(t)]));
  const after_ = new Map(JSON.parse(fresh).map((t: { name: string }) => [t.name, JSON.stringify(t)]));
  const changed: string[] = [];
  for (const [name, entry] of after_) {
    if (!before.has(name)) changed.push(`+ ${name} (new)`);
    else if (before.get(name) !== entry) changed.push(`~ ${name}\n    was ${before.get(name)}\n    now ${entry}`);
  }
  for (const name of before.keys()) if (!after_.has(name)) changed.push(`- ${name} (gone)`);

  assert.equal(
    committed,
    fresh,
    `the tool surface changed:\n  ${changed.join("\n  ")}\n` +
      "If that was intended, run `npm run snapshot:surface` and commit the result.",
  );
});

test("rendering twice produces the same bytes", () => {
  // Registration order is not name order, and `describeSurface` iterates a definer's array. If the
  // sort were ever dropped, this would still pass and the fixture would still be stable — which is
  // why the next test checks the sort itself rather than trusting this one to catch it.
  assert.equal(renderSurfaceSnapshot(), renderSurfaceSnapshot());
});

test("the snapshot is sorted by name, not by registration order", () => {
  const names = surfaceSnapshot().map((t) => t.name);
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(names, sorted, "an unsorted snapshot goes red on every move, which is what it must survive");

  // The premise: registration order really is different, so sorting is doing work.
  const registered = describeSurface().tools.map((t) => t.name);
  assert.notDeepEqual(registered, sorted, "if registration order were already sorted, this test would prove nothing");
});

test("every registered tool is in the snapshot exactly once", () => {
  const surface = describeSurface();
  const snapshot = surfaceSnapshot();
  assert.equal(snapshot.length, surface.tools.length);
  assert.equal(new Set(snapshot.map((t) => t.name)).size, snapshot.length, "a duplicate name would hide a tool");
});

test("required and optional together are the tool's whole argument list, in declaration order", () => {
  // The split comes from `!schema.isOptional?.()`, so a shape entry that is not a zod schema would
  // be silently classified REQUIRED. Checking against the source of truth catches that.
  const byName = new Map(surfaceSnapshot().map((t) => [t.name, t]));
  for (const tool of describeSurface().tools) {
    const entry = byName.get(tool.name);
    assert.ok(entry, `${tool.name} is missing from the snapshot`);
    assert.deepEqual(
      [...entry.required, ...entry.optional].sort(),
      tool.inputs.map((i) => i.name).sort(),
      `${tool.name}: the two lists do not add up to its arguments`,
    );
    assert.deepEqual(entry.required, tool.inputs.filter((i) => i.required).map((i) => i.name));
    assert.deepEqual(entry.optional, tool.inputs.filter((i) => !i.required).map((i) => i.name));
  }
});

test("the snapshot carries no description and no annotations", () => {
  // Phases 3 and 4 rewrite every description in this repo. If either field were in here, the
  // snapshot would be regenerated on every prose edit and would stop detecting a move.
  for (const entry of surfaceSnapshot()) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["evidence", "family", "kind", "name", "optional", "required"],
      `${entry.name} carries a field the snapshot must not freeze`,
    );
  }
});

test("a write tool is recorded as a write", () => {
  // Not a substitute for the hand-written WRITES list in test/tools.test.ts — a spot check that the
  // `kind` field in this fixture means what it says, so a diff on it is worth reading.
  const byName = new Map(surfaceSnapshot().map((t) => [t.name, t]));
  for (const name of ["order_buy", "order_sell", "eipo_order", "watchlist_delete", "logout"]) {
    assert.equal(byName.get(name)?.kind, "write", `${name} must be recorded as a write`);
  }
  for (const name of ["quote", "analyze", "status", "chart_series"]) {
    assert.equal(byName.get(name)?.kind, "read", `${name} must be recorded as a read`);
  }
});
