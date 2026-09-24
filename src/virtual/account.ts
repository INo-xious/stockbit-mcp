/** Stockbit-hosted virtual trading. The local paper ledger is a separate product. ADR-0013. */
import { getJson, postJson, type GetOptions } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { onTickGrid } from "../core/ticks.js";
import { normalizeSymbol } from "../symbol.js";
import { redact } from "../redact.js";

export const VIRTUAL_BANNER = "STOCKBIT VIRTUAL ACCOUNT — no real money.";
const identity = { mode: "stockbit_virtual" as const, source: "Stockbit website virtual account" };
type Row = Record<string, unknown>;
type ReadRoute = "virtualPortfolio" | "virtualPosition" | "virtualOrders" | "virtualFormula";
type WriteRoute = "virtualActivate" | "virtualBuy" | "virtualSell" | "virtualAmend" | "virtualCancel";

/** Restricted route vocabulary, also used by the deterministic API fixture tests. */
export interface VirtualIO {
  get(route: ReadRoute, options?: GetOptions): Promise<unknown>;
  post(route: WriteRoute, options?: GetOptions & { body?: unknown }): Promise<unknown>;
}
const http: VirtualIO = { get: getJson, post: postJson };

/** An explicit Stockbit application refusal, even when delivered as HTTP 200. */
class VirtualRejection extends StockbitError {}

function object(value: unknown, context: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StockbitError("schema_drift", `Unexpected virtual ${context} response: expected an object.`);
  }
  return value as Row;
}

/** Stockbit can return an application error in an HTTP 200 envelope. */
function data(body: unknown): unknown {
  const envelope = object(body, "API");
  if (envelope.error || envelope.error_type || envelope.success === false) {
    throw new VirtualRejection("invalid_param", String(envelope.message ?? "Stockbit rejected the virtual request."));
  }
  if (!("data" in envelope)) {
    throw new StockbitError("schema_drift", "Stockbit virtual response has no data field.");
  }
  return envelope.data;
}

function requireConfirm(confirm: boolean | undefined): void {
  if (confirm !== true) {
    throw new StockbitError("invalid_param", "Confirm the specific Stockbit virtual-account change before passing confirm: true.");
  }
}

export function virtualOrderBody(input: { price: number; lots: number }): {
  gtc: false; price: number; shares: number; tradeshare: false;
} {
  if (!Number.isSafeInteger(input.lots) || input.lots <= 0 || !Number.isSafeInteger(input.lots * 100)) {
    throw new StockbitError("invalid_param", "Virtual order lots must be a positive safe integer (100 shares per lot).");
  }
  if (!Number.isSafeInteger(input.price) || input.price <= 0 || !onTickGrid(input.price)) {
    throw new StockbitError("invalid_param", "Virtual order price must be a positive integer on the IDX tick grid.");
  }
  if (!Number.isSafeInteger(input.price * input.lots * 100)) {
    throw new StockbitError("invalid_param", "Virtual order notional exceeds safe integer precision.");
  }
  // These exact flags are in Stockbit's VIRTUAL_BUY/VIRTUAL_SELL UI. Social sharing is disabled.
  return { gtc: false, price: input.price, shares: input.lots * 100, tradeshare: false };
}

function id(value: unknown): string {
  const result = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(result)) {
    throw new StockbitError("invalid_param", "Expected a virtual order id from virtual_orders.");
  }
  return result;
}

function state(order: Row): string {
  return typeof order.status === "string" ? order.status.toUpperCase() : "";
}

function goodForDay(order: Row): boolean {
  return !!order.gtc && typeof order.gtc === "object" && (order.gtc as Row).enable === false;
}

/** The virtual web UI renders order.total in lots; request bodies use shares. */
function matchesOrder(rows: Row[], expected: { symbol: string; action: string; price: number; lots: number }): boolean {
  return rows.length > 0 && rows.every((row) =>
    row.symbol === expected.symbol && String(row.action).toLowerCase() === expected.action.toLowerCase() &&
    Number(row.price) === expected.price && goodForDay(row) &&
    ["OPEN", "PARTIAL", "READY", "MATCH", "REJECTED"].includes(state(row)) &&
    Number.isSafeInteger(Number(row.total)) && Number(row.total) > 0) &&
    rows.reduce((sum, row) => sum + Number(row.total), 0) === expected.lots;
}

