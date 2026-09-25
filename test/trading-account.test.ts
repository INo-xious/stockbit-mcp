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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { defaultSettings, settingsPath } from "../src/settings.ts";
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
    name: "Ayu Lestari",
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
  ["/account/personal", { data: {} }, "personalAccount"],
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
  rmSync(settingsPath(), { force: true });
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

const NESTED_SUMMARY = {
  trading: { balance: 2000000 },
  amount: { invested: 3000000, allocated: 100000, credit_limit: 4000000 },
  profit_loss: { net: 350000, unrealised: 300000, realised: 50000 },
  gain: 0.1,
  equity: 5400000,
  debt: { total: 200000, ratio: 0.04, market_value: 3300000, buffer: { value: 500000, percentage: 20 } },
};

const NESTED_HOLDING = {
  symbol: "BBRI",
  qty: { balance: { lot: 10, share: 1000 }, available: { lot: 8, share: 800 }, private_note: SECRET_ACCOUNT },
  price: { average: { price: 3000, fee: 0.1 }, latest: 3300 },
  asset: { amount_invested: 3000000, unrealised: { market_value: 3300000, profit_loss: 300000, gain: 0.1 } },
};

test("current nested portfolio totals preserve their meanings and omit account identifiers", async () => {
  overrides["/portfolio/v2/list"] = () => json({ data: { summary: NESTED_SUMMARY, results: [] } });
  overrides["/portfolio/v2/summary"] = () => json({ data: {
    aggregated_portfolio_summary: NESTED_SUMMARY,
    summary_per_portfolios: [{ account_number: SECRET_ACCOUNT, portfolio_name: "Private", summary: NESTED_SUMMARY }],
  } });
  const result = await getPortfolio();
  assert.deepEqual(result.holdings, []);
  assert.equal(result.totals?.costIdr, 3000000);
  assert.equal(result.totals?.tradingBalanceIdr, 2000000);
  assert.equal(result.totals?.cashIdr, undefined, "trading balance is not cash");
  assert.equal(result.totals?.netPnlIdr, 350000);
  assert.equal(result.totals?.unrealizedPnlIdr, 300000);
  assert.equal(result.totals?.gainRatio, 0.1, "a fraction is not mislabeled as a percentage");
  assert.equal(result.totals?.unrealizedPnlPct, undefined);
  assert.equal(result.totals?.debtBufferIdr, 500000);
  assert.equal(result.totals?.readFrom.costIdr, "aggregated_portfolio_summary.amount.invested");
  assert.equal(JSON.stringify(result).includes(SECRET_ACCOUNT), false);
});

test("a failed aggregate summary can still expose the list's clearly identified totals", async () => {
  overrides["/portfolio/v2/list"] = () => json({ data: { summary: NESTED_SUMMARY, results: [] } });
  overrides["/portfolio/v2/summary"] = () => json({ message: "Unavailable" }, 404);
  const result = await getPortfolio();
  assert.equal(result.totals?.readFrom.costIdr, "summary.amount.invested");
  assert.match(result.totalsUnavailable ?? "", /Account-wide summary unavailable/);
});

test("nested holdings map explicit share and lot units and preserve unknown key names only", async () => {
  overrides["/portfolio/v2/list"] = () => json({ data: { results: [NESTED_HOLDING] } });
  const holding = (await getPortfolio()).holdings[0];
  assert.equal(holding.lots, 10);
  assert.equal(holding.shares, 1000);
  assert.equal(holding.availableShares, 800);
  assert.equal(holding.averagePrice, 3000);
  assert.equal(holding.marketValueIdr, 3300000);
  assert.equal(holding.unrealizedGainRatio, 0.1);
  assert.equal(holding.readFrom.shares, "qty.balance.share");
  assert.ok(holding.unmappedKeys.includes("qty.private_note"));
  assert.equal(JSON.stringify(holding).includes(SECRET_ACCOUNT), false);
});

test("current detail null shells mean no position and never fabricate a zero holding", async () => {
  const shell = { symbol: "BBRI", qty: null, price: null, asset: null, company: null, info: [] };
  overrides["/portfolio/v2/detail"] = () => json({ data: { result: shell, day_trade: shell } });
  const position = await getPosition("BBRI");
  assert.equal(position.holding, null);
  assert.equal(position.dayTradeHolding, null);
  assert.equal(lastUrl("/portfolio/v2/detail").searchParams.get("stock_code"), "BBRI");
});

test("current detail unwraps the position and keeps day trading separate", async () => {
  overrides["/portfolio/v2/detail"] = () => json({ data: { result: NESTED_HOLDING, day_trade: null } });
  const position = await getPosition("BBRI");
  assert.equal(position.holding?.lots, 10);
  assert.equal(position.dayTradeHolding, null);
});

/* ----------------------------------- cash ----------------------------------- */

