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
import { resolveToolProfile } from "../src/tools/_profile.ts";

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
  "login",
  "logout",
  "order_amend",
  "order_buy",
  "order_cancel",
  "order_sell",
  "screener_delete",
  "screener_favorite",
  "screener_save",
  // Not an order tool: it revokes a standing "don't ask again". A write because it changes process
  // state and so must stay out of the workflow handler map, never because it can cost anything.
  "trading_forget",
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
  // Scoped with a declared evidence, because the root definer declares none and a tool that
  // declares none either can no longer register. That refusal is the point of the guard.
  const define = makeDefiner(server, handlers).family("market", { evidence: "observed" });
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
  const define = makeDefiner(server, new Map()).family("market", { evidence: "observed" });
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
  const define = makeDefiner(server, new Map()).family("market", { evidence: "observed" });
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
    .filter((t) => /PENDING VERIFICATION|(has|have) (not|never) been observed/i.test(t.description) && t.evidence !== "projected")
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


test("the order-entry block on the instructions page is true under every shape of profile", () => {
  // None of this was covered. The gating was changed twice in two commits and each change traded
  // one false claim for another, with a green suite both times — so the three states are pinned
  // here, by rendering the real page.
  const page = (raw: string) => {
    const resolved = resolveToolProfile(raw, new Set(describeSurface().tools.map((t) => t.name)));
    return buildInstructions(describeSurface(resolved.profile, resolved.isDefault));
  };

  // 1. A preview is registered -> the protocol, naming the previews that actually exist.
  const eipo = page("eipo");
  assert.match(eipo, /PLACING AN ORDER IS TWO STEPS/, "eipo_order places an order and needs the protocol");
  assert.ok(eipo.includes("eipo_order_preview builds a ticket"), "and it must name the preview it has");
  assert.doesNotMatch(
    eipo,
    /ORDER ENTRY IS NOT REGISTERED/,
    "saying order entry is impossible while eipo_order is registered is a false negative about a money write",
  );
  // An IPO has no auto-rejection band, and its ticket carries no commission and no net. Sharing one
  // sentence between the two previews invented all three.
  const eipoStep = eipo.slice(eipo.indexOf("eipo_order_preview builds a ticket"));
  const eipoLine = eipoStep.slice(0, eipoStep.indexOf("\n"));
  for (const invented of ["commission", "band", "the net"]) {
    assert.ok(!eipoLine.includes(invented), `the e-IPO ticket has no ${invented}: ${eipoLine}`);
  }

  // 2. A write with NO preview -> not the protocol. The write takes a ticket id and nothing else,
  //    and only a preview mints tickets, so this server can describe the protocol perfectly and
  //    still refuse every call.
  const writeOnly = page("core,order_buy");
  assert.doesNotMatch(writeOnly, /PLACING AN ORDER IS TWO STEPS/, "no preview means the protocol cannot be followed");
  assert.match(writeOnly, /CANNOT BE USED/, "and the page has to say why rather than staying silent");

  // 3. Nothing at all -> the remedy has to fix what the claim covers. The claim names e-IPO, so a
  //    remedy of ",trading" alone sends the user to edit a config file and restart for nothing.
  const core = page("core");
  assert.match(core, /ORDER ENTRY IS NOT REGISTERED/);
  const remedy = core.slice(core.indexOf("ORDER ENTRY IS NOT REGISTERED"));
  assert.ok(remedy.includes(",trading"), "equities remedy");
  assert.ok(remedy.includes(",eipo"), "the claim covers e-IPO subscription, so the remedy must too");
});

test("every order-entry write is in the list the instructions page measures against", () => {
  // `ORDER_ENTRY_TOOLS` is hand-written, inside the module whose own header argues that a
  // hand-written enumeration of a growing set is a claim with an expiry date. It cannot be derived
  // (that would make it agree with itself), so it is pinned against WRITES instead: a new order
  // tool added to the trading or eipo family reddens this rather than silently falling outside the
  // page's idea of order entry.
  const orderish = describeSurface()
    .writes.filter((n) => /^(order_|eipo_order)/.test(n))
    .sort();
  // Spelled out, so a sixth one reddens this instead of being quietly absorbed by a regex.
  assert.deepEqual(orderish, ["eipo_order", "order_amend", "order_buy", "order_cancel", "order_sell"]);

  const all = buildInstructions(describeSurface());
  for (const name of orderish) {
    assert.ok(all.includes(name), `${name} is an order-entry write the instructions never name`);
  }
});


/* ------------------------------------------------------------------ *
 * The evidence ladder, spelled out.
 *
 * Same reasoning as WRITES above and the same rule from CLAUDE.md: deriving this list from the code
 * would make the test agree with the code, and agreement is not the property. Evidence is a claim
 * about what somebody actually SAW, so the only honest place for it is a list a human edited.
 *
 * It used to be inferred from the description prose, which failed in both directions at once —
 * `screener_save` widened itself to `read-back` by phrasing its caveat "has NEVER been observed"
 * where the regex knew only "has NOT been observed", and `company_overview` was downgraded to
 * `projected` by a sentence about one field's key names. A tool moving between these three lists is
 * now a deliberate edit in a diff, and moving one UP the ladder takes a live call, not an edit.
 * ------------------------------------------------------------------ */

