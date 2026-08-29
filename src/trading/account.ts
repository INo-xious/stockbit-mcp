/**
 * The trading account, read-only: positions, cash, open orders, history, fees, who the account is.
 *
 * ## This module projects, and it never passes a row through
 *
 * Every other family in this codebase does the opposite. `src/core/brokers.ts` returns each raw row
 * beside the one or two fields it is willing to claim it recognised, because on market data an
 * unmapped field is a metric nobody has named yet and hiding it loses information.
 *
 * On carina an unmapped field is as likely to be an account number, a customer ID or a name. A tool
 * result is text a model relays — into a transcript, a summary, whatever the client does with it —
 * so the rule inverts: nothing leaves here that was not explicitly recognised and named.
 *
 * What replaces the raw row is `unmappedKeys`: the NAMES of the keys this projection did not
 * consume, with their values dropped. That keeps the drift signal a raw row was giving us — a
 * response whose shape changed shows up as a pile of unknown key names next to undefined fields —
 * without carrying the values across the boundary. Key names are wire vocabulary; values are the
 * user's money.
 *
 * ## Nothing here has been observed live
 *
 * The securities session needs a PIN this project never stores, so no capture of these responses
 * exists. Every candidate key list below is read off Stockbit's bundle and off the shape of the
 * neighbouring APIs, and `readFrom` names the key each value actually came from on the response in
 * hand. A field this projection could not read is `undefined` with its name absent from `readFrom`
 * — never a zero, never a silent default. `docs/PENDING-VERIFICATION.md` carries the list.
 *
 * The one guess that could be wrong *quietly* is lots vs shares: 1 lot = 100 shares, and a figure
 * read out of the wrong key is off by exactly 100×, which still looks like a plausible position.
 * So each is reported only from a key whose name says which it is, and the other is derived only
 * when it can be, with `derived` naming what was computed rather than read.
 *
 * ## Two doors onto the order list
 *
 * `listOrders()` is cached and projected, for a caller asking what is open. `listOrdersRaw()` is
 * uncached and unprojected, for the order write path's before/after snapshot. They are separate
 * entry points on purpose — ADR-0003's most expensive lesson was a truncating display accessor
 * being reused as the input to a byte-exact operation, which made every real chart look empty.
 * `listOrdersRaw` is internal: no tool returns it, and `test/trading-account.test.ts` asserts that.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { cached, parseOr } from "../core/_util.js";
import { normalizeSymbol } from "../symbol.js";

/* ----------------------------------- caching ----------------------------------- */

/**
 * Account TTLs are short for a different reason than the market-data ones.
 *
 * There, a cache saves requests on numbers that move every few seconds anyway. Here, a stale answer
 * is a correctness problem: a position that was sold thirty seconds ago, reported as held, is the
 * input to a decision. The cache exists only to stop one tool call that reads the portfolio three
 * times from making three requests — hence seconds, not minutes.
 *
 * `account` and the fee schedule are the exceptions: they change when the user opens an account or
 * renegotiates a rate, not during a session.
 */
const TTL = {
  position: 5_000,
  orders: 3_000,
  history: 30_000,
  tradable: 60_000,
  identity: 300_000,
  fees: 300_000,
} as const;

/* ---------------------------------- envelopes ---------------------------------- */

type Row = Record<string, unknown>;

const Envelope = z.object({ data: z.unknown() }).passthrough();

/** Where the payload was found, so a shape change is visible in the result rather than inferred. */
export type EnvelopePath = "data" | "data.data";

interface Payload {
  value: unknown;
  from: EnvelopePath;
}

/**
 * Peel the response envelope.
 *
 * Stockbit is inconsistent about `{data: X}` versus `{data: {data: X}}` across services — the
 * Chartbit charts API uses the doubled form, the market-data ones mostly do not — and carina has
 * not been observed. Both are accepted and the one that was taken is reported.
 */
function payloadOf(body: unknown, context: string): Payload {
  const outer = parseOr(Envelope, body, context).data;
  if (outer !== null && typeof outer === "object" && !Array.isArray(outer) && "data" in (outer as Row)) {
    return { value: (outer as Row).data, from: "data.data" };
  }
  return { value: outer ?? null, from: "data" };
}

/** Keys that plausibly wrap the rows, tried in order before falling back to any array present. */
const ROW_CONTAINERS = [
  "list",
  "result",
  "results",
  "items",
  "rows",
  "records",
  "portfolio",
  "positions",
  "orders",
  "histories",
  "history",
  "data",
] as const;

interface Rowset {
  rows: Row[];
  /** The key the rows came out of; null when the payload carried no array at all. */
  from: string | null;
  /** The payload's own key names, so `from: null` can be told apart from an empty list. */
  payloadKeys: string[];
}

const RowArray = z.array(z.record(z.unknown()));

function rowsOf(payload: unknown, context: string): Rowset {
  if (payload === null || payload === undefined) return { rows: [], from: null, payloadKeys: [] };
  if (Array.isArray(payload)) {
    return { rows: parseOr(RowArray, payload, `${context} rows`), from: "(root)", payloadKeys: [] };
  }
  if (typeof payload === "object") {
    const obj = payload as Row;
    const payloadKeys = Object.keys(obj);
    const key =
      ROW_CONTAINERS.find((k) => Array.isArray(obj[k])) ?? payloadKeys.find((k) => Array.isArray(obj[k]));
    if (key === undefined) return { rows: [], from: null, payloadKeys };
    return { rows: parseOr(RowArray, obj[key], `${context} rows`), from: key, payloadKeys };
  }
  throw new StockbitError(
    "schema_drift",
    `Unexpected ${context} response shape (payload was ${typeof payload}, expected an object or an array)`,
  );
}

/** A single object payload, for the endpoints that answer with one record rather than a list. */
function objectOf(payload: unknown, context: string): Row {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) return payload as Row;
  throw new StockbitError(
    "schema_drift",
    `Unexpected ${context} response shape (payload was ${Array.isArray(payload) ? "an array" : typeof payload}, expected an object)`,
  );
}

