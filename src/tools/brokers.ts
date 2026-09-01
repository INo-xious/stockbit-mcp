/**
 * The broker family's tools: the code->name directory, one broker's stocks, the league table, and a
 * typed accumulation/distribution reading.
 *
 * Every description here says which parts of the output are projected and which are raw. That is
 * not decoration: these tools are read by a model that has no other documentation, and a projected
 * field it trusts blindly is worse than one it knows to check.
 *
 * Two of them now say something more awkward, and have to. `broker_top` REFUSES the order the
 * exchange sent and the `limit` the caller asked for — it sorts and trims locally, because the
 * endpoint sorts ascending and ignores `limit` — and `broker_activity` REFUSES `period`, because
 * every value of it is a 400 there. A correction a caller cannot see is its own kind of silence,
 * so each is stated in the description AND carried in the result.
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
      "`codes: [\"AK\",\"XL\"]` returns just those houses, for when you are resolving a handful of " +
      "codes out of a broker_summary rather than building a table. The filter is applied HERE, to " +
      "the cached directory, not by the exchange — so it costs no extra request, and asking for " +
      "two codes and asking for all 112 are the same one fetch. `filteredTo` echoes what you " +
      "asked for and `notFound` lists any code no row ON THAT PAGE carried, so a missing house " +
      "is stated rather than left as a shorter list you have to notice. `notFound` is not proof " +
      "the exchange has no such broker: with a narrowed `page`/`limit` it can simply be on " +
      "another page, and a row whose key names this projection does not recognise lands there " +
      "too — that is what `unmapped` counts.\n" +
      "Each entry carries `code` and `name` where a recognised key held them, " +
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
      codes: z
        .array(z.string())
        .optional()
        .describe('Keep only these broker codes, e.g. ["AK","XL"]. Filtered locally; omit for the whole directory.'),
    },
    async (a) =>
      runTool(() => brokers.getBrokerDirectory({ page: a.page, limit: a.limit, codes: a.codes })),
    // Settled by a live call on 2026-08-29: the route answered from a real account and every
    // field this tool names was read out of that response. Opts out of the family default.
    { evidence: "observed" },
);

  define.read(
    "broker_activity",
    "Which STOCKS one broker traded, and how much of each. This is the reverse lookup of " +
      "broker_summary: that tool fixes a stock and lists brokers, this one fixes a broker and " +
      "lists stocks. Chain them to answer what neither answers alone — take the biggest net seller " +
      "of a stock from broker_summary, then ask here what else that broker was distributing.\n" +
      "`broker_code` is the two-letter code (YP, CC, XL); use the `brokers` tool to find one by " +
      "name. An unknown or malformed code is rejected before any request goes out.\n" +
      "CHOOSING THE WINDOW. Pass `period` for a preset, or `from`+`to` (YYYY-MM-DD) for an exact " +
      "range; both ends are required together. Omit both and you get the server's default, which " +
      "measured 2026-09-01 was that single day. Rows are per stock PER DAY, so a multi-day window " +
      "returns several rows for the same ticker — one per session it traded.\n" +
      "The `period` NAME never goes on the wire. This endpoint answers 400 to `period` on every " +
      "spelling and every value (measured 2026-09-01), but it accepts `from`/`to`, so a preset is " +
      "resolved into a date pair here and the dates are sent. That resolution is this server's own " +
      "calendar arithmetic, checked against Stockbit's: asked for LAST_7_DAYS and LAST_3_MONTHS, " +
      "broker_summary resolved them to the same dates this does. YEAR_TO_DATE it starts on " +
      "January 1st where Stockbit starts on the first trading day — a difference that cannot move " +
      "a figure, because a window padded with days the exchange was shut contains no extra trades " +
      "(measured: a Saturday start and the following Monday returned identical rows).\n" +
      "You never have to trust that arithmetic. `request` echoes the dates actually sent and " +
      "`from`/`to` on the result are the window the SERVER says it served.\n" +
      "FILTERS: `market_types` and `investor_types` each take a LIST, and each value is sent as its " +
      "own repeated parameter. Passing several boards means the union of those boards. Omit a " +
      "filter and it is not sent at all, in which case the server picks the default and this tool " +
      "cannot tell you which one it picked. REGULER is the ordinary order book and what " +
      "bandarmology normally means; ALL folds in negotiated block trades and can be several times " +
      "larger.\n" +
      "`request` in the result echoes exactly what was sent, so the filters behind the rows are " +
      "always visible.\n" +
      "BUY AND SELL ARE SEPARATE ROWS, and `side` is the only thing that tells them apart. The " +
      "response splits the two halves into `brokers_buy` and `brokers_sell` and sends BOTH as " +
      "positive numbers, so a sell row read without its side looks exactly like a buy. Never infer " +
      "the direction from a sign, and never sum `value` across sides without grouping by `side` " +
      "first — that total is turnover, not net flow.\n" +
      "Each row carries `symbol`, `side`, `date`, `value` (rupiah), `lot`, `avgPrice`, `freq` and " +
      "`investorType`, every one with `readFrom` naming the wire key it came from, and the whole " +
      "untouched row beside them. Absent means the wire did not carry it — never zero.\n" +
      "`rowsFrom` names the containers the rows came out of. `count: 0` with a populated " +
      "`rowsFrom` is a broker who traded nothing in that window; `rowsFrom: null` means the " +
      "payload was NOT PARSED — a shape this tool does not recognise, with `dataKeys` naming what " +
      "was actually there. Reporting the second as the first is the defect this tool was fixed " +
      "for: it read `count: 0` for a broker with 868 buy rows and 836 sell rows, because it " +
      "searched for an array and this route nests the two sides inside an object.",
    {
      broker_code: z.string().describe("Broker code, 2-4 uppercase letters or digits, e.g. YP"),
      period: z
        .enum(brokers.ACTIVITY_PERIODS)
        .optional()
        .describe(
          "Preset window, resolved here into `from`/`to` and sent as dates — the name itself is " +
            "refused by this endpoint. Ignored when `from`/`to` are given. Omitted means the " +
            "server's own default window.",
        ),
      from: z.string().optional().describe("Range start, YYYY-MM-DD. Requires `to`."),
      to: z.string().optional().describe("Range end, YYYY-MM-DD (inclusive). Requires `from`."),
      date_from: z.string().optional().describe("Alias for `from`."),
      date_to: z.string().optional().describe("Alias for `to`."),
      start_date: z.string().optional().describe("Alias for `from`."),
      end_date: z.string().optional().describe("Alias for `to`."),
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
          from: a.from,
          to: a.to,
          date_from: a.date_from,
          date_to: a.date_to,
          start_date: a.start_date,
          end_date: a.end_date,
          marketTypes: a.market_types as readonly unknown[] | undefined,
          investorTypes: a.investor_types as readonly unknown[] | undefined,
          sortBy: a.sort_by,
          page: a.page,
          limit: a.limit,
        }),
      ),
    // Settled by live calls on 2026-09-01 against YP: rows came back and every field named above
    // was read out of one of them, which is the bar. The same session settled the window —
    // `from`/`to` bind and are echoed — and exposed the two-sided container. Opts out of the
    // family default, which is `projected`.
    { evidence: "observed" },
  );

  define.read(
    "broker_top",
    "The market-wide broker league table: which brokers moved the most, across every stock rather " +
      "than one. Use it to pick a broker worth asking broker_activity about.\n" +
      "This is a market-level ranking, not a per-stock one — a broker at the top of it is not " +
      "thereby active in any particular stock. For a single stock use broker_summary.\n" +
      "THE ORDER IS THIS SERVER'S, NOT THE EXCHANGE'S. The endpoint answers ASCENDING by " +
      "`total_value` — biggest broker LAST — and no sort argument reverses it: `sort_by`, " +
      "`order_by` and `sort_direction` are accepted and change nothing, `order` and `sort` are " +
      "refused with a 400. So the rows are re-sorted here, DESCENDING by `total_value`, and " +
      "`sortedLocally` on the result says so. `sortedLocally.unsortable` counts rows whose " +
      "`total_value` could not be read; they keep their wire order at the END, because a row with " +
      "no rank is not given one.\n" +
      "`limit` IS ALSO THIS SERVER'S. The endpoint ignores it — the same 89 rows come back at " +
      "limit=3 and limit=5 — so the cap is applied here, after the sort, and `limitAppliedLocally` " +
      "names it while `countBeforeLimit` says how many rows there were before the trim. Do not " +
      "read a short list as the exchange's answer to your `limit`.\n" +
      "Board and investor-class filters are deliberately NOT offered here: they are documented for " +
      "the broker_activity route and only for it, and a filter this endpoint quietly ignores would " +
      "widen the answer without saying so. Use broker_activity when you need them.\n" +
      "Each entry carries `code`, `name`, `investorType` and `group` as sent, the figures " +
      "`totalValue`, `netValue`, `buyValue`, `sellValue`, `totalVolume` and `totalFrequency` as " +
      "numbers, `readFrom` naming the wire key each was read from, and the whole raw row under " +
      "`row`. UNITS ARE NOT ESTABLISHED FOR THIS ROUTE. The value figures are consistent with " +
      "rupiah by their magnitude (the largest broker on the 2026-09-01 reading was 5,636,360,451,396), " +
      "but `totalVolume`'s unit was never sampled and nothing here has confirmed whether it is lots " +
      "or shares. Elsewhere in this API that distinction is a factor of 100 and it is genuinely " +
      "mixed — `orderbook.volume` is SHARES while `technicals.volumeLots` is LOTS — so do not " +
      "assume this one matches either without checking. A figure that was not sent, or that this " +
      "server would not parse, is ABSENT together with its `readFrom` entry — never zero.\n" +
      "`date` carries the session the table covers (`from`, `to`, `idx`) when the response " +
      "volunteered it, which is the only thing dating these figures.\n" +
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
            "The list is partial, so any uppercase token is accepted. It does NOT decide the order " +
            "you get back: no value of it was seen to change the endpoint's ordering, and the rows " +
            "are sorted here descending by total_value regardless. It is sent, and echoed in " +
            "`request`, in case it selects something other than order.",
        ),
      page: z.coerce.number().optional().describe("1-based page. Omitted means the server default."),
      limit: z
        .coerce.number()
        .optional()
        .describe(
          "Rows to keep. Applied HERE after the descending sort, because the endpoint ignores its " +
            "own limit; it is not sent. `limitAppliedLocally` echoes it and `countBeforeLimit` " +
            "says what it trimmed.",
        ),
    },
    async (a) =>
      runTool(() =>
        brokers.getBrokerTop({ period: a.period, sortBy: a.sort_by, page: a.page, limit: a.limit }),
      ),
    // Settled by a live call on 2026-08-29: the route answered from a real account and every
    // field this tool names was read out of that response. Opts out of the family default.
    { evidence: "observed" },
);

  define.read(
    "bandar_detector",
    "A typed accumulation/distribution reading for one IDX stock, computed from the same broker " +
      "summary broker_summary returns: net buy and net sell totals for the window, the top " +
      "accumulators and distributors, and how concentrated each side is. It returns no verdict, no " +
      "score and no price forecast. A broker code is a pipe carrying thousands of unrelated " +
      "clients, not a person — the bandar-check skill has the rest of what this cannot prove, and " +
      "reading it before drawing a conclusion is the difference between flow and a story.\n" +
      "SIGNS: values are IDR, volumes are LOTS. Sell figures are NEGATIVE — `sellValueIdr`, " +
      "`sellLots`, and `netValueIdr` on anything in `topDistributors` — because that is how " +
      "Stockbit sends them. Do not negate them again.\n" +
      "`netValueIdr` is `buyValueIdr` minus the MAGNITUDE of `sellValueIdr`: how lopsided the two " +
      "sides are, not how much was bought. Near zero is the normal reading of a complete NET " +
      "table, since both sides describe the same trades from opposite ends. A large magnitude " +
      "means they do not cover the same trades — usually truncation, sometimes GROSS. `limit` " +
      "applies PER SIDE, so equal list lengths prove nothing; check whether `buyersListed` or " +
      "`sellersListed` has REACHED `limit`, and if so raise it and see whether the totals move.\n" +
      "`topDistributors` is largest seller FIRST, by size of flow. Concentration shares are " +
      "fractions of one side taken on magnitudes, so both sides are positive; a null share means " +
      "the question cannot be asked — that side is empty, or none of its figures could be read.\n" +
      "`unreadable.buyers` / `.sellers` count listed brokers left out of that side's totals, so " +
      "`buyers: 1` against `buyersListed: 16` means every buy figure covers 15 brokers.\n" +
      "Broker codes come back bare unless you pass `resolve_names: true`, which adds each house as " +
      "`name` on the two lists by joining against the cached `brokers` directory. Best-effort: if " +
      "the directory cannot be read every figure is unchanged and `names.note` says why, and a " +
      "code the directory does not carry simply has no `name`.\n" +
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
      resolve_names: z
        .boolean()
        .optional()
        .describe("Add each broker's securities house as `name`, joined from the cached directory."),
    },
    async (a) =>
      runTool(async () => {
        const reading = await brokers.getBandarDetector({
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
        });
        if (!a.resolve_names) return reading;
        // Only the two lists that are returned. `getBandarDetector` already slices them off a
        // sorted copy, so these are this call's own arrays and no cache entry is touched.
        // Both lists through ONE directory read — see `withBrokerNamesAll`.
        const [accumulators, distributors] = await brokers.withBrokerNamesAll([
          reading.topAccumulators,
          reading.topDistributors,
        ]);
        const note = accumulators.resolution.note ?? distributors.resolution.note;
        return {
          ...reading,
          topAccumulators: accumulators.rows,
          topDistributors: distributors.rows,
          names: {
            resolved: accumulators.resolution.resolved && distributors.resolution.resolved,
            ...(note ? { note } : {}),
          },
        };
      }),
    // Opts out of this scope's `projected` default. It computes entirely on `getBrokerSummary`,
    // whose route IS observed and whose response is the fixture committed at
    // test/fixtures/broker_summary_BBRI.json. `resolve_names` adds the only request it can make on
    // its own, to the broker directory — also observed, and `brokers` above declares it so. The
    // declaration therefore still covers every route this tool can touch.
    { evidence: "observed" },
  );
}