test("current cash and trading balances map independently without claiming withdrawability", async () => {
  overrides["/balance/cash"] = () => json({ data: { available_cash_on_hand: 2000000 } });
  overrides["/balance/cash/info"] = () => json({ data: { trade_limit: 4000000, trade_balance: 2500000, day_trade_buying_power: 6000000 } });
  const cash = await getCashBalance();
  assert.equal(cash.cashIdr, 2000000);
  assert.equal(cash.availableCashOnHandIdr, 2000000);
  assert.equal(cash.buyingPowerIdr, 4000000);
  assert.equal(cash.tradingBalanceIdr, 2500000);
  assert.equal(cash.dayTradeBuyingPowerIdr, 6000000);
  assert.equal(cash.withdrawableIdr, undefined);
  assert.equal(cash.readFrom.buyingPowerIdr, "info.trade_limit");
});

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
    rmSync(settingsPath(), { force: true });
  clearCache();
  }
});

/* ------------------------------------ fees ------------------------------------ */

test("nested fee rates are read while formula strings are never executed", async () => {
  overrides["/formula/v2"] = () => json({ data: {
    fee: { buy: 0.0012, sell: 0.0022 },
    formula: { buy: { invested: "throw new Error('Do not execute server formulas')" } },
  } });
  const fees = await getFees();
  assert.equal(fees.source, "formula");
  assert.equal(fees.buyPct, 0.12);
  assert.equal(fees.sellPct, 0.22);
  assert.equal(fees.readFrom?.buy, "fee.buy");
});

test("trading information requests supported features and projects the reply without leaking unknown values", async () => {
  overrides["/trading/info"] = () => json({ data: {
    day_trade: { trading_open: "09:00", trading_close: "15:50", debt_ratio_rules: { force_sell: 0.8 }, customer: SECRET_ACCOUNT },
    split_order: { max_order: 100, max_lot_per_order: 500 },
    market_cycle: { market_cycle_allocation: { name: "Regular", start_at: "09:00", end_at: "16:00" } },
  } });
  const info = await getTradingInfo();
  assert.deepEqual(lastUrl("/trading/info").searchParams.getAll("features"), ["FEATURE_DAY_TRADE", "FEATURE_SPLIT_ORDER", "FEATURE_MARKET_CYCLE"]);
  assert.equal(info.features.day_trade?.tradingOpen, "09:00");
  assert.equal(info.features.split_order?.maxLotsPerOrder, 500);
  assert.equal(info.features.market_cycle?.allocationName, "Regular");
  assert.equal(JSON.stringify(info).includes(SECRET_ACCOUNT), false);
});

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
  assert.deepEqual(result.request.stock_codes, ["BBRI", "GOTO"]);
  assert.deepEqual(lastUrl("/stock/tradable").searchParams.getAll("stock_codes"), ["BBRI", "GOTO"]);
});

