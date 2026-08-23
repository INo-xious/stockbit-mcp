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
import { clearTickets, peek, resetClock, setClock, take, TICKET_TTL_MS } from "../src/trading/tickets.ts";
import { idr, nearestTicks, previewOrder, tickSize } from "../src/trading/preview.ts";
import { orderBody, orderLogPath, placeBuy, placeSell, cancelOrder, submitOrder } from "../src/trading/orders.ts";
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
  setPolicy({ enabled: true, maxOrderValueIdr: 100_000_000 });
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
  setPolicy({ enabled: true, maxOrderValueIdr: 1_000_000 });
  const ticket = await buyTicket();
  const check = ticket.checks.find((c) => c.name === "value_within_cap")!;
  assert.equal(check.ok, false);
  assert.match(check.detail, /Rp 2,050,000 exceeds/);
});

test("a symbol off the allow-list fails, and the message says how to change it", async () => {
  setPolicy({ enabled: true, allowedSymbols: ["TLKM"] });
  const ticket = await buyTicket();
  const check = ticket.checks.find((c) => c.name === "symbol_allowed")!;
  assert.equal(check.ok, false);
  assert.match(check.detail, /trading-enable --symbols/);
});

test("a ticket is still issued when checks fail — the user asked what would happen", async () => {
  setPolicy({ enabled: false });
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
  setPolicy({ enabled: false });
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
  setPolicy({ enabled: false });
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
  setPolicy({ enabled: false });
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
  setPolicy({ enabled: true, autoConfirm: true, maxOrderValueIdr: null });
  const ticket = await buyTicket();
  await refuses(() => placeBuy({ ticketId: ticket.id }), /honoured only when maxOrderValueIdr is also set/);
  assert.match(tradingPolicy().autoConfirmIgnored ?? "", /maxOrderValueIdr/);
});

test("autoConfirm covers an order under the cap and refuses one over it", async () => {
  setPolicy({ enabled: true, autoConfirm: true, maxOrderValueIdr: 3_000_000 });
  const small = await buyTicket();
  const result = await placeBuy({ ticketId: small.id });
  assert.equal(result.outcome, "ok");

  setPolicy({ enabled: true, autoConfirm: true, maxOrderValueIdr: 1_000_000 });
  const big = await buyTicket();
  await refuses(() => placeBuy({ ticketId: big.id }), /autoConfirm covers orders up to Rp 1,000,000/);
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
    await refuses(() => placeBuy({ ticketId: ticket.id, confirm: true }), /Another order on BBRI is in flight/);
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
  assert.equal(entry.via, "explicit");
  assert.equal(entry.symbol, "BBRI");
  assert.equal(entry.shares, 500);
});

test("the log never carries a credential", async () => {
  const ticket = await buyTicket();
  await placeBuy({ ticketId: ticket.id, confirm: true });
  const contents = readFileSync(orderLogPath(), "utf8");
  assert.equal(contents.includes("SECURITIES-REFRESH"), false);
  assert.equal(/eyJ[A-Za-z0-9_-]+\./.test(contents), false, "no JWT may appear in the audit log");
});

/* ---------------------------------- elicitation ---------------------------------- */

test("an elicited yes is a confirmation; an elicited no is a refusal", async () => {
  const accepted = await buyTicket();
  const result = await submitOrder({ ticketId: accepted.id, elicit: async () => "accepted" });
  assert.equal(result.outcome, "ok");

  const declined = await buyTicket();
  await refuses(
    () => submitOrder({ ticketId: declined.id, elicit: async () => "declined" }),
    /declined this order/,
  );
});

test("a client that cannot ask does not become a client that cannot be refused", async () => {
  const ticket = await buyTicket();
  await refuses(
    () => submitOrder({ ticketId: ticket.id, elicit: async () => "unavailable" }),
    /Refusing to send an order without confirmation/,
  );
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
  setPolicy({ enabled: false });
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
