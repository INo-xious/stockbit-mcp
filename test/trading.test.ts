/**
 * Order entry. ADR-0004.
 *
 * The tests here are not about whether an order can be placed. They are about every path on which
 * one must NOT be, and about what is said when the outcome is not known — because those are the
 * paths with no undo. A chart save that goes wrong is restored from a snapshot; an order that goes
 * wrong is an order.
 *
 * So the shape of this file is: first, a long list of refusals, each asserting that ZERO requests
 * left the process. Then the outcome classes, one test each, driven by a fake account that can lie
 * in every way a real one can — accept and hide the order, error after accepting it, error without
 * accepting it, or fail the read-back that would have told us which.
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-orders-"));
delete process.env.STOCKBIT_TRADING;

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { StockbitError } from "../src/http/errors.ts";
import { settingsPath, defaultSettings, tradingPolicy } from "../src/settings.ts";
import {
  clearTickets,
  issue,
  peek,
  resetClock,
  setClock,
  slotCount,
  take,
  TICKET_TTL_MS,
} from "../src/trading/tickets.ts";
import { idr, nearestTicks, previewOrder, tickSize } from "../src/trading/preview.ts";
import {
  orderBody,
  orderLogPath,
  placeBuy,
  placeSell,
  cancelOrder,
  submitOrder,
  verifyAgainst,
} from "../src/trading/orders.ts";
import { describeRemember, forgetRemember, REMEMBER_TTL_MS } from "../src/trading/remember.ts";
import { resolveConfirmation } from "../src/trading/confirmation.ts";
import { registerTradingTools } from "../src/tools/trading.ts";
import type { Definer, ToolHandler } from "../src/tools/_define.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* ------------------------------- the fake account ------------------------------- */

interface OrderRow {
  order_id: string;
  symbol: string;
  action: string;
  status: string;
  price: number;
  shares: number;
  ui_ref?: string;
}

/** Every way a real brokerage can behave badly, as switches. */
const wire = {
  /** Answer the buy with this status instead of accepting it. */
  rejectBuyWith: null as null | { status: number; body: unknown },
  /** Accept the buy, but put it on the book already rejected. */
  exchangeRejects: false,
  /** Fail the buy request at the socket. `landed` records it anyway; `lost` does not. */
  dropBuyResponse: null as null | "landed" | "lost",
  /**
   * Fail every order-list call from the Nth (1-based) onward.
   *
   * From, not at: `getJson` retries a 5xx, so a knob that failed one call would be retried straight
   * into a success and the test would prove nothing.
   */
  failListFrom: null as null | number,
  /** Whether the order list echoes `ui_ref` back. When it does not, verification falls to a diff. */
  echoUiRef: true,
  /** Answer the buy with a Cloudflare challenge rather than an entitlement error. */
  challengeOnBuy: false,
  /** Accept the order and never show it in the list. */
  hideOrder: false,
};

let book: OrderRow[] = [];
let listCalls = 0;
const sent: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const QUOTE = { data: { id: "59", name: "Bank BRI", price: "4250", change: "10", percentage: "0.2" } };
const BOOK = { data: { ara: "4675", arb: "3825", fbuy: "1", fsell: "2", fnet: "-1", bid: "4240", offer: "4260" } };
const SESSION = { data: { status: "SESSION_1" } };
const TRADABLE = { data: { list: [{ symbol: "BBRI", tradable: true }] } };
const FORMULA = { data: { buy_fee: 0.0015, sell_fee: 0.0025 } };
const CASH = { data: { cash: 50_000_000, buying_power: 60_000_000 } };
const POSITION = { data: { symbol: "BBRI", lot: 40, available_lot: 40, average_price: 4000 } };

before(() => {
  getStore("main").set("MAIN-REFRESH");
  getStore("securities").set("SECURITIES-REFRESH");
  resetSession();

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const path = new URL(u).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (path.endsWith("/auth/refresh") || path.includes("/login/refresh")) {
      return json({ data: { access_token: farFutureJwt() } });
    }

    if (path.includes("/order/v2/list")) {
      listCalls++;
      if (wire.failListFrom !== null && listCalls >= wire.failListFrom) {
        return new Response("upstream is down", { status: 503 });
      }
      return json({
        data: { list: book.map((row) => (wire.echoUiRef ? row : { ...row, ui_ref: undefined })) },
      });
    }

    if (path.includes("/order/v2/")) {
      sent.push({ url: u, body });
      const action = path.split("/").pop()!;
      const row: OrderRow = {
        order_id: `ORD-${book.length + 1}`,
        symbol: String(body.symbol ?? "BBRI"),
        action,
        status: wire.exchangeRejects ? "REJECTED" : "OPEN",
        price: Number(body.price ?? 0),
        shares: Number(body.shares ?? 0),
        ui_ref: String(body.ui_ref),
      };

      if (action === "cancel") {
        book = book.filter((o) => o.order_id !== body.order_id);
        return json({ data: { status: "ok" } });
      }
      if (wire.challengeOnBuy) {
        return new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } });
      }
      if (wire.rejectBuyWith) {
        return json(wire.rejectBuyWith.body, wire.rejectBuyWith.status);
      }
      if (wire.dropBuyResponse) {
        if (wire.dropBuyResponse === "landed") book.push(row);
        throw new TypeError("socket hang up");
      }
      if (!wire.hideOrder) book.push(row);
      return json({ data: { order_id: row.order_id } });
    }

    if (path.includes("/emitten/")) return json(QUOTE);
    if (path.includes("/orderbook/companies/")) return json(BOOK);
    if (path.includes("/market-time/session")) return json(SESSION);
    if (path.includes("/stock/tradable")) return json(TRADABLE);
    if (path.includes("/formula/v2")) return json(FORMULA);
    if (path.includes("/balance/cash")) return json(CASH);
    if (path.includes("/portfolio/v2/detail")) return json(POSITION);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  resetClock();
  getStore("main").clear();
  getStore("securities").clear();
});

/** Write the settings file directly. `saveSettings` is deliberately unreachable from src/trading. */
function setPolicy(trading: Partial<ReturnType<typeof defaultSettings>["trading"]>): void {
  const settings = defaultSettings();
  settings.trading = { ...settings.trading, ...trading };
  mkdirSync(process.env.STOCKBIT_STORE_DIR!, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings), "utf8");
}

beforeEach(() => {
  clearCache();
  clearTickets();
  // A "don't ask again" is process memory, so it would otherwise leak from one test into the next
  // and make a later test pass for the wrong reason.
  forgetRemember();
  resetClock();
  resetSession();
  getStore("main").set("MAIN-REFRESH");
  getStore("securities").set("SECURITIES-REFRESH");
  book = [];
  listCalls = 0;
  sent.length = 0;
  wire.rejectBuyWith = null;
  wire.exchangeRejects = false;
  wire.dropBuyResponse = null;
  wire.failListFrom = null;
  wire.echoUiRef = true;
  wire.challengeOnBuy = false;
  wire.hideOrder = false;
  delete process.env.STOCKBIT_TRADING;
  setPolicy({ mode: "live", maxOrderValueIdr: 100_000_000 });
});

/** A ticket for 5 lots of BBRI at 4100 — inside the band, on the tick grid, affordable. */
async function buyTicket(overrides: { price?: number; lots?: number } = {}) {
  return previewOrder({ action: "buy", symbol: "BBRI", price: overrides.price ?? 4100, lots: overrides.lots ?? 5 });
}

/* ---------------------------------- tick sizes ---------------------------------- */

test("the IDX tick table, at every boundary", () => {
  // Boundaries, not midpoints: an off-by-one here puts a valid price one tick outside the grid and
  // the exchange rejects it with no explanation a user would recognise.
  assert.equal(tickSize(50), 1);
  assert.equal(tickSize(199), 1);
  assert.equal(tickSize(200), 2);
  assert.equal(tickSize(499), 2);
  assert.equal(tickSize(500), 5);
  assert.equal(tickSize(1999), 5);
  assert.equal(tickSize(2000), 10);
  assert.equal(tickSize(4999), 10);
  assert.equal(tickSize(5000), 25);
  assert.equal(tickSize(12_000), 25);
  assert.throws(() => tickSize(0), /positive number/);
  assert.throws(() => tickSize(-5), /positive number/);
});

