/**
 * Build the Claude Desktop Extension — `stockbit-mcp-<version>.mcpb`.
 *
 * A node-type extension is not an npm install: Claude Desktop unpacks the archive and runs the
 * entry point with whatever `node` it finds, so the archive has to carry its own `node_modules`.
 * That is why this stages a directory and installs into it rather than packing the repo.
 *
 *   node scripts/build-mcpb.mjs
 *
 * Requires `npm run build` to have produced `dist/` (it runs it if it has not).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "mcpb", "build");

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

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

if (!existsSync(join(root, "dist", "bin", "stockbit-mcp.js"))) {
  console.log("dist/ is missing — building first.");
  run("npm", ["run", "build"]);
}

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
cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));

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
run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], stage);

const out = `stockbit-mcp-${pkg.version}.mcpb`;
run("npx", ["--yes", "@anthropic-ai/mcpb", "pack", stage, join(root, out)]);
console.log(`\n${out} written.`);