/* ------------------------------- field projection ------------------------------- */

/**
 * A number off the wire.
 *
 * A digit string is accepted; a separated one ("1,234.56" or "1.234,56") is REFUSED rather than
 * guessed at. The two Indonesian conventions disagree about which separator is the decimal one, and
 * a money figure parsed under the wrong one is off by a factor of a thousand while still looking
 * like money. Refusing leaves the field undefined and its key in `unmappedKeys`, which is a
 * question the user can answer; a mis-scaled rupiah figure is not.
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

/** A non-empty string off the wire. Numbers are accepted for the id-shaped fields. */
function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Which wire key each projected field was read from. A field absent here was not on the row. */
export type ReadFrom = Record<string, string>;

/**
 * Read a row against a candidate-key map, one field at a time.
 *
 * Returns the values it recognised, the key each came from, and the names of every key it did not
 * consume. The values of unconsumed keys are deliberately discarded here — see the module note.
 */
function project<K extends string>(
  row: Row,
  spec: Record<K, { keys: readonly string[]; as: (v: unknown) => unknown }>,
): { fields: Partial<Record<K, unknown>>; readFrom: ReadFrom; unmappedKeys: string[] } {
  const fields: Partial<Record<K, unknown>> = {};
  const readFrom: ReadFrom = {};
  const consumed = new Set<string>();

  for (const field of Object.keys(spec) as K[]) {
    const { keys, as } = spec[field];
    for (const key of keys) {
      if (!(key in row)) continue;
      const value = as(row[key]);
      if (value === undefined) continue;
      fields[field] = value;
      readFrom[field] = key;
      consumed.add(key);
      break;
    }
  }

  const unmappedKeys = Object.keys(row).filter((k) => !consumed.has(k));
  return { fields, readFrom, unmappedKeys };
}

/* ---------------------------------- masking ---------------------------------- */

/**
 * A person's name, reduced to initials.
 *
 * Enough for the user to recognise their own account; not enough to be a name in a transcript. The
 * account holder already knows who they are, and no answer this server gives is improved by the
 * model having read the name.
 */
