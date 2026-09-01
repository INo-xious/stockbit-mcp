/**
 * Which tools this server registers — `STOCKBIT_TOOLS`.
 *
 * 138 tools is a lot for a protocol whose clients budget for a handful. Cursor stops at 40 and
 * refuses the rest without saying which; VS Code caps at 128; every client pays for the whole tool
 * list in the model's context on every turn, whether or not a single one is called. A server that
 * cannot be trimmed is a server people uninstall.
 *
 * So the same surface can be registered three ways:
 *
 *   - `all` — everything. NOT the default: an unset variable means `core`, see `DEFAULT_TOOL_PROFILE`.
 *   - `core` — the 41 tools that answer the questions people actually ask, and **the default**.
 *     It used to be exactly Cursor's 40 and is now one over: see `CORE_CAP` for what that buys and
 *     what it costs. On Cursor, name a narrower list rather than trusting this to fit. No order
 *     writes: whoever wants those asks for `core,trading` and has therefore thought about it once.
 *   - a comma-separated list of families and/or individual tool names — `market,bandarmology`,
 *     `core,trading`, `quote,broker_summary,analyze`.
 *
 * ## Two rules
 *
 * **`system` is never filtered.** `status`, `login` and `logout` are how a user finds out why
 * everything else is missing. A profile that could hide `status` would produce a server nobody can
 * debug, so the exemption lives in `_define.ts` where registration happens, not here.
 *
 * **An unknown token is an error, not a shrug.** `STOCKBIT_TOOLS=bandar` (for `bandarmology`) that
 * silently registered nothing would look exactly like a broken install. It throws, the message
 * lists every family, and `bin/stockbit-mcp.ts` exits rather than falling back to everything —
 * because a misconfigured profile silently loading the full surface is how a client's tool cap gets
 * blown by a typo.
 */
import { FAMILIES, type Family, type ToolProfile } from "./_define.js";

export { FAMILIES };

/**
 * The default working set: 41 tools, no order writes.
 *
 * Chosen against the questions this server exists to answer — what is the price, who accumulated,
 * is the trend real, what do I hold, tell me when — rather than by taking the first N of anything.
 * Every name here is checked against the real surface by `test/profile.test.ts`, so a rename cannot
 * leave a dangling entry that silently drops a tool from `core`.
 */
export const CORE_TOOLS: readonly string[] = [
  // Is this thing working?
  "status",
  "login",
  "logout",
  // What is the price?
  "quote",
  "orderbook",
  "price_bands",
  "top_movers",
  "market_movers",
  "market_session",
  // Is the move real?
  "technicals",
  "price_chart",
  "patterns",
  "analyze",
  "scan",
  "backtest",
  "strategy_compare",
  "timeframe_alignment",
  "position_size",
  // Who was on each side of the tape?
  "broker_summary",
  "broker_distribution",
  "broker_activity",
  "bandar_detector",
  // What is the company worth?
  "keystats",
  "ratios",
  "financials",
  "seasonality",
  "news",
  "stream",
  // The user's own lists.
  "watchlist",
  "screener",
  "workflow_list",
  "workflow_run",
  // Tell me when.
  "alert_create",
  "alert_list",
  "alert_delete",
  "alert_check",
  // The user's own money, read-only. The order writes are deliberately not here.
  "portfolio",
  "position",
  "cash_balance",
  "orders",
  "trading_status",
];

/**
 * The ceiling on `core`, and it is no longer Cursor's.
 *
 * This was 40 to sit exactly on Cursor's cap. It is 41 because `market_movers` was judged worth
 * more in the default surface than that exact fit: `top_movers` reads a NINE-symbol hotlist, and a
 * default profile that can rank nine stocks but not the market is missing the more useful of the
 * two. Both ship, because they read different services and neither answers the other's question.
 *
 * What that costs is stated rather than hidden: a Cursor user is now one over, and Cursor drops the
 * overflow WITHOUT saying which tool it dropped. Anyone on that client should name a narrower list
 * (a family list, or `core` minus what they do not want) rather than trust the default to fit.
 * README says the same thing where it used to promise the fit.
 */
export const CORE_CAP = 41;