test("an off-grid price names the two valid prices on either side", () => {
  assert.deepEqual(nearestTicks(4105), { below: 4100, above: 4110 });
  assert.deepEqual(nearestTicks(313), { below: 312, above: 314 });
});

test("rupiah are grouped the same way every time, whatever the machine's locale", () => {
  assert.equal(idr(2_050_000), "Rp 2,050,000");
  assert.equal(idr(0), "Rp 0");
  assert.equal(idr(null), "unknown");
});

/* ------------------------------------ preview ------------------------------------ */

test("the preview's arithmetic is the arithmetic the user is agreeing to", async () => {
  const ticket = await buyTicket();
  assert.equal(ticket.shares, 500, "5 lots is 500 shares");
  assert.equal(ticket.grossIdr, 2_050_000);
  assert.equal(ticket.feePct, 0.15, "0.0015 on the wire is 0.15%");
  assert.equal(ticket.feeIdr, 3075);
  assert.equal(ticket.netIdr, 2_053_075, "a buy costs gross PLUS commission");
  assert.equal(ticket.feeSource, "formula");
});

test("a sell's net is gross MINUS commission — the direction that matters to the user", async () => {
  const ticket = await previewOrder({ action: "sell", symbol: "BBRI", price: 4100, lots: 5 });
  assert.equal(ticket.feePct, 0.25);
  assert.equal(ticket.netIdr, 2_050_000 - ticket.feeIdr!);
  assert.match(ticket.summary, /You would receive/);
});

test("the summary carries every number the user is being asked about", async () => {
  const ticket = await buyTicket();
  for (const fragment of ["BUY 5 lots", "500 shares", "BBRI", "Rp 4,100", "Rp 2,050,000", "Rp 2,053,075"]) {
    assert.ok(ticket.summary.includes(fragment), `the summary must state ${fragment}: ${ticket.summary}`);
  }
  assert.match(ticket.summary, /Last traded Rp 4,250/);
  assert.match(ticket.summary, /band runs Rp 3,825 to Rp 4,675/);
});

test("an off-grid price fails a check and says which prices are valid", async () => {
  const ticket = await previewOrder({ action: "buy", symbol: "BBRI", price: 4105, lots: 1 });
  const tick = ticket.checks.find((c) => c.name === "price_tick")!;
  assert.equal(tick.ok, false);
  assert.match(tick.detail, /Rp 4,100 and Rp 4,110/);
  assert.match(ticket.summary, /CANNOT BE PLACED/);
});

test("a price outside the auto-rejection band fails, and says which side", async () => {
  const high = await previewOrder({ action: "buy", symbol: "BBRI", price: 4700, lots: 1 });
  assert.equal(high.checks.find((c) => c.name === "price_within_bands")!.ok, false);
  assert.match(high.checks.find((c) => c.name === "price_within_bands")!.detail, /ceiling/);

  const low = await previewOrder({ action: "buy", symbol: "BBRI", price: 3800, lots: 1 });
  assert.match(low.checks.find((c) => c.name === "price_within_bands")!.detail, /floor/);
});

test("a check that could not be run passes, is marked unverified, and is named in the warnings", async () => {
  // The alternative — failing closed — would brick order entry the first time a key name on this
  // never-observed host did not match, for a reason with nothing to do with the order.
  wire.failListFrom = 1;
  const ticket = await previewOrder({ action: "cancel", symbol: "BBRI", orderId: "ORD-9" });
  const check = ticket.checks.find((c) => c.name === "cancel_target_open")!;
  assert.equal(check.ok, true);
  assert.equal(check.unverified, true);
  assert.match(ticket.warnings.join(" "), /not contradicted/);
  assert.match(ticket.summary, /could not be verified/);
});

test("a cancel whose order list is unreadable and whose symbol is unknown is refused, not guessed", async () => {
  wire.failListFrom = 1;
  await assert.rejects(
    () => previewOrder({ action: "cancel", orderId: "ORD-9" }),
    /Pass `symbol` explicitly/,
  );
});

test("an order value over the configured cap fails the check", async () => {
  setPolicy({ mode: "live", maxOrderValueIdr: 1_000_000 });
  const ticket = await buyTicket();
  const check = ticket.checks.find((c) => c.name === "value_within_cap")!;
  assert.equal(check.ok, false);
  assert.match(check.detail, /Rp 2,050,000 exceeds/);
});

test("a symbol off the allow-list fails, and the message says how to change it", async () => {
  setPolicy({ mode: "live", allowedSymbols: ["TLKM"] });
  const ticket = await buyTicket();
  const check = ticket.checks.find((c) => c.name === "symbol_allowed")!;
  assert.equal(check.ok, false);
  assert.match(check.detail, /trading-enable --symbols/);
});

test("a ticket is still issued when checks fail — the user asked what would happen", async () => {
  setPolicy({ mode: "off" });
  const ticket = await buyTicket();
  assert.ok(peek(ticket.id), "the ticket exists");
  assert.equal(ticket.checks.find((c) => c.name === "trading_enabled")!.ok, false);
});

/* ------------------------------------ tickets ------------------------------------ */

test("a ticket expires, and take() says so rather than repricing it", async () => {
  const ticket = await buyTicket();
  setClock(() => Date.parse(ticket.expiresAt) + 1);
  assert.equal(peek(ticket.id), undefined);
  assert.throws(() => take(ticket.id), /expired/);
});

test("a ticket can only be spent once", async () => {
  const ticket = await buyTicket();
  take(ticket.id);
  assert.throws(() => take(ticket.id), /already used/);
});

test("a ticket whose checks failed is refused by take, not merely discouraged", async () => {
  setPolicy({ mode: "off" });
  const ticket = await buyTicket();
  assert.throws(() => take(ticket.id), /trading_enabled/);
});

test("an unknown ticket id says tickets are in memory and short-lived", () => {
  assert.throws(() => take("tk_nothing"), /expired, was already used, or belongs to a previous run/);
});

/* ------------------------------- refusals: no wire ------------------------------- */

/** Every refusal below must leave `sent` empty. That assertion IS the test. */
async function refuses(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  sent.length = 0;
  await assert.rejects(fn, pattern);
  assert.deepEqual(sent, [], "nothing may reach the order endpoints on a refused path");
}

test("trading off by default: the tool exists, refuses, and names the settings file", async () => {
  const ticket = await buyTicket();
  setPolicy({ mode: "off" });
  await refuses(() => placeBuy({ ticketId: ticket.id, confirm: true }), /Trading is off/);
  const policy = tradingPolicy();
  assert.match(policy.reason, /trading-enable/);
  assert.ok(policy.settingsPath.endsWith("settings.json"));
});

test("STOCKBIT_TRADING=off overrides an enabled settings file", async () => {
  const ticket = await buyTicket();
  process.env.STOCKBIT_TRADING = "off";
  await refuses(() => placeBuy({ ticketId: ticket.id, confirm: true }), /STOCKBIT_TRADING/);
});

test("the environment can turn trading OFF and can never turn it on", () => {
  setPolicy({ mode: "off" });
  for (const value of ["on", "1", "true", "yes", "ON"]) {
    process.env.STOCKBIT_TRADING = value;
    assert.equal(tradingPolicy().enabled, false, `STOCKBIT_TRADING=${value} must not enable trading`);
  }
  delete process.env.STOCKBIT_TRADING;
});

test("no confirmation, no order — and the refusal tells the model not to set it itself", async () => {
  const ticket = await buyTicket();
  await refuses(() => placeBuy({ ticketId: ticket.id }), /Do not set it on their behalf/);
  assert.ok(peek(ticket.id), "a refused call must NOT spend the ticket");
});

