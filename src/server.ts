/** Stockbit MCP server factory. Read-only Indonesian-market data over the exodus API. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/register.js";

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "stockbit",
      version: "0.1.0",
    },
    {
      instructions: `Stockbit MCP — read-only Indonesian (IDX) market data. Unofficial; uses your own session.

TOOL SELECTION:
- broker_summary  → who accumulated/distributed a stock last session (bandarmology). Unique to Stockbit.
- quote           → last price + best bid/offer for a symbol
- top_movers      → top gainers/losers/most-active (empty when market closed)
- trending        → trending tickers
- intraday_prices → minutely price series (for volume/price-move signals)
- price_performance → 1D/1W/1M/… performance
- orderbook       → full depth ladder
- keystats / ratios / financials → fundamentals
- sentiment_stream → community posts about a symbol (sentiment proxy)
- sectors         → IDX sector list

NOTES:
- Symbols are IDX tickers (BBRI, TLKM, …). IHSG is the composite index.
- Prices/values are IDR. Broker net values can be negative (net seller).
- All data is read-only; this server cannot place or modify orders.`,
    },
  );

  registerTools(server);
  return server;
}
