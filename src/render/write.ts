/**
 * Write a rendered chart to disk.
 *
 * Separated from the renderer so the renderer stays a pure string function — the thing that is
 * trivial to test — and the one side effect lives somewhere obvious.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
