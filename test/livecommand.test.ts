/**
 * The two arguments a user types before the prompt: the time frame and the scope.
 *
 * Both are parsed before any request happens, so both are testable with no session and no market.
 * The failures worth guarding against here are the QUIET ones — a scope that silently widens to the
 * whole market, an interval that silently slows to the default, an empty watchlist that reads as a
 * calm market. Each of those produces a watcher that is confidently wrong rather than broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseInterval,
  describeInterval,
  IntervalParseError,
  FASTEST_MS,
  DEFAULT_MS,
} from "../src/live/interval.ts";
import {
  parseScope,
  describeScope,
  inScope,
  ScopeParseError,
  type ResolvedScope,
} from "../src/live/scope.ts";

/* ------------------------------- intervals ------------------------------- */

test("no time frame means the documented default, not the fastest", () => {
  const i = parseInterval(undefined);
  assert.equal(i.ms, DEFAULT_MS);
  assert.equal(i.ms, 5 * 60_000);
  assert.equal(i.clamped, false);
});

test("the forms a person actually types all parse", () => {
  for (const token of ["5m", "5 minutes", "5menit", "5 min", "5"]) {
    assert.equal(parseInterval(token).ms, 5 * 60_000, token);
  }
  assert.equal(parseInterval("30s").ms, 30_000);
  assert.equal(parseInterval("45 detik").ms, 45_000);
  assert.equal(parseInterval("10m").ms, 10 * 60_000);
});

test("a bare number is minutes", () => {
  // "watch it every 5" means minutes to anyone saying it out loud. Reading it as milliseconds or
  // seconds would produce a watcher hammering the API on a command that looked reasonable.
  assert.equal(parseInterval("10").ms, 10 * 60_000);
});

test("realtime resolves to the floor and SAYS it is not really real time", () => {
  const i = parseInterval("realtime");
  assert.equal(i.ms, FASTEST_MS);
  assert.equal(i.realtime, true);
  assert.equal(i.clamped, true);

  const said = describeInterval(i);
  assert.match(said, /8-10 minutes behind/);
  assert.match(said, /fastest/);
});

test("a faster-than-the-source interval is clamped AND reported", () => {
  const i = parseInterval("1s");
  assert.equal(i.ms, FASTEST_MS);
  assert.equal(i.clamped, true);
  // The user has to be able to see that they did not get what they asked for.
  assert.match(describeInterval(i), /you asked for 1s/);
});

test("an unreadable time frame is an error, never a silent default", () => {
  // This is the whole point of the strictness: a watcher that quietly polls every five minutes when
  // the user asked for thirty seconds gives them no way to notice.
  for (const bad of ["soon", "fast", "5x", "abc", "-5m", "0m", "0"]) {
    assert.throws(() => parseInterval(bad), IntervalParseError, bad);
  }
});

test("hour and day units are refused", () => {
  // `5h` is a plausible typo for `5m` and would produce a watcher reporting once per session.
  assert.throws(() => parseInterval("5h"), IntervalParseError);
  assert.throws(() => parseInterval("1d"), IntervalParseError);
});

test("an interval longer than an hour is refused", () => {
  assert.throws(() => parseInterval("90m"), /longer than an hour/);
  assert.doesNotThrow(() => parseInterval("60m"));
});

test("the error names the unit it did not understand", () => {
  assert.throws(() => parseInterval("5j"), /"j" is not a unit/);
});

/* --------------------------------- scope --------------------------------- */

test("explicit symbols parse in the forms people write them", () => {
  assert.deepEqual(parseScope("BBCA,ANTM"), { kind: "symbols", symbols: ["BBCA", "ANTM"] });
  assert.deepEqual(parseScope("bbca antm"), { kind: "symbols", symbols: ["BBCA", "ANTM"] });
  assert.deepEqual(parseScope("BBCA, ANTM , TLKM"), { kind: "symbols", symbols: ["BBCA", "ANTM", "TLKM"] });
});

test("warrants and rights are valid instruments, not typos", () => {
  // He holds INET-W2. Rejecting anything with a dash would refuse a real position.
  assert.deepEqual(parseScope("INET-W2"), { kind: "symbols", symbols: ["INET-W2"] });
  assert.deepEqual(parseScope("BUMI-R"), { kind: "symbols", symbols: ["BUMI-R"] });
});

test("repeated symbols are deduped in the order typed", () => {
  assert.deepEqual(parseScope("BBCA,ANTM,BBCA"), { kind: "symbols", symbols: ["BBCA", "ANTM"] });
});

test("all, in both languages", () => {
  for (const token of ["all", "ALL", "all stocks", "all-stocks", "semua", "market", "*"]) {
    assert.deepEqual(parseScope(token), { kind: "all" }, token);
  }
});

test("watchlist, named and default", () => {
  assert.deepEqual(parseScope("watchlist"), { kind: "watchlist", name: undefined });
  assert.deepEqual(parseScope("wl"), { kind: "watchlist", name: undefined });
  assert.deepEqual(parseScope("watchlist:Bandar"), { kind: "watchlist", name: "Bandar" });
});

test("a watchlist name keeps the user's own capitalisation", () => {
  // Lowercasing it makes the lookup-failed message unrecognisable to the person who named it.
  assert.deepEqual(parseScope("watchlist:Saham Gorengan"), { kind: "watchlist", name: "Saham Gorengan" });
});

test("a stray prompt word in the scope slot is named in the error", () => {
  // The usual real-world failure: `/watch BBCA big buy 5m ...` — the prompt bleeds into the scope.
  assert.throws(() => parseScope("BBCA big buy"), /BIG, BUY are not IDX tickers/);
});

test("an empty scope is refused rather than defaulted to the whole market", () => {
  assert.throws(() => parseScope(""), ScopeParseError);
  assert.throws(() => parseScope(undefined), ScopeParseError);
});

test("too many explicit symbols is refused with a way out", () => {
  const many = Array.from({ length: 51 }, (_, i) => `AA${String(i).padStart(2, "0")}`).join(",");
  assert.throws(() => parseScope(many), /use a watchlist or "all"/);
});

test("a colon with no name is an error, not the default watchlist", () => {
  assert.throws(() => parseScope("watchlist:"), /name is expected/);
});

/* ------------------------- filtering, resolved --------------------------- */

const resolved = (symbols: string[] | null): ResolvedScope => ({
  scope: symbols === null ? { kind: "all" } : { kind: "symbols", symbols },
  symbols,
  notes: [],
});

test("null means no filter; empty means a filter matching nothing", () => {
  // These are NOT the same, and conflating them reports the entire market to someone who asked
  // about an empty watchlist.
  assert.equal(inScope(resolved(null), "BBCA"), true);
  assert.equal(inScope(resolved([]), "BBCA"), false);
});

test("scope matching is case-insensitive and trims", () => {
  const r = resolved(["BBCA"]);
  assert.equal(inScope(r, "bbca"), true);
  assert.equal(inScope(r, " BBCA "), true);
  assert.equal(inScope(r, "BBRI"), false);
});

test("an empty watchlist describes itself as empty", () => {
  const r: ResolvedScope = { scope: { kind: "watchlist", name: "Bandar" }, symbols: [], notes: [] };
  assert.match(describeScope(r), /Bandar/);
  assert.match(describeScope(r), /0 symbols/);
});

test("all describes its real coverage rather than implying everything", () => {
  assert.match(describeScope(resolved(null)), /most active/);
});
