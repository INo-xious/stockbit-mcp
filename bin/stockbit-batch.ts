#!/usr/bin/env node
/**
 * The historical backfill puller: many small requests, spread over many nights.
 *
 *   stockbit-batch plan   --kind broker --symbols-file u.txt --from 2024-09-02 --to 2026-08-28
 *   stockbit-batch bars   --symbols-file u.txt --from 2024-09-02 --to 2026-08-28 --out ./raw
 *   stockbit-batch broker --symbols-file u.txt --from 2024-09-02 --to 2026-08-28 --out ./raw \
 *                         --max-requests 8000 --kill-file ./STOP
 *   stockbit-batch probe  --symbols BBCA,ANTM,BUMI --from 2026-08-22 --to 2026-08-28
 *   stockbit-batch status --kind broker --symbols-file u.txt --from ... --to ...
 *
 * ## Why a CLI and not an MCP tool
 *
 * The same reason `stockbit-live` gives, taken further. A tool call has to return; this one runs
 * for nine hours. It also has to survive a reboot, be stoppable by a person who is not at a
 * keyboard, and refuse to run while the interactive tools are using the same session — none of
 * which fits inside a request/response.
 *
 * ## The one number worth internalising
 *
 * `broker_summary` aggregates its whole window into a single buyers/sellers table, so per-day
 * bandar behaviour costs one request per (symbol, session). For 239 symbols over two years that is
 * ~120,000 requests. This bin exists to spend them politely: off-hours, throttled, jittered,
 * checkpointed after every single one, and stoppable by touching a file.
 *
 * ## Safety, in the order it matters
 *
 * 1. Fetching commands refuse to run during IDX trading hours unless `--force`. The refresh token
 *    is single-use and rotates; two processes refreshing at once invalidate each other and lock the
 *    account out until a manual browser login. That is measured, not theoretical (2026-08-29).
 * 2. Every response is checked against the window that was requested before it is written. The
 *    broker endpoint answers a bad date request with HTTP 200 and the LATEST session, so a
 *    backfill that trusts its own request would write one Tuesday into five hundred rows.
 * 3. A key is checkpointed only after its payload is durably written. Crash between the two and the
 *    next run re-fetches; crash the other way round and the gap would be invisible forever.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { getBars, MAX_PAGES, ROWS_PER_PAGE } from "../src/core/bars.js";
import { getBrokerSummary } from "../src/core/marketdetectors.js";
import { sessionClock } from "../src/core/sessionclock.js";
import { RATE } from "../src/config.js";
import { CliParseError, formatUsage, gateCommandLine, isHelpToken, isVersionToken } from "../src/cliargs.js";
import { VERSION } from "../src/version.js";
import { BATCH_BIN, BATCH_COMMANDS, BATCH_EPILOGUE } from "../src/batch/cli.js";
import { plan, planSummary, sessionDates, type BatchKind, type PlanOrder, type WorkItem } from "../src/batch/planner.js";
import { run, type ProgressEvent } from "../src/batch/runner.js";
import { verifyBars, verifyBrokerWindow, type WindowVerdict } from "../src/batch/verify.js";

const DEFAULT_RATE_MS = 1750;
const DEFAULT_JITTER_MS = 500;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

function numberFlag(name: string, fallback: number): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/** Symbols from `--symbols A,B` or `--symbols-file path`. Blank lines and `#` comments ignored. */
function loadSymbols(): string[] {
  const inline = value("symbols");
  const file = value("symbols-file");
  if (inline && file) throw new Error("give --symbols or --symbols-file, not both");

  if (inline) {
    return inline.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (file) {
    const path = resolve(file);
    if (!existsSync(path)) throw new Error(`--symbols-file not found: ${path}`);
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.split("#")[0].trim())
      .filter(Boolean);
  }
  throw new Error("no symbols: pass --symbols BBCA,ANTM or --symbols-file <path>");
}

function requireDates(): { from: string; to: string } {
  const from = value("from");
  const to = value("to");
  if (!from || !to) throw new Error("both --from and --to are required (YYYY-MM-DD)");
  return { from, to };
}

function kindFlag(): BatchKind {
  const raw = value("kind");
  if (raw !== "bars" && raw !== "broker") {
    throw new Error(`--kind must be bars or broker, got ${JSON.stringify(raw ?? "(absent)")}`);
  }
  return raw;
}

