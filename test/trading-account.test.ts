/**
 * The trading account reads.
 *
 * Two claims are worth more than the rest here and most of the file is about them.
 *
 * The first is that an unrecognised field's VALUE never leaves this module. The whole reason
 * `src/trading/account.ts` inverts the project's usual passthrough rule is that a field it does not
 * recognise on a brokerage response may be an account number, and a tool result is text a model
 * relays. So there is a test that puts an account-number-shaped value under an unknown key and
 * asserts the serialised result contains the key's NAME and not the value.
 *
 * The second is lots versus shares. One lot is a hundred shares, a figure read out of the wrong key
 * is off by exactly 100×, and 100× of a plausible position is still a plausible position — nothing
 * downstream would catch it. So each is read only from a key whose name says which it is, and
 * anything computed is announced in `derived`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-trading-"));

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getStore } from "../src/auth/store.ts";
import { resetSession } from "../src/auth/session.ts";
import { clearCache } from "../src/core/_util.ts";
import { StockbitError } from "../src/http/errors.ts";
import {
  DEFAULT_FEES,
  PERFORMANCE_KINDS,
  getAccount,
  getCashBalance,
  getFees,
  getPortfolio,
  getPortfolioPerformance,
  getPosition,
  getRealizedHistory,
  getStockTradable,
  getTradeHistory,
  getTradingInfo,
  listOrders,
  listOrdersRaw,
  maskIdentifier,
  maskName,
} from "../src/trading/account.ts";
import { registerTradingTools } from "../src/tools/trading.ts";
import type { Definer, ToolHandler } from "../src/tools/_define.ts";

function farFutureJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: 2000000000 })}.sig`;
}

/* --------------------------------- fixtures --------------------------------- */

/**
 * An account number that must never appear in any result, parked under a key the projection does
 * not know. If this string turns up in a serialised tool result, the module's central rule broke.
 */
const SECRET_ACCOUNT = "1122334455667788";

/**
 * Three holdings, spelled three ways: the keys the projection expects, a second plausible set, and
 * a row it cannot read at all. A projection that only ever meets rows it understands proves nothing
 * about a host nobody has observed.
 */
const PORTFOLIO_BODY = {
  data: {
    list: [
      {
        symbol: "BBRI",
        lot: 25,
        available_lot: 20,
        average_price: 4100,
        last_price: 4250,
        market_value: 10625000,
        total_cost: 10250000,
        unrealized_pnl: 375000,
        unrealized_pnl_percent: 3.66,
        customer_account_number: SECRET_ACCOUNT,
      },
      {
        stock_code: "TLKM",
        balance: 3000,
        avg_price: "2800",
        // Thousand-separated: refused rather than guessed at, so it stays unmapped.
        market_value: "8,400,000",
      },
      { something_nobody_named: 1 },
    ],
  },
};

const SUMMARY_BODY = {
  data: { market_value: 19025000, total_cost: 18650000, unrealized_pnl: 375000, cash: 5000000 },
};

const CASH_BODY = { data: { cash: 5000000, buying_power: 12500000, withdrawable: 4800000 } };
const CASH_INFO_BODY = { data: { t0: 1000000, t1: 2000000, t2: 2000000 } };

const ORDERS_BODY = {
  data: {
    list: [
      {
        order_id: "ORD-1",
        symbol: "BBRI",
        action: "BUY",
        status: "OPEN",
        price: 4100,
        shares: 2500,
        filled: 500,
        ui_ref: "abc-123",
        client_account: SECRET_ACCOUNT,
      },
      { orderId: 77, stock_code: "TLKM", side: "Jual", order_lot: 10, order_status: "PARTIAL" },
      { mystery: true },
    ],
  },
};

const HISTORY_BODY = {
  data: { list: [{ symbol: "BBRI", action: "buy", price: 4100, shares: 2500, date: "2026-08-20" }] },
};
const REALIZED_BODY = {
  data: { list: [{ symbol: "ASII", realized_pnl: 250000, realized_pnl_percent: 5.1, date: "2026-08-01" }] },
};
const PERFORMANCE_BODY = { data: { list: [{ date: "2026-08-01", value: 100 }, { date: "2026-08-02", value: 105 }] } };

const TRADABLE_BODY = { data: { list: [{ symbol: "BBRI", tradable: true }] } };

