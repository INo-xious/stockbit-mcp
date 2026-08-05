/**
 * Workflow engine: run a named recipe of existing tools as a single call.
 *
 * ## What this is, and what it deliberately is not
 *
 * A workflow is a **declarative list of steps**, each naming a registered tool and its parameters,
 * with values that may reference earlier results. It is not a scripting language and there is no
 * `eval` anywhere in it. That is the whole design constraint: the assistant already composes tools
 * freely turn by turn, so the only thing a workflow adds is *doing it in one call, the same way
 * every time*. The moment it grows arbitrary expressions it stops being reproducible and starts
 * being a worse programming language.
 *
 * So the vocabulary is closed:
 *
 *   - a step names a tool that is actually registered — an unknown name fails before anything runs;
 *   - parameters interpolate `{{input.x}}`, `{{steps.<id>.<path>}}` and `{{item.<path>}}`, resolved
 *     by walking objects, never by executing anything;
 *   - `forEach` fans a step out over an array from an earlier result, with a hard `limit`.
 *
 * ## Failures do not silently vanish
 *
 * A step that throws aborts the run and the result says which step and why — unless it is marked
 * `optional`, in which case its error is recorded and the run continues. The distinction matters
 * because a workflow that swallows a failed step returns a confident-looking report built on a hole,
 * and the user has no way to see it.
 *
 * ## Fan-out is capped and says so
 *
 * `limit` bounds how many items a `forEach` runs, and when it truncates, the result records the
 * count it dropped. Silent truncation reads as "covered everything" when it did not — the same
 * reason `getBars` reports `truncated`.
 */

/** A tool as the workflow runner sees it: a name and something that takes arguments. */
export type ToolInvoker = (args: Record<string, unknown>) => Promise<unknown>;

export interface WorkflowStep {
  /** Referenced by later steps as `steps.<id>`. */
  id: string;
  tool: string;
  params?: Record<string, unknown>;
  /** Path to an array in the context; the step runs once per element. */
  forEach?: string;
  /** Max elements to run when fanning out. Defaults to 5. */
  limit?: number;
  /** A failure here is recorded rather than aborting the run. */
  optional?: boolean;
  /** Shown in the run report so the output reads as a narrative. */
  describe?: string;
}

export interface WorkflowInput {
  name: string;
  required: boolean;
  description: string;
}

export interface Workflow {
  name: string;
  description: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
}

export interface StepResult {
  id: string;
  tool: string;
  describe?: string;
  /** Present when the step ran once. */
  result?: unknown;
  /** Present when the step fanned out. */
  results?: unknown[];
  /** How many items a capped fan-out did not run. */
  skipped?: number;
  error?: string;
  ms: number;
}

export interface WorkflowRun {
  workflow: string;
  input: Record<string, unknown>;
  steps: StepResult[];
  ok: boolean;
  /** Set when the run stopped early. */
  failedAt?: string;
}

/* ------------------------------------ templating ------------------------------------ */

/**
 * Walk a dotted path through plain objects and arrays. Returns undefined rather than throwing.
 *
 * **Own properties only.** A plain `obj[key]` walks the prototype chain, so `{{constructor}}`
 * resolved to `Object` and `{{input.__proto__}}` to a prototype — a template could pull a function
 * or the prototype object into a tool parameter. Nothing here executes it, but a path expression
 * that can reach beyond the data it was given is the wrong shape for something a workflow file
 * controls.
 */
export function resolvePath(context: unknown, path: string): unknown {
  let current: unknown = context;
  for (const key of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const TEMPLATE = /\{\{\s*([A-Za-z0-9_.[\]]+)\s*\}\}/g;

/**
 * Interpolate one value.
 *
 * A string that is *exactly* one template resolves to the referenced value with its type intact —
 * `{{steps.quote.data.price}}` must be able to produce a number, not the string "3020", or every
 * numeric parameter downstream would need re-parsing. Anything else is string interpolation.
 */
export function interpolate(value: unknown, context: unknown): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z0-9_.[\]]+)\s*\}\}$/.exec(value);
    if (whole) return resolvePath(context, whole[1]);
    return value.replace(TEMPLATE, (_, path: string) => {
      const resolved = resolvePath(context, path);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolate(v, context)]),
    );
  }
  return value;
}

/* -------------------------------------- running -------------------------------------- */

export const DEFAULT_FANOUT_LIMIT = 5;

/** Reject a workflow that cannot run, before it runs half of itself. */
export function validateWorkflow(workflow: Workflow, available: Set<string>): void {
  const seen = new Set<string>();
  for (const step of workflow.steps) {
    if (!step.id) throw new Error(`Every step needs an id (workflow ${workflow.name})`);
    if (seen.has(step.id)) throw new Error(`Duplicate step id ${JSON.stringify(step.id)} in ${workflow.name}`);
    seen.add(step.id);
    if (!available.has(step.tool)) {
      throw new Error(
        `Step ${JSON.stringify(step.id)} calls tool ${JSON.stringify(step.tool)}, which is not registered. ` +
          `Available: ${[...available].sort().join(", ")}`,
      );
    }
  }
}

/**
 * Execute a workflow.
 *
 * `invoke` is injected rather than imported so the engine has no dependency on tool registration —
 * which is what makes it testable without standing up an MCP server, and what stops it from
 * quietly gaining the ability to call something that is not a declared tool.
 */
export async function runWorkflow(
  workflow: Workflow,
  input: Record<string, unknown>,
  invoke: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
  now: () => number = () => 0,
): Promise<WorkflowRun> {
  for (const declared of workflow.inputs) {
    if (declared.required && (input[declared.name] === undefined || input[declared.name] === "")) {
      throw new Error(`${workflow.name} requires input ${JSON.stringify(declared.name)}: ${declared.description}`);
    }
  }

  const context: { input: Record<string, unknown>; steps: Record<string, unknown>; item?: unknown } = {
    input,
    steps: {},
  };
  const steps: StepResult[] = [];

  for (const step of workflow.steps) {
    const started = now();
    const base: StepResult = { id: step.id, tool: step.tool, describe: step.describe, ms: 0 };

    try {
      if (step.forEach) {
        const source = resolvePath(context, step.forEach);
        if (!Array.isArray(source)) {
          throw new Error(`forEach path ${JSON.stringify(step.forEach)} did not resolve to an array`);
        }
        const limit = step.limit ?? DEFAULT_FANOUT_LIMIT;
        const chosen = source.slice(0, limit);
        const results: unknown[] = [];
        for (const item of chosen) {
          const args = interpolate(step.params ?? {}, { ...context, item }) as Record<string, unknown>;
          results.push(await invoke(step.tool, args));
        }
        base.results = results;
        // Recorded, never silent: a capped sweep that looks complete is a lie about coverage.
        if (source.length > chosen.length) base.skipped = source.length - chosen.length;
        context.steps[step.id] = results;
      } else {
        const args = interpolate(step.params ?? {}, context) as Record<string, unknown>;
        const result = await invoke(step.tool, args);
        base.result = result;
        context.steps[step.id] = result;
      }
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
      base.ms = now() - started;
      steps.push(base);
      if (step.optional) continue;
      return { workflow: workflow.name, input, steps, ok: false, failedAt: step.id };
    }

    base.ms = now() - started;
    steps.push(base);
  }

  return { workflow: workflow.name, input, steps, ok: steps.every((s) => !s.error) };
}
