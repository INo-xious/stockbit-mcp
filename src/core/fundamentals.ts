/**
 * Fundamentals, valuation and analyst ratings.
 *   GET /company-price-feed/seasonality/{symbol}?year=&back_year=
 *   GET /earnings?filter=&search=&quarter=&year=&sort_column=&order=&page=
 *   GET /analyst-ratings/{symbol}            and  .../{symbol}/consensus
 *   GET /comparison/{symbol}/ratios          and  .../{symbol}/industries
 *   GET /comparison/{symbol}/templates, /comparison/metrics, /comparison/templates
 *   GET /fundachart/metrics?metric_name=fundachart   and  /fundachart/templates
 *   GET /paywall/eligibility/check?features=&company=
 *
 * ## None of these has been observed live except the last one
 *
 * Only the paywall check has a response this project has actually seen (recorded in
 * `docs/research/chartbit-layout-format.md`). Everything else here is wired from route names and Stockbit's
 * own client parameters, which means the schemas below validate the *envelope* and almost nothing
 * else: every inner field is optional, every inner object passes through, and where a shape is
 * unmapped the payload is returned whole rather than projected into invented key names.
 *
 * The one place that does more than pass bytes through is `getPeerComparison`, and the way it does
 * it is deliberately auditable — see `extractReadings`.
 */
import { z } from "zod";
import { getJson } from "../http/client.js";
import { cached, parseOr } from "./_util.js";
import { CACHE } from "../config.js";
import { isSymbol, normalizeSymbol } from "../symbol.js";
import { StockbitError, type ErrorKind } from "../http/errors.js";

/* --------------------------------- shared plumbing --------------------------------- */

const Envelope = z.object({ data: z.unknown() }).passthrough();

function hasDataMember(body: unknown): body is { data: unknown } {
  return typeof body === "object" && body !== null && !Array.isArray(body) && "data" in body;
}

/**
 * The `data` member, or the whole body for the routes that do not wrap.
 *
 * Both shapes are live in this API. Most exodus routes answer `{data: ...}`; the paywall check was
 * observed answering with `features` and `company` at the top level and no `data` member at all.
 * Rejecting the second as drift would turn a working endpoint into an error, and defaulting it to
 * `null` would report "this account has no entitlements" for an account that has them.
 *
 * The envelope parse is what rejects a body that is not an object at all — a 200 carrying an HTML
 * error page, say. The payload itself is read off the raw body rather than off zod's output, so an
 * absent `data` key stays absent instead of arriving as `undefined` and being mistaken for null.
 */
function unwrapData(body: unknown, context: string): unknown {
  parseOr(Envelope, body, context);
  return hasDataMember(body) ? body.data : body;
}

/**
 * A number that may arrive as a number, a numeric string with thousands separators, or a
 * `{value}` / `{raw}` wrapper.
 *
 * All of those shapes are already known to be live on this API — `src/core/pricefeed.ts` documents
 * an orderbook payload where the auto-rejection bands are `{"value":"3,910"}` and the foreign
 * figures beside them are bare numbers. `Number("")` being `0` is the trap this guards: an empty
 * string has to read as "absent", never as a free zero in a valuation comparison.
 */
function numberish(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    const wrapper = value as Record<string, unknown>;
    if ("value" in wrapper) return numberish(wrapper.value);
    if ("raw" in wrapper) return numberish(wrapper.raw);
  }
  return null;
}

/** One half of a multi-call tool that did not answer. */
export interface SideFailure {
  /** Which call failed, by the name this module uses for it. */
  side: string;
  kind: ErrorKind;
  message: string;
}

interface Settled<T> {
  side: string;
  value?: T;
  error?: unknown;
  failure?: SideFailure;
}

/**
 * Run one half of a composite read, capturing its failure instead of rejecting.
 *
 * Composite tools here fetch two or three endpoints and present them together. A 404 on the
 * consensus half must not destroy the ratings half — but it must also not vanish, which is why the
 * failure is captured as data rather than swallowed.
 */
async function settle<T>(side: string, load: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { side, value: await load() };
  } catch (err) {
    const kind: ErrorKind = err instanceof StockbitError ? err.kind : "unknown";
    const message = err instanceof Error ? err.message : String(err);
    return { side, error: err, failure: { side, kind, message } };
  }
}

