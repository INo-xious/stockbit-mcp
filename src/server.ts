/**
 * Stockbit MCP server factory.
 *
 * The order here matters. The `instructions` string has to name every write tool, so the surface is
 * described first — against a recorder, not a server — and the server is built from what that
 * describes. Doing it the other way round is how the instructions came to claim four write tools
 * while twenty-two were registered.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/register.js";
import { describeSurface } from "./tools/surface.js";
import { buildInstructions } from "./instructions.js";
import { VERSION } from "./version.js";
import { registerWorkflowPrompts } from "./prompts.js";
import type { ToolProfile } from "./tools/_define.js";

export interface CreateServerOptions {
  /** Which families and tools to register. Omitted means all of them. */
  profile?: ToolProfile;
  /**
   * Whether `profile` is the DEFAULT rather than something the user asked for.
   *
   * Reaches the instructions, which have to say "registers the core profile, the default" instead
   * of "STOCKBIT_TOOLS=core is set" when nobody set it.
   */
  profileIsDefault?: boolean;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const surface = describeSurface(options.profile, options.profileIsDefault === true);

  const server = new McpServer(
    { name: "stockbit", version: VERSION },
    { instructions: buildInstructions(surface) },
  );

  registerTools(server, {
    profile: options.profile,
    profileIsDefault: options.profileIsDefault === true,
    toolCount: surface.tools.length,
  });

  // After the tools, and from the SURFACE rather than from the profile: a prompt's first
  // instruction is to call `workflow_run`, and its recipe then calls tools by name. A prompt whose
  // recipe names something this profile filtered out is a menu entry that always half-fails, which
  // is the same argument the code already makes one line down about `workflow_run` itself.
  registerWorkflowPrompts(server, surface);

  return server;
}
