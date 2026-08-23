/**
 * The file that decides whether this server may place an order.
 *
 * Every assertion here is about one of three properties, and each one exists because the failure it
 * prevents is silent:
 *
 *   1. **Default-off, including on failure.** A missing file, a corrupt file, a file with a trading
 *      block that half-parses — all of them mean "no permission", never "keep whatever survived".
 *   2. **The environment is one-directional.** `STOCKBIT_TRADING` can turn trading off and nothing
 *      in the environment can turn it on. A variable is the easiest thing in a process tree to set
 *      by accident.
 *   3. **`autoConfirm` is inert without a cap.** "I trust it for small orders" must not become "I
 *      trust it for any order" the day someone removes the cap.
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.STOCKBIT_STORE_DIR = mkdtempSync(join(tmpdir(), "stockbit-settings-test-"));

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  settingsPath,
  settingsWereCorrupt,
  tradingPolicy,
} from "../src/settings.ts";

const PATH = settingsPath();

function writeRaw(text: string): void {
  writeFileSync(PATH, text, "utf8");
}

function clear(): void {
  rmSync(PATH, { force: true });
}

test("with no settings file at all, trading is off", () => {
  clear();
  const policy = tradingPolicy({});
  assert.equal(policy.enabled, false);
  assert.equal(policy.autoConfirm, false);
  assert.match(policy.reason, /trading-enable/);
  assert.equal(policy.corrupt, undefined, "an absent file is the default state, not corruption");
});

test("the shipped default has every money-moving switch off", () => {
  const d = defaultSettings();
  assert.equal(d.trading.enabled, false);
  assert.equal(d.trading.autoConfirm, false);
  assert.equal(d.trading.maxOrderValueIdr, null);
  assert.deepEqual(d.trading.allowedSymbols, []);
});

test("enabling in the file enables the policy, and it is read at CALL time", () => {
  clear();
  assert.equal(tradingPolicy({}).enabled, false);
  const settings = defaultSettings();
  settings.trading.enabled = true;
  saveSettings(settings);
  // No restart, no cache to bust: `trading-disable` must take effect on the next order.
  assert.equal(tradingPolicy({}).enabled, true);
  settings.trading.enabled = false;
  saveSettings(settings);
  assert.equal(tradingPolicy({}).enabled, false);
});

test("STOCKBIT_TRADING=off overrides an enabled file", () => {
  const settings = defaultSettings();
  settings.trading.enabled = true;
  settings.trading.autoConfirm = true;
  settings.trading.maxOrderValueIdr = 1_000_000;
  saveSettings(settings);
  assert.equal(tradingPolicy({}).enabled, true, "precondition");

  for (const value of ["off", "OFF", "0", "false", "no"]) {
    const policy = tradingPolicy({ STOCKBIT_TRADING: value });
    assert.equal(policy.enabled, false, `STOCKBIT_TRADING=${value} must turn trading off`);
    assert.equal(policy.autoConfirm, false, "and it must take autoConfirm with it");
    assert.equal(policy.source, "env-off");
  }
});

test("no environment value can turn trading ON", () => {
  // This is the asymmetry the whole design rests on. An env var is the easiest thing in a process
  // tree to set by accident, and an accident that ENABLES ordering is the one that costs money.
  clear();
  for (const value of ["on", "1", "true", "yes", "enabled", "ON"]) {
    assert.equal(
      tradingPolicy({ STOCKBIT_TRADING: value }).enabled,
      false,
      `STOCKBIT_TRADING=${value} must not enable trading`,
    );
  }
});

test("autoConfirm without a value cap is REFUSED, and says so", () => {
  const settings = defaultSettings();
  settings.trading.enabled = true;
  settings.trading.autoConfirm = true;
  settings.trading.maxOrderValueIdr = null;
  saveSettings(settings);

  const policy = tradingPolicy({});
  assert.equal(policy.enabled, true);
  assert.equal(policy.autoConfirm, false, "autoConfirm must not be honoured without a cap");
  assert.match(policy.autoConfirmIgnored ?? "", /maxOrderValueIdr/);
  assert.match(policy.autoConfirmIgnored ?? "", /confirm: true/);
});

test("autoConfirm WITH a cap is honoured, and the cap travels with it", () => {
  const settings = defaultSettings();
  settings.trading.enabled = true;
  settings.trading.autoConfirm = true;
  settings.trading.maxOrderValueIdr = 5_000_000;
  saveSettings(settings);

  const policy = tradingPolicy({});
  assert.equal(policy.autoConfirm, true);
  assert.equal(policy.maxOrderValueIdr, 5_000_000);
  assert.equal(policy.autoConfirmIgnored, undefined);
});

test("a corrupt file is default-off AND says the file could not be read", () => {
  // Not a throw: an order tool that stack-traces on a bad settings file is worse than one that
  // refuses. Not a partial merge either — half-applying a corrupt trading block is how `enabled`
  // survives while the cap that bounded it does not.
  writeRaw("{ this is not json");
  const policy = tradingPolicy({});
  assert.equal(policy.enabled, false);
  assert.equal(policy.corrupt, true);
  assert.match(policy.reason, /could not be read/);
  assert.equal(settingsWereCorrupt(), true);
});

test("a hostile or half-typed file cannot smuggle a permission through", () => {
  // Every field is coerced, not trusted. A string "true", a negative cap and a non-array symbol
  // list are all things a hand-edited file plausibly contains.
  writeRaw(
    JSON.stringify({
      version: 1,
      trading: {
        enabled: "true",
        autoConfirm: 1,
        maxOrderValueIdr: -5,
        allowedSymbols: "BBRI",
        maxLotsPerOrder: 0,
      },
    }),
  );
  const settings = loadSettings();
  assert.equal(settings.trading.enabled, false, '"true" is a string, not permission');
  assert.equal(settings.trading.autoConfirm, false);
  assert.equal(settings.trading.maxOrderValueIdr, null, "a negative cap is no cap");
  assert.deepEqual(settings.trading.allowedSymbols, []);
  assert.equal(settings.trading.maxLotsPerOrder, defaultSettings().trading.maxLotsPerOrder);
});

test("allowed symbols are upper-cased, so a lower-case entry still restricts", () => {
  writeRaw(JSON.stringify({ trading: { enabled: true, allowedSymbols: ["bbri", "TLKM"] } }));
  assert.deepEqual(loadSettings().trading.allowedSymbols, ["BBRI", "TLKM"]);
});

test("the file is written atomically and owner-only", () => {
  clear();
  const settings = defaultSettings();
  settings.trading.enabled = true;
  saveSettings(settings);
  const dir = process.env.STOCKBIT_STORE_DIR!;
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "a temp file survived the write");
  if (process.platform !== "win32") {
    assert.equal(statSync(PATH).mode & 0o777, 0o600);
  }
  // An interrupted truncating write would read back as corrupt, and corrupt means default-off —
  // which would silently disable trading rather than merely losing an edit.
  assert.equal(tradingPolicy({}).enabled, true);
});

test("nothing that serves a model can write this file", () => {
  // A server that can widen its own permissions has no permissions. The CLI writes settings; the
  // tools and the trading code only read them.
  const SRC = fileURLToPath(new URL("../src", import.meta.url));
  const offenders: string[] = [];
  const walk = (dir: string): string[] => {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  };
  for (const file of walk(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (!rel.startsWith("tools/") && !rel.startsWith("trading/") && !rel.startsWith("eipo/")) continue;
    if (/\bsaveSettings\b/.test(readFileSync(file, "utf8"))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "these modules can rewrite the trading policy they are governed by");
});
