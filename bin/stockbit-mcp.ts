#!/usr/bin/env node
/**
 * Entry point: run the Stockbit MCP server over stdio.
 *
 * The only thing this decides is which tools to register. `STOCKBIT_TOOLS` is parsed here rather
 * than inside the server so a bad value can **stop the process**: a typo that quietly fell back to
 * registering every tool would blow a client's tool cap and look like a bug in the client. A
 * server that refuses to start with a message naming every valid family is the kinder failure.
 *
 * Unset means `core`, not everything — see `DEFAULT_TOOL_PROFILE`. The full surface is not a
 * startup cost, it is a PER-TURN one: 138 tool schemas is roughly 54,400 tokens in the model's
 * context on every message.
 *
 * ## The command line is gated, like every other bin
 *
 * This entry point used to read `process.argv` nowhere. Every token on the command line therefore
 * fell through to "start an MCP server on stdio" — so `stockbit-mcp --version` printed the
 * connection line and exited 0 when stdin closed, and there was no way to ask the installed package
 * what it was short of reading its `package.json` by hand. That matters more than it sounds:
 * `npx` caches a caret range, so a user can sit on a stale build indefinitely, and the version is
 * the first thing anyone needs in order to notice.
 *
 * `--version` and `--help` are answered before anything starts, and an unknown flag is a usage
 * error (exit 2) rather than a silently-started server. The other four bins already worked this
 * way; `src/cliargs.ts` explains why an unknown token must be an error and never a shrug.
 */
import { stdout } from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "../src/server.js";
import { describeSurface } from "../src/tools/surface.js";
import { resolveToolProfile } from "../src/tools/_profile.js";
import { logStderr } from "../src/redact.js";
import { CliParseError, gateBareCommandLine, type CommandSpec } from "../src/cliargs.js";
import { VERSION } from "../src/version.js";
import { armAutoRelogin } from "../src/auth/relogin.js";

const MCP_BIN = "stockbit-mcp";

/**
 * What this bin accepts. One behaviour, two questions about itself, and no positionals.
 *
 * Configuration is environment-only and stays that way: an MCP server is launched by a client from
 * a JSON config, and a flag the client cannot set is a flag nobody can use. `details` says so, so
 * `--help` sends the reader to the right place instead of implying flags that do not exist.
 */
const MCP_SPEC: CommandSpec = {
  summary: "Run the Stockbit MCP server over stdio.",
  flags: {
    "--version": "Print the installed version and exit.",
    "--help": "Print this usage and exit.",
  },
  details: [
    "Configured by environment, not by flags:",
    "  STOCKBIT_TOOLS   which tool families to register (default: core; `all` for every tool)",
    "",
    "Run `stockbit-auth login` first if this is a new machine.",
  ],
};

async function main(): Promise<void> {
  // Before ANYTHING starts. `--version` writes to stdout deliberately: it is the product of the
  // command and it exits before the transport is connected, so it cannot collide with the JSON-RPC
  // stream that owns stdout once the server is running. Everything the running server says goes to
  // stderr through `logStderr`, for exactly that reason.
  try {
    if (gateBareCommandLine(MCP_BIN, MCP_SPEC, process.argv.slice(2), (text) => stdout.write(text), VERSION) !== "ok") {
      return;
    }
  } catch (err) {
    if (err instanceof CliParseError) {
      // A usage error, not a runtime one — the same exit 2 `stockbit-auth` uses, so a wrapper can
      // tell "you typed it wrong" from "it ran and failed".
      logStderr(err.message);
      process.exit(2);
    }
    throw err;
  }

  // Describing the unfiltered surface first gives `parseToolProfile` the real tool names, so a typo
  // in a single tool name is caught the same way a typo in a family name is.
  const knownTools = new Set(describeSurface().tools.map((t) => t.name));

  let resolved;
  try {
    resolved = resolveToolProfile(process.env.STOCKBIT_TOOLS, knownTools);
  } catch (err) {
    logStderr(`stockbit-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const { profile, isDefault } = resolved;

  // Arm automatic login recovery — HERE, and in no other entry point.
  //
  // This is the enforcement half of "never auto-relogin inside `stockbit-batch`". Batch reaches
  // `forceRefresh` through the same `src/http/client.ts` as everything else and there is no run-mode
  // marker anywhere in this repo, so a check inside the auth layer would have nothing to test. A
  // capability the batch process simply never grants itself cannot be got wrong by a later edit to
  // some condition, and a long unattended backfill goes on failing fast, which is what it should do.
  //
  // Arming grants nothing on its own: recovery also needs STOCKBIT_AUTO_RELOGIN set, no
  // STOCKBIT_NO_BROWSER, a provably live website session, and its one unspent attempt.
  armAutoRelogin();

  const server = createServer({ profile, profileIsDefault: isDefault });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr(
    `stockbit-mcp: connected over stdio (tool profile: ${profile.label}` +
      `${isDefault ? " — the default; set STOCKBIT_TOOLS=all for every tool" : ""}).`,
  );
}

main().catch((err) => {
  logStderr("stockbit-mcp: fatal:", String(err));
  process.exit(1);
});
