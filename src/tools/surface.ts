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
  /** Families the profile withheld ENTIRELY — not one of their tools registered. */
  withheldFamilies: Family[];
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
    withheldFamilies: define.withheldFamilies(),
    profileLabel: profile?.label ?? "all",
    profileIsDefault: isDefault,
  };
}

/**
 * Group anything family-tagged, preserving the order families first appear.
 *
 * Generic over the item because there are two shapes of the same thing: `ToolRecord` here, and the
 * `Row` `toolsdoc.ts` builds from a live `tools/list`. Both were being grouped by hand — this
 * function, `toolsdoc.ts` and `instructions.ts` held three copies of the loop, and the exported one
 * was the copy nobody called.
 */
export function byFamily<T extends { family: Family }>(items: readonly T[]): Map<Family, T[]> {
  const groups = new Map<Family, T[]>();
  for (const item of items) {
    const existing = groups.get(item.family);
    if (existing) existing.push(item);
    else groups.set(item.family, [item]);
  }
  return groups;
}

/**
 * The one evidence word a group carries, or `"mixed"`.
 *
 * Takes the field rather than the record so a caller with its own row type can use it — which is
 * why the previous signature had no callers at all.
 */
export function dominantEvidence(tools: readonly { evidence: Evidence }[]): Evidence | "mixed" {
  const seen = new Set(tools.map((t) => t.evidence));
  if (seen.size === 1) return [...seen][0] as Evidence;
  return "mixed";
}
