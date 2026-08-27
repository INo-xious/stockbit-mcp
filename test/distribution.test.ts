/**
 * The four distribution manifests must agree with `package.json` and with each other.
 *
 * This project ships through npm, the MCP Registry, a Claude Code plugin and a Claude Desktop
 * Extension, and every one of them repeats the version number. A release that bumps three of the
 * four does not fail — it publishes an extension that reports 1.0.0 and behaves like 1.1.0, which is
 * the kind of thing nobody notices until a bug report describes a version that never existed. The
 * MCP Registry is stricter still: it refuses a package whose `mcpName` does not match the server
 * name, so a mismatch here is a publish that fails at the last step of a release.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => JSON.parse(readFileSync(join(ROOT, ...parts), "utf8"));

const pkg = read("package.json") as {
  name: string;
  version: string;
  mcpName: string;
  files: string[];
};

/* ------------------------------------- one version ------------------------------------- */

test("every manifest carries the version in package.json", () => {
  const server = read("server.json") as {
    version: string;
    packages: { identifier: string; version: string }[];
  };
  assert.equal(server.version, pkg.version, "server.json");
  assert.equal(server.packages[0].version, pkg.version, "server.json packages[0]");
  assert.equal(server.packages[0].identifier, pkg.name, "server.json must point at this npm package");

  assert.equal((read(".claude-plugin", "plugin.json") as { version: string }).version, pkg.version);
  assert.equal((read("mcpb", "manifest.json") as { version: string }).version, pkg.version);
});

test("the registry name is the one the npm package claims", () => {
  // The registry validates `mcpName` inside the published tarball against the server name it is
  // given. They are written in two files, so they are asserted in one place.
  const server = read("server.json") as { name: string };
  assert.equal(server.name, pkg.mcpName);
  assert.match(pkg.mcpName, /^io\.github\.[^/]+\/[a-z0-9-]+$/);
});

/* ------------------------------- what each one points at ------------------------------- */

test("the plugin's MCP config installs from npm, not from the checkout", () => {
  // A plugin checkout has no `dist/`, because `dist/` is gitignored. Pointing the plugin at a
  // relative entry point would give every installer a server that cannot start.
  const plugin = read(".claude-plugin", "plugin.json") as { mcpServers: string; skills: string };
  assert.equal(plugin.mcpServers, "./.mcp.json");

  const mcp = read(".mcp.json") as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const entry = mcp.mcpServers.stockbit;
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", `${pkg.name}@^${pkg.version.split(".")[0]}`]);
});

test("the extension runs the built entry point that package.json also exposes", () => {
  const manifest = read("mcpb", "manifest.json") as {
    server: { entry_point: string; mcp_config: { args: string[]; env: Record<string, string> } };
    icon: string;
  };
  assert.equal(manifest.server.entry_point, "dist/bin/stockbit-mcp.js");
  assert.ok(
    manifest.server.mcp_config.args.some((a) => a.endsWith("dist/bin/stockbit-mcp.js")),
    "the launch args must run the declared entry point",
  );
  assert.ok(existsSync(join(ROOT, "mcpb", manifest.icon)), "the declared icon must exist");

  // Every variable the extension sets must be one the server actually reads. A typo here is a
  // setting that appears in the UI and does nothing.
  const declared = Object.keys(manifest.server.mcp_config.env);
  assert.deepEqual(declared.sort(), ["STOCKBIT_NO_BROWSER", "STOCKBIT_TOOLS"]);
});

test("the extension's user settings are substituted into those variables", () => {
  const manifest = read("mcpb", "manifest.json") as {
    server: { mcp_config: { env: Record<string, string> } };
    user_config: Record<string, unknown>;
  };
  for (const [name, value] of Object.entries(manifest.server.mcp_config.env)) {
    const match = /^\$\{user_config\.([a-z_]+)\}$/.exec(value);
    assert.ok(match, `${name} must be substituted from a user_config key, got ${value}`);
    assert.ok(match[1] in manifest.user_config, `user_config has no key ${match[1]}`);
  }
});

/* ---------------------------------------- skills ---------------------------------------- */

