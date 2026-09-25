import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activateVirtualAccount, amendVirtualOrder, cancelVirtualOrder, getVirtualConfig,
  getVirtualOrders, getVirtualPortfolio, getVirtualPosition, placeVirtualOrder,
  virtualOrderBody, type VirtualIO,
} from "../src/virtual/account.ts";
import { VIRTUAL_ROUTES } from "../src/http/routes/virtual.ts";
import { buildUrl, domainOf, isPermitted } from "../src/http/transport.ts";
import { StockbitError } from "../src/http/errors.ts";

type Row = Record<string, unknown>;
function fixture() {
  let rows: Row[] = [];
  let failure: "lost-response" | "lost-readback" | "ignored" | "business-error" | "rejected" | undefined;
  let writes = 0;
  const sent: Array<{ route: string; body: unknown }> = [];
  const io: VirtualIO = {
    async get(route) {
      if (failure === "lost-readback" && writes) throw new Error("connection lost");
      if (route === "virtualOrders") return { data: structuredClone(rows) };
      if (route === "virtualPortfolio") return { data: { trading_balance: 100000000, amount: { invested: 0 }, result: [] } };
      if (route === "virtualPosition") return { data: { symbol: "BBCA", available_lot: 0, price: { average: 0 } } };
      return { data: { fee: { buy: 0.15, sell: 0.25 } } };
    },
    async post(route, options) {
      writes++;
      sent.push({ route, body: options?.body });
      if (failure === "lost-response") throw new Error("response lost after upstream applied write");
      if (failure === "business-error") return { error_type: "INVALID_ORDER", message: "invalid virtual order" };
      const body = (options?.body ?? {}) as Row;
      if (route === "virtualActivate") return { data: {} };
      if (route === "virtualCancel") {
        if (failure !== "ignored") rows = rows.map((r) => ({ ...r, status: "WITHDRAWN" }));
        return { data: {} };
      }
      const orderId = route === "virtualAmend" ? String(body.order_id) : "v-123";
      if (failure !== "ignored") {
        rows = [{
          id: orderId, action: route === "virtualSell" ? "SELL" : "BUY",
          symbol: options?.segments?.symbol ?? body.symbol,
          price: body.price, total: Number(body.shares) / 100,
          status: failure === "rejected" ? "REJECTED" : "OPEN", gtc: { enable: false },
        }];
      }
      return { data: { order_id: orderId } };
    },
  };
  return {
    io, sent,
    setRows(value: Row[]) { rows = value; },
    fail(value: typeof failure) { failure = value; },
  };
}
const input = { symbol: "bbca", action: "buy" as const, price: 1000, lots: 2, confirm: true };
const open = { id: "v-123", symbol: "BBCA", action: "BUY", status: "OPEN", price: 1000, total: 2, gtc: { enable: false } };

test("virtual route policy pins every endpoint to exodus and the main token", () => {
  for (const [name, route] of Object.entries(VIRTUAL_ROUTES)) {
    assert.equal(route.host, "exodus");
    assert.equal(route.auth, "main");
    const url = buildUrl(name as keyof typeof VIRTUAL_ROUTES, { symbol: "BBCA" });
    assert.equal(new URL(url).origin, "https://exodus.stockbit.com");
    assert.ok(new URL(url).pathname.startsWith("/virtualtrading/"));
    assert.equal(domainOf(name as keyof typeof VIRTUAL_ROUTES), "main");
    assert.equal(isPermitted(route.method, url), true);
    for (const foreign of ["https://carina.stockbit.com", "https://api-sekuritas.stockbit.com", "https://exodus.stockbit.com.evil.test"]) {
      assert.equal(isPermitted(route.method, foreign + new URL(url).pathname), false);
    }
  }
  assert.equal(isPermitted("POST", "https://exodus.stockbit.com/virtualtrading/withdraw/BBCA"), false);
  assert.equal(isPermitted("POST", "https://exodus.stockbit.com/virtualtrading/buy/BBCA/../../order/buy"), false);
  assert.throws(() => buildUrl("virtualBuy", { symbol: "../order/buy" }));
});

test("read results always identify Stockbit virtual data separately from brokerage/local paper", async () => {
  const { io } = fixture();
  for (const result of await Promise.all([
    getVirtualPortfolio(io), getVirtualPosition("bbca", io), getVirtualOrders(io), getVirtualConfig(io),
  ])) {
    assert.equal(result.mode, "stockbit_virtual");
    assert.equal(result.source, "Stockbit website virtual account");
    assert.match(result.summary, /no real money/);
  }
});

