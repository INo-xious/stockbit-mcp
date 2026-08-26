/**
 * `docs/TOOLS.md`, generated from the server rather than written by hand.
 *
 * A 138-row reference maintained by hand is a reference that is wrong. The old README listed about
 * fifty of them and omitted `analyze`, which is the single most useful tool here; the MCP
 * `instructions` claimed four write tools while twenty-two existed. Both were true when written.
 *
 * So this asks a real server — over an in-memory transport, exactly as a client would — what it
 * registered, and renders that. The committed file is checked against a fresh render by
 * `test/toolsdoc.test.ts`, so a description edited without regenerating fails CI rather than
 * quietly making the documentation a historical artefact.
 *
 * ## Deterministic
 *
 * No timestamps, no counts that depend on when it ran, no iteration over an unordered map. Two
 * renders of the same tree produce byte-identical output, or the freshness test would fail at
 * random and teach everyone to ignore it.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";
import { DEFAULT_TOOL_PROFILE, parseToolProfile } from "./tools/_profile.js";
import { describeSurface } from "./tools/surface.js";
import { promptsForSurface } from "./prompts.js";
import { FAMILIES, EVIDENCE_META_KEY, FAMILY_META_KEY, type Evidence, type Family } from "./tools/_define.js";

/** One line per family, so the table of contents says what each is for. */
const FAMILY_COVERS: Record<Family, string> = {
  system: "Is this working, and what do I run — plus logging in and out",
  market: "Prices, depth, movers, bars, the session clock",
  bandarmology: "Who accumulated and who distributed. The data no other market API has",
  analysis: "Indicators, patterns, backtests, scans, charts, position sizing",
  company: "Profile, ownership, management, peers, ratings",
  fundamentals: "Key statistics, ratios, financial statements, seasonality",
  insider: "Insider and affiliate transactions",
  corpaction: "Dividends, splits, rights, the corporate calendar",
  stream: "Posts, news and research from Stockbit's own feed",
  screener: "Stockbit's screener — the catalogue, the presets, and running one",
  account: "The user's watchlists and saved screens, and editing them",
  chartbit: "Reading and drawing on the user's real chart, in their own browser",
  alerts: "Rules that fire while no client is open",
  pine: "TradingView Pine Script generation",
  workflows: "Saved multi-step recipes, also offered as prompts",
  trading: "The brokerage account and order entry",
  eipo: "The IPO pipeline and subscribing to one",
};

const EVIDENCE_LABEL: Record<Evidence, string> = {
  observed: "Observed",
  "read-back": "Read-back",
  projected: "Projected",
};

interface Row {
  name: string;
  family: Family;
  evidence: Evidence;
  kind: string;
  whenToUse: string;
  inputs: string;
}

/**
 * Escape a Markdown table cell.
 *
 * Both metacharacters are escaped in a SINGLE pass over one character class, and that is the whole
 * point. Chained replaces — backslashes, then pipes — are correct only in that order, and a later
 * reader reordering them for tidiness would silently reintroduce the bug: escaping `|` first turns
 * `a\|b` into `a\\|b`, and doubling the backslashes afterwards produces `a\\\\|b`, an escaped
 * backslash followed by a live pipe that breaks the row. One pass cannot be reordered, and never
 * looks at a character it has already written.
 */
