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
import { makeDefiner, FAMILIES, FAMILY_META_KEY, EVIDENCE_META_KEY, type ToolHandler } from "../src/tools/_define.ts";
import { registerTools } from "../src/tools/register.ts";
import { describeSurface } from "../src/tools/surface.ts";
import { buildInstructions } from "../src/instructions.ts";

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
  "screener_delete",
  "screener_favorite",
  "screener_save",
  "watchlist_add",
  "watchlist_create",
  "watchlist_delete",
  "watchlist_favorite",
  "watchlist_remove",
  "watchlist_rename",
];

/** A server stub that records registrations without needing a transport. */
interface Registered {
  description?: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

function stubServer(): { server: McpServer; registered: Map<string, Registered> } {
  const registered = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered) => {
      registered.set(name, config);
    },
  } as unknown as McpServer;
  return { server, registered };
}

/** Read the `_meta` a real server stored for each tool. */
function metaOf(server: McpServer): Record<string, Record<string, unknown> | undefined> {
  const tools = (server as unknown as {
    _registeredTools: Record<string, { _meta?: Record<string, unknown> }>;
  })._registeredTools;
  return Object.fromEntries(Object.entries(tools).map(([name, config]) => [name, config._meta]));
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

test("destructiveHint is graded rather than uniform", () => {
  // Marking every write destructive teaches a client to ignore the flag, which makes the deletions
  // LESS visible rather than more. So the ones that cannot be undone in the Stockbit app in a few
  // taps are marked true and the rest are not, and this asserts the grading rather than the count.
  const server = new McpServer({ name: "stockbit-mcp", version: "test" });
  registerTools(server);
  const tools = (server as unknown as {
    _registeredTools: Record<string, { annotations?: { destructiveHint?: boolean } }>;
  })._registeredTools;

  for (const name of ["order_buy", "order_sell", "watchlist_delete", "screener_delete", "eipo_order"]) {
    assert.equal(tools[name].annotations?.destructiveHint, true, `${name} should warn the client`);
  }
  for (const name of ["watchlist_add", "watchlist_create", "watchlist_rename", "screener_save"]) {
    assert.equal(tools[name].annotations?.destructiveHint, false, `${name} is reversible in two taps`);
  }
});


/* ------------------------------ families and evidence ------------------------------ */

test("every tool says which family it belongs to", () => {
  const server = new McpServer({ name: "stockbit-mcp", version: "test" });
  registerTools(server);
  const meta = metaOf(server);
  const families = new Set<string>(FAMILIES);

  const missing: string[] = [];
  for (const [name, m] of Object.entries(meta)) {
    const family = m?.[FAMILY_META_KEY];
    if (typeof family !== "string" || !families.has(family)) missing.push(`${name} -> ${String(family)}`);
  }
  assert.deepEqual(missing, [], "a tool with no family cannot be filtered, documented or found");
});

test("every tool carries an evidence word, and it is one of the three", () => {
  const server = new McpServer({ name: "stockbit-mcp", version: "test" });
  registerTools(server);
  const allowed = new Set(["observed", "read-back", "projected"]);

  const wrong: string[] = [];
  for (const [name, m] of Object.entries(metaOf(server))) {
    const evidence = m?.[EVIDENCE_META_KEY];
    if (typeof evidence !== "string" || !allowed.has(evidence)) wrong.push(`${name} -> ${String(evidence)}`);
  }
  assert.deepEqual(wrong, []);
});

test("a tool whose description says it has never been observed is tagged projected", () => {
  // The description is where this fact already lives; the tag is derived from it so the two cannot
  // disagree. This asserts the derivation actually reaches the whole surface — including the four
  // spellings the phrase has across the family modules.
  const surface = describeSurface();
  const contradictions = surface.tools
    .filter((t) => /PENDING VERIFICATION|not been observed/i.test(t.description) && t.evidence !== "projected")
    .map((t) => `${t.name} is ${t.evidence}`);
  assert.deepEqual(contradictions, []);

  const projected = surface.tools.filter((t) => t.evidence === "projected");
  assert.ok(projected.length > 50, `expected the unobserved half to be large, got ${projected.length}`);
});

test("claiming a tool is observed while its description denies it is a registration error", () => {
  const { server } = stubServer();
  const define = makeDefiner(server, new Map());
  assert.throws(
    () =>
      define.read(
        "liar",
        "PENDING VERIFICATION: this route has not been observed live.",
        {},
        async () => ({}),
        { evidence: "observed" },
      ),
    /has not been observed live/,
  );
});

test("the legacy tools are annotated read-only now that they go through the same door", () => {
  // They used to be registered by intercepting `server.tool`, which set no annotations at all — so
  // a client had no way to know `quote` was safe and `order_buy` was not.
  const server = new McpServer({ name: "stockbit-mcp", version: "test" });
  registerTools(server);
  const tools = (server as unknown as {
    _registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }>;
  })._registeredTools;

  for (const name of ["quote", "broker_summary", "technicals", "analyze", "workflow_run", "scan"]) {
    assert.equal(tools[name].annotations?.readOnlyHint, true, `${name} is a read and should say so`);
  }
});

/* ---------------------------------- instructions ---------------------------------- */

test("the instructions name every write tool, and count them", () => {
  // This sentence used to read "the four order tools and the chartbit_* writes" while twenty-two
  // tools could change something. A hand-written enumeration of a growing set has an expiry date.
  const surface = describeSurface();
  const instructions = buildInstructions(surface);

  for (const name of WRITES) {
    assert.ok(instructions.includes(name), `instructions never mention ${name}`);
  }
  assert.ok(
    instructions.includes(`${WRITES.length} of ${surface.tools.length}`),
    "instructions should say how many of how many can change something",
  );
  assert.ok(instructions.includes("CALL status FIRST"), "the instructions should point a confused client at status");
});

test("describeSurface agrees with a real server, without starting one", () => {
  const server = new McpServer({ name: "stockbit-mcp", version: "test" });
  registerTools(server);
  const live = Object.keys(
    (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
  ).sort();

  const surface = describeSurface();
  assert.deepEqual(
    surface.tools.map((t) => t.name).sort(),
    live,
    "the recorder and the server must see the same surface, or the instructions describe a fiction",
  );
  assert.deepEqual(surface.writes, WRITES);
  assert.deepEqual(surface.skipped, []);
});
