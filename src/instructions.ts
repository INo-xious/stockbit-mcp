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
import { FAMILIES, type Family } from "./tools/_define.js";

/**
 * What to call each family in one phrase, and — for the two that need it — why it is here.
 *
 * Exhaustive over `Family`, so adding a family is a compile error rather than a line that quietly
 * never appears.
 */
const FAMILY_LABEL: Record<Family, string> = {
  system: "Is this working",
  market: "Market data",
  bandarmology: "Bandarmology",
  analysis: "Analysis",
  company: "Company",
  fundamentals: "Fundamentals",
  insider: "Insider activity",
  corpaction: "Corporate actions",
  stream: "Stream and research",
  screener: "Screener",
  account: "The user's own lists",
  chartbit: "Chartbit — the user's real chart, in their own browser",
  alerts: "Alerts, which fire while no client is open",
  pine: "TradingView Pine Script",
  workflows: "Saved recipes",
  trading: "The trading account",
  eipo: "IPOs",
};

const FAMILY_NOTE: Partial<Record<Family, string>> = {
  bandarmology:
    "Who accumulated and who distributed — the data no other market API has, and why this server exists.",
  trading: "Reads are free; the order tools are two-step and confirm-gated. See below.",
};

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
            // Counted, not written down. This module's whole argument is that a hand-written
            // count is a claim with an expiry date; a literal 138 here was exactly that mistake,
            // inside the sentence making the point.
            `because all ${surface.tools.length + surface.skipped.length} tool schemas cost far more context on every turn than a ` +
            `conversation needs, and this profile is ${surface.tools.length} of them. If a tool you expect is missing, that is why: setting ` +
            "STOCKBIT_TOOLS=all in the client's config registers everything, and " +
            `STOCKBIT_TOOLS=${surface.profileLabel},<family> adds one family.`
          : `This server is running with STOCKBIT_TOOLS=${surface.profileLabel}, so ${surface.skipped.length} ` +
            "tools are not registered. If a tool you expect is missing, that is why — status says which " +
            "profile is active. Setting STOCKBIT_TOOLS=all registers everything."
      }\n`
    : "";

  // The order protocol, and the projection warning, are about tools that may not be here.
  //
  // Under the default profile none of the order tools exist, so the two-step protocol below
  // describes a thing the model cannot do. Leaving it in is not harmless padding: it teaches the
  // model to offer order entry, and the failure lands after the user has said yes to something.
  //
  // But it is gated on the WHOLE set, not on `order_preview` alone. e-IPO subscription is order
  // entry — `eipo_order` is on the write list fifteen lines below, and it uses this exact ticket /
  // confirm / read-`outcome` protocol — so keying off the equities preview tool got both halves
  // wrong at once under `STOCKBIT_TOOLS=eipo`: it suppressed the protocol for a tool that needs it,
  // and then asserted "there is no way to place an order from here" while a tool that places one
  // was registered. A false negative about order entry is the most expensive sentence on this page.
  // Each preview describes its OWN ticket. An IPO has no auto-rejection band and its ticket carries
  // no commission and no net; saying otherwise under `eipo` invented three fields, which is the
  // "never invent a number" rule losing to a shared sentence.
  const ORDER_PREVIEWS = [
    {
      tool: "order_preview",
      fields: "the price, the lots, the commission, the net, today's band, and every check",
    },
    {
      tool: "eipo_order_preview",
      fields: "the lots, the shares, the price, the amount committed, the RDN balance, and every check",
    },
  ];
  const ORDER_ENTRY_TOOLS = [
    ...ORDER_PREVIEWS.map((p) => p.tool),
    "order_buy",
    "order_sell",
    "order_amend",
    "order_cancel",
    "eipo_order",
  ];
  const previews = ORDER_PREVIEWS.filter((p) => has(p.tool));
  const orderWrites = ["order_buy", "order_sell", "order_amend", "order_cancel", "eipo_order"].filter(has);

  // Three states, not two, and the middle one is a profile nobody would configure on purpose.
  //
  // Gating on "any order tool at all" was the fix for a false NEGATIVE — `STOCKBIT_TOOLS=eipo`
  // being told order entry was impossible while `eipo_order` was registered. But it turned that
  // into a false POSITIVE for a hand-picked profile that registers a write and no preview
  // (STOCKBIT_TOOLS takes individual tool names, so `core,order_buy` is a thing a user can type).
  // The write tools take a ticket id and nothing else, and tickets are minted only by a preview, so
  // that server can describe the protocol perfectly and still refuse every call — and the refusal
  // tells the model to run a tool that does not exist. The protocol needs a preview, so it is
  // gated on one.
  const orderBlock = previews.length
    ? `PLACING AN ORDER IS TWO STEPS, ALWAYS
