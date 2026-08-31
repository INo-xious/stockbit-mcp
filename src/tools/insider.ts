/**
 * Insider and ownership tools.
 *
 * All four are reads. The descriptions carry two things a model cannot infer from the schema: that
 * IDX disclosure is lagged, so none of this is a timing signal, and that these six routes have not
 * been observed live from this project, so the projections are defensive and the raw payload is
 * always included.
 */
import { z } from "zod";
import * as core from "../core/insider.js";
import { runTool } from "./_format.js";
import { StockbitError } from "../http/errors.js";
import type { Definer } from "./_define.js";

/** Repeated verbatim in every description here; the lag is the one thing that gets this misused. */
const LAG =
  "LAG: these are IDX/KSEI disclosures, not trades off the tape. A transaction appears days after " +
  "it happened and the date on a row is the transaction or record date, not the day it was " +
  "published. Do NOT use this to time an entry; use it to judge who owns the company and whether " +
  "the people running it have been adding or trimming.";

/** Also repeated: what an unverified shape means for the caller. */
const PENDING =
  "PENDING VERIFICATION: this endpoint has not been observed live, so field names are projected " +
  "ALONGSIDE the row's own keys, which are kept rather than replaced — read a field you do not see " +
  "here straight off the row.";

export function registerInsiderTools(define: Definer): void {
  define.read(
    "insider_transactions",
    "Disclosed transactions by an IDX company's insiders and major holders: directors, " +
      "commissioners, controlling shareholders and 5%+ owners, with the shares held before and " +
      "after, the percentage of the company that represents, and the executing broker.\n" +
      "This is the second bandarmology signal after broker_summary. broker_summary says which " +
      "brokers accumulated; this says whether the people who actually run the company did. Rows " +
      "carry a `badges` array where SHAREHOLDER_BADGE_DIREKTUR, _KOMISARIS and _PENGENDALI mark a " +
      "director, a commissioner and a controlling shareholder — that is the difference between an " +
      "insider trade and a fund rebalancing.\n" +
      LAG +
      "\nOmit `symbol` for the market-wide feed. Omit everything for the most recent disclosures " +
      "across IDX. An empty `rows` is a normal answer: most companies have no insider filing in a " +
      "given window.\n" +
      "DATES: `date_start` and `date_end` are both required together (YYYY-MM-DD). A half-specified " +
      "window is refused here because this API answers one with its default window and HTTP 200, " +
      "so you would believe you had filtered when you had not. For an open end pass a far date.\n" +
      "`action_type` and `source_type` filter server-side. Known actions: BUY, SELL, CROSS, " +
      "TRANSFER, CORPACTION, RIGHT_ISSUE, WARRANT_EXERCISE, MESOP_OPTION, BOND_CONVERSION, " +
      "STOCK_BONUS, PRIVATE_PLACEMENT, CAPITAL_REDUCTION, PUPS, REVERSE_SPLIT, STOCK_DIVIDEND, " +
      "TENDER_OFFER — the list is PARTIAL and an unrecognised name is sent rather than refused. " +
      "When you pass `action_type`, check `actionFilterHonored` in the result: false means the " +
      "server ignored the filter and the rows are unfiltered.\n" +
      "`insiderId` on a row is the handle for insider_ownership and shareholding(mode=investors).\n" +
      "Share counts are shares, not lots. ",
    {
      symbol: z.string().optional().describe("IDX ticker, e.g. BBRI. Omit for market-wide."),
      insider: z
        .string()
        .optional()
        .describe("Restrict to one holder, using the `insiderId` from a previous row."),
      date_start: z.string().optional().describe("Window start, YYYY-MM-DD. Requires date_end."),
      date_end: z.string().optional().describe("Window end, YYYY-MM-DD. Requires date_start."),
      page: z.coerce.number().optional().describe("1-based page (default 1). `hasMore` says if another exists."),
      limit: z.coerce.number().optional().describe("Rows per page. Stockbit's own client uses 20."),
      action_type: z
        .string()
        .optional()
        .describe("Filter by action, e.g. BUY or ACTION_TYPE_BUY. The known list is partial; unknown names are sent."),
      source_type: z
        .string()
        .optional()
        .describe("IDX (exchange filings) or KSEI (custodian records). Omit for both."),
    },
    async (a) =>
      runTool(() =>
        core.getInsiderTransactions({
          symbol: a.symbol as string | undefined,
          insider: a.insider as string | undefined,
          dateStart: a.date_start as string | undefined,
          dateEnd: a.date_end as string | undefined,
          page: a.page as number | undefined,
          limit: a.limit as number | undefined,
          actionType: a.action_type as string | undefined,
          sourceType: a.source_type as string | undefined,
        }),
      ),
    // Settled by a live call on 2026-08-29: the route answered from a real account and every
    // field this tool names was read out of that response. Opts out of the family default.
    { evidence: "observed" },
);

  define.read(
    "insider_ownership",
    "Every position one insider or major holder has disclosed, across all the IDX companies they " +
      "hold, with the recent changes to each. The inverse of insider_transactions: that one asks " +
      "'who traded this company', this asks 'what does this person own'.\n" +
      "`insider` is the `insiderId` from an insider_transactions row, not a name — there is no " +
      "name lookup on this endpoint. Run insider_transactions for the symbol first to get one.\n" +
      LAG +
      "\n`page` walks each position's `recent` list, NOT the list of positions: a position's own " +
      "`hasMore` tells you whether that position has more history, and you re-request the same " +
      "insider with a higher page to get it. An empty `positions` means this holder has no " +
      "disclosed holdings on the requested source, which is a real answer for a holder who has " +
      "sold out. " +
      PENDING,
    {
      insider: z.string().describe("Holder id, from the `insiderId` field of an insider_transactions row"),
      symbol: z.string().optional().describe("Narrow to one held ticker, e.g. BBRI"),
      page: z.coerce.number().optional().describe("1-based page of each position's `recent` list (default 1)"),
      source_type: z.string().optional().describe("IDX or KSEI. Omit for both."),
    },
    async (a) =>
      runTool(() =>
        core.getInsiderOwnership({
          insider: a.insider as string,
          symbol: a.symbol as string | undefined,
          page: a.page as number | undefined,
          sourceType: a.source_type as string | undefined,
        }),
      ),
  );

  define.read(
    "shareholding",
    "The shareholder register, from three directions. `mode` picks which:\n" +
      "- companies: who holds SYMBOL, with each holder's scrip/scripless share counts and percentage\n" +
      "- investors: what one holder holds, across every IDX company (needs `insider_id`)\n" +
      "- network: the ownership graph around a company or a holder — nodes and the stakes between " +
      "them, which is how you find the shared owner behind two unrelated-looking tickers\n" +
      "This is the register, not the tape: it is a periodic snapshot of who owns what, so it moves " +
      "on the reporting cycle rather than daily. Use insider_transactions for the changes between " +
      "snapshots. " +
      LAG +
      "\ncompanies is addressed upstream by Stockbit's internal numeric company id, NOT by ticker — " +
      "sending the ticker answers `Invalid company id`. You still pass `symbol`: the ticker is " +
      "resolved to its id first, which costs one extra request, and the id comes back as " +
      "`companyId`. A ticker Stockbit has no id for is refused here rather than upstream.\n" +
      "network needs BOTH `root_id` and `root_type` (COMPANY or INVESTOR). Get a company id from " +
      "mode=companies' `companyId` and a holder id from an insider_transactions row's `insiderId`. `max_depth` " +
      "defaults to Stockbit's own 3 and `max_edge_per_node` to 20; raising either grows the graph " +
      "fast.\n" +
      "The payload is returned WHOLE and unprojected, because this shape has not been mapped. " +
      "Beside it, `entriesFrom` names the key the holdings list actually arrived under (Stockbit's " +
      "own client hedges between `holders` and `holdings`, and between `links` and `edges`) and " +
      "`entryCount` says how many there were. entriesFrom=null with entryCount=null means no such " +
      "key was present at all, which is NOT the same as a register that came back empty. " +
      PENDING,
    {
      mode: z.enum(core.SHAREHOLDING_MODES).describe("companies | investors | network"),
      symbol: z.string().optional().describe("IDX ticker. Required for mode=companies."),
      insider_id: z.string().optional().describe("Holder id. Required for mode=investors."),
      root_id: z.string().optional().describe("Graph root: a company id or a holder id. Required for mode=network."),
      root_type: z
        .enum(core.SHAREHOLDING_NODE_TYPES)
        .optional()
        .describe("Which kind of id root_id is. Required for mode=network."),
      max_depth: z.coerce.number().optional().describe("Hops out from the root (Stockbit uses 3)"),
      max_edge_per_node: z.coerce.number().optional().describe("Edges kept per node (Stockbit uses 20)"),
      report_date: z.string().optional().describe("Pin to one report date, YYYY-MM-DD. Format unverified."),
    },
    async (a) =>
      runTool(async () => {
        const mode = a.mode as core.ShareholdingMode;
        if (mode === "companies") {
          return core.getShareholdingCompanies(requireArg(a.symbol, "symbol", mode));
        }
        if (mode === "investors") {
          return core.getShareholdingInvestors(requireArg(a.insider_id, "insider_id", mode));
        }
        return core.getShareholdingNetwork({
          rootId: requireArg(a.root_id, "root_id", mode),
          rootType: requireArg(a.root_type, "root_type", mode),
          maxDepth: a.max_depth as number | undefined,
          maxEdgePerNode: a.max_edge_per_node as number | undefined,
          reportDate: a.report_date as string | undefined,
        });
      }),
  );

  define.read(
    "ownership_composition",
    "How an IDX company's ownership is split, over a period: the make-up of the register rather " +
      "than the individual holders shareholding(mode=companies) lists.\n" +
      LAG +
      "\n`period_start` and `period_end` are both required together (YYYY-MM-DD), for the same " +
      "reason as insider_transactions: a half-specified window comes back as the default one with " +
      "HTTP 200. Omit both for whatever default period the endpoint uses.\n" +
      "The response is returned EXACTLY as Stockbit sends it, with no field renaming at all — this " +
      "is the one shape in this family with no mapped consumer to read names from, so any name " +
      "here would be invented. Read the payload as it comes. " +
      PENDING,
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      period_start: z.string().optional().describe("Period start, YYYY-MM-DD. Requires period_end."),
      period_end: z.string().optional().describe("Period end, YYYY-MM-DD. Requires period_start."),
    },
    async (a) =>
      runTool(() =>
        core.getOwnershipComposition(
          a.symbol as string,
          a.period_start as string | undefined,
          a.period_end as string | undefined,
        ),
      ),
  );
}

/**
 * Read an argument that is only required for some modes.
 *
 * The schema cannot express "required when mode=network" without four separate tools, so the check
 * lives here and fails with the mode named. Left to the core module it would surface as a confusing
 * complaint about an empty symbol.
 */
function requireArg(value: unknown, name: string, mode: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  throw new StockbitError(
    "invalid_param",
    `shareholding mode=${mode} requires ${name}`,
  );
}
