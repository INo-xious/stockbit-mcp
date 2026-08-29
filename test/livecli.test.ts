/**
 * `stockbit-live` — the command table, and the wiring that makes it load-bearing.
 *
 * Before the gate, this bin had the same hole as the 2026-08-29 `stockbit-auth login --help`
 * incident with a twist of its own: `positionals()` skips `--` tokens, so `stockbit-live --help`
 * fell through to the DEFAULT command and ran a scan, and a typo like `--tpo 5` didn't just lose
 * the flag — `5` became a stray positional in front of the scope parser.
 *
 * The spawns here only exercise paths that end before any network call: help, and parse refusals
 * (the bin's own rule — "a typo costs nothing and is reported instantly" — is what makes them
 * safe). A valid scan blocks for its whole window and polls the live API; none is ever spawned.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-livecli-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CliParseError, gateCommandLine } from "../src/cliargs.ts";
import { LIVE_BIN, LIVE_COMMANDS } from "../src/live/cli.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

/** Hard-coded on purpose — see authcli.test.ts on why this list is not derived from the spec. */
const SUBCOMMANDS = ["scan", "signals", "explain", "brokers"];

function gate(cmd: string, argv: string[]): string {
  return gateCommandLine(LIVE_BIN, LIVE_COMMANDS, cmd, argv, () => {});
}

test("the table covers exactly the commands the bin dispatches", () => {
  assert.deepEqual(Object.keys(LIVE_COMMANDS).sort(), [...SUBCOMMANDS].sort());
});

test("every documented invocation still parses", () => {
  // Straight from the bin's own header comment and the /watch skill.
  const documented: [string, string[]][] = [
    ["scan", ["BBCA,ANTM", "30s"]],
    ["scan", ["watchlist", "1m"]],
    ["scan", ["watchlist:Bandar", "5m"]],
    ["scan", ["all", "5m", "--always", "--pretty"]],
    ["scan", ["BBCA", "30s", "--top", "5"]],
    ["scan", ["BBCA", "30s", "--top=5"]],
    ["signals", ["watchlist", "1m", "value", "surge", "--pretty"]], // variadic prompt tail
    ["explain", ["BBCA", "09:00:00", "09:05:00"]],
    ["brokers", ["BBCA", "--pretty"]],
  ];
  for (const [cmd, argv] of documented) {
    assert.equal(gate(cmd, argv), "ok", `${cmd} ${argv.join(" ")}`);
  }
});

test("unknown flags, cross-command flags, and stray positionals are refused", () => {
  const cases: [string, string[], RegExp][] = [
    // The motivating typo: before the gate, `--tpo` vanished and `5` shifted the positionals.
    ["scan", ["BBCA", "30s", "--tpo", "5"], /unknown flag "--tpo".*scan accepts: --always, --pretty, --top/],
    ["scan", ["BBCA", "30s", "--prety"], /unknown flag "--prety"/],
    ["brokers", ["BBCA", "--top", "5"], /unknown flag "--top"/], // --top is scan's alone
    ["signals", ["watchlist", "1m", "--top", "5"], /unknown flag "--top"/],
    ["scan", ["BBCA", "30s", "extra"], /takes at most 2 positional arguments/],
    ["explain", ["BBCA", "1", "2", "3"], /takes at most 3 positional arguments/],
    ["scan", ["BBCA", "30s", "--top"], /--top needs a value/],
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
    assert.equal(gate(cmd, ["BBCA", "--bogus", "-h"]), "help", `${cmd}: help must beat the typo`);
  }
});

/* ------------------------------ the bin itself, spawned ------------------------------ */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin", "stockbit-live.ts");
const execFileAsync = promisify(execFile);

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "tsx", BIN, ...args], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("bare --help prints usage and runs nothing — it used to run a scan", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /scan/);
  assert.match(r.stdout, /With no command, `scan` runs\./);
});

test("bare -h is top-level help too — a single dash used to read as a COMMAND word", async () => {
  const r = await runCli(["-h"]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Usage: stockbit-live/);
});

test("help <command> prints that command's usage", async () => {
  const r = await runCli(["help", "brokers"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /brokers <SYMBOL>/);
});

test("a bad flag is refused through the JSON contract the /watch skill parses", async () => {
  const r = await runCli(["scan", "--bogus"]);
  assert.equal(r.code, 1, "failures on this bin are exit 1, that is its contract");
  const body = JSON.parse(r.stdout) as { ok: boolean; reason: string; detail: string };
  assert.equal(body.ok, false);
  assert.equal(body.reason, "bad-arguments");
  assert.match(body.detail, /unknown flag "--bogus"/);
});

test("an unknown command still answers in the established shape", async () => {
  const r = await runCli(["definitely-not"]);
  assert.equal(r.code, 1);
  const body = JSON.parse(r.stdout) as { ok: boolean; reason: string };
  assert.equal(body.reason, "unknown-command");
});

/* ------------------------------ the wiring, by source scan ------------------------------ */

test("every dispatch branch is in the table, and the gate runs before dispatch", () => {
  const source = readFileSync(BIN, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const labels = new Set([...code.matchAll(/command === "([a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...labels].sort(), Object.keys(LIVE_COMMANDS).sort());

  const gateAt = code.indexOf("gateCommandLine(");
  const dispatchAt = code.indexOf('command === "scan"');
  assert.ok(gateAt !== -1 && dispatchAt !== -1);
  assert.ok(gateAt < dispatchAt, "the gate must run before any handler can be reached");
});