test("autoConfirm without a value cap is refused, not honoured", async () => {
  // The rule the whole switch rests on: "I trust it for small orders" must not silently become
  // "I trust it for any order" the day the cap is removed.
  setPolicy({ mode: "live", autoConfirm: true, maxOrderValueIdr: null });
  const ticket = await buyTicket();
  await refuses(() => placeBuy({ ticketId: ticket.id }), /honoured only when maxOrderValueIdr is also set/);
  assert.match(tradingPolicy().autoConfirmIgnored ?? "", /maxOrderValueIdr/);
});

test("autoConfirm covers an order under the cap and refuses one over it", async () => {
  setPolicy({ mode: "live", autoConfirm: true, maxOrderValueIdr: 3_000_000 });
  const small = await buyTicket();
  const result = await placeBuy({ ticketId: small.id });
  assert.equal(result.outcome, "ok");

  // Refused on the ticket's own `value_within_cap` check rather than on autoConfirm's, and the
  // change of message is deliberate. `maxOrderValueIdr` is BOTH caps — the one autoConfirm is
  // bounded by and the one the preview checks — so an order over it can never be placed, and the
  // old wording ("Ask the user and pass confirm: true") was advice that could not have worked. The
  // refusal now names the thing that actually blocks it.
  setPolicy({ mode: "live", autoConfirm: true, maxOrderValueIdr: 1_000_000 });
  const big = await buyTicket();
  await refuses(() => placeBuy({ ticketId: big.id }), /value_within_cap — Rp 2,050,000 exceeds/);
});

test("an expired ticket is refused at the write, not repriced", async () => {
  const ticket = await buyTicket();
  setClock(() => Date.parse(ticket.expiresAt) + 1);
  await refuses(() => placeBuy({ ticketId: ticket.id, confirm: true }), /expired/);
});

test("a ticket whose checks failed cannot be redeemed even with confirm", async () => {
  const ticket = await previewOrder({ action: "buy", symbol: "BBRI", price: 4105, lots: 1 });
  await refuses(() => placeBuy({ ticketId: ticket.id, confirm: true }), /price_tick/);
});

test("a doctored ticket is caught by its own fingerprint", async () => {
  // The two-step protocol's promise is that what is placed is what was shown. A ticket object
  // mutated between the two steps breaks that promise, and this is what notices.
  const ticket = await buyTicket();
  (peek(ticket.id) as { price: number }).price = 1;
  await refuses(() => placeBuy({ ticketId: ticket.id, confirm: true }), /does not match its own fingerprint/);
});

test("a buy ticket cannot be redeemed by the sell tool", async () => {
  const ticket = await buyTicket();
  await refuses(() => placeSell({ ticketId: ticket.id, confirm: true }), /is a BUY and this is the SELL tool/);
  assert.ok(peek(ticket.id), "and the mismatch does not spend the ticket");
});

test("a snapshot that cannot be read aborts before the order, not after", async () => {
  const ticket = await buyTicket();
  wire.failListFrom = 1;
  await refuses(() => placeBuy({ ticketId: ticket.id, confirm: true }), /no way to tell whether this order landed/);
  const log = readFileSync(orderLogPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log[log.length - 1].outcome, "aborted-no-snapshot");
});

test("lock contention refuses instead of waiting — two orders from one intention is the risk", async () => {
  const ticket = await buyTicket();
  mkdirSync(join(process.env.STOCKBIT_STORE_DIR!, "order-BBRI.lock"), { recursive: true });
  try {
    // The refusal names both causes of a null lock: a concurrent order, and a lock that could not
    // be created at all. `acquireDirLock` gained the second when it stopped holding locks whose
    // owner token it could not write — naming only the first would assert a cause this file did not
    // establish. What must not change is that nothing is sent.
    await refuses(
      () => placeBuy({ ticketId: ticket.id, confirm: true }),
      /Could not take the order lock for BBRI.*another order on it is in flight/s,
    );
  } finally {
    // Left behind deliberately by the failure path; removed here so later tests can take it.
    const { rmSync } = await import("node:fs");
    rmSync(join(process.env.STOCKBIT_STORE_DIR!, "order-BBRI.lock"), { recursive: true, force: true });
  }
});

/* ---------------------------------- the request ---------------------------------- */

test("the body is exactly what plan §2.4 says, in shares and with the ticket's ui_ref", async () => {
  const ticket = await buyTicket();
  await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body, {
    ui_ref: ticket.uiRef,
    symbol: "BBRI",
    price: 4100,
    shares: 500,
    board_type: "RG",
    is_gtc: false,
    time_in_force: "0",
    split_order: false,
  });
  assert.ok(sent[0].url.endsWith("/order/v2/buy"));
});

test("platform_order_type is deliberately absent, and lots never reach the wire", async () => {
  const ticket = await buyTicket();
  const body = orderBody(ticket) as Record<string, unknown>;
  assert.equal("platform_order_type" in body, false, "an enum whose vocabulary is unobserved is not invented");
  assert.equal("lot" in body || "lots" in body, false, "the wire takes shares");
});

test("a cancel body carries the order id and the ui_ref and nothing else", async () => {
  book = [{ order_id: "ORD-7", symbol: "BBRI", action: "buy", status: "OPEN", price: 4100, shares: 500 }];
  const ticket = await previewOrder({ action: "cancel", orderId: "ORD-7" });
  await cancelOrder({ ticketId: ticket.id, confirm: true });
  assert.deepEqual(sent[0].body, { order_id: "ORD-7", ui_ref: ticket.uiRef });
});

/* -------------------------------- outcome classes -------------------------------- */

test("ok: accepted, and seen on the book by its ui_ref", async () => {
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.verified, true);
  assert.equal(result.orderId, "ORD-1");
  assert.equal(result.logged, true);
});

test("ok: verified by a diff when the list does not echo ui_ref", async () => {
  // Stockbit's list has never been observed, so it may not return the handle we sent. A verification
  // that only knew how to match on `ui_ref` would report every real order as not-visible.
  wire.echoUiRef = false;
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "ok");
  assert.equal(result.orderId, "ORD-1");
});

test("rejected: on the book with a rejected status is a failure, not a success", async () => {
  wire.exchangeRejects = true;
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "rejected");
  assert.equal(result.verified, false);
});

test("write-failed: a 4xx means nothing reached the exchange", async () => {
  wire.rejectBuyWith = { status: 400, body: { message: "bad board type" } };
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "write-failed");
  assert.equal(result.verified, false);
});

test("rejected: a 4xx that names a rejection is reported as one", async () => {
  wire.rejectBuyWith = { status: 400, body: { message: "order rejected: insufficient funds" } };
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "rejected");
});

test("not-visible: accepted but absent from the read-back, and the user is told not to resend", async () => {
  wire.hideOrder = true;
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "not-visible");
  assert.equal(result.verified, false);
  assert.match(result.outcomeUnknown!, /Do NOT resend/);
});

test("landed-despite-error: the request failed and the order is there anyway", async () => {
  wire.dropBuyResponse = "landed";
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "landed-despite-error");
  assert.equal(result.verified, true);
  assert.match(result.outcomeUnknown!, /must not be/);
});

test("not-found-after-error: the request failed and the book is clean", async () => {
  wire.dropBuyResponse = "lost";
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "not-found-after-error");
  assert.equal(result.verified, false);
});

test("outcome-unknown: the request failed AND the read-back failed", async () => {
  // The worst case, and the one that must not be dressed up. Reporting it as a failure would invite
  // a resend; reporting it as a success would be a lie.
  wire.dropBuyResponse = "landed";
  wire.failListFrom = 2;
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "outcome-unknown");
  assert.match(result.outcomeUnknown!, /Do not resend/);
});

test("outcome-unknown: accepted, but the read-back failed", async () => {
  wire.failListFrom = 2;
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.outcome, "outcome-unknown");
  assert.equal(result.verified, false);
});