${previews.map((p, i) => `${i + 1}. ${p.tool} builds a ticket: ${p.fields}.\n   Relay its "summary" to the user VERBATIM and ask them, in words.`).join("\n")}
${previews.length + 1}. Only after they agree, call the matching write tool with that ticket id and confirm: true. The
   write tools take no price and no quantity, so what reaches the exchange is exactly what the user
   was shown. Never set confirm on their behalf. A ticket expires in two minutes.
Afterwards, read "outcome" before saying anything. Only "ok" means the order is on the book and was
seen there. Anything else means the state is uncertain: relay "message" and DO NOT RESEND — a resend
is how one intention becomes two orders.
`
    : orderWrites.length
      ? `ORDER ENTRY IS REGISTERED HERE BUT CANNOT BE USED
This server registered ${orderWrites.join(" / ")} without a preview tool. Those take a
ticket id and nothing else, and tickets are minted only by order_preview / eipo_order_preview, which
this server did not register — so every call will be refused, and the refusal will name a tool that
is not here. Do not offer to place, amend or cancel an order. Setting STOCKBIT_TOOLS to include the
whole trading or eipo family, rather than individual tool names, is what fixes it.
`
      : `ORDER ENTRY IS NOT REGISTERED IN THIS SERVER
This server has none of ${ORDER_ENTRY_TOOLS.join(" / ")}, so there is
no way to place, amend or cancel an order — or to subscribe to an e-IPO — from here, whatever the
trading mode says. Do not offer to.
The trading account can still be READ if the tools above list it. Adding
STOCKBIT_TOOLS=${surface.profileLabel},trading for equities, or ,eipo for e-IPO subscription, to the
client's config and restarting it is what changes that — the claim above covers both, so the remedy
has to name both. It is the user's decision to make.
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
  // Every line names ONLY tools that are registered, and names ALL of them.
  //
  // This block has now been wrong in both directions, which is why it is generated rather than
  // written. It began as a static list that promised order entry a `core` server does not have. It
  // was then rewritten as per-line `named(...)` calls — which fixed the over-promising and
  // introduced two quieter faults: three of the names in it (`bars`, `ownership`, `reports`) were
  // not tools at all and were silently dropped by the filter, and eighty of the hundred and
  // thirty-eight registered tools appeared in no line at all. A hand-written enumeration of a
  // growing set is a claim with an expiry date; that is this module's own argument about the write
  // list, and it applies here too.
  //
  // So the names come from the surface, grouped by family. A new tool appears here the day it is
  // registered, a renamed one cannot go stale, and a typo is impossible because nothing is typed.
  const byFamilyName = new Map<Family, string[]>();
  for (const tool of surface.tools) {
    const list = byFamilyName.get(tool.family);
    if (list) list.push(tool.name);
    else byFamilyName.set(tool.family, [tool.name]);
  }

  const whatIsHere = FAMILIES.filter((family) => byFamilyName.has(family)).map((family) => {
    const names = byFamilyName.get(family)!;
    const gloss = FAMILY_NOTE[family];
    return `- ${FAMILY_LABEL[family]}: ${names.join(", ")}.${gloss ? ` ${gloss}` : ""}`;
  });

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
${has("trading_status") ? "Call trading_status to see whether it is on, and what to say if it is not." : "status reports the trading mode — this server did not register trading_status."}
The user enables it themselves at a terminal with "stockbit-auth trading-enable"; nothing you can
do turns it on. The
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
