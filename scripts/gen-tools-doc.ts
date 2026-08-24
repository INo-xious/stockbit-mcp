#!/usr/bin/env node
/**
 * Write `docs/TOOLS.md` from the live server surface.
 *
 * Run it after touching any tool — a description, an argument, a family, a rename.
 * `test/toolsdoc.test.ts` fails if the committed file and a fresh render disagree, so forgetting is
 * a red test rather than a reference that quietly becomes fiction.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToolsDoc } from "../src/toolsdoc.js";

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "TOOLS.md");
const markdown = await renderToolsDoc();
writeFileSync(target, markdown, "utf8");
const lines = markdown.split("\n").length;
console.log(`docs/TOOLS.md written — ${lines} lines.`);