export function maskName(value: string): string {
  const initials = value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}.`);
  return initials.length ? initials.join(" ") : "(masked)";
}

/**
 * An account, RDN or SID number, reduced to its last four characters.
 *
 * Four is what a bank prints on a statement for the same reason: it distinguishes the user's own
 * accounts from each other without being the number. The bullets are a fixed count, so the length
 * of the original is not disclosed either.
 */
export function maskIdentifier(value: string): string {
  const compact = value.replace(/\s+/g, "");
  const tail = compact.slice(-4);
  return tail ? `••••${tail}` : "(masked)";
}

/* --------------------------------- portfolio --------------------------------- */

export interface Holding {
  symbol?: string;
  /** Reported only from a key whose name says "lot". Otherwise derived from shares — see `derived`. */
  lots?: number;
  /** Likewise, reported only from a share-shaped key. */
  shares?: number;
  availableLots?: number;
  availableShares?: number;
  averagePrice?: number;
  lastPrice?: number;
  marketValueIdr?: number;
  costIdr?: number;
  unrealizedPnlIdr?: number;
  unrealizedPnlPct?: number;
  /** Fields computed here rather than read off the wire. `["shares"]` means shares = lots × 100. */
  derived?: string[];
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

const SHARES_PER_LOT = 100;

const HOLDING_SPEC = {
  symbol: { keys: ["symbol", "stock_code", "stockCode", "code", "ticker"], as: asText },
  lots: { keys: ["lot", "lots", "total_lot", "totalLot", "lot_balance", "balance_lot"], as: asNumber },
  shares: {
    keys: ["shares", "share", "balance", "total_balance", "quantity", "qty", "volume"],
    as: asNumber,
  },
  availableLots: { keys: ["available_lot", "availableLot", "sellable_lot", "lot_available"], as: asNumber },
  availableShares: {
    keys: ["available_balance", "available_shares", "availableBalance", "sellable", "available"],
    as: asNumber,
  },
  averagePrice: {
    keys: ["average_price", "avg_price", "avgPrice", "averagePrice", "price_avg", "buy_average"],
    as: asNumber,
  },
  lastPrice: {
    keys: ["last_price", "lastPrice", "market_price", "marketPrice", "close_price", "last"],
    as: asNumber,
  },
  marketValueIdr: { keys: ["market_value", "marketValue", "current_value", "value"], as: asNumber },
  costIdr: { keys: ["total_cost", "cost", "investment_value", "buy_value", "average_value"], as: asNumber },
  unrealizedPnlIdr: {
    keys: ["unrealized_pnl", "unrealized_pl", "potential_gain", "gain_loss", "profit_loss", "pl"],
    as: asNumber,
  },
  unrealizedPnlPct: {
    keys: [
      "unrealized_pnl_percent",
      "unrealized_pl_percent",
      "gain_loss_percent",
      "profit_loss_percent",
      "pl_percent",
      "percentage",
    ],
    as: asNumber,
  },
} as const;

function projectHolding(row: Row): Holding {
  const { fields, readFrom, unmappedKeys } = project(row, HOLDING_SPEC);
  const holding: Holding = { ...(fields as Omit<Holding, "readFrom" | "unmappedKeys">), readFrom, unmappedKeys };

  // The 100× field. Deriving is safe in one direction only: whichever was read keeps its name, and
  // the computed one is announced so a reader can discount it.
  const derived: string[] = [];
  if (holding.lots === undefined && holding.shares !== undefined && holding.shares % SHARES_PER_LOT === 0) {
    holding.lots = holding.shares / SHARES_PER_LOT;
    derived.push("lots");
  } else if (holding.shares === undefined && holding.lots !== undefined) {
    holding.shares = holding.lots * SHARES_PER_LOT;
    derived.push("shares");
  }
  if (
    holding.availableLots === undefined &&
    holding.availableShares !== undefined &&
    holding.availableShares % SHARES_PER_LOT === 0
  ) {
    holding.availableLots = holding.availableShares / SHARES_PER_LOT;
    derived.push("availableLots");
  } else if (holding.availableShares === undefined && holding.availableLots !== undefined) {
    holding.availableShares = holding.availableLots * SHARES_PER_LOT;
    derived.push("availableShares");
  }
  if (derived.length) holding.derived = derived;
  return holding;
}

export interface PortfolioTotals {
  marketValueIdr?: number;
  costIdr?: number;
  unrealizedPnlIdr?: number;
  unrealizedPnlPct?: number;
  realizedPnlIdr?: number;
  cashIdr?: number;
  totalEquityIdr?: number;
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

const TOTALS_SPEC = {
  marketValueIdr: {
    keys: ["market_value", "marketValue", "total_market_value", "stock_value", "current_value"],
    as: asNumber,
  },
  costIdr: { keys: ["total_cost", "investment_value", "cost", "buy_value"], as: asNumber },
  unrealizedPnlIdr: {
    keys: ["unrealized_pnl", "unrealized_pl", "potential_gain", "gain_loss", "profit_loss"],
    as: asNumber,
  },
  unrealizedPnlPct: {
    keys: ["unrealized_pnl_percent", "gain_loss_percent", "profit_loss_percent", "percentage"],
    as: asNumber,
  },
  realizedPnlIdr: { keys: ["realized_pnl", "realized_pl", "realized_gain"], as: asNumber },
  cashIdr: { keys: ["cash", "cash_balance", "total_cash", "cash_on_hand"], as: asNumber },
  totalEquityIdr: { keys: ["total_equity", "totalEquity", "net_asset_value", "total_asset"], as: asNumber },
} as const;

export interface Portfolio {
  holdings: Holding[];
  /** Present when `/portfolio/v2/summary` answered; the summary is fetched alongside the list. */
  totals?: PortfolioTotals;
  /** Why `totals` is absent, when it is. A summary failure never fails the whole read. */
  totalsUnavailable?: string;
  count: number;
  rowsFrom: string | null;
  envelope: EnvelopePath;
  payloadKeys: string[];
}

/**
 * The whole portfolio: every holding, plus the account-level totals when they can be had.
 *
 * The summary is a second request and it is allowed to fail on its own. A user asking what they
 * hold is answered by the list; refusing to answer at all because the totals endpoint was down
 * would be the wrong trade.
 */
export async function getPortfolio(): Promise<Portfolio> {
  return cached("carina:portfolio", TTL.position, async () => {
    const body = await getJson("portfolioList");
    const payload = payloadOf(body, "portfolio");
    const { rows, from, payloadKeys } = rowsOf(payload.value, "portfolio");

    let totals: PortfolioTotals | undefined;
    let totalsUnavailable: string | undefined;
    try {
      totals = await getPortfolioTotals();
    } catch (err) {
      totalsUnavailable = err instanceof StockbitError ? err.message : String(err);
    }

    return {
      holdings: rows.map(projectHolding),
      ...(totals ? { totals } : {}),
      ...(totalsUnavailable ? { totalsUnavailable } : {}),
      count: rows.length,
      rowsFrom: from,
      envelope: payload.from,
      payloadKeys,
    };
  });
}

/** The account-level totals on their own. Separate so a caller that only needs them pays for one request. */
async function getPortfolioTotals(): Promise<PortfolioTotals> {
  return cached("carina:portfolio:summary", TTL.position, async () => {
    const body = await getJson("portfolioSummary");
    const payload = payloadOf(body, "portfolio summary");
    const row = objectOf(payload.value, "portfolio summary");
    const { fields, readFrom, unmappedKeys } = project(row, TOTALS_SPEC);
    return { ...(fields as Omit<PortfolioTotals, "readFrom" | "unmappedKeys">), readFrom, unmappedKeys };
  });
}

export interface Position {
  symbol: string;
  /** Null when the account holds none of this symbol — a normal answer, not an error. */
  holding: Holding | null;
  envelope: EnvelopePath;
  payloadKeys: string[];
}

/**
 * One symbol's position.
 *
 * A 404 is translated into `holding: null` rather than thrown: "you do not own PGAS" is the answer
 * to the question, and a caller that has to catch an error to learn it will report it as a failure.
 */
export async function getPosition(symbol: string): Promise<Position> {
  const sym = normalizeSymbol(symbol);
  return cached(`carina:position:${sym}`, TTL.position, async () => {
    let body: unknown;
    try {
      body = await getJson("portfolioDetail", { params: { stock_code: sym } });
    } catch (err) {
      if (err instanceof StockbitError && err.kind === "not_found") {
        return { symbol: sym, holding: null, envelope: "data" as const, payloadKeys: [] };
      }
      throw err;
    }
    const payload = payloadOf(body, "position");
    if (payload.value === null || payload.value === undefined) {
      return { symbol: sym, holding: null, envelope: payload.from, payloadKeys: [] };
    }
    // The detail route may answer with the record itself or with a one-element list of them.
    if (Array.isArray(payload.value)) {
      const rows = parseOr(RowArray, payload.value, "position rows");
      return {
        symbol: sym,
        holding: rows.length ? projectHolding(rows[0]) : null,
        envelope: payload.from,
        payloadKeys: [],
      };
    }
    const row = objectOf(payload.value, "position");
    return { symbol: sym, holding: projectHolding(row), envelope: payload.from, payloadKeys: Object.keys(row) };
  });
}

/* ------------------------------------ cash ------------------------------------ */

export interface CashBalance {
  cashIdr?: number;
  buyingPowerIdr?: number;
  withdrawableIdr?: number;
  /** Settlement buckets, when `/balance/cash/info` carried them. */
  settlement?: { t0Idr?: number; t1Idr?: number; t2Idr?: number; readFrom: ReadFrom; unmappedKeys: string[] };
  settlementUnavailable?: string;
  readFrom: ReadFrom;
  unmappedKeys: string[];
  envelope: EnvelopePath;
}

const CASH_SPEC = {
  cashIdr: { keys: ["cash", "cash_balance", "cash_on_hand", "balance", "total_cash"], as: asNumber },
  buyingPowerIdr: {
    keys: ["buying_power", "buyingPower", "trading_limit", "tradingLimit", "purchasing_power", "limit"],
    as: asNumber,
  },
  withdrawableIdr: {
    keys: ["withdrawable", "cash_withdrawable", "available_withdrawal", "withdrawal_limit", "available_cash"],
    as: asNumber,
  },
} as const;

const SETTLEMENT_SPEC = {
  t0Idr: { keys: ["t0", "t_0", "settlement_t0", "t0_amount"], as: asNumber },
  t1Idr: { keys: ["t1", "t_1", "settlement_t1", "t1_amount"], as: asNumber },
  t2Idr: { keys: ["t2", "t_2", "settlement_t2", "t2_amount"], as: asNumber },
} as const;

/**
 * Cash, and the settlement breakdown when it is available.
 *
 * `buyingPowerIdr` is the number an order preview checks affordability against, and it is NOT the
 * same as cash: Indonesian retail accounts routinely carry a trading limit above their balance.
 * Reporting cash where buying power was meant is the kind of error that only shows up when an order
 * is rejected, so they are separate fields and neither substitutes for the other.
 */
export async function getCashBalance(): Promise<CashBalance> {
  return cached("carina:cash", TTL.position, async () => {
    const body = await getJson("balanceCash");
    const payload = payloadOf(body, "cash balance");
    const row = objectOf(payload.value, "cash balance");
    const { fields, readFrom, unmappedKeys } = project(row, CASH_SPEC);

    let settlement: CashBalance["settlement"];
    let settlementUnavailable: string | undefined;
    try {
      const infoBody = await getJson("balanceCashInfo");
      const infoPayload = payloadOf(infoBody, "cash info");
      const infoRow = objectOf(infoPayload.value, "cash info");
      const info = project(infoRow, SETTLEMENT_SPEC);
      settlement = {
        ...(info.fields as { t0Idr?: number; t1Idr?: number; t2Idr?: number }),
        readFrom: info.readFrom,
        unmappedKeys: info.unmappedKeys,
      };
    } catch (err) {
      settlementUnavailable = err instanceof StockbitError ? err.message : String(err);
    }

    return {
      ...(fields as { cashIdr?: number; buyingPowerIdr?: number; withdrawableIdr?: number }),
      ...(settlement ? { settlement } : {}),
      ...(settlementUnavailable ? { settlementUnavailable } : {}),
      readFrom,
      unmappedKeys,
      envelope: payload.from,
    };
  });
}

/* ----------------------------------- orders ----------------------------------- */

export interface Order {
  orderId?: string;
  symbol?: string;
  /** Normalised to buy/sell when the wire value said so; `sideRaw` keeps what it actually said. */
  side?: "buy" | "sell";
  sideRaw?: string;
  status?: string;
  price?: number;
  lots?: number;
  shares?: number;
  filledShares?: number;
  remainingShares?: number;
  createdAt?: string;
  uiRef?: string;
  derived?: string[];
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

const ORDER_SPEC = {
  orderId: { keys: ["order_id", "orderId", "id", "order_number", "orderNumber"], as: asText },
  symbol: { keys: ["symbol", "stock_code", "stockCode", "code", "ticker"], as: asText },
  sideRaw: { keys: ["action", "side", "buy_sell", "order_action", "type", "order_type"], as: asText },
  status: { keys: ["status", "order_status", "state", "status_name"], as: asText },
  price: { keys: ["price", "order_price", "limit_price"], as: asNumber },
  lots: { keys: ["lot", "lots", "order_lot", "total_lot"], as: asNumber },
  shares: { keys: ["shares", "share", "amount", "quantity", "qty", "volume"], as: asNumber },
  filledShares: {
    keys: ["filled", "filled_shares", "done", "matched", "match_amount", "traded"],
    as: asNumber,
  },
  remainingShares: { keys: ["remaining", "remaining_shares", "open_amount", "outstanding"], as: asNumber },
  createdAt: { keys: ["created_at", "createdAt", "order_time", "order_date", "time", "date"], as: asText },
  uiRef: { keys: ["ui_ref", "uiRef"], as: asText },
} as const;

/** Read buy/sell out of whatever word the wire used, and only when it actually says one of them. */
function sideOf(raw: string | undefined): "buy" | "sell" | undefined {
  if (!raw) return undefined;
  const token = raw.trim().toLowerCase();
  if (/(^|[^a-z])buy([^a-z]|$)|^b$|beli/.test(token)) return "buy";
  if (/(^|[^a-z])sell([^a-z]|$)|^s$|jual/.test(token)) return "sell";
  return undefined;
}

function projectOrder(row: Row): Order {
  const { fields, readFrom, unmappedKeys } = project(row, ORDER_SPEC);
  const order: Order = { ...(fields as Omit<Order, "readFrom" | "unmappedKeys">), readFrom, unmappedKeys };
  const side = sideOf(order.sideRaw);
  if (side) order.side = side;

  const derived: string[] = [];
  if (order.shares === undefined && order.lots !== undefined) {
    order.shares = order.lots * SHARES_PER_LOT;
    derived.push("shares");
  } else if (order.lots === undefined && order.shares !== undefined && order.shares % SHARES_PER_LOT === 0) {
    order.lots = order.shares / SHARES_PER_LOT;
    derived.push("lots");
  }
  if (derived.length) order.derived = derived;
  return order;
}

export interface OrderList {
  orders: Order[];
  count: number;
  rowsFrom: string | null;
  envelope: EnvelopePath;
  payloadKeys: string[];
  /** Exactly what was sent, so the filter behind the rows is always visible. */
  request: { stockCode?: string };
}

/**
 * The order list, projected and briefly cached.
 *
 * `filter_criteria.stock_code` is the parameter name Stockbit's own client sends — a dotted key,
 * not a nested object. It is passed through the transport's query builder verbatim.
 */
export async function listOrders(opts: { symbol?: string } = {}): Promise<OrderList> {
  const stockCode = opts.symbol ? normalizeSymbol(opts.symbol) : undefined;
  return cached(`carina:orders:${stockCode ?? "all"}`, TTL.orders, async () => {
    const body = await listOrdersRaw({ stockCode });
    return { ...readOrderList(body), request: { ...(stockCode ? { stockCode } : {}) } };
  });
}

/**
 * Project an already-fetched order list. Pure, so the write path can read its own snapshot with the
 * same projection the display tool uses instead of inventing a second one.
 */
export function readOrderList(body: unknown): Omit<OrderList, "request"> {
  const payload = payloadOf(body, "orders");
  const { rows, from, payloadKeys } = rowsOf(payload.value, "orders");
  return {
    orders: rows.map(projectOrder),
    count: rows.length,
    rowsFrom: from,
    envelope: payload.from,
    payloadKeys,
  };
}

/**
 * The order list, raw and uncached — the write path's snapshot.
 *
 * INTERNAL. This returns the response body unprojected, which means it may contain fields nothing
 * has inspected. It exists so `placeOrder`'s before/after comparison sees exactly what the server
 * said, including whatever key the new order is identified by. No tool returns this value, and a
 * guard test asserts that no module under `src/tools/` imports it.
 */
export async function listOrdersRaw(opts: { stockCode?: string } = {}): Promise<unknown> {
  return getJson("orderList", {
    params: opts.stockCode ? { "filter_criteria.stock_code": opts.stockCode } : {},
  });
}

export interface OrderDetail {
  orderId: string;
  order: Order | null;
  envelope: EnvelopePath;
  /**
   * PENDING VERIFICATION: `order_id` is the parameter name this sends. The bundle shows the route
   * but not the key, and a wrong key most likely returns the whole list or a 400 rather than the
   * wrong order — visible either way, which is why it is sent rather than refused.
   */
  request: { order_id: string };
}

/** One order in full. */
export async function getOrderDetail(orderId: string): Promise<OrderDetail> {
  const id = orderId.trim();
  if (!id) throw new StockbitError("invalid_param", "An order id is required.");
  return cached(`carina:order:${id}`, TTL.orders, async () => {
    const body = await getJson("orderDetail", { params: { order_id: id } });
    const payload = payloadOf(body, "order detail");
    if (payload.value === null || payload.value === undefined) {
      return { orderId: id, order: null, envelope: payload.from, request: { order_id: id } };
    }
    if (Array.isArray(payload.value)) {
      const rows = parseOr(RowArray, payload.value, "order detail rows");
      return {
        orderId: id,
        order: rows.length ? projectOrder(rows[0]) : null,
        envelope: payload.from,
        request: { order_id: id },
      };
    }
    return {
      orderId: id,
      order: projectOrder(objectOf(payload.value, "order detail")),
      envelope: payload.from,
      request: { order_id: id },
    };
  });
}

/* ----------------------------------- history ----------------------------------- */

export interface TradeRow {
  orderId?: string;
  symbol?: string;
  side?: "buy" | "sell";
  sideRaw?: string;
  price?: number;
  shares?: number;
  lots?: number;
  valueIdr?: number;
  feeIdr?: number;
  date?: string;
  status?: string;
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

const TRADE_SPEC = {
  orderId: { keys: ["order_id", "orderId", "id", "trade_id"], as: asText },
  symbol: { keys: ["symbol", "stock_code", "stockCode", "code"], as: asText },
  sideRaw: { keys: ["action", "side", "buy_sell", "type", "order_type", "transaction_type"], as: asText },
  price: { keys: ["price", "average_price", "match_price", "done_price"], as: asNumber },
  shares: { keys: ["shares", "amount", "quantity", "qty", "volume"], as: asNumber },
  lots: { keys: ["lot", "lots", "total_lot"], as: asNumber },
  valueIdr: { keys: ["value", "total_value", "amount_idr", "net_value", "gross_value"], as: asNumber },
  feeIdr: { keys: ["fee", "total_fee", "commission", "fees"], as: asNumber },
  date: { keys: ["date", "trade_date", "created_at", "createdAt", "time", "transaction_date"], as: asText },
  status: { keys: ["status", "state", "status_name"], as: asText },
} as const;

function projectTrade(row: Row): TradeRow {
  const { fields, readFrom, unmappedKeys } = project(row, TRADE_SPEC);
  const trade: TradeRow = { ...(fields as Omit<TradeRow, "readFrom" | "unmappedKeys">), readFrom, unmappedKeys };
  const side = sideOf(trade.sideRaw);
  if (side) trade.side = side;
  return trade;
}

export interface HistoryPage {
  trades: TradeRow[];
  count: number;
  rowsFrom: string | null;
  envelope: EnvelopePath;
  payloadKeys: string[];
  request: Record<string, string | number>;
}

export interface HistoryOptions {
  symbol?: string;
  /** Sent verbatim. The accepted vocabulary is not known, so it is not validated against a list. */
  period?: string;
  page?: number;
  limit?: number;
}

/**
 * Executed trades.
 *
 * `stockCode` is camelCase on this route and snake_case on the order list — that is Stockbit's
 * spelling, not a transcription slip, and it is the sort of thing that turns a filtered read into
 * an unfiltered one silently. `request` echoes what was actually sent so the filter is visible.
 */
export async function getTradeHistory(opts: HistoryOptions = {}): Promise<HistoryPage> {
  const params: Record<string, string | number> = {};
  if (opts.symbol) params.stockCode = normalizeSymbol(opts.symbol);
  if (opts.period) params.period = opts.period;
  if (opts.page !== undefined) params.page = requirePositiveInt(opts.page, "page");
  if (opts.limit !== undefined) params.limit = requirePositiveInt(opts.limit, "limit");

  return cached(`carina:history:${JSON.stringify(params)}`, TTL.history, async () => {
    const body = await getJson("historyList", { params });
    const payload = payloadOf(body, "trade history");
    const { rows, from, payloadKeys } = rowsOf(payload.value, "trade history");
    return {
      trades: rows.map(projectTrade),
      count: rows.length,
      rowsFrom: from,
      envelope: payload.from,
      payloadKeys,
      request: params,
    };
  });
}

export interface RealizedRow {
  symbol?: string;
  realizedPnlIdr?: number;
  realizedPnlPct?: number;
  buyValueIdr?: number;
  sellValueIdr?: number;
  shares?: number;
  lots?: number;
  date?: string;
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

const REALIZED_SPEC = {
  symbol: { keys: ["symbol", "stock_code", "stockCode", "code"], as: asText },
  realizedPnlIdr: {
    keys: ["realized_pnl", "realized_pl", "realized_gain", "profit_loss", "gain_loss", "pl"],
    as: asNumber,
  },
  realizedPnlPct: {
    keys: ["realized_pnl_percent", "profit_loss_percent", "gain_loss_percent", "percentage"],
    as: asNumber,
  },
  buyValueIdr: { keys: ["buy_value", "total_buy", "cost", "buy_amount"], as: asNumber },
  sellValueIdr: { keys: ["sell_value", "total_sell", "proceeds", "sell_amount"], as: asNumber },
  shares: { keys: ["shares", "amount", "quantity", "qty", "volume"], as: asNumber },
  lots: { keys: ["lot", "lots", "total_lot"], as: asNumber },
  date: { keys: ["date", "sell_date", "closed_at", "created_at", "time"], as: asText },
} as const;

export interface RealizedPage {
  rows: RealizedRow[];
  count: number;
  rowsFrom: string | null;
  envelope: EnvelopePath;
  payloadKeys: string[];
  request: Record<string, string | number>;
}

/** Closed positions and what they actually made. */
export async function getRealizedHistory(opts: HistoryOptions = {}): Promise<RealizedPage> {
  const params: Record<string, string | number> = {};
  if (opts.symbol) params.stockCode = normalizeSymbol(opts.symbol);
  if (opts.period) params.period = opts.period;
  if (opts.page !== undefined) params.page = requirePositiveInt(opts.page, "page");
  if (opts.limit !== undefined) params.limit = requirePositiveInt(opts.limit, "limit");

  return cached(`carina:realized:${JSON.stringify(params)}`, TTL.history, async () => {
    const body = await getJson("historyRealized", { params });
    const payload = payloadOf(body, "realized history");
    const { rows, from, payloadKeys } = rowsOf(payload.value, "realized history");
    return {
      rows: rows.map((row) => {
        const { fields, readFrom, unmappedKeys } = project(row, REALIZED_SPEC);
        return { ...(fields as Omit<RealizedRow, "readFrom" | "unmappedKeys">), readFrom, unmappedKeys };
      }),
      count: rows.length,
      rowsFrom: from,
      envelope: payload.from,
      payloadKeys,
      request: params,
    };
  });
}

function requirePositiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new StockbitError("invalid_param", `${field} must be a positive integer, got ${value}`);
  }
  return value;
}

/* --------------------------------- performance --------------------------------- */

/**
 * The four series `/history/performance/portfolio/:kind` serves.
 *
 * A closed list because it is a path segment: an unrecognised value would be a request for a URL
 * this project never meant to reach, which is exactly what ADR-0002's route table exists to stop.
 */
export const PERFORMANCE_KINDS = [
  "total-equity",
  "total-equity-return",
  "stock-allocation",
  "cumulative-return",
] as const;
export type PerformanceKind = (typeof PERFORMANCE_KINDS)[number];

export interface Performance {
  kind: PerformanceKind | "trade";
  /**
   * The payload, projected only where it is a list of points this module recognises; otherwise the
   * shape is reported and the numbers are left out rather than renamed. Performance series carry no
   * identifiers, so this one is safe to describe structurally.
   */
  points: Array<{ label?: string; value?: number; readFrom: ReadFrom; unmappedKeys: string[] }>;
  count: number;
  rowsFrom: string | null;
  envelope: EnvelopePath;
  payloadKeys: string[];
}

const POINT_SPEC = {
  label: { keys: ["date", "label", "time", "period", "name", "symbol"], as: asText },
  value: { keys: ["value", "amount", "percentage", "percent", "equity", "return", "allocation"], as: asNumber },
} as const;

function projectSeries(payload: Payload, context: string, kind: Performance["kind"]): Performance {
  const { rows, from, payloadKeys } = rowsOf(payload.value, context);
  return {
    kind,
    points: rows.map((row) => {
      const { fields, readFrom, unmappedKeys } = project(row, POINT_SPEC);
      return { ...(fields as { label?: string; value?: number }), readFrom, unmappedKeys };
    }),
    count: rows.length,
    rowsFrom: from,
    envelope: payload.from,
    payloadKeys,
  };
}

/** How the account's own trading has done — the aggregate, not a series. */
export async function getTradePerformance(): Promise<Performance> {
  return cached("carina:performance:trade", TTL.history, async () => {
    const body = await getJson("historyTradePerformance");
    const payload = payloadOf(body, "trade performance");
    return projectSeries(payload, "trade performance", "trade");
  });
}

/** One of the four portfolio series. */
export async function getPortfolioPerformance(kind: string): Promise<Performance> {
  const found = PERFORMANCE_KINDS.find((k) => k === kind);
  if (!found) {
    throw new StockbitError(
      "invalid_param",
      `Unknown performance series "${kind}". Expected one of: ${PERFORMANCE_KINDS.join(", ")}`,
    );
  }
  return cached(`carina:performance:${found}`, TTL.history, async () => {
    const body = await getJson("historyPortfolioPerformance", { segments: { performanceKind: found } });
    const payload = payloadOf(body, "portfolio performance");
    return projectSeries(payload, "portfolio performance", found);
  });
}

/* ------------------------------- fees & tradability ------------------------------- */

/**
 * The project's long-standing fee assumption, and the reason it is only a fallback.
 *
 * 0.15% buy / 0.25% sell is the common Indonesian retail rate and is what this codebase has quoted
 * since before there was a trading session to ask. It is not necessarily THIS account's rate, and a
 * preview that reports a net proceed on the wrong one is wrong in the single number the user checks
 * before agreeing to an order. So it is used only when the account's own schedule cannot be read,
 * and `source` always says which happened.
 */
export const DEFAULT_FEES = { buyPct: 0.15, sellPct: 0.25 } as const;

export interface Fees {
  buyPct: number;
  sellPct: number;
  source: "formula" | "trading-info" | "default";
  /** Set when the defaults were used, saying what failed. */
  note?: string;
  readFrom?: ReadFrom;
  /** What the wire actually held, before the percent/fraction reading below. */
  raw?: { buy?: number; sell?: number };
}

const FEE_SPEC = {
  buy: {
    keys: ["buy_fee", "fee_buy", "buy_commission", "commission_buy", "buy_fee_percentage", "buy"],
    as: asNumber,
  },
  sell: {
    keys: ["sell_fee", "fee_sell", "sell_commission", "commission_sell", "sell_fee_percentage", "sell"],
    as: asNumber,
  },
} as const;

/**
 * Read a fee as a percentage.
 *
 * The wire may express 0.15% as `0.0015` or as `0.15` and there is no field naming the convention.
 * The split is at 0.05: no Indonesian brokerage charges 5% commission, and none charges 0.0015%, so
 * a value below the threshold is a fraction and above it a percentage. `raw` carries the original
 * either way, so a reader who disagrees with the reading can see what it was.
 */
function feePercent(value: number): number {
  return value < 0.05 ? value * 100 : value;
}

function feesFrom(row: Row, source: "formula" | "trading-info"): Fees | null {
  const { fields, readFrom } = project(row, FEE_SPEC);
  const buy = fields.buy as number | undefined;
  const sell = fields.sell as number | undefined;
  if (buy === undefined && sell === undefined) return null;
  return {
    buyPct: buy === undefined ? DEFAULT_FEES.buyPct : feePercent(buy),
    sellPct: sell === undefined ? DEFAULT_FEES.sellPct : feePercent(sell),
    source,
    readFrom,
    raw: { ...(buy === undefined ? {} : { buy }), ...(sell === undefined ? {} : { sell }) },
    ...(buy === undefined || sell === undefined
      ? { note: "Only one side of the commission was found; the other is this project's default." }
      : {}),
  };
}

/**
 * This account's commission, from `/formula/v2` if it can be read, else `/trading/info`, else the
 * documented defaults. Never throws: a preview must still be able to say what it does not know.
 */
export async function getFees(): Promise<Fees> {
  return cached("carina:fees", TTL.fees, async () => {
    const reasons: string[] = [];
    for (const [route, source] of [
      ["tradingFormula", "formula"],
      ["tradingInfo", "trading-info"],
    ] as const) {
      try {
        const body = await getJson(route);
        const payload = payloadOf(body, "fee schedule");
        const row =
          payload.value !== null && typeof payload.value === "object" && !Array.isArray(payload.value)
            ? (payload.value as Row)
            : null;
        const fees = row ? feesFrom(row, source) : null;
        if (fees) return fees;
        reasons.push(`${route} answered but carried no recognisable commission fields`);
      } catch (err) {
        reasons.push(`${route}: ${err instanceof StockbitError ? err.message : String(err)}`);
      }
    }
    return {
      ...DEFAULT_FEES,
      source: "default" as const,
      note:
        "This account's own commission could not be read, so the project's documented defaults are " +
        `in use and any fee figure computed from them may be wrong. ${reasons.join("; ")}`,
    };
  });
}

/** Everything `/trading/info` says, projected for the fields a preview needs. */
export interface TradingInfo {
  fees: Fees;
  /** Account-level trading state, when the endpoint carried it. */
  status?: string;
  buyingPowerIdr?: number;
  readFrom: ReadFrom;
  unmappedKeys: string[];
  envelope: EnvelopePath;
}

const TRADING_INFO_SPEC = {
  status: { keys: ["status", "trading_status", "state", "account_status"], as: asText },
  buyingPowerIdr: { keys: ["buying_power", "buyingPower", "trading_limit", "limit"], as: asNumber },
} as const;

export async function getTradingInfo(): Promise<TradingInfo> {
  return cached("carina:trading-info", TTL.fees, async () => {
    const body = await getJson("tradingInfo");
    const payload = payloadOf(body, "trading info");
    const row = objectOf(payload.value, "trading info");
    const { fields, readFrom, unmappedKeys } = project(row, TRADING_INFO_SPEC);
    return {
      fees: await getFees(),
      ...(fields as { status?: string; buyingPowerIdr?: number }),
      readFrom,
      unmappedKeys,
      envelope: payload.from,
    };
  });
}

export interface Tradability {
  symbol: string;
  /** Undefined when the response carried no field this projection recognises as the verdict. */
  tradable?: boolean;
  reason?: string;
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

const TRADABLE_SPEC = {
  symbol: { keys: ["symbol", "stock_code", "stockCode", "code"], as: asText },
  tradable: {
    keys: ["tradable", "is_tradable", "can_trade", "tradeable", "is_tradeable"],
    as: (v: unknown) => (typeof v === "boolean" ? v : undefined),
  },
  reason: { keys: ["reason", "message", "note", "description", "status"], as: asText },
} as const;

export interface TradabilityResult {
  symbols: Tradability[];
  rowsFrom: string | null;
  envelope: EnvelopePath;
  payloadKeys: string[];
  request: { stock_codes: string };
}

/**
 * Whether the exchange will accept an order in these symbols right now — suspensions, delistings,
 * and the full-call-auction board all land here.
 *
 * A symbol the response does not mention is returned with `tradable: undefined`, not `false`. "We
 * could not tell" and "you may not trade this" lead to different conversations with the user.
 */
export async function getStockTradable(symbols: string[]): Promise<TradabilityResult> {
  if (!symbols.length) throw new StockbitError("invalid_param", "At least one symbol is required.");
  const codes = symbols.map(normalizeSymbol);
  const stockCodes = codes.join(",");

  return cached(`carina:tradable:${stockCodes}`, TTL.tradable, async () => {
    const body = await getJson("stockTradable", { params: { stock_codes: stockCodes } });
    const payload = payloadOf(body, "tradability");
    const { rows, from, payloadKeys } = rowsOf(payload.value, "tradability");

    const found = rows.map((row) => {
      const { fields, readFrom, unmappedKeys } = project(row, TRADABLE_SPEC);
      const f = fields as { symbol?: string; tradable?: boolean; reason?: string };
      return { symbol: f.symbol ?? "", tradable: f.tradable, reason: f.reason, readFrom, unmappedKeys };
    });

    // Every symbol asked about appears in the answer, so a caller can index by what it sent.
    const bySymbol = new Map(found.filter((r) => r.symbol).map((r) => [normalizeSymbol(r.symbol), r]));
    const merged = codes.map(
      (code) => bySymbol.get(code) ?? { symbol: code, readFrom: {}, unmappedKeys: [] },
    );

    return { symbols: merged, rowsFrom: from, envelope: payload.from, payloadKeys, request: { stock_codes: stockCodes } };
  });
}

/* ---------------------------------- identity ---------------------------------- */

export interface SubAccount {
  /** The sub-account's type or product name — not an identifier, so not masked. */
  type?: string;
  /** Masked to its last four characters. */
  numberMasked?: string;
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

export interface AccountIdentity {
  /** Initials only. See `maskName`. */
  nameMasked?: string;
  /** Last four characters only. See `maskIdentifier`. */
  accountNumberMasked?: string;
  rdnMasked?: string;
  sidMasked?: string;
  broker?: string;
  status?: string;
  subAccounts: SubAccount[];
  subAccountsUnavailable?: string;
  /**
   * Says plainly that the masking happened here rather than upstream, so a caller does not report
   * the bullets as what Stockbit returned.
   */
  masking: string;
  readFrom: ReadFrom;
  unmappedKeys: string[];
  envelope: EnvelopePath;
}

const ACCOUNT_SPEC = {
  name: { keys: ["name", "full_name", "fullname", "customer_name", "client_name"], as: asText },
  accountNumber: { keys: ["account_number", "accountNumber", "account_id", "client_id", "customer_id"], as: asText },
  rdn: { keys: ["rdn", "rdn_number", "rdn_account", "bank_account", "bank_account_number"], as: asText },
  sid: { keys: ["sid", "sid_number", "investor_id"], as: asText },
  broker: { keys: ["broker", "broker_name", "securities", "company"], as: asText },
  status: { keys: ["status", "account_status", "state"], as: asText },
} as const;

const SUB_ACCOUNT_SPEC = {
  type: { keys: ["type", "sub_account_type", "product", "name", "label"], as: asText },
  number: { keys: ["sub_account", "sub_account_id", "account_number", "id", "code"], as: asText },
} as const;

/**
 * Who the account is — masked before it leaves this function, not at the tool boundary.
 *
 * Masking here rather than in `src/tools/trading.ts` means there is no code path, present or
 * future, that gets the unmasked value by calling the core function directly. The tool layer is
 * where a shortcut gets taken; this is not the tool layer.
 */
export async function getAccount(): Promise<AccountIdentity> {
  return cached("carina:account", TTL.identity, async () => {
    const body = await getJson("account");
    const payload = payloadOf(body, "account");
    const row = objectOf(payload.value, "account");
    const { fields, readFrom, unmappedKeys } = project(row, ACCOUNT_SPEC);
    const f = fields as Record<string, string | undefined>;

    let subAccounts: SubAccount[] = [];
    let subAccountsUnavailable: string | undefined;
    try {
      const listBody = await getJson("subAccountList");
      const listPayload = payloadOf(listBody, "sub-accounts");
      const { rows } = rowsOf(listPayload.value, "sub-accounts");
      subAccounts = rows.map((subRow) => {
        const sub = project(subRow, SUB_ACCOUNT_SPEC);
        const values = sub.fields as { type?: string; number?: string };
        return {
          ...(values.type ? { type: values.type } : {}),
          ...(values.number ? { numberMasked: maskIdentifier(values.number) } : {}),
          readFrom: sub.readFrom,
          unmappedKeys: sub.unmappedKeys,
        };
      });
    } catch (err) {
      subAccountsUnavailable = err instanceof StockbitError ? err.message : String(err);
    }

    return {
      ...(f.name ? { nameMasked: maskName(f.name) } : {}),
      ...(f.accountNumber ? { accountNumberMasked: maskIdentifier(f.accountNumber) } : {}),
      ...(f.rdn ? { rdnMasked: maskIdentifier(f.rdn) } : {}),
      ...(f.sid ? { sidMasked: maskIdentifier(f.sid) } : {}),
      ...(f.broker ? { broker: f.broker } : {}),
      ...(f.status ? { status: f.status } : {}),
      subAccounts,
      ...(subAccountsUnavailable ? { subAccountsUnavailable } : {}),
      masking:
        "Name, account, RDN and SID are masked by this server before they reach you. The full " +
        "values are never returned by any tool; the account holder can see them in the Stockbit app.",
      readFrom,
      unmappedKeys,
      envelope: payload.from,
    };
  });
}
