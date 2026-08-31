/**
 * `stockbit-alerts` — the command table, and the wiring that makes it load-bearing.
 *
 * This bin's worst case of the 2026-08-29 unknown-flags incident: `watch --help` didn't print
 * anything — it STARTED the long-lived daemon. The spawn below proves `watch --help` now returns
 * immediately; if the gate were deleted, the child would sit in the daemon loop until the execFile
 * timeout killed it, which fails the test loudly (and touches nothing: its store is an empty temp
 * dir, so there are no rules to evaluate and no notification channels configured).
 *
 * `test` is never spawned — it SENDS a sample notification through every configured channel, and a
 * test must not notify anyone. Its gating is proven at spec level plus the source scan.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-alertscli-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CliParseError, gateCommandLine } from "../src/cliargs.ts";
import { ALERTS_BIN, ALERTS_COMMANDS } from "../src/alerts/cli.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

/** Hard-coded on purpose — see authcli.test.ts on why this list is not derived from the spec. */
const SUBCOMMANDS = ["watch", "check", "test"];

function gate(cmd: string, argv: string[]): string {
  return gateCommandLine(ALERTS_BIN, ALERTS_COMMANDS, cmd, argv, () => {});
}

test("the table covers exactly the commands the bin dispatches", () => {
  assert.deepEqual(Object.keys(ALERTS_COMMANDS).sort(), [...SUBCOMMANDS].sort());
});

test("every documented invocation still parses", () => {
  // Straight from the bin's header comment: the watch/check/test examples plus the delivery flags,
  // which the bin resolves into ONE options object for every command.
  const documented: [string, string[]][] = [
    ["watch", []],
    ["watch", ["--interval", "30"]],
    ["watch", ["--interval=30", "--always"]],
    ["watch", ["--symbol", "BBRI", "--no-desktop", "--no-telegram", "--webhook", "https://example.test/hook"]],
    ["check", []],
    ["check", ["--dry-run"]],
    ["check", ["--symbol", "BBRI", "--always"]],
    ["test", []],
    ["test", ["--no-telegram", "--dry-run"]],
  ];
  for (const [cmd, argv] of documented) {
    assert.equal(gate(cmd, argv), "ok", `${cmd} ${argv.join(" ")}`);
  }
});

test("unknown flags, watch-only flags elsewhere, and stray positionals are refused", () => {
  const cases: [string, string[], RegExp][] = [
    ["watch", ["--bogus"], /unknown flag "--bogus".*watch accepts: --always, --dry-run/],
    // --interval is watch's alone: `check --interval 30` almost certainly meant `watch`.
    ["check", ["--interval", "30"], /unknown flag "--interval"/],
    // The whole token as typed, `=value` included — the quote must match what is on their screen.
    ["test", ["--interval=30"], /unknown flag "--interval=30"/],
    ["watch", ["foo"], /unexpected argument "foo".*accepts no positional arguments/],
    ["watch", ["--webhook"], /--webhook needs a value/],
  ];
  for (const [cmd, argv, expected] of cases) {
    try {
      gate(cmd, argv);
      assert.fail(`${cmd} ${argv.join(" ")} was accepted`);
    } catch (err) {
      assert.ok(err instanceof CliParseError, String(err));
      assert.match(err.message, expected);
    }
  }
});

test("--help answers for every command without reaching any handler", () => {
  for (const cmd of SUBCOMMANDS) {
    assert.equal(gate(cmd, ["--help"]), "help", cmd);
    assert.equal(gate(cmd, ["--bogus", "-h"]), "help", `${cmd}: help must beat the typo`);
  }
});

/* ------------------------------ the bin itself, spawned ------------------------------ */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin", "stockbit-alerts.ts");
const execFileAsync = promisify(execFile);

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const childStore = mkdtempSync(join(tmpdir(), "stockbit-alertscli-child-"));
  try {
    const env = {
      ...process.env,
      // Offline, like every other test. `status` asks npm whether a newer release exists, and a
      // SPAWNED bin does not inherit this suite's stubbed `fetch` — so without this the gate would
      // make a real request to registry.npmjs.org. test/updatecheck.test.ts asserts every spawner
      // sets it, because one that forgets is silent.
      STOCKBIT_NO_UPDATE_CHECK: "1",
      STOCKBIT_FORCE_FILE_STORE: "1",
      STOCKBIT_STORE_DIR: childStore,
      // Nothing to deliver to, even if a handler were somehow reached.
      STOCKBIT_ALERT_WEBHOOK: "",
      STOCKBIT_TELEGRAM_BOT_TOKEN: "",
      STOCKBIT_TELEGRAM_CHAT_ID: "",
    };
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", BIN, ...args], {
        encoding: "utf8",
        cwd: ROOT,
        env,
        timeout: 60_000,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  } finally {
    rmSync(childStore, { recursive: true, force: true });
  }
}

test("watch --help prints usage and returns — it used to start the daemon", async () => {
  const r = await runCli(["watch", "--help"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /--interval N/);
  assert.doesNotMatch(r.stdout, /stockbit-alerts watching/, "the daemon's banner means the daemon started");
});

test("bare --help lists the commands and the environment-only Telegram rule", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /watch/);
  assert.match(r.stdout, /Telegram is environment-only/);
});

test("an unknown flag is refused with exit code 2, before any pass runs", async () => {
  const r = await runCli(["check", "--bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag "--bogus"/);
});

test("an unknown command keeps its established refusal", async () => {
  const r = await runCli(["definitely-not"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Unknown command "definitely-not"/);
});

/* ------------------------------ the wiring, by source scan ------------------------------ */

test("every dispatch branch is in the table, and the gate runs before dispatch", () => {
  const source = readFileSync(BIN, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  // `watch` is the fall-through branch, so it appears as `command !== "watch"`; `help` is the help
  // word handled before the gate, not a dispatchable command.
  const labels = new Set([...code.matchAll(/command [!=]== "([a-z-]+)"/g)].map((m) => m[1]));
  labels.delete("help");
  assert.deepEqual([...labels].sort(), Object.keys(ALERTS_COMMANDS).sort());

  const gateAt = code.indexOf("gateCommandLine(");
  const dispatchAt = code.indexOf('command === "test"');
  assert.ok(gateAt !== -1 && dispatchAt !== -1);
  assert.ok(gateAt < dispatchAt, "the gate must run before any handler can be reached");
});
