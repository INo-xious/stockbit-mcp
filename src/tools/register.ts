/**
 * MCP tool registration. Each tool is a thin wrapper over `core/`, mapped to a confirmed endpoint
 * (see STOCKBIT-API.md §4). Read-only by construction — no order/write tools exist here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as core from "../core/index.js";
import { runImageTool, runTool } from "./_format.js";
import { renderSankey } from "../render/sankey.js";
import { defaultChartPath, writeSvg } from "../render/write.js";

export function registerTools(server: McpServer): void {
  /* ------------------------------ broker / bandar ------------------------------ */

  server.tool(
    "broker_summary",
    "Broker summary for an IDX stock: which brokers net-bought/sold, in lots and IDR value, with " +
      "foreign/local/govt classification. This is the core bandarmology signal — TradingView has " +
      "no equivalent.\n" +
      "DATES: omit from/to for the latest completed session. Supply BOTH from and to (YYYY-MM-DD) " +
      "for a historical window — the server aggregates net flow across it in one request, so a " +
      "multi-month range is as cheap as one day. For a single past day pass the same date twice. " +
      "Both ends are required; a half-specified range is rejected because the API would silently " +
      "return the latest session instead.\n" +
      "An empty result for a weekend or public holiday is expected, not an error.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      from: z.string().optional().describe("Range start, YYYY-MM-DD. Requires `to`."),
      to: z.string().optional().describe("Range end, YYYY-MM-DD (inclusive). Requires `from`."),
      // Accepted because a caller may reasonably reach for these spellings. The API ignores both —
      // it answers 200 with the latest session — so they are normalized onto from/to and never sent.
      date_from: z.string().optional().describe("Alias for `from`."),
      date_to: z.string().optional().describe("Alias for `to`."),
      start_date: z.string().optional().describe("Alias for `from`."),
      end_date: z.string().optional().describe("Alias for `to`."),
      limit: z.coerce.number().optional().describe("Max brokers per side (default 50; API default 25 truncates)"),
      transaction_type: z.enum(["NET", "BUY", "SELL"]).optional().describe("Default NET"),
      market_board: z.enum(["REGULER", "NEGOTIATED", "CASH"]).optional().describe("Default REGULER (use for bandarmology)"),
      investor_type: z.enum(["ALL", "FOREIGN", "DOMESTIC"]).optional().describe("Default ALL"),
    },
    async (a) =>
      runTool(() =>
        core.getBrokerSummary({
          symbol: a.symbol,
          limit: a.limit,
          transactionType: a.transaction_type,
          marketBoard: a.market_board,
          investorType: a.investor_type,
          from: a.from,
          to: a.to,
          date_from: a.date_from,
          date_to: a.date_to,
          start_date: a.start_date,
          end_date: a.end_date,
        }),
      ),
  );

  server.tool(
    "broker_distribution",
    "Broker-to-broker flow for an IDX stock, ALWAYS rendered as an SVG diagram: for each top " +
      "broker, WHICH brokers were on the other side of their trades and how much moved between " +
      "them. broker_summary says how much a broker accumulated; this shows who they accumulated " +
      "it from.\n" +
      "Returns the diagram as an image AND writes a .svg file, reporting the path in `savedTo` " +
      "(pass `save_path` to choose where). It deliberately does NOT return a table of numbers — " +
      "the picture is the output. Use broker_summary for per-broker figures.\n" +
      "DATES: pass a `period` preset, or BOTH `from` and `to` (YYYY-MM-DD). from/to override period.\n" +
      "data_type=VALUE is IDR, VOLUME is LOTS (1 lot = 100 shares); the summary states which.\n" +
      "REQUIRES a Stockbit account with at least Rp 10,000,000 total balance — Stockbit gates this " +
      "feature. If the account does not qualify the tool returns an error saying so.\n" +
      "An empty diagram on a weekend or public holiday is expected, not an error.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      side: z.enum(["buyers", "sellers"]).optional().describe("Which side to chart. Default buyers."),
      data_type: z.enum(["VALUE", "VOLUME"]).optional().describe("Default VALUE (IDR). VOLUME returns lots (1 lot = 100 shares)."),
      investor_type: z.enum(["ALL", "FOREIGN", "DOMESTIC"]).optional().describe("Default ALL"),
      period: z
        .enum(core.DISTRIBUTION_PERIODS)
        .optional()
        .describe("Preset window; default LAST_1_DAY. Ignored when from/to are given."),
      from: z.string().optional().describe("Window start, YYYY-MM-DD. Requires `to`."),
      to: z.string().optional().describe("Window end, YYYY-MM-DD (inclusive). Requires `from`."),
      date_from: z.string().optional().describe("Alias for `from`."),
      date_to: z.string().optional().describe("Alias for `to`."),
      start_date: z.string().optional().describe("Alias for `from`."),
      end_date: z.string().optional().describe("Alias for `to`."),
      theme: z.enum(["dark", "light"]).optional().describe("Palette. Default dark."),
      top_sources: z.coerce.number().optional().describe("Source brokers to draw (default 8)"),
      top_targets: z.coerce.number().optional().describe("Counterparties to draw; the rest merge into an 'others' band (default 12)"),
      save_path: z.string().optional().describe("Where to write the .svg. Defaults to ~/.stockbit/charts/."),
    },
    async (a) =>
      runImageTool(async () => {
        const d = await core.getBrokerDistribution({
          symbol: a.symbol,
          dataType: a.data_type,
          investorType: a.investor_type,
          period: a.period,
          from: a.from,
          to: a.to,
          date_from: a.date_from,
          date_to: a.date_to,
          start_date: a.start_date,
          end_date: a.end_date,
        });
        const side = a.side ?? "buyers";
        const brokers = side === "buyers" ? d.topBuyers : d.topSellers;
        const svg = renderSankey(brokers, {
          symbol: d.symbol,
          unit: d.amountUnit,
          from: d.from,
          to: d.to,
          side,
          topSources: a.top_sources,
          topTargets: a.top_targets,
          theme: a.theme,
        });

        // Always written, not only on request: the file is the durable artifact, and MCP clients
        // differ in whether they render an inline SVG. A caller whose client shows nothing still
        // has a path to open.
        const savedTo = writeSvg(
          a.save_path ??
            defaultChartPath({ symbol: d.symbol, side, from: d.from, to: d.to, dataType: d.dataType }),
          svg,
        );

        return {
          base64: Buffer.from(svg, "utf8").toString("base64"),
          mimeType: "image/svg+xml",
          // Metadata only — no per-broker table. The diagram is the answer; broker_summary is
          // where the figures live.
          summary: {
            success: true,
            data: {
              symbol: d.symbol,
              side,
              from: d.from,
              to: d.to,
              amountUnit: d.amountUnit,
              dataType: d.dataType,
              brokersCharted: Math.min(brokers.length, a.top_sources ?? 8),
              savedTo,
            },
          },
        };
      }),
  );

  /* ---------------------------------- quotes ---------------------------------- */

  server.tool(
    "quote",
    "Real-time quote for an IDX symbol: last price, change, and best bid/offer. Also resolves the " +
      "symbol's internal company id.",
    { symbol: z.string().describe("IDX ticker, e.g. BBRI, or index e.g. IHSG") },
    async (a) => runTool(() => core.getQuote(a.symbol)),
  );

  server.tool(
    "top_movers",
    "Top gainers, losers, or most-active IDX stocks (hotlist). Returns an empty list when the " +
      "market is closed — that is expected, not an error.",
    {
      type: z.enum(["topGainer", "topLoser", "mostActive"]).describe("Which hotlist"),
      limit: z.coerce.number().optional().describe("Default 25"),
    },
    async (a) => runTool(() => core.getTopMovers(a.type, a.limit ?? 25)),
  );

  server.tool(
    "trending",
    "Trending IDX stocks right now (community-driven).",
    {},
    async () => runTool(() => core.getTrending()),
  );

  server.tool(
    "sectors",
    "List IDX sectors (id, name).",
    {},
    async () => runTool(() => core.getSectors()),
  );

  /* --------------------------------- price feed --------------------------------- */

  server.tool(
    "intraday_prices",
    "Intraday minutely close-price series for a symbol (the basis for volume/price-move signals).",
    {
      symbol: z.string().describe("IDX ticker"),
      interval: z.coerce.number().optional().describe("Minutes per point (default 1)"),
    },
    async (a) => runTool(() => core.getIntradayPrices(a.symbol, a.interval ?? 1)),
  );

  server.tool(
    "price_performance",
    "Multi-timeframe price performance (1D/1W/1M/…): close, high, low, and % change per timeframe.",
    { symbol: z.string().describe("IDX ticker") },
    async (a) => runTool(() => core.getPricePerformance(a.symbol)),
  );

  server.tool(
    "orderbook",
    "Full order-book depth ladder for a symbol.",
    { symbol: z.string().describe("IDX ticker") },
    async (a) => runTool(() => core.getOrderbook(a.symbol)),
  );

  /* -------------------------------- fundamentals -------------------------------- */

  server.tool(
    "keystats",
    "Key statistics for a company (valuation, size, performance metrics).",
    { symbol: z.string().describe("IDX ticker") },
    async (a) => runTool(() => core.getKeystats(a.symbol)),
  );

  server.tool(
    "ratios",
    "Financial ratios for a company.",
    { symbol: z.string().describe("IDX ticker") },
    async (a) => runTool(() => core.getRatios(a.symbol)),
  );

  server.tool(
    "financials",
    "Financial statements (structured tables; the large HTML report is stripped). data_type/" +
      "report_type/statement_type are integer selectors matching Stockbit's UI toggles.",
    {
      symbol: z.string().describe("IDX ticker"),
      data_type: z.coerce.number().optional(),
      report_type: z.coerce.number().optional(),
      statement_type: z.coerce.number().optional(),
    },
    async (a) =>
      runTool(() =>
        core.getFinancials({
          symbol: a.symbol,
          dataType: a.data_type,
          reportType: a.report_type,
          statementType: a.statement_type,
        }),
      ),
  );

  /* ---------------------------------- sentiment ---------------------------------- */

  server.tool(
    "sentiment_stream",
    "Recent community posts mentioning a symbol (sentiment/news proxy — not price data).",
    {
      symbol: z.string().describe("IDX ticker"),
      limit: z.coerce.number().optional().describe("Default 30"),
    },
    async (a) => runTool(() => core.getSentimentStream(a.symbol, a.limit ?? 30)),
  );
}
