/**
 * Insider transactions and shareholder ownership — the second bandarmology signal.
 *
 *   GET /insider/company/majorholder                        → disclosed insider transactions
 *   GET /insider/majorholder/ownership                      → one insider's positions
 *   GET /insider/shareholding/companies/{symbol}            → who holds this company
 *   GET /insider/shareholding/investors/{insiderId}         → what this holder holds
 *   GET /insider/shareholding/network                       → the ownership graph around a node
 *   GET /insider/shareholding/composition/companies/{symbol} → holding composition over time
 *
 * Broker summary says which *brokers* accumulated; this says whether the directors, commissioners
 * and controlling shareholders of the company did. It is the only signal here that comes from the
 * people who know the business from the inside.
 *
 * ## Lag, and why it is not a timing signal
 *
 * Every row is a disclosure, not a print. IDX requires a filing after the fact, so a transaction
 * surfaces days after it happened and the `date` on a row is the transaction or record date, not
 * the day the row appeared. Treating it as intraday flow is the one way to misuse this module, so
 * every tool description says it outright.
 *
 * ## What is verified and what is not
 *
 * None of these six routes has been probed live from this project. The field names below were read
 * out of Stockbit's own web client (the `insider-activity` module-federation remote and the
 * insider and ownership page bundles), which is the same evidence class the rest of this
 * repo's enum spellings come from, and it is one step weaker than a live response.
 *
 * So the split is deliberate: the transaction row shape is well enough mapped to project into named
 * fields, and every projection is ADDITIVE — the raw row is spread through underneath, camelCase
 * names cannot collide with the wire's snake_case, and nothing is dropped. The shareholding and
 * composition payloads are NOT mapped, so they are returned whole with only a count and a
 * which-key-was-it note beside them. Naming survivors of a shape nobody has measured turns "not
 * looked at yet" into "does not exist"; see the note on `getSectors` in emitten.ts.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { StockbitError } from "../http/errors.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { resolveCompanyId } from "./emitten.js";
import { normalizeTradeDate } from "./dates.js";

/* -------------------------------- vocabularies -------------------------------- */

/**
 * The action types on an insider transaction, without the `ACTION_TYPE_` prefix.
 *
 * **Treat this list as partial.** It is the enum Stockbit's own insider page carries, and its
 * filter UI offers only six of them (All, Buy, Sell, Cross, Transfer, Corp Action) — so the API may
 * well answer with, or accept, a name that is not here. Callers therefore pass a free string and an
 * unrecognised value is sent rather than refused: rejecting an unknown-but-real action would make a
 * legitimate query impossible, and the cost of being wrong the other way is one 400 from the server.
 */
export const INSIDER_ACTION_TYPES = [
  "UNSPECIFIED",
  "BUY",
  "SELL",
  "CROSS",
  "TRANSFER",
  "CORPACTION",
  "RIGHT_ISSUE",
  "WARRANT_EXERCISE",
  "MESOP_OPTION",
  "BOND_CONVERSION",
  "STOCK_BONUS",
  "PRIVATE_PLACEMENT",
  "CAPITAL_REDUCTION",
  "PUPS",
  "REVERSE_SPLIT",
  "STOCK_DIVIDEND",
  "TENDER_OFFER",
] as const;

/**
 * Where a disclosure came from. IDX rows are exchange filings; KSEI rows are custodian holding
 * records, which is why Stockbit relabels the date column "Trx Date" for IDX and "Rec Date" for
 * KSEI. UNSPECIFIED is the "no filter" value, not a third source.
 *
 * Partial for the same reason as the action list.
 */
export const INSIDER_SOURCE_TYPES = ["UNSPECIFIED", "IDX", "KSEI"] as const;

/** What an ownership-graph root is. Also partial. */
export const SHAREHOLDING_NODE_TYPES = ["COMPANY", "INVESTOR"] as const;

/** The three shareholding views. Not a wire value — it picks which route is called. */
export const SHAREHOLDING_MODES = ["companies", "investors", "network"] as const;
export type ShareholdingMode = (typeof SHAREHOLDING_MODES)[number];

