/**
 * `stockbit-batch` — the planner, the window assertion, and the drip loop's stop conditions.
 *
 * The runner is exercised entirely against fakes. That is the point of injecting its dependencies:
 * a three-week, 120,000-request backfill has control flow that must be proven (does the kill-file
 * actually stop it? does the budget hold? does a wrong-window response stay out of the
 * checkpoint?), and none of those questions should need a network, a clock, or nine hours.
 *
 * The one spawned test is the `--help` gate, for the reason `src/cliargs.ts` documents: this bin's
 * worst case of that bug is `broker --help` starting an overnight run against Darren's own session.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const STORE = mkdtempSync(join(tmpdir(), "stockbit-batch-test-"));
process.env.STOCKBIT_FORCE_FILE_STORE = "1";
process.env.STOCKBIT_STORE_DIR = STORE;

import { test, after } from "node:test";
import assert from "node:assert/strict";

import { CliParseError, gateCommandLine } from "../src/cliargs.ts";
import { BATCH_BIN, BATCH_COMMANDS } from "../src/batch/cli.ts";
import { itemKey, plan, planSummary, sessionDates, type WorkItem } from "../src/batch/planner.ts";
import { run, type RunnerDeps } from "../src/batch/runner.ts";
import { verifyBars, verifyBrokerWindow } from "../src/batch/verify.ts";

const execFileAsync = promisify(execFile);
after(() => rmSync(STORE, { recursive: true, force: true }));

/* ------------------------------------- planner ------------------------------------- */

test("bars plan one item per symbol — getBars pages the range itself", () => {
  const items = plan({ kind: "bars", symbols: ["BBCA", "ANTM"], from: "2026-08-03", to: "2026-08-28" });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.symbol), ["BBCA", "ANTM"]);
  assert.equal(items[0].from, "2026-08-03");
  assert.equal(items[0].to, "2026-08-28");
});

test("broker plan one item per symbol AND session — the 120k number", () => {
  // 2026-08-03 (Mon) .. 2026-08-07 (Fri) = 5 sessions.
  const items = plan({ kind: "broker", symbols: ["BBCA", "ANTM"], from: "2026-08-03", to: "2026-08-07" });
  assert.equal(items.length, 10);
  for (const item of items) assert.equal(item.from, item.to, "a broker window must be one session");
});

test("weekends are not planned", () => {
  const dates = sessionDates("2026-08-07", "2026-08-10"); // Fri, Sat, Sun, Mon
  assert.deepEqual(dates, ["2026-08-07", "2026-08-10"]);
});

test("holidays are deliberately NOT modelled", () => {
  // 2026-08-17 is Indonesian Independence Day — a real IDX holiday, and it IS planned. A hard-coded
  // holiday table goes stale and then silently skips real sessions; one wasted request that comes
  // back empty is the cheaper error. See the planner's docstring.
  assert.ok(sessionDates("2026-08-17", "2026-08-17").includes("2026-08-17"));
});

test("default order is most-recent-first, date-major", () => {
  const items = plan({ kind: "broker", symbols: ["AAAA", "BBBB"], from: "2026-08-03", to: "2026-08-05" });
  // An interruption must leave every symbol covering the newest sessions, not a few symbols
  // covering everything.
  assert.deepEqual(items.slice(0, 2).map((i) => `${i.symbol}@${i.from}`), ["AAAA@2026-08-05", "BBBB@2026-08-05"]);
  assert.equal(items[items.length - 1].from, "2026-08-03");
});

test("symbol-major order is available when asked for", () => {
  const items = plan({ kind: "broker", symbols: ["AAAA", "BBBB"], from: "2026-08-03", to: "2026-08-04", order: "symbol-major" });
  assert.deepEqual(items.map((i) => `${i.symbol}@${i.from}`),
    ["AAAA@2026-08-03", "AAAA@2026-08-04", "BBBB@2026-08-03", "BBBB@2026-08-04"]);
});