/**
 * Rethrow when *every* half failed.
 *
 * Without this, a composite read whose calls all 401'd would return a well-formed object full of
 * empty arrays, and the caller would read an expired session as "this company has no analyst
 * coverage". The first failure's original error is rethrown so the typed kind and status survive.
 */
function requireOneSide(sides: Array<Settled<unknown>>): void {
  const failures = sides.filter((s) => s.failure !== undefined);
  if (failures.length > 0 && failures.length === sides.length) throw failures[0].error;
}

function failuresOf(sides: Array<Settled<unknown>>): SideFailure[] {
  return sides.flatMap((s) => (s.failure ? [s.failure] : []));
}

function noteFailures(failures: SideFailure[], notes: string[]): void {
  for (const f of failures) {
    notes.push(`The ${f.side} request failed (${f.kind}): ${f.message}. Its part of this answer is absent, not empty.`);
  }
}

/* ------------------------------- argument validation ------------------------------- */

/** One past the current year: Stockbit publishes forward-looking rows before the year turns. */
function maxYear(): number {
  return new Date().getFullYear() + 1;
}

/** The oldest year worth asking for. IDX data before this is not served by these endpoints. */
const MIN_YEAR = 1990;

function intArg(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new StockbitError(
      "invalid_param",
      `Invalid ${name} ${JSON.stringify(value)}: expected an integer between ${min} and ${max}`,
    );
  }
  return value;
}

/** A free-text query parameter. Trimmed, bounded, and refused when empty rather than sent blank. */
function textArg(name: string, value: string, maxLength = 100): string {
  const trimmed = String(value).trim();
  if (trimmed === "") {
    throw new StockbitError("invalid_param", `Invalid ${name}: expected a non-empty value, or omit it entirely`);
  }
  if (trimmed.length > maxLength) {
    throw new StockbitError("invalid_param", `Invalid ${name}: at most ${maxLength} characters`);
  }
  return trimmed;
}

/* ----------------------------------- seasonality ----------------------------------- */

export interface Seasonality {
  symbol: string;
  /** The year actually sent. Echoed because it is defaulted when the caller omits it. */
  year: number;
  /** Present only when the caller supplied it. */
  backYear?: number;
  /** The payload, unprojected. See the note on `getSeasonality`. */
  data: unknown;
}

/**
 * Month-by-month seasonal returns for one symbol.
 *
 * `year` is required by the endpoint — it answers 400 without one — so it is defaulted to the
 * current calendar year rather than omitted. `docs/research/2026-08-05-capability-research.md` records it as the END of
 * a fixed ten-year lookback rather than a lookback length, which is why nothing here tries to derive
 * a range from it.
 *
 * `back_year` is passed through unchanged. Stockbit's own client sends it and this project has not
 * observed whether it means a start year or a count of years, so the validation accepts either
 * reading and the tool description says as much rather than inventing a meaning.
 *
 * The response shape is unmapped, so `data` is whatever the endpoint returned. It is deliberately
 * not projected: naming three fields here would turn every unnamed one into "does not exist".
 */
export async function getSeasonality(symbol: string, year?: number, backYear?: number): Promise<Seasonality> {
  const sym = normalizeSymbol(symbol);
  const resolvedYear = year === undefined ? new Date().getFullYear() : intArg("year", year, MIN_YEAR, maxYear());
  const resolvedBack = backYear === undefined ? undefined : intArg("back_year", backYear, 1, maxYear());

  return cached(`seasonality:${sym}:${resolvedYear}:${resolvedBack ?? "none"}`, CACHE.keystatsTtlMs, async () => {
    const body = await getJson("seasonality", {
      segments: { symbol: sym },
      params: { year: resolvedYear, back_year: resolvedBack },
    });
    return {
      symbol: sym,
      year: resolvedYear,
      ...(resolvedBack === undefined ? {} : { backYear: resolvedBack }),
      data: unwrapData(body, "seasonality"),
    };
  });
}

/* ------------------------------------- earnings ------------------------------------- */

/** Sort direction. `desc` is the value Stockbit's own client sends. */
export const EARNINGS_ORDERS = ["asc", "desc"] as const;
export type EarningsOrder = (typeof EARNINGS_ORDERS)[number];