const ENUM_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Put a caller's enum-ish value into the wire spelling.
 *
 * Accepts `cross`, `CROSS` and `ACTION_TYPE_CROSS` alike and always sends the prefixed form. The
 * charset check is the only rejection: it keeps arbitrary text out of the query string without
 * pretending to know the full vocabulary, which is what a `z.enum` of the list above would do.
 *
 * Spaces are NOT folded into underscores, deliberately. It would look accommodating and be wrong:
 * the wire name for "Corp Action" is `ACTION_TYPE_CORPACTION`, so a caller typing the label they
 * saw would get a plausible `ACTION_TYPE_CORP_ACTION` sent on their behalf and an unexplained empty
 * result. Refusing it names the rule instead.
 */
function wireEnum(value: string, prefix: string, field: string): string {
  const upper = value.trim().toUpperCase();
  const full = upper.startsWith(prefix) ? upper : prefix + upper;
  if (!ENUM_RE.test(full)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${field} ${JSON.stringify(value)}: expected a name like ` +
        `${prefix}CROSS (letters, digits and underscores only)`,
    );
  }
  return full;
}

const ACTION_PREFIX = "ACTION_TYPE_";
const SOURCE_PREFIX = "SOURCE_TYPE_";
const NODE_PREFIX = "SHAREHOLDING_NETWORK_NODE_TYPE_";

/* ---------------------------------- envelope ---------------------------------- */

/**
 * The response envelope, and the reason it is not just `{data}`.
 *
 * This family reports failures **inside a 200**: Stockbit's own client checks `error` and
 * `error_type` on the body root and throws `message` before it looks at `data`. A caller that only
 * read `data` would see `null`, report an empty list, and call it success — which is exactly how a
 * refusal becomes "this insider has never traded".
 */
const Envelope = z
  .object({
    data: z.unknown().optional(),
    error: z.unknown().optional(),
    error_type: z.unknown().optional(),
    message: z.unknown().optional(),
  })
  .passthrough();

/** Present and meaningfully set. `""`, `0`, `false` and null all count as "not set". */
function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== "" && value !== 0;
}

/** Unwrap `data`, turning an in-body error into a thrown one. Returns `undefined` for no data. */
function unwrap(body: unknown, context: string): unknown {
  const parsed = parseOr(Envelope, body, context);
  if (truthy(parsed.error) || truthy(parsed.error_type)) {
    const said = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message : undefined;
    const type = typeof parsed.error_type === "string" ? parsed.error_type : undefined;
    throw new StockbitError(
      "upstream",
      said ?? `Stockbit returned an error for ${context} with HTTP 200 and no message`,
      { status: 200, errorType: type },
    );
  }
  return parsed.data ?? undefined;
}

/* ------------------------------- value readers ------------------------------- */

/**
 * A number out of a field that may be a bare number or a thousands-separated string.
 *
 * `undefined` means the field was not there or was not a number — never 0. `Number("")` being 0 is
 * the trap: a missing share count reported as zero reads as "sold everything".
 */
function numberish(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** A string out of a field that may be a string or a number (ids arrive as both). */
function stringish(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A boolean out of a flag that may be a boolean or its string spelling. `undefined` if neither. */
function boolish(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === 1 || value === "1") return true;
  if (value === "false" || value === 0 || value === "0") return false;
  return undefined;
}

/** Read `row[outer][inner]` without assuming `row[outer]` is an object. */
function nested(row: Record<string, unknown>, outer: string, inner: string): unknown {
  const child = row[outer];
  return child && typeof child === "object" ? (child as Record<string, unknown>)[inner] : undefined;
}

/** Set `key` only when the value exists, so a projection never blanks a raw field it sits beside. */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/* ----------------------------- transaction rows ----------------------------- */

/**
 * One disclosed change in an insider's holding.
 *
 * The named fields are derived; the raw row is spread underneath them, so anything Stockbit sends
 * that is not named here is still returned. The names are camelCase precisely so they cannot
 * shadow a wire field: the wire is snake_case throughout.
 */
export interface InsiderTransaction {
  /** The holder's id. This is the value `insider_ownership` and shareholding investors take. */
  insiderId?: string;
  /** The holder's name, from `name`. */
  holderName?: string;
  /** e.g. `ACTION_TYPE_CROSS`. See `INSIDER_ACTION_TYPES` — the list is partial. */
  actionType?: string;
  /** Shares added (positive) or removed (negative), from `changes.value`. */
  sharesChanged?: number;
  /** The change as a percentage of shares outstanding, from `changes.percentage`. */
  changePercent?: number;
  /** Holding before the transaction, from `previous`. */
  sharesBefore?: number;
  percentBefore?: number;
  /** Holding after it, from `current`. */
  sharesAfter?: number;
  percentAfter?: number;
  /** Executing broker, from `broker_detail`. `group` is BROKER_GROUP_{FOREIGN,LOCAL,GOVERNMENT}. */
  brokerCode?: string;
  brokerGroup?: string;
  /** IDX or KSEI, from `data_source.type`. */
  sourceType?: string;
  /** Everything the row carried, unmodified. */
  [key: string]: unknown;
}

/**
 * Project one movement row.
 *
 * `price_formatted`, `date`, `symbol`, `nationality` and `badges` are deliberately NOT re-exported
 * under new names: they arrive usable and copying them would only create a second place to be wrong.
 * `badges` is worth knowing about — `SHAREHOLDER_BADGE_DIREKTUR`, `_KOMISARIS` and `_PENGENDALI`
 * mark a director, a commissioner and a controlling shareholder, which is the difference between an
 * insider trade and a fund rebalancing.
 */
function projectTransaction(row: Record<string, unknown>): InsiderTransaction {
  const out: Record<string, unknown> = { ...row };
  put(out, "insiderId", stringish(row.id));
  put(out, "holderName", stringish(row.name));
  put(out, "actionType", stringish(row.action_type));
  put(out, "sharesChanged", numberish(nested(row, "changes", "value")));
  put(out, "changePercent", numberish(nested(row, "changes", "percentage")));
  put(out, "sharesBefore", numberish(nested(row, "previous", "value")));
  put(out, "percentBefore", numberish(nested(row, "previous", "percentage")));
  put(out, "sharesAfter", numberish(nested(row, "current", "value")));
  put(out, "percentAfter", numberish(nested(row, "current", "percentage")));
  put(out, "brokerCode", stringish(nested(row, "broker_detail", "code")));
  put(out, "brokerGroup", stringish(nested(row, "broker_detail", "group")));
  put(out, "sourceType", stringish(nested(row, "data_source", "type")));
  return out as InsiderTransaction;
}

const RowArray = z.array(z.record(z.unknown())).nullable().optional();

/* -------------------------- shared request validation -------------------------- */

/**
 * A holder id, for the `insider` query parameter.
 *
 * Looser than the transport's `insiderId` path validator on purpose. A query value cannot change
 * which route was called, so the only thing worth excluding is a character that would break the
 * query string; refusing a real id because it turned out not to be all digits would be the more
 * expensive mistake.
 */
function normalizeInsiderId(input: string, field = "insider"): string {
  const value = String(input).trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${field} ${JSON.stringify(input)}: expected a holder id as returned in the ` +
        "`insiderId` field of an insider_transactions row (letters, digits, _ or -)",
    );
  }
  return value;
}

