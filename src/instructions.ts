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

  const profileNote = surface.skipped.length
    ? `\nTOOL PROFILE\nThis server is running with STOCKBIT_TOOLS=${surface.profileLabel}, so ${surface.skipped.length} ` +
      `tools are not registered. If a tool you expect is missing, that is why — status says which profile is ` +
      `active. Setting STOCKBIT_TOOLS=all (or removing it) registers everything.\n`
    : "";

  return `Stockbit MCP — the Indonesian exchange (IDX), through the user's own Stockbit account.
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
${profileNote}
THE TOOLS THAT CHANGE SOMETHING are exactly: ${writes.join(", ")} — ${writes.length} of ${total}.
Everything else reads, and a saved workflow recipe can reach nothing but reads.`;
}