test("a Cloudflare challenge is reported as a challenge, not as an entitlement problem", async () => {
  wire.challengeOnBuy = true;
  const ticket = await buyTicket();
  const result = await placeBuy({ ticketId: ticket.id, confirm: true });
  assert.equal(result.verified, false);
  assert.match(result.error!, /challenge/i);
});

/* ---------------------------------- the audit log ---------------------------------- */

test("every attempt appends one line, and the line names the outcome and how it was confirmed", async () => {
  const before = existsSync(orderLogPath()) ? readFileSync(orderLogPath(), "utf8").split("\n").length : 0;
  const ticket = await buyTicket();
  await placeBuy({ ticketId: ticket.id, confirm: true });
  const lines = readFileSync(orderLogPath(), "utf8").trim().split("\n");
  assert.ok(lines.length > before - 1);
  const entry = JSON.parse(lines[lines.length - 1]);
  assert.equal(entry.outcome, "ok");
  // NOT "explicit". That value used to mean two different things — "a person clicked yes" and "a
  // model asserted one had" — and an audit trail whose vocabulary cannot tell those apart is the
  // defect ADR-0010 is about. No `elicit` is wired into this harness, so nobody was asked, and the
  // line says exactly that.
  assert.equal(entry.via, "explicit-unelicited");
  assert.equal(entry.elicitation, "unavailable");
  assert.equal(entry.symbol, "BBRI");
  assert.equal(entry.shares, 500);
});

test("the audit vocabulary no longer contains the word that conflated two things", async () => {
  // Pinned as a property of the whole file rather than of one line: `via: "explicit"` must not be
  // reachable by any path, because its whole problem was that it was reachable by two.
  const ticket = await buyTicket();
  await placeBuy({ ticketId: ticket.id, confirm: true });
  const contents = readFileSync(orderLogPath(), "utf8");
  assert.equal(/"via":"explicit"/.test(contents), false, "no line may claim the old, ambiguous value");
});

test("the log never carries a credential", async () => {
  const ticket = await buyTicket();
  await placeBuy({ ticketId: ticket.id, confirm: true });
  const contents = readFileSync(orderLogPath(), "utf8");
  assert.equal(contents.includes("SECURITIES-REFRESH"), false);
  assert.equal(/eyJ[A-Za-z0-9_-]+\./.test(contents), false, "no JWT may appear in the audit log");
});

/* ---------------------------------- elicitation ---------------------------------- */

/**
 * The human channel, as the gate sees it.
 *
 * `answers` is the sequence of replies, one per call, so a test can drive two orders through one
 * harness. `calls` is what proves the ask HAPPENED — which, since ADR-0010, is as much of the
 * property as the answer is.
 */
function fakeElicit(...answers: Array<"accepted" | "declined" | "unavailable" | { remember: true }>) {
  const calls: Array<{ message: string; prompt?: Record<string, unknown> }> = [];
  let index = 0;
  const elicit = async (message: string, prompt?: Record<string, unknown>) => {
    calls.push({ message, prompt });
    const answer = answers[Math.min(index++, answers.length - 1)];
    return typeof answer === "string"
      ? { answer, remember: false }
      : { answer: "accepted" as const, remember: true };
  };
  return { elicit, calls };
}

