/**
 * Paper trading: the same protocol, a local ledger, and no way to reach the exchange.
 *
 * The first assertion in this file is the one the whole feature rests on — **in paper mode no
 * request ever reaches a carina order route**. Everything else is arithmetic that has to be right
 * (average cost carrying commission, realised P&L against it, cash moving the right way) and fill
 * rules that have to be honest about being approximate.
 *
 * The ledger operations are pure functions over a plain object, so most of this runs with no store
 * and no stubbing at all.
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-paper-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  amendPaperOrder,
  cancelPaperOrder,
  emptyLedger,
  loadLedger,
  paperLedgerPath,
  placePaperOrder,
  saveLedger,
  settlePaper,
  snapshot,
  PAPER_BANNER,
  PAPER_FEES,
  type PaperLedger,
  type PaperMarket,
} from "../src/trading/paper.ts";
import { defaultSettings, settingsPath, tradingPolicy } from "../src/settings.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const NOW = new Date("2026-08-25T03:30:00.000Z");
const AT_TOUCH: PaperMarket = { bid: 4090, offer: 4100, last: 4095 };
const AWAY: PaperMarket = { bid: 4090, offer: 4100, last: 4095 };

function ledgerWith(cash: number): PaperLedger {
  return emptyLedger(cash, NOW);
}

function setMode(mode: "off" | "paper" | "live"): void {
  const settings = defaultSettings();
  settings.trading.mode = mode;
  mkdirSync(STORE, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings), "utf8");
}

beforeEach(() => {
  rmSync(paperLedgerPath(), { force: true });
  setMode("paper");
});

/* ------------------------------- the boundary that matters ------------------------------- */

test("in paper mode nothing can reach a carina order route", async () => {
  // The route table is what actually enforces this; the point here is that paper mode does not
  // quietly acquire a second way to the exchange. If `performPaperOrder` ever fell through to
  // `postJson`, this fails — the fetch stub records every request that leaves.
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    throw new Error("no network in this test");
  }) as typeof fetch;

  try {
    const { previewOrder } = await import("../src/trading/preview.ts");
    await previewOrder({ action: "buy", symbol: "BBRI", price: 4100, lots: 1 }).catch(() => undefined);
  } finally {
    globalThis.fetch = realFetch;
  }

  const orderRoutes = seen.filter((url) => /carina\.stockbit\.com\/.*order/i.test(url) );
  assert.deepEqual(orderRoutes, [], `a request reached a carina order route: ${orderRoutes.join(", ")}`);
});

test("the policy in paper mode is enabled but not live", () => {
  const policy = tradingPolicy({});
  assert.equal(policy.mode, "paper");
  assert.equal(policy.enabled, true);
  assert.equal(policy.live, false);
});

/* ------------------------------------- placing ------------------------------------- */

test("a marketable buy fills at the limit, and the cash moves by gross plus commission", () => {
  const ledger = ledgerWith(100_000_000);
  const result = placePaperOrder(ledger, { symbol: "BBRI", action: "buy", price: 4100, lots: 10 }, AT_TOUCH, NOW);

  assert.equal(result.filled, true);
  assert.equal(result.order.status, "filled");
  assert.equal(result.order.fillPrice, 4100, "fills at the limit, not at the touch — no free price improvement");

  const gross = 1000 * 4100;
  const fee = gross * (PAPER_FEES.buyPct / 100);
  assert.ok(Math.abs(result.ledger.cashIdr - (100_000_000 - gross - fee)) < 1e-6);
  assert.equal(result.ledger.positions.BBRI.shares, 1000);
  // Average cost carries the commission, so a "break-even" reading is a real one.
  assert.ok(result.ledger.positions.BBRI.avgPrice > 4100);
  assert.ok(Math.abs(result.ledger.positions.BBRI.avgPrice - (gross + fee) / 1000) < 1e-9);
});

