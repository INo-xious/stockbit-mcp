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
import { runTool } from "./_format.js";
import type { Definer } from "./_define.js";

/** Appended where the row shape has not been observed live, so a caller does not over-trust it. */
const PENDING =
  "PENDING VERIFICATION: this response shape has not been observed live. The payload is returned " +
  "as Stockbit sent it, unprojected, rather than reduced to guessed field names — read the keys off " +
  "the result instead of assuming them.";

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
      "Check `unmapped` and `warnings` on the result before using the numbers. Field names are " +
      "projected defensively from a shape that has not been observed live: if open/high/low are " +
      "unmapped every candle is flat and candlestick patterns are meaningless, and if volume is " +
      "unmapped it is 0 on every bar and that 0 is not real. `mapped`, `extraKeys` and `sample` show " +
      "which wire keys were used and what else the point carried.\n" +
      "raw=true returns the sibling chart endpoint's payload untouched instead of bars. Use it only " +
      "to discover real field spellings when `unmapped` or `extraKeys` is non-empty; it is not a " +
      "fallback and returns no `bars`.",
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
  );

  define.read(
    "running_trade",
    "The running-trade tape: individual prints as they cross the exchange.\n" +
      "Omit `symbol` for the market-wide tape, pass it to follow one ticker. `action` filters to one " +
      "side (BUY = buyer-initiated, SELL = seller-initiated); omitted means the endpoint's own " +
      "default, which is not necessarily ALL.\n" +
      "grouped=true reads a different endpoint that returns the tape aggregated rather than print by " +
      "print. It is not a display option: the two return different payloads.\n" +
      "An empty result is NORMAL outside 09:00-16:00 WIB — the tape is a live feed and nothing " +
      "crosses when the market is shut. Call market_session before treating emptiness as a fault.\n" +
      PENDING,
    {
      symbol: z.string().optional().describe("IDX ticker. Omit for the market-wide tape."),
      action: z.enum(core.RUNNING_TRADE_ACTIONS).optional().describe("ALL, BUY or SELL. Omitted sends no filter."),
      limit: z.coerce.number().optional().describe("Max rows. Omitted sends no limit and takes the server default."),
      grouped: z.boolean().optional().describe("Read the aggregated view instead of the print-by-print tape."),
    },
    async (a) =>
      runTool(() =>
        core.getRunningTrade({
          symbol: a.symbol as string | undefined,
          action: a.action as (typeof core.RUNNING_TRADE_ACTIONS)[number] | undefined,
          limit: a.limit as number | undefined,
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
      "An empty result is normal before the session's first print. It is a per-session view: there " +
      "is no date argument, so this is today.\n" +
      PENDING,
    {
      symbol: z.string().optional().describe("IDX ticker. Omit for whatever the endpoint returns market-wide."),
      mode: z.enum(core.TRADE_BOOK_MODES).optional().describe("OVERALL or BIG_MONEY. Omitted sends no mode."),
      data_modes: z
        .array(z.enum(core.TRADE_BOOK_DATA_MODES))
        .optional()
        .describe("Auction phases to exclude: EXCLUDE_PRE and/or EXCLUDE_POST."),
      limit: z.coerce.number().optional().describe("Max rows. Omitted takes the server default."),
      chart: z.boolean().optional().describe("Read the chart endpoint instead of the table."),
    },
    async (a) =>
      runTool(() =>
        core.getTradeBook({
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
    "The intraday running-trade chart for one symbol, returned exactly as Stockbit sends it.\n" +
      "Read the tool name as intent, not as a description of the payload: whether this endpoint " +
      "breaks the session down by broker, by price level or by side has NOT been observed. Inspect " +
      "the keys before reporting anything as broker flow. For confirmed per-broker numbers use the " +
      "broker summary and broker distribution tools instead.\n" +
      "Covers the current session only, and is empty before the first print of the day.\n" +
      PENDING,
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) => runTool(() => core.getRunningTradeChart(a.symbol as string)),
  );

  define.read(
    "market_movers",
    "Market movers from the order-trade service.\n" +
      "This is a DIFFERENT endpoint from top_movers, which reads the hotlist. They are two services " +
      "and are not guaranteed to agree; a disagreement is not evidence that either is wrong.\n" +
      "Only `limit` is sent. This endpoint's category vocabulary (gainers vs losers vs most active) " +
      "has not been observed, so no category filter is sent and you get whatever its default view " +
      "is — check the payload to see which one that is rather than assuming gainers.\n" +
      "An empty list is normal outside trading hours.\n" +
      PENDING,
    { limit: z.coerce.number().optional().describe("Max rows. Omitted takes the server default.") },
    async (a) => runTool(() => core.getMarketMovers(a.limit as number | undefined)),
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
    "Last price for several symbols in one request.\n" +
      "Returns `requested`, `found`, `missing` and `rows`. READ `missing` BEFORE USING THE ROWS. The " +
      "multi-symbol encoding this endpoint wants has not been confirmed, and if it is the wrong one " +
      "the server answers HTTP 200 with a single row instead of an error — `missing` listing almost " +
      "everything you asked for is that failure, not a set of unlisted tickers.\n" +
      "`missing` also does not prove a symbol has no price: it means no returned row mentioned that " +
      "ticker. Symbols are matched against the rows' own string values rather than a named field, " +
      "because the key the ticker lives under has not been observed.\n" +
      "At most 50 symbols per call; split a longer list. For one symbol with orderbook depth use the " +
      "orderbook or quote tools instead.\n" +
      PENDING,
    {
      symbols: z.array(z.string()).describe("IDX tickers, e.g. [\"BBRI\", \"TLKM\"]. Max 50, de-duplicated."),
    },
    async (a) => runTool(() => core.getPricesBatch(a.symbols as string[])),
  );

  define.read(
    "price_market",
    "One symbol's prices broken down by market board for a session.\n" +
      "boards takes uppercase names such as REGULER, NEGO or TUNAI and they are sent UNPREFIXED and " +
      "unaltered. This API uses two mutually incompatible prefixed board vocabularies elsewhere " +
      "(MARKET_BOARD_ on broker summary, MARKET_TYPE_ on broker distribution) and which, if either, " +
      "applies here is unknown — so nothing is added to your value. If the result looks unfiltered, " +
      "the spelling is the first thing to suspect.\n" +
      "Omitting `date` reads the current session. A past date is served from a 5-minute cache since " +
      "a closed session cannot change; today is cached for 3 seconds.\n" +
      "An empty result for a past date most likely means that date was not a trading day.\n" +
      PENDING,
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
