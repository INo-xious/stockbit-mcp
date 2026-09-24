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
import { byFamily, type Surface } from "./tools/surface.js";
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
  trading: "Read-only brokerage account and local paper simulation",
  eipo: "Read-only IPO information",
  virtual: "Stockbit website virtual trading",
};

const FAMILY_NOTE: Partial<Record<Family, string>> = {
  bandarmology:
    "Who accumulated and who distributed — the data no other market API has, and why this server exists.",
  trading: "Real-account reads and explicitly named local paper tools only.",
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

  const paperPreview = has("paper_order_preview");
  const paperWrites = ["paper_order_buy", "paper_order_sell", "paper_order_amend", "paper_order_cancel"].filter(has);
  const orderBlock = `REAL-MONEY EXECUTION IS NOT AVAILABLE
This build has no live buy, sell, amend, cancel, IPO subscription, deposit or withdrawal route.
No setting, environment variable or tool profile can enable real-money execution. Brokerage
portfolio, cash and order-history tools are read-only and always refer to the real account.
Local paper_* tools and Stockbit virtual_* tools are separate simulations. Never describe either
as a real holding, an exchange fill or investment advice.
${paperPreview ? `LOCAL PAPER ORDERS USE TWO STEPS
paper_order_preview builds a local simulation ticket. Relay its summary and obtain agreement before
calling the matching paper_order_* tool. Inspect outcome before reporting success. Paper fills use
local simulation rules, not Stockbit's website virtual portfolio.
` : paperWrites.length ? `PAPER WRITES CANNOT BE USED WITHOUT paper_order_preview
Add the trading family to STOCKBIT_TOOLS to include their required preview tool.
` : ""}
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
  const grouped = byFamily(surface.tools);

  const whatIsHere = FAMILIES.filter((family) => grouped.has(family)).map((family) => {
    const names = grouped.get(family)!.map((tool) => tool.name);
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

PORTFOLIO ACCESS AND SIMULATION
${has("trading_status") ? "Call trading_status to inspect local paper settings." : "status reports local paper settings."}
The securities session is only for reading the brokerage account. It requires the user's six-digit
PIN entered at their own terminal via "stockbit-auth trading-login". NEVER ask for that PIN in chat.
Local paper mode is enabled at a terminal with "stockbit-auth trading-enable --paper".
Stockbit website virtual tools use the ordinary Stockbit login and a distinct virtual-only route set.

READING A RESULT — the conventions, once, for every tool
These used to be restated inside forty-odd tool descriptions. They are the same everywhere, so they
are here instead, and a tool only mentions what is specific to it.
- PROVENANCE. Stockbit's API is private and undocumented, so this server distinguishes what it has
  SEEN from what it has guessed. Each tool carries the word in _meta["stockbit-mcp/evidence"]:
  observed (a real response was read and the code written against it), read-back (a write confirmed
  by re-reading the account), projected (field names taken from Stockbit's web bundle and never seen
  live). A description saying "PENDING VERIFICATION" is a projected tool saying so in words.
- ABSENT IS NOT ZERO. A field missing from a result means the value could not be read, never that it
  is zero or empty. Do not sum, average or compare a set of rows with fields missing without saying
  so. readFrom names the wire key each value came from; derived marks a value computed rather than
  read; unmappedKeys names fields this server did not recognise — on account data the VALUES are
  dropped, deliberately, because an unmapped field on a brokerage response may be an account number.
- WHERE THE ROWS CAME FROM. Unprojected tools return Stockbit's own rows untouched. Some hand back
  the payload exactly as it arrived and say nothing about its shape — read the keys off the result
  rather than assuming them. The rest report where they found the rows, in rowsFrom or source: "data" (the payload was a bare array), "data.<key>"
  (wrapped, with the siblings alongside), null/"absent" (no row array was found at all), or
  "unrecognized" (the payload was not a row list; the body is returned so you can see what arrived).
  An EMPTY list is a genuine zero — a quiet symbol, a narrow keyword, a weekend — ONLY when the
  source names a real location it was found at ("data" or "data.<key>"). Where the source is null,
  "absent" or "unrecognized", an empty list means NOT PARSED rather than none, and saying "there
  were none" is then a claim nobody made.
  Where a row carries raw, read a field you do not see off that before concluding it is missing.
- AFTER A WRITE, read outcome: ok means the change was made AND seen when the account was read
  back; rejected means it was refused and nothing is on the book; not-visible means it was accepted
  but could not be found; write-failed means it did not go through; outcome-unknown means the
  read-back itself failed. ok is the only clean success — never resend anything else. NOTHING HERE
  ROLLS BACK: each of these is one action a person can reverse in the Stockbit app, and undoing a
  change this server could not read would be a second blind write. Relay message rather than
  reporting success in your own words.

${orderBlock}${accountBlock}
NOTES
- Symbols are IDX tickers (BBRI, TLKM, …). IHSG is the composite index. Values are in rupiah.
- 1 lot = 100 shares. The tools take lots and do the arithmetic.
- Broker net values ARE negative for a net seller — that is the wire's sign, already applied. Do not
  negate them again.
${profileNote}
THE TOOLS THAT CHANGE SOMETHING are exactly: ${writes.join(", ")} — ${writes.length} of ${total}.
Everything else reads, and a saved workflow recipe can reach nothing but reads.`;
}
