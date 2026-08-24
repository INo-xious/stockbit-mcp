/**
 * Subscribing to an IPO. ADR-0004, same switch and same protocol as an exchange order.
 *
 * ## Why it is under the trading switch at all
 *
 * An e-IPO subscription commits real money out of the RDN account, on a security that has never
 * traded, for an allotment that may be a fraction of what was asked for and cannot be cancelled by
 * selling. It is a trade. Putting it behind the same `trading.enabled` switch and the same
 * preview→confirm→redeem protocol is the only consistent reading.
 *
 * ## The one thing this has that an exchange order does not
 *
 * `POST /eipo/order/verify` is Stockbit's OWN dry run: the server itself says whether the
 * subscription would be accepted. That is a better check than anything computed here — it knows the
 * offering's rules, this project does not — so its answer goes into the ticket as a check of its
 * own, and a verify that says no blocks the order.
 *
 * A verify that cannot be read does NOT block it: the endpoint has never been observed, and a
 * projection that fails to recognise the response would otherwise make subscription impossible for
 * a reason unrelated to the subscription. It is marked `unverified` and named in the warnings, the
 * same way every other unreadable check is.
 *
 * ## What is guessed
 *
 * The request body. `{emiten_code, price, lot}` is what the e-IPO flow expresses a subscription in
 * everywhere it is visible, but it has not been captured. See `docs/PENDING-VERIFICATION.md`: the
 * first real subscription is a live gate, not a test run.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { postJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { redactValue } from "../redact.js";
import { invalidateCache } from "../core/_util.js";
import { tradingPolicy, type TradingPolicy } from "../settings.js";
import { idr } from "../trading/preview.js";
import { TICKET_TTL_MS, issue, now, peek, take, type TicketBase } from "../trading/tickets.js";
import { ensureEipoSession } from "./session.js";
import { getMyOrderRaw, getOfferingStatus, getRdnBalance, normalizeEmiten, readEipoOrder } from "./api.js";
import { stockbitDir } from "../paths.js";

const SHARES_PER_LOT = 100;

/** The same log an exchange order writes to. One file, one audit trail, whatever the venue. */
export function eipoLogPath(): string {
  return join(stockbitDir(), "order-mutations.log");
}