const ACCOUNT_BODY = {
  data: {
    name: "Marvel Harisson",
    account_number: "NH000123456789",
    rdn: "8801234567",
    sid: "IDD123456789012",
    broker: "Stockbit Sekuritas",
    internal_note: SECRET_ACCOUNT,
  },
};
const SUB_ACCOUNT_BODY = { data: { list: [{ type: "REGULER", sub_account_id: "SA-99887766" }] } };

const TRADING_INFO_BODY = { data: { status: "ACTIVE", buying_power: 12500000 } };

/* ---------------------------------- the wire ---------------------------------- */

const realFetch = globalThis.fetch;
const seenUrls: string[] = [];
const requests: Record<string, number> = {};

/** Per-path overrides for the tests that need a route to fail or answer differently. */
let overrides: Record<string, () => Response> = {};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function count(key: string): void {
  requests[key] = (requests[key] ?? 0) + 1;
}

function lastUrl(fragment: string): URL {
  const found = [...seenUrls].reverse().find((u) => u.includes(fragment));
  assert.ok(found, `no request matching ${fragment} was made`);
  return new URL(found);
}

const ROUTE_BODIES: Array<[string, unknown, string]> = [
  ["/portfolio/v2/list", PORTFOLIO_BODY, "portfolioList"],
  ["/portfolio/v2/summary", SUMMARY_BODY, "portfolioSummary"],
  ["/portfolio/v2/detail", { data: PORTFOLIO_BODY.data.list[0] }, "portfolioDetail"],
  ["/balance/cash/info", CASH_INFO_BODY, "cashInfo"],
  ["/balance/cash", CASH_BODY, "cash"],
  ["/order/v2/detail", { data: ORDERS_BODY.data.list[0] }, "orderDetail"],
  ["/order/v2/list", ORDERS_BODY, "orderList"],
  ["/history/realized", REALIZED_BODY, "realized"],
  ["/history/performance/trade", PERFORMANCE_BODY, "tradePerformance"],
  ["/history/performance/portfolio/", PERFORMANCE_BODY, "portfolioPerformance"],
  ["/history/v3", HISTORY_BODY, "history"],
  ["/trading/info", TRADING_INFO_BODY, "tradingInfo"],
  ["/formula/v2", { data: { buy_fee: 0.0012, sell_fee: 0.0022 } }, "formula"],
  ["/stock/tradable", TRADABLE_BODY, "tradable"],
  ["/v2/sub-account/list", SUB_ACCOUNT_BODY, "subAccounts"],
  ["/account", ACCOUNT_BODY, "account"],
];

