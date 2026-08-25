#!/usr/bin/env node
/**
 * Assert that `npm publish` would ship the built server and nothing else.
 *
 * Before this existed, `npm pack` shipped 247 files and 3 MB: the whole `src/` tree, the tests, the
 * documentation, a local status board, the handoff plan, and a `dist/` left over from an earlier
 * refactor whose orphan files no longer had a source. A published tarball is the one artefact that
 * cannot be quietly fixed afterwards, so this runs in CI on every push.
 *
 * The check is an allow-list, deliberately: a deny-list only catches the mistakes someone already
 * thought of. Anything that is not a compiled `.js` under `dist/bin` or `dist/src`, or one of the
 * six root files a consumer actually reads, is an offender — including files this project has not
 * invented yet.
 */
import { execFileSync, execSync } from "node:child_process";
import { basename } from "node:path";

/** Exactly what belongs in the tarball. Anything else fails the run. */
const ALLOWED = /^(dist\/(bin|src)\/.+\.js|README(\.id)?\.md|CHANGELOG\.md|SECURITY\.md|LICENSE|package\.json)$/;

/**
 * Names that mean a specific past mistake came back.
 *
 * Redundant with the allow-list by construction. They are listed anyway so the failure message can
 * say *which* mistake it is rather than only that a path did not match a regular expression.
 */
const KNOWN_BAD = /(^|\/)(test|tests)\/|(^|\/)plan\.md$|(^|\/)progress\//i;

/** A sanity band, not a target. Well under it means the build broke; well over means something crept in. */
const MIN_FILES = 100;
const MAX_FILES = 150;

/**
 * Ask npm what it would pack, without going through a shell.
 *
 * `execFileSync("npm", …)` is wrong on Windows, where npm is `npm.cmd`: since the fix for
 * CVE-2024-27980 Node will not spawn a `.cmd` through `execFile` at all, so the call died with
 * `spawnSync npm ENOENT` on every Windows machine running Node 20.12 or newer — a check that runs
 * on three operating systems cannot be reached on one of them.
 *
 * `npm run` exports `npm_execpath`, the path to npm's own CLI entry point, so the normal route is
 * to run that script with the Node already executing this file. The name is checked because under
 * yarn or pnpm the same variable points at *their* CLI, and `pnpm pack --dry-run --json` is not
 * the command this wants.
 *
 * The fallback covers `node scripts/check-pack.mjs` run directly, where the variable is absent. It
 * is the one path that needs a shell, because resolving `npm.cmd` is exactly what a shell is for.
 * It goes through `execSync` with a single fixed string rather than `execFileSync` with `shell:
 * true` and an argument array: that combination earns a DEP0190 deprecation warning on Node 24,
 * since the arguments are concatenated rather than escaped. Nothing here is interpolated, so there
 * is nothing for the shell to reinterpret either way — this simply says so in the form Node wants.
 */
function npmPackJson() {
  const options = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  };

  const cli = process.env.npm_execpath;
  if (cli && basename(cli) === "npm-cli.js") {
    return execFileSync(process.execPath, [cli, "pack", "--dry-run", "--json"], options);
  }

  return execSync("npm pack --dry-run --json", options);
}

function packFileList() {
  const out = npmPackJson();
  // `npm pack --json` prints an array with one entry per tarball it would build.
  const parsed = JSON.parse(out);
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || !Array.isArray(entry.files)) {
    throw new Error("npm pack --json did not return a file list");
  }
  return { name: entry.name, version: entry.version, files: entry.files.map((f) => f.path) };
}

function main() {
  const { name, version, files } = packFileList();

  const offenders = [];
  for (const path of files) {
    if (KNOWN_BAD.test(path)) offenders.push([path, "matches a path this package must never ship"]);
    else if (path.endsWith(".map")) offenders.push([path, "source maps are not published"]);
    else if (!ALLOWED.test(path)) offenders.push([path, "not in the allow-list"]);
  }

  const problems = offenders.map(([path, why]) => `  ${path} — ${why}`);
  if (files.length < MIN_FILES || files.length > MAX_FILES) {
    problems.push(`  file count ${files.length} is outside the expected ${MIN_FILES}–${MAX_FILES}`);
  }

  if (problems.length) {
    console.error(`check:pack FAILED for ${name}@${version} — ${files.length} files\n`);
    console.error(problems.join("\n"));
    console.error(
      "\nFix `files` in package.json, or delete the stray file. Run `npm run build` first if " +
        "dist/ is stale: the build cleans dist/ so orphans from an earlier layout cannot survive.",
    );
    process.exit(1);
  }

  const js = files.filter((f) => f.startsWith("dist/")).length;
  console.log(`check:pack OK — ${name}@${version}: ${files.length} files (${js} compiled, ${files.length - js} root).`);
}

main();
