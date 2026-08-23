/**
 * Company identity tools: profile, contact, subsidiaries, shareholders, classification, index and
 * sector membership, search, and the full info row that `quote` narrows.
 *
 * All reads. The descriptions carry more than usual about *where the rows were found*, because none
 * of these endpoints has been observed live: `src/core/company.ts` locates the row array instead of
 * assuming a key, and a caller that does not know to check `source` will read a lookup failure as an
 * empty answer.
 */
import { z } from "zod";
import * as core from "../core/company.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

/** The paragraph every row-set tool ends with. One wording, so the contract cannot drift per tool. */
const ROW_SOURCE_NOTE =
  "Rows come back verbatim under `rows`. `source` says where they were found in the response: " +
  '"data" when the payload was a bare array, "data.<key>" when it was wrapped, and **null when no ' +
  "row array could be found at all** — in that case `extra` holds what the response did carry, and " +
  "an empty `rows` means the lookup failed rather than that the answer was empty. `rows: []` with a " +
  "non-null `source` is a genuine zero.";

const PENDING_NOTE =
  "Pending verification: this endpoint has not been observed live, so nothing is renamed or " +
  "projected — you are reading the fields the API sent.";

export function registerCompanyTools(define: Definer): void {
  define.read(
    "company_overview",
    "Everything /emitten/{symbol}/info returns for one ticker, with nothing discarded: index " +
      "memberships, catalogs, the UMA (unusual market activity) marker, special notations, the " +
      "corporate-action block and margin / day-trade eligibility, alongside the live price fields.\n" +
      "Use this when the question is what a stock IS — is it in LQ45, is it under special " +
      "monitoring, can it be day-traded — rather than what it costs; `quote` reads the same upstream " +
      "row but keeps only price and best bid/offer.\n" +
      "`found` and `missing` list which of the five named blocks (indexes, catalogs, uma, notation, " +
      "corp_action) the response actually carried. A name in `missing` means the field was ABSENT, " +
      "never that it was empty or false.\n" +
      "`eligibility` is keyed by the response's own field names — every key that mentioned margin or " +
      "day trading — because those flags are known to exist but their exact spellings have not been " +
      "observed. `{}` means no such key was present, which is not the same as 'not eligible'. Every " +
      "other field of the row is passed through unchanged.",
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) => runTool(() => core.companyOverview(a.symbol as string)),
  );

  define.read(
    "company_profile",
    "The company description block for a ticker: what the business does, and whatever else " +
      "Stockbit's profile endpoint carries. Returned verbatim under `profile`; `null` there means the " +
      "endpoint answered with no profile body, which is an answer and not an error.\n" +
      "Set include_typed_info or include_fin_items to add the v2 statement-vocabulary views — the " +
      "typed company record and the financial line items that vocabulary defines. Each is ONE extra " +
      "upstream request and both are off by default.\n" +
      'emitten_type selects that vocabulary and is ignored unless one of those two is requested. ' +
      '"company" is the only value that has been observed; banks and other issuers whose statements ' +
      "differ use another value that is unconfirmed, so an override is accepted but nothing here can " +
      "tell you it is right — a wrong one is likely to come back as a not_found.\n" +
      PENDING_NOTE,
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      include_typed_info: z
        .boolean()
        .optional()
        .describe("Also fetch the v2 typed company record (one extra request). Default false"),
      include_fin_items: z
        .boolean()
        .optional()
        .describe("Also fetch the v2 financial line-item list (one extra request). Default false"),
      emitten_type: z
        .string()
        .optional()
        .describe('Statement vocabulary for the v2 views. Default "company"; other values exist but are unconfirmed'),
    },
    async (a) =>
      runTool(() =>
        core.getCompanyProfile(a.symbol as string, {
          typedInfo: a.include_typed_info as boolean | undefined,
          finItems: a.include_fin_items as boolean | undefined,
          emittenType: a.emitten_type as string | undefined,
        }),
      ),
  );

  define.read(
    "company_contact",
    "Registered address, phone, website and investor-relations contacts for a ticker, verbatim.\n" +
      "`null` means the endpoint returned no contact body — some issuers publish none. That is an " +
      "answer, not a failure.\n" +
      PENDING_NOTE,
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) => runTool(() => core.getContact(a.symbol as string)),
  );

  define.read(
    "company_subsidiaries",
    "The subsidiaries and associates Stockbit lists for a ticker.\n" +
      "This is corporate structure, not ownership OF the company — for who owns the shares use " +
      "`shareholders`.\n" +
      ROW_SOURCE_NOTE +
      "\n" +
      PENDING_NOTE,
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) => runTool(() => core.getSubsidiaries(a.symbol as string)),
  );

  define.read(
    "shareholders",
    "Share ownership composition for a ticker, as Stockbit's shareholder chart reports it.\n" +
      "Costs TWO upstream requests: the endpoint is gated behind a one-shot token that is minted and " +
      "spent immediately. The token is never returned to you and cannot be reused.\n" +
      "value_year selects the year of the reading; omit it for whatever the endpoint defaults to. " +
      "shareholder_type filters the ownership category, but its accepted values have NOT been " +
      "observed — an unrecognised one is more likely to come back as an empty chart than as an " +
      "error, so omit it unless you already know the vocabulary.\n" +
      ROW_SOURCE_NOTE +
      "\n" +
      "Pending verification: where the minted token belongs on the wire is unconfirmed; it is sent " +
      "as a `token` query parameter. An auth error here on a session that works elsewhere means that " +
      "placement is wrong, not that the account lacks access.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      value_year: z.coerce
        .number()
        .optional()
        .describe("Four-digit year of the reading, e.g. 2025. Omit for the endpoint's default"),
      shareholder_type: z
        .string()
        .optional()
        .describe("Ownership category filter. Accepted values are unobserved — omit unless known"),
    },
    async (a) =>
      runTool(() =>
        core.getShareholders(
          a.symbol as string,
          a.value_year as number | undefined,
          a.shareholder_type as string | undefined,
        ),
      ),
  );

  define.read(
    "classification",
    "Stockbit's company classification.\n" +
      'scope "taxonomy" returns the classification scheme itself — the categories. scope "company" ' +
      "returns the per-company assignments for the whole market, which is a large answer and is not " +
      "filtered by symbol: there is no symbol argument because the endpoint takes none.\n" +
      "For the IDX sector list with ids and parents, use the `sectors` tool instead; this is a " +
      "different taxonomy and the two are not interchangeable.\n" +
      ROW_SOURCE_NOTE +
      "\n" +
      PENDING_NOTE,
    {
      scope: z
        .enum(core.CLASSIFICATION_SCOPES)
        .optional()
        .describe('"taxonomy" for the scheme (default), "company" for every issuer\'s assignment'),
    },
    async (a) => runTool(() => core.getClassification(a.scope as core.ClassificationScope | undefined)),
  );

  define.read(
    "index_members",
    "The constituents of an IDX index or special board: IDX30, LQ45, KOMPAS100, and the " +
      "monitoring / syariah lists.\n" +
      "limit is REQUIRED by the endpoint and capped at " +
      String(core.INDEX_MEMBERS_MAX_LIMIT) +
      ". Omitting it upstream does not mean 'everything', so there is no default here — ask for more " +
      "than you expect rather than paging. A limit outside 1.." +
      String(core.INDEX_MEMBERS_MAX_LIMIT) +
      " is rejected before any request is made.\n" +
      "`symbols` is the tickers taken from the rows that carried one; `rowsWithoutSymbol` above zero " +
      "means that list is incomplete and you should read `rows`.\n" +
      ROW_SOURCE_NOTE +
      "\n" +
      PENDING_NOTE,
    {
      index_code: z.string().describe("Uppercase index or board code, e.g. IDX30, LQ45"),
      limit: z.coerce
        .number()
        .describe(`Max rows, 1..${core.INDEX_MEMBERS_MAX_LIMIT}. Required — the endpoint has no default`),
    },
    async (a) => runTool(() => core.getIndexMembers(a.index_code as string, a.limit as number)),
  );

  define.read(
    "sector_companies",
    "The companies in one IDX sector.\n" +
      "sector_id is the NUMERIC id from the `sectors` tool, not a sector name — a name is rejected " +
      "before any request is made. Run `sectors` first if you only have the name.\n" +
      "`symbols` is the tickers off the rows that carried one; `rowsWithoutSymbol` above zero means " +
      "that list is incomplete.\n" +
      ROW_SOURCE_NOTE +
      "\n" +
      PENDING_NOTE,
    { sector_id: z.string().describe("Numeric sector id from the `sectors` tool, e.g. 5") },
    async (a) => runTool(() => core.getSectorCompanies(a.sector_id as string)),
  );

  define.read(
    "symbol_search",
    "Search Stockbit's directory by keyword — the way to turn a company name into a ticker.\n" +
      'variant "v2" (default) is the endpoint Stockbit\'s own client uses and the only one that takes ' +
      'page, type or insider_category. variant "legacy" takes ONLY a keyword and REFUSES the others ' +
      "rather than ignoring them, so a paged call cannot silently collapse to page 1.\n" +
      "Matches are not only companies — people and other entities can appear — so `symbols` holds " +
      "just the rows that carried a ticker and can be shorter than `rows`.\n" +
      "The type and insider_category vocabularies have not been observed; an unrecognised value is " +
      "more likely to narrow the result to nothing than to raise an error. A blank keyword is " +
      "rejected here and never sent.\n" +
      ROW_SOURCE_NOTE +
      "\n" +
      PENDING_NOTE,
    {
      keyword: z.string().describe("What to search for: a ticker fragment, company name or person"),
      variant: z
        .enum(core.SEARCH_VARIANTS)
        .optional()
        .describe('"v2" (default, supports filters) or "legacy" (keyword only)'),
      page: z.coerce.number().optional().describe("1-based page number. v2 only"),
      type: z.string().optional().describe("Result-type filter. v2 only; accepted values unobserved"),
      insider_category: z
        .string()
        .optional()
        .describe("Insider-category filter. v2 only; accepted values unobserved"),
    },
    async (a) =>
      runTool(() =>
        core.search(a.keyword as string, {
          variant: a.variant as core.SearchVariant | undefined,
          page: a.page as number | undefined,
          type: a.type as string | undefined,
          insiderCategory: a.insider_category as string | undefined,
        }),
      ),
  );
}