async function orders(io: VirtualIO): Promise<Row[]> {
  const result = data(await io.get("virtualOrders"));
  if (!Array.isArray(result)) {
    throw new StockbitError("schema_drift", "Stockbit virtual order data is not an array.");
  }
  return result.map((row) => object(row, "order"));
}

export async function getVirtualPortfolio(io: VirtualIO = http) {
  const portfolio = object(data(await io.get("virtualPortfolio")), "portfolio");
  return { ...identity, summary: VIRTUAL_BANNER, portfolio };
}

export async function getVirtualPosition(symbol: string, io: VirtualIO = http) {
  symbol = normalizeSymbol(symbol);
  const value = data(await io.get("virtualPosition", { segments: { symbol } }));
  // Observed 2026-09-24: an unheld symbol answers 200 with data:null, while a held
  // symbol answers an object. Missing data is still schema drift, not an empty holding.
  const position = value === null ? null : object(value, "position");
  return { ...identity, summary: VIRTUAL_BANNER, symbol, found: position !== null, position };
}

export async function getVirtualOrders(io: VirtualIO = http) {
  return { ...identity, summary: VIRTUAL_BANNER, orders: await orders(io) };
}

export async function getVirtualConfig(io: VirtualIO = http) {
  const config = object(data(await io.get("virtualFormula")), "formula");
  // Never execute the formula strings supplied by Stockbit.
  return { ...identity, summary: VIRTUAL_BANNER, config };
}

export interface VirtualWriteResult {
  mode: "stockbit_virtual";
  source: string;
  outcome: "ok" | "rejected" | "unknown";
  message: string;
  receipt?: unknown;
  observed?: unknown;
  error?: string;
  errorKind?: string;
  status?: number;
}

/**
 * Exactly one write invocation, then a fresh read. No fallback or rollback. A failed
 * acknowledgement/read-back is uncertain, never an invitation to submit again.
 */
async function write(
  send: () => Promise<unknown>,
  verify: (receipt: unknown) => Promise<{ confirmed: boolean; rejected?: boolean; observed: unknown }>,
): Promise<VirtualWriteResult> {
  let receipt: unknown;
  let acknowledged = false;
  try {
    receipt = data(await send());
    acknowledged = true;
    const result = await verify(receipt);
    const outcome = result.rejected ? "rejected" : result.confirmed ? "ok" : "unknown";
    return {
      ...identity, outcome, receipt, observed: result.observed,
      message: `${VIRTUAL_BANNER} ` + (outcome === "ok"
        ? "Change confirmed by reading the Stockbit virtual account back. An order record does not imply a fill; inspect its status."
        : outcome === "rejected"
          ? "Stockbit recorded the virtual order as rejected. Inspect the returned order for its reason."
          : "The requested change could not be confirmed. Check virtual_orders and the Stockbit website before any new submission; do not automatically retry."),
    };
  } catch (error) {
    // A verification read can also fail with 4xx after a successful write, so the
    // rejected classification applies only before an acknowledgement was parsed.
    const rejected = !acknowledged && (error instanceof VirtualRejection || (
      error instanceof StockbitError && error.status !== undefined &&
      [400, 401, 403, 404, 409, 422].includes(error.status)
    ));
    return {
      ...identity, outcome: rejected ? "rejected" : "unknown", receipt,
      error: redact(String(error)),
      ...(error instanceof StockbitError ? { errorKind: error.kind, status: error.status } : {}),
      message: `${VIRTUAL_BANNER} ` + (rejected
        ? "Stockbit refused the virtual request. Read the returned error and resolve its cause before a new submission; do not automatically retry."
        : "The virtual request outcome is unknown. Read virtual_orders and the Stockbit website before any new submission; do not automatically retry."),
    };
  }
}

export async function activateVirtualAccount(confirm: boolean, io: VirtualIO = http): Promise<VirtualWriteResult> {
  requireConfirm(confirm);
  return write(() => io.post("virtualActivate"), async () => {
    const observed = await getVirtualPortfolio(io);
    return { confirmed: true, observed };
  });
}

