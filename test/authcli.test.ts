/**
 * `stockbit-auth` — the command table, and the wiring that makes it load-bearing.
 *
 * This is the regression test for 2026-08-29: `stockbit-auth login --help` opened a REAL browser
 * login, because unknown flags were invisible to `argv.includes()`. Three layers, because each can
 * fail alone: the spec (does the table say what the handlers read?), the wiring (does the bin
 * actually gate through it? — spawned, so `main()` itself is on trial), and a source scan for the
 * commands that can never be spawned safely (`doctor` launches a browser, `logout` clears the
 * credential; running those to prove they DON'T run would be the incident again, as a test).
 *
 * The spawns are made safe under mutation by a tripwire: `STOCKBIT_BROWSER` points at a file that
 * does not exist, and `findBrowsers()` throws on that BEFORE any profile creation or launch. If the
 * gate were deleted, `login --help` would exit 1 having done nothing — a loud test failure, and no
 * browser. (`STOCKBIT_NO_BROWSER` alone would not do: `captureViaBrowserLogin` never checks it.)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-authcli-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CliParseError, formatUsage, gateCommandLine } from "../src/cliargs.ts";
import { AUTH_BIN, AUTH_COMMANDS } from "../src/auth/cli.ts";

after(() => rmSync(STORE, { recursive: true, force: true }));

/**
 * Hard-coded on purpose (the WRITES-list philosophy): deriving this from the spec would make the
 * test agree with any mistake the spec makes. A subcommand added to the bin must be added HERE and
 * to the table, consciously, or the source-scan test below fails.
 */
const SUBCOMMANDS = [
  "login",
  "import-har",
  "doctor",
  "bootstrap",
  "status",
  "logout",
  "trading-login",
  "trading-status",
  "trading-enable",
  "trading-disable",
  "trading-forget",
  "paper-reset",
  "trading-logout",
];

function gate(cmd: string, argv: string[]): { result: string; help: string } {
  let help = "";
  const result = gateCommandLine(AUTH_BIN, AUTH_COMMANDS, cmd, argv, (text) => (help += text));
  return { result, help };
}

test("the table covers exactly the subcommands the bin dispatches", () => {
  assert.deepEqual(Object.keys(AUTH_COMMANDS).sort(), [...SUBCOMMANDS].sort());
});

test("every documented invocation still parses — the docs and skills depend on these", () => {
  // Each of these appears in README.md, SECURITY.md, docs/, or a skills/*/SKILL.md. Strictness that
  // broke one of them would trade a silent failure for a loud regression.
  const documented: [string, string[]][] = [
    ["login", []],
    ["login", ["--fresh-profile"]],
    ["login", ["--switch-account", "--verify"]],
    ["bootstrap", ["--verify"]],
    ["import-har", ["C:\\x\\login.har", "--shred", "--verify"]],
    ["doctor", ["--skip-self-test"]],
    ["status", []],
    ["status", ["--verify", "--json"]],
    ["logout", ["--keep-profile"]],
    ["trading-login", ["--browser"]],
    ["trading-status", ["--offline"]],
    ["trading-enable", ["--paper", "--cash", "250000000"]],
    ["trading-enable", ["--live", "--max-order-value", "5000000", "--max-lots", "10", "--symbols", "BBRI,TLKM", "--auto-confirm"]],
    ["trading-enable", ["--no-auto-confirm", "--paper"]],
    ["trading-enable", ["--paper", "--elicitation", "required"]],
    ["trading-enable", ["--paper", "--elicitation=never"]],
    ["trading-enable", ["--live", "--require-elicitation"]],
    ["trading-enable", ["--paper", "--no-elicitation"]],
    ["paper-reset", ["--cash=1000000"]],
    ["trading-logout", []],
    ["trading-disable", []],
    ["trading-forget", []],
  ];
  for (const [cmd, argv] of documented) {
    assert.equal(gate(cmd, argv).result, "ok", `${cmd} ${argv.join(" ")}`);
  }
});

test("status keeps --offline, because SECURITY.md tells reporters to run it", () => {
  // Offline is the default now, so the flag does nothing — but SECURITY.md asks vulnerability
  // reporters to paste `stockbit-auth status --offline --json`, and an error there would turn a
  // security report into a support question.
  assert.equal(gate("status", ["--offline", "--json"]).result, "ok");
});

