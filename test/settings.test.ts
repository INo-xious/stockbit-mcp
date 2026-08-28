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
  assert.equal(d.trading.mode, "off");
  assert.equal(d.trading.autoConfirm, false);
  assert.equal(d.trading.maxOrderValueIdr, null);
  assert.deepEqual(d.trading.allowedSymbols, []);
  // Not `required`: that would refuse orders from every client that cannot elicit, which is a
  // breaking change dressed as a default. Not `never` either — the whole point is that the ask
  // happens wherever it can.
  assert.equal(d.trading.elicitation, "when-available");
  assert.equal(d.trading.confirmationsRevokedAt, null);
});

test("enabling in the file enables the policy, and it is read at CALL time", () => {
  clear();
  assert.equal(tradingPolicy({}).enabled, false);
  const settings = defaultSettings();
  settings.trading.mode = "live";
  saveSettings(settings);
  // No restart, no cache to bust: `trading-disable` must take effect on the next order.
  assert.equal(tradingPolicy({}).enabled, true);
  assert.equal(tradingPolicy({}).live, true);
  settings.trading.mode = "off";
  saveSettings(settings);
  assert.equal(tradingPolicy({}).enabled, false);
});

test("paper is a third state, not a flag beside enabled", () => {
  // `enabled: boolean` could not say this without a second field, and the pair "enabled but paper"
  // is exactly the combination a reader gets wrong — one of the two says the opposite of the truth.
  clear();
  const settings = defaultSettings();
  settings.trading.mode = "paper";
  saveSettings(settings);

  const policy = tradingPolicy({});
  assert.equal(policy.mode, "paper");
  assert.equal(policy.live, false, "paper is not live");
  assert.equal(policy.enabled, true, "but it IS enabled — an order tool does something in paper");
  assert.match(policy.reason, /PAPER/);
  assert.match(policy.reason, /local ledger/);
});

test("paper never auto-confirms, however the file is written", () => {
  // Paper exists to rehearse the live protocol. A rehearsal that skips the confirmation step
  // rehearses the wrong thing.
  clear();
  const settings = defaultSettings();
  settings.trading.mode = "paper";
  settings.trading.autoConfirm = true;
  settings.trading.maxOrderValueIdr = 5_000_000;
  saveSettings(settings);
  assert.equal(tradingPolicy({}).autoConfirm, false);
});

test("the environment can only move DOWN the ladder", () => {
  clear();
  const settings = defaultSettings();
  settings.trading.mode = "live";
  saveSettings(settings);

  // live -> paper
  const lowered = tradingPolicy({ STOCKBIT_TRADING: "paper" });
  assert.equal(lowered.mode, "paper");
  assert.equal(lowered.source, "env-paper");
  assert.match(lowered.reason, /No real order can be placed/);

  // live -> off
  assert.equal(tradingPolicy({ STOCKBIT_TRADING: "off" }).mode, "off");

  // paper -> live is NOT possible.
  settings.trading.mode = "paper";
  saveSettings(settings);
  assert.equal(tradingPolicy({ STOCKBIT_TRADING: "live" }).mode, "paper", "nothing in the env raises the mode");

  // off -> paper is not possible either: the env cannot turn anything on.
  settings.trading.mode = "off";
  saveSettings(settings);
  assert.equal(tradingPolicy({ STOCKBIT_TRADING: "paper" }).mode, "off");
});

test("a v1 file is migrated: enabled:true meant real money, so it means live", () => {
  writeRaw(JSON.stringify({ version: 1, trading: { enabled: true, maxLotsPerOrder: 100 } }));
  const settings = loadSettings();
  assert.equal(settings.trading.mode, "live");
  assert.equal(settings.trading.maxLotsPerOrder, 100, "the rest of the block survives the migration");

  writeRaw(JSON.stringify({ version: 1, trading: { enabled: false } }));
  assert.equal(loadSettings().trading.mode, "off");
});

test("an unrecognised mode is off, because an ambiguous permission is no permission", () => {
  writeRaw(JSON.stringify({ version: 2, trading: { mode: "papr" } }));
  assert.equal(loadSettings().trading.mode, "off");
  writeRaw(JSON.stringify({ version: 2, trading: { mode: true } }));
  assert.equal(loadSettings().trading.mode, "off");
});

test("an unrecognised elicitation value is the DEFAULT, not the strictest or the loosest", () => {
  // Deliberately unlike `mode`, whose fallback is `off`. An unreadable *permission* is no
  // permission; this is not a permission. Falling back to `never` would silently weaken an account
  // over a typo, and to `required` would silently brick one.
  for (const value of ["requried", true, 1, null, [], "REQUIRED"]) {
    writeRaw(JSON.stringify({ version: 2, trading: { mode: "live", elicitation: value } }));
    assert.equal(loadSettings().trading.elicitation, "when-available", `elicitation: ${JSON.stringify(value)}`);
  }
  writeRaw(JSON.stringify({ version: 2, trading: { mode: "live" } }));
  assert.equal(loadSettings().trading.elicitation, "when-available", "and an absent field is the same thing");
});