const OBSERVED = [
  "stream_trending",
  "brokers",
  "broker_top",
  "chart_series",
  "stream_user",
  "status",
  "login",
  "logout",
  "broker_summary",
  "broker_distribution",
  "alert_create",
  "alert_list",
  "alert_delete",
  "alert_check",
  "pine_script",
  "stockbit_web",
  "technicals",
  "price_chart",
  "quote",
  "top_movers",
  "trending",
  "sectors",
  "intraday_prices",
  // Moved up from PROJECTED on 2026-09-01: called live against BBRI and every key its description
  // names — the two TYPE_CHART_* series, the broker lists, the minute grid — was read out of the
  // response. Its docstring used to disclaim knowing its own shape.
  "broker_flow_intraday",
  // Also moved up on 2026-09-01, and this one had never answered AT ALL: it was sending its
  // one-shot token as a query parameter the endpoint does not read. Capturing Stockbit's own
  // request settled the placement, and the chart it then returned is where `series`, the points
  // and the `timeframes` vocabulary were read from.
  "shareholders",
  "price_performance",
  "orderbook",
  "keystats",
  "ratios",
  "financials",
  "sentiment_stream",
  "chart_settings",
  "backtest",
  "strategy_compare",
  "patterns",
  "timeframe_alignment",
  "scan",
  "price_bands",
  "watchlist",
  "screener",
  "analyze",
  "position_size",
  "bandar_detector",
  "chartbit_layouts",
  "chartbit_layout",
  "chartbit_drawings",
  "chartbit_templates",
  "chartbit_layout_save",
  "chartbit_drawings_save",
  "chartbit_layout_delete",
  "chartbit_open",
  "chartbit_draw",
  "chartbit_clear",
  "chartbit_shapes",
  "chartbit_screenshot",
  "chartbit_save",
  "chartbit_study",
  "chartbit_analyze",
  "workflow_list",
  "workflow_run",
  "company_subsidiaries",
  "index_members",
  "symbol_search",
  "classification",
  "corporate_actions",
  "corporate_action_status",
  "dividend_calendar",
  "ipo_pipeline",
  "stream",
  "news",
  "insider_transactions",
  "screener_favorites",
  "screener_finitems",
];

const READ_BACK = [
  "watchlist_create",
  "watchlist_rename",
  "watchlist_delete",
  "watchlist_add",
  "watchlist_remove",
  "watchlist_favorite",
  "screener_save",
  "screener_delete",
  "screener_favorite",
];

const PROJECTED = [
  "analyst_ratings",
  "stream_post_detail",
  "stream_pinned",
  "research",
  "company_overview",
  "company_profile",
  "company_contact",
  "sector_companies",
  "seasonality",
  "earnings",
  "peer_comparison",
  "fundachart",
  "entitlements",
  "insider_ownership",
  "shareholding",
  "ownership_composition",
  "running_trade",
  "trade_book",
  "market_movers",
  "top_stocks",
  "order_queue",
  "market_session",
  "prices_batch",
  "price_market",
  "broker_activity",
  "calendar_today",
  "stock_conversion",
  "underwriters",
  "screener_run",
  "watchlist_symbols",
  "watchlist_search",
  "portfolio",
  "position",
  "cash_balance",
  "orders",
  "order_detail",
  "order_history",
  "trade_performance",
  "trading_info",
  "stock_tradable",
  "account",
  "trading_status",
  "order_preview",
  "order_buy",
  "order_sell",
  "order_amend",
  "order_cancel",
  "trading_forget",
  "eipo_list",
  "eipo_detail",
  "eipo_status",
  "eipo_my_order",
  "eipo_price_groups",
  "eipo_rdn_balance",
  "eipo_unboxing",
  "eipo_order_preview",
  "eipo_order",
];

test("every tool's evidence is exactly what this file says it is", () => {
  const surface = describeSurface();
  const expected = new Map<string, string>();
  for (const n of OBSERVED) expected.set(n, "observed");
  for (const n of READ_BACK) expected.set(n, "read-back");
  for (const n of PROJECTED) expected.set(n, "projected");

  assert.equal(
    expected.size,
    OBSERVED.length + READ_BACK.length + PROJECTED.length,
    "a name appears in two lists",
  );
  assert.equal(surface.tools.length, expected.size, "a tool was added or removed without editing this file");

  const wrong: string[] = [];
  for (const tool of surface.tools) {
    const want = expected.get(tool.name);
    if (want === undefined) wrong.push(`${tool.name}: registered but not listed here`);
    else if (want !== tool.evidence) wrong.push(`${tool.name}: listed ${want}, registered ${tool.evidence}`);
  }
  assert.deepEqual(wrong, []);
});