test("unknown flags and stray arguments are refused, naming what IS accepted", () => {
  const cases: [string, string[], RegExp][] = [
    ["login", ["--hepl"], /unknown flag "--hepl".*--fresh-profile, --switch-account, --verify/],
    ["status", ["--offlin"], /unknown flag "--offlin".*--verify, --offline, --json/],
    ["status", ["-j"], /unknown flag "-j"/],
    // Cross-command bleed: a flag that exists SOMEWHERE must not be accepted everywhere. These two
    // subcommands never even received argv before this change.
    ["trading-logout", ["--keep-profile"], /trading-logout accepts no flags/],
    ["trading-disable", ["--paper"], /trading-disable accepts no flags/],
    ["trading-forget", ["--paper"], /trading-forget accepts no flags/],
    ["login", ["now"], /unexpected argument "now"/],
    ["import-har", ["a.har", "b.har"], /takes at most 1 positional argument/],
    ["trading-enable", ["--paper", "--cash"], /--cash needs a value/],
    // His handler's own check (bin comment: "--elicitation --max-order-value 5000000") — the gate
    // fires first with the same verdict: a value flag followed by another flag has no value.
    ["trading-enable", ["--paper", "--elicitation"], /--elicitation needs a value/],
  ];
  for (const [cmd, argv, expected] of cases) {
    try {
      gate(cmd, argv);
      assert.fail(`${cmd} ${argv.join(" ")} was accepted`);
    } catch (err) {
      assert.ok(err instanceof CliParseError, String(err));
      assert.match(err.message, expected);
      assert.match(err.message, /--help/, "every refusal must point at the help");
    }
  }
});

test("--help answers for every subcommand without reaching any handler, even next to a typo", () => {
  for (const cmd of SUBCOMMANDS) {
    const plain = gate(cmd, ["--help"]);
    assert.equal(plain.result, "help", cmd);
    assert.ok(plain.help.includes(cmd), `${cmd} help names the command`);
    assert.equal(gate(cmd, ["-h"]).result, "help", `${cmd} -h`);
    assert.equal(gate(cmd, ["--bogus", "--help"]).result, "help", `${cmd}: help must beat the typo`);
  }
});

test("generated usage carries the load-bearing wording forward", () => {
  const status = formatUsage(AUTH_BIN, AUTH_COMMANDS, "status");
  assert.match(status, /ROTATES/, "the cost of --verify must stay in the help");
  assert.match(status, /--offline/);
  assert.match(status, /--json/);
  const har = formatUsage(AUTH_BIN, AUTH_COMMANDS, "import-har");
  assert.match(har, /Preserve log/, "the DevTools tutorial moved into the table; it must still print");
  const top = formatUsage(AUTH_BIN, AUTH_COMMANDS);
  for (const cmd of SUBCOMMANDS) assert.ok(top.includes(cmd), `top-level usage lists ${cmd}`);
});

/* ------------------------------ the bin itself, spawned ------------------------------ */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin", "stockbit-auth.ts");
const execFileAsync = promisify(execFile);

/**
 * Run the real CLI. The child gets its own empty store and the browser tripwire — see the header.
 * `--import tsx` from the repo root is the same loader `npm test` itself uses, so this is portable
 * exactly as far as the suite already is.
 *
 * `store` hands the child a directory the CALLER owns and keeps: the login-lock tests need to seed
 * `login.lock` before the run and to read the directory after it, which the disposable store this
 * makes by default has already deleted by the time the assertion runs.
 */
async function runCli(
  args: string[],
  opts: { store?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const childStore = opts.store ?? mkdtempSync(join(tmpdir(), "stockbit-authcli-child-"));
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
      STOCKBIT_NO_BROWSER: "1",
      STOCKBIT_BROWSER: join(childStore, "no-such-browser.exe"),
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
    if (!opts.store) rmSync(childStore, { recursive: true, force: true });
  }
}