test("personal account fallback projects masked fields and drops personal addresses and identifiers", async () => {
  overrides["/account"] = () => json({ message: "Unrecognized Command" }, 404);
  overrides["/account/personal"] = () => json({ data: {
    personal: { full_name: "Ayu Lestari", identity: SECRET_ACCOUNT, email: "private@example.test", street: "Private street" },
    account: { number: "ACCT-7788", ksei: { sid: "SID-9911" }, bank: { rdn: { account: { number: "RDN-4455", name: "Ayu Lestari" } } } },
    status: { description: "Active" },
  } });
  const account = await getAccount();
  assert.equal(account.nameMasked, "A. L.");
  assert.equal(account.accountNumberMasked, "••••7788");
  assert.equal(account.rdnMasked, "••••4455");
  assert.equal(account.sidMasked, "••••9911");
  assert.equal(account.readFrom.name, "personal.full_name");
  const serialized = JSON.stringify(account);
  for (const privateValue of [SECRET_ACCOUNT, "private@example.test", "Private street", "Ayu Lestari", "ACCT-7788"]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("an empty symbol list is refused before any request", async () => {
  await assert.rejects(() => getStockTradable([]), /At least one symbol/);
  assert.equal(requests.tradable, undefined);
});

/* ---------------------------------- identity ---------------------------------- */

test("the account holder's name never leaves as a name", async () => {
  const identity = await getAccount();
  assert.equal(identity.nameMasked, "A. L.");
  assert.equal(JSON.stringify(identity).includes("Ayu"), false);
  assert.equal(JSON.stringify(identity).includes("Lestari"), false);
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

test("the reads and the writes are exactly these, and nothing drifts between them", async () => {
  const { definer, reads, writes } = fakeDefiner();
  registerTradingTools(definer);
  assert.deepEqual(
    [...reads.keys()].sort(),
    [
      "account",
      "cash_balance",
      "order_detail",
      "order_history",
      "paper_order_preview",
      "paper_portfolio",
      "paper_position",
      "paper_cash_balance",
      "paper_orders",
      "paper_order_detail",
      "paper_order_history",
      "paper_trade_performance",
      "orders",
      "portfolio",
      "position",
      "stock_tradable",
      "trade_performance",
      "trading_info",
      "trading_status",
    ].sort(),
  );
  // The four that move money, and only those four — plus `trading_forget`, which is a write for the
  // same structural reason and for no other: it changes process state, so it must not be reachable
  // from a saved workflow recipe. It moves nothing and can only ever make this server ask MORE
  // questions. `order_preview` is a read on purpose: it prices and checks an order and sends
  // nothing, so a recipe may reach it — and a recipe that reaches the preview still cannot reach
  // anything that places what it priced.
  assert.deepEqual(
    [...writes].sort(),
    ["paper_order_amend", "paper_order_buy", "paper_order_cancel", "paper_order_sell", "trading_forget"],
  );
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

/** Every registered description, by tool name and by whether it was a read or a write. */
function descriptions(): { reads: Map<string, string>; writes: Map<string, string> } {
  const reads = new Map<string, string>();
  const writes = new Map<string, string>();
  registerTradingTools({
    read: (name, description) => {
      reads.set(name, description);
    },
    write: (name, description) => {
      writes.set(name, description);
    },
    writeNames: () => [...writes.keys()],
  });
  return { reads, writes };
}

test("every account read distinguishes verified empty/account envelopes from projected nonempty rows", () => {
  const { reads } = descriptions();
  // The two exceptions are named rather than filtered by a pattern. `trading_status` reads local
  // configuration and makes no request; `order_preview` carries its own, longer warning about
  // checks that could not be verified, and repeating the projection note there would bury it.
  const exempt = new Set(["trading_status", "order_preview"]);
  for (const [name, description] of reads) {
    if (exempt.has(name) || name.startsWith("paper_")) continue;
    assert.match(description, /Field mapping is partly verified/, name);
    assert.match(description, /Nonempty holding, order and history rows remain projected/, name);
    assert.match(description, /trading-login/, `${name} must say how to get a session`);
  }
  assert.equal([...reads.keys()].filter((name) => !name.startsWith("paper_") && name !== "trading_status").length, 10);
});

test("every write description says there is no undo, and forbids a resend", () => {
  // These four are the only tools in this project that cannot be taken back. A model reads the
  // description and nothing else before deciding how to talk about the result, so the two facts
  // that matter most have to be in it.
  //
  // `trading_forget` is named as an exception rather than filtered out by a pattern, the same way
  // the read exemptions above are, because the whole value of this test is that a NEW write has to
  // be thought about here. It is exempt because every clause would be a lie: it moves no money,
  // there is nothing to resend, and it is undone by ticking the box again.
  const { writes } = descriptions();
  assert.equal(writes.size, 5);
  const exempt = new Set(["trading_forget"]);
  for (const [name, description] of writes) {
    if (exempt.has(name)) continue;
    assert.match(description, /LOCAL PAPER SIMULATION ONLY/i, `${name} must identify local simulation`);
    assert.match(description, /confirm: true/, `${name} must state the confirmation requirement`);
    assert.match(description, /No real money/, `${name} must rule out real-money execution`);
  }
  assert.equal(writes.size - exempt.size, 4, "the money-moving writes are still exactly four");
});

test("trading_forget's description says it only ever tightens", () => {
  // The one thing a model must not conclude from "this is a write tool" is that calling it is
  // risky. It is the opposite: it takes a permission away, so hesitating over it is the failure.
  const { writes } = descriptions();
  const description = writes.get("trading_forget")!;
  assert.doesNotMatch(description, /no undo/i, "saying so would be false and would teach hesitation");
  assert.match(description, /ask me again|ask the user directly|asks the user directly/i);
  assert.match(description, /never fewer|only ever/i, "it must say it cannot loosen anything");
  assert.match(description, /stockbit-auth trading-forget/, "and name the terminal command that crosses processes");
});

test("paper mode never substitutes a ledger for real portfolio and securities reads", async () => {
  const settings = defaultSettings();
  settings.trading.mode = "paper";
  writeFileSync(settingsPath(), JSON.stringify(settings));
  const { definer, reads } = fakeDefiner();
  registerTradingTools(definer);
  for (const [name, args, path] of [
    ["portfolio", {}, "/portfolio/v2/list"],
    ["position", { symbol: "BBRI" }, "/portfolio/v2/detail"],
    ["cash_balance", {}, "/balance/cash"],
    ["orders", {}, "/order/v2/list"],
    ["order_detail", { order_id: "O1" }, "/order/v2/detail"],
    ["order_history", {}, "/history/v3"],
    ["trade_performance", {}, "/history/performance/trade"],
  ] as const) {
    const result = await reads.get(name)!(args);
    assert.ok(seenUrls.some((url) => new URL(url).pathname === path), `${name} must read the securities account`);
    assert.doesNotMatch(JSON.stringify(result), /PAPER ACCOUNT/);
  }
});
