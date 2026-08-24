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
import type { ToolProfile } from "./tools/_define.js";

export interface CreateServerOptions {
  /** Which families and tools to register. Omitted means all of them. */
  profile?: ToolProfile;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const surface = describeSurface(options.profile);

  const server = new McpServer(
    { name: "stockbit", version: VERSION },
    { instructions: buildInstructions(surface) },
  );

  registerTools(server, { profile: options.profile });
  return server;
}
