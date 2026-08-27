/**
 * The arithmetic that decides whether a user gets woken up.
 *
 * Kept entirely offline: this is the layer that must be right regardless of whether a market is
 * open, and the failures it guards against are the ones that produce a screener nobody trusts —
 * a parse bug that reads as "no activity", a session reset that reads as a giant trade, and an
 * average over hundreds of prints presented as though it were one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readRaw,
  snapshotFromTopStock,
  diffSnapshots,
  looksLikeSessionReset,
} from "../src/live/tape.ts";

const row = (code: string, value: number, lot: number, frequency: number, average = 1000) => ({
  code,
  value: { raw: String(value), formatted: "x" },
  lot: { raw: String(lot), formatted: "x" },
  frequency: { raw: String(frequency), formatted: "x" },
  average: { raw: String(average), formatted: "x" },
});

/* ------------------------------- the parser ------------------------------- */

test("readRaw understands the {raw, formatted} shape Stockbit actually sends", () => {
  // The bug this exists for: `Number({raw:"477705146500"})` is NaN, so all 100 symbols read as
  // unparseable and the endpoint looked frozen. It was not. The parser was.
  assert.equal(readRaw({ raw: "477705146500", formatted: "477.7B" }), 477705146500);
});

test("readRaw takes plain numbers and separator-formatted strings too", () => {
  assert.equal(readRaw(3130), 3130);
  assert.equal(readRaw("1,119"), 1119);
});

test("readRaw returns null rather than 0 for anything it cannot read", () => {
  // Zero is a real market value — it means nothing traded. A parse failure must never be able to
  // impersonate it.
  for (const bad of [undefined, null, {}, { raw: "abc" }, "n/a", [], NaN, Infinity]) {
    assert.equal(readRaw(bad), null, `${JSON.stringify(bad)} must be null, not 0`);
  }
});

/* ------------------------------ snapshotting ------------------------------ */

test("a row missing value or frequency is skipped, not defaulted to zero", () => {
  const snap = snapshotFromTopStock([
    row("BBRI", 100, 10, 5),
    { code: "BROKEN", lot: { raw: "5" } },
    { value: { raw: "1" }, frequency: { raw: "1" } }, // no code
  ]);
  assert.equal(snap.symbols.size, 1);
  assert.ok(snap.symbols.has("BBRI"));
});

test("symbols are upper-cased so the same ticker cannot appear twice", () => {
  const snap = snapshotFromTopStock([row("bbri", 100, 10, 5)]);
  assert.ok(snap.symbols.has("BBRI"));
});

/* --------------------------------- deltas --------------------------------- */

test("the delta is what traded in the window, not the session total", () => {
  const a = snapshotFromTopStock([row("BBRI", 1_000_000, 100, 10)], 0);
  const b = snapshotFromTopStock([row("BBRI", 1_500_000, 150, 15)], 20_000);
  const [d] = diffSnapshots(a, b);
  assert.equal(d.value, 500_000);
  assert.equal(d.lots, 50);
  assert.equal(d.trades, 5);
  assert.equal(d.seconds, 20);
});

test("averageTradeValue is value divided by TRANSACTIONS — the whole detector", () => {
  const a = snapshotFromTopStock([row("X", 0, 0, 0)], 0);
  const b = snapshotFromTopStock([row("X", 5_000_000_000, 1000, 1)], 15_000);
  const [d] = diffSnapshots(a, b);
  assert.equal(d.averageTradeValue, 5_000_000_000);
  assert.equal(d.confidence, "single", "one transaction means the average IS that trade");
});

test("confidence degrades as the print count rises, because the average stops being one trade", () => {
  const cases: Array<[number, string]> = [[0, "none"], [1, "single"], [3, "few"], [5, "few"], [6, "averaged"], [400, "averaged"]];
  for (const [trades, expected] of cases) {
    const a = snapshotFromTopStock([row("X", 0, 0, 0)], 0);
    const b = snapshotFromTopStock([row("X", 1_000_000, 10, trades)], 10_000);
    assert.equal(diffSnapshots(a, b)[0].confidence, expected, `${trades} trades`);
  }
});