export interface EarningsOptions {
  /** Stockbit's own filter token. Vocabulary unmapped; passed through verbatim. */
  filter?: string;
  /** Free-text search across issuers. */
  search?: string;
  /** Calendar quarter, 1-4. */
  quarter?: number;
  year?: number;
  /** Which column to sort by, as an integer. `1` is what Stockbit's own client sends. */
  sortColumn?: number;
  order?: string;
  page?: number;
}

export interface Earnings {
  /** Exactly the query parameters that went on the wire, so a caller can see what it asked. */
  query: Record<string, string | number>;
  /** The payload, unprojected. */
  data: unknown;
}

/**
 * The market-wide earnings recap: consensus estimate against actual, across every IDX issuer.
 *
 * Market-wide, not per-symbol — there is no symbol path segment here. `search` is the way to narrow
 * it to one issuer, and it is a text search rather than a ticker lookup.
 *
 * Every argument is optional and every omitted one is left off the query string entirely. That
 * matters more than it looks: sending `quarter=` empty is not the same request as not sending
 * `quarter`, and this endpoint's defaults are Stockbit's, not this module's.
 */
export async function getEarnings(opts: EarningsOptions = {}): Promise<Earnings> {
  const query: Record<string, string | number> = {};
  if (opts.filter !== undefined) query.filter = textArg("filter", opts.filter);
  if (opts.search !== undefined) query.search = textArg("search", opts.search);
  if (opts.quarter !== undefined) query.quarter = intArg("quarter", opts.quarter, 1, 4);
  if (opts.year !== undefined) query.year = intArg("year", opts.year, MIN_YEAR, maxYear());
  if (opts.sortColumn !== undefined) query.sort_column = intArg("sort_column", opts.sortColumn, 0, 99);
  if (opts.order !== undefined) {
    const order = String(opts.order).trim().toLowerCase();
    if (!(EARNINGS_ORDERS as readonly string[]).includes(order)) {
      throw new StockbitError(
        "invalid_param",
        `Invalid order ${JSON.stringify(opts.order)}: expected one of ${EARNINGS_ORDERS.join(", ")}`,
      );
    }
    query.order = order;
  }
  if (opts.page !== undefined) query.page = intArg("page", opts.page, 1, 1000);

  // Key order is fixed by the assignments above, so this string is stable for a given argument set
  // and — the part that matters — different for every argument set. A key that dropped `page` would
  // serve page 1 to a caller who asked for page 4.
  return cached(`earnings:${JSON.stringify(query)}`, CACHE.keystatsTtlMs, async () => {
    const body = await getJson("earnings", { params: query });
    return { query, data: unwrapData(body, "earnings") };
  });
}

/* --------------------------------- analyst ratings --------------------------------- */

export interface AnalystRatings {
  symbol: string;
  /** Per-analyst rows. Absent when that call failed; see `failed`. */
  ratings?: unknown;
  /** The aggregated consensus. Absent when that call failed. */
  consensus?: unknown;
  failed: SideFailure[];
  notes: string[];
}

/**
 * Analyst ratings and the consensus roll-up, in one answer.
 *
 * Two endpoints, fetched together because asking for one without the other is almost never what a
 * caller wants: the per-analyst rows without the consensus is a list nobody can weigh, and the
 * consensus without the rows hides how many houses it is built from.
 *
 * Coverage on IDX is thin outside the large caps, so an empty payload on either half is a normal
 * answer for a small-cap and not an error. A *failed* half is different and is reported in `failed`
 * with its error kind; if both fail the original error is rethrown rather than dressed up as an
 * empty result.
 */
export async function getAnalystRatings(symbol: string): Promise<AnalystRatings> {
  const sym = normalizeSymbol(symbol);
  return cached(`analystratings:${sym}`, CACHE.keystatsTtlMs, async () => {
    const [ratings, consensus] = await Promise.all([
      settle("analyst ratings", async () =>
        unwrapData(await getJson("analystRatings", { segments: { symbol: sym } }), "analyst ratings"),
      ),
      settle("analyst consensus", async () =>
        unwrapData(await getJson("analystConsensus", { segments: { symbol: sym } }), "analyst consensus"),
      ),
    ]);
    requireOneSide([ratings, consensus]);

    const failed = failuresOf([ratings, consensus]);
    const notes: string[] = [];
    noteFailures(failed, notes);
    notes.push(
      "Field names are not projected: both payloads are returned exactly as Stockbit sent them, " +
        "because this response shape has not been observed live.",
    );

    return {
      symbol: sym,
      ...(ratings.failure ? {} : { ratings: ratings.value }),
      ...(consensus.failure ? {} : { consensus: consensus.value }),
      failed,
      notes,
    };
  });
}

