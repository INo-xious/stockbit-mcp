#!/usr/bin/env node
/**
 * Start the built server the way a client starts it, and check that it answers.
 *
 * The unit tests exercise every module in isolation; none of them proves that `dist/bin/
 * stockbit-mcp.js` boots, speaks MCP over stdio, and registers the tools it is supposed to. That
 * gap is exactly where a packaging mistake lands — a bad `bin` path, a missing file in `files`, an
 * import that only resolves under `tsx` — and it is invisible until someone runs `npx stockbit-mcp`.
 *
 * Everything runs against a throwaway store: no keychain, no browser, no network. A server with no
 * session must still start and answer, because that is the state every new user is in.
 *
 * Usage:
 *   node scripts/smoke.mjs [--expect-tools N] [--expect-prompts N]
 *
 * The expected counts come from `--expect-*` first, then from the header of `docs/TOOLS.md` once
 * that file is generated, then from the constants below. Guessing is not one of the options: an
 * unknown expectation is reported as unknown rather than passed.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** What the surface is expected to hold when nothing else says otherwise. Update with each phase. */
const FALLBACK_TOOLS = 134;
const FALLBACK_PROMPTS = 0;

function flag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const raw = process.argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} needs a non-negative integer, got ${raw}`);
  return n;
}

/** `**138 tools** (114 read, 24 write) in 17 families, 8 prompts` — the generated header. */
function fromToolsDoc() {
  const path = join(ROOT, "docs", "TOOLS.md");
  if (!existsSync(path)) return {};
  const head = readFileSync(path, "utf8").slice(0, 4096);
  const tools = head.match(/\*\*(\d+) tools\*\*/);
  const prompts = head.match(/(\d+) prompts?\b/);
  return {
    tools: tools ? Number(tools[1]) : undefined,
    prompts: prompts ? Number(prompts[1]) : undefined,
  };
}

const failures = [];
function check(ok, message) {
  if (!ok) failures.push(message);
  return ok;
}

async function main() {
  const doc = fromToolsDoc();
  const expectTools = flag("--expect-tools") ?? doc.tools ?? FALLBACK_TOOLS;
  const expectPrompts = flag("--expect-prompts") ?? doc.prompts ?? FALLBACK_PROMPTS;

  const entry = join(ROOT, "dist", "bin", "stockbit-mcp.js");
  if (!existsSync(entry)) {
    console.error(`smoke FAILED — ${entry} is missing. Run \`npm run build\` first.`);
    process.exit(1);
  }

  const store = mkdtempSync(join(tmpdir(), "stockbit-smoke-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? store,
      // A throwaway store, no keychain, and no way to open a browser window.
      STOCKBIT_FORCE_FILE_STORE: "1",
      STOCKBIT_STORE_DIR: store,
      STOCKBIT_NO_BROWSER: "1",
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "stockbit-smoke", version: "1.0.0" }, { capabilities: {} });
  let toolNames = [];
  let promptNames = [];

  try {
    await client.connect(transport);

    const info = client.getServerVersion();
    check(info?.name === "stockbit", `server name is ${JSON.stringify(info?.name)}, expected "stockbit"`);
    check(typeof info?.version === "string" && info.version.length > 0, "server reported no version");

    const instructions = client.getInstructions();
    check(typeof instructions === "string" && instructions.length > 0, "server sent no instructions");

    const { tools } = await client.listTools();
    toolNames = tools.map((t) => t.name).sort();
    check(
      tools.length === expectTools,
      `tools/list returned ${tools.length}, expected ${expectTools}`,
    );

    // `prompts/list` is an error, not an empty list, until the server declares the capability.
    if (client.getServerCapabilities()?.prompts) {
      const { prompts } = await client.listPrompts();
      promptNames = prompts.map((p) => p.name).sort();
      check(
        prompts.length === expectPrompts,
        `prompts/list returned ${prompts.length}, expected ${expectPrompts}`,
      );
    } else {
      check(expectPrompts === 0, `expected ${expectPrompts} prompts but the server declares no prompt capability`);
    }

    // The one call every new user makes. It must answer with an empty store and say what to run.
    if (toolNames.includes("status")) {
      const res = await client.callTool({ name: "status", arguments: {} });
      check(res.isError !== true, `status returned isError — ${JSON.stringify(res.content).slice(0, 400)}`);
      const text = (res.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      check(
        text.includes("stockbit-auth login"),
        "status did not name `stockbit-auth login` as the next step on an empty store",
      );
      check(!/\beyJ[A-Za-z0-9_-]{10,}/.test(text), "status leaked something JWT-shaped");
    }
  } catch (err) {
    failures.push(`transport or protocol error: ${err?.message ?? err}`);
  } finally {
    await client.close().catch(() => {});
    rmSync(store, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error("smoke FAILED\n" + failures.map((f) => `  ${f}`).join("\n"));
    process.exit(1);
  }
  console.log(
    `smoke OK — ${toolNames.length} tools, ${promptNames.length} prompts, ` +
      `initialize and ${toolNames.includes("status") ? "status" : "tools/list"} answered on an empty store.`,
  );
}

main().catch((err) => {
  console.error(`smoke FAILED — ${err?.stack ?? err}`);
  process.exit(1);
});
