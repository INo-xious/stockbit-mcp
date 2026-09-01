/**
 * `STOCKBIT_TOOLS` — what a filtered server registers, and what it refuses to do quietly.
 *
 * The failure this file guards against is not "the wrong tools were registered". It is the softer
 * one: a typo that silently registers everything, or a `core` profile that names a tool which was
 * renamed two commits ago and therefore is not in `core` any more even though the list still says
 * it is. Both look like the server working.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-profile-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CORE_TOOLS, CORE_CAP, parseToolProfile } from "../src/tools/_profile.ts";
import { FAMILIES } from "../src/tools/_define.ts";
import { describeSurface } from "../src/tools/surface.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

const ALL = describeSurface();
const ALL_NAMES = new Set(ALL.tools.map((t) => t.name));

test("every name in CORE_TOOLS is a tool that actually exists", () => {
  // A rename that left a dangling entry would quietly drop that tool from `core` — the profile most
  // users run — and nothing else would notice.
  const dangling = CORE_TOOLS.filter((name) => !ALL_NAMES.has(name));
  assert.deepEqual(dangling, []);
});

test("core stays inside its declared cap, and the cap stays inside a client's", () => {
  // The title used to say "fits under Cursor's cap, which is the reason it exists". That stopped
  // being true when CORE_CAP went to 41 for `market_movers`, and a test whose name asserts an
  // invariant it no longer checks is worse than no test — it reads as coverage.
  //
  // So the two properties are now separate. The first is that `core` respects whatever ceiling this
  // project has declared for it. The second is that the ceiling is still a CLIENT-shaped number
  // rather than something that drifted: 41 is one over Cursor and well under VS Code's 128, and a
  // core that sailed past every client's limit would have no reason to exist at all.
  assert.ok(CORE_TOOLS.length <= CORE_CAP, `core has ${CORE_TOOLS.length} tools, cap is ${CORE_CAP}`);
  assert.ok(CORE_TOOLS.length >= 30, "a core so small it cannot answer anything is not a profile");
  assert.ok(CORE_CAP <= 128, `core must still fit a real client's cap; ${CORE_CAP} does not fit VS Code`);
  assert.equal(new Set(CORE_TOOLS).size, CORE_TOOLS.length, "a duplicate would waste one of the 41");
});

test("core includes status, and deliberately excludes the order writes", () => {
  assert.ok(CORE_TOOLS.includes("status"), "the tool that explains everything else must be in every profile");
  for (const name of ["order_buy", "order_sell", "order_amend", "order_cancel", "eipo_order"]) {
    assert.ok(!CORE_TOOLS.includes(name), `${name} must be opted into, not defaulted into`);
  }
});

test("an empty, absent or 'all' value filters nothing", () => {
  for (const raw of [undefined, "", "   ", "all", "ALL"]) {
    const profile = parseToolProfile(raw);
    assert.equal(profile.label, "all", `${JSON.stringify(raw)} should mean everything`);
    assert.equal(describeSurface(profile).skipped.length, 0);
  }
});

test("core registers exactly the core list, plus system which is never filtered", () => {
  const surface = describeSurface(parseToolProfile("core"));
  const registered = new Set(surface.tools.map((t) => t.name));

  for (const name of CORE_TOOLS) assert.ok(registered.has(name), `core should register ${name}`);
  for (const name of ["status", "login", "logout"]) {
    assert.ok(registered.has(name), `${name} is in the system family and must survive any profile`);
  }
  assert.equal(registered.size, CORE_TOOLS.length, "core registered something that is not in the list");
  assert.equal(surface.skipped.length, ALL.tools.length - CORE_TOOLS.length);
});

test("a family list registers those families and the system family, and nothing else", () => {
  const surface = describeSurface(parseToolProfile("trading,market"));
  const families = new Set(surface.tools.map((t) => t.family));
  assert.deepEqual([...families].sort(), ["market", "system", "trading"]);

  const skippedFamilies = new Set(surface.skipped.map((name) => ALL.tools.find((t) => t.name === name)?.family));
  assert.ok(!skippedFamilies.has("trading"));
  assert.ok(!skippedFamilies.has("market"));
  assert.ok(skippedFamilies.has("chartbit"), "a family not named should be filtered out");
});

test("individual tool names can be mixed with families", () => {
  const surface = describeSurface(parseToolProfile("bandarmology,quote,analyze"));
  const registered = new Set(surface.tools.map((t) => t.name));
  assert.ok(registered.has("quote"));
  assert.ok(registered.has("analyze"));
  assert.ok(registered.has("broker_summary"), "the whole bandarmology family");
  assert.ok(!registered.has("financials"));
  assert.ok(registered.has("status"), "system survives");
});

test("system is never filtered out, even by a profile that names no families at all", () => {
  const surface = describeSurface(parseToolProfile("quote"));
  const registered = surface.tools.map((t) => t.name).sort();
  assert.deepEqual(registered, ["login", "logout", "quote", "status"]);
});

test("an unknown token throws, and the message lists every family", () => {
  assert.throws(
    () => parseToolProfile("bandar", ALL_NAMES),
    (err: Error) => {
      assert.match(err.message, /unknown family or tool "bandar"/);
      for (const family of FAMILIES) assert.ok(err.message.includes(family), `message omits ${family}`);
      return true;
    },
  );
});

test("an unknown tool name is caught too, when the real tool list is supplied", () => {
  // Without `knownTools` a bare name is accepted as a tool: `parseToolProfile` must not depend on
  // registration, or `describeSurface` could not use it. `bin/stockbit-mcp.ts` supplies the set.
  assert.doesNotThrow(() => parseToolProfile("quotte"));
  assert.throws(() => parseToolProfile("quotte", ALL_NAMES), /unknown family or tool "quotte"/);
});

test("whitespace and case are forgiven; a stray comma is not an error", () => {
  const profile = parseToolProfile(" Market , , BANDARMOLOGY ", ALL_NAMES);
  const families = new Set(describeSurface(profile).tools.map((t) => t.family));
  assert.deepEqual([...families].sort(), ["bandarmology", "market", "system"]);
});

test("a profile that excludes the workflows family does not register workflow_run at all", () => {
  const surface = describeSurface(parseToolProfile("market"));
  const registered = new Set(surface.tools.map((t) => t.name));
  assert.ok(!registered.has("workflow_run"), "workflow_run belongs to the workflows family");
  assert.ok(!registered.has("workflow_list"));
  assert.ok(surface.skipped.includes("workflow_run"), "and it is reported as skipped, not lost");
});

test("workflow_run under a partial profile names the disabled tool and its family", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerTools } = await import("../src/tools/register.ts");

  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      cb: (a: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>,
    ) => {
      handlers.set(name, cb);
    },
  } as unknown as InstanceType<typeof McpServer>;

  // `workflows` and `market` are in; `analysis` and `bandarmology` are not, so `deep_dive` cannot run.
  registerTools(server, { profile: parseToolProfile("workflows,market") });
  const run = handlers.get("workflow_run");
  assert.ok(run);

  const result = await run({ name: "deep_dive", input: { symbol: "BBRI" } });
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /disabled by STOCKBIT_TOOLS=workflows,market/);
  assert.match(text, /technicals|broker_distribution/);
  assert.match(text, /STOCKBIT_TOOLS=workflows,market,(analysis|bandarmology)/, "it must give the value to set");
  assert.match(text, /`(analysis|bandarmology)` family/);
});

test("under the DEFAULT profile the same message does not blame a variable nobody set", async () => {
  // This message now reaches ordinary users: `core` is the default, and `pine_script` is not in it,
  // so `pine_handoff` hits this path for anyone who runs it without configuring anything. Telling
  // them a variable is "disabling" a tool sends them looking for it in a config file they may not
  // own — and the old text also told them to unset it, which under a default changes nothing.
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerTools } = await import("../src/tools/register.ts");

  const handlers = new Map<string, (a: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>>();
  const server = {
    registerTool: (
      name: string,
      _config: unknown,
      cb: (a: Record<string, unknown>) => Promise<{ content: { text?: string }[] }>,
    ) => {
      handlers.set(name, cb);
    },
  } as unknown as InstanceType<typeof McpServer>;

  registerTools(server, { profile: parseToolProfile("core"), profileIsDefault: true });
  const run = handlers.get("workflow_run");
  assert.ok(run, "workflow_run is in core, so the prompt-facing tool exists");

  const result = await run({ name: "pine_handoff", input: { symbol: "BBRI" } });
  const text = result.content.map((c) => c.text ?? "").join("\n");
  assert.match(text, /pine_script/, "it must name the tool that is missing");
  assert.match(text, /which is the default/, "and say the profile was not chosen by the user");
  assert.doesNotMatch(text, /disabled by STOCKBIT_TOOLS/, "nobody set STOCKBIT_TOOLS");
  assert.match(text, /STOCKBIT_TOOLS=core,pine/, "and it must give the exact value that fixes it");
});

test("withheldFamilies names the families with NOTHING registered, and only those", () => {
  const core = describeSurface(parseToolProfile("core"), true);
  const withheld = new Set(core.withheldFamilies);

  // The property, stated directly rather than as a fixed list: a family is withheld exactly when it
  // lost at least one tool and kept none.
  const kept = new Set(core.tools.map((t) => t.family));
  const lost = new Set(ALL.tools.filter((t) => !core.tools.some((c) => c.name === t.name)).map((t) => t.family));
  assert.deepEqual([...withheld].sort(), [...lost].filter((f) => !kept.has(f)).sort());

  // The case that made this necessary, and the case that would make it lie.
  assert.ok(withheld.has("chartbit"), "core registers none of chartbit's tools");
  assert.equal(
    withheld.has("trading"),
    false,
    "core keeps five trading tools, so telling a user to add `trading` would add nothing",
  );

  assert.deepEqual(ALL.withheldFamilies, [], "the unfiltered surface withholds nothing");

  // The remaining half of the property — that a family which registers NOTHING is never named — is
  // pinned in test/tools.test.ts ("a family that registers nothing at all is never named as
  // withheld"), not here. It cannot be tested against the real surface: every one of the seventeen
  // families has at least one tool today, so the derivation this repo uses and the FAMILIES-minus-
  // present one it rejects agree on every profile, and an assertion written here would iterate over
  // an empty list and pin nothing.
  assert.equal(
    FAMILIES.filter((f) => !ALL.tools.some((t) => t.family === f)).length,
    0,
    "if this ever fails, a family has no tools and the note above needs revisiting",
  );
});
