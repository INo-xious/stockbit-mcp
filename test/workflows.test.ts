import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FANOUT_LIMIT,
  interpolate,
  resolvePath,
  runWorkflow,
  validateWorkflow,
  type Workflow,
} from "../src/workflows/run.ts";
import { BUILTIN_WORKFLOWS, findWorkflow } from "../src/workflows/builtin.ts";

/** Records what was invoked, so a test asserts the calls rather than the narrative around them. */
function recorder(responses: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const invoke = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    const response = responses[tool];
    if (typeof response === "function") return (response as (a: Record<string, unknown>) => unknown)(args);
    if (response === undefined) throw new Error(`no stub for ${tool}`);
    return response;
  };
  return { calls, invoke };
}

const AVAILABLE = new Set(["quote", "technicals", "price_chart", "broker_summary", "alert_check", "top_movers"]);

/* ------------------------------------ templating ------------------------------------ */

test("a whole-string template keeps the referenced value's TYPE", () => {
  // "{{steps.quote.price}}" must be able to produce a number. If it stringified, every numeric
  // parameter downstream would need re-parsing, and a zod number would reject "3020".
  const context = { steps: { quote: { price: 3020, tags: ["a", "b"] } } };
  assert.equal(interpolate("{{steps.quote.price}}", context), 3020);
  assert.deepEqual(interpolate("{{steps.quote.tags}}", context), ["a", "b"]);
});

test("a template inside a longer string interpolates as text", () => {
  const context = { input: { symbol: "BBRI" } };
  assert.equal(interpolate("chart for {{input.symbol}} today", context), "chart for BBRI today");
});

test("an unresolved template becomes undefined, not the literal braces", () => {
  // A parameter that arrives as the string "{{input.bars}}" would be sent to the API verbatim.
  assert.equal(interpolate("{{input.missing}}", { input: {} }), undefined);
  assert.equal(interpolate("value: {{input.missing}}", { input: {} }), "value: ");
});

test("templates resolve inside nested objects and arrays", () => {
  const out = interpolate(
    { symbol: "{{input.s}}", panels: ["rsi"], nested: { deep: ["{{input.s}}", 2] } },
    { input: { s: "TLKM" } },
  );
  assert.deepEqual(out, { symbol: "TLKM", panels: ["rsi"], nested: { deep: ["TLKM", 2] } });
});

test("resolvePath walks arrays and stops safely at a missing branch", () => {
  const context = { steps: { movers: { results: [{ symbol: "BBRI" }, { symbol: "TLKM" }] } } };
  assert.equal(resolvePath(context, "steps.movers.results.1.symbol"), "TLKM");
  assert.equal(resolvePath(context, "steps.movers.results.9.symbol"), undefined);
  assert.equal(resolvePath(context, "steps.nothing.at.all"), undefined);
});

test("SECURITY: templating resolves paths, it does not evaluate anything", () => {
  // The engine must never gain an expression evaluator; a workflow is data, not code.
  const context = { input: { x: 1 } };
  assert.equal(interpolate("{{constructor}}", context), undefined);
  assert.equal(interpolate("{{input.__proto__}}", context), undefined);
  assert.equal(interpolate("{{process.env.HOME}}", context), undefined);
});

/* ------------------------------------ validation ------------------------------------ */

test("a workflow naming a tool that is not registered fails before anything runs", () => {
  const workflow: Workflow = {
    name: "bad", description: "", inputs: [],
    steps: [{ id: "a", tool: "quote" }, { id: "b", tool: "no_such_tool" }],
  };
  assert.throws(() => validateWorkflow(workflow, AVAILABLE), /not registered/);
  assert.throws(() => validateWorkflow(workflow, AVAILABLE), /Available:/);
});

test("duplicate step ids are rejected, since the second would overwrite the first's result", () => {
  const workflow: Workflow = {
    name: "dup", description: "", inputs: [],
    steps: [{ id: "a", tool: "quote" }, { id: "a", tool: "technicals" }],
  };
  assert.throws(() => validateWorkflow(workflow, AVAILABLE), /Duplicate step id/);
});

test("a missing required input is refused with the input's own description", async () => {
  const workflow: Workflow = {
    name: "needs", description: "",
    inputs: [{ name: "symbol", required: true, description: "IDX ticker" }],
    steps: [{ id: "q", tool: "quote", params: { symbol: "{{input.symbol}}" } }],
  };
  const { invoke, calls } = recorder({ quote: {} });
  await assert.rejects(() => runWorkflow(workflow, {}, invoke), /requires input "symbol": IDX ticker/);
  assert.equal(calls.length, 0, "nothing should run when an input is missing");
});

