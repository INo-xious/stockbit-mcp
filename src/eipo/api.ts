/**
 * e-IPO: the offerings, and this account's place in them.
 *
 * ## Two projection policies in one module, on purpose
 *
 * An offering is public. The prospectus, the price range, the underwriters, the timetable — that is
 * information Stockbit publishes to everyone, and the market-data rule applies: return the payload
 * whole, because a field nobody has named yet is still information and hiding it loses it.
 *
 * The RDN balance and this account's own subscription are not public. There the rule from
 * `src/trading/account.ts` applies instead: project into named fields and drop the values of keys
 * that were not recognised, keeping only their names. The line between the two is the question
 * "does this describe the offering, or does it describe the user?"
 *
 * ## Nothing here has been observed live
 *
 * Same as carina, and for a related reason: the e-IPO session is minted from a webview grant nobody
 * has captured. `readFrom` names the wire key each projected value came from; `docs/PENDING-
 * VERIFICATION.md` carries the list.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { cached, parseOr } from "../core/_util.js";
import { ensureEipoSession } from "./session.js";

const TTL = { offerings: 300_000, account: 10_000 } as const;

type Row = Record<string, unknown>;

const Envelope = z.object({ data: z.unknown() }).passthrough();

/** Peel `{data}` and, when it is there, the second `{data}` inside it. */
function payloadOf(body: unknown, context: string): unknown {
  const outer = parseOr(Envelope, body, context).data;
  if (outer && typeof outer === "object" && !Array.isArray(outer) && "data" in (outer as Row)) {
    return (outer as Row).data;
  }
  return outer ?? null;
}

/** An emiten code, on its way into a query parameter. Letters and digits, like a ticker. */
export function normalizeEmiten(code: string): string {
  const trimmed = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,10}$/.test(trimmed)) {
    throw new StockbitError(
      "invalid_param",
      `${JSON.stringify(code)} is not an emiten code. Expected letters and digits, e.g. BREN.`,
    );
  }
  return trimmed;
}

/* --------------------------------- public offerings --------------------------------- */

/**
 * Every offering the app lists: upcoming, open, and recently closed.
 *
 * Returned whole. This is the public half of the module — see the note above.
 */
export async function listOfferings(): Promise<unknown> {
  await ensureEipoSession();
  return cached("eipo:list", TTL.offerings, async () => payloadOf(await getJson("eipoCompanyList"), "e-IPO list"));
}

/** One offering in full: the prospectus data, the price range, the timetable. */
export async function getOffering(emitenCode: string): Promise<unknown> {
  const code = normalizeEmiten(emitenCode);
  await ensureEipoSession();
  return cached(`eipo:detail:${code}`, TTL.offerings, async () =>
    payloadOf(await getJson("eipoCompanyDetail", { params: { emiten_code: code } }), "e-IPO detail"),
  );
}

/**
 * Where one offering is in its timetable.
 *
 * Worth reading before anything else about an offering: "still open", "closed, allotment pending"
 * and "allotted" are three different answers to "can I subscribe" and to "did I get any", and the
 * detail payload alone does not distinguish them.
 */
export async function getOfferingStatus(emitenCode: string): Promise<unknown> {
  const code = normalizeEmiten(emitenCode);
  await ensureEipoSession();
  return cached(`eipo:status:${code}`, TTL.account, async () =>
    payloadOf(await getJson("eipoStatus", { params: { emiten_code: code } }), "e-IPO status"),
  );
}

/** The price bands an order may be placed at. */
export async function getPriceGroups(): Promise<unknown> {
  await ensureEipoSession();
  return cached("eipo:price-groups", TTL.offerings, async () =>
    payloadOf(await getJson("eipoPriceGroup"), "e-IPO price groups"),
  );
}

/** Stockbit's "unboxing" write-up for an offering. Editorial, not a filing. */
export async function getUnboxing(emitenCode: string): Promise<unknown> {
  const code = normalizeEmiten(emitenCode);
  await ensureEipoSession();
  return cached(`eipo:unboxing:${code}`, TTL.offerings, async () =>
    payloadOf(await getJson("eipoUnboxing", { params: { emiten_code: code } }), "e-IPO unboxing"),
  );
}

/* ---------------------------------- this account ---------------------------------- */

export type ReadFrom = Record<string, string>;

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** The same projector `src/trading/account.ts` uses: recognised values out, unknown NAMES only. */
function project<K extends string>(
  row: Row,
  spec: Record<K, { keys: readonly string[]; as: (v: unknown) => unknown }>,
): { fields: Partial<Record<K, unknown>>; readFrom: ReadFrom; unmappedKeys: string[] } {
  const fields: Partial<Record<K, unknown>> = {};
  const readFrom: ReadFrom = {};
  const consumed = new Set<string>();
  for (const field of Object.keys(spec) as K[]) {
    for (const key of spec[field].keys) {
      if (!(key in row)) continue;
      const value = spec[field].as(row[key]);
      if (value === undefined) continue;
      fields[field] = value;
      readFrom[field] = key;
      consumed.add(key);
      break;
    }
  }
  return { fields, readFrom, unmappedKeys: Object.keys(row).filter((k) => !consumed.has(k)) };
}