function logEipo(entry: Record<string, unknown>): boolean {
  try {
    mkdirSync(stockbitDir(), { recursive: true });
    appendFileSync(eipoLogPath(), `${JSON.stringify(redactValue(entry))}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function refuse(message: string): never {
  throw new StockbitError("invalid_param", message);
}

/* ------------------------------------ the ticket ------------------------------------ */

export interface EipoTicket extends TicketBase {
  kind: "eipo";
  emitenCode: string;
  lots: number;
  shares: number;
  price: number;
  amountIdr: number;
  rdnAvailableIdr: number | null;
  /** Whether an existing subscription to this offering was found. */
  alreadySubscribed: boolean | null;
  uiRef: string;
  policy: TradingPolicy;
  warnings: string[];
  fingerprint: string;
  createdAt: string;
}

export function fingerprintOfEipo(ticket: EipoTicket): string {
  const material = {
    emitenCode: ticket.emitenCode,
    price: ticket.price,
    lots: ticket.lots,
    shares: ticket.shares,
    uiRef: ticket.uiRef,
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 32);
}

/** The subscription body. See the module note: this is the part a HAR settles. */
export function eipoOrderBody(ticket: EipoTicket): Record<string, unknown> {
  return { emiten_code: ticket.emitenCode, price: ticket.price, lot: ticket.lots };
}

/**
 * Read Stockbit's own verify answer.
 *
 * `null` means the response carried nothing this projection recognises as a verdict — which is
 * different from a "no" and is treated as such.
 */
export function readVerdict(body: unknown): { accepted: boolean | null; message?: string } {
  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const data = (payload.data && typeof payload.data === "object" ? payload.data : payload) as Record<string, unknown>;
  const message =
    typeof data.message === "string"
      ? data.message
      : typeof payload.message === "string"
        ? payload.message
        : undefined;

  for (const key of ["valid", "is_valid", "success", "eligible", "can_order", "verified"]) {
    const value = data[key] ?? payload[key];
    if (typeof value === "boolean") return { accepted: value, ...(message ? { message } : {}) };
  }
  // A message that names a rejection is a verdict even when no boolean came with it.
  if (message && /not eligible|reject|insufficient|closed|invalid|cannot/i.test(message)) {
    return { accepted: false, message };
  }
  return { accepted: null, ...(message ? { message } : {}) };
}

async function attempt<T>(label: string, load: () => Promise<T>, notes: string[]): Promise<T | null> {
  try {
    return await load();
  } catch (err) {
    notes.push(`${label} could not be read (${err instanceof StockbitError ? err.message : String(err)})`);
    return null;
  }
}

/**
 * Price and check a subscription without committing to it.
 *
 * Reads run one after another, for the reason `src/trading/preview.ts` gives: concurrent first calls
 * each trigger their own token refresh, and a rotating refresh token means all but one lose.
 */
export async function previewEipoOrder(input: {
  emitenCode: string;
  lots: number;
  price: number;
}): Promise<EipoTicket> {
  const policy = tradingPolicy();
  const emitenCode = normalizeEmiten(input.emitenCode);
  const warnings: string[] = [];
  const checks: EipoTicket["checks"] = [];

  if (!Number.isInteger(input.lots) || input.lots < 1) {
    refuse(`Lots must be a positive whole number, got ${input.lots}.`);
  }
  if (!Number.isFinite(input.price) || input.price <= 0) {
    refuse(`A subscription price must be a positive number, got ${input.price}.`);
  }

  const lots = input.lots;
  const shares = lots * SHARES_PER_LOT;
  const amountIdr = input.price * shares;

  await ensureEipoSession();

  const status = await attempt("The offering's status", () => getOfferingStatus(emitenCode), warnings);
  const rdn = await attempt("The RDN balance", () => getRdnBalance(), warnings);
  const existing = await attempt("This account's existing subscription", () => getMyOrderRaw(emitenCode), warnings);

  const uiRef = randomUUID();
  const verifyBody = { emiten_code: emitenCode, price: input.price, lot: lots };
  const verdict = await attempt(
    "Stockbit's own verification",
    async () => readVerdict(await postJson("eipoOrderVerify", { body: verifyBody })),
    warnings,
  );

  checks.push({
    name: "trading_enabled",
    ok: policy.enabled,
    detail: policy.enabled ? `Trading is on (${policy.source}).` : policy.reason,
  });

  checks.push({
    name: "lots_within_cap",
    ok: lots <= policy.maxLotsPerOrder,
    detail:
      lots <= policy.maxLotsPerOrder
        ? `${lots} lots is within the configured cap of ${policy.maxLotsPerOrder}.`
        : `${lots} lots exceeds the configured cap of ${policy.maxLotsPerOrder} per order.`,
  });

  checks.push(
    policy.maxOrderValueIdr === null
      ? { name: "value_within_cap", ok: true, detail: "No per-order value cap is configured." }
      : {
          name: "value_within_cap",
          ok: amountIdr <= policy.maxOrderValueIdr,
          detail:
            amountIdr <= policy.maxOrderValueIdr
              ? `${idr(amountIdr)} is within the configured cap of ${idr(policy.maxOrderValueIdr)}.`
              : `${idr(amountIdr)} exceeds the configured per-order cap of ${idr(policy.maxOrderValueIdr)}.`,
        },
  );

  const available = rdn?.availableIdr ?? rdn?.balanceIdr ?? null;
  checks.push(
    available === null
      ? {
          name: "rdn_sufficient",
          ok: true,
          detail:
            "The RDN balance could not be read, so whether this subscription is funded was not checked. " +
            "An IPO order is paid from the RDN account, not from trading cash.",
          unverified: true as const,
        }
      : {
          name: "rdn_sufficient",
          ok: amountIdr <= available,
          detail:
            amountIdr <= available
              ? `${idr(amountIdr)} against ${idr(available)} available in the RDN account.`
              : `${idr(amountIdr)} is more than the ${idr(available)} available in the RDN account.`,
        },
  );

  const alreadySubscribed = existing === null ? null : readEipoOrder(unwrapData(existing)) !== null;
  checks.push(
    alreadySubscribed === null
      ? {
          name: "not_already_subscribed",
          ok: true,
          detail: `Whether this account already subscribed to ${emitenCode} could not be established.`,
          unverified: true as const,
        }
      : {
          name: "not_already_subscribed",
          ok: !alreadySubscribed,
          detail: alreadySubscribed
            ? `This account already has a subscription to ${emitenCode}. Placing another may replace it or be ` +
              "rejected; read `eipo_my_order` and decide with the user before continuing."
            : `No existing subscription to ${emitenCode}.`,
        },
  );

  checks.push(
    verdict === null || verdict.accepted === null
      ? {
          name: "server_verified",
          ok: true,
          detail:
            "Stockbit's own verification of this subscription could not be read, so it was not used. " +
            (verdict?.message ? `The server said: ${verdict.message}` : ""),
          unverified: true as const,
        }
      : {
          name: "server_verified",
          ok: verdict.accepted,
          detail: verdict.accepted
            ? "Stockbit's own verification accepted this subscription."
            : `Stockbit's own verification REFUSED this subscription${verdict.message ? `: ${verdict.message}` : "."}`,
        },
  );

  if (status !== null) {
    const text = JSON.stringify(status);
    if (/closed|ended|allot|finish/i.test(text) && !/open/i.test(text)) {
      warnings.push(
        `The offering's status does not read as open. Check \`eipo_status\` for ${emitenCode} before ` +
          "telling the user their subscription will be accepted.",
      );
    }
  }

  const unverifiedNames = checks.filter((c) => c.unverified).map((c) => c.name);
  if (unverifiedNames.length) {
    warnings.push(
      `${unverifiedNames.length} check(s) could not be run against live data and passed by default: ` +
        `${unverifiedNames.join(", ")}. They mean "not contradicted", not "confirmed".`,
    );
  }

  const createdMs = now();
  const failed = checks.filter((c) => !c.ok);
  const ticket: EipoTicket = {
    id: `tk_${randomUUID()}`,
    kind: "eipo",
    emitenCode,
    lots,
    shares,
    price: input.price,
    amountIdr,
    rdnAvailableIdr: available,
    alreadySubscribed,
    uiRef,
    policy,
    checks,
    warnings,
    fingerprint: "",
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(createdMs + TICKET_TTL_MS).toISOString(),
    summary: "",
  };
  ticket.fingerprint = fingerprintOfEipo(ticket);
  ticket.summary =
    `SUBSCRIBE to ${emitenCode}'s IPO: ${lots} lots (${shares} shares) at ${idr(input.price)}, ` +
    `committing ${idr(amountIdr)} from the RDN account` +
    (available === null ? "" : ` (${idr(available)} available)`) +
    ". An IPO allotment is often smaller than the subscription, and it cannot be cancelled by selling. " +
    (failed.length
      ? `THIS SUBSCRIPTION CANNOT BE PLACED: ${failed.map((c) => c.detail).join(" ")}`
      : `Every check passed${unverifiedNames.length ? `, though ${unverifiedNames.length} could not be verified` : ""}.`) +
    ` Ticket ${ticket.id} expires ${ticket.expiresAt}.`;

  return issue(ticket);
}

