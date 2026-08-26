/**
 * The `instructions` string a client reads before it calls anything.
 *
 * It carries the facts that cannot be discovered from a tool list: that trading is off until the
 * account owner turns it on at their own terminal, that placing an order is two steps with a human
 * in the middle, and exactly which tools can change something.
 *
 * That last list used to be a sentence: *"The only tools that change anything are the four order
 * tools and the chartbit_* writes."* By the time anyone read it again there were twenty-two writes,
 * including an IPO subscription and nine watchlist and screener edits. A hand-written enumeration
 * of a growing set is a claim with an expiry date, so it is generated from the surface itself now —
 * the same list `test/tools.test.ts` asserts and `define.write` produces.
 */
import type { Surface } from "./tools/surface.js";

export function buildInstructions(surface: Surface): string {
  const writes = surface.writes;
  const total = surface.tools.length;

  const has = (name: string): boolean => surface.tools.some((t) => t.name === name);

  // Two different sentences, because "STOCKBIT_TOOLS=core is set" is false when nobody set it —
  // and a model relaying that sends the user hunting for a variable in a config file they may not
  // even own. Removing the variable is also the wrong advice under the default: it changes nothing.
  const profileNote = surface.skipped.length
    ? `\nTOOL PROFILE\n${
        surface.profileIsDefault
          ? `This server registers the \`${surface.profileLabel}\` tool profile, which is the DEFAULT — ` +
            `nobody had to set anything. ${surface.skipped.length} tools are therefore not registered, ` +
            "because 138 tool schemas cost roughly 54,400 tokens of context on every turn and most " +
            "conversations need forty of them. If a tool you expect is missing, that is why: setting " +
            "STOCKBIT_TOOLS=all in the client's config registers everything, and " +
            `STOCKBIT_TOOLS=${surface.profileLabel},<family> adds one family.`
          : `This server is running with STOCKBIT_TOOLS=${surface.profileLabel}, so ${surface.skipped.length} ` +
            "tools are not registered. If a tool you expect is missing, that is why — status says which " +
            "profile is active. Setting STOCKBIT_TOOLS=all registers everything."
      }\n`
    : "";

  // The order protocol, and the projection warning, are about tools that may not be here.
  //
  // Under the default profile none of the four order tools exist, so the two-step protocol below
  // describes a thing the model cannot do. Leaving it in is not harmless padding: it teaches the
  // model to offer order entry, and the failure lands after the user has said yes to something.
  const orderBlock = has("order_preview")
    ? `PLACING AN ORDER IS TWO STEPS, ALWAYS
1. order_preview builds a ticket: the price, the lots, the commission, the net, today's band, and
   every check. Relay its "summary" to the user VERBATIM and ask them, in words.
2. Only after they agree, call the matching write tool with that ticket id and confirm: true. The
   write tools take no price and no quantity, so what reaches the exchange is exactly what the user
   was shown. Never set confirm on their behalf. A ticket expires in two minutes.
Afterwards, read "outcome" before saying anything. Only "ok" means the order is on the book and was
seen there. Anything else means the state is uncertain: relay "message" and DO NOT RESEND — a resend
is how one intention becomes two orders.
`
    : `ORDER ENTRY IS NOT REGISTERED IN THIS SERVER
This server has no order_preview / order_buy / order_sell / order_amend / order_cancel, so there is
no way to place, amend or cancel an order from here whatever the trading mode says. Do not offer to.
The trading account can still be READ if the tools above list it. Adding
STOCKBIT_TOOLS=${surface.profileLabel},trading to the client's config and restarting it is what
changes that, and it is the user's decision to make.
`;

  const accountBlock = has("portfolio")
    ? `
