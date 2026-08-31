/**
 * Who a company is, rather than what its price did: profile, contact, subsidiaries, shareholders,
 * classification, index and sector membership, and symbol search.
 *
 *   GET  /emitten/{symbol}/profile                        → the company description block
 *   GET  /emitten/{symbol}/contact                        → registered address, IR contacts
 *   GET  /emitten/v2/{emittenType}/{symbol}/info          → the typed (statement-vocabulary) view
 *   GET  /emitten/v2/{emittenType}/{symbol}/fin-items     → the line items that vocabulary defines
 *   GET  /emitten-metadata/subsidiary/{symbol}            → subsidiaries and associates
 *   POST /emitten-metadata/shareholders/token             → one-shot token for the chart below
 *   GET  /emitten-metadata/shareholders/{symbol}/chart    → ownership composition over time
 *   GET  /emitten/classification[/company]                → the classification scheme, and per-company
 *   GET  /emitten/indexes/{indexCode}?limit               → index constituents
 *   GET  /emitten/v3/sector/{sectorId}/company            → the companies in one sector
 *   GET  /search/v2?keyword&page&type&insider_category    → search
 *   GET  /search?keyword                                  → the older search
 *
 * ## None of these has been observed on the wire
 *
 * Every endpoint above is wired from Stockbit's own client surface, not from a captured response.
 * That is the constraint this whole module is written around: the envelopes are permissive, no inner
 * field is required, and where the rows live inside `data` is *located* rather than assumed. A
 * schema that demanded `data.result` would turn a working endpoint into a `schema_drift` error on
 * the first real call, and a projection that assumed it would report a populated response as empty —
 * which is worse, because it looks like an answer.
 *
 * So the shared primitive here is `RowSet`: rows, plus **where they were found**, plus everything
 * else the envelope carried. `rows: [], source: "data"` means the endpoint said zero. `rows: [],
 * source: null` means this code could not find the array and `extra` holds what `data` did contain.
 * Collapsing those two into a bare `[]` is the failure mode that costs a day to notice.
 */
