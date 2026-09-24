/**
 * Build the Claude Desktop Extension — `stockbit-mcp-<version>.mcpb`.
 *
 * A node-type extension is not an npm install: Claude Desktop unpacks the archive and runs the
 * entry point with whatever `node` it finds, so the archive has to carry its own `node_modules`.
 * That is why this stages a directory and installs into it rather than packing the repo.
 *
 *   npm run build:mcpb
 *
 * Always rebuilds `dist/` before staging to avoid packaging stale source changes.
 */
import { execFileSync, execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "mcpb", "build");

/**
 * Run one of npm's own CLIs without going through a shell, for the reason spelled out in
 * `scripts/check-pack.mjs`: npm on Windows is `npm.cmd`, and since the fix for CVE-2024-27980 Node
 * refuses to spawn a `.cmd` through `execFile`. `npm run` exports `npm_execpath` — the path to
 * npm's entry script — so the normal route runs that with the Node already executing this file.
 * The basename is checked because under yarn or pnpm the variable points at THEIR CLI.
 *
 * When invoked directly, discover npm's CLI with a fixed command before passing paths as ordinary
 * arguments. Repository paths may contain spaces or shell metacharacters.
 */
function npm(args, cwd = root) {
  const options = { cwd, stdio: "inherit" };
  const cli = process.env.npm_execpath;
  if (cli && basename(cli) === "npm-cli.js") {
    execFileSync(process.execPath, [cli, ...args], options);
    return;
  }
  const discoveredCli = execSync("npm exec --offline -- node -p process.env.npm_execpath", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (!discoveredCli || basename(discoveredCli) !== "npm-cli.js" || !existsSync(discoveredCli)) {
    throw new Error("Cannot locate npm's CLI. Run this build with npm run build:mcpb.");
  }
  execFileSync(process.execPath, [discoveredCli, ...args], options);
}

/** Anything that is not npm — plain executables, safe through `execFile` on every platform. */
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "mcpb", "manifest.json"), "utf8"));

// A version skew here ships an extension that reports one version and behaves as another.
if (manifest.version !== pkg.version) {
  console.error(
    `mcpb/manifest.json says ${manifest.version} and package.json says ${pkg.version}. ` +
      "They must match; fix the manifest.",
  );
  process.exit(1);
}

console.log("Building the current checkout…");
npm(["run", "build"]);

// The icon is committed, but it is also generated, so a fresh checkout that lost it still builds.
if (!existsSync(join(root, "mcpb", "icon.png"))) {
  run("node", [join(root, "scripts", "gen-icon.mjs")]);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
cpSync(join(root, "mcpb", "manifest.json"), join(stage, "manifest.json"));
cpSync(join(root, "mcpb", "icon.png"), join(stage, "icon.png"));
cpSync(join(root, "README.md"), join(stage, "README.md"));
cpSync(join(root, "README.id.md"), join(stage, "README.id.md"));
cpSync(join(root, "SECURITY.md"), join(stage, "SECURITY.md"));
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
mkdirSync(join(stage, "docs"));
for (const name of ["README.md", "CLIENTS.md", "TOOLS.md", "VERIFICATION.md"]) {
  cpSync(join(root, "docs", name), join(stage, "docs", name));
}

// A trimmed package.json: the extension needs `type: module` and the runtime deps, and nothing
// else. Carrying the scripts would let a lifecycle hook run on the user's machine at install.
writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      type: pkg.type,
      main: "dist/bin/stockbit-mcp.js",
      dependencies: pkg.dependencies,
      engines: pkg.engines,
    },
    null,
    2,
  ) + "\n",
);

// The lockfile is copied so the install is the same resolution CI tested, and `--omit=dev`
// keeps tsx and typescript out of a user-facing archive.
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
console.log("Installing runtime dependencies into the staged extension…");
npm(["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], stage);

/**
 * Pinned, not floating.
 *
 * `npm exec --yes -- @anthropic-ai/mcpb` resolves `latest` over the network on every run, so the
 * tool that packs a release asset could differ between the run that was tested and the run that
 * ships — including a major version. The release workflows now build this AFTER `npm publish`, so a
 * surprise here lands on an irreversible release. `2.1.2` is what `latest` resolved to when this was
 * pinned; bump it deliberately, in a commit that can be reviewed.
 */
const MCPB_PACKER = "@anthropic-ai/mcpb@2.1.2";

const out = `stockbit-mcp-${pkg.version}.mcpb`;
npm(["exec", "--yes", "--", MCPB_PACKER, "pack", stage, join(root, out)]);
console.log(`\n${out} written.`);