test("resume skips checkpointed keys and nothing else", () => {
  const done = new Set([itemKey("broker", "BBCA", "2026-08-05", "2026-08-05")]);
  const items = plan({ kind: "broker", symbols: ["BBCA"], from: "2026-08-03", to: "2026-08-05", done });
  assert.equal(items.length, 2);
  assert.ok(!items.some((i) => i.from === "2026-08-05"));
});

test("planSummary reports progress without re-planning by hand", () => {
  const done = new Set([itemKey("broker", "BBCA", "2026-08-05", "2026-08-05")]);
  const summary = planSummary({ kind: "broker", symbols: ["BBCA"], from: "2026-08-03", to: "2026-08-05", done });
  assert.deepEqual(summary, { total: 3, done: 1, remaining: 2 });
});

test("limit is applied after ordering, so a capped run is a coherent prefix", () => {
  const items = plan({ kind: "broker", symbols: ["AAAA", "BBBB"], from: "2026-08-03", to: "2026-08-07", limit: 3 });
  assert.equal(items.length, 3);
  assert.equal(items[0].from, "2026-08-07");
});

test("duplicate symbols are collapsed", () => {
  const items = plan({ kind: "bars", symbols: ["BBCA", "bbca", " BBCA "], from: "2026-08-03", to: "2026-08-07" });
  assert.equal(items.length, 1);
});

test("an unusable range or empty symbol list fails before a long run starts", () => {
  assert.throws(() => plan({ kind: "bars", symbols: ["BBCA"], from: "2026-08-28", to: "2026-08-03" }), /after/);
  assert.throws(() => plan({ kind: "bars", symbols: [], from: "2026-08-03", to: "2026-08-07" }), /empty/);
  assert.throws(() => plan({ kind: "bars", symbols: ["BBCA"], from: "03-08-2026", to: "2026-08-07" }), /YYYY-MM-DD/);
});

/* -------------------------------------- verify -------------------------------------- */

test("a broker response covering the requested session passes", () => {
  const verdict = verifyBrokerWindow({ from: "2026-08-03", to: "2026-08-03" }, { from: "2026-08-03", to: "2026-08-03" });
  assert.equal(verdict.ok, true);
});

test("THE trap: a response bearing the latest session instead of the requested one is refused", () => {
  // The documented failure — HTTP 200, no error, today's numbers answering a question about
  // February. Trusted, it would write one session into hundreds of rows.
  const verdict = verifyBrokerWindow({ from: "2026-02-17", to: "2026-02-17" }, { from: "2026-08-28", to: "2026-08-28" });
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /LATEST session/);
  assert.match(verdict.ok === false ? verdict.observed : "", /2026-02-17.*2026-08-28/);
});

test("a response that will not say which dates it covers is refused, not assumed", () => {
  const verdict = verifyBrokerWindow({ from: "2026-08-03", to: "2026-08-03" }, {});
  assert.equal(verdict.ok, false);
  assert.match(verdict.ok === false ? verdict.reason : "", /did not state which dates/);
});

test("bars inside the window pass; bars outside it do not", () => {
  const window = { from: "2026-08-03", to: "2026-08-05" };
  assert.equal(verifyBars(window, { bars: [{ date: "2026-08-03" }, { date: "2026-08-05" }] }).ok, true);
  const bad = verifyBars(window, { bars: [{ date: "2026-08-03" }, { date: "2026-09-01" }] });
  assert.equal(bad.ok, false);
});

test("an empty bar series is an observation, not a failure", () => {
  // Holidays are not modelled and a thin name may simply not trade. Treating this as an error would
  // make the circuit breaker trip on a public holiday.
  const verdict = verifyBars({ from: "2026-08-17", to: "2026-08-17" }, { bars: [] });
  assert.equal(verdict.ok, true);
  assert.match(verdict.ok === true ? verdict.note ?? "" : "", /holiday|did not trade/);
});

test("out-of-order, duplicated or truncated series are refused", () => {
  const window = { from: "2026-08-03", to: "2026-08-05" };
  assert.equal(verifyBars(window, { bars: [{ date: "2026-08-05" }, { date: "2026-08-03" }] }).ok, false);
  assert.equal(verifyBars(window, { bars: [{ date: "2026-08-03" }, { date: "2026-08-03" }] }).ok, false);
  assert.equal(verifyBars(window, { bars: [{ date: "2026-08-03" }], truncated: true }).ok, false);
});

