import { z } from "zod";
import {
  activateVirtualAccount, amendVirtualOrder, cancelVirtualOrder, getVirtualConfig,
  getVirtualOrders, getVirtualPortfolio, getVirtualPosition, placeVirtualOrder,
  type VirtualWriteResult,
} from "../virtual/account.js";
import { StockbitError } from "../http/errors.js";
import { jsonResult, runTool } from "./_format.js";
import type { Definer } from "./_define.js";

const NOTE = "Stockbit WEBSITE virtual account: simulated money, separate from the local paper ledger and real brokerage portfolio. Uses your normal Stockbit login; no trading PIN. ";
const WRITE_NOTE = "Requires confirm: true for this specific virtual-account change. Inspect outcome and message. A timeout or unverified result must not be automatically retried. Good-for-day limit orders only; no social sharing. ";
const confirm = z.boolean().optional().describe("True only after the user authorized this specific Stockbit virtual-account change.");
const symbol = z.string().describe("IDX ticker, e.g. BBCA");
const price = z.number().int().positive().describe("Limit price in IDR per share, on the IDX tick grid");
const lots = z.number().int().positive().describe("Whole lots; one lot is 100 shares");

async function runWrite(fn: () => Promise<VirtualWriteResult>) {
  try {
    const result = await fn();
    return jsonResult({ success: result.outcome === "ok", data: result }, result.outcome !== "ok");
  } catch (error) {
    return jsonResult(error instanceof StockbitError ? error.toResult() : { success: false, error: String(error) }, true);
  }
}

export function registerVirtualTools(define: Definer): void {
  define.read("virtual_portfolio", NOTE + "Read virtual cash, holdings, and performance fields from Stockbit.", {},
    () => runTool(() => getVirtualPortfolio()), { evidence: "observed" });
  define.read("virtual_position", NOTE + "Read one virtual holding.", { symbol },
    (a) => runTool(() => getVirtualPosition(a.symbol)), { evidence: "observed" });
  define.read("virtual_orders", NOTE + "Read virtual orders and their actual upstream statuses. An order record is not proof of a fill.", {},
    () => runTool(() => getVirtualOrders()), { evidence: "observed" });
  define.read("virtual_config", NOTE + "Read virtual-account fee and formula settings without executing formula strings.", {},
    () => runTool(() => getVirtualConfig()), { evidence: "observed" });
  define.write("virtual_activate", NOTE + "Activate Stockbit's virtual account and verify portfolio access. " + WRITE_NOTE,
    { confirm }, (a) => runWrite(() => activateVirtualAccount(a.confirm === true)),
    { destructiveHint: false, idempotentHint: false });
  define.write("virtual_order", NOTE + "Place a simulated buy or sell on Stockbit and read back the virtual order. A sell order was verified live; successful buys and fills remain unverified. " + WRITE_NOTE,
    { symbol, action: z.enum(["buy", "sell"]), price, lots, confirm },
    (a) => runWrite(() => placeVirtualOrder({ ...a, confirm: a.confirm === true })),
    { evidence: "read-back", destructiveHint: false, idempotentHint: false });
  define.write("virtual_order_amend", NOTE + "Change an open virtual order's limit price and total lots. Verified live for a price change on an unfilled sell order. " + WRITE_NOTE,
    { order_id: z.string(), symbol, price, lots, confirm },
    (a) => runWrite(() => amendVirtualOrder({ ...a, orderId: a.order_id, confirm: a.confirm === true })),
    { evidence: "read-back", destructiveHint: true, idempotentHint: false });
  define.write("virtual_order_cancel", NOTE + "Cancel an open virtual order and verify WITHDRAWN status. Verified live for an unfilled sell order. " + WRITE_NOTE,
    { order_id: z.string(), confirm },
    (a) => runWrite(() => cancelVirtualOrder({ orderId: a.order_id, confirm: a.confirm === true })),
    { evidence: "read-back", destructiveHint: true, idempotentHint: false });
}