/** Peel `{data}` once, so `readEipoOrder` sees the record rather than the envelope. */
function unwrapData(body: unknown): unknown {
  if (body && typeof body === "object" && "data" in (body as Record<string, unknown>)) {
    const inner = (body as Record<string, unknown>).data;
    if (inner && typeof inner === "object" && "data" in (inner as Record<string, unknown>)) {
      return (inner as Record<string, unknown>).data;
    }
    return inner;
  }
  return body;
}

/* ------------------------------------- the write ------------------------------------- */

export type EipoOutcome = "ok" | "rejected" | "not-visible" | "landed-despite-error" | "outcome-unknown" | "write-failed";

export interface EipoResult {
  ticketId: string;
  emitenCode: string;
  lots: number;
  price: number;
  amountIdr: number;
  uiRef: string;
  outcome: EipoOutcome;
  verified: boolean;
  outcomeUnknown?: string;
  error?: string;
  logged: boolean;
  logPath: string;
  at: string;
}

/**
 * Commit the subscription a ticket describes.
 *
 * Throws only before the request. Afterwards it returns what is known — including that it does not
 * know, which for a commitment with no undo is the answer that matters most.
 */
export async function placeEipoOrder(options: {
  ticketId: string;
  confirm?: boolean;
  elicit?: (message: string) => Promise<"accepted" | "declined" | "unavailable">;
}): Promise<EipoResult> {
  const policy = tradingPolicy();
  if (!policy.enabled) {
    refuse(`${policy.reason} No subscription was sent. Settings file: ${policy.settingsPath}.`);
  }

  const found = peek(options.ticketId);
  if (!found) take(options.ticketId); // throws with the precise reason
  if (found && found.kind !== "eipo") {
    refuse(`Ticket ${options.ticketId} is an exchange order, not an e-IPO subscription. Use the order tools.`);
  }
  const preview = found as EipoTicket;

  let via: "explicit" | "auto-confirm" | "elicited" | null = options.confirm === true ? "explicit" : null;
  if (!via && policy.autoConfirmIgnored) refuse(`${policy.autoConfirmIgnored} Nothing was sent.`);
  if (!via && policy.autoConfirm) {
    const cap = policy.maxOrderValueIdr;
    if (cap === null) {
      refuse("autoConfirm is set but no maxOrderValueIdr is configured, so it is ignored. Pass confirm: true.");
    }
    if (preview.amountIdr <= cap) via = "auto-confirm";
    else {
      refuse(
        `autoConfirm covers orders up to ${idr(cap)} and this subscription is ${idr(preview.amountIdr)}. ` +
          "Ask the user and pass confirm: true.",
      );
    }
  }
  if (!via && options.elicit) {
    const answer = await options.elicit(preview.summary);
    if (answer === "accepted") via = "elicited";
    else if (answer === "declined") refuse("The user declined this subscription when asked directly. Nothing was sent.");
  }
  if (!via) {
    refuse(
      "Refusing to send an IPO subscription without confirmation. Show the user the ticket's `summary`, in " +
        "words, and pass confirm: true only after they agree to THAT subscription.",
    );
  }

  const ticket = take(options.ticketId, "eipo") as EipoTicket;
  if (fingerprintOfEipo(ticket) !== ticket.fingerprint) {
    refuse(
      `Ticket ${ticket.id} does not match its own fingerprint — the subscription it describes has been altered ` +
        "since it was previewed. Nothing was sent.",
    );
  }

  const at = new Date().toISOString();
  const base = {
    ticketId: ticket.id,
    emitenCode: ticket.emitenCode,
    lots: ticket.lots,
    price: ticket.price,
    amountIdr: ticket.amountIdr,
    uiRef: ticket.uiRef,
    logPath: eipoLogPath(),
    at,
  };

  let before: unknown;
  try {
    before = unwrapData(await getMyOrderRaw(ticket.emitenCode));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logEipo({ ...base, via, outcome: "aborted-no-snapshot", error: message });
    refuse(
      `This account's existing subscriptions could not be read (${message}), so there would have been no way ` +
        "to tell whether this one landed. Nothing was sent.",
    );
  }
  const hadOrder = readEipoOrder(before) !== null;

  let writeError: Error | null = null;
  try {
    await postJson("eipoOrderPlace", { body: eipoOrderBody(ticket) });
  } catch (err) {
    writeError = err instanceof Error ? err : new Error(String(err));
  }
  invalidateCache("eipo:order");
  invalidateCache("eipo:rdn");

  // `readBack` and its payload are tracked separately: "the read-back failed" and "the read-back
  // says there is no subscription" are opposite facts, and a null payload means the second. Folding
  // them together would report a clean 'no subscription here' as an unknown outcome.
  let after: unknown = null;
  let readBack = false;
  let readBackError: string | undefined;
  try {
    after = unwrapData(await getMyOrderRaw(ticket.emitenCode));
    readBack = true;
  } catch (err) {
    readBackError = err instanceof Error ? err.message : String(err);
  }

  const projected = readBack ? readEipoOrder(after) : null;
  // A subscription that was not there before and is there now, or one whose lots now match what was
  // asked for. Either is evidence; neither is assumed from a 2xx alone.
  const landed = readBack && projected !== null && (!hadOrder || projected.lots === ticket.lots);

  const finish = (outcome: EipoOutcome, verified: boolean, extra: Partial<EipoResult> = {}): EipoResult => {
    const logged = logEipo({ ...base, via, venue: "eipo", outcome, verified, ...extra });
    return { ...base, outcome, verified, ...extra, logged };
  };

  if (writeError) {
    const message = writeError.message;
    const status = writeError instanceof StockbitError ? writeError.status : undefined;
    if (landed) {
      return finish("landed-despite-error", true, {
        error: message,
        outcomeUnknown:
          `The request errored (${message}) but the subscription IS recorded. It was NOT retried and must ` +
          "not be — read `eipo_my_order` before doing anything else.",
      });
    }
    if (!readBack) {
      return finish("outcome-unknown", false, {
        error: message,
        outcomeUnknown:
          `The request errored (${message}) AND the subscription could not be read back (${readBackError}), ` +
          "so whether it exists is unknown. Do not resend it.",
      });
    }
    return finish(status !== undefined && status >= 400 && status < 500 ? "write-failed" : "rejected", false, {
      error: message,
    });
  }

  if (!readBack) {
    return finish("outcome-unknown", false, {
      error: readBackError,
      outcomeUnknown:
        `The request succeeded but the subscription could not be read back (${readBackError}), so it is ` +
        "unconfirmed. Do not resend it — read `eipo_my_order` in a moment.",
    });
  }
  if (landed) return finish("ok", true);
  return finish("not-visible", false, {
    outcomeUnknown:
      "The request was accepted but no subscription is visible yet. Do NOT resend it — read " +
      "`eipo_my_order` again before concluding anything.",
  });
}
