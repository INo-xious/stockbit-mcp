/**
 * Market-data tools: the one-request chart series, the running-trade tape, the trade book, the
 * order queue, and the session clock that says whether any of them should have data right now.
 *
 * Every description below states what an empty answer means, because on this API an empty answer is
 * the normal shape of several different problems: the market is shut, the symbol is suspended, or a
 * parameter was not understood and the endpoint answered 200 anyway. A model reading these tools has
 * no other way to tell those apart.
 */
import { z } from "zod";
import * as core from "../core/market.js";
import { MARKET_MOVER_VIEWS } from "../http/transport.js";
import type { MarketMoverView } from "../http/transport.js";
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

/** Appended where the row shape has not been observed live, so a caller does not over-trust it. */
const PENDING = "PENDING VERIFICATION: this response shape has not been observed live.";

export function registerMarketTools(define: Definer): void {
  define.read(
    "chart_series",
    "A whole daily OHLCV series for one symbol in ONE request, oldest bar first.\n" +
      "This is the cheap path. The other one (the `bars` family) pages 12 rows at a time, so a year " +
      "costs ~21 upstream calls and three years ~62; this costs one. Prefer it when you need a " +
      "series and a calendar window is good enough.\n" +
      "timeframe is a CALENDAR WINDOW, not a bar interval, and must be lowercase: 1w, 1m, 3m, ytd, " +
      "1y, 3y, 5y. Bars are always daily. An uppercase or interval-style value (1D, DAILY) is " +
      "refused here rather than sent, because the server answers those with HTTP 200 and an empty " +
      "series that looks exactly like a symbol with no history.\n" +
      "This tool ERRORS instead of returning an empty series — including when the response parses " +
      "but holds no points. An empty result would be indistinguishable from a broken fast path, so " +
      "on an error fall back to the paged bars tools rather than concluding the symbol has no data.\n" +
      "Check `unmapped` and `warnings` on the result before using the numbers. On the daily route " +
      "the close arrives as `value` and open/high/low/volume arrive EMPTY, so every candle is flat " +
      "and `warnings` says so: candlestick patterns and high/low indicators are meaningless on this " +
      "series. Volume on that route comes back NULL, not 0 — a field that arrived empty on every " +
      "bar is absent, and `warnings` names every such field. `mapped`, `extraKeys` and `sample` show " +
      "which wire keys were used and what else the point carried.\n" +
      "raw=true returns THIS ROUTE'S payload untouched instead of bars — the same request, with " +
      "nothing projected. Use it only to discover real field spellings when `unmapped` or " +
      "`extraKeys` is non-empty; it is not a fallback and returns no `bars`.\n" +
      "raw=true used to read a DIFFERENT endpoint. It called /charts/:symbol while the projection " +
      "reads /charts/:symbol/daily, and handed the first the second's vocabulary — so the escape " +
      "hatch could not reproduce the payload it exists to diagnose. Measured 2026-09-01 the two do " +
      "not share a vocabulary: /charts/:symbol REFUSES 1w with 400 \"Kurun waktu tidak valid\" and " +
      "answers `{chart_points: []}` for everything else, while the daily route accepts 1w and " +
      "answers the rich payload. That is why 1w errored and 1m came back empty — the route was " +
      "wrong, not the value. Fixed: raw now reads the same route as the projection.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      timeframe: z
        .enum(core.CHART_TIMEFRAMES)
        .describe("Calendar window, lowercase: 1w, 1m, 3m, ytd, 1y, 3y, 5y. Bars are daily regardless."),
      raw: z
        .boolean()
        .optional()
        .describe("Return the unprojected chart payload instead of bars. Default false."),
    },
    async (a) =>
      runTool(() =>
        a.raw === true
          ? core.getChartRaw(a.symbol as string, a.timeframe as string)
          : core.getSeriesBars(a.symbol as string, a.timeframe as string),
      ),
    // Settled by a live call on 2026-08-29: the route answered from a real account and every
    // field this tool names was read out of that response. Opts out of the family default.
    { evidence: "observed" },
);

  define.read(
    "running_trade",
    "The running-trade tape: individual prints as they cross the exchange.\n" +
      "Omit `symbol` for the market-wide tape, pass it to follow one ticker. `action` filters to one " +
      "side (BUY = buyer-initiated, SELL = seller-initiated); omitted means the endpoint's own " +
      "default, which is not necessarily ALL.\n" +
      "grouped=true reads a different endpoint that returns the tape aggregated rather than print by " +
      "print. It is not a display option: the two return different payloads.\n" +
      "WHICH SESSION AM I LOOKING AT. Both views carry `data.date` and it is the answer — read it " +
      "rather than assuming today. Measured 2026-09-01 after the ~18:00 WIB broker release, both " +
      "served that same day. Broker-derived and foreign-derived figures across this API publish at " +
      "roughly 18:00 WIB, so before that release a payload carrying YESTERDAY's date is correct and " +
      "not yet published — it is not stale data and not a bug. market_movers' `foreign.isShown` is " +
      "the explicit flag for the same thing and flips false to true across that release.\n" +
      "INTRADAY BROKER ATTRIBUTION DOES NOT EXIST TO BE RETURNED. IDX closed broker codes on live " +
      "running trade on 6 December 2021. So `is_broker_exists: false` with empty `buyer`/`seller` " +
      "is an honest answer about the exchange, not a parse failure or a missing field — check that " +
      "flag per row rather than concluding the projection broke.\n" +
      "THIS TAPE IS NOT LIVE. Measured against the live API during an open session, it runs about " +
      "EIGHT TO TEN MINUTES BEHIND and refreshes in bursts — its head sat unchanged for over three " +
      "minutes while the lag grew second for second, and the staleness is at Stockbit's origin, not " +
      "in a CDN. Do not answer 'what just traded' from it. src/live/tape.ts exists because of this.\n" +
      "READ THIS BEFORE ASKING IT ABOUT THE CLOSE. Measured 2026-08-28: the window always starts at " +
      "the SESSION OPEN, at most 100 rows come back however large `limit` is, and `offset`/`page` " +
      "are accepted but move nothing. So on a busy ticker this tool can only ever show the first " +
      "100 prints of the day — the last trade before the close is NOT reachable through it at any " +
      "argument. A limit above 100 is refused here rather than silently truncated. USE " +
      "broker_flow_intraday for anything about the rest of the session: it covers 09:00 to 16:14 at " +
      "one-minute resolution with per-broker value and volume, and it is the tool that answers the " +
      "questions this one cannot.\n" +
      "`order_by` is required upstream and is NOT a time ordering: 1 is chronological from the open " +
      "with real trade sizes, 2 and 3 both return lot-ascending rows that were every one a 1-lot " +
      "trade when measured. None of the three returns the most recent prints and none returns the " +
      "largest. 1 is the default because it is the only one that answers a question anyone asks.\n" +
      "An empty result is NORMAL outside 09:00-16:00 WIB — the tape is a live feed and nothing " +
      "crosses when the market is shut. Call market_session before treating emptiness as a fault.\n" +
      PENDING,
    {
      symbol: z.string().optional().describe("IDX ticker. Omit for the market-wide tape."),
      action: z.enum(core.RUNNING_TRADE_ACTIONS).optional().describe("ALL, BUY or SELL. Omitted sends no filter."),
      limit: z.coerce
        .number()
        .optional()
        .describe(`Max rows, 1-${core.RUNNING_TRADE_MAX_LIMIT}. Larger is refused: the endpoint ignores it.`),
      order_by: z.coerce
        .number()
        .optional()
        .describe("1 chronological from the open (default), 2 and 3 lot-ascending. Not a time ordering."),
      grouped: z.boolean().optional().describe("Read the aggregated view instead of the print-by-print tape."),
    },
    async (a) =>
      runTool(() =>
        core.getRunningTrade({
          symbol: a.symbol as string | undefined,
          action: a.action as (typeof core.RUNNING_TRADE_ACTIONS)[number] | undefined,
          limit: a.limit as number | undefined,
          orderBy: a.order_by as 1 | 2 | 3 | undefined,
          grouped: a.grouped as boolean | undefined,
        }),
      ),
  );

  define.read(
    "trade_book",
    "Traded volume broken down by price level for a session.\n" +
      "mode=BIG_MONEY restricts to large prints, mode=OVERALL covers everything; omitted sends no " +
      "mode. data_modes excludes auction phases: EXCLUDE_PRE drops the pre-opening auction, " +
      "EXCLUDE_POST the post-closing one. Both auctions match at a single price and can distort the " +
      "distribution badly, so excluding them changes the picture rather than trimming it.\n" +
      "chart=true reads a different endpoint returning the chart form of the same idea, not a " +
      "rendering of this one.\n" +
      "`group_by` is REQUIRED: without it every call answers 400 \"Group by is required\" whatever " +
      "else is sent, which is why this tool could not be called at all until the parameter " +
      "existed. PASS group_by=1 — measured 2026-09-01, that returns the by-price book this tool is " +
      "named for. 2 is also accepted but answered empty on a closed market, so what it groups by is " +
      "not established; 0 is read as absent and 3 is refused. Only those four have been tried, so " +
      "your value is sent verbatim rather than checked against a list. chart=true is a different " +
      "endpoint and has never been seen to demand it, so it is not required there.\n" +
      "An empty result is normal before the session's first print. It is a per-session view: there " +
      "is no date argument, so this is today.\n" +
      "PENDING VERIFICATION, and precisely which part: the RESPONSE has now been seen live — a " +
      "`book` of price levels, each with buy/sell/pre_open/post_close/total blocks — but `mode` and " +
      "`data_modes` have never been observed to be accepted, because until `group_by` existed no " +
      "call from this project ever reached this endpoint at all. Treat those two as unverified " +
      "guesses and check the payload rather than assuming a filter was applied.",
    {
      symbol: z.string().optional().describe("IDX ticker. Omit for whatever the endpoint returns market-wide."),
      mode: z.enum(core.TRADE_BOOK_MODES).optional().describe("OVERALL or BIG_MONEY. Omitted sends no mode."),
      data_modes: z
        .array(z.enum(core.TRADE_BOOK_DATA_MODES))
        .optional()
        .describe("Auction phases to exclude: EXCLUDE_PRE and/or EXCLUDE_POST."),
      group_by: z
        .string()
        .optional()
        .describe("REQUIRED. Use 1 for the by-price book; 2 is accepted, 3 is refused. Sent verbatim."),
      limit: z.coerce.number().optional().describe("Max rows. Omitted takes the server default."),
      chart: z.boolean().optional().describe("Read the chart endpoint instead of the table."),
    },
    async (a) =>
      runTool(() =>
        core.getTradeBook({
          groupBy: a.group_by as string | undefined,
          symbol: a.symbol as string | undefined,
          mode: a.mode as (typeof core.TRADE_BOOK_MODES)[number] | undefined,
          dataModes: a.data_modes as (typeof core.TRADE_BOOK_DATA_MODES)[number][] | undefined,
          limit: a.limit as number | undefined,
          chart: a.chart as boolean | undefined,
        }),
      ),
  );

  define.read(
    "broker_flow_intraday",
    "Per-broker intraday flow for one symbol, minute by minute, returned exactly as Stockbit sends " +
      "it. The tool name is now a description of the payload rather than a hope: read live on " +
      "2026-09-01 against BBRI it carried 335 ONE-MINUTE points spanning 09:00 to 16:14.\n" +
      "`data.price_chart_data` is the price series — each point `{date, time, datetime_label, " +
      "value{raw,formatted}, open, high, low}`. `data.broker_chart_data` is a list of TWO series, " +
      "`TYPE_CHART_VALUE` and `TYPE_CHART_VOLUME`; each carries a `brokers` list of codes and a " +
      "`charts` array of `{broker_code, chart[]}` on the same minute grid. Beside them sit `from`, " +
      "`to`, `data_last_updated` and `date_session_info`.\n" +
      "This is the highest-resolution view of the session this server has, and unlike running_trade " +
      "it covers the WHOLE session rather than the first 100 prints. Only the top few brokers " +
      "appear (five on the reading above), so it ranks the session's main participants — it is not " +
      "a complete broker list. For the full table use broker summary or broker distribution.\n" +
      "WHICH SESSION, AND WHEN IT IS PUBLISHED. The payload states its own window — `from`, `to` " +
      "and `date_session_info` — and that is the answer; read it rather than assuming today. " +
      "Measured 2026-09-01 at 18:40 WIB, all three read that same trading day. Broker-derived data " +
      "across this API publishes at roughly 18:00 WIB, so BEFORE that release this endpoint serves " +
      "the PREVIOUS session and says so in `from`/`to`. That is correct and unpublished, not stale " +
      "— the earlier claim that it 'covers the current session only, and is empty before the first " +
      "print of the day' was never achievable and is withdrawn.\n" +
      "CAUTION on `data_last_updated`: it is stamped with a `Z` suffix but the value is WIB. The " +
      "2026-09-01 reading was \"2026-09-01T16:28:44Z\" at a moment when UTC was 11:28 — five hours " +
      "in the future, and 16:28 WIB is minutes after the 16:15 close, which is the only reading " +
      "that makes sense. Do NOT parse this field as UTC; it is seven hours ahead of what it claims.",
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) => runTool(() => core.getRunningTradeChart(a.symbol as string)),
    // Settled by a live call on 2026-09-01: every key named above was read out of a real response.
    // Opts out of the family default, which is `projected` for the rest of these.
    { evidence: "observed" },
  );

  define.read(
    "market_movers",
    "The market movers behind Stockbit's own Movers dialog — the market-wide ranking.\n" +
      "This is a DIFFERENT endpoint from top_movers, which reads the hotlist, and the difference is " +
      "not cosmetic: measured 2026-09-01, the hotlist served NINE symbols while this served FIFTY, " +
      "including structured warrants. Different universes. A symbol in one and not the other is " +
      "expected, and a disagreement is not evidence that either is wrong. For a market-wide " +
      "ranking, this is the one to use.\n" +
      "`view` selects the tab, and the vocabulary is CLOSED to the eight members the server was " +
      "seen to accept: topGainer, topLoser, topValue, topVolume, topFrequency, netForeignBuy, " +
      "netForeignSell, bigMoneyNetValue. Each was echoed back verbatim on 2026-09-01, against a " +
      "control value that answers 400 — so this endpoint rejects members it does not know rather " +
      "than silently serving its default, which is what makes the echo trustworthy. The result's " +
      "`view` is that echo: what the server says it SERVED, not what you asked for.\n" +
      "The UI's ninth tab, IEP/IEV, is NOT a view — ten spellings of it were refused. It is a " +
      "field: every row carries `iepIev` with the indicative equilibrium price and volume. Those " +
      "are only meaningful during pre-opening (08:45-09:00 WIB) and read zero outside it.\n" +
      "`limit` is honoured, but the service caps the answer at 50 rows however large it is. `page` " +
      "is ignored, and the payload's own pagination block reads all zeros on every call, so it is " +
      "not reported rather than passed through as a fake answer about whether more rows exist.\n" +
      "Every row carries `readFrom` naming the wire key each value came from, `unmappedKeys` for " +
      "anything this projection does not recognise, and the raw row.\n" +
      "`foreign` says which session the net-foreign figures are from. `foreign.isShown` is the " +
      "service's own flag for whether they mean anything yet: it reads false intraday and true " +
      "after the ~18:00 WIB broker release on the same day. Foreign figures carrying yesterday's " +
      "date before that release are correct and unpublished, not stale.\n" +
      "An empty list is normal outside trading hours, though this endpoint served 50 rows with the " +
      "market shut.",
    {
      view: z
        .enum(MARKET_MOVER_VIEWS as [string, ...string[]])
        .optional()
        .describe("Which tab. Omitted takes the server's default view — read `view` to see which."),
      limit: z.coerce
        .number()
        .optional()
        .describe("Max rows. Honoured, but capped at 50 by the service. Omitted takes its default."),
    },
    async (a) =>
      runTool(() =>
        core.getMarketMovers({
          view: a.view as MarketMoverView | undefined,
          limit: a.limit as number | undefined,
        }),
      ),
    // Settled by live calls on 2026-09-01: every member echoed, every projected key read out of a
    // real row, and the limit/page/pagination behaviour measured rather than assumed.
    { evidence: "observed" },
  );

  define.read(
    "top_stocks",
    "The order-trade service's top-stock list.\n" +
      "Same caveats as market_movers: a separate service from the hotlist tools, only `limit` is " +
      "sent, and which ranking the default view uses has not been observed — read it off the " +
      "payload. Empty is normal outside trading hours.\n" +
      PENDING,
    { limit: z.coerce.number().optional().describe("Max rows. Omitted takes the server default.") },
    async (a) => runTool(() => core.getTopStocks(a.limit as number | undefined)),
  );

  define.read(
    "order_queue",
    "The live order queue for one symbol: what is currently resting on the book.\n" +
      "This is the most perishable reading in this server and is cached for 3 seconds. A queue from " +
      "a minute ago is not a slightly stale answer, it is a wrong one.\n" +
      "sort_by takes an uppercase key such as TIME, QUEUE, LOT or PRICE. THAT LIST IS PARTIAL — the " +
      "endpoint accepts others that have not been enumerated, so an unlisted key is passed through " +
      "rather than refused. The flip side: an unrecognised key is likely to be IGNORED by the server " +
      "rather than rejected, so confirm the order you got is the order you asked for.\n" +
      "Empty means nothing is queued, which is the normal state outside trading hours.\n" +
      PENDING,
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      sort_by: z
        .string()
        .optional()
        .describe("Uppercase sort key, e.g. TIME, QUEUE, LOT, PRICE. Partial list; others are allowed."),
      limit: z.coerce.number().optional().describe("Max rows. Omitted takes the server default."),
    },
    async (a) =>
      runTool(() =>
        core.getOrderQueue({
          symbol: a.symbol as string,
          sortBy: a.sort_by as string | undefined,
          limit: a.limit as number | undefined,
        }),
      ),
  );

  define.read(
    "market_session",
    "Where the IDX trading day currently is: pre-opening, session 1, the midday break, session 2, " +
      "post-closing, or shut.\n" +
      "Call this BEFORE concluding that an empty movers list, a still order queue or a silent tape " +
      "means something is broken. Outside 09:00-16:00 WIB (Mon-Fri, excluding IDX holidays) every " +
      "live feed in this server is legitimately empty.\n" +
      "Takes no arguments and is cached for 5 seconds only, because a stale session flag makes every " +
      "judgement built on it wrong.\n" +
      PENDING,
    {},
    async () => runTool(() => core.getMarketSession()),
  );

  define.read(
    "prices_batch",
    "A price SERIES for ONE symbol. Despite the name, this route does not batch — pass exactly one " +
      "symbol.\n" +
      "The multi-symbol question is settled and the answer is that there is no encoding. Measured " +
      "2026-09-01: `stock_code=BBRI` returns 20 bare numbers under `data.prices`; comma-joining " +
      "three symbols returns an EMPTY list; and the repeated-key form answers 400 \"too many values " +
      "for field stock_code\". More than one symbol is therefore refused here rather than sent, " +
      "because an empty list reads as \"these symbols have no prices\" — a claim about the market " +
      "when the truth is a claim about the request.\n" +
      "Note this returns a SERIES of prices, not one last price. For a single last price with " +
      "orderbook depth use quote or orderbook. For several symbols, call this once per symbol.\n" +
      "`missing` still does not prove a symbol has no price: it means no returned row mentioned " +
      "that ticker. Symbols are matched against the rows' own string values rather than a named " +
      "field — that ONE detail, which key the ticker sits under, is still unsettled, while the " +
      "route's own behaviour above was measured live.",
    {
      symbols: z
        .array(z.string())
        .describe("Exactly ONE IDX ticker, e.g. [\"BBRI\"]. More than one is refused — see above."),
    },
    async (a) => runTool(() => core.getPricesBatch(a.symbols as string[])),
    // Settled live 2026-09-01: every encoding tried, and the single-symbol series read off a real
    // response. What is observed is the ROUTE's behaviour; the row projection is unchanged.
    { evidence: "observed" },
  );

  define.read(
    "price_market",
    "DOES NOT WORK. Use orderbook instead — its `market_data[]` already returns the per-board " +
      "split (All Market / Regular / Nego / Cash) for a symbol.\n" +
      "This is not a vocabulary problem and there is no argument that fixes it. Measured " +
      "2026-09-01, /company-price-feed/prices/:symbol/market answers 400 \"Silahkan Periksa " +
      "permintaan\" with NO query parameters at all. It also refuses every board spelling tried " +
      "(REGULER, RG, regular, REGULAR, TN, NG, CASH, ALL, MARKET_TYPE_REGULAR, MARKET_TYPE_ALL, " +
      "BOARD_REGULAR, 1, 0) under every key tried (market, board, market_type, type).\n" +
      "The bare call being refused is what settles it: if sending nothing is also an error, no " +
      "combination of arguments can be the answer. Earlier passes read these 400s as an unknown " +
      "board vocabulary and kept guessing spellings; the control that was missing was the empty " +
      "request.\n" +
      "Calling this tool refuses immediately and names the alternative rather than spending a round " +
      "trip to be told the request is invalid.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      date: z.string().optional().describe("Session date, YYYY-MM-DD. Omit for the current session."),
      boards: z.array(z.string()).optional().describe("Uppercase board names, e.g. [\"REGULER\"]."),
    },
    async (a) =>
      runTool(() =>
        core.getMarketPrices({
          symbol: a.symbol as string,
          date: a.date as string | undefined,
          boards: a.boards as string[] | undefined,
        }),
      ),
  );
}
