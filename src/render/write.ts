/**
 * Write a rendered chart to disk.
 *
 * Separated from the renderer so the renderer stays a pure string function — the thing that is
 * trivial to test — and the one side effect lives somewhere obvious.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Write `svg` to `path`, creating parent directories, and return the resolved absolute path.
 *
 * The extension is forced to `.svg`: the content is SVG regardless of what the caller asked for,
 * and a mislabelled file (`chart.png` holding markup) fails confusingly later in whatever opens it.
 */
export function writeSvg(path: string, svg: string): string {
  const target = resolve(/\.svgz?$/i.test(path) ? path : `${path}.svg`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, svg, "utf8");
  return target;
}

/**
 * Where a chart lands when the caller does not name a path.
 *
 * Under `~/.stockbit/charts` rather than the working directory or a temp dir: the working directory
 * is whatever the MCP client happened to launch from (so files scatter into unrelated projects),
 * and a temp dir gets swept, which is the wrong behaviour for something the user is told the path of.
 * This sits beside the existing `~/.stockbit` credential directory and is easy to find again.
 */
export function defaultChartPath(parts: {
  symbol: string;
  side: string;
  from?: string;
  to?: string;
  dataType: string;
}): string {
  const window = parts.from && parts.to ? `${parts.from}_${parts.to}` : "latest";
  // Deterministic, so repeating the same query overwrites rather than piling up files.
  const name = `${parts.symbol}-${parts.side}-${window}-${parts.dataType}`.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(homedir(), ".stockbit", "charts", name);
}