/* -------------------------------------- runner -------------------------------------- */

function fakeDeps(overrides: Partial<RunnerDeps> = {}) {
  const persisted: string[] = [];
  const checkpointed: string[] = [];
  const sleeps: number[] = [];
  const deps: RunnerDeps = {
    fetch: async () => ({ ok: true }),
    verify: () => ({ ok: true }),
    persist: async (item) => { persisted.push(item.key); },
    markDone: async (item) => { checkpointed.push(item.key); },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => new Date("2026-08-29T22:00:00Z"),
    killed: () => false,
    isTradingHours: () => false,
    random: () => 0,
    ...overrides,
  };
  return { deps, persisted, checkpointed, sleeps };
}

const items = (n: number): WorkItem[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: "broker" as const, symbol: "BBCA", from: `2026-08-0${i + 1}`, to: `2026-08-0${i + 1}`,
    key: `broker:BBCA:2026-08-0${i + 1}`,
  }));

test("a clean run persists and checkpoints every item", async () => {
  const { deps, persisted, checkpointed } = fakeDeps();
  const result = await run({ items: items(3), rateMs: 10 }, deps);
  assert.equal(result.stoppedBecause, "complete");
  assert.equal(result.succeeded, 3);
  assert.equal(persisted.length, 3);
  assert.deepEqual(checkpointed, persisted, "a key is checkpointed only after its payload is written");
});

test("throttling happens between requests, never before the first", async () => {
  const { deps, sleeps } = fakeDeps();
  await run({ items: items(3), rateMs: 1750, jitterMs: 0 }, deps);
  assert.deepEqual(sleeps, [1750, 1750], "a resumed run must not burst, and must not stall on entry");
});

test("the kill-file stops within one request", async () => {
  let calls = 0;
  const { deps, checkpointed } = fakeDeps({ killed: () => calls >= 2 });
  const original = deps.fetch;
  deps.fetch = async (item) => { calls++; return original(item); };

  const result = await run({ items: items(6), rateMs: 0 }, deps);
  assert.equal(result.stoppedBecause, "killed");
  assert.equal(checkpointed.length, 2);
  assert.equal(result.remaining, 4);
});

test("trading hours stop a run that did not ask to override them", async () => {
  const { deps } = fakeDeps({ isTradingHours: () => true });
  const result = await run({ items: items(4), rateMs: 0, offHoursOnly: true }, deps);
  assert.equal(result.stoppedBecause, "market-open");
  assert.equal(result.attempted, 0, "not one request may go out while the interactive session is in use");
});

test("--force runs during trading hours", async () => {
  const { deps } = fakeDeps({ isTradingHours: () => true });
  const result = await run({ items: items(2), rateMs: 0, offHoursOnly: false }, deps);
  assert.equal(result.stoppedBecause, "complete");
  assert.equal(result.attempted, 2);
});

test("the request budget is a ceiling, not a suggestion", async () => {
  const { deps } = fakeDeps();
  const result = await run({ items: items(9), rateMs: 0, maxRequests: 4 }, deps);
  assert.equal(result.attempted, 4);
  assert.equal(result.stoppedBecause, "budget-spent");
});

test("a wrong-window response is never checkpointed", async () => {
  const { deps, persisted, checkpointed } = fakeDeps({
    verify: () => ({ ok: false, reason: "latest session", observed: "x" }),
  });
  const result = await run({ items: items(3), rateMs: 0, maxConsecutiveFailures: 99 }, deps);
  assert.equal(result.succeeded, 0);
  assert.equal(persisted.length, 0, "wrong-window data must not reach the raw zone");
  assert.equal(checkpointed.length, 0, "and the key must stay open so the next pass retries it");
  assert.equal(result.failed, 3);
});