test("the plugin ships the nine skills, each named after its directory", () => {
  const dirs = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  assert.deepEqual(dirs, [
    "bandar-check",
    "chart-markup",
    "morning-scan",
    "stock-deep-dive",
    "stockbit-auth",
    "stockbit-status",
    "strategy-backtest",
    "trade-with-guardrails",
    "watch",
  ]);

  for (const dir of dirs) {
    const body = readFileSync(join(ROOT, "skills", dir, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(body);
    assert.ok(frontmatter, `${dir}: no YAML frontmatter`);

    const name = /^name:\s*(.+)$/m.exec(frontmatter[1]);
    assert.ok(name, `${dir}: no name`);
    assert.equal(
      name[1].trim(),
      dir,
      `${dir}: the skill name must equal its directory, or the loader will not find it`,
    );

    const description = /^description:\s*(.+)$/m.exec(frontmatter[1]);
    assert.ok(description, `${dir}: no description`);
    assert.ok(
      description[1].trim().length > 40,
      `${dir}: the description is the only thing a model sees when deciding to load the skill`,
    );
  }
});

test("the money-touching skill states the rules that cannot be waived", () => {
  // This is the one skill that can spend money. If a later edit smooths these away, the skill still
  // loads and still reads well, and the guardrails are gone.
  const body = readFileSync(join(ROOT, "skills", "trade-with-guardrails", "SKILL.md"), "utf8");
  for (const rule of [
    "Never set `confirm: true` on the user's behalf",
    "Never ask for the PIN",
    "Never resend",
    "trading_status",
    "order_preview",
    "verbatim",
  ]) {
    assert.ok(body.includes(rule), `trade-with-guardrails no longer says: ${rule}`);
  }
});

/* --------------------------------------- packaging --------------------------------------- */

test("none of the distribution manifests are shipped to npm", () => {
  // `files` is an allow-list, so this is really a check that nobody added a broad entry to it.
  // server.json and .mcp.json describe how to install the package and have no business inside it.
  for (const entry of pkg.files) {
    assert.ok(
      !entry.startsWith("server.json") && !entry.startsWith(".mcp") && !entry.startsWith("mcpb"),
      `package.json files must not ship ${entry}`,
    );
  }
});

/* ------------------------- the skills name real tools and real arguments ------------------------- */

/**
 * Words the skills use that are result fields, modes or English, not tools or arguments.
 *
 * Spelled out rather than derived, because the point of the test below is to catch a plausible name
 * that does not exist — `ownership` for `ownership_composition`, say — and a rule loose enough to
 * let that through would let anything through.
 */
const PROSE_IDENTIFIERS = new Set([
  // Result fields the skills tell the model to read.
  "outcome",
  "summary",
  "warnings",
  "inconclusive",
  "unverified",
  "readFrom",
  // Error kinds from src/http/errors.ts — a skill quoting one back is naming a real failure,
  // not calling a tool. Only the underscored one can match the tool-shaped pattern.
  "rate_limited",
  // Trading modes.
  "off",
  "paper",
  "live",
]);

test("every tool-shaped name in a skill is a real tool or a real argument", async () => {
  const { describeSurface } = await import("../src/tools/surface.ts");
  const surface = describeSurface();

  const known = new Set<string>(PROSE_IDENTIFIERS);
  for (const tool of surface.tools) {
    known.add(tool.name);
    for (const input of tool.inputs) known.add(input.name);
  }

  const problems: string[] = [];
  for (const dir of readdirSync(join(ROOT, "skills"))) {
    const body = readFileSync(join(ROOT, "skills", dir, "SKILL.md"), "utf8");
    for (const [, identifier] of body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
      if (!known.has(identifier)) problems.push(`${dir}: \`${identifier}\``);
    }
  }

  assert.deepEqual(
    problems,
    [],
    "a skill names something that is neither a tool nor an argument — a model told to call it will fail",
  );
});

/* ------------------------- limits the MCP registry enforces ------------------------- */

/**
 * The MCP registry rejects a description longer than 100 characters, and it does so at PUBLISH
 * time — after npm has already accepted the package and the tag and GitHub Release exist.
 *
 * That is exactly what happened on the first real publish of 1.1.0: npm went out fine, the tag and
 * Release were created, and only then did `mcp-publisher` answer
 *
 *   422 {"errors":[{"message":"expected length <= 100","location":"body.description"}]}
 *
 * leaving the registry entry missing with no way to retry without cutting a new version. The limit
 * belongs in a test, where it costs seconds, rather than in a release, where it costs a version
 * number.
 */
test("server.json's description fits the MCP registry's 100-character limit", () => {
  const server = read("server.json") as { description: string };
  assert.ok(
    server.description.length <= 100,
    `server.json description is ${server.description.length} characters; the registry rejects anything over 100`,
  );
});

test("server.json still HAS a description worth reading", () => {
  // The cheap way to satisfy the test above is to gut the field. It is the only prose a user sees
  // when browsing the registry, so a floor matters as much as the ceiling.
  const server = read("server.json") as { description: string };
  assert.ok(server.description.trim().length >= 40, "too short to tell anyone what this server does");
});