/* -------------------------------------- running -------------------------------------- */

test("steps run in order and later steps see earlier results", async () => {
  const workflow: Workflow = {
    name: "chain", description: "",
    inputs: [{ name: "symbol", required: true, description: "" }],
    steps: [
      { id: "quote", tool: "quote", params: { symbol: "{{input.symbol}}" } },
      { id: "chart", tool: "price_chart", params: { symbol: "{{input.symbol}}", ref: "{{steps.quote.data.price}}" } },
    ],
  };
  const { invoke, calls } = recorder({ quote: { data: { price: 3020 } }, price_chart: { ok: true } });
  const run = await runWorkflow(workflow, { symbol: "BBRI" }, invoke);

  assert.equal(run.ok, true);
  assert.deepEqual(calls.map((c) => c.tool), ["quote", "price_chart"]);
  assert.deepEqual(calls[1].args, { symbol: "BBRI", ref: 3020 }, "the chart step should see the quote's price");
  assert.equal(run.steps[0].result !== undefined, true);
});

test("forEach fans a step out over an earlier result", async () => {
  const workflow: Workflow = {
    name: "sweep", description: "", inputs: [],
    steps: [
      { id: "movers", tool: "top_movers" },
      { id: "readings", tool: "technicals", forEach: "steps.movers.data.results", params: { symbol: "{{item.symbol}}" } },
    ],
  };
  const { invoke, calls } = recorder({
    top_movers: { data: { results: [{ symbol: "BBRI" }, { symbol: "TLKM" }, { symbol: "GOTO" }] } },
    technicals: (args) => ({ symbol: args.symbol }),
  });
  const run = await runWorkflow(workflow, {}, invoke);

  assert.equal(run.ok, true);
  assert.deepEqual(calls.slice(1).map((c) => c.args.symbol), ["BBRI", "TLKM", "GOTO"]);
  assert.equal(run.steps[1].results?.length, 3);
});

test("a capped fan-out REPORTS what it skipped instead of looking complete", async () => {
  // Silent truncation reads as "covered everything" when it did not.
  const workflow: Workflow = {
    name: "capped", description: "", inputs: [],
    steps: [
      { id: "movers", tool: "top_movers" },
      { id: "readings", tool: "technicals", forEach: "steps.movers.data.results", limit: 2, params: { symbol: "{{item.symbol}}" } },
    ],
  };
  const { invoke, calls } = recorder({
    top_movers: { data: { results: [1, 2, 3, 4, 5].map((n) => ({ symbol: `S${n}` })) } },
    technicals: {},
  });
  const run = await runWorkflow(workflow, {}, invoke);

  assert.equal(run.steps[1].results?.length, 2);
  assert.equal(run.steps[1].skipped, 3, "three items were not run and the result must say so");
  assert.equal(calls.length, 3, "the cap must actually stop the calls, not just the reporting");
});

test("fan-out has a default cap, so an unbounded list cannot run away", async () => {
  const workflow: Workflow = {
    name: "uncapped", description: "", inputs: [],
    steps: [
      { id: "movers", tool: "top_movers" },
      { id: "readings", tool: "technicals", forEach: "steps.movers.data.results", params: {} },
    ],
  };
  const many = Array.from({ length: 50 }, (_, i) => ({ symbol: `S${i}` }));
  const { invoke } = recorder({ top_movers: { data: { results: many } }, technicals: {} });
  const run = await runWorkflow(workflow, {}, invoke);

  assert.equal(run.steps[1].results?.length, DEFAULT_FANOUT_LIMIT);
  assert.equal(run.steps[1].skipped, 50 - DEFAULT_FANOUT_LIMIT);
});

test("forEach over something that is not an array is an error, not an empty pass", async () => {
  const workflow: Workflow = {
    name: "notarray", description: "", inputs: [],
    steps: [
      { id: "quote", tool: "quote" },
      { id: "x", tool: "technicals", forEach: "steps.quote.data.price", params: {} },
    ],
  };
  const { invoke } = recorder({ quote: { data: { price: 3020 } }, technicals: {} });
  const run = await runWorkflow(workflow, {}, invoke);

  assert.equal(run.ok, false);
  assert.equal(run.failedAt, "x");
  assert.match(run.steps[1].error!, /did not resolve to an array/);
});