test("all three elicitation values survive a round trip through the file", () => {
  for (const value of ["required", "when-available", "never"] as const) {
    writeRaw(JSON.stringify({ version: 2, trading: { mode: "live", elicitation: value } }));
    assert.equal(loadSettings().trading.elicitation, value);
    assert.equal(tradingPolicy({}).elicitation, value, "and it reaches the policy every gate reads");
  }
});

test("a revocation that cannot be read is kept, because dropping it would keep a grant alive", () => {
  // The asymmetry that decides this: `confirmationsRevokedAt` is a REVOCATION, not a permission.
  // Misreading it as "never revoked" silently keeps a standing confirmation alive; misreading it as
  // "revoked" only means the user is asked again. So a non-empty string is carried through even
  // when it is not a date, and `rememberCovers` treats an unparseable moment as revoking
  // everything. Only a non-string, or an empty one, is "nothing here".
  for (const value of [17, true, { at: 1 }, null, [], ""]) {
    writeRaw(JSON.stringify({ version: 2, trading: { mode: "live", confirmationsRevokedAt: value } }));
    assert.equal(loadSettings().trading.confirmationsRevokedAt, null, JSON.stringify(value));
  }
  writeRaw(JSON.stringify({ version: 2, trading: { mode: "live", confirmationsRevokedAt: "yesterday" } }));
  assert.equal(loadSettings().trading.confirmationsRevokedAt, "yesterday", "a hand-edited value is not discarded");

  const iso = "2026-08-28T01:02:03.000Z";
  writeRaw(JSON.stringify({ version: 2, trading: { mode: "live", confirmationsRevokedAt: iso } }));
  assert.equal(loadSettings().trading.confirmationsRevokedAt, iso);
});

test("elicitation: required and autoConfirm contradict, and the ASK wins", () => {
  // Two switches that say opposite things about whether a person is asked. Resolved in favour of
  // the one that produces a question, and reported through the channel that already exists for
  // "you set this and it is not doing anything" rather than through a new field nobody reads.
  const settings = defaultSettings();
  settings.trading.mode = "live";
  settings.trading.autoConfirm = true;
  settings.trading.maxOrderValueIdr = 5_000_000;
  settings.trading.elicitation = "required";
  saveSettings(settings);

  const policy = tradingPolicy({});
  assert.equal(policy.enabled, true);
  assert.equal(policy.autoConfirm, false, "the cap is fine; the contradiction is what disables it");
  assert.equal(policy.elicitation, "required");
  assert.match(policy.autoConfirmIgnored ?? "", /elicitation is `required`/);
  assert.match(policy.autoConfirmIgnored ?? "", /The ask wins/);
  assert.match(policy.autoConfirmIgnored ?? "", /confirm: true/);

  // And the way out is named, so a user who actually wanted autoConfirm knows what to type.
  assert.match(policy.autoConfirmIgnored ?? "", /--elicitation when-available/);
});

test("STOCKBIT_TRADING=off overrides an enabled file", () => {
  const settings = defaultSettings();
  settings.trading.mode = "live";
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
  settings.trading.mode = "live";
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
  settings.trading.mode = "live";
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
      version: 2,
      trading: {
        mode: "yes please",
        enabled: "true",
        autoConfirm: 1,
        maxOrderValueIdr: -5,
        allowedSymbols: "BBRI",
        maxLotsPerOrder: 0,
        // A non-string that a loose reader would happily accept as "never".
        elicitation: { toString: "never" },
        confirmationsRevokedAt: 0,
      },
    }),
  );
  const settings = loadSettings();
  assert.equal(settings.trading.mode, "off", '"yes please" is not a mode, and "true" is a string');
  assert.equal(settings.trading.autoConfirm, false);
  assert.equal(settings.trading.maxOrderValueIdr, null, "a negative cap is no cap");
  assert.deepEqual(settings.trading.allowedSymbols, []);
  assert.equal(settings.trading.maxLotsPerOrder, defaultSettings().trading.maxLotsPerOrder);
  assert.equal(settings.trading.elicitation, "when-available", "a non-string cannot smuggle `never` through");
  assert.equal(settings.trading.confirmationsRevokedAt, null);
});

test("allowed symbols are upper-cased, so a lower-case entry still restricts", () => {
  writeRaw(JSON.stringify({ trading: { mode: "live", allowedSymbols: ["bbri", "TLKM"] } }));
  assert.deepEqual(loadSettings().trading.allowedSymbols, ["BBRI", "TLKM"]);
});

test("the file is written atomically and owner-only", () => {
  clear();
  const settings = defaultSettings();
  settings.trading.mode = "live";
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
