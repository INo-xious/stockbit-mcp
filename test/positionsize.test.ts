/**
 * The arithmetic people get wrong under time pressure.
 *
 * Every test here corresponds to a specific way of losing more money than intended: rounding lots
 * up, forgetting that a lot is a hundred shares, forgetting commission, putting a stop on a price
 * the exchange rejects, or putting one below the floor and calling it a stop.
 *
 * No network, no account, no session — this is a pure function and the tests say so by never
 * stubbing anything.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { positionSize, DEFAULT_FEE_PCT } from "../src/analysis/positionsize.ts";
import { tickSize, roundToTick, onTickGrid } from "../src/core/ticks.ts";
import { idr } from "../src/core/format.ts";

test("lots are floored, so the risk never exceeds the budget", () => {
  // 4100 entry, 3900 stop: 200/share, 20,000/lot. A 500,000 budget buys 25 lots exactly.
  const exact = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.equal(exact.lots, 25);
  assert.equal(exact.riskIdr, 500_000);

  // 510,000 would be 25.5 lots. Twenty-six lots would risk 520,000 — more than was allowed.
  const inexact = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 510_000 });
  assert.equal(inexact.lots, 25, "rounding up would exceed the stated risk");
  assert.equal(inexact.riskIdr, 500_000);
  assert.equal(inexact.riskBudgetIdr, 510_000, "the budget is reported alongside what was used");
});

test("a lot is a hundred shares, and the position value says so", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.equal(r.shares, 2_500);
  assert.equal(r.positionIdr, 2_500 * 4100);
  assert.equal(r.riskPerShareIdr, 200);
});

test("percent of account and an explicit rupiah figure agree when they should", () => {
  const byPct = positionSize({ entryPrice: 4100, stopPrice: 3900, accountIdr: 50_000_000, riskPct: 1 });
  const byIdr = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.equal(byPct.lots, byIdr.lots);
  assert.equal(byPct.riskBudgetIdr, 500_000);
  assert.ok(byPct.riskPctOfAccount !== null && Math.abs(byPct.riskPctOfAccount - 1) < 1e-9);
  assert.equal(byIdr.riskPctOfAccount, null, "with no account value there is no percentage to report");
});

test("exactly one way of stating the risk, and neither zero nor both", () => {
  assert.throws(
    () => positionSize({ entryPrice: 4100, stopPrice: 3900 }),
    /How much are you willing to lose/,
  );
  assert.throws(
    () => positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000, accountIdr: 50_000_000, riskPct: 1 }),
    /not both/,
  );
  assert.throws(
    () => positionSize({ entryPrice: 4100, stopPrice: 3900, accountIdr: 50_000_000 }),
    /go together/,
  );
});

test("a stop above the entry is a typo, not a short", () => {
  assert.throws(
    () => positionSize({ entryPrice: 3900, stopPrice: 4100, riskIdr: 500_000 }),
    /no short selling/,
  );
  assert.throws(
    () => positionSize({ entryPrice: 4100, stopPrice: 4100, riskIdr: 500_000 }),
    /must be BELOW/,
  );
});

test("zero lots is a warning with the arithmetic in it, not a silent 1", () => {
  // One lot of a 200/share risk costs 20,000. A 5,000 budget cannot buy any of it.
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 5_000 });
  assert.equal(r.lots, 0);
  assert.equal(r.shares, 0);
  assert.equal(r.riskIdr, 0);
  assert.match(r.summary, /^NO POSITION/);
  assert.ok(r.warnings.some((w) => w.includes(idr(20_000)) && w.includes(idr(5_000))));
});

test("an off-grid stop fails a check and names the two valid prices", () => {
  // At 4103 the tick is 10, so 4103 is not a price the exchange accepts.
  assert.equal(tickSize(4103), 10);
  const r = positionSize({ entryPrice: 4100, stopPrice: 4103 - 200, riskIdr: 500_000 });
  assert.equal(r.ticks.stopOnGrid, false, "3903 is off the 10 grid");
  const check = r.checks.find((c) => c.name === "stop on the tick grid");
  assert.ok(check);
  assert.equal(check.ok, false);
  assert.match(check.detail, /REJECTED/);
  assert.equal(r.ticks.nearest?.stop?.below, 3900);
  assert.equal(r.ticks.nearest?.stop?.above, 3910);
  assert.match(r.summary, /BLOCKED/);
});

test("an on-grid entry and stop pass, and the tick is reported", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.equal(r.ticks.entryOnGrid, true);
  assert.equal(r.ticks.stopOnGrid, true);
  assert.equal(r.ticks.tick, 10);
  assert.equal(r.ticks.nearest, undefined);
  assert.ok(r.checks.every((c) => c.ok));
  assert.ok(!r.summary.includes("BLOCKED"));
});

test("a stop below today's floor is called out — it cannot fill", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000, arb: 3950, ara: 4400 });
  assert.equal(r.bands.checked, true);
  assert.equal(r.bands.stopBelowArb, true);
  assert.equal(r.bands.entryAboveAra, false);
  const check = r.checks.find((c) => c.name === "stop within today's ARB");
  assert.ok(check && !check.ok);
  assert.match(check.detail, /floor/);
  assert.ok(r.warnings.some((w) => /auto-rejection floor/.test(w)));
});

test("an entry above today's ceiling is called out too", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000, ara: 4000 });
  assert.equal(r.bands.entryAboveAra, true);
  const check = r.checks.find((c) => c.name === "entry within today's ARA");
  assert.ok(check && !check.ok);
  assert.match(check.detail, /auto-rejected/);
});

test("bands not supplied are reported as unchecked rather than passed", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.equal(r.bands.checked, false);
  assert.equal(r.bands.entryAboveAra, undefined);
  assert.ok(r.warnings.some((w) => /price_bands/.test(w)));
});

test("commission is included, defaulted, and labelled", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.equal(r.feeSource, "default");
  const value = 2_500 * 4100;
  const expected = value * (DEFAULT_FEE_PCT.buy / 100) + value * (DEFAULT_FEE_PCT.sell / 100);
  assert.ok(Math.abs(r.feesRoundTripIdr - expected) < 1e-6);
  assert.ok(r.warnings.some((w) => /published retail rate/.test(w)));

  const supplied = positionSize({
    entryPrice: 4100,
    stopPrice: 3900,
    riskIdr: 500_000,
    feeBuyPct: 0.1,
    feeSellPct: 0.2,
  });
  assert.equal(supplied.feeSource, "supplied");
  assert.ok(supplied.feesRoundTripIdr < r.feesRoundTripIdr);
  assert.ok(!supplied.warnings.some((w) => /published retail rate/.test(w)));
});

test("break-even is above the entry, on the grid, and moves with the fee", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.ok(r.breakEvenPrice > 4100, "commission has to be earned back before flat");
  assert.ok(onTickGrid(r.breakEvenPrice), `${r.breakEvenPrice} is not a valid price`);

  const cheaper = positionSize({
    entryPrice: 4100,
    stopPrice: 3900,
    riskIdr: 500_000,
    feeBuyPct: 0.01,
    feeSellPct: 0.01,
  });
  assert.ok(cheaper.breakEvenPrice <= r.breakEvenPrice, "a lower fee cannot raise break-even");
});

test("R targets are on the grid and evenly spaced in risk terms", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.equal(r.rTargets.r1, 4300);
  assert.equal(r.rTargets.r2, 4500);
  assert.equal(r.rTargets.r3, 4700);
  for (const price of Object.values(r.rTargets)) assert.ok(onTickGrid(price));
});

test("max_lots caps the answer and says it did", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000, maxLots: 10 });
  assert.equal(r.lots, 10);
  assert.equal(r.riskIdr, 200_000, "capping lowers the risk, it does not merely relabel it");
  assert.ok(r.warnings.some((w) => /Capped at 10 lots/.test(w)));
});

test("a very tight stop is flagged as a fee schedule rather than a risk limit", () => {
  // 4100 with a 4095 stop is 0.12% away — inside ordinary intraday noise.
  const r = positionSize({ entryPrice: 4100, stopPrice: 4090, riskIdr: 500_000 });
  assert.ok(r.warnings.some((w) => /fee schedule/.test(w)));
});

test("the summary says what this is not", () => {
  const r = positionSize({ entryPrice: 4100, stopPrice: 3900, riskIdr: 500_000 });
  assert.match(r.summary, /25 lots/);
  assert.match(r.summary, /order_preview/);
  assert.match(r.summary, /arithmetic, not permission/);
});

/* --------------------------------- the tick grid --------------------------------- */

test("the grid bands are the IDX ones, at their boundaries", () => {
  assert.equal(tickSize(199), 1);
  assert.equal(tickSize(200), 2);
  assert.equal(tickSize(499), 2);
  assert.equal(tickSize(500), 5);
  assert.equal(tickSize(1999), 5);
  assert.equal(tickSize(2000), 10);
  assert.equal(tickSize(4999), 10);
  assert.equal(tickSize(5000), 25);
  assert.throws(() => tickSize(0), /positive/);
  assert.throws(() => tickSize(-5), /positive/);
});

test("rounding states its direction, and the result is always on the grid", () => {
  assert.equal(roundToTick(4103, "down"), 4100);
  assert.equal(roundToTick(4103, "up"), 4110);
  assert.equal(roundToTick(4100, "down"), 4100, "already valid, so unchanged");
  assert.equal(roundToTick(4100, "up"), 4100);

  // Crossing a band boundary downward: 200 has a 2 tick, 199 has a 1 tick.
  assert.ok(onTickGrid(roundToTick(201, "down")));
  assert.ok(onTickGrid(roundToTick(5001, "up")));
  assert.ok(onTickGrid(roundToTick(1999, "up")));
});