test("nothing traded gives a null average, never a divide-by-zero", () => {
  const a = snapshotFromTopStock([row("X", 500, 5, 3)], 0);
  const b = snapshotFromTopStock([row("X", 500, 5, 3)], 10_000);
  const [d] = diffSnapshots(a, b);
  assert.equal(d.trades, 0);
  assert.equal(d.averageTradeValue, null);
  assert.equal(d.confidence, "none");
});

test("a symbol with no baseline is skipped — its session total is not a trade", () => {
  // top-stock is a RANKED list, so symbols enter and leave it between polls. Reporting a newcomer's
  // cumulative value as a delta would announce an entire session as if it had just printed.
  const a = snapshotFromTopStock([row("BBRI", 100, 1, 1)], 0);
  const b = snapshotFromTopStock([row("BBRI", 200, 2, 2), row("NEWCOMER", 900_000_000_000, 1, 1)], 10_000);
  const out = diffSnapshots(a, b);
  assert.deepEqual(out.map((d) => d.symbol), ["BBRI"]);
});

test("a counter that went BACKWARDS is dropped — that is a new session, not a trade", () => {
  const a = snapshotFromTopStock([row("X", 9_000_000, 900, 90)], 0);
  const b = snapshotFromTopStock([row("X", 1_000, 1, 1)], 10_000);
  assert.deepEqual(diffSnapshots(a, b), [], "a negative delta must never surface as an alert");
});

test("results are ordered by rupiah, biggest first", () => {
  const a = snapshotFromTopStock([row("A", 0, 0, 0), row("B", 0, 0, 0), row("C", 0, 0, 0)], 0);
  const b = snapshotFromTopStock([row("A", 10, 1, 1), row("B", 900, 1, 1), row("C", 50, 1, 1)], 1000);
  assert.deepEqual(diffSnapshots(a, b).map((d) => d.symbol), ["B", "C", "A"]);
});

/* ----------------------------- session resets ----------------------------- */

test("a whole-market rollback is recognised as a session reset", () => {
  const a = snapshotFromTopStock([row("A", 100, 1, 1), row("B", 100, 1, 1), row("C", 100, 1, 1)], 0);
  const b = snapshotFromTopStock([row("A", 1, 1, 1), row("B", 1, 1, 1), row("C", 1, 1, 1)], 10_000);
  assert.equal(looksLikeSessionReset(a, b), true);
});

test("one symbol going backwards is a glitch, not a reset", () => {
  const a = snapshotFromTopStock([row("A", 100, 1, 1), row("B", 100, 1, 1), row("C", 100, 1, 1)], 0);
  const b = snapshotFromTopStock([row("A", 1, 1, 1), row("B", 200, 2, 2), row("C", 200, 2, 2)], 10_000);
  assert.equal(looksLikeSessionReset(a, b), false, "the caller must not throw away a good baseline");
});

/* ------------------------- the measured real numbers ------------------------- */

test("the figures measured live on 2026-08-27 come out as observed", () => {
  // Recorded from two real top-stock responses 25 seconds apart during an open session. If a future
  // change breaks the arithmetic, this is the case that says so in the units a person recognises.
  const a = snapshotFromTopStock(
    [row("DSSA", 477_705_146_500, 4_266_087, 37_435), row("BBCA", 434_746_618_579, 682_617, 10_965)],
    0,
  );
  const b = snapshotFromTopStock(
    [row("DSSA", 479_099_185_500, 4_278_370, 37_526), row("BBCA", 434_802_283_579, 682_704, 10_984)],
    25_000,
  );
  const byCode = new Map(diffSnapshots(a, b).map((d) => [d.symbol, d]));

  assert.equal(byCode.get("DSSA")!.value, 1_394_039_000);
  assert.equal(byCode.get("DSSA")!.trades, 91);
  assert.equal(Math.round(byCode.get("DSSA")!.averageTradeValue!), 15_319_110);

  assert.equal(byCode.get("BBCA")!.value, 55_665_000);
  assert.equal(byCode.get("BBCA")!.trades, 19);
  assert.equal(byCode.get("BBCA")!.confidence, "averaged");
});
