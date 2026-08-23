/**
 * The broker family's tools: the code->name directory, one broker's stocks, the league table, and a
 * typed accumulation/distribution reading.
 *
 * Three of the four run on routes nobody has observed live, so their descriptions say which parts
 * of the output are projected and which are raw. That sentence is not decoration: these tools are
 * read by a model that has no other documentation, and a projected field it trusts blindly is worse
 * than one it knows to check.
 */
import { z } from "zod";
import * as brokers from "../core/brokers.js";
import {
  BROKER_SUMMARY_PERIODS,
  INVESTOR_TYPES,
  MARKET_BOARDS,
  TRANSACTION_TYPES,
  type BrokerSummaryPeriod,
  type InvestorType,
  type MarketBoard,
  type TransactionType,
} from "../core/marketdetectors.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

export function registerBrokerTools(define: Definer): void {
  define.read(
    "brokers",
    "The IDX broker directory: what every two-letter broker code stands for. This is the lookup " +
      "that makes broker_summary, broker_distribution and bandar_detector readable — their output " +
      "is bare codes like YP, CC, XL, and this turns them into securities houses.\n" +
      "One page covers the whole exchange at the default limit of 150, so call it once and reuse " +
      "the mapping; it is cached for five minutes and the membership list changes only when a " +
      "house is licensed or renamed.\n" +
      "PENDING VERIFICATION: this route has not been observed live, so field names are projected " +
      "defensively. Each entry carries `code` and `name` where a recognised key held them, " +
      "`readFrom` naming the wire key each was read from, and `row` with the entire raw row. If " +
      "`code` is undefined the projection did not recognise this row's key names — read `row` " +
      "directly and report `unmapped.sampleKeys`, which lists what the row actually contained.\n" +
      "`rowsFrom` names the envelope key the rows came out of. `rowsFrom: null` with `count: 0` " +
      "means the response carried no array at all: that is either a genuinely empty page or a " +
      "response shape this projection does not know, and `dataKeys` shows which it was. It is not " +
      "the same as a directory with no brokers in it.",
    {
      page: z.coerce.number().optional().describe("1-based page (default 1)"),
      limit: z.coerce.number().optional().describe("Rows per page (default 150, which covers IDX in one page)"),
    },
    async (a) =>
      runTool(() => brokers.getBrokerDirectory({ page: a.page, limit: a.limit })),
  );

  define.read(
    "broker_activity",
    "Which STOCKS one broker traded, and how much of each. This is the reverse lookup of " +
      "broker_summary: that tool fixes a stock and lists brokers, this one fixes a broker and " +
      "lists stocks. Chain them to answer what neither answers alone — take the biggest net seller " +
      "of a stock from broker_summary, then ask here what else that broker was distributing.\n" +
      "`broker_code` is the two-letter code (YP, CC, XL); use the `brokers` tool to find one by " +
      "name. An unknown or malformed code is rejected before any request goes out.\n" +
      "FILTERS: `market_types` and `investor_types` each take a LIST, and each value is sent as its " +
      "own repeated parameter. Passing several boards means the union of those boards. Omit a " +
      "filter and it is not sent at all, in which case the server picks the default and this tool " +
      "cannot tell you which one it picked — pass `period` if the window matters to your answer. " +
      "REGULER is the ordinary order book and what bandarmology normally means; ALL folds in " +
      "negotiated block trades and can be several times larger.\n" +
      "`request` in the result echoes exactly what was sent, so the window and filters behind the " +
      "rows are always visible.\n" +
      "PENDING VERIFICATION: this route has not been observed live. Only the traded `symbol` is " +
      "projected, with `readFrom.symbol` naming the key it came from; the value, volume and " +
      "frequency figures are left inside the raw `row` under their own names rather than renamed on " +
      "a guess, because a net figure read out of the wrong key would point confidently the wrong " +
      "way. Read them from `row`.\n" +
      "`rowsFrom: null` with `count: 0` means the response carried no array — an empty result or an " +
      "unrecognised shape, distinguished by `dataKeys` — and NOT a broker who traded nothing.",
    {
      broker_code: z.string().describe("Broker code, 2-4 uppercase letters or digits, e.g. YP"),
      period: z
        .enum(brokers.BROKER_PERIODS)
        .optional()
        .describe(
          "Window to aggregate over, e.g. LAST_1_DAY, LAST_7_DAYS, YEAR_TO_DATE. Omitted means " +
            "the server's own default, which this tool cannot report.",
        ),
      market_types: z
        .array(z.enum(brokers.BROKER_MARKET_TYPES))
        .optional()
        .describe("Boards to include, as a list. Each value is sent as its own repeated parameter."),
      investor_types: z
        .array(z.enum(brokers.BROKER_INVESTOR_TYPES))
        .optional()
        .describe("Investor classes to include, as a list. Also sent as repeated parameters."),
      sort_by: z
        .string()
        .optional()
        .describe(
          `Sort key, without the SORT_BY_ prefix. Known values: ${brokers.BROKER_SORT_KEYS.join(", ")}. ` +
            "The list was read from Stockbit's own bundle and is partial, so any uppercase token " +
            "is accepted.",
        ),
      page: z.coerce.number().optional().describe("1-based page. Omitted means the server default."),
      limit: z.coerce.number().optional().describe("Rows per page. Omitted means the server default."),
    },
    async (a) =>
      runTool(() =>
        brokers.getBrokerActivity({
          brokerCode: a.broker_code,
          period: a.period,
          marketTypes: a.market_types as readonly unknown[] | undefined,
          investorTypes: a.investor_types as readonly unknown[] | undefined,
          sortBy: a.sort_by,
          page: a.page,
          limit: a.limit,
        }),
      ),
  );

  define.read(
    "broker_top",
    "The market-wide broker league table: which brokers moved the most, across every stock rather " +
      "than one. Use it to pick a broker worth asking broker_activity about.\n" +
      "This is a market-level ranking, not a per-stock one — a broker at the top of it is not " +
      "thereby active in any particular stock. For a single stock use broker_summary.\n" +
      "Board and investor-class filters are deliberately NOT offered here: they are documented for " +
      "the broker_activity route and only for it, and a filter this endpoint quietly ignores would " +
      "widen the answer without saying so. Use broker_activity when you need them.\n" +
      "PENDING VERIFICATION: this route has not been observed live. Each entry carries `code` and " +
      "`name` where a recognised key held them, `readFrom` naming those keys, and the whole raw " +
      "row under `row` — the value, volume and frequency figures are in there under names that " +
      "have not been confirmed, so read them from `row`.\n" +
      "`rowsFrom: null` with `count: 0` means no array was found in the response, not an empty " +
      "market; `dataKeys` shows what the response did carry.",
    {
      period: z
        .enum(brokers.BROKER_PERIODS)
        .optional()
        .describe("Window, e.g. LAST_1_DAY or YEAR_TO_DATE. Omitted means the server's own default."),
      sort_by: z
        .string()
        .optional()
        .describe(
          `Sort key without the SORT_BY_ prefix. Known values: ${brokers.BROKER_SORT_KEYS.join(", ")}. ` +
            "The list is partial, so any uppercase token is accepted.",
        ),
      page: z.coerce.number().optional().describe("1-based page. Omitted means the server default."),
      limit: z.coerce.number().optional().describe("Rows per page. Omitted means the server default."),
    },
    async (a) =>
      runTool(() =>
        brokers.getBrokerTop({ period: a.period, sortBy: a.sort_by, page: a.page, limit: a.limit }),
      ),
  );

  define.read(
    "bandar_detector",
    "A typed accumulation/distribution reading for one IDX stock, computed from the same broker " +
      "summary broker_summary returns: total net buy and net sell value for the window, the top " +
      "accumulators and distributors, and how concentrated each side is.\n" +
      "WHAT IT DOES NOT PROVE, which matters more than the numbers:\n" +
      "- A broker code is a pipe, not a person. One broker carries thousands of unrelated clients, " +
      "so 'YP accumulated 40%' means YP's clients did, and they are not one buyer with one plan.\n" +
      "- The same owner can split orders across several brokers precisely so this reading shows " +
      "nothing. LOW concentration is therefore not evidence of absence.\n" +
      "- A single session says very little. Institutions build over weeks, and one day of net " +
      "buying sits inside ordinary two-way flow. Pass `period` or a from/to window before drawing " +
      "any conclusion.\n" +
      "- Nothing here separates accumulation from a client moving between accounts, a market maker " +
      "hedging, an index fund tracking a reweight, or a pre-agreed block. It returns no verdict, " +
      "no score and no price forecast.\n" +
      "READING THE NUMBERS: values are IDR, volumes are LOTS (1 lot = 100 shares). `netValueIdr` " +
      "is buy minus sell across the listed brokers and is near ZERO on a complete NET table by " +
      "construction — both sides describe the same trades — so a large magnitude means the table " +
      "was truncated by `limit` or the request was GROSS, not that the stock was bought up. Reason " +
      "from `buyValueIdr` / `sellValueIdr` and the two lists.\n" +
      "Concentration shares are null, never 0, when there is nothing on that side to take a share " +
      "of — a weekend or a halted stock gives null, which is not 'evenly spread'.\n" +
      "Broker codes come back bare; the `brokers` tool turns them into names.\n" +
      "DATES: omit from/to for the latest session, or supply BOTH (YYYY-MM-DD). A half-specified " +
      "range is rejected because the API would silently answer with the latest session instead.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      top: z.coerce.number().optional().describe("Brokers to keep per side (default 5, max 50)"),
      from: z.string().optional().describe("Range start, YYYY-MM-DD. Requires `to`."),
      to: z.string().optional().describe("Range end, YYYY-MM-DD (inclusive). Requires `from`."),
      // Accepted for the same reason broker_summary accepts them: a caller reaches for these
      // spellings, the API ignores them and answers 200 with the latest session, so they are
      // normalized onto from/to rather than left to fail silently.
      date_from: z.string().optional().describe("Alias for `from`."),
      date_to: z.string().optional().describe("Alias for `to`."),
      start_date: z.string().optional().describe("Alias for `from`."),
      end_date: z.string().optional().describe("Alias for `to`."),
      period: z
        .enum(BROKER_SUMMARY_PERIODS)
        .optional()
        .describe(
          "Preset window instead of from/to — LATEST (default), YESTERDAY, LAST_7_DAYS, " +
            "LAST_3_MONTHS, YEAR_TO_DATE. Aggregated server-side in one request, so YEAR_TO_DATE " +
            "costs the same as today. Ignored when from/to are given.",
        ),
      limit: z
        .coerce.number()
        .optional()
        .describe(
          "Max brokers per side fetched from the summary (default 50). Raising it widens the " +
            "totals and the concentration denominators; it is not the same as `top`, which only " +
            "trims the two lists that are returned.",
        ),
      transaction_type: z
        .enum(TRANSACTION_TYPES)
        .optional()
        .describe("NET (default) nets each broker's buys against its sells; GROSS does not."),
      market_board: z
        .enum(MARKET_BOARDS)
        .optional()
        .describe(
          "Default REGULER — the ordinary order book, and what bandarmology means. ALL folds in " +
            "negotiated blocks and can be several times larger.",
        ),
      investor_type: z.enum(INVESTOR_TYPES).optional().describe("Default ALL"),
    },
    async (a) =>
      runTool(() =>
        brokers.getBandarDetector({
          symbol: a.symbol as string,
          top: a.top,
          limit: a.limit as number | undefined,
          period: a.period as BrokerSummaryPeriod | undefined,
          transactionType: a.transaction_type as TransactionType | undefined,
          marketBoard: a.market_board as MarketBoard | undefined,
          investorType: a.investor_type as InvestorType | undefined,
          from: a.from,
          to: a.to,
          date_from: a.date_from,
          date_to: a.date_to,
          start_date: a.start_date,
          end_date: a.end_date,
        }),
      ),
  );
}
