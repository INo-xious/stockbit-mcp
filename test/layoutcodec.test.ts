import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERIES_ID_LITERALS,
  SERIES_ID_PLACEHOLDER,
  buildLayout,
  corruptingLiterals,
  encodeLayoutForSave,
  isPlausibleLayout,
  normalizeSeriesIds,
} from "../src/core/layoutcodec.ts";

/* ------------------------------ faithful to Stockbit's Fj ------------------------------ */

test("normalizeSeriesIds reproduces Stockbit's substitution exactly", () => {
  // ak = function(a){ var b=a; ["D4LkIE","7a6YCE"].forEach(id => b=b.replace(RegExp(id,"g"),"_seriesId")); return b }
  assert.equal(normalizeSeriesIds('{"id":"D4LkIE"}'), '{"id":"_seriesId"}');
  assert.equal(normalizeSeriesIds('{"id":"7a6YCE"}'), '{"id":"_seriesId"}');
  assert.equal(
    normalizeSeriesIds('{"a":"D4LkIE","b":"7a6YCE"}'),
    '{"a":"_seriesId","b":"_seriesId"}',
    "both ids are rewritten in one pass",
  );
});

test("the replace is GLOBAL, as in the original", () => {
  // A single-occurrence replace would leave later ids intact and produce a layout the server
  // stores but the client cannot rebind.
  assert.equal(normalizeSeriesIds("D4LkIE D4LkIE D4LkIE"), "_seriesId _seriesId _seriesId");
});

test("a payload with no series id is returned untouched", () => {
  const input = '{"charts":[{"panes":[]}]}';
  assert.equal(normalizeSeriesIds(input), input);
});

test("an already-normalised layout survives a second pass unchanged", () => {
  // Round-tripping a stored layout must be idempotent, or repeated saves would drift.
  const once = normalizeSeriesIds('{"id":"D4LkIE"}');
  assert.equal(normalizeSeriesIds(once), once);
});

/* --------------------------------- the corruption hazard --------------------------------- */

test("a literal appearing outside an id is REFUSED rather than silently rewritten", () => {
  // The real hazard: Stockbit's replace is unanchored, so a drawing whose text happens to contain
  // the literal is corrupted on save and nothing reports it.
  const layout = { charts: [{ panes: [{ sources: [{ type: "Note", state: { text: "target D4LkIE zone" } }] }] }] };
  assert.throws(() => encodeLayoutForSave(layout), /would corrupt this layout/);
  assert.throws(() => encodeLayoutForSave(layout), /D4LkIE/);
});

test("the same payload can be sent deliberately with allowLossy", () => {
  const layout = { charts: [{ panes: [{ sources: [{ type: "Note", state: { text: "D4LkIE" } }] }] }] };
  const encoded = encodeLayoutForSave(layout, { allowLossy: true });
  assert.match(encoded, /_seriesId/);
  assert.equal(encoded.includes("D4LkIE"), false, "allowLossy means Stockbit's exact behaviour");
});

test("a literal used legitimately AS an id is not treated as corruption", () => {
  // This is the normal case — it is exactly what the substitution exists for.
  const layout = { charts: [{ panes: [{ sources: [{ type: "MainSeries", id: "D4LkIE" }] }] }] };
  assert.doesNotThrow(() => encodeLayoutForSave(layout));
  assert.match(encodeLayoutForSave(layout), /"id":"_seriesId"/);
});

test("corruptingLiterals reports which literals are present", () => {
  assert.deepEqual(corruptingLiterals('{"x":"nothing here"}'), []);
  assert.deepEqual(corruptingLiterals('{"x":"D4LkIE"}'), ["D4LkIE"]);
  assert.deepEqual(corruptingLiterals('{"x":"D4LkIE","y":"7a6YCE"}'), [...SERIES_ID_LITERALS]);
});

test("an unserialisable layout fails loudly instead of sending undefined", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => encodeLayoutForSave(circular));
  // A bare function serialises to undefined rather than throwing — that must not reach the wire.
  assert.throws(() => encodeLayoutForSave(() => 1), /not serialisable/);
});

/* ------------------------------------- composition ------------------------------------- */

test("buildLayout produces the shape Stockbit's own templates use", () => {
  const layout = buildLayout() as Record<string, unknown>;
  assert.equal(layout.layout, "s");
  assert.deepEqual(layout.layoutsSizes, { s: [{ percent: 1 }] });
  const chart = (layout.charts as Array<Record<string, unknown>>)[0];
  assert.equal(chart.version, 3);
  assert.equal(chart.timezone, "Asia/Jakarta", "Chartbit's templates are Jakarta time");
  assert.equal(chart.chartId, "1");
  assert.deepEqual(chart.lineToolsGroups, { groups: [] });
  const sources = ((chart.panes as Array<Record<string, unknown>>)[0].sources) as Array<Record<string, unknown>>;
  assert.equal(sources[0].type, "MainSeries");
  assert.equal(sources[0].id, SERIES_ID_PLACEHOLDER, "a saved layout carries the placeholder, not a live id");
});

test("theme and timezone are honoured", () => {
  const dark = buildLayout({ theme: "dark", timezone: "Etc/UTC" }) as Record<string, unknown>;
  const chart = (dark.charts as Array<Record<string, unknown>>)[0];
  assert.equal(chart.theme, "dark");
  assert.equal(chart.timezone, "Etc/UTC");
});

test("extra sources are appended after the main series, not in front of it", () => {
  // MainSeries first is what every shipped template does; a line tool ahead of it would be a
  // different z-order than the user drew.
  const layout = buildLayout({ sources: [{ type: "LineToolHorzLine" }] }) as Record<string, unknown>;
  const chart = (layout.charts as Array<Record<string, unknown>>)[0];
  const sources = ((chart.panes as Array<Record<string, unknown>>)[0].sources) as Array<Record<string, unknown>>;
  assert.equal(sources.length, 2);
  assert.equal(sources[0].type, "MainSeries");
  assert.equal(sources[1].type, "LineToolHorzLine");
});

test("a composed layout encodes cleanly", () => {
  const encoded = encodeLayoutForSave(buildLayout());
  const parsed = JSON.parse(encoded);
  assert.equal(isPlausibleLayout(parsed), true);
  assert.equal(encoded.includes(SERIES_ID_PLACEHOLDER), true);
});

/* ------------------------------------- shape check ------------------------------------- */

test("isPlausibleLayout rejects things that are not a chart state", () => {
  assert.equal(isPlausibleLayout(buildLayout()), true);
  for (const bad of [null, undefined, "", 42, {}, { charts: [] }, { charts: [{}] }, { charts: [{ panes: [] }] }]) {
    assert.equal(isPlausibleLayout(bad), false, `${JSON.stringify(bad)} is not a layout`);
  }
});

test("a real stored layout round-trips through the codec unchanged", () => {
  // The property that matters for any future write: read a layout, send it back, get the same bytes.
  const stored = normalizeSeriesIds(JSON.stringify(buildLayout({ theme: "dark" })));
  const reencoded = encodeLayoutForSave(JSON.parse(stored));
  assert.equal(reencoded, stored, "a round-trip must not alter the user's layout");
});
