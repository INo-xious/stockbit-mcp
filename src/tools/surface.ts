/**
 * What tools this server would register, without starting one.
 *
 * Three things need to know the surface before a client is connected: the `instructions` string
 * (which must name every write tool, and used to name four of twenty-two because it was written by
 * hand), the generated tool reference, and `status` (which reports how many tools a profile left).
 *
 * Starting a real server to find out is the wrong shape — `createServer` needs the answer *before*
 * it can build its instructions, so that would be a cycle. Instead `registerTools` is called
 * against a recorder that implements the two methods it touches and remembers what it was told.
 * That works because registration is pure: it builds descriptions and closures and makes no
 * request, opens no file and reads no credential. If that ever stops being true, this breaks
 * loudly rather than quietly doing I/O at import time.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./register.js";
import type { Evidence, Family, ToolProfile, ToolRecord } from "./_define.js";

export interface Surface {
  /** Every tool that would be registered, in registration order. */
  tools: ToolRecord[];
  /** The names that change something, sorted. */
  writes: string[];
  /** The names a profile kept out, in registration order. */
  skipped: string[];
  /** What to call the profile in a message. `"all"` when there is none. */
  profileLabel: string;
  /**
   * True when this profile is the DEFAULT rather than something the user asked for.
   *
   * The two need different words. Telling a reader "STOCKBIT_TOOLS=core is set, so 98 tools are
   * missing" when nobody set it sends them looking for a variable that is not there, in a config
   * file they may not even own.
   */
  profileIsDefault: boolean;
}

/** A stand-in for `McpServer` that records instead of registering. */
function recorder(): McpServer {
  return {
    registerTool() {
      return { enable() {}, disable() {}, remove() {} };
    },
    registerPrompt() {
      return { enable() {}, disable() {}, remove() {} };
    },
  } as unknown as McpServer;
}

/** Describe the surface a profile would produce. Synchronous and side-effect free. */
export function describeSurface(profile?: ToolProfile, isDefault = false): Surface {
  const define = registerTools(recorder(), { profile, profileIsDefault: isDefault });
  return {
    tools: define.records(),
    writes: define.writeNames(),
    skipped: define.skippedNames(),
    profileLabel: profile?.label ?? "all",
    profileIsDefault: isDefault,
  };
}

/** Group a surface by family, preserving the order families first appear. */
export function byFamily(surface: Surface): { family: Family; tools: ToolRecord[] }[] {
  const groups = new Map<Family, ToolRecord[]>();
  for (const tool of surface.tools) {
    const existing = groups.get(tool.family);
    if (existing) existing.push(tool);
    else groups.set(tool.family, [tool]);
  }
  return [...groups].map(([family, tools]) => ({ family, tools }));
}

/** The evidence word a family mostly carries, for a summary row. */
export function dominantEvidence(tools: ToolRecord[]): Evidence | "mixed" {
  const seen = new Set(tools.map((t) => t.evidence));
  if (seen.size === 1) return [...seen][0] as Evidence;
  return "mixed";
}
