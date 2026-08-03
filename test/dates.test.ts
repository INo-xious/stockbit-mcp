import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSettledRange,
  normalizeDateRange,
  normalizeTradeDate,
  todayIso,
} from "../src/core/dates.ts";
import { buildBrokerSummaryParams } from "../src/core/marketdetectors.ts";

/* ------------------------------ single date ------------------------------ */

test("normalizeTradeDate accepts the dashed form the API requires", () => {
  assert.equal(normalizeTradeDate("2026-08-03"), "2026-08-03");
  assert.equal(normalizeTradeDate("  2026-08-03  "), "2026-08-03");
});

test("normalizeTradeDate rejects the formats the API rejects", () => {
  // Verified against the live endpoint: each of these returns an error there.
  for (const bad of ["20260803", "2026/08/03", "03-08-2026", "2026-8-3", "not-a-date", ""]) {
    assert.throws(() => normalizeTradeDate(bad), /Invalid date/, `should reject ${JSON.stringify(bad)}`);
  }
});

test("normalizeTradeDate rejects impossible calendar dates", () => {
  // Date would roll 2026-02-30 to 2026-03-02 and the request would succeed for the wrong day.
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-10", "2026-04-31", "2025-02-29"]) {
    assert.throws(() => normalizeTradeDate(bad), /not a real calendar date/, `should reject ${bad}`);
  }
  assert.equal(normalizeTradeDate("2024-02-29"), "2024-02-29"); // real leap day
});

test("normalizeTradeDate rejects non-strings", () => {
  for (const bad of [undefined, null, 20260803, {}, []]) {
    assert.throws(() => normalizeTradeDate(bad as unknown), /must be a string/);
  }
});

/* -------------------------------- ranges -------------------------------- */

test("no dates at all means no range", () => {
  assert.equal(normalizeDateRange({}), undefined);
  assert.equal(normalizeDateRange({ from: "", to: "  " }), undefined);
});

test("a full range is accepted, including a single day expressed twice", () => {
  assert.deepEqual(normalizeDateRange({ from: "2026-07-28", to: "2026-08-01" }), {
    from: "2026-07-28",
    to: "2026-08-01",
  });
  assert.deepEqual(normalizeDateRange({ from: "2026-08-03", to: "2026-08-03" }), {
    from: "2026-08-03",
    to: "2026-08-03",
  });
});

test("a half-specified range is rejected — the API would silently return the latest session", () => {
  // Measured: from=2026-07-27 with no `to` returns 200 with from=to=today.
  assert.throws(() => normalizeDateRange({ from: "2026-07-27" }), /needs both ends/);
  assert.throws(() => normalizeDateRange({ to: "2026-08-03" }), /needs both ends/);
  assert.throws(() => normalizeDateRange({ start_date: "2026-07-27" }), /needs both ends/);
});

test("an inverted range is rejected", () => {
  assert.throws(
    () => normalizeDateRange({ from: "2026-08-03", to: "2026-07-27" }),
    /must not be after/,
  );
});

/* -------------------------------- aliases -------------------------------- */

test("each alias pair resolves to the same range", () => {
  const expected = { from: "2026-07-28", to: "2026-08-01" };
  assert.deepEqual(normalizeDateRange({ from: "2026-07-28", to: "2026-08-01" }), expected);
  assert.deepEqual(normalizeDateRange({ date_from: "2026-07-28", date_to: "2026-08-01" }), expected);
  assert.deepEqual(normalizeDateRange({ start_date: "2026-07-28", end_date: "2026-08-01" }), expected);
});

test("aliases may be mixed across the two ends", () => {
  assert.deepEqual(normalizeDateRange({ from: "2026-07-28", end_date: "2026-08-01" }), {
    from: "2026-07-28",
    to: "2026-08-01",
  });
});

test("the same alias repeated with an identical value is fine", () => {
  assert.deepEqual(
    normalizeDateRange({ from: "2026-07-28", start_date: "2026-07-28", to: "2026-08-01" }),
    { from: "2026-07-28", to: "2026-08-01" },
  );
});