test("login --help prints usage and never opens a browser — the 2026-08-29 incident, replayed", async () => {
  const r = await runCli(["login", "--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /--switch-account/);
  // "Opening a browser…" is cmdLogin's first line. If the gate were gone, the tripwire would exit 1
  // AFTER printing it — so this assertion, not the exit code, is what proves no handler ran.
  assert.doesNotMatch(r.stdout + r.stderr, /Opening a browser/);
});

test("login with an unknown flag refuses before doing anything", async () => {
  const r = await runCli(["login", "--bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag "--bogus"/);
  assert.match(r.stderr, /--fresh-profile/);
  assert.doesNotMatch(r.stdout + r.stderr, /Opening a browser/);
});

test("bare --help is exit 0 now, not the exit-2 accident it used to be", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /login/);
  assert.match(r.stdout, /trading-logout/);
});

test("status with an unknown flag is a usage error, exit 2", async () => {
  const r = await runCli(["status", "--bogus"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag "--bogus"/);
  assert.match(r.stderr, /--offline/);
});

test("status --offline --json still works end to end — the SECURITY.md path", async () => {
  const r = await runCli(["status", "--offline", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotThrow(() => JSON.parse(r.stdout), "the report must stay machine-readable");
});

test("an unknown subcommand still gets usage on stderr and exit 2", async () => {
  const r = await runCli(["definitely-not-a-command"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /Usage: stockbit-auth/);
});

/* ------------------------------ the login lock ------------------------------ */

/**
 * The hole P7g closed: `login.lock` is a five-gate safety property, and gate 5 of automatic login
 * recovery is "the lock is free". This bin took nothing, so that gate read FREE for the whole time
 * a `stockbit-auth login` was driving `~/.stockbit/browser-profile` — and an unattended recovery
 * could open a second browser onto the profile the user was typing their password into. The MCP
 * `login` tool's own comment names the CLI as the thing the lock protects against.
 *
 * Spawned rather than called, because the lock is a property of the PROCESS: the acquisition, the
 * refusal, and the release-on-exit all live in the bin, and the release in particular is an `exit`
 * listener that only exists in a real process.
 */
test("login refuses while another process holds the profile lock, before promising a window", async () => {
  const store = mkdtempSync(join(tmpdir(), "stockbit-authcli-held-"));
  // A bare directory, exactly as a holder that died mid-login would leave it: no owner token, so a
  // release from this run could only remove it by breaking the rule in `releaseDecision`.
  mkdirSync(join(store, "login.lock"), { recursive: true });
  try {
    const r = await runCli(["login"], { store });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Another login is already in progress/);
    assert.match(r.stderr, /lock is held on the browser profile/);
    // The refusal must come BEFORE cmdLogin's first line. "Opening a browser…" followed by a
    // refusal is a report of something that did not happen, and this is the assertion — not the
    // exit code — that proves no capture was reached.
    assert.doesNotMatch(r.stdout + r.stderr, /Opening a browser/);
    assert.ok(existsSync(join(store, "login.lock")), "a refused login must never delete the holder's lock");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("trading-login --browser takes the same lock — it drives the same profile", async () => {
  // The other CLI participant, and the one that is easy to forget: it reaches the identical
  // `captureViaBrowserLogin` on the identical default profile, so a PIN modal in one window and a
  // recovery launching into the other is the same wreck as two logins.
  //
  // Safe to spawn only because the lock is held: the refusal is the FIRST thing in the `--browser`
  // branch, so this run exits before any browser code is reached — which the "Opening the
  // logged-in browser" assertion below is what proves. (The PIN branch is deliberately not locked;
  // it posts to carina and opens nothing.)
  const store = mkdtempSync(join(tmpdir(), "stockbit-authcli-trading-"));
  mkdirSync(join(store, "login.lock"), { recursive: true });
  try {
    const r = await runCli(["trading-login", "--browser"], { store });
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Another login is already in progress/);
    assert.doesNotMatch(r.stdout + r.stderr, /Opening the logged-in browser/);
    assert.ok(existsSync(join(store, "login.lock")), "a refused capture must never delete the holder's lock");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test("a login that FAILS still releases the lock — a leak recreates the stale lock it prevents", async () => {
  // The failure path, not the happy one, because that is where a lock is lost: `cmdLogin` leaves
  // through `process.exit` in five places and a `finally` would run in none of them. Here the
  // browser tripwire makes `findBrowsers()` throw, so the run dies at the top-level `main().catch`
  // — the hardest of those paths — with the lock already taken.
  //
  // A leak is not a tidiness problem. `login.lock` is only broken as stale after twenty minutes, so
  // one leaked lock refuses every login AND every automatic recovery for that long, on behalf of a
  // process that has already exited. That is the condition `reap_orphans` was written to clean up.
  const store = mkdtempSync(join(tmpdir(), "stockbit-authcli-leak-"));
  try {
    const r = await runCli(["login"], { store });
    assert.equal(r.code, 1, "precondition: the tripwire must make this login fail");
    assert.match(r.stderr, /Opening a browser/, "precondition: it got past the lock and into the capture");
    assert.equal(existsSync(join(store, "login.lock")), false, "the lock outlived the process that held it");
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

test(
  "Ctrl-C during a login releases the lock — an exit listener alone does NOT run on a signal",
  {
    // Not a caveat on the FIX — a real console Ctrl-C on Windows does deliver SIGINT and does run
    // the handler, so the lock is released there too. What Windows lacks is the way this test
    // SIMULATES it: `child.kill("SIGINT")` terminates the process outright rather than delivering a
    // signal, so the handler never gets its chance and the assertion would fail for a reason that
    // says nothing about the behaviour under test.
    //
    // SIGTERM is separately a no-op on Windows — node cannot listen for it — which the handler
    // registration tolerates and nothing here can improve.
    //
    // Options go BEFORE the function: `test(name, options, fn)`. Passing them after the callback
    // parses fine and is silently ignored, which is how the first attempt at this skip shipped a
    // Windows failure that looked exactly like the bug it was meant to document.
    skip:
      process.platform === "win32"
        ? "child.kill('SIGINT') on Windows terminates without delivering the signal, so Ctrl-C cannot be simulated"
        : false,
  },
  async () => {
  // The regression this guards is specific and was nearly shipped. Node does not run `exit`
  // listeners when a signal terminates the process by default — measured: a script that registers
  // one and then sends itself SIGINT exits 130 without the listener printing. So releasing only
  // from `process.once("exit", …)` leaks `login.lock` on Ctrl-C.
  //
  // And Ctrl-C is not an edge case for THIS command: it hands a human fifteen minutes to type into
  // a browser window, so interrupting it is the ordinary way to change your mind. Before the CLI
  // took a lock at all, that cost nothing. With an exit-only release it would cost twenty minutes
  // in which every login and every unattended recovery is refused on behalf of a dead process —
  // a REGRESSION, not a leftover risk. Taking a lock is only an improvement if releasing it is at
  // least as reliable as never having taken it.
  const store = mkdtempSync(join(tmpdir(), "stockbit-authcli-sigint-"));
  try {
    // A "browser" that exists and then blocks, so the CLI gets past `findBrowsers()`, takes the
    // lock, and is still alive to be interrupted. The tripwire the other tests use exits at once,
    // which is the wrong shape for this one.
    const stub = join(store, "blocking-browser");
    writeFileSync(stub, "#!/bin/sh\nexec sleep 120\n", { mode: 0o755 });

    const child = spawn(process.execPath, ["--import", "tsx", BIN, "login"], {
      cwd: ROOT,
      env: {
        ...process.env,
        STOCKBIT_NO_UPDATE_CHECK: "1",
        STOCKBIT_FORCE_FILE_STORE: "1",
        STOCKBIT_STORE_DIR: store,
        STOCKBIT_BROWSER: stub,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });

    try {
      const lock = join(store, "login.lock");
      // Synchronise on the child's OWN output, not on the lock file appearing.
      //
      // `holdLoginLock` creates the lock directory inside `acquireLoginLock()` and registers the
      // signal handlers a few statements later, so "the lock exists" is true slightly BEFORE the
      // handlers are installed. Polling for the file and firing immediately raced that window —
      // fine when this file runs alone, and a real failure under the loaded machine of a full suite
      // run, which is exactly the kind of flake that gets muted rather than fixed.
      //
      // "Opening a browser…" is `cmdLogin`'s first line and it prints only AFTER `holdLoginLock`
      // has returned, so it is proof the handlers are in place. Deterministic, not a sleep.
      let seen = "";
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child never opened a browser; saw: ${seen}`)), 60_000);
        child.stderr?.on("data", (c) => {
          seen += String(c);
          if (seen.includes("Opening a browser")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`child exited before opening a browser; saw: ${seen}`));
        });
      });
      assert.ok(existsSync(lock), "precondition: the CLI must have taken the lock before we interrupt it");

      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.kill("SIGINT");
      await exited;

      assert.equal(existsSync(lock), false, "Ctrl-C left the lock behind, refusing every login for 20 minutes");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

/* ------------------------------ the wiring, by source scan ------------------------------ */

test("every dispatch case is in the table, and the gate runs before the switch", () => {
  // `doctor`, `logout`, `bootstrap` and the trading commands can never be spawned to prove their
  // wiring — proving it live IS the incident. So the proof is structural: read the bin, strip
  // comments (the login.test.ts pattern), and check the dispatch against the table.
  const source = readFileSync(join(ROOT, "bin", "stockbit-auth.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const labels = [...code.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]);
  assert.deepEqual(labels.sort(), Object.keys(AUTH_COMMANDS).sort(), "a case without a spec entry is ungated");

  const gateAt = code.indexOf("gateCommandLine(");
  const switchAt = code.indexOf("switch (cmd)");
  assert.ok(gateAt !== -1, "the bin must call gateCommandLine");
  assert.ok(switchAt !== -1, "the bin must still dispatch through switch (cmd)");
  assert.ok(gateAt < switchAt, "the gate must run BEFORE dispatch, or --help reaches the handlers again");
});
