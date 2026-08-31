#!/usr/bin/env node
/**
 * Start the BUILT binary over stdio and ask it what it registered.
 *
 * This is the only check that runs the thing a user actually runs: the compiled entry point, over a
 * real transport, in a child process with a throwaway store. Everything else in the suite imports
 * TypeScript directly and would not notice a broken build, a missing `dist/` file, or an entry point
 * that cannot start.
 *
 * ## Two children, and that is the point
 *
 * The server registers the `core` profile when `STOCKBIT_TOOLS` says nothing. That is the
 * configuration almost every user gets, and until this script ran it, the only surface ever smoke
 * -tested was `all` — the one almost nobody has. So:
 *
 *   1. **unset** — the default path. Counts come from the "default tools / default prompts" line in
 *      `docs/TOOLS.md`, which `src/toolsdoc.ts` COMPUTES from the surface.
 *   2. **STOCKBIT_TOOLS=all** — the full surface, from the header line of the same file.
 *
 * Neither count is written down here. A number in this file is a number that goes stale, and a
 * smoke test that has to be updated by hand is one that gets updated to whatever makes it pass.
 *
 * Setting `STOCKBIT_TOOLS` in the environment overrides both runs with a single explicit one, so a
 * developer can smoke a profile the way a user would configure it — but then `--expect-tools` is
 * required, because nothing can know what an arbitrary profile should register.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function flag(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const raw = process.argv[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} needs a non-negative integer, got ${raw}`);
  return n;
}

/**
 * Read both sets of expected counts out of the generated reference.
 *
 * Anchored patterns, not loose ones. The previous `/(\d+) prompts?\b/` matched the first such string
 * anywhere in 4 KB of prose, so any sentence mentioning a number of prompts would have silently
 * become the expectation. These match the two sentences `toolsdoc.ts` writes, and nothing else:
 *
 *   **138 tools** (114 read, 24 write) in 17 families, 8 prompts.
 *   Unset, this server registers the **`core`** profile: **40 default tools** and **6 default prompts**.
 */
function fromToolsDoc() {
  const path = join(ROOT, "docs", "TOOLS.md");
  if (!existsSync(path)) return {};
  const head = readFileSync(path, "utf8").slice(0, 4096);
  const all = head.match(/\*\*(\d+) tools\*\* \(\d+ read, \d+ write\) in \d+ families, (\d+) prompts?\./);
  const dflt = head.match(/\*\*(\d+) default tools\*\* and \*\*(\d+) default prompts\*\*/);
  return {
    allTools: all ? Number(all[1]) : undefined,
    allPrompts: all ? Number(all[2]) : undefined,
    defaultTools: dflt ? Number(dflt[1]) : undefined,
    defaultPrompts: dflt ? Number(dflt[2]) : undefined,
  };
}

/**
 * Start the built server with `env`, and check what it registered.
 *
 * Returns the failures it found, prefixed with which run they came from — two runs producing the
 * same bare message is exactly the case where a prefix is the difference between a diagnosis and a
 * second guess.
 */
async function runOnce({ label, profileEnv, expectTools, expectPrompts }) {
  const failures = [];
  const check = (ok, message) => {
    if (!ok) failures.push(`[${label}] ${message}`);
    return ok;
  };

  const entry = join(ROOT, "dist", "bin", "stockbit-mcp.js");
  if (!existsSync(entry)) {
    return { failures: [`[${label}] ${entry} is missing. Run \`npm run build\` first.`], toolNames: [], promptNames: [] };
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
      // And no network. This smoke calls the `status` tool, which asks npm whether a newer release
      // exists — so without this, a gate command that is supposed to prove the built binary starts
      // would instead depend on registry.npmjs.org being reachable, and stall for the timeout when
      // it is not. `test/updatecheck.test.ts` asserts every spawner sets this.
      STOCKBIT_NO_UPDATE_CHECK: "1",
      ...(profileEnv === undefined ? {} : { STOCKBIT_TOOLS: profileEnv }),
      ...(process.env.STOCKBIT_TRADING ? { STOCKBIT_TRADING: process.env.STOCKBIT_TRADING } : {}),
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
    check(tools.length === expectTools, `tools/list returned ${tools.length}, expected ${expectTools}`);

    // `prompts/list` is an error, not an empty list, until the server declares the capability.
    if (client.getServerCapabilities()?.prompts) {
      const { prompts } = await client.listPrompts();
      promptNames = prompts.map((p) => p.name).sort();
      if (expectPrompts !== undefined) {
        check(prompts.length === expectPrompts, `prompts/list returned ${prompts.length}, expected ${expectPrompts}`);
      }
    } else if (expectPrompts !== undefined) {
      check(expectPrompts === 0, `expected ${expectPrompts} prompts but the server declares no prompt capability`);
    }

    // The one call every new user makes. It must answer with an empty store and say what to run.
    // `status` is in every profile — the `system` family is never filtered — so this runs on both.
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
    } else {
      check(false, "status was not registered — the system family must never be filtered out");
    }
  } catch (err) {
    failures.push(`[${label}] transport or protocol error: ${err?.message ?? err}`);
  } finally {
    await client.close().catch(() => {});
    rmSync(store, { recursive: true, force: true });
  }

  return { failures, toolNames, promptNames };
}

async function main() {
  const doc = fromToolsDoc();

  // An explicit STOCKBIT_TOOLS in the environment means "smoke exactly this", and nothing can know
  // what an arbitrary profile should register — so the count has to be supplied.
  const override = (process.env.STOCKBIT_TOOLS ?? "").trim();
  let runs;
  if (override) {
    const expectTools = flag("--expect-tools");
    if (expectTools === undefined) {
      console.error(
        `smoke FAILED — STOCKBIT_TOOLS=${override} filters the surface, so pass --expect-tools N ` +
          "with the count that profile should register.",
      );
      process.exit(1);
    }
    // `--expect-prompts` is OPTIONAL and unset means "do not check". Defaulting it to 0 made the
    // usage this file documents fail every time: `STOCKBIT_TOOLS=core npm run smoke
    // --expect-tools 40` registers 6 prompts and was told to expect none.
    runs = [
      {
        label: override,
        profileEnv: override,
        expectTools,
        expectPrompts: flag("--expect-prompts"),
      },
    ];
  } else {
    if (doc.defaultTools === undefined || doc.allTools === undefined) {
      console.error(
        "smoke FAILED — could not read the expected counts out of docs/TOOLS.md. " +
          "Run `npm run docs:tools` first.",
      );
      process.exit(1);
    }
    runs = [
      // The default FIRST: it is the configuration almost every user gets, and a failure there
      // matters more than a failure in the one almost nobody has.
      { label: "default", profileEnv: undefined, expectTools: doc.defaultTools, expectPrompts: doc.defaultPrompts ?? 0 },
      { label: "all", profileEnv: "all", expectTools: doc.allTools, expectPrompts: doc.allPrompts ?? 0 },
    ];
  }

  const failures = [];
  const summary = [];
  for (const run of runs) {
    const result = await runOnce(run);
    failures.push(...result.failures);
    summary.push(`${run.label}: ${result.toolNames.length} tools, ${result.promptNames.length} prompts`);
  }

  if (failures.length) {
    console.error(`smoke FAILED\n${failures.map((f) => `  ${f}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`smoke OK — ${summary.join(" · ")}; initialize and status answered on an empty store.`);
}

main().catch((err) => {
  console.error(`smoke FAILED — ${err?.stack ?? err}`);
  process.exit(1);
});
