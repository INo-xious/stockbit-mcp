/**
 * Where this project keeps things on disk. One definition, used by everything.
 *
 * `~/.stockbit` holds credentials, settings, alert rules and their log, the audit logs for account
 * and order writes, saved charts and generated Pine. `STOCKBIT_STORE_DIR` moves all of it — that is
 * how the test suite runs against a temporary directory instead of the developer's real store, and
 * how someone on a shared machine can put it on an encrypted volume.
 *
 * It used to be moved by *nine* copies of the same expression, and `src/render/write.ts` had three
 * sites that hard-coded `~/.stockbit` and did not honour the variable at all. So a test that set
 * `STOCKBIT_STORE_DIR` still wrote real chart SVGs into the developer's home directory, and a user
 * who moved the store found their charts had not moved with it. A helper cannot drift from itself.
 *
 * Read dynamically rather than captured at import: tests set the variable after importing, and a
 * module-level constant would freeze the first value anyone happened to load.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/** The store root: `$STOCKBIT_STORE_DIR`, or `~/.stockbit`. */
export function stockbitDir(): string {
  return process.env.STOCKBIT_STORE_DIR || join(homedir(), ".stockbit");
}

/** A path inside the store. `stockbitPath("alerts.log")`, `stockbitPath("paper", "ledger.json")`. */
export function stockbitPath(...parts: string[]): string {
  return join(stockbitDir(), ...parts);
}

/** Where rendered chart SVGs and PNGs land. */
export function chartsDir(): string {
  return stockbitPath("charts");
}

/** Where generated Pine scripts land. */
export function pineDir(): string {
  return stockbitPath("pine");
}
