/**
 * Fundamentals, valuation and analyst-ratings tools. All reads.
 *
 * Five of these six routes have never been observed live, so every description below says what is
 * projected and what is passed through untouched. A model that is told "the raw row is included"
 * will look in it; a model that is handed a confident-looking schema full of undefined keys will
 * report that the data does not exist.
 */
import { z } from "zod";
import * as core from "../core/fundamentals.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

export function registerFundamentalsTools(define: Definer): void {
  define.read(
    "seasonality",
    "Month-by-month seasonal price behaviour for one IDX stock: how it has done in each calendar " +
      "month across Stockbit's fixed ten-year lookback, in ONE request.\n" +
      "`year` is the END of that lookback, not a number of years — omit it and the current year is " +
      "sent, because the endpoint rejects the request outright without one.\n" +
      "`back_year` is passed through unchanged. Stockbit's own client sends it and this project has " +
      "not observed whether it means a start year or a count of years back, so do not read meaning " +
      "into it; it is accepted so the parameter is reachable, not because its effect is known.\n" +
      "PENDING: the response shape is unverified, so nothing is renamed — `data` is exactly what " +
      "Stockbit returned. Read the field names out of it rather than assuming any. An empty or null " +
      "`data` means Stockbit has no seasonality series for that symbol and year, which is normal for " +
      "recently listed companies; it is not an error and not a reading of zero.\n" +
      "This is a price-history statistic, not a forecast, and it says nothing about why a month was " +
      "strong.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      year: z.coerce.number().optional().describe("End year of the ten-year lookback (default: current year)"),
      back_year: z.coerce.number().optional().describe("Stockbit's back_year parameter, passed through as given"),
    },
    async (a) =>
      runTool(() =>
        core.getSeasonality(a.symbol as string, a.year as number | undefined, a.back_year as number | undefined),
      ),
  );

  define.read(
    "earnings",
    "The MARKET-WIDE earnings recap: consensus estimate against actual, across every IDX issuer, " +
      "in one request. Use it for questions like 'who beat last quarter'.\n" +
      "There is NO symbol argument — this endpoint is not per-company. To narrow it to one issuer " +
      "use `search`, which is a text search over the listing, not a ticker lookup, so confirm the " +
      "row you get back is the company you meant.\n" +
      "Every argument is optional and an omitted one is left off the request entirely, so the " +
      "defaults you get are Stockbit's own — this tool does not choose a quarter or a year for you. " +
      "`sort_column` is an integer column index whose vocabulary is unmapped; 1 is the value " +
      "Stockbit's own client sends, and other values are accepted but their effect is unknown. " +
      "`filter` is likewise a Stockbit token passed through verbatim.\n" +
      "PENDING: the response shape is unverified, so `data` is returned exactly as received and " +
      "`query` echoes the parameters that actually went on the wire. An empty `data` means no issuer " +
      "matched the filters — most often a quarter that has not been reported yet — not an error.",
    {
      filter: z.string().optional().describe("Stockbit's own filter token; vocabulary unmapped, sent verbatim"),
      search: z.string().optional().describe("Free-text search over issuers (not a ticker lookup)"),
      quarter: z.coerce.number().optional().describe("Calendar quarter, 1-4"),
      year: z.coerce.number().optional().describe("Calendar year, e.g. 2026"),
      sort_column: z.coerce.number().optional().describe("Sort column index; 1 is what Stockbit's client sends"),
      order: z.enum(core.EARNINGS_ORDERS).optional().describe("Sort direction"),
      page: z.coerce.number().optional().describe("1-based page number"),
    },
    async (a) =>
      runTool(() =>
        core.getEarnings({
          filter: a.filter as string | undefined,
          search: a.search as string | undefined,
          quarter: a.quarter as number | undefined,
          year: a.year as number | undefined,
          sortColumn: a.sort_column as number | undefined,
          order: a.order as string | undefined,
          page: a.page as number | undefined,
        }),
      ),
  );

  define.read(
    "analyst_ratings",
    "What sell-side analysts publish on one IDX stock: the per-analyst rows AND the consensus " +
      "roll-up (target price, buy/hold/sell counts), fetched together in one call.\n" +
      "Analyst coverage on IDX is thin outside the large caps. An empty `ratings` or `consensus` " +
      "means nobody publishes on that company, which is a real answer about a small-cap and NOT an " +
      "error — do not retry it and do not report it as a failure.\n" +
      "A request that genuinely failed is different: it appears in `failed` with its error kind, and " +
      "the corresponding key is absent rather than empty. If both halves fail the tool errors " +
      "instead of returning an empty-looking success.\n" +
      "PENDING: neither response shape has been observed live, so both payloads are returned " +
      "unprojected — read the target price and the rating counts out of them rather than expecting " +
      "named fields.\n" +
      "This reports what analysts said, not whether they were right, and nothing here is a " +
      "recommendation.",
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) => runTool(() => core.getAnalystRatings(a.symbol as string)),
  );

  define.read(
    "peer_comparison",
    "A stock's valuation ratios AND its INDUSTRY aggregate, side by side. This is the denominator " +
      "that absolute valuation bands do not have: 'PBV 1.2' is expensive for a bank and cheap for a " +
      "consumer name, and the `analyze` tool's valuation pillar scores against fixed bands and says " +
      "in its own output that this is systematically wrong for banks, property and cyclicals. Use " +
      "this tool before calling any ratio cheap or expensive.\n" +
      "Which number is which is never ambiguous: in `paired`, `symbolValue` is the company you " +
      "asked about and `industryValue` is Stockbit's aggregate for its industry. `symbolOnly` and " +
      "`industryOnly` are metrics that exist on one side only, so there is nothing to compare them " +
      "with. `otherCompanies` holds rows the payload attributed to a DIFFERENT ticker — the peer " +
      "set, not the subject — and they are deliberately excluded from the pairing.\n" +
      "NO VERDICT IS COMPUTED. These are Stockbit's numbers placed next to each other; the judgement " +
      "is yours, and 'below the industry' is not by itself a reason to buy anything.\n" +
      "PENDING: the comparison response shapes are unverified, so the pairing is a best-effort match " +
      "on label TEXT rather than a mapped schema. Every reading records the wire key it came from " +
      "(`labelKey`/`valueKey`) and its path inside `raw`, so check a pair before relying on it. A " +
      "label that matched more than one reading on a side is listed under `ambiguous` with all its " +
      "candidates instead of being paired arbitrarily. If `paired` is empty, that is a shape problem " +
      "and the raw payloads are attached — it is not a statement about the company.\n" +
      "`include_catalogues` adds the comparison metric vocabulary and the account's saved comparison " +
      "sets. It costs two extra requests and answers 'what can be compared', not 'how does this " +
      "company compare', so leave it off unless that is the question.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      include_raw: z
        .boolean()
        .optional()
        .describe("Keep the unprojected payloads under `raw` (default true; set false if too large)"),
      include_catalogues: z
        .boolean()
        .optional()
        .describe("Also fetch the comparison metric list and saved comparison sets (default false)"),
    },
    async (a) =>
      runTool(() =>
        core.getPeerComparison(a.symbol as string, {
          includeRaw: a.include_raw as boolean | undefined,
          includeCatalogues: a.include_catalogues as boolean | undefined,
        }),
      ),
  );

  define.read(
    "fundachart",
    "The fundachart vocabulary: which fundamental metrics Stockbit can plot over time, plus the " +
      "saved fundachart layouts on this account.\n" +
      "Takes no symbol and returns no company data — it answers 'what can be charted' and 'what have " +
      "I saved', not 'what is BBRI's revenue'. For the numbers themselves use the fundamentals and " +
      "financial-statement tools.\n" +
      "An empty `templates` means this account has saved no fundachart layouts, which is the ordinary " +
      "state for an account that has never opened the feature; it is not an error.\n" +
      "PENDING: neither response shape has been observed live, so both are returned unprojected. A " +
      "half that failed appears in `failed` with its error kind and its key is absent rather than " +
      "empty.",
    {},
    async () => runTool(() => core.getFundachart()),
  );

  define.read(
    "entitlements",
    "Ask Stockbit directly whether THIS account is entitled to a feature, per feature and " +
      "optionally per company.\n" +
      "ASK THIS BEFORE CONCLUDING THAT ANYTHING IS PAYWALLED. This project has twice explained a " +
      "failure by inferring a gate from the web UI and been wrong both times: once blaming every 403 " +
      "on the Rp 10,000,000 broker-distribution balance requirement, once concluding that chart " +
      "saving was behind the Pro paywall — the server answered `is_eligible: true` on that same " +
      "account. A paywall that exists in the UI is not proof that this account is subject to it.\n" +
      "`eligible: true` means the account is entitled and something else explains the failure. " +
      "`eligible: false` is a real entitlement refusal. `eligible: null` means the response carried " +
      "no verdict for that feature, and a feature listed in `unanswered` was asked about and not " +
      "mentioned at all — treat BOTH as unknown, never as blocked.\n" +
      "Feature names may be given with or without the PAYWALL_FEATURE_ prefix. Omit `features` " +
      "entirely to ask about the five names read out of Stockbit's own bundle: CHARTBIT, KEYSTATS, " +
      "FINANCIALS, ANALYSIS, FUNDACHART. That list is not exhaustive, so any well-formed " +
      "PAYWALL_FEATURE_* name is accepted.\n" +
      "Without `company` no per-company gate is evaluated, and this says nothing about whether an " +
      "endpoint is working — only about entitlement.\n" +
      "PENDING: only a SINGLE-feature request has been observed live. Several are sent as repeated " +
      "parameters; if Stockbit wants them joined differently the extras will show up in `unanswered` " +
      "rather than as a quiet refusal.",
    {
      features: z
        .array(z.string())
        .optional()
        .describe("Feature names, with or without the PAYWALL_FEATURE_ prefix (default: the five known ones)"),
      company: z.string().optional().describe("IDX ticker to evaluate a per-company gate against, e.g. BBRI"),
    },
    async (a) =>
      runTool(() => core.getEntitlements(a.features as string[] | undefined, a.company as string | undefined)),
  );
}