test("a buy below the market is left open and says why", () => {
  const ledger = ledgerWith(100_000_000);
  const result = placePaperOrder(ledger, { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, AWAY, NOW);
  assert.equal(result.filled, false);
  assert.equal(result.order.status, "open");
  assert.match(result.reason, /Left OPEN/);
  assert.equal(result.ledger.cashIdr, 100_000_000, "an unfilled order costs nothing");
  assert.equal(result.ledger.positions.BBRI, undefined);
});

test("a buy the ledger cannot afford is refused, with the arithmetic", () => {
  const ledger = ledgerWith(1_000_000);
  assert.throws(
    () => placePaperOrder(ledger, { symbol: "BBRI", action: "buy", price: 4100, lots: 10 }, AT_TOUCH, NOW),
    (err: Error) => {
      assert.match(err.message, new RegExp(PAPER_BANNER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(err.message, /Not enough cash/);
      return true;
    },
  );
});

test("a sell of more than the ledger holds is refused — there is no short selling", () => {
  const bought = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4100, lots: 5 }, AT_TOUCH, NOW);
  assert.throws(
    () => placePaperOrder(bought.ledger, { symbol: "BBRI", action: "sell", price: 4200, lots: 10 }, { bid: 4200, offer: 4210, last: 4205 }, NOW),
    /no short selling/,
  );
});

/* ------------------------------------ the round trip ------------------------------------ */

test("a sell realises P&L against the commission-inclusive average, and clears the position", () => {
  const bought = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, { bid: 3990, offer: 4000, last: 3995 }, NOW);
  const avg = bought.ledger.positions.BBRI.avgPrice;

  const sold = placePaperOrder(bought.ledger, { symbol: "BBRI", action: "sell", price: 4200, lots: 10 }, { bid: 4200, offer: 4210, last: 4205 }, NOW);
  assert.equal(sold.filled, true);
  assert.equal(sold.ledger.positions.BBRI, undefined, "selling everything removes the holding");

  const gross = 1000 * 4200;
  const sellFee = gross * (PAPER_FEES.sellPct / 100);
  const expected = gross - sellFee - avg * 1000;
  const fill = sold.ledger.fills.at(-1)!;
  assert.ok(fill.realisedIdr !== undefined);
  assert.ok(Math.abs(fill.realisedIdr - expected) < 1e-6, `realised ${fill.realisedIdr}, expected ${expected}`);

  // Cash back = starting - buy cost + sell proceeds, and the round trip loses both commissions.
  assert.ok(sold.ledger.cashIdr > 100_000_000, "a 5% move covers 0.4% of commission");
});

test("a partial sell leaves the average price alone", () => {
  const bought = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, { bid: 3990, offer: 4000, last: 3995 }, NOW);
  const avg = bought.ledger.positions.BBRI.avgPrice;
  const sold = placePaperOrder(bought.ledger, { symbol: "BBRI", action: "sell", price: 4200, lots: 4 }, { bid: 4200, offer: 4210, last: 4205 }, NOW);
  assert.equal(sold.ledger.positions.BBRI.shares, 600);
  assert.equal(sold.ledger.positions.BBRI.avgPrice, avg, "selling does not re-price what is left");
});

test("two buys at different prices average correctly", () => {
  const first = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, { bid: 3990, offer: 4000, last: 3995 }, NOW);
  const second = placePaperOrder(first.ledger, { symbol: "BBRI", action: "buy", price: 4200, lots: 10 }, { bid: 4190, offer: 4200, last: 4195 }, NOW);
  const position = second.ledger.positions.BBRI;
  assert.equal(position.shares, 2000);
  const expected = (4000 * 1000 * 1.0015 + 4200 * 1000 * 1.0015) / 2000;
  assert.ok(Math.abs(position.avgPrice - expected) < 1e-6);
});

/* ------------------------------------- settlement ------------------------------------- */

test("an open order fills when the session later prints through the limit", () => {
  const placed = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, AWAY, NOW);
  assert.equal(placed.filled, false);

  const settled = settlePaper(placed.ledger, { intradayBySymbol: { BBRI: [4090, 4050, 3995, 4010] } }, NOW);
  assert.equal(settled.filled.length, 1);
  assert.equal(settled.ledger.orders[0].status, "filled");
  assert.equal(settled.ledger.orders[0].fillPrice, 4000, "fills at the limit, not at the print");
  assert.equal(settled.ledger.positions.BBRI.shares, 1000);
});

test("an open order that the session never reached stays open", () => {
  const placed = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 3500, lots: 10 }, AWAY, NOW);
  const settled = settlePaper(placed.ledger, { intradayBySymbol: { BBRI: [4090, 4050, 3995] } }, NOW);
  assert.deepEqual(settled.filled, []);
  assert.equal(settled.ledger.orders[0].status, "open");
});

test("an open sell fills when the session prints at or above the limit", () => {
  const bought = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4100, lots: 10 }, AT_TOUCH, NOW);
  const placed = placePaperOrder(bought.ledger, { symbol: "BBRI", action: "sell", price: 4500, lots: 10 }, { bid: 4100, offer: 4110, last: 4105 }, NOW);
  assert.equal(placed.filled, false);

  const settled = settlePaper(placed.ledger, { intradayBySymbol: { BBRI: [4200, 4400, 4510] } }, NOW);
  assert.equal(settled.filled.length, 1);
  assert.equal(settled.ledger.positions.BBRI, undefined);
});

