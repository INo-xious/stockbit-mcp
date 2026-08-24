/**
 * The eight built-in workflows, offered as MCP prompts.
 *
 * `workflow_run` already runs them, so this adds no capability. What it adds is *discovery and
 * presentation*, and both matter more than they sound.
 *
 * Discovery: a prompt is something the user picks from a menu in their client — a slash command in
 * Claude Code, an attachment button in Claude Desktop. A tool is something a model finds if it
 * happens to read far enough down a list of 137 descriptions. "Do the morning scan" should not
 * depend on the second thing.
 *
 * Presentation: a workflow returns a pile of step results, and how those get read to a person is
 * where the value is or is not delivered. `bandar_watch` returns net flow per broker; whether the
 * answer says "ZP accumulated 801,071 lots net" or "several brokers were active" is the difference
 * between the tool being useful and being noise. So each prompt carries the specific guidance for
 * *that* workflow — what to lead with, which caveat is load-bearing, and what must not be invented.
 *
 * ## Why the prompt text tells the model to call a tool
 *
 * A prompt in MCP returns messages, not results. The model reads them and decides what to do. So
 * the text says, in words: call `workflow_run` with this name and this input, then present it like
 * so. That keeps one implementation of each recipe rather than a second copy living in prose.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BUILTIN_WORKFLOWS } from "./workflows/builtin.js";
import type { Workflow } from "./workflows/run.js";
import type { ToolProfile } from "./tools/_define.js";

/**
 * How to read each workflow's output back to a person.
 *
 * One entry per built-in. A workflow with no entry still gets a prompt — the generic instructions
 * below apply — but it is worth writing one: this is where the domain knowledge that makes an
 * answer trustworthy actually lives.
 */
const PRESENTATION: Record<string, string> = {
  deep_dive:
    "Lead with the quote and the technical state in one or two sentences, then who was on each side " +
    "of the tape. Quote the `confidence` value and name any MISSING pillars rather than averaging " +
    "over them. Give the chart path so the user can open it.",
  morning_scan:
    "Separate the movers that have nothing behind them from the ones breaking out — that separation " +
    "is the whole point of the scan, and a ranked list of percentage gainers is not it. Note the " +
    "market session: before the open, yesterday's movers are what you are looking at.",
  bandar_watch:
    "Say whether the numbers are NET or GROSS and which board they came from — they differ, and a " +
    "reader who assumes the wrong one draws the opposite conclusion. If the stock is floor-locked " +
    "on ARB, say so: flow in a stock nobody can sell out of carries no signal.",
  alert_sweep:
    "Say what fired and, for each one, the condition and the value that satisfied it. An alert " +
    "reported without the number that triggered it is not actionable. If nothing fired, say that " +
    "plainly — it is an answer.",
  pine_handoff:
    "Return the script itself and name the levels it embeds, so the user can see what they are " +
    "pasting into TradingView before they paste it.",
  strategy_check:
    "Quote the `warnings` verbatim. `inconclusive` is an answer, not a failure — on two years of " +
    "daily bars a walk-forward usually reaches it, and reporting a result that did not survive " +
    "out-of-sample as if it had is the failure mode this workflow exists to avoid.",
  screen_and_dive:
    "Name the screen that was run and how many symbols survived it, then take the survivors one at " +
    "a time. A list of tickers with no reading attached is what the user could already get.",
  portfolio_review:
    "Never invent a holding. Work only from what `portfolio` returned; if `cash_balance` or any " +
    "other step failed, say which one and what is therefore missing from the picture.",
};

/** The instructions every prompt carries, whatever the workflow. */
const ALWAYS =
  "Always say what could not be read: a step that failed, a field that came back unmapped, a number " +
  "that is projected rather than observed. This is not investment advice.";

/** Build the user-message text for one workflow and one set of arguments. */
export function promptText(workflow: Workflow, args: Record<string, string | undefined>): string {
  const supplied = Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== undefined && v !== ""),
  );
  const input = JSON.stringify(supplied);
  const presentation = PRESENTATION[workflow.name];

  return (
    `Call \`workflow_run\` with \`name: ${JSON.stringify(workflow.name)}\` and \`input: ${input}\`.\n\n` +
    `${workflow.description}\n\n` +
    `Present the result: ${presentation ? `${presentation} ` : ""}${ALWAYS}`
  );
}

/**
 * Register one prompt per built-in workflow.
 *
 * Skipped entirely when a profile has filtered out the `workflows` family: a prompt whose first
 * instruction is to call a tool that is not registered would be a menu entry that always fails.
 */
export function registerWorkflowPrompts(server: McpServer, profile?: ToolProfile): number {
  if (profile && !profile.allows("workflows", "workflow_run")) return 0;

  for (const workflow of BUILTIN_WORKFLOWS) {
    const message = (args: Record<string, string | undefined>) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: promptText(workflow, args) },
        },
      ],
    });

    // A workflow with no inputs must be registered WITHOUT an argument schema. Declaring an empty
    // one makes the SDK validate `arguments` as a required object, so a client that sends none —
    // which is the correct thing for a prompt that takes none — gets "expected object, received
    // undefined" instead of the prompt.
    if (workflow.inputs.length === 0) {
      server.registerPrompt(
        workflow.name,
        { title: titleFor(workflow.name), description: workflow.description },
        () => message({}),
      );
      continue;
    }

    const argsSchema: Record<string, z.ZodType<string | undefined>> = {};
    for (const input of workflow.inputs) {
      // MCP prompt arguments are strings on the wire — there is no number type in the protocol —
      // so a numeric input like `bars` arrives as "200" and `workflow_run`'s own schema coerces it.
      const field = z.string().describe(input.description);
      argsSchema[input.name] = input.required ? field : field.optional();
    }

    server.registerPrompt(
      workflow.name,
      { title: titleFor(workflow.name), description: workflow.description, argsSchema },
      (args: Record<string, string | undefined>) => message(args ?? {}),
    );
  }

  return BUILTIN_WORKFLOWS.length;
}

/** `deep_dive` reads as a slug in a menu; "Deep dive" reads as a thing to click. */
function titleFor(name: string): string {
  const words = name.split("_");
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}