THE ACCOUNT ENDPOINTS HAVE NEVER BEEN OBSERVED LIVE
Everything on the trading host projects field names read off Stockbit's web client rather than off a
real response. "readFrom" names the wire key each value came from, and a field that is absent was not
recognised — which is not the same as zero. Say that, rather than reporting a confident number.
`
    : "";

  // Built from the surface, not written down. The static list claimed order entry was available
  // ("Order entry: order_preview, then order_buy / …") — which is FALSE under the default profile,
  // where none of those four exist. A model reading it would offer to place an order and then fail
  // to find the tool, which reads as a broken server rather than as a profile.
  // Every line names ONLY tools that are registered.
  //
  // Gating a line on one tool and then listing six was the original bug wearing a different hat:
  // under the default profile the block still promised `running_trade`, `order_history`,
  // `trading_info`, `account`, the whole insider and corporate-action families and the IPO
  // pipeline. A model told those exist calls one and gets "no such tool", which reads as a broken
  // server. `named()` keeps only what is really there, so a line can never over-promise; a line
  // whose every tool was filtered disappears entirely.
  const named = (...names: string[]): string => names.filter(has).join(", ");
  const line = (label: string, listed: string, tail = ""): string | null =>
    listed ? `- ${label}: ${listed}.${tail}` : null;

  const whatIsHere = [
    line(
      "Market data",
      named("quote", "orderbook", "price_bands", "top_movers", "bars", "intraday_prices", "running_trade", "market_session"),
    ),
    line(
      "Bandarmology",
      named("broker_summary", "broker_distribution", "broker_activity", "bandar_detector"),
      " Who accumulated and who distributed — the data no other market API has, and why this server exists.",
    ),
    line("Analysis", named("technicals", "patterns", "analyze", "scan", "backtest", "strategy_compare", "timeframe_alignment", "position_size", "price_chart")),
    line("Company and fundamentals", named("company_profile", "keystats", "ratios", "financials", "seasonality", "ownership", "insider_transactions", "corporate_actions", "analyst_ratings", "peer_comparison")),
    line("Stream and research", named("stream", "news", "reports", "ipo_pipeline")),
    line("Lists and recipes", named("watchlist", "screener", "workflow_list", "workflow_run")),
    line("Chartbit — the user's real chart, in their own browser", named("chartbit_open", "chartbit_draw", "chartbit_screenshot", "chartbit_clear", "chartbit_save")),
    line("Alerts", named("alert_create", "alert_list", "alert_delete", "alert_check")),
    line("The trading account", named("portfolio", "position", "cash_balance", "orders", "order_history", "trading_info", "account", "trading_status")),
    line("Order entry", named("order_preview", "order_buy", "order_sell", "order_amend", "order_cancel")),
  ].filter((l): l is string => l !== null);

  return `Stockbit MCP — the Indonesian exchange (IDX), through the user's own Stockbit account.
Unofficial. Every request is made as them.

WHAT IS HERE
${whatIsHere.join("\n")}

IF ANYTHING LOOKS WRONG, CALL status FIRST
It reports the version, which sessions exist (never the tokens), the trading mode, the IDX session
clock in WIB, and the next command to run if something is missing. It answers with no session at
all, which is the state every new user is in.

LOGGING IN WHEN THE BROWSER IS ALREADY SIGNED IN
This is the common case and it used to look like a hang. If the user is already signed in to
Stockbit in that browser profile, the login page lands in the app rather than on a form, so there is
no login response to capture. login now reads the credential out of the browser's own session and
finishes in seconds; if there is nothing usable there it signs that profile out and re-opens the
form. Neither needs anything from you.
Two arguments, and they are not interchangeable:
- switch_account: true signs the CURRENT account out and shows a real form. This is the one for
  "log me in as my other account". Ask the user first — it signs them out of Stockbit in that
  browser.
- fresh_profile: true throws the browser profile away and starts clean, so they re-enter password
  and OTP from scratch. This is for a profile that is broken or held open, NOT for switching
  accounts.

TRADING IS OFF UNTIL THE USER TURNS IT ON
Call trading_status to see whether it is on, and what to say if it is not. The user enables it
themselves at a terminal with "stockbit-auth trading-enable"; nothing you can do turns it on. The
trading session needs their 6-digit PIN, entered at their own terminal via "stockbit-auth
trading-login". NEVER ask the user for that PIN — no tool here accepts one and this server never
stores one.

${orderBlock}${accountBlock}
NOTES
- Symbols are IDX tickers (BBRI, TLKM, …). IHSG is the composite index. Values are in rupiah.
- 1 lot = 100 shares. The tools take lots and do the arithmetic.
- Broker net values can be negative, meaning a net seller.
${profileNote}
THE TOOLS THAT CHANGE SOMETHING are exactly: ${writes.join(", ")} — ${writes.length} of ${total}.
Everything else reads, and a saved workflow recipe can reach nothing but reads.`;
}
