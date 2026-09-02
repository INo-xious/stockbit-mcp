#!/usr/bin/env node
/**
 * Write `test/fixtures/surface.json` — the frozen shape of the tool surface.
 *
 * Run it when a tool is deliberately added, removed, renamed, re-familied, re-evidenced, or given
 * an argument:
 *
 *     npm run snapshot:surface
 *
 * `test/surface-snapshot.test.ts` fails when the committed file and a fresh render disagree, so the
 * point of this script is that changing the surface produces a REVIEWABLE DIFF instead of a silent
 * edit. That is its whole job: the coming phases move roughly sixty tools between files, and the
 * failure mode of a move is not a crash, it is one tool quietly arriving with a different family, a
 * different evidence word or one fewer argument.
 *
 * ## Six fields, and not one more
 *
 * `ToolRecord` also carries `description` and `annotations`. Both are deliberately left out.
 * Rewriting descriptions is the express purpose of two upcoming phases, and a snapshot that churned
 * on every prose edit would be regenerated so often that nobody would read its diff — which is
 * exactly how a snapshot stops detecting anything.
 *
 * ## Not a substitute for `test/tools.test.ts`
 *
 * That file's `WRITES` list and evidence map are hand-written ON PURPOSE, because a derived list
 * would only prove the code agrees with itself. This file IS derived, so it can only ever say "this
 * changed", never "this is correct". It is a drift detector. The security assertions stay where
 * they are.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSurfaceSnapshot } from "../src/tools/snapshot.js";

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "surface.json");
const json = renderSurfaceSnapshot();
writeFileSync(target, json, "utf8");
console.log(`test/fixtures/surface.json written — ${JSON.parse(json).length} tools.`);