before(() => {
  getStore("securities").set("SECURITIES-REFRESH");
  resetSession();
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    seenUrls.push(u);
    const path = new URL(u).pathname;
    if (path.endsWith("/auth/refresh")) {
      count("refresh");
      return json({ data: { access_token: farFutureJwt() } });
    }
    for (const [fragment, body, key] of ROUTE_BODIES) {
      if (path.includes(fragment)) {
        count(key);
        const override = overrides[fragment];
        if (override) return override();
        return json(body);
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  clearCache();
  resetSession("securities");
  getStore("securities").set("SECURITIES-REFRESH");
  seenUrls.length = 0;
  overrides = {};
  for (const key of Object.keys(requests)) delete requests[key];
});

after(() => {
  globalThis.fetch = realFetch;
  getStore("securities").clear();
});

/* ------------------------------ the central rule ------------------------------ */

test("an unrecognised field's NAME is reported and its VALUE is not", async () => {
  const portfolio = await getPortfolio();
  const serialised = JSON.stringify(portfolio);
  assert.ok(
    serialised.includes("customer_account_number"),
    "the unknown key's name must be reported so drift is visible",
  );
  assert.equal(
    serialised.includes(SECRET_ACCOUNT),
    false,
    "an unmapped value must never cross this boundary — it may be an account number",
  );
});

test("the same rule holds on orders and on the account record", async () => {
  const orders = JSON.stringify(await listOrders());
  assert.ok(orders.includes("client_account"));
  assert.equal(orders.includes(SECRET_ACCOUNT), false);

  const identity = JSON.stringify(await getAccount());
  assert.ok(identity.includes("internal_note"));
  assert.equal(identity.includes(SECRET_ACCOUNT), false);
});

/* --------------------------------- portfolio --------------------------------- */

test("a holding is projected, and readFrom names the key each figure came from", async () => {
  const { holdings } = await getPortfolio();
  const bbri = holdings[0];
  assert.equal(bbri.symbol, "BBRI");
  assert.equal(bbri.lots, 25);
  assert.equal(bbri.averagePrice, 4100);
  assert.equal(bbri.unrealizedPnlIdr, 375000);
  assert.equal(bbri.readFrom.averagePrice, "average_price");
  assert.equal(bbri.readFrom.lots, "lot");
});

test("shares are derived from lots and the derivation is announced", async () => {
  const { holdings } = await getPortfolio();
  const bbri = holdings[0];
  assert.equal(bbri.shares, 2500, "25 lots is 2500 shares");
  assert.deepEqual(bbri.derived, ["shares", "availableShares"]);
  assert.equal(bbri.readFrom.shares, undefined, "a derived figure was not read from anything");
});

test("a share-shaped key gives shares, and lots are the derived one", async () => {
  const { holdings } = await getPortfolio();
  const tlkm = holdings[1];
  assert.equal(tlkm.shares, 3000, "`balance` is a share count");
  assert.equal(tlkm.lots, 30);
  assert.deepEqual(tlkm.derived, ["lots"]);
});

test("a thousand-separated number is refused rather than guessed at", async () => {
  // "8,400,000" is 8.4m under one Indonesian convention and 8.4 under the other. A field left
  // undefined is a question the user can answer; a figure off by a thousand is not.
  const { holdings } = await getPortfolio();
  const tlkm = holdings[1];
  assert.equal(tlkm.marketValueIdr, undefined);
  assert.ok(tlkm.unmappedKeys.includes("market_value"), "the refused key must show up as unmapped");
});

test("a row nothing was recognised on is still returned, empty and honest", async () => {
  const { holdings } = await getPortfolio();
  const unknown = holdings[2];
  assert.equal(unknown.symbol, undefined);
  assert.deepEqual(unknown.readFrom, {});
  assert.deepEqual(unknown.unmappedKeys, ["something_nobody_named"]);
});

test("the summary is fetched alongside the list, and its failure does not fail the read", async () => {
  overrides["/portfolio/v2/summary"] = () => new Response("boom", { status: 500 });
  const portfolio = await getPortfolio();
  assert.equal(portfolio.holdings.length, 3, "the holdings are the answer to the question asked");
  assert.equal(portfolio.totals, undefined);
  assert.ok(portfolio.totalsUnavailable, "and the reason the totals are missing is stated");
});

test("owning none of a symbol is an answer, not an error", async () => {
  overrides["/portfolio/v2/detail"] = () => new Response("not found", { status: 404 });
  const position = await getPosition("pgas");
  assert.equal(position.symbol, "PGAS");
  assert.equal(position.holding, null);
});

/* ----------------------------------- cash ----------------------------------- */

test("cash and buying power are separate fields, because they are separate numbers", async () => {
  const cash = await getCashBalance();
  assert.equal(cash.cashIdr, 5000000);
  assert.equal(cash.buyingPowerIdr, 12500000, "the trading limit is larger than the balance");
  assert.equal(cash.settlement?.t1Idr, 2000000);
});

test("a settlement lookup that fails leaves the balance readable", async () => {
  overrides["/balance/cash/info"] = () => new Response("nope", { status: 503 });
  const cash = await getCashBalance();
  assert.equal(cash.cashIdr, 5000000);
  assert.equal(cash.settlement, undefined);
  assert.ok(cash.settlementUnavailable);
});

/* ---------------------------------- orders ---------------------------------- */

test("side is normalised only when the wire says a word we know, and sideRaw always survives", async () => {
  const { orders } = await listOrders();
  assert.equal(orders[0].side, "buy");
  assert.equal(orders[0].sideRaw, "BUY");
  assert.equal(orders[1].side, "sell", "`Jual` is sell");
  assert.equal(orders[2].side, undefined);
  assert.equal(orders[2].sideRaw, undefined);
});

test("an order id that arrived as a number is still a string", async () => {
  const { orders } = await listOrders();
  assert.equal(orders[1].orderId, "77");
});

test("the symbol filter is sent as the dotted key Stockbit's own client uses", async () => {
  await listOrders({ symbol: "bbri" });
  const url = lastUrl("/order/v2/list");
  assert.equal(url.searchParams.get("filter_criteria.stock_code"), "BBRI");
});

test("listOrders is cached and listOrdersRaw is not", async () => {
  await listOrders();
  await listOrders();
  assert.equal(requests.orderList, 1, "the display read is cached");
  await listOrdersRaw();
  await listOrdersRaw();
  assert.equal(requests.orderList, 3, "the write path's snapshot must never be served from a cache");
});

test("no tool module reaches for the raw order list", () => {
  // The ADR-0003 lesson restated as a guard: a byte-exact operation's accessor must not become a
  // display accessor by being convenient. If a tool ever needs this, that is an argument to make.
  const toolsDir = fileURLToPath(new URL("../src/tools/", import.meta.url));
  const offenders = readdirSync(toolsDir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => readFileSync(join(toolsDir, f), "utf8").includes("listOrdersRaw"));
  assert.deepEqual(offenders, []);
});

/* ---------------------------------- history ---------------------------------- */

test("the history filter is camelCase on this route, unlike the order list", async () => {
  await getTradeHistory({ symbol: "bbri", period: "1M", page: 2, limit: 50 });
  const url = lastUrl("/history/v3");
  assert.equal(url.searchParams.get("stockCode"), "BBRI");
  assert.equal(url.searchParams.get("period"), "1M");
  assert.equal(url.searchParams.get("page"), "2");
});

test("a page that is not a positive integer never reaches the wire", async () => {
  await assert.rejects(() => getTradeHistory({ page: 0 }), /positive integer/);
  await assert.rejects(() => getTradeHistory({ limit: 1.5 }), /positive integer/);
  assert.equal(requests.history, undefined);
});

test("realized history projects the profit and loss that actually happened", async () => {
  const { rows } = await getRealizedHistory();
  assert.equal(rows[0].symbol, "ASII");
  assert.equal(rows[0].realizedPnlIdr, 250000);
});

/* -------------------------------- performance -------------------------------- */

test("a performance series must be one of the four, and an unknown one sends nothing", async () => {
  await assert.rejects(() => getPortfolioPerformance("everything"), /Unknown performance series/);
  assert.equal(requests.portfolioPerformance, undefined);
  for (const kind of PERFORMANCE_KINDS) {
    const series = await getPortfolioPerformance(kind);
    assert.equal(series.kind, kind);
    assert.equal(series.count, 2);
    clearCache();
  }
});

/* ------------------------------------ fees ------------------------------------ */

test("a fee expressed as a fraction is read as a percentage, with the raw value kept", async () => {
  const fees = await getFees();
  assert.equal(fees.source, "formula");
  assert.ok(Math.abs(fees.buyPct - 0.12) < 1e-9, `expected 0.12%, got ${fees.buyPct}`);
  assert.ok(Math.abs(fees.sellPct - 0.22) < 1e-9);
  assert.equal(fees.raw?.buy, 0.0012, "what the wire said is kept so the reading can be checked");
});

test("a fee already expressed as a percentage is not multiplied again", async () => {
  overrides["/formula/v2"] = () => json({ data: { buy_fee: 0.15, sell_fee: 0.25 } });
  const fees = await getFees();
  assert.equal(fees.buyPct, 0.15);
  assert.equal(fees.sellPct, 0.25);
});

test("when the account's own rate cannot be read, the fallback SAYS it is a fallback", async () => {
  // The failure this prevents: a net proceed quoted confidently off a rate that is not this
  // account's. `source: "default"` is what the tool description tells the model to disclose.
  overrides["/formula/v2"] = () => new Response("gone", { status: 500 });
  overrides["/trading/info"] = () => new Response("gone", { status: 500 });
  const fees = await getFees();
  assert.equal(fees.source, "default");
  assert.equal(fees.buyPct, DEFAULT_FEES.buyPct);
  assert.match(fees.note ?? "", /may be wrong/);
});

test("trading_info falls back to the fee schedule endpoint before the defaults", async () => {
  overrides["/formula/v2"] = () => new Response("gone", { status: 500 });
  overrides["/trading/info"] = () => json({ data: { status: "ACTIVE", buy_fee: 0.15, sell_fee: 0.25 } });
  const info = await getTradingInfo();
  assert.equal(info.status, "ACTIVE");
  assert.equal(info.fees.source, "trading-info");
});

/* --------------------------------- tradability --------------------------------- */

test("a symbol the response did not mention is unknown, not untradable", async () => {
  const result = await getStockTradable(["bbri", "gotO"]);
  assert.equal(result.symbols[0].tradable, true);
  assert.equal(result.symbols[1].symbol, "GOTO");
  assert.equal(result.symbols[1].tradable, undefined, "'we could not tell' is not 'you may not'");
  assert.equal(result.request.stock_codes, "BBRI,GOTO");
});

test("an empty symbol list is refused before any request", async () => {
  await assert.rejects(() => getStockTradable([]), /At least one symbol/);
  assert.equal(requests.tradable, undefined);
});

/* ---------------------------------- identity ---------------------------------- */

test("the account holder's name never leaves as a name", async () => {
  const identity = await getAccount();
  assert.equal(identity.nameMasked, "M. H.");
  assert.equal(JSON.stringify(identity).includes("Marvel"), false);
  assert.equal(JSON.stringify(identity).includes("Harisson"), false);
});

test("identifiers keep four characters, and the bullets do not encode the length", async () => {
  const identity = await getAccount();
  assert.equal(identity.accountNumberMasked, "••••6789");
  assert.equal(identity.rdnMasked, "••••4567");
  assert.equal(identity.sidMasked, "••••9012");
  assert.equal(identity.subAccounts[0].numberMasked, "••••7766");
  assert.equal(identity.subAccounts[0].type, "REGULER");
  assert.match(identity.masking, /masked by this server/);
});

test("masking is done in the core module, not at the tool boundary", () => {
  // Stated as a unit test on the helpers so the rule survives a refactor of either layer: whatever
  // calls these gets the masked form, and there is no unmasked path to reach for.
  assert.equal(maskName("Siti Nurhaliza Putri"), "S. N. P.");
  assert.equal(maskName("   "), "(masked)");
  assert.equal(maskIdentifier("NH000123456789"), "••••6789");
  assert.equal(maskIdentifier("12"), "••••12");
  assert.equal(maskIdentifier(""), "(masked)");
});

/* --------------------------------- the session --------------------------------- */

test("with no trading session, every read says how to get one", async () => {
  resetSession("securities");
  getStore("securities").clear();
  try {
    await assert.rejects(
      () => getPortfolio(),
      (err: unknown) => {
        assert.ok(err instanceof StockbitError);
        assert.equal(err.kind, "auth");
        assert.match(err.message, /stockbit-auth trading-login/);
        assert.match(err.message, /never stored/, "and says the PIN is not kept, in the same breath");
        return true;
      },
    );
  } finally {
    getStore("securities").set("SECURITIES-REFRESH");
    resetSession("securities");
  }
});

/* ----------------------------------- tools ----------------------------------- */

function fakeDefiner(): { definer: Definer; reads: Map<string, ToolHandler>; writes: string[] } {
  const reads = new Map<string, ToolHandler>();
  const writes: string[] = [];
  const definer: Definer = {
    read: (name, _description, _shape, handler) => {
      reads.set(name, handler);
    },
    write: (name) => {
      writes.push(name);
    },
    writeNames: () => [...writes],
  };
  return { definer, reads, writes };
}

test("ten reads, no writes — nothing in this family can place an order", async () => {
  const { definer, reads, writes } = fakeDefiner();
  registerTradingTools(definer);
  assert.deepEqual(
    [...reads.keys()].sort(),
    [
      "account",
      "cash_balance",
      "order_detail",
      "order_history",
      "orders",
      "portfolio",
      "position",
      "stock_tradable",
      "trade_performance",
      "trading_info",
    ],
  );
  assert.deepEqual(writes, [], "order entry is ADR-0004 and arrives through define.write, not here");
});

test("the arguments a model sends reach the wire", async () => {
  const { definer, reads } = fakeDefiner();
  registerTradingTools(definer);

  await reads.get("order_history")!({ kind: "realized", symbol: "asii", limit: 10 });
  assert.equal(lastUrl("/history/realized").searchParams.get("stockCode"), "ASII");

  await reads.get("stock_tradable")!({ symbols: ["bbri"] });
  assert.equal(lastUrl("/stock/tradable").searchParams.get("stock_codes"), "BBRI");

  await reads.get("trade_performance")!({ series: "cumulative-return" });
  assert.ok(lastUrl("/history/performance/portfolio/").pathname.endsWith("/cumulative-return"));
});

test("every tool description tells the model the fields are not observed", () => {
  const { definer } = fakeDefiner();
  const descriptions: string[] = [];
  const capturing: Definer = {
    read: (_name, description) => {
      descriptions.push(description);
    },
    write: definer.write,
    writeNames: definer.writeNames,
  };
  registerTradingTools(capturing);
  assert.equal(descriptions.length, 10);
  for (const description of descriptions) {
    assert.match(description, /PENDING VERIFICATION/);
    assert.match(description, /trading-login/, "and how to get a session, since none of these work without one");
  }
});