/* -------------------------------- peer comparison -------------------------------- */

/**
 * Key spellings that have carried a metric's LABEL elsewhere in this API.
 *
 * A candidate list, searched in order — not an assertion that any particular one is present. The
 * spelling that actually matched is reported on every reading as `labelKey`, so a reader can tell
 * a real match from a lucky one without re-reading the payload.
 */
const LABEL_KEYS = ["name", "metric_name", "metric", "title", "label"] as const;

/** The same idea for a metric's VALUE. `numberish` handles the `{raw}` / `{value}` wrappers. */
const VALUE_KEYS = ["value", "raw", "amount", "val"] as const;

/**
 * Keys that identify which company a row belongs to.
 *
 * Needed because the ratios endpoint is a *comparison* endpoint: it very likely carries several
 * companies' rows, and pairing "PBV" against the industry without knowing whose PBV it is would be
 * worse than not pairing at all. Values are accepted only when they look like a ticker.
 */
const OWNER_KEYS = ["symbol", "company_symbol", "ticker"] as const;

/** Bounds on the walk. A malformed or self-similar payload must not turn a read into a hang. */
const MAX_DEPTH = 12;
const MAX_NODES = 20_000;

export interface Reading {
  /** The metric's label, spelled as the wire spells it. */
  metric: string;
  /** The label parsed as a number, or null when it was not numeric. Never a substituted zero. */
  value: number | null;
  /** Whatever was actually at the value key, before `numberish` looked at it. */
  rawValue: unknown;
  /** The ticker this row belongs to, when the payload said. Absent when it did not. */
  owner?: string;
  /** Where this came from inside the payload returned under `raw`, so the match is checkable. */
  path: string;
  /** Which of `LABEL_KEYS` matched. */
  labelKey: string;
  /** Which of `VALUE_KEYS` matched. */
  valueKey: string;
}

/**
 * Find every label/value pair in an arbitrary payload.
 *
 * This exists because the comparison responses have not been observed and projecting them into
 * named fields would mean inventing those names. Instead of guessing a schema, this walks the JSON
 * looking for the label/value key spellings this API already uses elsewhere, and records for each
 * hit *which* spelling matched and *where* it was found. A wrong guess therefore shows up as a
 * missing pair with the raw payload attached, not as a confident number under a made-up key.
 *
 * Pure and exported so the pairing can be tested without a network.
 */
