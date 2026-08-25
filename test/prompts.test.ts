/**
 * The eight workflows as MCP prompts, asserted through a real client.
 *
 * Everything here goes over an in-memory transport rather than against the registration functions,
 * because the thing being tested is what a client sees: the prompt list, the argument schema it
 * renders a form from, and the message text the model actually receives. A unit test of
 * `promptText` would pass while `registerPrompt` was called with the wrong shape.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-prompts-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.ts";
import { BUILTIN_WORKFLOWS } from "../src/workflows/builtin.ts";
import { parseToolProfile } from "../src/tools/_profile.ts";
import { describeSurface } from "../src/tools/surface.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

async function connect(profile?: ReturnType<typeof parseToolProfile>) {
  const server = createServer(profile ? { profile } : {});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prompt-test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: () => Promise.all([client.close(), server.close()]) };
}

test("every built-in workflow is offered as a prompt, and nothing else is", async () => {
  const { client, close } = await connect();
  try {
    const { prompts } = await client.listPrompts();
    assert.equal(prompts.length, BUILTIN_WORKFLOWS.length);
    assert.deepEqual(
      prompts.map((p) => p.name).sort(),
      BUILTIN_WORKFLOWS.map((w) => w.name).sort(),
    );
    for (const prompt of prompts) {
      assert.ok(prompt.description && prompt.description.length > 20, `${prompt.name} has no description`);
      assert.ok(prompt.title, `${prompt.name} has no human-readable title`);
    }
  } finally {
    await close();
  }
});

test("required workflow inputs are required arguments, and optional ones are not", async () => {
  const { client, close } = await connect();
  try {
    const { prompts } = await client.listPrompts();
    for (const workflow of BUILTIN_WORKFLOWS) {
      const prompt = prompts.find((p) => p.name === workflow.name);
      assert.ok(prompt, `no prompt for ${workflow.name}`);
      const args = prompt.arguments ?? [];
      assert.equal(args.length, workflow.inputs.length, `${workflow.name} argument count`);
      for (const input of workflow.inputs) {
        const arg = args.find((a) => a.name === input.name);
        assert.ok(arg, `${workflow.name} is missing argument ${input.name}`);
        assert.equal(Boolean(arg.required), input.required, `${workflow.name}.${input.name} requiredness`);
        assert.equal(arg.description, input.description);
      }
    }
  } finally {
    await close();
  }
});

test("getPrompt returns a user message that names workflow_run and carries the arguments", async () => {
  const { client, close } = await connect();
  try {
    const result = await client.getPrompt({ name: "deep_dive", arguments: { symbol: "BBRI" } });
    assert.equal(result.messages.length, 1);
    const [message] = result.messages;
    assert.equal(message.role, "user");
    assert.equal(message.content.type, "text");
    const text = message.content.type === "text" ? message.content.text : "";

    assert.match(text, /workflow_run/);
    assert.match(text, /"deep_dive"/);
    assert.match(text, /BBRI/);
    assert.match(text, /not investment advice/i);
  } finally {
    await close();
  }
});

test("an omitted optional argument does not become an empty input key", async () => {
  // `{"symbol":"BBRI","bars":""}` would reach `workflow_run` as an explicit empty string, which is
  // not the same as absent — the workflow's own default would never apply.
  const { client, close } = await connect();
  try {
    const result = await client.getPrompt({ name: "deep_dive", arguments: { symbol: "BBRI" } });
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    assert.match(text, /input: \{"symbol":"BBRI"\}/);
    assert.ok(!text.includes('"bars"'));
  } finally {
    await close();
  }
});

test("a workflow with no inputs still produces a usable prompt", async () => {
  const { client, close } = await connect();
  try {
    const result = await client.getPrompt({ name: "portfolio_review" });
    const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
    assert.match(text, /input: \{\}/);
    assert.match(text, /Never invent a holding/);
  } finally {
    await close();
  }
});

test("each prompt carries presentation guidance specific to its workflow", async () => {
  // Generic guidance would make these eight menu entries interchangeable. The domain knowledge is
  // the point: NET vs GROSS for bandarmology, `inconclusive` being an answer for a backtest.
  const expectations: Record<string, RegExp> = {
    deep_dive: /confidence/,
    morning_scan: /breaking out|market session/i,
    bandar_watch: /NET or GROSS/,
    alert_sweep: /fired/,
    pine_handoff: /TradingView/,
    strategy_check: /inconclusive/,
    screen_and_dive: /survived/,
    portfolio_review: /Never invent a holding/,
  };

  // Required arguments have to be supplied, so each entry brings the minimum its workflow needs.
  const required: Record<string, Record<string, string>> = {
    deep_dive: { symbol: "BBRI" },
    bandar_watch: { symbol: "BBRI" },
    pine_handoff: { symbol: "BBRI" },
    strategy_check: { symbol: "BBRI" },
  };

  const { client, close } = await connect();
  try {
    for (const [name, pattern] of Object.entries(expectations)) {
      const result = await client.getPrompt({ name, arguments: required[name] ?? {} });
      const text = result.messages[0].content.type === "text" ? result.messages[0].content.text : "";
      assert.match(text, pattern, `${name} is missing its own guidance`);
    }
  } finally {
    await close();
  }
});

test("a profile that filters out workflows registers no prompts at all", async () => {
  // A menu entry whose first instruction is to call a tool that is not registered is worse than no
  // menu entry: it fails after the user has chosen it.
  const profile = parseToolProfile("market");
  assert.ok(describeSurface(profile).skipped.includes("workflow_run"));

  const { client, close } = await connect(profile);
  try {
    const capabilities = client.getServerCapabilities();
    if (capabilities?.prompts) {
      const { prompts } = await client.listPrompts();
      assert.deepEqual(prompts, []);
    }
  } finally {
    await close();
  }
});