/** A 1-based page number. Rejects 0, negatives and fractions rather than sending them. */
function normalizePage(input: number | undefined, field = "page"): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isInteger(input) || input < 1) {
    throw new StockbitError("invalid_param", `${field} must be a whole number of 1 or more, got ${input}`);
  }
  return input;
}

/**
 * Validate a two-ended window, refusing a half-specified one.
 *
 * Both ends or neither. A lone bound is rejected for the reason `src/core/dates.ts` documents at
 * length for this API: it answers a half-specified range with HTTP 200 and the default window, so
 * the caller believes they filtered when they did not. To leave one side open, pass a far date —
 * the error says so.
 */
function normalizeWindow(
  start: string | undefined,
  end: string | undefined,
  startField: string,
  endField: string,
): { start: string; end: string } | undefined {
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined || end === undefined) {
    const given = start === undefined ? endField : startField;
    const missing = start === undefined ? startField : endField;
    throw new StockbitError(
      "invalid_param",
      `A window needs both ends: got ${given} but no ${missing}. This API answers a ` +
        "half-specified range with its default window and HTTP 200, so it is refused here. " +
        `For an open end pass a far date (${startField}=2000-01-01 or ${endField}=2099-12-31).`,
    );
  }
  const from = normalizeTradeDate(start, startField);
  const to = normalizeTradeDate(end, endField);
  // ISO dates compare correctly as strings.
  if (from > to) {
    throw new StockbitError("invalid_param", `${startField} (${from}) must not be after ${endField} (${to})`);
  }
  return { start: from, end: to };
}