test("one bad symbol-day does not abort the run", async () => {
  let n = 0;
  const { deps, checkpointed } = fakeDeps({
    fetch: async () => { if (++n === 2) throw new Error("transient 502"); return { ok: true }; },
  });
  const result = await run({ items: items(4), rateMs: 0 }, deps);
  assert.equal(result.stoppedBecause, "complete");
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 1);
  assert.ok(!checkpointed.includes("broker:BBCA:2026-08-02"), "the failed key stays open for retry");
});

test("consecutive failures trip the circuit breaker instead of hammering a broken API", async () => {
  const { deps } = fakeDeps({ fetch: async () => { throw new Error("401 unauthorized"); } });
  const result = await run({ items: items(50), rateMs: 0, maxConsecutiveFailures: 3 }, deps);
  assert.equal(result.stoppedBecause, "too-many-failures");
  assert.equal(result.attempted, 3, "stop at the breaker, not 50 requests later");
});

test("a success resets the consecutive-failure counter", async () => {
  let n = 0;
  const { deps } = fakeDeps({
    fetch: async () => { n++; if (n % 2 === 0) throw new Error("flaky"); return { ok: true }; },
  });
  const result = await run({ items: items(8), rateMs: 0, maxConsecutiveFailures: 3 }, deps);
  assert.equal(result.stoppedBecause, "complete", "alternating failures are not a systemic outage");
});

/* ---------------------------------- the --help gate ---------------------------------- */

const SUBCOMMANDS = ["plan", "bars", "broker", "probe", "status"];

test("the table covers exactly the commands the bin dispatches", () => {
  assert.deepEqual(Object.keys(BATCH_COMMANDS).sort(), [...SUBCOMMANDS].sort());
});

test("unknown flags are refused, naming the token", () => {
  assert.throws(
    () => gateCommandLine(BATCH_BIN, BATCH_COMMANDS, "broker", ["--yolo"], () => {}),
    (err: unknown) => err instanceof CliParseError && /--yolo/.test(err.message),
  );
});

test("--help is answered for every command and never falls through", () => {
  for (const cmd of SUBCOMMANDS) {
    let written = "";
    const outcome = gateCommandLine(BATCH_BIN, BATCH_COMMANDS, cmd, ["--help"], (t) => { written += t; });
    assert.equal(outcome, "help", `${cmd} --help must not reach the handler`);
    assert.match(written, new RegExp(cmd));
  }
});

test("`broker --help` returns immediately instead of starting an overnight drip", async () => {
  // The spawned proof. If the gate were removed this would attempt a real backfill and the child
  // would run until the timeout killed it — a loud failure, and no requests either way because the
  // temp store holds no session.
  // `fileURLToPath`, never `.pathname`. `.pathname` returns `/C:/Users/...` on Windows but
  // `/home/runner/...` on POSIX, so stripping the leading slash to repair the Windows form DELETES
  // THE ROOT everywhere else: the absolute path becomes relative, resolves against the repo
  // directory, and the child dies with ERR_MODULE_NOT_FOUND for
  // `<repo>/home/runner/work/stockbit-mcp/stockbit-mcp/bin/stockbit-batch.ts`. That is exactly how
  // this shipped — green on both Windows runners, red on Ubuntu and macOS, which blocked the 1.2.3
  // publish. `fileURLToPath` is the conversion that knows the difference, and it percent-decodes,
  // so a checkout path containing a space survives too.
  const bin = fileURLToPath(new URL("../bin/stockbit-batch.ts", import.meta.url));
  // Checked here rather than left to the child, because the child's complaint was an
  // ERR_MODULE_NOT_FOUND stack fifteen frames deep inside tsx's resolver, which says nothing about
  // the path having been mangled by the caller.
  assert.ok(existsSync(bin), `the CLI to spawn does not exist at ${bin}`);
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", bin, "broker", "--help"],
    { timeout: 30_000, env: { ...process.env, STOCKBIT_STORE_DIR: STORE, STOCKBIT_NO_UPDATE_CHECK: "1" } },
  );
  assert.match(stdout, /broker/);
  assert.match(stdout, /--kill-file/);
});