test("an unheld virtual position is the observed nullable response, not a parser failure", async () => {
  const f = fixture();
  const result = await getVirtualPosition("bbri", { ...f.io, get: async () => ({ message: "ok", data: null }) });
  assert.equal(result.found, false);
  assert.equal(result.position, null);
  assert.equal(result.symbol, "BBRI");
  await assert.rejects(() => getVirtualPosition("BBRI", { ...f.io, get: async () => ({ message: "ok" }) }), /no data field/);
});

test("order construction validates precise whole lots and tick prices without changing the user's price", () => {
  assert.deepEqual(virtualOrderBody(input), { gtc: false, price: 1000, shares: 200, tradeshare: false });
  for (const bad of [
    { price: 1001, lots: 1 }, { price: 0, lots: 1 }, { price: Infinity, lots: 1 },
    { price: 1000, lots: 0 }, { price: 1000, lots: 1.5 }, { price: 1000, lots: Number.MAX_SAFE_INTEGER },
  ]) assert.throws(() => virtualOrderBody(bad));
});

test("all virtual mutations require explicit confirmation before any IO", async () => {
  const io: VirtualIO = { get: async () => { throw new Error("unexpected read"); }, post: async () => { throw new Error("unexpected write"); } };
  await assert.rejects(() => activateVirtualAccount(false, io), /Confirm/);
  await assert.rejects(() => placeVirtualOrder({ ...input, confirm: false }, io), /Confirm/);
  await assert.rejects(() => amendVirtualOrder({ ...input, orderId: "v-123", confirm: false }, io), /Confirm/);
  await assert.rejects(() => cancelVirtualOrder({ orderId: "v-123", confirm: false }, io), /Confirm/);
});

test("buy and sell use only their fixed virtual routes and disabled sharing", async () => {
  for (const action of ["buy", "sell"] as const) {
    const f = fixture();
    const result = await placeVirtualOrder({ ...input, action }, f.io);
    assert.equal(result.outcome, "ok");
    assert.deepEqual(f.sent, [{ route: action === "buy" ? "virtualBuy" : "virtualSell", body: { gtc: false, price: 1000, shares: 200, tradeshare: false } }]);
    assert.match(result.message, /does not imply a fill/);
  }
});

test("activation is verified through a fresh virtual portfolio read", async () => {
  const f = fixture();
  assert.equal((await activateVirtualAccount(true, f.io)).outcome, "ok");
  assert.deepEqual(f.sent, [{ route: "virtualActivate", body: undefined }]);
});

test("unknown writes, failed verification, and ignored writes never replay a POST", async () => {
  for (const failure of ["lost-response", "lost-readback", "ignored"] as const) {
    const f = fixture(); f.fail(failure);
    const result = await placeVirtualOrder(input, f.io);
    assert.equal(result.outcome, "unknown", failure);
    assert.equal(f.sent.length, 1, failure);
    assert.match(result.message, /do not automatically retry/);
  }
});

test("explicit business/HTTP refusals report rejection while a failed readback remains uncertain", async () => {
  const f = fixture(); f.fail("business-error");
  assert.equal((await placeVirtualOrder(input, f.io)).outcome, "rejected");
  assert.equal(f.sent.length, 1);
  const refusal = new StockbitError("invalid_param", "Trading tidak diperolehkan diluar jam pasar", { status: 400 });
  const failedPost: VirtualIO = { ...fixture().io, post: async () => { throw refusal; } };
  assert.equal((await placeVirtualOrder(input, failedPost)).outcome, "rejected");
  let reads = 0;
  const failedRead: VirtualIO = { ...fixture().io, get: async () => { if (reads++) throw refusal; return { data: [] }; } };
  assert.equal((await placeVirtualOrder(input, failedRead)).outcome, "unknown");
});

test("Stockbit rejected orders are not reported as successful", async () => {
  const f = fixture(); f.fail("rejected");
  assert.equal((await placeVirtualOrder(input, f.io)).outcome, "rejected");
});

test("an existing order id in an acknowledgement is not evidence of a newly placed order", async () => {
  const f = fixture(); f.setRows([open]);
  assert.equal((await placeVirtualOrder(input, f.io)).outcome, "unknown");
});