class NamedProfile implements ToolProfile {
  constructor(
    readonly label: string,
    private readonly families: ReadonlySet<Family>,
    private readonly tools: ReadonlySet<string>,
  ) {}

  allows(family: Family, name: string): boolean {
    return this.families.has(family) || this.tools.has(name);
  }
}

/** The profile that filters nothing. Its label is what `status` and the instructions report. */
const ALL: ToolProfile = { label: "all", allows: () => true };

function isFamily(value: string): value is Family {
  return (FAMILIES as readonly string[]).includes(value);
}

/**
 * Parse `STOCKBIT_TOOLS`.
 *
 * `knownTools` is passed in rather than imported so this module does not depend on registration —
 * `describeSurface` needs a profile *before* it can describe the surface, and importing the surface
 * here would close that loop. When it is omitted, individual tool names are accepted without being
 * checked; `bin/stockbit-mcp.ts` supplies the real set so a typo in a tool name is caught too.
 *
 * @throws Error naming every family, when a token is neither a family nor a known tool.
 */
export function parseToolProfile(raw: string | undefined, knownTools?: ReadonlySet<string>): ToolProfile {
  const value = (raw ?? "").trim();
  if (!value || value.toLowerCase() === "all") return ALL;

  const families = new Set<Family>();
  const tools = new Set<string>();
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower === "all") return ALL;
    if (lower === "core") {
      for (const name of CORE_TOOLS) tools.add(name);
      continue;
    }
    if (isFamily(lower)) {
      families.add(lower);
      continue;
    }
    if (!knownTools || knownTools.has(token)) {
      tools.add(token);
      continue;
    }
    throw new Error(
      `STOCKBIT_TOOLS: unknown family or tool ${JSON.stringify(token)}. ` +
        `Families: ${FAMILIES.join(", ")}. Also accepted: "all", "core", or any tool name. ` +
        // NOT "unset the variable to register everything". Unset is `core` now — 41 of 138. This
        // message is printed as the server refuses to start, to a user who is already confused
        // about which tools exist; sending them to the wrong remedy from there is worse than
        // saying nothing.
        `Set STOCKBIT_TOOLS=all to register everything, or unset it for the default (${DEFAULT_TOOL_PROFILE}).`,
    );
  }

  if (!families.size && !tools.size) return ALL;
  return new NamedProfile(value, families, tools);
}

/**
 * What this server registers when `STOCKBIT_TOOLS` says nothing.
 *
 * `core` rather than `all`, and the reason is measured. Startup was never the problem — a built
 * server boots, registers everything and answers `status` in about 200 ms. The cost is per TURN:
 * `tools/list` for the full surface is about 220,000 bytes — roughly 55,000 tokens — in the model's
 * context on every single message. `core` is about 71,000, roughly 17,700. That is the same server
 * costing a third as much to talk to, for 41 tools chosen to be the questions people actually ask.
 * (Figures are approximate on purpose: they move whenever a description is edited, and a number
 * stated to the byte is a number that is quietly wrong a week later.)
 *
 * This also aligns the code with the docs: the README has been telling people to put
 * `"STOCKBIT_TOOLS": "core"` in the snippet they copy for as long as the profile has existed.
 */
export const DEFAULT_TOOL_PROFILE = "core";

/**
 * Resolve the profile for a server, and say whether the DEFAULT was used.
 *
 * `parseToolProfile` stays pure — `toolsdoc.ts` still asks it for `"all"` and means it, and
 * `test/profile.test.ts` still tests "what does this string mean" without a default in the way.
 * The `isDefault` flag exists because the two cases need different words: a note saying
 * "STOCKBIT_TOOLS=core is set" when nobody set it sends a reader looking for a variable that is not
 * there, in a config file they may not even own.
 */
export function resolveToolProfile(
  raw: string | undefined,
  knownTools?: ReadonlySet<string>,
): { profile: ToolProfile; isDefault: boolean } {
  const value = (raw ?? "").trim();
  if (!value) return { profile: parseToolProfile(DEFAULT_TOOL_PROFILE, knownTools), isDefault: true };
  return { profile: parseToolProfile(value, knownTools), isDefault: false };
}