test("a tool that declares no evidence, in a family that declares none either, cannot register", () => {
  // The old fallback handed such a tool `"observed"` — the STRONGEST claim on the ladder, for
  // saying nothing at all. Silence is not evidence.
  const server = new McpServer({ name: "t", version: "0" });
  const define = makeDefiner(server, new Map()).family("market");
  assert.throws(
    () => define.read("undeclared", "A tool that says nothing about provenance.", {}, async () => ({ content: [] })),
    /declares no evidence/,
  );
});

test("a description that says the route was never observed contradicts any claim above projected", () => {
  const server = new McpServer({ name: "t", version: "0" });
  const define = makeDefiner(server, new Map()).family("market", { evidence: "observed" });

  // "never" — the spelling that used to slip past the guard entirely.
  assert.throws(
    () => define.read("neverseen", "This route has never been observed live.", {}, async () => ({ content: [] })),
    /One of the two is wrong/,
  );
  // and the spelling it always caught
  assert.throws(
    () => define.read("notseen", "This route has not been observed live.", {}, async () => ({ content: [] })),
    /One of the two is wrong/,
  );
  // `projected` agrees with the prose, so it registers.
  assert.doesNotThrow(() =>
    define.read(
      "honest",
      "PENDING VERIFICATION: this route has never been observed live.",
      {},
      async () => ({ content: [] }),
      { evidence: "projected" },
    ),
  );
});

test("a family that registers nothing at all is never named as withheld", () => {
  // `withheldFamilies` is derived from what registration actually FILTERED, not from FAMILIES minus
  // the families present. The two agree on every profile this repo can produce today, because all
  // seventeen families have at least one tool — so only a definer built by hand can tell them
  // apart, and without this test the choice recorded in plan.md has no guard at all.
  //
  // The difference matters the day a family is declared before its tools exist: FAMILIES-minus-
  // present would name it, and send a reader to set `STOCKBIT_TOOLS=<label>,<family>` to register
  // nothing. A family that offered nothing lost nothing.
  const server = new McpServer({ name: "t", version: "0" });
  const define = makeDefiner(server, new Map(), {
    profile: { label: "probe", allows: (family) => family === "market" },
  });
  const kept = define.family("market", { evidence: "observed" });
  const filtered = define.family("chartbit", { evidence: "observed" });
  define.family("pine", { evidence: "observed" }); // declared, registers nothing, offers nothing

  kept.read("kept_one", "A tool the profile allows.", {}, async () => ({ content: [] }));
  filtered.read("dropped_one", "A tool the profile filters out.", {}, async () => ({ content: [] }));

  assert.deepEqual(define.withheldFamilies(), ["chartbit"]);
});

/* ------------------------------------------------------------------ *
 * Claim honesty: what an EMPTY answer is allowed to mean.
 *
 * A description is the only thing a model has when it turns a `rows: []` into a sentence for a
 * person, so one that reads an empty page as history is a defect in the same class as a wrong
 * number. These pin the two readings a 2026-08-31 field report caught being asserted.
 * ------------------------------------------------------------------ */

test("an empty corporate-action page is not described as proof it never happened", () => {
  // DEWA's shares outstanding grew 12.9x since its 2007 listing while rightissue, warrant, bonus,
  // stocksplit, reversesplit, tenderoffer and stock_conversion ALL came back `rows: []`. The feed's
  // window starts years after the listing, so empty is a fact about the window, not about history.
  const byName = new Map(describeSurface().tools.map((t) => [t.name, t.description]));
  for (const name of ["corporate_actions", "stock_conversion"]) {
    const description = byName.get(name) ?? "";
    assert.doesNotMatch(description, /issuer (that )?has never/i, `${name} still reads an empty page as "never"`);
    assert.match(description, /PERIOD THIS FEED COVERS/, `${name} must scope empty to the covered period`);
  }
});

test("the warrant action kind says whose warrant it means, so empty is not read as none exist", () => {
  // `corporate_actions(action_type:"warrant")` covers warrants the ISSUER distributed. DEWA has
  // five listed structured call warrants issued by four securities houses, and no route here links
  // one to its underlying — so the two together answered "does DEWA have warrants" with "no".
  const description = describeSurface().tools.find((t) => t.name === "corporate_actions")?.description ?? "";
  assert.match(description, /structured/i, "the other instrument class must be named, not implied");
  assert.match(description, /not evidence/i, "and what an empty list does NOT settle");
});

test("chartbit_save says the save and the check ride different credentials", () => {
  // The save runs in the chart page on the website session; the check is a REST read on the `main`
  // token domain (src/http/routes/exodus.ts, `chartbitDrawings`, auth: "main"). A field report hit
  // both failure spellings — a 400 from the read and a `main` refresh 401 — on a save that had
  // demonstrably worked, and nothing in the description said the two could fail independently.
  const description = describeSurface().tools.find((t) => t.name === "chartbit_save")?.description ?? "";
  assert.match(description, /website session/i, "the save side's credential must be named");
  assert.match(description, /`main` token domain/, "and the check side's, in CONTEXT.md's words");
  assert.match(description, /verifyError/, "and the field that carries the failure");
});