function receiptIds(receipt: unknown): string[] {
  const row = object(receipt, "order receipt");
  const values = row.order_id !== undefined ? [row.order_id] : row.order_ids;
  if (!Array.isArray(values) || !values.length) {
    throw new StockbitError("schema_drift", "Virtual order acknowledgement has no order id.");
  }
  const ids = values.map(id);
  if (new Set(ids).size !== ids.length) {
    throw new StockbitError("schema_drift", "Virtual order acknowledgement repeats an order id.");
  }
  return ids;
}

export async function placeVirtualOrder(input: {
  symbol: string; action: "buy" | "sell"; price: number; lots: number; confirm: boolean;
}, io: VirtualIO = http): Promise<VirtualWriteResult> {
  requireConfirm(input.confirm);
  const symbol = normalizeSymbol(input.symbol);
  if (input.action !== "buy" && input.action !== "sell") {
    throw new StockbitError("invalid_param", "Virtual action must be buy or sell.");
  }
  const body = virtualOrderBody(input);
  const before = new Set((await orders(io)).map((row) => String(row.id)));
  return write(
    () => io.post(input.action === "buy" ? "virtualBuy" : "virtualSell", { segments: { symbol }, body }),
    async (receipt) => {
      const ids = receiptIds(receipt);
      const after = await orders(io);
      const observed = after.filter((row) => ids.includes(String(row.id)));
      const confirmed = observed.length === ids.length && ids.every((value) => !before.has(value)) &&
        matchesOrder(observed, { ...input, symbol });
      return { confirmed, rejected: confirmed && observed.some((row) => state(row) === "REJECTED"), observed };
    },
  );
}

/** Amend/cancel only a currently open order actually returned by the virtual API. */
async function openOrder(orderId: string, io: VirtualIO): Promise<{ order: Row; before: Row[] }> {
  const before = await orders(io);
  const match = before.find((row) => String(row.id) === orderId);
  if (!match || !["OPEN", "PARTIAL", "READY"].includes(state(match))) {
    throw new StockbitError("invalid_param", "The virtual order is absent or no longer open. Refresh virtual_orders.");
  }
  if (!goodForDay(match)) {
    throw new StockbitError("invalid_param", "Only verified good-for-day virtual orders are supported by this tool.");
  }
  return { order: match, before };
}

export async function amendVirtualOrder(input: {
  orderId: string; symbol: string; price: number; lots: number; confirm: boolean;
}, io: VirtualIO = http): Promise<VirtualWriteResult> {
  requireConfirm(input.confirm);
  const orderId = id(input.orderId);
  const symbol = normalizeSymbol(input.symbol);
  const { gtc, price, shares } = virtualOrderBody(input);
  const { order: original, before } = await openOrder(orderId, io);
  if (original.symbol !== symbol) throw new StockbitError("invalid_param", "The symbol does not match that virtual order.");
  return write(() => io.post("virtualAmend", { body: { gtc, order_id: orderId, price, shares, symbol } }), async (receipt) => {
    const ids = receiptIds(receipt);
    const after = await orders(io);
    const observed = after.filter((row) => ids.includes(String(row.id)));
    const lineage = ids.length === 1 && (ids[0] === orderId || (
      !before.some((row) => String(row.id) === ids[0]) &&
      after.some((row) => String(row.id) === orderId && state(row) === "AMENDED")
    ));
    const confirmed = lineage && observed.length === ids.length &&
      matchesOrder(observed, { ...input, symbol, action: String(original.action) });
    return { confirmed, rejected: confirmed && observed.some((row) => state(row) === "REJECTED"), observed };
  });
}

export async function cancelVirtualOrder(input: {
  orderId: string; confirm: boolean;
}, io: VirtualIO = http): Promise<VirtualWriteResult> {
  requireConfirm(input.confirm);
  const orderId = id(input.orderId);
  await openOrder(orderId, io);
  return write(() => io.post("virtualCancel", { body: { order_id: orderId, gtc: false } }), async () => {
    const observed = (await orders(io)).find((row) => String(row.id) === orderId) ?? null;
    // Disappearance alone is not proof of cancellation: it may have filled or expired.
    return { confirmed: observed !== null && state(observed) === "WITHDRAWN", observed };
  });
}
