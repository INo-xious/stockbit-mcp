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
import { execFileSync } from "node:child_process";

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

function packFileList() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
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
