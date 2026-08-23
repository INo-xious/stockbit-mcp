/**
 * Stockbit MCP server factory.
 *
 * The `instructions` string below is the only documentation a client reads before it starts calling
 * tools, so it carries the two facts that cannot be discovered from a tool list: that trading is off
 * until the account owner turns it on at their own terminal, and that placing an order is two steps
 * with a human in the middle. Everything else a model can find in the tool descriptions.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/register.js";

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "stockbit",
      version: "0.1.0",
    },
    {
      instructions: `Stockbit MCP — the Indonesian exchange (IDX), through the user's own Stockbit account.
Unofficial. Every request is made as them.

WHAT IS HERE
- Market data: quotes, orderbook depth, intraday and daily bars, movers, running trade, seasonality.
- Bandarmology: broker_summary, broker_distribution, broker_activity, bandar_detector — who accumulated
  and who distributed. This is the data no other market API has, and it is why this server exists.
- Company: profile, fundamentals, ratios, financial statements, ownership, insider activity, corporate
  actions, analyst ratings, peer comparison.
- Stream and research: posts, news, reports, the IPO pipeline.
- Screener, watchlists, and saved workflows (workflow_list / workflow_run).
- Chartbit: read the user's real chart and draw on it in their own browser (chartbit_*).
- The trading account: portfolio, position, cash_balance, orders, order_history, trading_info, account.
- Order entry: order_preview, then order_buy / order_sell / order_amend / order_cancel.

TRADING IS OFF UNTIL THE USER TURNS IT ON
Call trading_status to see whether it is on, and what to say if it is not. The user enables it
themselves at a terminal with "stockbit-auth trading-enable"; nothing you can do turns it on. The
trading session needs their 6-digit PIN, entered at their own terminal via "stockbit-auth
trading-login". NEVER ask the user for that PIN — no tool here accepts one and this server never
stores one.

PLACING AN ORDER IS TWO STEPS, ALWAYS
1. order_preview builds a ticket: the price, the lots, the commission, the net, today's band, and
   every check. Relay its "summary" to the user VERBATIM and ask them, in words.
2. Only after they agree, call the matching write tool with that ticket id and confirm: true. The
   write tools take no price and no quantity, so what reaches the exchange is exactly what the user
   was shown. Never set confirm on their behalf. A ticket expires in two minutes.
Afterwards, read "outcome" before saying anything. Only "ok" means the order is on the book and was
seen there. Anything else means the state is uncertain: relay "message" and DO NOT RESEND — a resend
is how one intention becomes two orders.

THE ACCOUNT ENDPOINTS HAVE NEVER BEEN OBSERVED LIVE
Everything on the trading host projects field names read off Stockbit's web client rather than off a
real response. "readFrom" names the wire key each value came from, and a field that is absent was not
recognised — which is not the same as zero. Say that, rather than reporting a confident number.

NOTES
- Symbols are IDX tickers (BBRI, TLKM, …). IHSG is the composite index. Values are in rupiah.
- 1 lot = 100 shares. The tools take lots and do the arithmetic.
- Broker net values can be negative, meaning a net seller.
- The only tools that change anything are the four order tools and the chartbit_* writes. Everything
  else reads, and a saved workflow recipe can reach nothing but reads.`,
    },
  );

  registerTools(server);
  return server;
}
