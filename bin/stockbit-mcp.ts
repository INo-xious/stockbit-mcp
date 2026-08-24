#!/usr/bin/env node
/**
 * Entry point: run the Stockbit MCP server over stdio.
 *
 * The only thing this decides is which tools to register. `STOCKBIT_TOOLS` is parsed here rather
 * than inside the server so a bad value can **stop the process**: a typo that quietly fell back to
 * registering all 138 tools would blow a client's tool cap and look like a bug in the client. A
 * server that refuses to start with a message naming every valid family is the kinder failure.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.js";
import { describeSurface } from "../src/tools/surface.js";
import { parseToolProfile } from "../src/tools/_profile.js";
import { logStderr } from "../src/redact.js";

async function main(): Promise<void> {
  // Describing the unfiltered surface first gives `parseToolProfile` the real tool names, so a typo
  // in a single tool name is caught the same way a typo in a family name is.
  const knownTools = new Set(describeSurface().tools.map((t) => t.name));

  let profile;
  try {
    profile = parseToolProfile(process.env.STOCKBIT_TOOLS, knownTools);
  } catch (err) {
    logStderr(`stockbit-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const server = createServer({ profile });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr(`stockbit-mcp: connected over stdio (tool profile: ${profile.label}).`);
}

main().catch((err) => {
  logStderr("stockbit-mcp: fatal:", String(err));
  process.exit(1);
});