/* --------------------------- insider transactions --------------------------- */

export interface InsiderTransactionOptions {
  /** Restrict to one IDX ticker. Omit for the market-wide feed Stockbit's insider page shows. */
  symbol?: string;
  /** Restrict to one holder, by the id on a row. */
  insider?: string;
  dateStart?: string;
  dateEnd?: string;
  page?: number;
  limit?: number;
  actionType?: string;
  sourceType?: string;
}

export interface InsiderTransactions {
  symbol?: string;
  insider?: string;
  page: number;
  rows: InsiderTransaction[];
  /**
   * Whether another page exists, from `is_more`. `undefined` means the payload did not say —
   * which is not the same as "no more".
   */
  hasMore?: boolean;
  /**
   * Only set when `actionType` was requested: whether every returned row actually carries it.
   *
   * `action_type` is a filter Stockbit's own insider widget sends, but it has not been confirmed
   * against the wire from here, and this API's habit is to ignore a parameter it does not know and
   * answer 200 anyway. `false` means the filter was ignored and the rows are unfiltered — check it
   * before reporting "this insider only ever bought". `undefined` means no rows came back, so
   * nothing could be checked.
   */
  actionFilterHonored?: boolean;
  /** Whatever else the payload carried beside `movement`. */
  [key: string]: unknown;
}

/**
 * Build the query.
 *
 * Exported so the exact wire shape is assertable without a round trip. Absent options are absent,
 * not empty: Stockbit's older page bundle sends `insider=""` and `date_start=""` when the user has
 * not chosen one, and sending a parameter this project did not mean to send is the thing worth
 * avoiding of the two.
 */
export function buildInsiderTransactionParams(
  opts: InsiderTransactionOptions,
): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (opts.symbol !== undefined) params.symbol = normalizeSymbol(opts.symbol);
  if (opts.insider !== undefined) params.insider = normalizeInsiderId(opts.insider);

  const window = normalizeWindow(opts.dateStart, opts.dateEnd, "date_start", "date_end");
  if (window) {
    params.date_start = window.start;
    params.date_end = window.end;
  }

  // Both clients always send a page; 1 is their default too.
  params.page = normalizePage(opts.page) ?? 1;
  const limit = normalizePage(opts.limit, "limit");
  if (limit !== undefined) params.limit = limit;
  if (opts.actionType !== undefined) {
    params.action_type = wireEnum(opts.actionType, ACTION_PREFIX, "action_type");
  }
  if (opts.sourceType !== undefined) {
    params.source_type = wireEnum(opts.sourceType, SOURCE_PREFIX, "source_type");
  }
  return params;
}

const TransactionPayload = z
  .object({ movement: RowArray, is_more: z.unknown().optional() })
  .passthrough();

