/**
 * The whole tool surface, asserted at the level a client sees it.
 *
 * Two properties, and both are about the same hole. `workflow_run` executes saved recipes by
 * calling tool handlers directly, and it found those handlers by intercepting registration — which
 * meant every registered tool was reachable from a recipe. A recipe is data: a name and a list of
 * steps. Data must not be able to place an order.
 *
 * So `define.write` registers the tool and deliberately does NOT add it to the handler map. The
 * first test drives that mechanism directly; the second asserts the resulting shape on a real
 * server, naming every write there is, so a new one cannot arrive without this file changing.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-tools-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { makeDefiner, type ToolHandler } from "../src/tools/_define.ts";
import { registerTools } from "../src/tools/register.ts";

/**
 * Every tool that can change something. Spelled out rather than derived, because deriving it from
 * the code would make this test agree with whatever the code does — which is the one thing it must
 * not do.
 */
const WRITES = [
  "chartbit_analyze",
  "chartbit_clear",
  "chartbit_draw",
  "chartbit_drawings_save",
  "chartbit_layout_delete",
  "chartbit_layout_save",
  "chartbit_save",
  "chartbit_study",
  "eipo_order",
  "order_amend",
  "order_buy",
  "order_cancel",
  "order_sell",
];

/** A server stub that records registrations without needing a transport. */
function stubServer(): { server: McpServer; registered: Map<string, { annotations?: Record<string, unknown> }> } {
  const registered = new Map<string, { annotations?: Record<string, unknown> }>();
  const server = {
    registerTool: (name: string, config: { annotations?: Record<string, unknown> }) => {
      registered.set(name, config);
    },
  } as unknown as McpServer;
  return { server, registered };
}

test("define.read joins the workflow handler map and define.write never does", () => {
  const { server, registered } = stubServer();
  const handlers = new Map<string, ToolHandler>();
  const define = makeDefiner(server, handlers);
  const handler: ToolHandler = async () => ({});

  define.read("a_read", "reads", { x: z.string() }, handler);
  define.write("a_write", "writes", { x: z.string() }, handler);

  assert.deepEqual([...registered.keys()], ["a_read", "a_write"], "both are registered with the client");
  assert.deepEqual([...handlers.keys()], ["a_read"], "only the read is reachable from a saved recipe");
  assert.deepEqual(define.writeNames(), ["a_write"]);
});

test("a read is annotated read-only and a write is annotated destructive", () => {
  // MCP annotations are hints, not a boundary — the boundary is the route table and the confirm
  // gates. They are still asserted: a client that surfaces "this modifies your account" before the
  // call is one more place the user can say no, and it can only do that if the flag is right.
  const { server, registered } = stubServer();
  const define = makeDefiner(server, new Map());
  const handler: ToolHandler = async () => ({});

  define.read("a_read", "reads", {}, handler);
  define.write("a_write", "writes", {}, handler);

  assert.equal(registered.get("a_read")!.annotations!.readOnlyHint, true);
  assert.equal(registered.get("a_read")!.annotations!.destructiveHint, false);
  assert.equal(registered.get("a_write")!.annotations!.readOnlyHint, false);
  assert.equal(registered.get("a_write")!.annotations!.destructiveHint, true);
  assert.equal(registered.get("a_write")!.annotations!.idempotentHint, false);
});

test("an annotation override applies without losing the write's read-only:false", () => {
  const { server, registered } = stubServer();
  const define = makeDefiner(server, new Map());
  define.write("reversible", "writes, but undoably", {}, async () => ({}), { destructiveHint: false });
  assert.equal(registered.get("reversible")!.annotations!.destructiveHint, false);
  assert.equal(registered.get("reversible")!.annotations!.readOnlyHint, false, "it is still a write");
});

test("the real server registers every tool exactly once", () => {
  const server = new McpServer({ name: "stockbit-mcp", version: "test" });
  registerTools(server);
  const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.equal(new Set(names).size, names.length, "a duplicate name would shadow a tool silently");
  assert.ok(names.length > 100, `expected the full surface, got ${names.length}`);
});

test("the tools that can change something are exactly these, and everything else is read-only", () => {
  const server = new McpServer({ name: "stockbit-mcp", version: "test" });
  registerTools(server);
  const tools = (server as unknown as {
    _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }>;
  })._registeredTools;

  const writes = Object.entries(tools)
    .filter(([, config]) => config.annotations?.readOnlyHint === false)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(writes, WRITES);

  // The four order tools are the ones with no undo. Named again here so that adding a fifth is a
  // deliberate edit to a list that says why it exists.
  for (const name of ["order_buy", "order_sell", "order_amend", "order_cancel"]) {
    assert.ok(writes.includes(name), `${name} must be registered as a write`);
  }
});