test("an elicited yes is a confirmation; an elicited no is a refusal", async () => {
  const accepted = await buyTicket();
  const result = await submitOrder({ ticketId: accepted.id, elicit: fakeElicit("accepted").elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "accepted");

  const declined = await buyTicket();
  await refuses(
    () => submitOrder({ ticketId: declined.id, elicit: fakeElicit("declined").elicit }),
    /declined this order/,
  );
});

test("a client that cannot ask does not become a client that cannot be refused", async () => {
  const ticket = await buyTicket();
  await refuses(
    () => submitOrder({ ticketId: ticket.id, elicit: fakeElicit("unavailable").elicit }),
    /Refusing to send an order without confirmation/,
  );
});

/* ------------------------- elicitation is decisive (ADR-0010) ------------------------- */

test("confirm: true CANNOT skip a declined elicitation — the reporter's PoC, as a unit test", async () => {
  // This is the whole defect. `via` used to be seeded from `options.confirm`, and every later gate
  // — including the only channel that reaches a person — was behind `if (!via)`. So a model that
  // set confirm: true was never asking anyone, and the audit line said "explicit" either way.
  const ticket = await buyTicket();
  const asked = fakeElicit("declined");
  await refuses(
    () => submitOrder({ ticketId: ticket.id, confirm: true, elicit: asked.elicit }),
    /declined this order/,
  );
  assert.equal(asked.calls.length, 1, "the human MUST have been asked, confirm: true notwithstanding");
});

test("the PoC reproduces in paper mode too, which is where it was reported", async () => {
  setPolicy({ mode: "paper" });
  const ticket = await buyTicket();
  const asked = fakeElicit("declined");
  await refuses(
    () => submitOrder({ ticketId: ticket.id, confirm: true, elicit: asked.elicit }),
    /declined this order/,
  );
  assert.equal(asked.calls.length, 1);
  // Paper diverges after passGates and nowhere earlier, so it inherits the gate rather than
  // reimplementing it. Asserting it here is what stops that ever becoming two code paths.
  assert.deepEqual(sent, []);
});

test("confirm: true plus an available human records `elicited`, not `explicit-unelicited`", async () => {
  const ticket = await buyTicket();
  const asked = fakeElicit("accepted");
  const result = await submitOrder({ ticketId: ticket.id, confirm: true, elicit: asked.elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "accepted", "a person was asked, so the result says a person was asked");
  assert.equal(asked.calls.length, 1);
  const entry = JSON.parse(readFileSync(orderLogPath(), "utf8").trim().split("\n").pop()!);
  assert.equal(entry.via, "elicited");
  assert.equal(entry.elicitation, "accepted");
});

test("the order dialog is given its own words, not the generic fallback", async () => {
  // `passGates` used to call `options.elicit(ticket.summary)` with one argument, so every order
  // dialog silently fell back to _define.ts's defaults. The summary is the message; the title and
  // description are what the box itself says.
  const ticket = await buyTicket();
  const asked = fakeElicit("accepted");
  await submitOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.equal(asked.calls[0].message, ticket.summary);
  assert.match(String(asked.calls[0].prompt?.title), /Place this order\?/);
  assert.match(String(asked.calls[0].prompt?.description), /exchange/);
  assert.ok(asked.calls[0].prompt?.remember, "and the waiver box is offered under the default policy");
});

test("in paper mode the dialog says paper, rather than promising the exchange", async () => {
  setPolicy({ mode: "paper" });
  const ticket = await buyTicket();
  const asked = fakeElicit("accepted");
  await submitOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.match(String(asked.calls[0].prompt?.title), /PAPER/);
  assert.match(String(asked.calls[0].prompt?.description), /No real money/);
});

test("an unavailable human plus confirm: true proceeds, and both the result and the log say so", async () => {
  const ticket = await buyTicket();
  const result = await submitOrder({ ticketId: ticket.id, confirm: true, elicit: fakeElicit("unavailable").elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "unavailable");
  const entry = JSON.parse(readFileSync(orderLogPath(), "utf8").trim().split("\n").pop()!);
  assert.equal(entry.via, "explicit-unelicited");
  assert.equal(entry.elicitation, "unavailable");
});

test("elicitation: required refuses when no person can be reached, and names the way out", async () => {
  setPolicy({ mode: "live", maxOrderValueIdr: 100_000_000, elicitation: "required" });
  const ticket = await buyTicket();
  await refuses(
    () => submitOrder({ ticketId: ticket.id, confirm: true, elicit: fakeElicit("unavailable").elicit }),
    /--elicitation when-available/,
  );

  // And with no elicit channel offered at all, which is the same fact arriving a different way.
  const second = await buyTicket();
  await refuses(() => submitOrder({ ticketId: second.id, confirm: true }), /cannot ask/);
});

test("elicitation: required still lets an accepted dialog through", async () => {
  setPolicy({ mode: "live", maxOrderValueIdr: 100_000_000, elicitation: "required" });
  const ticket = await buyTicket();
  const asked = fakeElicit("accepted");
  const result = await submitOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(asked.calls[0].prompt?.remember, undefined, "a policy that demands the ask offers no waiver box");
});

test("elicitation: never does not ask, even when it could, and needs confirm", async () => {
  setPolicy({ mode: "live", maxOrderValueIdr: 100_000_000, elicitation: "never" });
  const asked = fakeElicit("declined");

  const refused = await buyTicket();
  await refuses(
    () => submitOrder({ ticketId: refused.id, elicit: asked.elicit }),
    /Refusing to send an order without confirmation/,
  );

  const ticket = await buyTicket();
  const result = await submitOrder({ ticketId: ticket.id, confirm: true, elicit: asked.elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "disabled-by-policy");
  assert.equal(asked.calls.length, 0, "the channel exists and must not have been used");
  const entry = JSON.parse(readFileSync(orderLogPath(), "utf8").trim().split("\n").pop()!);
  assert.equal(entry.via, "explicit-elicit-disabled");
});

test("autoConfirm within its cap proceeds without asking, and says that is what happened", async () => {
  setPolicy({ mode: "live", autoConfirm: true, maxOrderValueIdr: 3_000_000 });
  const ticket = await buyTicket();
  const asked = fakeElicit("declined");
  const result = await submitOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "waived-by-auto-confirm");
  assert.equal(asked.calls.length, 0, "the owner's own capped switch is the one thing that skips the ask");
  const entry = JSON.parse(readFileSync(orderLogPath(), "utf8").trim().split("\n").pop()!);
  assert.equal(entry.via, "auto-confirm");
});

test("autoConfirm loses to elicitation: required — the ask wins, and the order still goes through", async () => {
  setPolicy({ mode: "live", autoConfirm: true, maxOrderValueIdr: 3_000_000, elicitation: "required" });
  const asked = fakeElicit("accepted");
  const ticket = await buyTicket();
  const result = await submitOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "accepted");
  assert.equal(asked.calls.length, 1, "autoConfirm must not have skipped the ask the owner demanded");

  // And the contradiction is reported through the channel that already exists for it.
  assert.match(tradingPolicy().autoConfirmIgnored ?? "", /elicitation is `required`/);
});

test("the gate offers no waiver box it could not honour, and grants nothing on its own", async () => {
  // Driven against `resolveConfirmation` directly rather than through an order, because the point
  // is a property of the gate: it decides, and the caller commits. Two separate claims —
  //
  //   1. a box is never shown for a commitment with no gross value, because a grant is "each order
  //      up to X rupiah" and there is no X to cap it at; and
  //   2. an accepted-with-remember answer creates NOTHING here, it only reports the tick.
  const policy = tradingPolicy();
  const asked = fakeElicit({ remember: true });

  const noValue = await resolveConfirmation({
    policy,
    summary: "a commitment with no gross value",
    valueIdr: null,
    noun: "order",
    waivable: true,
    elicit: asked.elicit,
  });
  assert.equal(asked.calls[0].prompt?.remember, undefined, "no box when there is no value to cap it at");
  assert.equal(noValue.rememberRequested, false, "and a tick on a box that was not offered is not consent");

  const withValue = await resolveConfirmation({
    policy,
    summary: "an ordinary order",
    valueIdr: 2_050_000,
    noun: "order",
    waivable: true,
    elicit: asked.elicit,
  });
  assert.ok(asked.calls[1].prompt?.remember, "the box IS offered here");
  assert.equal(withValue.rememberRequested, true, "and the tick is reported");
  assert.equal(describeRemember().active, false, "but the gate itself created nothing");
});

/* -------------------------- "don't ask again", and its bounds -------------------------- */

test("a ticked box covers the NEXT order of equal or lower value, and nothing bigger", async () => {
  const asked = fakeElicit({ remember: true });

  const first = await buyTicket({ lots: 5 }); // Rp 2,050,000
  const granted = await submitOrder({ ticketId: first.id, elicit: asked.elicit });
  assert.equal(granted.elicitation, "accepted", "the order they were asked about is still an ASKED order");
  assert.equal(asked.calls.length, 1);

  const smaller = await buyTicket({ lots: 2 });
  const covered = await submitOrder({ ticketId: smaller.id, elicit: asked.elicit });
  assert.equal(covered.outcome, "ok");
  assert.equal(covered.elicitation, "remembered");
  assert.equal(asked.calls.length, 1, "and this one was not asked about");
  const entry = JSON.parse(readFileSync(orderLogPath(), "utf8").trim().split("\n").pop()!);
  assert.equal(entry.via, "remembered");

  const bigger = await buyTicket({ lots: 20 });
  await submitOrder({ ticketId: bigger.id, elicit: asked.elicit });
  assert.equal(asked.calls.length, 2, "a larger order is outside what they agreed to, so it IS asked about");
});

test("an accepted dialog with the box UNticked grants nothing", async () => {
  const asked = fakeElicit("accepted");
  const first = await buyTicket({ lots: 5 });
  await submitOrder({ ticketId: first.id, elicit: asked.elicit });
  const second = await buyTicket({ lots: 1 });
  await submitOrder({ ticketId: second.id, elicit: asked.elicit });
  assert.equal(asked.calls.length, 2, "consent to one order is not consent to the next");
});

test("a cancel is never covered by a grant", async () => {
  const asked = fakeElicit({ remember: true });
  const first = await buyTicket({ lots: 5 });
  await submitOrder({ ticketId: first.id, elicit: asked.elicit });

  book.push({ order_id: "ORD-77", symbol: "BBRI", action: "buy", status: "OPEN", price: 4100, shares: 500 });
  const cancel = await previewOrder({ action: "cancel", symbol: "BBRI", orderId: "ORD-77" });
  const result = await submitOrder({ ticketId: cancel.id, elicit: asked.elicit });
  assert.equal(result.elicitation, "accepted");
  assert.equal(asked.calls.length, 2, "a grant covers new orders, and a cancel is not one");
});

test("an AMEND is never covered by a grant — and it does have a gross value", async () => {
  // The first implementation of this bound inferred it from `valueIdr === null`, on the reasoning
  // that a cancel and an amend carry no value. That is false of an amend: its ticket resolves price
  // and lots from the working order, so its gross is a real number. Every amend was therefore
  // waived by a box ticked on a buy, for something `order_amend`'s own description calls "a real
  // order decision and not an edit". The first assertion below is the one that would have caught it.
  const asked = fakeElicit({ remember: true });
  const first = await buyTicket({ lots: 5 }); // Rp 2,050,000
  await submitOrder({ ticketId: first.id, elicit: asked.elicit });

  book.push({ order_id: "ORD-88", symbol: "BBRI", action: "buy", status: "OPEN", price: 4100, shares: 500 });
  const amend = await previewOrder({ action: "amend", symbol: "BBRI", orderId: "ORD-88", price: 4200, lots: 4 });
  assert.equal(amend.grossIdr, 1_680_000, "an amend ticket carries a real gross — the null it was inferred from is a fiction");
  assert.ok(amend.grossIdr < 2_050_000, "and it is under the approved cap, so only the KIND bound can refuse it");

  const result = await submitOrder({ ticketId: amend.id, elicit: asked.elicit });
  assert.equal(result.elicitation, "accepted");
  assert.equal(asked.calls.length, 2, "the amend MUST have been put to the human");
});

test("the waiver box is not offered on a commitment a grant may not cover", async () => {
  // A box that does nothing is worse than no box: the person believes they have answered for next
  // time, and they have not.
  const asked = fakeElicit("accepted");
  // Two orders: a successful cancel removes its own row from the fake book, so one id cannot serve
  // both halves of this test.
  book.push({ order_id: "ORD-98", symbol: "BBRI", action: "buy", status: "OPEN", price: 4100, shares: 500 });
  book.push({ order_id: "ORD-99", symbol: "BBRI", action: "buy", status: "OPEN", price: 4100, shares: 500 });

  const cancel = await previewOrder({ action: "cancel", symbol: "BBRI", orderId: "ORD-98" });
  await submitOrder({ ticketId: cancel.id, elicit: asked.elicit });
  assert.equal(asked.calls[0].prompt?.remember, undefined, "no box on a cancel");

  const amend = await previewOrder({ action: "amend", symbol: "BBRI", orderId: "ORD-99", price: 4200, lots: 4 });
  await submitOrder({ ticketId: amend.id, elicit: asked.elicit });
  assert.equal(asked.calls[1].prompt?.remember, undefined, "no box on an amend");
});

test("autoConfirm does not refuse a cancel it simply cannot speak to — it asks", async () => {
  // A cancel has no gross value, so it is not "over the cap"; it is outside what a value cap can
  // say anything about. Refusing it would make cancelling an order harder than placing one.
  setPolicy({ mode: "live", autoConfirm: true, maxOrderValueIdr: 3_000_000 });
  book.push({ order_id: "ORD-70", symbol: "BBRI", action: "buy", status: "OPEN", price: 4100, shares: 500 });
  const cancel = await previewOrder({ action: "cancel", symbol: "BBRI", orderId: "ORD-70" });
  const asked = fakeElicit("accepted");
  const result = await submitOrder({ ticketId: cancel.id, elicit: asked.elicit });
  assert.equal(result.outcome, "ok");
  assert.equal(result.elicitation, "accepted");
  assert.equal(asked.calls.length, 1);
});

test("a grant expires, on the same clock the tickets use", async () => {
  const asked = fakeElicit({ remember: true });
  const first = await buyTicket({ lots: 5 });
  await submitOrder({ ticketId: first.id, elicit: asked.elicit });

  const base = Date.now();
  setClock(() => base + REMEMBER_TTL_MS + 1);
  // The ticket clock moved too, so this one has to be minted after the jump.
  const later = await buyTicket({ lots: 1 });
  await submitOrder({ ticketId: later.id, elicit: asked.elicit });
  assert.equal(asked.calls.length, 2, "fifteen minutes is the bound, and it is a real one");
});

test("changing the policy invalidates a grant made under the old one", async () => {
  const asked = fakeElicit({ remember: true });
  const first = await buyTicket({ lots: 5 });
  await submitOrder({ ticketId: first.id, elicit: asked.elicit });

  // They agreed to "orders up to Rp 2,050,000" against one set of rules. Tightening or loosening
  // any of them makes it a different set, and the grant was not made against it.
  setPolicy({ mode: "live", maxOrderValueIdr: 50_000_000 });
  const after = await buyTicket({ lots: 1 });
  await submitOrder({ ticketId: after.id, elicit: asked.elicit });
  assert.equal(asked.calls.length, 2);
});

test("a terminal revocation reaches a grant this process is already holding", async () => {
  const asked = fakeElicit({ remember: true });
  const first = await buyTicket({ lots: 5 });
  await submitOrder({ ticketId: first.id, elicit: asked.elicit });

  // What `stockbit-auth trading-forget` does: stamp a moment into the file. The server cannot be
  // reached from a terminal, but it re-reads the policy on every order, so this is what crosses.
  setPolicy({
    mode: "live",
    maxOrderValueIdr: 100_000_000,
    confirmationsRevokedAt: new Date(Date.now() + 1000).toISOString(),
  });
  const after = await buyTicket({ lots: 1 });
  await submitOrder({ ticketId: after.id, elicit: asked.elicit });
  assert.equal(asked.calls.length, 2, "a grant made before the revocation covers nothing after it");
});

test("an order that is refused AFTER the dialog leaves no grant behind", async () => {
  // The gate runs against a peeked ticket so a refusal costs nothing — which means it must not
  // leave anything behind either. Creating the grant inside the gate meant a person could watch
  // their order be refused and still have silently turned confirmations off for fifteen minutes.
  //
  // The trigger is not exotic: the dialog runs at human speed and a ticket lasts two minutes.
  const ticket = await buyTicket({ lots: 5 });
  const slowHuman = async () => {
    // They read the summary properly, and the ticket expires while they are doing it.
    setClock(() => Date.parse(ticket.expiresAt) + 1);
    return { answer: "accepted" as const, remember: true };
  };
  await refuses(() => submitOrder({ ticketId: ticket.id, elicit: slowHuman }), /ran out before the answer came back/);
  assert.equal(describeRemember().active, false, "no waiver may survive an order that never happened");

  // And the refusal ties the expiry to the dialog, rather than leaving the reader to connect them.
  resetClock();
  const asked = fakeElicit("accepted");
  const next = await buyTicket({ lots: 1 });
  await submitOrder({ ticketId: next.id, elicit: asked.elicit });
  assert.equal(asked.calls.length, 1, "the next order is still asked about");
});

test("a ticket that cannot be placed is refused before anyone is asked", async () => {
  // `take()` would refuse this a moment later with the same sentence. Asking a person to approve an
  // order that cannot be placed whatever they answer spends their attention on nothing, and teaches
  // them the dialog is noise — which is how a confirmation stops being read.
  const ticket = await previewOrder({ action: "buy", symbol: "BBRI", price: 4105, lots: 1 });
  const asked = fakeElicit("accepted");
  await refuses(() => submitOrder({ ticketId: ticket.id, elicit: asked.elicit }), /price_tick/);
  assert.equal(asked.calls.length, 0, "nobody is asked about an order the ticket already blocks");
  assert.equal(describeRemember().active, false);
});

test("replaying a spent ticket does not ask the person a second time", async () => {
  // Since the human is asked BEFORE the ticket is taken, a `peek` that admitted a consumed ticket
  // meant a model retrying order_buy put the dialog up again — asking someone to approve an order
  // that had already reached the exchange, and only then refusing. Being asked twice about one
  // order is how a person ends up believing they have two.
  const asked = fakeElicit("accepted");
  const ticket = await buyTicket({ lots: 5 });
  const first = await submitOrder({ ticketId: ticket.id, elicit: asked.elicit });
  assert.equal(first.outcome, "ok");
  assert.equal(asked.calls.length, 1);

  await refuses(() => submitOrder({ ticketId: ticket.id, elicit: asked.elicit }), /was already used/);
  assert.equal(asked.calls.length, 1, "the replay must not reach a person at all");
});

test("a cap lowered between the preview and the write refuses, and does not auto-confirm", async () => {
  // The two caps are the same field read at two moments: `value_within_cap` is computed at preview,
  // and the gate reads the policy at the write. Lower it in between and a ticket that passed its
  // own check arrives at the gate over the new cap. The autoConfirm branch must refuse it —
  // returning `auto-confirm` here would send an order the owner's current policy forbids, unasked.
  setPolicy({ mode: "live", autoConfirm: true, maxOrderValueIdr: 5_000_000 });
  const ticket = await buyTicket({ lots: 5 }); // Rp 2,050,000, inside the cap it was priced against
  assert.ok(ticket.checks.every((c) => c.ok), "precondition: the ticket passed every check");

  setPolicy({ mode: "live", autoConfirm: true, maxOrderValueIdr: 1_000_000 });
  const asked = fakeElicit("accepted");
  await refuses(() => submitOrder({ ticketId: ticket.id, elicit: asked.elicit }), /the cap changed after this ticket was priced/);
  assert.equal(asked.calls.length, 0, "and the cap is not something a person can confirm away");
});

test("a revocation timestamp that cannot be parsed revokes everything", async () => {
  // The safe direction for a revocation. Somebody wrote something into that field; the reading that
  // asks the human again costs a dialog, and the other reading costs an order.
  const asked = fakeElicit({ remember: true });
  const first = await buyTicket({ lots: 5 });
  await submitOrder({ ticketId: first.id, elicit: asked.elicit });

  setPolicy({ mode: "live", maxOrderValueIdr: 100_000_000, confirmationsRevokedAt: "yesterday" });
  const after = await buyTicket({ lots: 1 });
  await submitOrder({ ticketId: after.id, elicit: asked.elicit });
  assert.equal(asked.calls.length, 2);
});

test("trading_forget clears the grant, and says whether there was one", async () => {
  const asked = fakeElicit({ remember: true });
  const first = await buyTicket({ lots: 5 });
  await submitOrder({ ticketId: first.id, elicit: asked.elicit });
  assert.equal(describeRemember().active, true, "precondition");

  const handlers = new Map<string, ToolHandler>();
  registerTradingTools({
    read: () => {},
    write: (name, _d, _s, handler) => {
      handlers.set(name, handler);
    },
    writeNames: () => [...handlers.keys()],
  });

  const cleared = JSON.parse(
    ((await handlers.get("trading_forget")!({})) as { content: Array<{ text: string }> }).content[0].text,
  ).data;
  assert.equal(cleared.hadGrant, true);
  assert.equal(cleared.clearedCapIdr, 2_050_000);
  assert.equal(describeRemember().active, false);

  // Idempotent, and honest about it rather than claiming to have done something.
  const again = JSON.parse(
    ((await handlers.get("trading_forget")!({})) as { content: Array<{ text: string }> }).content[0].text,
  ).data;
  assert.equal(again.hadGrant, false);

  const next = await buyTicket({ lots: 1 });
  await submitOrder({ ticketId: next.id, elicit: asked.elicit });
  assert.equal(asked.calls.length, 2, "and the next order is asked about again");
});

test("the tool layer wires the human channel through, and a declined dialog reaches the caller", async () => {
  // The three Definer literals in this file had no elicitation member at all, so the whole
  // tool-level path — the one a real client actually takes — was untested. This drives order_buy
  // the way an MCP client does.
  const reads = new Map<string, ToolHandler>();
  const writes = new Map<string, ToolHandler>();
  const asked = fakeElicit("declined");
  registerTradingTools({
    read: (name, _d, _s, handler) => {
      reads.set(name, handler);
    },
    write: (name, _d, _s, handler) => {
      writes.set(name, handler);
    },
    writeNames: () => [...writes.keys()],
    elicitDecision: asked.elicit,
  });

  const preview = await reads.get("order_preview")!({ action: "buy", symbol: "BBRI", price: 4100, lots: 5 });
  const ticketId = JSON.parse((preview as { content: Array<{ text: string }> }).content[0].text).data.id;

  sent.length = 0;
  const placed = (await writes.get("order_buy")!({ ticket_id: ticketId, confirm: true })) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  assert.equal(placed.isError, true, "a declined dialog is an error result, not a quiet success");
  assert.match(placed.content[0].text, /declined this order/);
  assert.equal(asked.calls.length, 1);
  assert.deepEqual(sent, [], "and nothing reached the exchange");
});

test("the tool layer's message tells the user when nobody was asked", async () => {
  const reads = new Map<string, ToolHandler>();
  const writes = new Map<string, ToolHandler>();
  registerTradingTools({
    read: (name, _d, _s, handler) => {
      reads.set(name, handler);
    },
    write: (name, _d, _s, handler) => {
      writes.set(name, handler);
    },
    writeNames: () => [...writes.keys()],
  });

  const preview = await reads.get("order_preview")!({ action: "buy", symbol: "BBRI", price: 4100, lots: 5 });
  const ticketId = JSON.parse((preview as { content: Array<{ text: string }> }).content[0].text).data.id;
  const placed = await writes.get("order_buy")!({ ticket_id: ticketId, confirm: true });
  const payload = JSON.parse((placed as { content: Array<{ text: string }> }).content[0].text).data;
  assert.equal(payload.outcome, "ok");
  assert.match(payload.message, /is on the book/);
  assert.match(payload.message, /No human was asked directly/);
  assert.match(payload.message, /--elicitation required/, "and names the switch that would refuse instead");
});

/* ------------------------------------ the tools ------------------------------------ */

test("the four write tools are not in the workflow handler map", () => {
  // `workflow_run` executes saved recipes by calling handlers directly. A recipe is data — a name
  // and a list of steps — and data must not be able to place an order.
  const reads = new Map<string, ToolHandler>();
  const writes: string[] = [];
  const definer: Definer = {
    read: (name, _d, _s, handler) => {
      reads.set(name, handler);
    },
    write: (name) => {
      writes.push(name);
    },
    writeNames: () => [...writes],
  };
  registerTradingTools(definer);
  for (const name of ["order_buy", "order_sell", "order_amend", "order_cancel"]) {
    assert.equal(reads.has(name), false, `${name} must not be reachable from a workflow recipe`);
    assert.ok(writes.includes(name));
  }
});

test("the write tool composes a message per outcome, and says when the audit line is missing", async () => {
  const handlers = new Map<string, ToolHandler>();
  const writeHandlers = new Map<string, ToolHandler>();
  registerTradingTools({
    read: (name, _d, _s, handler) => {
      handlers.set(name, handler);
    },
    write: (name, _d, _s, handler) => {
      writeHandlers.set(name, handler);
    },
    writeNames: () => [...writeHandlers.keys()],
  });

  const preview = await handlers.get("order_preview")!({ action: "buy", symbol: "BBRI", price: 4100, lots: 5 });
  const ticketId = JSON.parse((preview as { content: Array<{ text: string }> }).content[0].text).data.id;

  const placed = await writeHandlers.get("order_buy")!({ ticket_id: ticketId, confirm: true });
  const payload = JSON.parse((placed as { content: Array<{ text: string }> }).content[0].text).data;
  assert.equal(payload.outcome, "ok");
  assert.match(payload.message, /is on the book/);
  assert.ok(payload.auditLog.endsWith("order-mutations.log"));
});

test("trading_status answers with no session and no requests", async () => {
  const handlers = new Map<string, ToolHandler>();
  registerTradingTools({
    read: (name, _d, _s, handler) => {
      handlers.set(name, handler);
    },
    write: () => {},
    writeNames: () => [],
  });
  sent.length = 0;
  const result = await handlers.get("trading_status")!({});
  const payload = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text).data;
  assert.equal(payload.policy.enabled, true);
  assert.equal(payload.ticketTtlSeconds, TICKET_TTL_MS / 1000);
  assert.match(payload.protocol, /Two steps/);
  assert.deepEqual(sent, []);
});

test("a StockbitError from a refusal is a refusal, not an upstream failure", async () => {
  setPolicy({ mode: "off" });
  const ticket = await buyTicket();
  await assert.rejects(
    () => placeBuy({ ticketId: ticket.id, confirm: true }),
    (err: unknown) => {
      assert.ok(err instanceof StockbitError);
      assert.equal(err.kind, "invalid_param", "a policy refusal is the caller's to fix, not the server's");
      return true;
    },
  );
});


/* ------------------------------------------------------------------ *
 * Ticket slots are evicted. The map used to grow for the life of the process: nothing called
 * `delete`, `peek`/`take` only TESTED expiry, and `clearTickets()` is tests-only. Every preview in
 * a long session left a whole ticket behind — its checks, its warnings, a copy of the policy, a
 * market snapshot.
 * ------------------------------------------------------------------ */

function stubTicket(id: string, issuedAt: number) {
  return issue({
    id,
    kind: "order" as const,
    expiresAt: new Date(issuedAt + TICKET_TTL_MS).toISOString(),
    checks: [],
    summary: `ticket ${id}`,
  });
}

test("expired ticket slots are evicted rather than held for the life of the process", () => {
  clearTickets();
  const start = Date.parse("2026-08-05T03:00:00Z");
  setClock(() => start);
  try {
    for (let i = 0; i < 20; i++) stubTicket(`old-${i}`, start);
    assert.equal(slotCount(), 20);

    // Still inside the retention window: nothing is dropped, because `take` must still be able to
    // say "already used" rather than "never existed".
    let at = start + TICKET_TTL_MS * 2;
    setClock(() => at);
    stubTicket("mid", at);
    assert.equal(slotCount(), 21, "a ticket only just expired is still worth a real error message");

    // Past the first batch's retention but inside `mid`'s: the old twenty go, `mid` stays.
    at = start + TICKET_TTL_MS * 7;
    setClock(() => at);
    stubTicket("second", at);
    assert.equal(slotCount(), 2, "the original twenty are gone; `mid` and `second` remain");
    assert.throws(() => take("old-0"), /No order ticket/, "an evicted slot is simply unknown");

    // Past everything issued so far.
    at = start + TICKET_TTL_MS * 40;
    setClock(() => at);
    stubTicket("last", at);
    assert.equal(slotCount(), 1, "only the ticket just issued is still worth holding");
  } finally {
    resetClock();
    clearTickets();
  }
});

test("a spent ticket still reports 'already used' while it is retained", () => {
  clearTickets();
  const start = Date.parse("2026-08-05T03:00:00Z");
  setClock(() => start);
  try {
    stubTicket("spent", start);
    take("spent");
    assert.throws(() => take("spent"), /already used/, "the duplicate-order guard must survive");

    setClock(() => start + TICKET_TTL_MS * 2);
    assert.throws(() => take("spent"), /already used/, "and it must survive mere expiry too");
  } finally {
    resetClock();
    clearTickets();
  }
});


/* ------------------------------------------------------------------ *
 * order_preview's argument bounds, at the schema.
 *
 * `z.coerce.number()` on its own accepts NaN ("abc"), 0 (""), negatives and fractions, and
 * previewOrder does five sequential network reads before anything looks at the value — so a user
 * paid a full round trip for an argument that could never have been valid, and `tickSize(NaN)` was
 * reached with a message that rendered as `idr(NaN)`.
 * ------------------------------------------------------------------ */

test("order_preview rejects an impossible price or lot count without a request", () => {
  const shapes = new Map<string, Record<string, { safeParse(v: unknown): { success: boolean } }>>();
  registerTradingTools({
    read: (name, _d, shape) => {
      shapes.set(name, shape as never);
    },
    write: () => {},
    writeNames: () => [],
  } as unknown as Definer);

  const shape = shapes.get("order_preview");
  assert.ok(shape, "order_preview must be a read tool");
  const price = shape.price;
  const lots = shape.lots;

  for (const bad of ["abc", NaN, 0, -1, Infinity]) {
    assert.equal(price.safeParse(bad).success, false, `price must reject ${String(bad)}`);
    assert.equal(lots.safeParse(bad).success, false, `lots must reject ${String(bad)}`);
  }
  assert.equal(lots.safeParse(1.5).success, false, "a fractional lot cannot be sent — the wire takes shares");

  // What must still get through, including the string forms an MCP client may send.
  assert.equal(price.safeParse(4100).success, true);
  assert.equal(price.safeParse("4100").success, true);
  assert.equal(lots.safeParse(5).success, true);
  assert.equal(lots.safeParse("5").success, true);
  assert.equal(price.safeParse(undefined).success, true, "both stay optional");
  assert.equal(lots.safeParse(undefined).success, true);
});


/* ------------------------------------------------------------------ *
 * verifyAgainst — the function that decides whether a real brokerage order landed.
 *
 * It had no test of its own. Every path through it was exercised only incidentally, through
 * `submitOrder`, against a stub that always behaved. This is the code that turns "the request
 * returned 2xx" into `ok` / `not-visible` / `rejected`, on a write that moves money and has no undo,
 * so each branch is asserted directly.
 * ------------------------------------------------------------------ */

type VOrder = Parameters<typeof verifyAgainst>[1][number];

const vOrder = (over: Partial<VOrder> = {}): VOrder =>
  ({ readFrom: {}, unmappedKeys: [], ...over }) as VOrder;

const vTicket = (over: Record<string, unknown> = {}) =>
  ({
    id: "t1",
    kind: "order",
    action: "buy",
    symbol: "BBRI",
    price: 4100,
    lots: 5,
    shares: 500,
    uiRef: "ui-abc",
    boardType: "RG",
    isGtc: false,
    timeInForce: "0",
    ...over,
  }) as Parameters<typeof verifyAgainst>[0];

test("verifyAgainst: a buy is landed when the read-back carries its ui_ref", () => {
  const after = [vOrder({ orderId: "o1", uiRef: "ui-abc", symbol: "BBRI", status: "open" })];
  assert.deepEqual(verifyAgainst(vTicket(), [], after), { landed: true, orderId: "o1", rejected: false });
});

test("verifyAgainst: a ui_ref match whose status says rejected is landed AND rejected", () => {
  // Both at once, deliberately: the order reached the book and the book turned it down. Reporting
  // only `landed` would say `ok` about an order that is not working.
  const after = [vOrder({ orderId: "o1", uiRef: "ui-abc", status: "REJECTED — price outside band" })];
  assert.deepEqual(verifyAgainst(vTicket(), [], after), { landed: true, orderId: "o1", rejected: true });
});

test("verifyAgainst: with no ui_ref on the row it falls back to an id that was not there before", () => {
  const before = [vOrder({ orderId: "old", symbol: "BBRI" })];
  const after = [vOrder({ orderId: "old", symbol: "BBRI" }), vOrder({ orderId: "fresh", symbol: "BBRI" })];
  assert.deepEqual(verifyAgainst(vTicket(), before, after), { landed: true, orderId: "fresh", rejected: false });
});

test("verifyAgainst: the fallback will not claim an order on a different symbol", () => {
  const after = [vOrder({ orderId: "fresh", symbol: "TLKM" })];
  assert.deepEqual(verifyAgainst(vTicket(), [], after), { landed: false, rejected: false });
});

test("verifyAgainst: nothing new means not landed, and never a guess at an id", () => {
  const before = [vOrder({ orderId: "old", symbol: "BBRI" })];
  const result = verifyAgainst(vTicket(), before, before);
  assert.equal(result.landed, false);
  assert.equal(result.orderId, undefined, "a not-landed verdict must not name an order");
});

test("verifyAgainst: a cancel counts as landed when the order is gone OR says cancelled", () => {
  const ticket = vTicket({ action: "cancel", orderId: "o1", price: null, lots: null, shares: null });

  // Gone from the list entirely.
  assert.deepEqual(verifyAgainst(ticket, [vOrder({ orderId: "o1" })], []), {
    landed: true,
    orderId: "o1",
    rejected: false,
  });

  // Still listed, but marked.
  assert.equal(verifyAgainst(ticket, [], [vOrder({ orderId: "o1", status: "Cancelled" })]).landed, true);

  // Still open — the cancel did not take.
  assert.equal(verifyAgainst(ticket, [], [vOrder({ orderId: "o1", status: "open" })]).landed, false);
});

test("verifyAgainst: an amend lands only when the target carries the NEW terms", () => {
  const ticket = vTicket({ action: "amend", orderId: "o1", price: 4200, lots: 6, shares: 600 });

  assert.equal(
    verifyAgainst(ticket, [], [vOrder({ orderId: "o1", price: 4200, shares: 600 })]).landed,
    true,
  );
  assert.equal(
    verifyAgainst(ticket, [], [vOrder({ orderId: "o1", price: 4100, shares: 600 })]).landed,
    false,
    "the old price still standing is the amend not having happened",
  );
  assert.equal(
    verifyAgainst(ticket, [], [vOrder({ orderId: "o1", price: 4200, shares: 500 })]).landed,
    false,
    "and so is the old size",
  );
  assert.equal(verifyAgainst(ticket, [], []).landed, false, "a vanished order is not an amended one");
});

test("verifyAgainst: an amend that names only one term does not require the other to match", () => {
  const priceOnly = vTicket({ action: "amend", orderId: "o1", price: 4200, lots: null, shares: null });
  assert.equal(
    verifyAgainst(priceOnly, [], [vOrder({ orderId: "o1", price: 4200, shares: 999 })]).landed,
    true,
    "shares were not part of the request, so they cannot falsify it",
  );
});