export function escapeMarkdownTableCell(value: string): string {
  return value
    .replace(/[\\|]/g, (metacharacter) => `\\${metacharacter}`)
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/**
 * The first sentence of a description, capped.
 *
 * A tool reference is a thing people scan, and these descriptions are written for a model — several
 * hundred words apiece, with the caveats that matter at call time. The first sentence is the part
 * that answers "when would I use this"; the rest is in the tool itself, where the model reads it.
 */
function whenToUse(description: string, max = 160): string {
  const first = description.split(/(?<=\.)\s|\n/)[0]?.trim() ?? description;
  return first.length <= max ? first : `${first.slice(0, max - 1).trimEnd()}…`;
}

function kindOf(annotations: Record<string, unknown> | undefined): string {
  if (annotations?.readOnlyHint === true) return "read";
  return annotations?.destructiveHint === true ? "write, destructive" : "write";
}

/** Render the whole reference. Async because it stands up a server and asks it. */
export async function renderToolsDoc(): Promise<string> {
  const server = createServer({ profile: parseToolProfile("all") });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stockbit-toolsdoc", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  try {
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();

    const rows: Row[] = tools.map((tool) => {
      const meta = (tool._meta ?? {}) as Record<string, unknown>;
      const shape = (tool.inputSchema ?? {}) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const required = new Set(shape.required ?? []);
      const inputs = Object.keys(shape.properties ?? {})
        .map((name) => (required.has(name) ? `${name}*` : name))
        .join(", ");
      return {
        name: tool.name,
        family: (meta[FAMILY_META_KEY] as Family) ?? "system",
        evidence: (meta[EVIDENCE_META_KEY] as Evidence) ?? "projected",
        kind: kindOf(tool.annotations as Record<string, unknown> | undefined),
        whenToUse: whenToUse(tool.description ?? ""),
        inputs: inputs || "—",
      };
    });

    const reads = rows.filter((r) => r.kind === "read").length;
    const writes = rows.length - reads;
    // FAMILIES order, not registration order or alphabetical: it is roughly the order someone
    // learns them in, and it is stable across refactors of the registration file.
    const present = FAMILIES.filter((family) => rows.some((r) => r.family === family));

    const out: string[] = [];
    out.push("<!-- GENERATED by `npm run docs:tools` — do not edit. -->");
    out.push("");
    out.push("# Tool reference");
    out.push("");
    out.push(
      `**${rows.length} tools** (${reads} read, ${writes} write) in ${present.length} families, ` +
        `${prompts.length} prompts.`,
    );
    out.push("");
    // The default profile's counts, COMPUTED from the surface rather than written down.
    //
    // `scripts/smoke.mjs` reads this line to learn what an unconfigured server should register, so
    // that the check every user's actual configuration gets is not a number somebody remembered to
    // update. The wording is load-bearing for that regex — see the smoke script.
    const defaultSurface = describeSurface(parseToolProfile(DEFAULT_TOOL_PROFILE), true);
    out.push(
      `Unset, this server registers the **\`${DEFAULT_TOOL_PROFILE}\`** profile: ` +
        `**${defaultSurface.tools.length} default tools** and ` +
        `**${promptsForSurface(defaultSurface).length} default prompts**. ` +
        "Everything listed below needs `STOCKBIT_TOOLS=all`.",
    );
    out.push("");
    out.push(
      "Every tool carries an **evidence** word — Observed, Read-back or Projected. They are defined " +
        "in [`CONTEXT.md`](../CONTEXT.md) and the current state of each family is in " +
        "[`VERIFICATION.md`](VERIFICATION.md). *Projected* does not mean broken; it means nobody has " +
        "checked it, and the code is written so an unchecked guess fails loudly rather than quietly.",
    );
    out.push("");
    out.push(
      "`*` marks a required argument. Descriptions here are the first sentence only — the full one, " +
        "with the caveats that matter at call time, is what the model reads.",
    );
    out.push("");

    /* --------------------------------- families table --------------------------------- */

    out.push("## Families");
    out.push("");
    out.push("| Family | Tools | Covers | Evidence |");
    out.push("|---|---|---|---|");
    for (const family of present) {
      const inFamily = rows.filter((r) => r.family === family);
      const seen = new Set(inFamily.map((r) => r.evidence));
      const evidence =
        seen.size === 1 ? EVIDENCE_LABEL[[...seen][0] as Evidence] : "Mixed";
      out.push(
        `| [${family}](#${family}) | ${inFamily.length} | ${escapeMarkdownTableCell(FAMILY_COVERS[family])} | ${evidence} |`,
      );
    }
    out.push("");

    /* ----------------------------------- per family ----------------------------------- */

    for (const family of present) {
      const inFamily = rows.filter((r) => r.family === family);
      out.push(`## ${family}`);
      out.push("");
      out.push(escapeMarkdownTableCell(FAMILY_COVERS[family]) + ".");
      out.push("");
      out.push("| Tool | Kind | When to use | Evidence | Inputs |");
      out.push("|---|---|---|---|---|");
      for (const row of inFamily) {
        out.push(
          `| \`${row.name}\` | ${row.kind} | ${escapeMarkdownTableCell(row.whenToUse)} | ${EVIDENCE_LABEL[row.evidence]} | ` +
            `${escapeMarkdownTableCell(row.inputs)} |`,
        );
      }
      out.push("");
    }

    /* ------------------------------------- prompts ------------------------------------- */

    if (prompts.length) {
      out.push("## Prompts");
      out.push("");
      out.push(
        "The built-in workflows, offered as MCP prompts — a menu entry in your client rather than a " +
          "tool a model has to find. Each runs `workflow_run` and carries guidance on how to present " +
          "the result.",
      );
      out.push("");
      out.push("| Prompt | What it does | Arguments |");
      out.push("|---|---|---|");
      for (const prompt of [...prompts].sort((a, b) => a.name.localeCompare(b.name))) {
        const args = (prompt.arguments ?? [])
          .map((a) => (a.required ? `${a.name}*` : a.name))
          .join(", ");
        out.push(`| \`${prompt.name}\` | ${escapeMarkdownTableCell(prompt.description ?? "")} | ${args || "—"} |`);
      }
      out.push("");
    }

    return `${out.join("\n").trimEnd()}\n`;
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
}