test("a symbol with no series leaves its orders alone rather than guessing", () => {
  const placed = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, AWAY, NOW);
  const settled = settlePaper(placed.ledger, { intradayBySymbol: {} }, NOW);
  assert.deepEqual(settled.filled, []);
  assert.equal(settled.ledger.orders[0].status, "open");
});

/* --------------------------------- cancel and amend --------------------------------- */

test("an open order can be cancelled; a filled one cannot", () => {
  const open = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, AWAY, NOW);
  const cancelled = cancelPaperOrder(open.ledger, open.order.id);
  assert.equal(cancelled.order.status, "cancelled");

  const filled = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4100, lots: 10 }, AT_TOUCH, NOW);
  assert.throws(() => cancelPaperOrder(filled.ledger, filled.order.id), /is filled, not open/);
  assert.throws(() => cancelPaperOrder(filled.ledger, "nope"), /No paper order with id/);
});

test("an amend replaces the order rather than editing it, and says which replaced which", () => {
  // Replace rather than edit because that is what the exchange does — an amended order loses its
  // queue position, and pretending otherwise would flatter a strategy that amends often.
  const open = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, AWAY, NOW);
  const amended = amendPaperOrder(open.ledger, open.order.id, { price: 4100, lots: 5 }, AT_TOUCH, NOW);

  const original = amended.ledger.orders.find((o) => o.id === open.order.id)!;
  assert.equal(original.status, "amended");
  assert.equal(original.replacedBy, amended.order.id);
  assert.equal(amended.order.price, 4100);
  assert.equal(amended.order.lots, 5);
  assert.equal(amended.filled, true, "the new terms were marketable");
  assert.match(amended.reason, /Amended/);
});

/* -------------------------------------- reading -------------------------------------- */

test("the snapshot marks holdings, and says so when it cannot", () => {
  const bought = placePaperOrder(ledgerWith(100_000_000), { symbol: "BBRI", action: "buy", price: 4000, lots: 10 }, { bid: 3990, offer: 4000, last: 3995 }, NOW);

  const marked = snapshot(bought.ledger, { BBRI: 4400 });
  assert.equal(marked.holdings.length, 1);
  assert.equal(marked.holdings[0].lastPrice, 4400);
  assert.ok((marked.holdings[0].unrealisedIdr ?? 0) > 0);
  assert.ok(marked.totalValueIdr !== null);
  assert.match(marked.summary, /^PAPER ACCOUNT/);
  assert.match(marked.summary, /approximate/);

  const unmarked = snapshot(bought.ledger, { BBRI: null });
  assert.equal(unmarked.holdings[0].lastPrice, undefined);
  assert.equal(unmarked.totalValueIdr, null, "an unmarkable holding means no total, not a wrong one");
  assert.match(unmarked.summary, /could not be marked/);
});

/* ------------------------------------ persistence ------------------------------------ */

test("the ledger round-trips through disk", () => {
  const placed = placePaperOrder(ledgerWith(50_000_000), { symbol: "BBRI", action: "buy", price: 4100, lots: 2 }, AT_TOUCH, NOW);
  saveLedger(placed.ledger);

  const read = loadLedger();
  assert.equal(read.cashIdr, placed.ledger.cashIdr);
  assert.equal(read.positions.BBRI.shares, 200);
  assert.equal(read.orders.length, 1);
  assert.equal(read.fills.length, 1);
});

test("a missing ledger is a new account; a corrupt one is an error, not a silent reset", () => {
  rmSync(paperLedgerPath(), { force: true });
  const fresh = loadLedger(7_000_000);
  assert.equal(fresh.cashIdr, 7_000_000);
  assert.deepEqual(fresh.orders, []);

  mkdirSync(join(STORE, "paper"), { recursive: true });
  writeFileSync(paperLedgerPath(), "{ not json", "utf8");
  assert.throws(() => loadLedger(), /could not be read/);
  assert.throws(() => loadLedger(), /paper-reset/, "and it says how to start over deliberately");
});

/* --------------------------------------- e-IPO --------------------------------------- */

test("e-IPO refuses in paper mode rather than simulating an allotment", async () => {
  // An exchange fill is a function of price and a queue — approximable. An allotment is a function
  // of national demand, which is not. A simulated one would be a number this project invented.
  const { previewEipoOrder } = await import("../src/eipo/order.ts");
  await assert.rejects(
    () => previewEipoOrder({ emitenCode: "TEST", lots: 1, price: 1000 }),
    /no paper e-IPO/i,
  );
});