/** Disclosed insider transactions, newest first as Stockbit returns them. */
export async function getInsiderTransactions(
  opts: InsiderTransactionOptions = {},
): Promise<InsiderTransactions> {
  const params = buildInsiderTransactionParams(opts);
  // Keyed on the whole param set: a different action filter, page or window is a different answer,
  // and collapsing any of them would serve one query's rows to another.
  const key = `insiderTransactions:${JSON.stringify(params)}`;

  return cached(key, CACHE.keystatsTtlMs, async () => {
    const data = unwrap(await getJson("insiderTransactions", { params }), "insider transactions");
    const base = {
      symbol: typeof params.symbol === "string" ? params.symbol : undefined,
      insider: typeof params.insider === "string" ? params.insider : undefined,
      page: params.page as number,
    };
    if (data === undefined || data === null) return { ...base, rows: [] };

    const { movement, ...rest } = parseOr(TransactionPayload, data, "insider transactions");
    const rows = (movement ?? []).map(projectTransaction);
    const wanted = params.action_type;
    return {
      ...rest,
      ...base,
      rows,
      hasMore: boolish(rest.is_more),
      actionFilterHonored:
        wanted === undefined || rows.length === 0
          ? undefined
          : rows.every((row) => row.actionType === wanted),
    };
  });
}

/* ----------------------------- insider ownership ----------------------------- */

export interface InsiderPosition {
  /** Recent disclosed changes in this position, projected like `insider_transactions` rows. */
  recent: InsiderTransaction[];
  /** Whether this position has more history on a further page, from its own `is_more`. */
  hasMore?: boolean;
  /** Everything else the position row carried, including its `symbol` and `company_name`. */
  [key: string]: unknown;
}

export interface InsiderOwnership {
  insiderId: string;
  /** The holder's name, from `insider_name`. */
  insiderName?: string;
  page: number;
  positions: InsiderPosition[];
  /** Whatever else the payload carried beside `ownership`. */
  [key: string]: unknown;
}

export interface InsiderOwnershipOptions {
  insider: string;
  /** Narrow to one held ticker. */
  symbol?: string;
  page?: number;
  sourceType?: string;
}

/** Build the ownership query. Exported for the same reason as the transaction one. */
function buildInsiderOwnershipParams(
  opts: InsiderOwnershipOptions,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    insider: normalizeInsiderId(opts.insider),
    page: normalizePage(opts.page) ?? 1,
  };
  if (opts.symbol !== undefined) params.symbol = normalizeSymbol(opts.symbol);
  if (opts.sourceType !== undefined) {
    params.source_type = wireEnum(opts.sourceType, SOURCE_PREFIX, "source_type");
  }
  return params;
}

const OwnershipPayload = z
  .object({ ownership: RowArray, insider_name: z.unknown().optional() })
  .passthrough();

/**
 * Every position one holder has disclosed, with the recent changes to each.
 *
 * `page` walks each position's `recent` list, not the list of positions — Stockbit's client appends
 * the new `recent` rows onto the position it already has and re-reads that position's `is_more`.
 */
export async function getInsiderOwnership(opts: InsiderOwnershipOptions): Promise<InsiderOwnership> {
  const params = buildInsiderOwnershipParams(opts);
  const key = `insiderOwnership:${JSON.stringify(params)}`;

  return cached(key, CACHE.keystatsTtlMs, async () => {
    const data = unwrap(await getJson("insiderOwnership", { params }), "insider ownership");
    const base = { insiderId: params.insider as string, page: params.page as number };
    if (data === undefined || data === null) return { ...base, positions: [] };

    const { ownership, ...rest } = parseOr(OwnershipPayload, data, "insider ownership");
    const positions = (ownership ?? []).map((row) => {
      const { recent, ...position } = row;
      return {
        ...position,
        recent: (Array.isArray(recent) ? recent : []).map((entry) =>
          projectTransaction(entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {}),
        ),
        hasMore: boolish(row.is_more),
      };
    });
    return {
      ...rest,
      ...base,
      insiderName: stringish(rest.insider_name),
      positions,
    };
  });
}

/* ------------------------------- shareholding ------------------------------- */