test("conflicting aliases are rejected rather than silently resolved by precedence", () => {
  assert.throws(
    () => normalizeDateRange({ from: "2026-07-28", start_date: "2026-07-01", to: "2026-08-01" }),
    /Conflicting start dates/,
  );
  assert.throws(
    () => normalizeDateRange({ from: "2026-07-28", to: "2026-08-01", end_date: "2026-08-02" }),
    /Conflicting end dates/,
  );
});

/* ------------------------------ settled ranges ------------------------------ */

test("isSettledRange is true only for a window that ended before today", () => {
  const now = new Date("2026-08-03T09:00:00Z");
  assert.equal(isSettledRange({ from: "2026-07-01", to: "2026-08-02" }, now), true);
  assert.equal(isSettledRange({ from: "2026-07-01", to: "2026-08-03" }, now), false, "today is still moving");
  assert.equal(isSettledRange({ from: "2026-08-04", to: "2026-08-05" }, now), false, "future");
});

test("todayIso is a plain YYYY-MM-DD", () => {
  assert.match(todayIso(new Date("2026-08-03T23:59:00Z")), /^2026-08-03$/);
});

/* ---------------- the invariant this whole feature depends on ---------------- */

test("REGRESSION: dates and `period` are never sent together", () => {
  // If `period` is present the API ignores from/to and answers 200 with the latest session, so a
  // caller asking for last week silently receives today. This assertion is the guard.
  const ranged = buildBrokerSummaryParams({ symbol: "BBRI", from: "2026-07-28", to: "2026-08-01" });
  assert.equal("period" in ranged, false, "`period` must be absent whenever a range is supplied");
  assert.equal(ranged.from, "2026-07-28");
  assert.equal(ranged.to, "2026-08-01");

  // …and via every alias spelling, since those are the paths most likely to regress.
  for (const input of [
    { date_from: "2026-07-28", date_to: "2026-08-01" },
    { start_date: "2026-07-28", end_date: "2026-08-01" },
  ]) {
    const p = buildBrokerSummaryParams({ symbol: "BBRI", ...input });
    assert.equal("period" in p, false, `\`period\` leaked for ${JSON.stringify(input)}`);
    assert.equal(p.from, "2026-07-28");
    assert.equal(p.to, "2026-08-01");
  }
});

test("REGRESSION: with no dates the request is unchanged from before this feature", () => {
  const p = buildBrokerSummaryParams({ symbol: "BBRI" });
  assert.equal(p.period, "BROKER_SUMMARY_PERIOD_LATEST");
  assert.equal("from" in p, false);
  assert.equal("to" in p, false);
  assert.equal(p.transaction_type, "TRANSACTION_TYPE_NET");
  assert.equal(p.market_board, "MARKET_BOARD_REGULER");
  assert.equal(p.investor_type, "INVESTOR_TYPE_ALL");
  assert.equal(p.limit, 50);
});

test("the alias spellings never reach the wire", () => {
  const p = buildBrokerSummaryParams({
    symbol: "BBRI",
    date_from: "2026-07-28",
    end_date: "2026-08-01",
  });
  for (const dead of ["date_from", "date_to", "start_date", "end_date"]) {
    assert.equal(dead in p, false, `${dead} must not be sent — the API ignores it`);
  }
});

test("filters and limit survive alongside a range", () => {
  const p = buildBrokerSummaryParams({
    symbol: "BBRI",
    from: "2026-07-28",
    to: "2026-08-01",
    limit: 10,
    transactionType: "BUY",
    marketBoard: "CASH",
    investorType: "FOREIGN",
  });
  assert.equal(p.limit, 10);
  assert.equal(p.transaction_type, "TRANSACTION_TYPE_BUY");
  assert.equal(p.market_board, "MARKET_BOARD_CASH");
  assert.equal(p.investor_type, "INVESTOR_TYPE_FOREIGN");
  assert.equal("period" in p, false);
});
