/**
 * `stockbit-mcp` — the command line, and the proof that asking about the server does not START one.
 *
 * The defect this replays: `bin/stockbit-mcp.ts` read `process.argv` nowhere. It was the only one
 * of the five bins not gated through `src/cliargs.ts`, so every token on its command line fell
 * through to "connect an MCP server on stdio" — `--version` included. Asking the package what
 * version it was therefore produced a running server, no version, and exit 0 when stdin closed.
 * With `npx` caching a caret range, the installed version is exactly the thing a stale user needs
 * to read, and it was the one question this bin could not answer.
 *
 * The bin is SPAWNED rather than imported, so `main()` itself is on trial — the same reason
 * `authcli.test.ts` spawns. Importing it would prove the spec and not the wiring, and the wiring is
 * where the bug was.
 *
 * **What makes these assertions non-vacuous.** Every case below asserts the startup line
 * ("connected over stdio", written to stderr by `logStderr`) is ABSENT. That is only evidence if
 * the line appears when a server really does start, so the last test spawns the bin with no
 * arguments and asserts it IS there. If the gate were deleted, that control keeps passing and every
 * other test fails — which is the shape a regression test should have.
 *
 * Spawning bare is safe and terminates: `execFile` gives the child no stdin, so the transport sees
 * an immediate EOF and the process exits on its own. That is the behaviour the field report
 * observed, used here as the control.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-mcpcli-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";

after(() => rmSync(STORE, { recursive: true, force: true }));

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(ROOT, "bin", "stockbit-mcp.ts");

/** The line the server writes to stderr once the transport is live. Absence of it is the assertion. */
const STARTED = /connected over stdio/;

/**
 * Run the real bin and collect its three outputs.
 *
 * `spawn` rather than `execFile` specifically for stdin: `execFile` always gives the child a pipe
 * on fd 0 and never closes it, so the no-argument control would sit on an open stdin until the
 * timeout and report a kill instead of a clean exit. `stdio[0] = "ignore"` is /dev/null, the
 * transport reads EOF at once, and the control exits 0 in under a second.
 */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const childStore = mkdtempSync(join(tmpdir(), "stockbit-mcpcli-child-"));
  const env = {
    ...process.env,
    STOCKBIT_FORCE_FILE_STORE: "1",
    STOCKBIT_STORE_DIR: childStore,
    STOCKBIT_NO_BROWSER: "1",
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      rmSync(childStore, { recursive: true, force: true });
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(childStore, { recursive: true, force: true });
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** The manifest npm installed — the same one `src/version.ts` walks up to find. */
function manifestVersion(): string {
  const raw = readFileSync(join(ROOT, "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

test("--version prints the installed version and starts no server", async () => {
  const r = await runCli(["--version"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), manifestVersion());
  assert.doesNotMatch(r.stderr, STARTED);
});

test("-v is the same question", async () => {
  const r = await runCli(["-v"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), manifestVersion());
  assert.doesNotMatch(r.stderr, STARTED);
});

test("the version goes to stdout, because it exits before stdout becomes the JSON-RPC stream", async () => {
  // Everything the RUNNING server says goes to stderr through `logStderr`, since stdout belongs to
  // the transport. `--version` is the one thing allowed on stdout: it answers and exits without
  // ever connecting, so a client parsing stdout as JSON-RPC is never in the picture.
  const r = await runCli(["--version"]);
  assert.equal(r.stderr, "");
  assert.ok(r.stdout.length > 0);
});

test("--help prints usage, names both flags, and starts no server", async () => {
  const r = await runCli(["--help"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Usage: stockbit-mcp/);
  assert.match(r.stdout, /--version/);
  assert.match(r.stdout, /STOCKBIT_TOOLS/);
  assert.doesNotMatch(r.stderr, STARTED);
});

test("an unknown flag is a usage error, not a silently started server", async () => {
  const r = await runCli(["--verison"]);
  assert.equal(r.code, 2);
  // Names the bad token and what the bin does accept — the `src/cliargs.ts` contract.
  assert.match(r.stderr, /unknown flag "--verison"/);
  assert.match(r.stderr, /--version/);
  assert.doesNotMatch(r.stderr, STARTED);
  assert.equal(r.stdout, "");
});

test("a stray positional is refused too", async () => {
  const r = await runCli(["wat"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unexpected argument "wat"/);
  assert.doesNotMatch(r.stderr, STARTED);
});

test("NEGATIVE CONTROL: with no arguments the server really does start", async () => {
  // Without this, every `doesNotMatch(STARTED)` above would keep passing if the startup line were
  // renamed or the server stopped starting at all, and the suite would be asleep.
  const r = await runCli([]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, STARTED);
});

/* ---------------------------- the same question, of every bin ---------------------------- */

/**
 * Hard-coded rather than read from `package.json`, on the `WRITES`-list principle: a list derived
 * from the manifest would agree with the manifest even when the manifest is the thing that is
 * wrong. A bin added to `package.json` must be added here consciously.
 */
const SHIPPED_BINS = [
  "stockbit-mcp",
  "stockbit-auth",
  "stockbit-live",
  "stockbit-alerts",
  "stockbit-batch",
] as const;

test("every shipped bin answers --version with the same version, and runs nothing", async () => {
  // `stockbit-mcp` was the one that could not, but the report's wider point was that NONE of them
  // could: there was no way to ask the installed package what it was from a command line at all.
  // One version for five bins, because they are one package.
  for (const name of SHIPPED_BINS) {
    const bin = join(ROOT, "bin", `${name}.ts`);
    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", bin, "--version"], {
        cwd: ROOT,
        env: { ...process.env, STOCKBIT_FORCE_FILE_STORE: "1", STOCKBIT_STORE_DIR: STORE, STOCKBIT_NO_BROWSER: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), manifestVersion(), name);
  }
});