/* ------------------------------------- failures ------------------------------------- */

test("a failing step ABORTS the run and names itself", async () => {
  const workflow: Workflow = {
    name: "fails", description: "", inputs: [],
    steps: [
      { id: "quote", tool: "quote" },
      { id: "boom", tool: "technicals" },
      { id: "never", tool: "price_chart" },
    ],
  };
  const { invoke, calls } = recorder({
    quote: { ok: true },
    technicals: () => {
      throw new Error("upstream exploded");
    },
    price_chart: {},
  });
  const run = await runWorkflow(workflow, {}, invoke);

  assert.equal(run.ok, false);
  assert.equal(run.failedAt, "boom");
  assert.match(run.steps[1].error!, /upstream exploded/);
  assert.equal(calls.some((c) => c.tool === "price_chart"), false, "steps after a failure must not run");
});

test("an optional step records its failure and the run continues", async () => {
  // broker_distribution is gated behind a Rp 10m balance; a deep dive is still worth having
  // without it, and aborting would throw away the steps that succeeded.
  const workflow: Workflow = {
    name: "optional", description: "", inputs: [],
    steps: [
      { id: "quote", tool: "quote" },
      { id: "gated", tool: "broker_summary", optional: true },
      { id: "after", tool: "price_chart" },
    ],
  };
  const { invoke, calls } = recorder({
    quote: { ok: true },
    broker_summary: () => {
      throw new Error("403 forbidden");
    },
    price_chart: { ok: true },
  });
  const run = await runWorkflow(workflow, {}, invoke);

  assert.equal(run.ok, false, "the run is not clean — the failure must remain visible");
  assert.equal(run.failedAt, undefined, "but it did not abort");
  assert.match(run.steps[1].error!, /403/);
  assert.equal(calls.some((c) => c.tool === "price_chart"), true, "later steps still ran");
});

/* ------------------------------------- built-ins ------------------------------------- */

test("every built-in workflow is internally consistent", () => {
  const registered = new Set([
    "quote", "technicals", "price_chart", "broker_summary", "broker_distribution",
    "alert_check", "top_movers", "pine_script",
  ]);
  for (const workflow of BUILTIN_WORKFLOWS) {
    assert.doesNotThrow(() => validateWorkflow(workflow, registered), `${workflow.name} is invalid`);
    assert.ok(workflow.description.length > 20, `${workflow.name} needs a real description`);
    for (const step of workflow.steps) {
      // A forEach must point at a step that already ran, or it can never resolve.
      if (step.forEach) {
        const match = /^steps\.([A-Za-z0-9_]+)/.exec(step.forEach);
        assert.ok(match, `${workflow.name}.${step.id} forEach must reference a step`);
        const priorIds = workflow.steps.slice(0, workflow.steps.indexOf(step)).map((s) => s.id);
        assert.ok(priorIds.includes(match[1]), `${workflow.name}.${step.id} fans out over a step that has not run`);
      }
    }
  }
});

test("every template in a built-in references a declared input or an earlier step", () => {
  // A typo here produces an undefined parameter at run time, which is exactly the kind of silent
  // wrong behaviour that is hard to notice in a multi-step result.
  for (const workflow of BUILTIN_WORKFLOWS) {
    const inputs = new Set(workflow.inputs.map((i) => i.name));
    workflow.steps.forEach((step, index) => {
      const priorIds = new Set(workflow.steps.slice(0, index).map((s) => s.id));
      for (const [, path] of JSON.stringify(step.params ?? {}).matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)) {
        const [root, first] = path.split(".");
        if (root === "input") {
          assert.ok(inputs.has(first), `${workflow.name}.${step.id} uses undeclared input ${first}`);
        } else if (root === "steps") {
          assert.ok(priorIds.has(first), `${workflow.name}.${step.id} references step ${first} before it runs`);
        } else {
          assert.equal(root, "item", `${workflow.name}.${step.id} has an unknown template root ${root}`);
          assert.ok(step.forEach, `${workflow.name}.${step.id} uses {{item}} without forEach`);
        }
      }
    });
  }
});

test("findWorkflow finds by exact name and refuses anything else", () => {
  assert.equal(findWorkflow("deep_dive")?.name, "deep_dive");
  assert.equal(findWorkflow("DEEP_DIVE"), undefined);
  assert.equal(findWorkflow("nope"), undefined);
});