/**
 * A shareholding payload, returned whole.
 *
 * Only two things are added: which key the list of holdings arrived under, and how many entries it
 * had. Stockbit's own ownership page reads `holders ?? holdings` — its authors did not know which
 * one the server sends either — so reporting the answer is more useful than picking one and
 * silently returning nothing when it is the other.
 *
 * `entriesFrom: null` with `entryCount: null` means neither key was present, which is a different
 * fact from a holder list that came back empty.
 */
export interface Shareholding {
  mode: ShareholdingMode;
  /** The symbol (companies), holder id (investors) or root id (network) that was asked for. */
  subject: string;
  /** Which key the main list came from, or null when none of the candidates was present. */
  entriesFrom: string | null;
  /** How many entries it held, or null when there was no such key. Zero is a real, empty answer. */
  entryCount: number | null;
  /**
   * Companies mode only: the numeric company id the ticker resolved to, which is what the request
   * was actually addressed with. It is also the `root_id` for `mode="network"`.
   */
  companyId?: string;
  /** Network mode only: how many nodes the graph carried, or null when there was no `nodes` key. */
  nodeCount?: number | null;
  /** The payload, unprojected. */
  data: unknown;
}

/** First present array among `keys`, with the key it came from. */
function firstArray(
  data: unknown,
  keys: readonly string[],
): { from: string | null; count: number | null } {
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) return { from: key, count: (record[key] as unknown[]).length };
    }
  }
  return { from: null, count: null };
}

/**
 * Who holds a company.
 *
 * ## The path segment is a company id, and it was being sent a ticker
 *
 * `shareholding(mode="companies", symbol="DEWA")` answered `400 {"error":"Invalid company id"}`,
 * because the ticker went straight into the `{symbol}` segment of
 * `/insider/shareholding/companies/{…}` and the endpoint wants Stockbit's internal numeric id
 * (`"134"` for DEWA). There was no argument that made this mode work.
 *
 * The id is resolved here rather than exposed as a parameter, so the documented interface stays a
 * ticker — which is what a caller has. `resolveCompanyId` is the same reader `watchlist_add`
 * already uses, and it reads the id off the `emitten/{symbol}/info` row that `quote` is written
 * against, so the id itself is observed rather than guessed. It costs one extra request, cached.
 *
 * `subject` stays the ticker that was asked for; `companyId` says what was actually sent, because
 * a caller comparing this against `mode="network"` needs the id and would otherwise have to go and
 * find it a second time.
 */
export async function getShareholdingCompanies(symbol: string): Promise<Shareholding> {
  const sym = normalizeSymbol(symbol);
  return cached(`shareholding:companies:${sym}`, CACHE.keystatsTtlMs, async () => {
    const companyId = await resolveCompanyId(sym);
    // Tested for being a NUMBER, not merely for being present. The quote row reads its id through
    // `z.coerce.string()`, and `String(null)` is the four-character string "null" — truthy, and
    // exactly the kind of value that reaches a URL looking like an id. The transport's numeric
    // validator would refuse it a moment later, but with a message about a malformed id rather
    // than the true one: Stockbit has no id for this ticker.
    if (companyId === undefined || !/^[0-9]+$/.test(companyId)) {
      throw new StockbitError(
        "not_found",
        `${sym} has no company id on Stockbit, and this endpoint is addressed by company id rather ` +
          `than by ticker, so the register cannot be read for it. Check the ticker.`,
      );
    }
    const data = unwrap(
      await getJson("shareholdingCompanies", { segments: { companyId } }),
      "shareholding companies",
    );
    const { from, count } = firstArray(data, ["holders", "holdings"]);
    return {
      mode: "companies" as const,
      subject: sym,
      companyId,
      entriesFrom: from,
      entryCount: count,
      data,
    };
  });
}

/** What one holder holds, across every company. */
export async function getShareholdingInvestors(insiderId: string): Promise<Shareholding> {
  const id = normalizeInsiderId(insiderId, "insider_id");
  return cached(`shareholding:investors:${id}`, CACHE.keystatsTtlMs, async () => {
    const data = unwrap(
      // The transport validates this segment as a numeric id; a non-numeric holder id would be
      // refused there rather than reaching the URL.
      await getJson("shareholdingInvestors", { segments: { insiderId: id } }),
      "shareholding investors",
    );
    const { from, count } = firstArray(data, ["holdings", "holders"]);
    return { mode: "investors" as const, subject: id, entriesFrom: from, entryCount: count, data };
  });
}