function orderFlag(): PlanOrder {
  const raw = value("order") ?? "recent-first";
  if (raw !== "recent-first" && raw !== "oldest-first" && raw !== "symbol-major") {
    throw new Error(`--order must be recent-first, oldest-first or symbol-major, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function outDir(): string {
  return resolve(value("out") ?? "./raw");
}

function checkpointPath(): string {
  return resolve(value("checkpoint") ?? join(outDir(), "checkpoint.ndjson"));
}

/**
 * Completed keys from the checkpoint.
 *
 * NDJSON, append-only. A rewritten JSON blob would be one interrupted write away from losing weeks
 * of progress; appending one line per completed item cannot corrupt what came before it.
 */
function loadCheckpoint(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const keys = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return new Set(keys);
}

function rawPathFor(root: string, item: WorkItem): string {
  const name = item.from === item.to ? `${item.from}.json` : `${item.from}_${item.to}.json`;
  return join(root, item.kind, item.symbol, name);
}

function writeRaw(root: string, item: WorkItem, payload: unknown): void {
  const target = rawPathFor(root, item);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(payload, null, 1), "utf8");
}

async function fetchItem(item: WorkItem): Promise<unknown> {
  return item.kind === "bars"
    ? await getBars({ symbol: item.symbol, from: item.from, to: item.to })
    : await getBrokerSummary({ symbol: item.symbol, from: item.from, to: item.to });
}

function verifyItem(item: WorkItem, payload: unknown): WindowVerdict {
  const window = { from: item.from, to: item.to };
  return item.kind === "bars"
    ? verifyBars(window, payload as { bars: { date: string }[]; truncated?: boolean; pagesFetched?: number })
    : verifyBrokerWindow(window, payload as { from?: string; to?: string });
}

function describeStop(reason: string): string {
  switch (reason) {
    case "killed": return "stopped: kill-file present";
    case "market-open": return "stopped: IDX is open — backfilling now competes with the interactive session (use --force to override)";
    case "budget-spent": return "stopped: --max-requests reached";
    case "too-many-failures": return "STOPPED: too many consecutive failures — something systemic is wrong (token? network? endpoint?). Nothing further was attempted.";
    case "aborted": return "stopped: interrupted";
    default: return "complete";
  }
}

async function fetchCommand(kind: BatchKind): Promise<void> {
  const symbols = loadSymbols();
  const { from, to } = requireDates();
  const root = outDir();
  const ckpt = checkpointPath();
  const force = flag("force");
  const killFile = value("kill-file");

  const items = plan({ kind, symbols, from, to, done: loadCheckpoint(ckpt), order: orderFlag() });
  const summary = planSummary({ kind, symbols, from, to, done: loadCheckpoint(ckpt) });

  console.log(`${kind}: ${summary.remaining.toLocaleString()} of ${summary.total.toLocaleString()} requests remaining (${summary.done.toLocaleString()} already done)`);
  console.log(`out: ${root}`);
  console.log(`checkpoint: ${ckpt}`);
  if (killFile) console.log(`kill-file: ${resolve(killFile)} — touch it to stop cleanly`);
  if (!items.length) {
    console.log("nothing to do.");
    return;
  }

  mkdirSync(dirname(ckpt), { recursive: true });

  let lastReport = 0;
  const started = Date.now();
  const result = await run(
    {
      items,
      rateMs: numberFlag("rate-ms", DEFAULT_RATE_MS),
      jitterMs: numberFlag("jitter-ms", DEFAULT_JITTER_MS),
      offHoursOnly: !force,
      maxRequests: value("max-requests") ? numberFlag("max-requests", Infinity) : undefined,
    },
    {
      fetch: fetchItem,
      verify: verifyItem,
      async persist(item, payload) {
        writeRaw(root, item, payload);
      },
      async markDone(item) {
        // Only ever after persist returned. See the header note on crash ordering.
        appendFileSync(ckpt, `${item.key}\n`, "utf8");
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => new Date(),
      killed: () => Boolean(killFile) && existsSync(resolve(killFile as string)),
      isTradingHours: (now) => sessionClock(now).isTradingHours,
      onProgress(event: ProgressEvent) {
        if (event.outcome !== "ok") {
          console.error(`   ${event.outcome}  ${event.item.key}  ${event.detail ?? ""}`);
          return;
        }
        // One line a minute, not one a request: a nine-hour log nobody can read is not a log.
        const now = Date.now();
        if (now - lastReport < 60_000) return;
        lastReport = now;
        const done = event.index + 1;
        const rate = done / ((now - started) / 1000);
        const etaMin = rate > 0 ? Math.round((items.length - done) / rate / 60) : 0;
        console.log(`   ${done.toLocaleString()}/${items.length.toLocaleString()}  ${event.item.key}  ~${etaMin} min left`);
      },
    },
  );

  console.log("");
  console.log(describeStop(result.stoppedBecause));
  console.log(`attempted ${result.attempted.toLocaleString()}  ok ${result.succeeded.toLocaleString()}  failed ${result.failed.toLocaleString()}  remaining ${result.remaining.toLocaleString()}`);
  for (const failure of result.failures.slice(0, 10)) {
    console.error(`   ${failure.key}: ${failure.reason}`);
  }
  if (result.failures.length > 10) console.error(`   ...and ${result.failures.length - 10} more`);
  if (result.stoppedBecause === "too-many-failures") process.exitCode = 1;
}

/**
 * Upstream HTTP requests one work item costs.
 *
 * For broker it is 1: one session, one call. For bars it is the page walk, and conflating the two
 * would under-report a bars backfill by a factor of forty — `plan` exists to state the cost before
 * it is spent, so the number it prints has to be the real one.
 */
function requestsPerItem(kind: BatchKind, from: string, to: string): number {
  if (kind === "broker") return 1;
  const sessions = sessionDates(from, to).length;
  return Math.min(MAX_PAGES, Math.max(1, Math.ceil(sessions / ROWS_PER_PAGE)));
}

function planCommand(): void {
  const kind = kindFlag();
  const symbols = loadSymbols();
  const { from, to } = requireDates();
  const summary = planSummary({ kind, symbols, from, to, done: loadCheckpoint(checkpointPath()) });

  const perItem = requestsPerItem(kind, from, to);
  const upstream = summary.remaining * perItem;
  const betweenItemsMs = numberFlag("rate-ms", DEFAULT_RATE_MS) + numberFlag("jitter-ms", DEFAULT_JITTER_MS) / 2;
  // Two paces compose: this bin's delay between work items, and the HTTP layer's own minimum
  // spacing, which is what actually governs a bars page walk.
  const hours = (summary.remaining * betweenItemsMs + upstream * RATE.minSpacingMs) / 3_600_000;

  console.log(`kind:      ${kind}`);
  console.log(`symbols:   ${symbols.length}`);
  console.log(`window:    ${from} .. ${to}`);
  console.log(`work items: ${summary.total.toLocaleString()} total, ${summary.done.toLocaleString()} done, ${summary.remaining.toLocaleString()} remaining`);
  if (perItem > 1) {
    console.log(`upstream:  ~${upstream.toLocaleString()} HTTP requests (${perItem} pages per symbol; getBars walks ${ROWS_PER_PAGE} sessions a page)`);
  } else {
    console.log(`upstream:  ${upstream.toLocaleString()} HTTP requests (one per session)`);
  }
  console.log(`estimate:  ${hours.toFixed(1)} hours of wall clock at the configured pace`);
  console.log("");
  console.log("No requests were made. Run the fetch command when you are happy with those numbers.");
}

async function probeCommand(): Promise<void> {
  const symbols = loadSymbols();
  const { from, to } = requireDates();
  const root = outDir();

  console.log(`probing ${symbols.length} symbol(s), ${from} .. ${to}`);
  let failures = 0;

  for (const symbol of symbols) {
    for (const kind of ["bars", "broker"] as const) {
      const items = plan({ kind, symbols: [symbol], from, to, order: "oldest-first", limit: 1 });
      if (!items.length) continue;
      const item = items[0];
      try {
        const payload = await fetchItem(item);
        const verdict = verifyItem(item, payload);
        writeRaw(root, item, payload);
        if (verdict.ok) {
          console.log(`   ok    ${item.key}${verdict.note ? `  (${verdict.note})` : ""}`);
        } else {
          failures++;
          console.error(`   FAIL  ${item.key}  ${verdict.reason}  [${verdict.observed}]`);
        }
      } catch (err) {
        failures++;
        console.error(`   ERROR ${item.key}  ${err instanceof Error ? err.message : String(err)}`);
      }
      await new Promise((r) => setTimeout(r, DEFAULT_RATE_MS));
    }
  }

  console.log("");
  console.log(failures ? `${failures} probe(s) failed — do not start a long run` : `all probes passed; raw responses written to ${root}`);
  if (failures) process.exitCode = 1;
}

function statusCommand(): void {
  const kind = kindFlag();
  const symbols = loadSymbols();
  const { from, to } = requireDates();
  const ckpt = checkpointPath();
  const summary = planSummary({ kind, symbols, from, to, done: loadCheckpoint(ckpt) });
  const pct = summary.total ? (100 * summary.done) / summary.total : 0;

  console.log(`${kind}  ${summary.done.toLocaleString()}/${summary.total.toLocaleString()} (${pct.toFixed(1)}%)  remaining ${summary.remaining.toLocaleString()}`);
  console.log(`checkpoint: ${ckpt}${existsSync(ckpt) ? "" : "  (does not exist yet)"}`);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "";
  const rest = process.argv.slice(3);

  // `--version` as the command word: the package's own answer about itself, on stdout, exit 0.
  if (isVersionToken(command)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (!command || command === "help" || isHelpToken(command)) {
    const topic = rest[0];
    if (topic !== undefined && !(topic in BATCH_COMMANDS)) {
      console.error(`Unknown command ${JSON.stringify(topic)}. Use ${Object.keys(BATCH_COMMANDS).join(", ")}.`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(formatUsage(BATCH_BIN, BATCH_COMMANDS, topic, BATCH_EPILOGUE));
    return;
  }

  // The gate runs before ANY dispatch, so `broker --help` can never start an overnight drip.
  try {
    if (gateCommandLine(BATCH_BIN, BATCH_COMMANDS, command, rest, (text) => process.stdout.write(text)) === "help") {
      return;
    }
  } catch (err) {
    if (err instanceof CliParseError) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  switch (command) {
    case "plan": return planCommand();
    case "bars": return await fetchCommand("bars");
    case "broker": return await fetchCommand("broker");
    case "probe": return await probeCommand();
    case "status": return statusCommand();
    default:
      console.error(`Unknown command ${JSON.stringify(command)}. Use ${Object.keys(BATCH_COMMANDS).join(", ")}.`);
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
