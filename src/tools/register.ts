/**
 * MCP tool registration. Each tool is a thin wrapper over `core/`, mapped to a confirmed endpoint
 * (see STOCKBIT-API.md §4). Read-only by construction — no order/write tools exist here.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as core from "../core/index.js";
import { runImageTool, runTool } from "./_format.js";
import { renderSankey } from "../render/sankey.js";
import { renderCandles, type Annotation, type SubPanel } from "../render/candles.js";
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
    "Broker-to-broker flow for an IDX stock, ALWAYS rendered as an SVG diagram laid out " +
      "BUYER -> SELLER exactly like Stockbit's own Broker Distribution: top buyers on the left, " +
      "the sellers they bought from on the right. Each seller's bar is that seller's TOTAL, so a " +
      "partly-filled bar means the buyers shown account for only part of what it sold. For each top " +
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
      data_type: z.enum(["VALUE", "VOLUME"]).optional().describe("Default VALUE (IDR). VOLUME returns lots (1 lot = 100 shares)."),
      investor_type: z.enum(["ALL", "FOREIGN", "DOMESTIC"]).optional().describe("Default ALL"),
      market_board: z
        .enum(core.DISTRIBUTION_BOARDS)
        .optional()
        .describe("Default REGULER, matching Stockbit's UI. ALL folds in negotiated blocks and changes the numbers a lot."),
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
          marketBoard: a.market_board,
          period: a.period,
          from: a.from,
          to: a.to,
          date_from: a.date_from,
          date_to: a.date_to,
          start_date: a.start_date,
          end_date: a.end_date,
        });
        // Always buyers -> sellers, matching Stockbit. Each seller's bar is its TRUE total, so
        // the picture states the seller's whole position rather than only the slice the drawn
        // buyers account for.
        const brokers = d.topBuyers;
        const sellerTotals = new Map(d.topSellers.map((s) => [s.code, s.amount]));
        const svg = renderSankey(brokers, {
          symbol: d.symbol,
          unit: d.amountUnit,
          from: d.from,
          to: d.to,
          targetTotals: sellerTotals,
          topSources: a.top_sources,
          topTargets: a.top_targets,
          theme: a.theme,
          board: `${d.marketBoard.toLowerCase()} board`,
        });

        // Always written, not only on request: the file is the durable artifact, and MCP clients
        // differ in whether they render an inline SVG. A caller whose client shows nothing still
        // has a path to open.
        const savedTo = writeSvg(
          a.save_path ??
            defaultChartPath({ symbol: d.symbol, side: "buy-to-sell", from: d.from, to: d.to, dataType: d.dataType }),
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
              direction: "buyers bought from sellers",
              from: d.from,
              to: d.to,
              amountUnit: d.amountUnit,
              dataType: d.dataType,
              marketBoard: d.marketBoard,
              brokersCharted: Math.min(brokers.length, a.top_sources ?? 8),
              savedTo,
            },
          },
        };
      }),
  );

  /* ------------------------------ charts & technicals ------------------------------ */

  server.tool(
    "technicals",
    "Technical indicator readings for an IDX stock, computed from daily bars: SMA/EMA, RSI, MACD, " +
      "Bollinger Bands, ATR, and support/resistance levels found by pivot clustering.\n" +
      "Returns NUMBERS for reasoning — use `price_chart` when you want the picture. Every reading " +
      "reported is the latest defined value of its series.\n" +
      "Deep history is paged 12 sessions at a time upstream, so a large `bars` is slow; " +
      "`pagesFetched` reports what the query cost.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce.number().optional().describe("Sessions to analyse (default 200). Ignored if `from` is given."),
      from: z.string().optional().describe("Earliest session, YYYY-MM-DD"),
      to: z.string().optional().describe("Latest session, YYYY-MM-DD"),
    },
    async (a) =>
      runTool(async () => {
        const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 200, from: a.from, to: a.to });
        const bars = series.bars;
        const close = bars.map((b) => b.close);
        const m = core.macd(close);
        const bb = core.bollinger(close, 20, 2);
        const last = bars[bars.length - 1];
        return {
          symbol: series.symbol,
          from: series.from,
          to: series.to,
          sessions: bars.length,
          truncated: series.truncated,
          pagesFetched: series.pagesFetched,
          last: last && {
            date: last.date,
            open: last.open,
            high: last.high,
            low: last.low,
            close: last.close,
            volumeLots: last.volume,
            valueIdr: last.value,
            netForeignIdr: last.netForeign,
          },
          indicators: {
            sma20: core.latest(core.sma(close, 20)),
            sma50: core.latest(core.sma(close, 50)),
            sma200: core.latest(core.sma(close, 200)),
            ema20: core.latest(core.ema(close, 20)),
            rsi14: core.latest(core.rsi(close, 14)),
            macd: core.latest(m.macd),
            macdSignal: core.latest(m.signal),
            macdHistogram: core.latest(m.histogram),
            bollingerUpper: core.latest(bb.upper),
            bollingerMiddle: core.latest(bb.middle),
            bollingerLower: core.latest(bb.lower),
            atr14: core.latest(core.atr(bars, 14)),
          },
          levels: core.levels(bars, 5, 1.5).slice(0, 8),
        };
      }),
  );

  server.tool(
    "price_chart",
    "Candlestick chart for an IDX stock, ALWAYS rendered as an SVG: daily candles with volume, " +
      "optional overlays (SMA/EMA/Bollinger) and sub-panels (RSI, MACD), plus support/resistance " +
      "levels drawn on.\n" +
      "Returns the image AND writes a .svg, reporting the path in `savedTo`. Use `technicals` for " +
      "the numbers; this is the picture.\n" +
      "`annotations` draws your own levels, zones, trend lines and markers, which is how you show " +
      "the evidence behind an analysis. Drawing happens on this render only — nothing is written to " +
      "the Stockbit account.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce.number().optional().describe("Sessions to plot (default 120)"),
      from: z.string().optional().describe("Earliest session, YYYY-MM-DD"),
      to: z.string().optional().describe("Latest session, YYYY-MM-DD"),
      overlays: z
        .array(z.enum(["sma20", "sma50", "sma200", "ema20", "bollinger"]))
        .optional()
        .describe("Price overlays. Default sma20 + sma50."),
      panels: z.array(z.enum(["rsi", "macd"])).optional().describe("Sub-panels below price. Default rsi."),
      show_levels: z.boolean().optional().describe("Draw support/resistance from pivot clustering. Default true."),
      show_volume: z.boolean().optional().describe("Default true"),
      annotations: z
        .array(
          z.object({
            kind: z.enum(["level", "zone", "trend", "marker"]),
            price: z.coerce.number().optional(),
            from: z.coerce.number().optional().describe("zone: one edge"),
            to: z.coerce.number().optional().describe("zone: other edge"),
            from_date: z.string().optional().describe("trend: start session"),
            from_price: z.coerce.number().optional(),
            to_date: z.string().optional().describe("trend: end session"),
            to_price: z.coerce.number().optional(),
            date: z.string().optional().describe("marker: session"),
            label: z.string().optional(),
            color: z.string().optional(),
          }),
        )
        .optional()
        .describe("Your own drawings on top of the chart"),
      theme: z.enum(["dark", "light"]).optional().describe("Default dark"),
      save_path: z.string().optional().describe("Where to write the .svg. Defaults to ~/.stockbit/charts/."),
    },
    async (a) =>
      runImageTool(async () => {
        const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 120, from: a.from, to: a.to });
        const bars = series.bars;
        const close = bars.map((b) => b.close);

        const wanted = a.overlays ?? ["sma20", "sma50"];
        const overlays: Array<{ label: string; series: core.Series; dashed?: boolean; color?: string }> = [];
        if (wanted.includes("sma20")) overlays.push({ label: "SMA 20", series: core.sma(close, 20) });
        if (wanted.includes("sma50")) overlays.push({ label: "SMA 50", series: core.sma(close, 50) });
        if (wanted.includes("sma200")) overlays.push({ label: "SMA 200", series: core.sma(close, 200) });
        if (wanted.includes("ema20")) overlays.push({ label: "EMA 20", series: core.ema(close, 20) });
        if (wanted.includes("bollinger")) {
          const bb = core.bollinger(close, 20, 2);
          overlays.push(
            { label: "BB upper", series: bb.upper, dashed: true, color: "#8b949e" },
            { label: "BB lower", series: bb.lower, dashed: true, color: "#8b949e" },
          );
        }

        const panels: SubPanel[] = [];
        for (const p of a.panels ?? ["rsi"]) {
          if (p === "rsi") {
            panels.push({
              label: "RSI(14)",
              range: [0, 100],
              guides: [30, 70],
              series: [{ label: "RSI", series: core.rsi(close, 14) }],
            });
          } else {
            const m = core.macd(close);
            panels.push({
              label: "MACD(12,26,9)",
              histogram: m.histogram,
              series: [
                { label: "MACD", series: m.macd },
                { label: "signal", series: m.signal, color: "#e3b341" },
              ],
            });
          }
        }

        const annotations: Annotation[] = [];
        if (a.show_levels !== false) {
          for (const l of core.levels(bars, 5, 1.5).filter((x) => x.touches >= 2).slice(0, 5)) {
            annotations.push({ kind: "level", price: l.price, label: `${l.kind} ${l.price} (x${l.touches})` });
          }
        }
        for (const raw of a.annotations ?? []) {
          if (raw.kind === "level" && raw.price !== undefined) {
            annotations.push({ kind: "level", price: raw.price, label: raw.label, color: raw.color });
          } else if (raw.kind === "zone" && raw.from !== undefined && raw.to !== undefined) {
            annotations.push({ kind: "zone", from: raw.from, to: raw.to, label: raw.label, color: raw.color });
          } else if (
            raw.kind === "trend" &&
            raw.from_date &&
            raw.to_date &&
            raw.from_price !== undefined &&
            raw.to_price !== undefined
          ) {
            annotations.push({
              kind: "trend",
              fromDate: raw.from_date,
              fromPrice: raw.from_price,
              toDate: raw.to_date,
              toPrice: raw.to_price,
              label: raw.label,
              color: raw.color,
            });
          } else if (raw.kind === "marker" && raw.date && raw.label) {
            annotations.push({ kind: "marker", date: raw.date, price: raw.price, label: raw.label, color: raw.color });
          }
        }

        const svg = renderCandles({
          symbol: series.symbol,
          bars,
          subtitle: `${series.from} → ${series.to}  ·  ${bars.length} sessions  ·  daily`,
          overlays,
          subPanels: panels,
          annotations,
          showVolume: a.show_volume !== false,
          theme: a.theme,
        });

        const savedTo = writeSvg(
          a.save_path ??
            defaultChartPath({
              symbol: series.symbol,
              side: "price",
              from: series.from,
              to: series.to,
              dataType: "DAILY",
            }),
          svg,
        );

        return {
          base64: Buffer.from(svg, "utf8").toString("base64"),
          mimeType: "image/svg+xml",
          summary: {
            success: true,
            data: {
              symbol: series.symbol,
              from: series.from,
              to: series.to,
              sessions: bars.length,
              lastClose: bars[bars.length - 1]?.close,
              overlays: overlays.map((o) => o.label),
              panels: panels.map((p) => p.label),
              levelsDrawn: annotations.filter((x) => x.kind === "level").length,
              truncated: series.truncated,
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