test("order readback must match price, aggregate lots, symbol, action, GFD, and a known status", async () => {
  for (const mismatch of [
    { price: 1100 }, { total: 20 }, { symbol: "BBRI" }, { action: "SELL" },
    { gtc: { enable: true } }, { status: "UNRECOGNIZED" },
  ]) {
    let reads = 0;
    const f = fixture();
    const io: VirtualIO = { ...f.io, get: async () => ({ data: reads++ ? [{ ...open, ...mismatch }] : [] }) };
    assert.equal((await placeVirtualOrder(input, io)).outcome, "unknown", JSON.stringify(mismatch));
    assert.equal(f.sent.length, 1);
  }
});

test("split virtual acknowledgements require unique IDs and the exact requested total lots", async () => {
  for (const wrong of [false, true]) {
    let reads = 0;
    const io: VirtualIO = {
      get: async () => ({ data: reads++ ? [{ ...open, id: "a", total: 1 }, { ...open, id: "b", total: wrong ? 2 : 1 }] : [] }),
      post: async () => ({ data: { order_ids: ["a", "b"] } }),
    };
    assert.equal((await placeVirtualOrder(input, io)).outcome, wrong ? "unknown" : "ok");
  }
});

test("amend/cancel refuse absent, completed, mismatched, and non-GFD virtual orders before a write", async () => {
  for (const row of [undefined, { ...open, status: "MATCH" }, { ...open, gtc: { enable: true } }, { ...open, gtc: {} }]) {
    const f = fixture(); f.setRows(row ? [row] : []);
    await assert.rejects(() => cancelVirtualOrder({ orderId: "v-123", confirm: true }, f.io));
    await assert.rejects(() => amendVirtualOrder({ ...input, orderId: "v-123" }, f.io));
    assert.equal(f.sent.length, 0);
  }
  const f = fixture(); f.setRows([open]);
  await assert.rejects(() => amendVirtualOrder({ ...input, symbol: "BBRI", orderId: "v-123" }, f.io), /does not match/);
  assert.equal(f.sent.length, 0);
});

test("amend verifies both price and total lots; cancellation requires a WITHDRAWN readback", async () => {
  const f = fixture(); f.setRows([open]);
  assert.equal((await amendVirtualOrder({ ...input, orderId: "v-123", price: 1050, lots: 3 }, f.io)).outcome, "ok");
  assert.deepEqual(f.sent[0], { route: "virtualAmend", body: { gtc: false, order_id: "v-123", price: 1050, shares: 300, symbol: "BBCA" } });
  assert.equal((await cancelVirtualOrder({ orderId: "v-123", confirm: true }, f.io)).outcome, "ok");
  assert.deepEqual(f.sent[1], { route: "virtualCancel", body: { order_id: "v-123", gtc: false } });
  const ignored = fixture(); ignored.setRows([open]); ignored.fail("ignored");
  assert.equal((await amendVirtualOrder({ ...input, orderId: "v-123", price: 1050 }, ignored.io)).outcome, "unknown");
  assert.equal((await cancelVirtualOrder({ orderId: "v-123", confirm: true }, ignored.io)).outcome, "unknown");
});

test("amend cannot claim an unrelated order as the requested change", async () => {
  for (const mismatch of [
    { action: "SELL" }, { gtc: { enable: true } }, { status: "UNRECOGNIZED" },
  ]) {
    let reads = 0;
    const f = fixture();
    const io: VirtualIO = { ...f.io, get: async () => ({ data: [{ ...open, ...(reads++ ? mismatch : {}) }] }) };
    assert.equal((await amendVirtualOrder({ ...input, orderId: "v-123" }, io)).outcome, "unknown");
  }
  for (const amendedOriginal of [false, true]) {
    let reads = 0;
    const io: VirtualIO = {
      get: async () => ({ data: reads++ ? [{ ...open, status: amendedOriginal ? "AMENDED" : "OPEN" }, { ...open, id: "replacement" }] : [open] }),
      post: async () => ({ data: { order_id: "replacement" } }),
    };
    assert.equal((await amendVirtualOrder({ ...input, orderId: "v-123" }, io)).outcome, amendedOriginal ? "ok" : "unknown");
  }
});

test("malformed or HTTP-200 business-error reads fail visibly", async () => {
  for (const response of [{ data: {} }, { data: [], error_type: "NO_ACCESS" }, { success: false, data: [] }]) {
    const io: VirtualIO = { get: async () => response, post: async () => { throw new Error("unexpected"); } };
    await assert.rejects(() => getVirtualOrders(io));
  }
});