function objectOf(payload: unknown, context: string): Row {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Row;
  throw new StockbitError("schema_drift", `Unexpected ${context} response shape (expected an object)`);
}

export interface RdnBalance {
  availableIdr?: number;
  balanceIdr?: number;
  heldIdr?: number;
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

const RDN_SPEC = {
  availableIdr: { keys: ["available", "available_balance", "usable_balance", "free_balance"], as: asNumber },
  balanceIdr: { keys: ["balance", "rdn_balance", "total_balance", "amount"], as: asNumber },
  heldIdr: { keys: ["hold", "held", "hold_amount", "blocked", "reserved"], as: asNumber },
} as const;

/**
 * The RDN cash an IPO subscription is funded from.
 *
 * NOT the same money as `cash_balance` on the trading host: an IPO order holds funds in the
 * investor's RDN account until allotment, and an account can have buying power on carina while
 * having nothing available here. Quoting one for the other is how a user is told they can subscribe
 * when they cannot.
 */
export async function getRdnBalance(): Promise<RdnBalance> {
  await ensureEipoSession();
  return cached("eipo:rdn", TTL.account, async () => {
    const row = objectOf(payloadOf(await getJson("eipoRdnBalance"), "RDN balance"), "RDN balance");
    const { fields, readFrom, unmappedKeys } = project(row, RDN_SPEC);
    return { ...(fields as Omit<RdnBalance, "readFrom" | "unmappedKeys">), readFrom, unmappedKeys };
  });
}

export interface EipoOrder {
  emitenCode?: string;
  status?: string;
  /** What was asked for. */
  lots?: number;
  shares?: number;
  price?: number;
  amountIdr?: number;
  /** What was actually granted. An IPO allotment is routinely smaller than the subscription. */
  allottedLots?: number;
  allottedShares?: number;
  allottedAmountIdr?: number;
  readFrom: ReadFrom;
  unmappedKeys: string[];
}

const ORDER_SPEC = {
  emitenCode: { keys: ["emiten_code", "emitenCode", "symbol", "code"], as: asText },
  status: { keys: ["status", "order_status", "state"], as: asText },
  lots: { keys: ["lot", "lots", "total_lot", "order_lot"], as: asNumber },
  shares: { keys: ["shares", "quantity", "qty", "amount_share"], as: asNumber },
  price: { keys: ["price", "order_price", "final_price"], as: asNumber },
  amountIdr: { keys: ["amount", "total_amount", "order_amount", "value"], as: asNumber },
  allottedLots: { keys: ["allotment_lot", "allotted_lot", "result_lot", "final_lot"], as: asNumber },
  allottedShares: { keys: ["allotment_share", "allotted_share", "result_share"], as: asNumber },
  allottedAmountIdr: { keys: ["allotment_amount", "allotted_amount", "result_amount"], as: asNumber },
} as const;

/** Project one subscription record. Exported so the write path can read its own read-back. */
export function readEipoOrder(payload: unknown): EipoOrder | null {
  if (payload === null || payload === undefined) return null;
  const row = Array.isArray(payload)
    ? (payload[0] as Row | undefined)
    : (payload as Row);
  if (!row || typeof row !== "object") return null;
  const { fields, readFrom, unmappedKeys } = project(row, ORDER_SPEC);
  return { ...(fields as Omit<EipoOrder, "readFrom" | "unmappedKeys">), readFrom, unmappedKeys };
}

/**
 * This account's subscription to one offering, if any.
 *
 * `null` means no subscription — a normal answer. `allotted*` fields are what actually came through:
 * an oversubscribed IPO routinely allots a fraction of what was asked for, and reporting the
 * subscription as the holding is wrong in the direction that matters.
 */
export async function getMyOrder(emitenCode: string): Promise<{ emitenCode: string; order: EipoOrder | null }> {
  const code = normalizeEmiten(emitenCode);
  await ensureEipoSession();
  return cached(`eipo:order:${code}`, TTL.account, async () => {
    try {
      const payload = payloadOf(await getJson("eipoOrderDetail", { params: { emiten_code: code } }), "e-IPO order");
      return { emitenCode: code, order: readEipoOrder(payload) };
    } catch (err) {
      if (err instanceof StockbitError && err.kind === "not_found") return { emitenCode: code, order: null };
      throw err;
    }
  });
}

/** Uncached, for the write path's read-back. See the note in `src/trading/account.ts` on why. */
export async function getMyOrderRaw(emitenCode: string): Promise<unknown> {
  return getJson("eipoOrderDetail", { params: { emiten_code: normalizeEmiten(emitenCode) } });
}