import { z } from "zod";
import { getJson, postJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { normalizeSymbol } from "../symbol.js";
import { StockbitError } from "../http/errors.js";

/* --------------------------- envelope + row location --------------------------- */

/**
 * The weakest envelope that still catches a non-JSON body: `data` may be anything, including
 * absent. Everything downstream inspects the value instead of trusting a schema for it.
 */
const RawEnvelope = z.object({ data: z.unknown() }).passthrough();

/** A body's `data`, or null when the endpoint sent none. Never `undefined`: absence must be visible. */
function dataOf(body: unknown, context: string): unknown {
  const { data } = parseOr(RawEnvelope, body, context);
  return data === undefined ? null : data;
}

/**
 * Keys that have been seen wrapping a row array elsewhere in this API, in the order they are tried.
 *
 * `result` leads because that is where the watchlist DETAIL route puts its rows while the watchlist
 * INDEX route returns a bare array — the two endpoints of one feature already disagree, so a single
 * assumed spelling was never going to hold across eleven unprobed ones.
 */
const ROW_KEYS = ["result", "results", "companies", "company", "items", "list", "rows", "data"] as const;

export interface RowSet {
  /** The rows, verbatim and in the order the endpoint returned them. */
  rows: unknown[];
  /**
   * Where the rows were read from: `data` when `data` was itself an array, `data.<key>` when it was
   * wrapped, or **null** when nothing array-shaped was found.
   *
   * `rows: [], source: "data"` is a genuine empty answer. `rows: [], source: null` is this code
   * failing to locate them, and `extra` then holds the whole object so the miss is diagnosable
   * without a second probe.
   */
  source: string | null;
  /**
   * Whatever `data` carried besides the rows: the leftover keys when it was an object, or `data`
   * itself when it was neither an array nor an object. Absent when `data` WAS the array.
   */
  extra?: unknown;
}

/** Locate the row array inside an envelope without assuming which key holds it. */
function rowsOf(body: unknown, context: string): RowSet {
  const data = dataOf(body, context);
  if (Array.isArray(data)) return { rows: data, source: "data" };
  if (data === null || typeof data !== "object") {
    return { rows: [], source: null, ...(data === null ? {} : { extra: data }) };
  }

  const object = data as Record<string, unknown>;
  const rest = (chosen: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(object).filter(([key]) => key !== chosen));

  for (const key of ROW_KEYS) {
    if (Array.isArray(object[key])) {
      return { rows: object[key] as unknown[], source: `data.${key}`, extra: rest(key) };
    }
  }
  // No known spelling. One array and one only is unambiguous; two would be a coin toss, and picking
  // wrong there returns half a response as if it were all of it.
  const arrays = Object.entries(object).filter(([, value]) => Array.isArray(value));
  if (arrays.length === 1) {
    const [key, value] = arrays[0];
    return { rows: value as unknown[], source: `data.${key}`, extra: rest(key) };
  }
  return { rows: [], source: null, extra: object };
}

/**
 * Tickers read off rows that carry a string `symbol`, with a count of the rows that did not.
 *
 * `symbol` is not a guess: every emitten-shaped row already mapped in this codebase carries it
 * (`getSectors`, the watchlist members, the screener's `company` block). It is still reported
 * defensively — a non-zero `rowsWithoutSymbol` means the ticker list is not the whole answer and
 * the caller should read `rows`.
 */
function symbolsIn(rows: unknown[]): { symbols: string[]; rowsWithoutSymbol: number } {
  const symbols: string[] = [];
  let rowsWithoutSymbol = 0;
  for (const row of rows) {
    const value = row && typeof row === "object" ? (row as Record<string, unknown>).symbol : undefined;
    if (typeof value === "string" && value.trim() !== "") symbols.push(value);
    else rowsWithoutSymbol++;
  }
  return { symbols, rowsWithoutSymbol };
}

/* ---------------------------------- profile ---------------------------------- */

/**
 * The statement-vocabulary selector in the v2 emitten paths.
 *
 * `company` is the only value observed. Banks, insurers and other issuers whose statements have a
 * different shape use another one that nobody here has seen, so it is an override rather than an
 * enum: refusing an unknown value would make the whole vocabulary unreachable, and inventing the
 * list would make a wrong one look supported.
 */
const DEFAULT_EMITTEN_TYPE = "company";

/** Normalize a caller's emitten type. The transport enforces the charset; this fixes the casing. */
function emittenTypeOf(value: string | undefined): string {
  return (value ?? DEFAULT_EMITTEN_TYPE).trim().toLowerCase();
}

export interface CompanyProfile {
  symbol: string;
  /** The profile body verbatim. `null` when the endpoint returned no `data` at all. */
  profile: unknown;
  /** The vocabulary used for the two fields below. Absent when neither was requested. */
  emittenType?: string;
  /** Present only when asked for. */
  typedInfo?: unknown;
  finItems?: unknown;
}

/** The profile block alone. */
async function getProfile(symbol: string): Promise<unknown> {
  const sym = normalizeSymbol(symbol);
  return cached(`companyProfile:${sym}`, CACHE.keystatsTtlMs, async () =>
    dataOf(await getJson("emittenProfile", { segments: { symbol: sym } }), "company profile"),
  );
}

/** The typed view of a company, under one statement vocabulary. */
async function getTypedInfo(symbol: string, emittenType?: string): Promise<unknown> {
  const sym = normalizeSymbol(symbol);
  const type = emittenTypeOf(emittenType);
  return cached(`companyTypedInfo:${sym}:${type}`, CACHE.keystatsTtlMs, async () =>
    dataOf(
      await getJson("emittenTypedInfo", { segments: { emittenType: type, symbol: sym } }),
      "typed company info",
    ),
  );
}

/** The financial line items one statement vocabulary defines for this company. */
async function getFinItems(symbol: string, emittenType?: string): Promise<unknown> {
  const sym = normalizeSymbol(symbol);
  const type = emittenTypeOf(emittenType);
  return cached(`companyFinItems:${sym}:${type}`, CACHE.keystatsTtlMs, async () =>
    dataOf(
      await getJson("emittenFinItems", { segments: { emittenType: type, symbol: sym } }),
      "company fin-items",
    ),
  );
}

/**
 * The profile, optionally with the two v2 views beside it.
 *
 * The extras are opt-in because each is a separate upstream request and neither is what "profile"
 * means to a caller who just wants the company description. Composition is deliberately not cached
 * here: each part carries its own cache entry under its own key, so asking for the profile twice
 * with different extras cannot serve one answer for the other.
 */
export async function getCompanyProfile(
  symbol: string,
  opts: { typedInfo?: boolean; finItems?: boolean; emittenType?: string } = {},
): Promise<CompanyProfile> {
  const sym = normalizeSymbol(symbol);
  const wantsTyped = opts.typedInfo === true;
  const wantsItems = opts.finItems === true;
  const type = emittenTypeOf(opts.emittenType);

  const [profile, typedInfo, finItems] = await Promise.all([
    getProfile(sym),
    wantsTyped ? getTypedInfo(sym, type) : Promise.resolve(undefined),
    wantsItems ? getFinItems(sym, type) : Promise.resolve(undefined),
  ]);

  return {
    symbol: sym,
    profile,
    ...(wantsTyped || wantsItems ? { emittenType: type } : {}),
    ...(wantsTyped ? { typedInfo } : {}),
    ...(wantsItems ? { finItems } : {}),
  };
}

/** Registered address and investor-relations contacts. */
export async function getContact(symbol: string): Promise<unknown> {
  const sym = normalizeSymbol(symbol);
  return cached(`companyContact:${sym}`, CACHE.keystatsTtlMs, async () =>
    dataOf(await getJson("emittenContact", { segments: { symbol: sym } }), "company contact"),
  );
}

/** Subsidiaries and associates. `source: null` means the rows were not where this code looked. */
export async function getSubsidiaries(symbol: string): Promise<RowSet & { symbol: string }> {
  const sym = normalizeSymbol(symbol);
  return cached(`companySubsidiaries:${sym}`, CACHE.keystatsTtlMs, async () => ({
    symbol: sym,
    ...rowsOf(await getJson("emittenSubsidiary", { segments: { symbol: sym } }), "subsidiaries"),
  }));
}

/* -------------------------------- shareholders -------------------------------- */

/**
 * The bounds a `value_year` must fall inside. Nothing outside them is a year anyone means, and the
 * point of checking is that a typo (`202`, `20255`) is refused here rather than becoming a
 * confidently empty chart.
 */
const MIN_VALUE_YEAR = 1990;
const MAX_VALUE_YEAR = 2100;

/**
 * Pull a token out of the minting response without betting on one field name.
 *
 * The response shape is unobserved. Rather than assume `data.token`, any string value under a key
 * whose name contains "token" is accepted, named keys before nested ones and depth-bounded — the
 * main session's own refresh route nests its payload two deep (`data.data`), so a flat read would
 * already be wrong once in this codebase.
 */
function tokenIn(value: unknown, depth = 0): string | undefined {
  if (depth >= 4 || value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  // Named keys first, at every level, so a `token` two deep beats an unrelated string one deep.
  for (const [key, nested] of entries) {
    if (/token/i.test(key) && typeof nested === "string" && nested.trim() !== "") return nested;
  }
  for (const [, nested] of entries) {
    const found = tokenIn(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Mint the one-shot token the shareholder chart is gated behind.
 *
 * **No request body is sent.** The body this endpoint expects is unobserved, and sending a guessed
 * one is the riskier of the two mistakes: an absent body can only ever be an absent body, while a
 * guessed `{symbol}` could be read as a filter nobody asked for. If a live probe shows it needs one,
 * that is a one-line change with a captured request behind it.
 *
 * Never cached. A one-shot credential served from a TTL cache is a second call that fails for a
 * reason the caller cannot see.
 */
async function mintShareholdersToken(): Promise<string> {
  const body = await postJson("shareholdersToken");
  const data = dataOf(body, "shareholders token");
  // A bare-string `data` is the token itself; anything else is searched by key name. The search is
  // deliberately not "any string in the payload" — that would happily return a message or a status.
  // Observed 2026-08-29: the endpoint answers {"message":"Successfully retrieved Token","data":
  // {"value":"<64 hex>"}}. The token sits under `value`, which no /token/i key search can find, and
  // `message` is the only string that mentions the word — so this had always thrown `schema_drift`.
  // Read narrowly, from `data.value` on this one route, rather than by loosening `tokenIn` into
  // "any string called value" and letting it grab an unrelated field on some other payload.
  const fromValue =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).value
      : undefined;
  const token =
    typeof data === "string" && data.trim() !== ""
      ? data
      : typeof fromValue === "string" && fromValue.trim() !== ""
        ? fromValue
        : tokenIn(body);
  if (!token) {
    // Key names only. The token value must not reach a message that may be logged.
    const keys = body && typeof body === "object" ? Object.keys(body as Record<string, unknown>) : [];
    throw new StockbitError(
      "schema_drift",
      `The shareholders token endpoint returned no token-shaped field (top-level keys: ${
        keys.join(", ") || "none"
      })`,
    );
  }
  return token;
}

/**
 * The refusal the shareholder chart answers when it will not take the minted token.
 *
 * `WebViewToken.FromContext` is the gateway naming the token it looked for and did not find, which
 * is what makes it a placement signal rather than a generic auth failure. Anchored on that phrase
 * and on `Unauthenticated` so a reworded envelope around the same refusal still matches.
 */
const WEBVIEW_TOKEN_REFUSAL = /WebViewToken|Unauthenticated/i;

/**
 * Read the chart with the minted token, and say what a refusal here actually means.
 *
 * **UNVERIFIED: where the minted token belongs.** It is sent as a `token` query parameter, which is
 * the placement the e-IPO refresh uses, but no capture of this call exists — if the chart answers
 * 401 with a valid session, the placement is the first thing to move (a header, or the body of a
 * POST variant).
 *
 * That prediction fired. A 2026-08-31 field report got
 * `rpc error: code = Unauthenticated desc = WebViewToken.FromContext: User Not Found` (401) from
 * this call in a session where `insider_transactions`, `broker_summary` and `chartbit_layouts` all
 * succeeded at the same moment. Two requests were spent to be told nothing.
 *
 * ## Measured 2026-09-01: the query parameter makes no difference
 *
 * The same call was made three ways on a working credential — with a freshly minted token, with
 * no `token` parameter at all, and with `token=notarealtoken`. All three answered the identical
 * 401 with the identical body. A parameter the server reads would be expected to tell a garbage
 * value apart from a valid one somehow, so this is strong evidence the `token` query parameter is
 * not read here at all and the placement is simply wrong.
 *
 * It is not left as PROOF, and nothing is changed on the strength of it: a request refused at the
 * same gate every time cannot fully distinguish "the parameter was ignored" from "the parameter
 * was read and the token rejected for some other reason". What it does settle is that no value in
 * that query parameter will make this call work, so the next person should not spend time on the
 * token's VALUE. The remaining candidates are a header and a POST body, and choosing between them
 * takes a capture of Stockbit's own request — DevTools on the ownership view of a symbol page,
 * which is a thing a person does in a browser, not something this server can do to itself.
 *
 * The placement still cannot be corrected from here — moving it without a capture would be
 * replacing one guess with another, and the honest thing is to say which guess is standing. So the
 * 401 is re-raised carrying the diagnosis instead of the raw gateway string: this is a token
 * PLACEMENT failure, not a session failure and not an entitlement the account lacks. Getting that
 * reading for free is what turned a dead end into a five-second diagnosis in the field.
 */
async function readShareholdersChart(
  sym: string,
  valueYear: number | undefined,
  type: string | undefined,
  token: string,
): Promise<unknown> {
  try {
    return await getJson("shareholdersChart", {
      segments: { symbol: sym },
      // `symbol` is sent as a query parameter as well as a path segment because Stockbit's own
      // client sends both. Duplication is cheap; a missing filter is a wrong answer.
      params: { symbol: sym, value_year: valueYear, shareholder_type: type, token },
    });
  } catch (error) {
    // Matched on the KIND *or* the body text, because the two things the field recorded are not
    // the same strength. The `WebViewToken.FromContext: User Not Found` string was copied out of a
    // response; the 401 beside it is the reporter's annotation and no status for this failure is
    // written down anywhere in this repo. A gateway that answered the same rpc error under some
    // other status would slip past a kind-only test and hand the caller back the raw string —
    // which is the exact dead end this whole branch exists to remove.
    if (error instanceof StockbitError && (error.kind === "auth" || WEBVIEW_TOKEN_REFUSAL.test(error.message))) {
      throw new StockbitError(
        "auth",
        `The shareholder chart refused the one-shot token it just minted for ${sym}. This is not ` +
          `your session: the token was minted seconds earlier on the same credential, and the ` +
          `same call answers this identically with a valid token, with no token and with a junk ` +
          `token (measured 2026-09-01), so the \`token\` query parameter this client sends is not ` +
          `the placement the endpoint reads. No value will fix it. Where the token really belongs ` +
          `— a header, or a POST body — takes a capture of Stockbit's own request to settle, so ` +
          `this tool is expected to fail until someone makes one. Read the register through ` +
          `company_profile's \`shareholder_one_percent\` instead; it carries holders, percentages ` +
          `and the scrip/scripless split. Upstream said: ${error.message}`,
        { status: error.status },
      );
    }
    throw error;
  }
}

export interface Shareholders extends RowSet {
  symbol: string;
  /** Echoed back so a cached answer can be told apart from the one that was asked for. */
  valueYear?: number;
  shareholderType?: string;
}

/**
 * Ownership composition for a symbol.
 *
 * Two requests: the token is minted, then spent immediately on the chart. The minted token is
 * **not** returned to the caller — it is a credential, and the caller has no use for a spent one.
 */
export async function getShareholders(
  symbol: string,
  valueYear?: number,
  shareholderType?: string,
): Promise<Shareholders> {
  const sym = normalizeSymbol(symbol);
  if (valueYear !== undefined) {
    if (!Number.isInteger(valueYear) || valueYear < MIN_VALUE_YEAR || valueYear > MAX_VALUE_YEAR) {
      throw new StockbitError(
        "invalid_param",
        `Invalid value_year ${JSON.stringify(valueYear)}: expected a whole year between ` +
          `${MIN_VALUE_YEAR} and ${MAX_VALUE_YEAR}`,
      );
    }
  }
  const type = shareholderType?.trim();
  if (type === "") {
    throw new StockbitError("invalid_param", "shareholder_type must not be empty; omit it instead");
  }

  const key = `shareholders:${sym}:${valueYear ?? "-"}:${type ?? "-"}`;
  return cached(key, CACHE.keystatsTtlMs, async () => {
    const token = await mintShareholdersToken();
    const body = await readShareholdersChart(sym, valueYear, type, token);
    return {
      symbol: sym,
      ...(valueYear !== undefined ? { valueYear } : {}),
      ...(type !== undefined ? { shareholderType: type } : {}),
      ...rowsOf(body, "shareholders chart"),
    };
  });
}

/* ------------------------------- classification ------------------------------- */

/**
 * Which classification endpoint to read.
 *
 * `taxonomy` is the scheme itself; `company` is the per-company assignment list. They are separate
 * paths rather than a parameter, so the choice is named here instead of being a boolean nobody can
 * read at a call site.
 */
export const CLASSIFICATION_SCOPES = ["taxonomy", "company"] as const;
export type ClassificationScope = (typeof CLASSIFICATION_SCOPES)[number];

export async function getClassification(scope: ClassificationScope = "taxonomy"): Promise<RowSet> {
  return cached(`classification:${scope}`, CACHE.keystatsTtlMs, async () =>
    rowsOf(
      await getJson(scope === "company" ? "emittenClassificationCompany" : "emittenClassification"),
      `classification ${scope}`,
    ),
  );
}

/* ---------------------------- index / sector members ---------------------------- */

/** Stockbit's cap on `limit`. Asking for more is not an error; it simply does not give more. */
export const INDEX_MEMBERS_MAX_LIMIT = 500;

export interface MemberList extends RowSet {
  /** Tickers taken from the rows that carried a `symbol`. */
  symbols: string[];
  /** Rows with no string `symbol`. Non-zero means `symbols` is not the whole list — read `rows`. */
  rowsWithoutSymbol: number;
}

/**
 * The constituents of an index (IDX30, LQ45, and the special-board lists).
 *
 * `limit` is **required** by the endpoint: omitting it does not mean "everything". It is therefore a
 * required argument here too, and it is part of the cache key — a key that dropped it would answer a
 * request for 100 rows with the 10 somebody asked for first, which is the exact bug this codebase
 * already shipped once on the per-symbol stream route.
 *
 * Cached briefly rather than as a directory: constituent rows are expected to carry a last price.
 */
export async function getIndexMembers(indexCode: string, limit: number): Promise<MemberList & { indexCode: string; limit: number }> {
  const code = String(indexCode).trim().toUpperCase();
  if (!Number.isInteger(limit) || limit < 1 || limit > INDEX_MEMBERS_MAX_LIMIT) {
    throw new StockbitError(
      "invalid_param",
      `Invalid limit ${JSON.stringify(limit)}: expected a whole number between 1 and ${INDEX_MEMBERS_MAX_LIMIT}`,
    );
  }
  return cached(`indexMembers:${code}:${limit}`, CACHE.defaultTtlMs, async () => {
    const set = rowsOf(
      await getJson("indexMembers", { segments: { indexCode: code }, params: { limit } }),
      "index members",
    );
    return { indexCode: code, limit, ...set, ...symbolsIn(set.rows) };
  });
}

/**
 * The companies in one sector. `sectorId` is the numeric id from `sectors` (`getSectors`), not a
 * sector name — the transport rejects anything that is not digits.
 */
export async function getSectorCompanies(sectorId: string): Promise<MemberList & { sectorId: string }> {
  const id = String(sectorId).trim();
  return cached(`sectorCompanies:${id}`, CACHE.defaultTtlMs, async () => {
    const set = rowsOf(
      await getJson("sectorCompanies", { segments: { sectorId: id } }),
      "sector companies",
    );
    return { sectorId: id, ...set, ...symbolsIn(set.rows) };
  });
}

/* ----------------------------------- search ----------------------------------- */

/**
 * Which search endpoint to call.
 *
 * `v2` is the one Stockbit's own client uses and the only one that accepts paging and filters;
 * `legacy` is the older keyword-only path, kept because it is a smaller surface to fall back to if
 * v2 turns out to be gated.
 */
export const SEARCH_VARIANTS = ["v2", "legacy"] as const;
export type SearchVariant = (typeof SEARCH_VARIANTS)[number];

export interface SearchResult extends RowSet {
  keyword: string;
  variant: SearchVariant;
  page?: number;
  type?: string;
  insiderCategory?: string;
  /** Tickers off the rows that carried one. Search matches people and posts too, so this can be short. */
  symbols: string[];
  rowsWithoutSymbol: number;
}

export interface SearchOptions {
  variant?: SearchVariant;
  page?: number;
  type?: string;
  insiderCategory?: string;
}

/**
 * Search Stockbit's directory by keyword.
 *
 * The filters are refused rather than dropped on the legacy variant. Silently ignoring `page` would
 * return page 1 to a caller paging through results and look like the end of the list.
 *
 * Cached for seconds rather than minutes: search rows are expected to carry a last price.
 */
export async function search(keyword: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const term = typeof keyword === "string" ? keyword.trim() : "";
  if (term === "") {
    throw new StockbitError("invalid_param", "A search keyword is required and must not be blank");
  }
  const variant: SearchVariant = opts.variant ?? "v2";
  if (!SEARCH_VARIANTS.includes(variant)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid search variant ${JSON.stringify(variant)}: expected ${SEARCH_VARIANTS.join(" or ")}`,
    );
  }
  if (opts.page !== undefined && (!Number.isInteger(opts.page) || opts.page < 1)) {
    throw new StockbitError("invalid_param", `Invalid page ${JSON.stringify(opts.page)}: expected a whole number from 1`);
  }
  const type = opts.type?.trim() || undefined;
  const insiderCategory = opts.insiderCategory?.trim() || undefined;
  if (variant === "legacy" && (opts.page !== undefined || type !== undefined || insiderCategory !== undefined)) {
    throw new StockbitError(
      "invalid_param",
      "The legacy search takes only a keyword. Use variant \"v2\" for page, type or insider_category.",
    );
  }

  // JSON rather than a colon-joined string: three of these five parts are free text, and a
  // colon-joined key lets one caller's keyword collide with another's type filter.
  const key = `search:${JSON.stringify([variant, term, opts.page ?? null, type ?? null, insiderCategory ?? null])}`;
  return cached(key, CACHE.defaultTtlMs, async () => {
    const body =
      variant === "legacy"
        ? await getJson("search", { params: { keyword: term } })
        : await getJson("searchV2", {
            params: { keyword: term, page: opts.page, type, insider_category: insiderCategory },
          });
    const set = rowsOf(body, `search ${variant}`);
    return {
      keyword: term,
      variant,
      ...(opts.page !== undefined ? { page: opts.page } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(insiderCategory !== undefined ? { insiderCategory } : {}),
      ...set,
      ...symbolsIn(set.rows),
    };
  });
}

/* -------------------------------- company overview -------------------------------- */

/**
 * The five blocks the quote projection throws away.
 *
 * Recorded in `docs/research/2026-08-05-capability-research.md` from a live emittenInfo payload:
 * "returns `indexes[]`, `catalogs[]`, `uma`, `notation[]`, `corp_action`, margin and day-trade
 * eligibility. All discarded today." The five names come from that note; the eligibility flags do
 * not, because the note did not record their spellings — see `ELIGIBILITY_KEY_RE`.
 */
const OVERVIEW_FIELDS = ["indexes", "catalogs", "uma", "notation", "corp_action"] as const;

/**
 * Margin and day-trade eligibility, matched on the key NAME rather than on a guessed spelling.
 *
 * The research note recorded that these flags exist without recording what they are called. Shipping
 * `isMarginable: row.is_marginable` would put a key in every response that is always `undefined` and
 * would read, to a model, as "this stock is not marginable". Matching the concept and reporting the
 * wire keys that were actually present says only what the payload says.
 */
const ELIGIBILITY_KEY_RE = /margin|day[\s_-]?trade|daytrade/i;

const OverviewResponse = z
  .object({ data: z.record(z.unknown()).nullable().optional() })
  .passthrough();

export interface CompanyOverview {
  symbol: string;
  /** Index memberships, as the row carried them. */
  indexes?: unknown;
  catalogs?: unknown;
  /** Unusual Market Activity marker, where the row carries one. */
  uma?: unknown;
  /** Special notations: special monitoring, syariah, suspension and the like. */
  notation?: unknown;
  /** From the row's `corp_action`. */
  corpAction?: unknown;
  /**
   * Margin / day-trade eligibility keyed by the WIRE key that matched, so nothing is renamed and
   * nothing is invented. `{}` means no key in the row mentioned either concept.
   */
  eligibility: Record<string, unknown>;
  /** Which of the five named blocks the response actually carried. */
  found: string[];
  /** Which of them it did not. A name here means "absent", never "empty". */
  missing: string[];
  /** Everything else the row carried, unmodified. */
  [key: string]: unknown;
}

/**
 * The full emittenInfo row, projected but not narrowed.
 *
 * `getQuote` in `src/core/emitten.ts` keeps eight fields of this row and drops the rest, including
 * every block above — so a caller asking "is this stock in LQ45, is it under special monitoring, can
 * it be day-traded" had no way to find out from data this server already paid for. This is the same
 * request with nothing thrown away: the named blocks are surfaced, the flags are reported under
 * their own wire keys, and the remainder passes through.
 *
 * Deliberately a second cache entry rather than a change to `getQuote`: the two have different
 * shapes and the quote path is load-bearing for the analysis modules. Both use the 3s quote TTL,
 * because this row carries the live price.
 *
 * `found` / `missing` / `eligibility` / `symbol` are this function's own keys and take precedence
 * over anything the row happens to call by the same name.
 */
export async function companyOverview(symbol: string): Promise<CompanyOverview> {
  const sym = normalizeSymbol(symbol);
  return cached(`companyOverview:${sym}`, CACHE.quoteTtlMs, async () => {
    const body = await getJson("emittenInfo", { segments: { symbol: sym } });
    const row: Record<string, unknown> = parseOr(OverviewResponse, body, "company overview").data ?? {};

    const found: string[] = [];
    const missing: string[] = [];
    for (const field of OVERVIEW_FIELDS) {
      if (row[field] === undefined || row[field] === null) missing.push(field);
      else found.push(field);
    }

    const eligibility: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (ELIGIBILITY_KEY_RE.test(key)) eligibility[key] = value;
    }

    return {
      ...row,
      symbol: sym,
      indexes: row.indexes,
      catalogs: row.catalogs,
      uma: row.uma,
      notation: row.notation,
      corpAction: row.corp_action,
      eligibility,
      found,
      missing,
    };
  });
}
