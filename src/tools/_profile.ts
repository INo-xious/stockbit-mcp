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
 *   - `all` (the default, and what an empty value means) — everything.
 *   - `core` — the 40 tools that answer the questions people actually ask, chosen to fit under
 *     Cursor's cap with room for a client's own tools. No order writes: someone who wants those
 *     asks for `core,trading` and has therefore thought about it once.
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
 * The default working set: 40 tools, no order writes.
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

/** Cursor's ceiling. `core` exists to fit under it, so exceeding it would defeat the point. */
export const CORE_CAP = 40;

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

export function isFamily(value: string): value is Family {
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
        "Unset the variable to register everything.",
    );
  }

  if (!families.size && !tools.size) return ALL;
  return new NamedProfile(value, families, tools);
}
