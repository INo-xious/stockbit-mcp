#!/usr/bin/env node
/** Entry point: run the Stockbit MCP server over stdio. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.js";
import { logStderr } from "../src/redact.js";

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr("stockbit-mcp: connected over stdio.");
}

main().catch((err) => {
  logStderr("stockbit-mcp: fatal:", String(err));
  process.exit(1);
});