export interface ShareholdingNetworkOptions {
  /** The company id or holder id the graph is centred on. */
  rootId: string;
  /** COMPANY or INVESTOR — which kind of id `rootId` is. */
  rootType: string;
  /** How many hops out. Stockbit's own page uses 3. */
  maxDepth?: number;
  /** How many edges to keep per node. Stockbit's own page uses 20. */
  maxEdgePerNode?: number;
  /** Pin the graph to one report date. Format assumed YYYY-MM-DD; unverified. */
  reportDate?: string;
}

/** Build the network query. Exported so the defaults and spellings are assertable offline. */
export function buildShareholdingNetworkParams(
  opts: ShareholdingNetworkOptions,
): Record<string, string | number> {
  const params: Record<string, string | number> = {
    root_id: normalizeInsiderId(opts.rootId, "root_id"),
    root_type: wireEnum(opts.rootType, NODE_PREFIX, "root_type"),
  };
  if (opts.maxDepth !== undefined) params.max_depth = normalizePage(opts.maxDepth, "max_depth") as number;
  if (opts.maxEdgePerNode !== undefined) {
    params.max_edge_per_node = normalizePage(opts.maxEdgePerNode, "max_edge_per_node") as number;
  }
  if (opts.reportDate !== undefined) params.report_date = normalizeTradeDate(opts.reportDate, "report_date");
  return params;
}

/**
 * The ownership graph around one node.
 *
 * A root is required. Stockbit's own page never issues this request without one — it holds the
 * query disabled until a company or investor has been selected — so a rootless call is untested
 * rather than merely unusual, and an id is always available from the two views above.
 */
export async function getShareholdingNetwork(
  opts: ShareholdingNetworkOptions,
): Promise<Shareholding> {
  const params = buildShareholdingNetworkParams(opts);
  const key = `shareholding:network:${JSON.stringify(params)}`;
  return cached(key, CACHE.keystatsTtlMs, async () => {
    const data = unwrap(await getJson("shareholdingNetwork", { params }), "shareholding network");
    // `links` is what the payload the page builds its graph from carries; `edges` is the fallback
    // its own normalizer checks. Reporting which arrived beats guessing.
    const { from, count } = firstArray(data, ["links", "edges"]);
    const nodes = firstArray(data, ["nodes"]);
    return {
      mode: "network" as const,
      subject: params.root_id as string,
      entriesFrom: from,
      entryCount: count,
      nodeCount: nodes.count,
      data,
    };
  });
}

/* --------------------------- ownership composition --------------------------- */

export interface OwnershipComposition {
  symbol: string;
  periodStart?: string;
  periodEnd?: string;
  /** The payload, unprojected — this shape has not been mapped at all. */
  data: unknown;
}

/**
 * How a company's ownership is split, over a period.
 *
 * Nothing about the response is projected: unlike the transaction rows, no consumer of this
 * endpoint was available to read field names out of, so every name would be a guess. The envelope
 * is still validated and an in-body error still throws.
 */
export async function getOwnershipComposition(
  symbol: string,
  periodStart?: string,
  periodEnd?: string,
): Promise<OwnershipComposition> {
  const sym = normalizeSymbol(symbol);
  const window = normalizeWindow(periodStart, periodEnd, "period_start", "period_end");
  const params: Record<string, string> = {};
  if (window) {
    params.period_start = window.start;
    params.period_end = window.end;
  }
  const key = `ownershipComposition:${sym}:${JSON.stringify(params)}`;

  return cached(key, CACHE.keystatsTtlMs, async () => {
    const data = unwrap(
      await getJson("shareholdingComposition", { segments: { symbol: sym }, params }),
      "ownership composition",
    );
    return { symbol: sym, periodStart: window?.start, periodEnd: window?.end, data };
  });
}