export function extractReadings(payload: unknown): Reading[] {
  const out: Reading[] = [];
  let nodes = 0;

  const visit = (node: unknown, path: string, depth: number, owner: string | undefined): void => {
    if (depth > MAX_DEPTH || nodes >= MAX_NODES) return;
    nodes++;

    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`, depth + 1, owner));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;

    let scope = owner;
    for (const key of OWNER_KEYS) {
      const candidate = record[key];
      if (typeof candidate !== "string") continue;
      const ticker = candidate.trim().toUpperCase();
      if (isSymbol(ticker)) {
        scope = ticker;
        break;
      }
    }

    const labelKey = LABEL_KEYS.find((k) => typeof record[k] === "string" && (record[k] as string).trim() !== "");
    const valueKey = labelKey === undefined ? undefined : VALUE_KEYS.find((k) => k in record);
    if (labelKey !== undefined && valueKey !== undefined) {
      out.push({
        metric: (record[labelKey] as string).trim(),
        value: numberish(record[valueKey]),
        rawValue: record[valueKey],
        ...(scope === undefined ? {} : { owner: scope }),
        path: path === "" ? "$" : path,
        labelKey,
        valueKey,
      });
    }

    for (const [key, child] of Object.entries(record)) {
      visit(child, path === "" ? key : `${path}.${key}`, depth + 1, scope);
    }
  };

  visit(payload, "", 0, undefined);
  return out;
}

/** Labels are matched on letters and digits only, so "PBV (x)" and "PBV(X)" are the same metric. */
function metricKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export interface PairedMetric {
  /** The metric's label on the symbol's side. */
  metric: string;
  /** The same metric's label on the industry side, which may be spelled differently. */
  industryMetric: string;
  /** The subject company's own value. */
  symbolValue: number | null;
  /** The industry aggregate's value for the same metric. */
  industryValue: number | null;
  symbolPath: string;
  industryPath: string;
}

/** A label that matched more than one reading on a side, so no unambiguous pair could be made. */
export interface AmbiguousMetric {
  metric: string;
  symbolReadings: Reading[];
  industryReadings: Reading[];
}

export interface ComparisonCatalogues {
  /** Metric vocabulary for the comparison service. Absent when that call failed. */
  metrics?: unknown;
  /** The account's saved comparison sets. Absent when that call failed. */
  templates?: unknown;
  /** Saved comparison sets scoped to this symbol. Absent when that call failed. */
  symbolTemplates?: unknown;
  failed: SideFailure[];
}

export interface PeerComparison {
  symbol: string;
  /** Metrics found on both sides exactly once each. */
  paired: PairedMetric[];
  /** Readings for the subject company with no industry counterpart. */
  symbolOnly: Reading[];
  /** Industry readings with no counterpart for the subject company. */
  industryOnly: Reading[];
  ambiguous: AmbiguousMetric[];
  /** Readings the ratios payload attributed to some OTHER ticker: the peer set, not the subject. */
  otherCompanies: Reading[];
  failed: SideFailure[];
  notes: string[];
  /** The unprojected payloads. A side that failed has no key here. */
  raw?: { ratios?: unknown; industries?: unknown };
  /** Only present when the caller asked for them. */
  catalogues?: ComparisonCatalogues;
}

function pair(symbolReadings: Reading[], industryReadings: Reading[]) {
  const group = (readings: Reading[]): Map<string, Reading[]> => {
    const map = new Map<string, Reading[]>();
    for (const reading of readings) {
      const key = metricKey(reading.metric);
      if (key === "") continue;
      const bucket = map.get(key);
      if (bucket) bucket.push(reading);
      else map.set(key, [reading]);
    }
    return map;
  };

  const left = group(symbolReadings);
  const right = group(industryReadings);
  const paired: PairedMetric[] = [];
  const symbolOnly: Reading[] = [];
  const industryOnly: Reading[] = [];
  const ambiguous: AmbiguousMetric[] = [];

  for (const [key, mine] of left) {
    const theirs = right.get(key);
    if (theirs === undefined) {
      symbolOnly.push(...mine);
      continue;
    }
    if (mine.length !== 1 || theirs.length !== 1) {
      // Picking one of several would be an arbitrary choice presented as a fact. Say so instead.
      ambiguous.push({ metric: mine[0].metric, symbolReadings: mine, industryReadings: theirs });
      continue;
    }
    paired.push({
      metric: mine[0].metric,
      industryMetric: theirs[0].metric,
      symbolValue: mine[0].value,
      industryValue: theirs[0].value,
      symbolPath: mine[0].path,
      industryPath: theirs[0].path,
    });
  }

  for (const [key, theirs] of right) {
    if (!left.has(key)) industryOnly.push(...theirs);
  }

  return { paired, symbolOnly, industryOnly, ambiguous };
}

async function loadPeerComparison(sym: string): Promise<PeerComparison> {
  const [ratios, industries] = await Promise.all([
    settle("comparison ratios", async () =>
      unwrapData(await getJson("comparisonRatios", { segments: { symbol: sym } }), "comparison ratios"),
    ),
    settle("comparison industries", async () =>
      unwrapData(await getJson("comparisonIndustries", { segments: { symbol: sym } }), "comparison industries"),
    ),
  ]);
  requireOneSide([ratios, industries]);

  const allSymbolSide = ratios.failure ? [] : extractReadings(ratios.value);
  const industryReadings = industries.failure ? [] : extractReadings(industries.value);
  const subject = allSymbolSide.filter((r) => r.owner === undefined || r.owner === sym);
  const otherCompanies = allSymbolSide.filter((r) => r.owner !== undefined && r.owner !== sym);

  const { paired, symbolOnly, industryOnly, ambiguous } = pair(subject, industryReadings);
  const failed = failuresOf([ratios, industries]);
  const notes: string[] = [];
  noteFailures(failed, notes);

  notes.push(
    "Pairing is a best-effort match on label text, not a mapped schema: every reading records the " +
      "wire key it came from (labelKey/valueKey) and its path inside `raw`, so each pair is checkable.",
  );
  if (failed.length > 0) {
    notes.push("One side is missing, so nothing here is a peer-relative reading yet.");
  } else if (paired.length === 0) {
    notes.push(
      "No metric label appeared on both sides, so nothing could be paired. That is a shape problem, " +
        "not a verdict: read `raw` before concluding anything about this company.",
    );
  }
  if (ambiguous.length > 0) {
    notes.push(
      `${ambiguous.length} label(s) matched more than one reading on a side and were left unpaired; ` +
        "they are listed under `ambiguous` with every candidate.",
    );
  }
  notes.push("No verdict is computed here. These are Stockbit's numbers, side by side.");

  return {
    symbol: sym,
    paired,
    symbolOnly,
    industryOnly,
    ambiguous,
    otherCompanies,
    failed,
    notes,
    raw: {
      ...(ratios.failure ? {} : { ratios: ratios.value }),
      ...(industries.failure ? {} : { industries: industries.value }),
    },
  };
}

async function loadComparisonCatalogues(sym: string): Promise<ComparisonCatalogues> {
  const [metrics, templates, symbolTemplates] = await Promise.all([
    settle("comparison metrics", async () =>
      unwrapData(await getJson("comparisonMetrics"), "comparison metrics"),
    ),
    settle("comparison templates", async () =>
      unwrapData(await getJson("comparisonTemplates"), "comparison templates"),
    ),
    settle("comparison symbol templates", async () =>
      unwrapData(await getJson("comparisonSymbolTemplates", { segments: { symbol: sym } }), "comparison symbol templates"),
    ),
  ]);
  requireOneSide([metrics, templates, symbolTemplates]);
  return {
    ...(metrics.failure ? {} : { metrics: metrics.value }),
    ...(templates.failure ? {} : { templates: templates.value }),
    ...(symbolTemplates.failure ? {} : { symbolTemplates: symbolTemplates.value }),
    failed: failuresOf([metrics, templates, symbolTemplates]),
  };
}

export interface PeerComparisonOptions {
  /** Keep the unprojected payloads in the answer. Default true. */
  includeRaw?: boolean;
  /** Also fetch the metric vocabulary and the saved comparison sets. Default false. */
  includeCatalogues?: boolean;
}

/**
 * The subject company's ratios and its industry aggregate, side by side.
 *
 * This is the denominator `src/analysis/analyze.ts` does not have. That pillar scores PE and PBV
 * against fixed absolute bands and says in its own comments that the result is systematically wrong
 * for banks, property and cyclicals, because "a PBV of 1.2 is expensive for a bank and cheap for a
 * consumer name" is a question absolute bands cannot ask. The comparison service's industries route
 * is Stockbit's own industry aggregate, so the comparison stops being a client-side computation over
 * N peer fetches.
 *
 * **No verdict is computed.** The pairing is presented, the raw payloads travel with it, and the
 * judgement is left to a consumer that can be written once the shapes are confirmed live.
 *
 * The two catalogue calls are off by default because they are static vocabulary, not an answer
 * about this company, and they cost two extra requests every time the tool is used for what it is
 * for. They are cached under their own key so the flag cannot poison the main result.
 */
export async function getPeerComparison(
  symbol: string,
  opts: PeerComparisonOptions = {},
): Promise<PeerComparison> {
  const sym = normalizeSymbol(symbol);
  const base = await cached(`peercomparison:${sym}`, CACHE.keystatsTtlMs, () => loadPeerComparison(sym));
  const catalogues = opts.includeCatalogues
    ? await cached(`comparisoncatalogues:${sym}`, CACHE.keystatsTtlMs, () => loadComparisonCatalogues(sym))
    : undefined;

  // A shallow copy first: the cached object is shared, so dropping `raw` for one caller must not
  // drop it for the next one.
  const result: PeerComparison = { ...base };
  if (opts.includeRaw === false) delete result.raw;
  if (catalogues !== undefined) result.catalogues = catalogues;
  return result;
}

/* -------------------------------------- fundachart -------------------------------------- */

/**
 * The catalogue selector Stockbit's own client sends on the fundachart metric list.
 *
 * Hard-coded rather than exposed as an argument: the screener has its own metric route, so this
 * value is not a knob a caller should be turning, and a wrong value here would most likely return a
 * different catalogue rather than an error.
 */
const FUNDACHART_METRIC_NAME = "fundachart";

export interface Fundachart {
  /** The metric vocabulary a fundachart can plot. Absent when that call failed. */
  metrics?: unknown;
  /** The account's saved fundachart layouts. Absent when that call failed. */
  templates?: unknown;
  failed: SideFailure[];
  notes: string[];
}

/**
 * The fundachart metric vocabulary and the account's saved fundachart templates.
 *
 * Neither call takes a symbol: this is the vocabulary and the saved layouts, not a chart of any
 * particular company. An empty `templates` payload means the account has saved none, which is the
 * ordinary state for an account that has never opened the feature.
 */
export async function getFundachart(): Promise<Fundachart> {
  return cached("fundachart", CACHE.keystatsTtlMs, async () => {
    const [metrics, templates] = await Promise.all([
      settle("fundachart metrics", async () =>
        unwrapData(
          await getJson("fundachartMetrics", { params: { metric_name: FUNDACHART_METRIC_NAME } }),
          "fundachart metrics",
        ),
      ),
      settle("fundachart templates", async () =>
        unwrapData(await getJson("fundachartTemplates"), "fundachart templates"),
      ),
    ]);
    requireOneSide([metrics, templates]);

    const failed = failuresOf([metrics, templates]);
    const notes: string[] = [];
    noteFailures(failed, notes);
    notes.push("Both payloads are returned unprojected; these response shapes have not been observed live.");

    return {
      ...(metrics.failure ? {} : { metrics: metrics.value }),
      ...(templates.failure ? {} : { templates: templates.value }),
      failed,
      notes,
    };
  });
}

/* ------------------------------------ entitlements ------------------------------------ */

/**
 * The feature names seen in Stockbit's own web bundle.
 *
 * Not a closed list — the bundle's enum is longer than what has been read out of it — so this is the
 * default question and the documented vocabulary, never a validator. `normalizeFeature` accepts any
 * well-formed `PAYWALL_FEATURE_*` name.
 */
export const KNOWN_PAYWALL_FEATURES = [
  "PAYWALL_FEATURE_CHARTBIT",
  "PAYWALL_FEATURE_KEYSTATS",
  "PAYWALL_FEATURE_FINANCIALS",
  "PAYWALL_FEATURE_ANALYSIS",
  "PAYWALL_FEATURE_FUNDACHART",
] as const;

const FEATURE_PREFIX = "PAYWALL_FEATURE_";
const FEATURE_RE = /^PAYWALL_FEATURE_[A-Z0-9_]{1,64}$/;

/** Accept `CHARTBIT` or `PAYWALL_FEATURE_CHARTBIT`; send the full name Stockbit expects. */
export function normalizeFeature(input: string): string {
  const upper = String(input).trim().toUpperCase().replace(/[\s-]+/g, "_");
  const full = upper.startsWith(FEATURE_PREFIX) ? upper : `${FEATURE_PREFIX}${upper}`;
  if (!FEATURE_RE.test(full)) {
    throw new StockbitError(
      "invalid_param",
      `Invalid paywall feature ${JSON.stringify(input)}: expected a name such as ` +
        `${KNOWN_PAYWALL_FEATURES[0]} (the ${FEATURE_PREFIX} prefix may be omitted)`,
    );
  }
  return full;
}

/**
 * The one response in this module whose shape has actually been seen:
 *   {"features":[{"feature":"PAYWALL_FEATURE_CHARTBIT","is_eligible":true}],
 *    "company":{"company":"BBRI","is_eligible":true}}
 *
 * Note the absence of a `data` envelope — `unwrapData` is still applied first so that a deployment
 * which does wrap keeps working. Every field stays optional: an observation is one observation.
 */
const EligibilityResponse = z
  .object({
    features: z
      .array(z.object({ feature: z.string().optional(), is_eligible: z.boolean().optional() }).passthrough())
      .nullable()
      .optional(),
    company: z
      .object({ company: z.string().optional(), is_eligible: z.boolean().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export interface FeatureEligibility {
  feature: string;
  /** `null` when the row carried no `is_eligible` at all — which is not the same as "not entitled". */
  eligible: boolean | null;
}

export interface Entitlements {
  /** The feature names actually sent, after normalization. */
  requested: string[];
  features: FeatureEligibility[];
  /** Present only when the response carried a company verdict. */
  company?: { symbol?: string; eligible: boolean | null };
  /** Requested features the response said nothing about. Never read these as "not entitled". */
  unanswered: string[];
  /** Features the response volunteered that were not asked for. */
  unrequested: string[];
  notes: string[];
  raw: unknown;
}

/**
 * Ask Stockbit directly whether this account is entitled to a feature.
 *
 * This project has twice explained a failure by *inferring* a gate and been wrong both times: once
 * blaming every 403 on the Rp 10,000,000 broker-distribution balance requirement, once concluding
 * that Chartbit saving was behind the Pro paywall. Both were read off the web UI's intentions rather
 * than asked of the server, and the server answers this question directly — for Chartbit it answered
 * `is_eligible: true` on the same account whose saves were being discarded.
 *
 * ## The multi-feature request form is the one guess here
 *
 * Only a single-feature request has been observed. Several features are sent as repeated `features`
 * parameters, which is the form `src/http/transport.ts` already uses for the broker-activity route
 * and the form its `QueryParams` array support exists for. If Stockbit instead wants them
 * comma-joined, the extra features simply will not appear in the response — and that shows up in
 * `unanswered` rather than as a quiet "not entitled".
 */
export async function getEntitlements(features?: readonly string[], company?: string): Promise<Entitlements> {
  // Annotated as one array type on purpose: the two branches have different element types and a
  // union of arrays is awkward to map over.
  const asked: readonly string[] =
    features === undefined || features.length === 0 ? KNOWN_PAYWALL_FEATURES : features;
  const requested = [...new Set(asked.map(normalizeFeature))];
  const symbol = company === undefined ? undefined : normalizeSymbol(company);

  return cached(`entitlements:${requested.join(",")}:${symbol ?? "none"}`, CACHE.keystatsTtlMs, async () => {
    const body = await getJson("paywallEligibility", {
      params: { features: requested, company: symbol },
    });
    // `raw` carries the payload as it arrived, not zod's output: a reader checking an unexpected
    // answer needs what Stockbit sent, not what this schema chose to keep.
    const payload = unwrapData(body, "paywall eligibility");
    const parsed = parseOr(EligibilityResponse, payload, "paywall eligibility");

    const rows = parsed.features ?? [];
    const answered: FeatureEligibility[] = rows.flatMap((row) =>
      row.feature === undefined ? [] : [{ feature: row.feature, eligible: row.is_eligible ?? null }],
    );
    const answeredNames = new Set(answered.map((f) => f.feature));
    const unanswered = requested.filter((f) => !answeredNames.has(f));
    const unrequested = answered.map((f) => f.feature).filter((f) => !requested.includes(f));

    const notes: string[] = [];
    if (unanswered.length > 0) {
      notes.push(
        `The response did not mention ${unanswered.join(", ")}. Treat those as UNKNOWN, not as ` +
          "blocked: the multi-feature request form has not been confirmed against a live account.",
      );
    }
    if (answered.length === 0) {
      notes.push("The response carried no feature verdicts at all. Read `raw` before concluding anything.");
    }
    if (symbol === undefined) {
      notes.push("No company was supplied, so any per-company gate was not evaluated.");
    }

    return {
      requested,
      features: answered,
      ...(parsed.company
        ? {
            company: {
              ...(parsed.company.company === undefined ? {} : { symbol: parsed.company.company }),
              eligible: parsed.company.is_eligible ?? null,
            },
          }
        : {}),
      unanswered,
      unrequested,
      notes,
      raw: payload,
    };
  });
}
