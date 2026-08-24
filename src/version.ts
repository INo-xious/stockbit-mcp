/**
 * The published version, read from `package.json` at run time.
 *
 * It used to be a string literal in `src/server.ts`, which said `0.1.0` for as long as nobody
 * remembered to change it. A version a client reports is only useful if it is true, and the one
 * place it is guaranteed true is the manifest npm installed.
 *
 * Walking up from this module's own URL rather than from `process.cwd()`: an MCP server is launched
 * by a client, from whatever directory that client happened to be in, and a relative read would
 * find some other project's manifest or nothing at all. The walk also checks the package `name`,
 * so a `package.json` belonging to a host application cannot be mistaken for this one — which is
 * exactly what happens when this code is bundled into someone else's tree.
 *
 * Both layouts have to work: `src/version.ts` under `tsx`, and `dist/src/version.js` after a build.
 * Walking up finds the same manifest either way.
 */
import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "stockbit-mcp";

/** What to report when the manifest genuinely cannot be found. Never throws — a version is not worth a crash. */
const UNKNOWN = "0.0.0-dev";

function readVersion(): string {
  let dir: string;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    return UNKNOWN;
  }
  const { root } = parse(dir);
  // Bounded by the filesystem root; `dist/src` is two levels, source is one, and a bundled copy
  // could be deeper.
  for (let i = 0; i < 12; i++) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (parsed.name === PACKAGE_NAME && typeof parsed.version === "string" && parsed.version) {
        return parsed.version;
      }
    } catch {
      // No manifest here, or an unreadable one. Keep walking.
    }
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return UNKNOWN;
}

/** The version this build reports to a client, and prints in `status`. */
export const VERSION = readVersion();
