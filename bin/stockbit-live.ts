#!/usr/bin/env node
/**
 * The live market sampler's entry point: measure what traded over one window, print it, exit.
 *
 *   stockbit-live scan BBCA,ANTM 30s        two readings 30s apart, ranked by rupiah
 *   stockbit-live scan watchlist 1m         ...over the user's default watchlist
 *   stockbit-live scan watchlist:Bandar 5m  ...over a named one
 *   stockbit-live scan all 5m               ...over the ~100 most active symbols
 *   stockbit-live scan BBCA 30s --top 5     cap the rows printed (default 10)
 *   stockbit-live scan BBCA 30s --always    measure even outside IDX hours
 *   stockbit-live scan BBCA 30s --pretty    indented JSON, for reading by eye
 *
 * ## Why a CLI and not an MCP tool
 *
 * An MCP tool call has to return, and this one has to WAIT — the whole measurement is the difference
 * between two readings taken some time apart. A CLI can block honestly for ninety seconds; a tool
 * that did the same would be an MCP server ignoring its client. The other half of the reason is
 * reach: the MCP surface is filtered by `STOCKBIT_TOOLS`, and a user running `core,chartbit` would
 * not see a new tool at all without editing their config first.
 *
 * ## What this deliberately does NOT do
 *
 * **It does not decide whether anything was big.** It measures, ranks, and reports `confidence`.
 * Every threshold this feature will eventually need — what counts as a large transaction, what
 * counts as unusual for a given stock — is an open question with real measurements behind it and no
 * answer yet. Printing a ranked list with no cutoff is the honest shape until that lands, and it
 * keeps the numbers comparable across runs, which is exactly what deciding the cutoff will need.
 *
 * **It never places, cancels or modifies an order.** It reads one public market endpoint.
 */
import { sessionClock, isWithinPollingWindow } from "../src/core/sessionclock.js";
import { CliParseError, formatUsage, gateCommandLine, isHelpToken, isVersionToken } from "../src/cliargs.js";
import { VERSION } from "../src/version.js";
import { LIVE_BIN, LIVE_COMMANDS, LIVE_EPILOGUE } from "../src/live/cli.js";
import { StockbitError } from "../src/http/errors.js";
import { parseInterval, describeInterval, IntervalParseError } from "../src/live/interval.js";
import { parseScope, resolveScope, describeScope, inScope, ScopeParseError } from "../src/live/scope.js";
import { MarketWatcher } from "../src/live/poller.js";
import { SignalWatcher } from "../src/live/watcher.js";
import { compilePrompt, describeSpec } from "../src/live/promptspec.js";
import { attribute, parseTape } from "../src/live/attribution.js";
import { readBandar } from "../src/live/bandar.js";
import { getRunningTrade } from "../src/core/market.js";
import { getBrokerSummary } from "../src/core/marketdetectors.js";

/**
 * The longest window one `scan` may measure over.
 *
 * Eight minutes. Not a guess about politeness — a caller running this through a tool harness is
 * usually capped at ten minutes per command, so a window past this cannot report back even when it
 * completes. `parseInterval` allows up to an hour because a background watcher legitimately would;
 * a single blocking measurement cannot, so the cap lives here rather than there.
 *
 * REFUSED, not silently shortened. Quietly measuring 90 seconds when the user asked for 30 minutes
 * would answer a question they did not ask, and the answer would look identical to the real one.
 */
const MAX_SCAN_MS = 8 * 60_000;

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Positional arguments, with the flags and their values removed. */
function positionals(): string[] {
  const out: string[] = [];
  const argv = process.argv.slice(2);
  const takesValue = new Set(["--top"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (takesValue.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function emit(body: unknown): void {
  process.stdout.write(JSON.stringify(body, null, flag("pretty") ? 2 : 0) + "\n");
}

/**
 * Report a failure as JSON on stdout and a non-zero exit.
 *
 * Both halves matter. A caller that only reads stdout must not mistake a failure for a calm market,
 * and a caller that only checks the exit code must not mistake one for success.
 */
function fail(reason: string, detail: string, hint?: string): never {
  emit({ ok: false, reason, detail, ...(hint ? { hint } : {}) });
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function scan(): Promise<void> {
  const [, scopeToken, intervalToken] = positionals();

  // Parse before anything touches the network, so a typo costs nothing and is reported instantly.
  let scope, interval;
  try {
    scope = parseScope(scopeToken);
    interval = parseInterval(intervalToken);
  } catch (err) {
    if (err instanceof ScopeParseError || err instanceof IntervalParseError) {
      fail("bad-arguments", err.message, "Usage: stockbit-live scan <BBCA,ANTM|watchlist[:Name]|all> <30s|5m|realtime>");
    }
    throw err;
  }

  if (interval.ms > MAX_SCAN_MS) {
    fail(
      "window-too-long",
      `A single scan measures over the window you name, and ${describeInterval(interval)} is longer than the ${MAX_SCAN_MS / 60_000}-minute maximum for one measurement.`,
      "Use a shorter window (30s, 1m, 5m). Longer cadences need a background watcher, which does not exist yet.",
    );
  }

  const clock = sessionClock();

  // The market gate runs BEFORE the first request. Two readings taken while the exchange is shut are
  // identical, every delta computes to exactly zero, and the output is indistinguishable from a
  // genuinely quiet open session — the same "I cannot see" reported as "nothing is happening" that
  // the poller's loud failures exist to prevent.
  if (!flag("always") && !isWithinPollingWindow(new Date())) {
    fail(
      "market-closed",
      `IDX is outside its polling window right now (${clock.nowWib} WIB, ${clock.weekday}, phase: ${clock.phase}). Two readings taken now would be identical, which would read as a quiet market rather than a shut one.`,
      "Pass --always to measure anyway. Note the window is a flat 08:45-16:15 WIB on weekdays and knows nothing about IDX holidays.",
    );
  }

  // Resolving comes before polling too: a watchlist scope needs a network lookup, and discovering a
  // bad watchlist name AFTER waiting out the full window would be a cruel way to report a typo.
  let resolved;
  try {
    resolved = await resolveScope(scope);
  } catch (err) {
    if (err instanceof StockbitError && err.kind === "auth") {
      fail("auth", err.message, "Run /stockbit-status to check the session, then /stockbit-auth to log in again.");
    }
    fail("scope-unresolved", err instanceof Error ? err.message : String(err));
  }

  const watcher = new MarketWatcher();
  const started = Date.now();

  try {
    const first = await watcher.poll(started);

    // Say what is happening before blocking. A silent process that produces nothing for five minutes
    // is indistinguishable from a hung one. stderr, so stdout stays parseable JSON.
    process.stderr.write(
      `sampling ${describeScope(resolved)} ${describeInterval(interval)} — ${first.symbolsSeen} symbols in the first reading, back in ${Math.round(interval.ms / 1000)}s\n`,
    );

    await sleep(interval.ms);
    const second = await watcher.poll();

    if (second.reason === "session-reset") {
      fail(
        "session-reset",
        "The cumulative counters restarted between the two readings, so their difference is meaningless. This is what a new trading day looks like from here.",
        "Run it again — the next measurement starts from a clean baseline.",
      );
    }
    if (!second.deltas) {
      fail("no-baseline", `The second reading produced no comparison (${second.reason ?? "unknown"}).`);
    }

    const all = second.deltas.filter((d) => inScope(resolved, d.symbol));
    const traded = all.filter((d) => d.trades > 0);
    const top = Number(option("top") ?? 10);
    const limit = Number.isFinite(top) && top > 0 ? Math.floor(top) : 10;

    // A symbol the user explicitly named that produced no row at all is NOT a quiet symbol. It was
    // absent from at least one reading, so there is no baseline to difference — `top-stock` is a
    // ranked list and names genuinely enter and leave it. Reporting that as "nothing traded" would
    // be a claim about the market made from a gap in our own data.
    const requested = resolved.symbols ?? [];
    const seen = new Set(all.map((d) => d.symbol));
    const unobserved = requested.filter((s) => !seen.has(s));

    emit({
      ok: true,
      scope: { kind: scope.kind, described: describeScope(resolved), symbols: resolved.symbols },
      window: {
        requested: describeInterval(interval),
        requestedMs: interval.ms,
        actualSeconds: traded[0]?.seconds ?? all[0]?.seconds ?? (Date.now() - started) / 1000,
        clampedFromRealtime: interval.realtime,
      },
      market: { nowWib: clock.nowWib, weekday: clock.weekday, phase: clock.phase, isTradingHours: clock.isTradingHours },
      symbolsSeen: second.symbolsSeen,
      tradedInWindow: traded.length,
      /**
       * Ranked by rupiah, capped. Every row carries `confidence`: `single` means the average IS one
       * trade, `averaged` means it says nothing about any individual print.
       */
      deltas: traded.slice(0, limit),
      truncated: Math.max(0, traded.length - limit),
      quiet: all.filter((d) => d.trades === 0).map((d) => d.symbol),
      unobserved,
      notes: [
        ...resolved.notes,
        ...(unobserved.length
          ? [`${unobserved.join(", ")} produced no comparable reading — absent from at least one snapshot, which is not the same as having traded nothing.`]
          : []),
        "Nothing here judges whether a figure is large. These are measurements, ranked.",
      ],
    });
  } catch (err) {
    if (err instanceof StockbitError && err.kind === "auth") {
      fail("auth", err.message, "Run /stockbit-status to check the session, then /stockbit-auth to log in again.");
    }
    if (err instanceof StockbitError) fail(err.kind, err.message);
    fail("failed", err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------- signals -------------------------------- */

/**
 * One full detection pass: the value surge plus every order-book signal the prompt enabled.
 *
 * Two market readings are needed before anything can be detected, so this polls, waits the interval,
 * and polls again — the same shape as `scan`, with the detectors and the alert engine on top.
 */
async function signals(): Promise<void> {
  const [, scopeToken, intervalToken, ...promptWords] = positionals();

  let scope, interval;
  try {
    scope = parseScope(scopeToken);
    interval = parseInterval(intervalToken);
  } catch (err) {
    if (err instanceof ScopeParseError || err instanceof IntervalParseError) {
      fail("bad-arguments", err.message, "Usage: stockbit-live signals <BBCA,ANTM|watchlist|all> <30s|5m> [prompt]");
    }
    throw err;
  }
  if (interval.ms > MAX_SCAN_MS) {
    fail("window-too-long", `${describeInterval(interval)} is longer than one measurement can cover.`, "Use 30s, 1m or 5m.");
  }

  const spec = compilePrompt(promptWords.join(" "));
  const clock = sessionClock();

  if (!flag("always") && !isWithinPollingWindow(new Date())) {
    fail(
      "market-closed",
      `IDX is shut (${clock.nowWib} WIB, ${clock.weekday}, ${clock.phase}). Two readings taken now are identical, so every detector would see a flat, silent market.`,
      "Pass --always to run anyway.",
    );
  }

  let resolved;
  try {
    resolved = await resolveScope(scope);
  } catch (err) {
    if (err instanceof StockbitError && err.kind === "auth") {
      fail("auth", err.message, "Run /stockbit-status, then /stockbit-auth.");
    }
    fail("scope-unresolved", err instanceof Error ? err.message : String(err));
  }

  // Trading seconds elapsed today, for the "what should this window have carried" baseline.
  const elapsedSeconds = () => {
    const wib = new Date(Date.now() + 7 * 3600_000);
    const mins = wib.getUTCHours() * 60 + wib.getUTCMinutes();
    return Math.max(60, (Math.min(mins, 16 * 60) - 9 * 60) * 60);
  };

  const watcher = new SignalWatcher({ scope: resolved, spec, elapsedSeconds });

  try {
    await watcher.pass(new Date()); // baseline; produces no deltas by design
    process.stderr.write(
      `watching ${describeScope(resolved)} ${describeInterval(interval)} — baseline taken, detecting in ${Math.round(interval.ms / 1000)}s\n`,
    );
    await sleep(interval.ms);
    const result = await watcher.pass(new Date());

    emit({
      ok: true,
      scope: { kind: scope.kind, described: describeScope(resolved) },
      window: { requested: describeInterval(interval), requestedMs: interval.ms },
      market: { nowWib: clock.nowWib, weekday: clock.weekday, phase: clock.phase },
      prompt: { interpretation: describeSpec(spec), downgrades: spec.downgrades },
      symbolsSeen: result.symbolsSeen,
      booksRead: result.booksRead,
      detected: result.signals.length,
      alerts: result.engine?.emitted ?? [],
      marketWide: result.engine?.marketWide ?? null,
      suppressed: (result.engine?.suppressed ?? []).map((s) => ({
        symbol: s.signal.symbol,
        kind: s.signal.kind,
        reason: s.reason,
      })),
      alertsSpentThisSession: watcher.alertsSpent,
      errors: result.errors,
      notes: [
        ...resolved.notes,
        "Detection runs on live aggregates. Broker-level attribution is a separate, delayed step — see the `explain` command.",
      ],
    });
  } catch (err) {
    if (err instanceof StockbitError && err.kind === "auth") {
      fail("auth", err.message, "Run /stockbit-status, then /stockbit-auth.");
    }
    fail(err instanceof StockbitError ? err.kind : "failed", err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------- explain -------------------------------- */

/** Feature 4: name the prints behind a move, from the (late) tape. */
async function explain(): Promise<void> {
  const [, symbolToken, from, to] = positionals();
  if (!symbolToken) fail("bad-arguments", "Name a symbol.", "Usage: stockbit-live explain <SYMBOL> [HH:MM:SS] [HH:MM:SS]");

  try {
    const raw = await getRunningTrade({ symbol: symbolToken, limit: 100 });
    const result = attribute(parseTape(raw), symbolToken, from, to);
    emit({ ok: true, ...result, prints: result.prints.slice(0, 25) });
  } catch (err) {
    if (err instanceof StockbitError && err.kind === "auth") {
      fail("auth", err.message, "Run /stockbit-status, then /stockbit-auth.");
    }
    fail(err instanceof StockbitError ? err.kind : "failed", err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------- brokers -------------------------------- */

/** Feature 8: end-of-day broker context. Never an alert. */
async function brokers(): Promise<void> {
  const [, symbolToken] = positionals();
  if (!symbolToken) fail("bad-arguments", "Name a symbol.", "Usage: stockbit-live brokers <SYMBOL>");

  try {
    const raw = await getBrokerSummary({ symbol: symbolToken });
    const ctx = readBandar({ ...(raw as object), symbol: symbolToken.toUpperCase() });
    if (!ctx) fail("failed", "The broker summary did not parse.");
    emit({ ok: true, ...ctx, buyers: ctx.buyers.slice(0, 10), sellers: ctx.sellers.slice(0, 10) });
  } catch (err) {
    if (err instanceof StockbitError && err.kind === "auth") {
      fail("auth", err.message, "Run /stockbit-status, then /stockbit-auth.");
    }
    fail(err instanceof StockbitError ? err.kind : "failed", err instanceof Error ? err.message : String(err));
  }
}

const COMMANDS_HINT =
  "Commands: scan <scope> <time-frame> · signals <scope> <time-frame> [prompt] · explain <SYMBOL> · brokers <SYMBOL>";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const explicit = positionals()[0];

  // Help before anything else. `--help` used to be INVISIBLE here — `positionals()` skips flag
  // tokens, so `stockbit-live --help` fell through to the default command and ran a scan (same
  // defect class as the 2026-08-29 stockbit-auth incident; see src/live/cli.ts). Requested help is
  // human output: plain text on stdout, exit 0 — the one deliberate exception to the JSON contract.
  if (explicit === undefined ? args.some(isHelpToken) : isHelpToken(explicit)) {
    process.stdout.write(formatUsage(LIVE_BIN, LIVE_COMMANDS, undefined, LIVE_EPILOGUE));
    return;
  }
  // Version on the same rule, and read the same way: flags may precede the command word, so when
  // there is no explicit command the whole argv is searched. `stockbit-live scan --version` stays
  // an unknown flag on `scan`.
  if (explicit === undefined ? args.some(isVersionToken) : isVersionToken(explicit)) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (explicit === "help") {
    const topic = positionals()[1];
    if (topic !== undefined && !(topic in LIVE_COMMANDS)) {
      fail("unknown-command", `"${topic}" is not a command.`, COMMANDS_HINT);
    }
    process.stdout.write(formatUsage(LIVE_BIN, LIVE_COMMANDS, topic, LIVE_EPILOGUE));
    return;
  }

  const command = explicit ?? "scan";

  // The command word is the first positional and flags may come before it, so the gate sees argv
  // with that one token removed. Every invocation passes the gate BEFORE any handler runs: an
  // unknown flag used to be silently ignored (and its value became a stray positional), which in a
  // measuring tool means answering a question nobody asked. Refusals keep the machine contract —
  // `ok:false` JSON, exit 1 — because callers like the /watch skill parse that shape.
  const rest = [...args];
  const at = rest.indexOf(command);
  if (at !== -1) rest.splice(at, 1);
  let gate: "help" | "ok" | "unknown-command";
  try {
    gate = gateCommandLine(LIVE_BIN, LIVE_COMMANDS, command, rest, (text) => process.stdout.write(text));
  } catch (err) {
    if (err instanceof CliParseError) {
      fail("bad-arguments", err.message, `Run \`stockbit-live ${command} --help\` for what ${command} accepts.`);
    }
    throw err;
  }
  if (gate === "help") return;
  if (gate === "unknown-command") {
    fail("unknown-command", `"${command}" is not a command.`, COMMANDS_HINT);
  }

  if (command === "scan") return scan();
  if (command === "signals") return signals();
  if (command === "explain") return explain();
  if (command === "brokers") return brokers();
  // Unreachable while the dispatch above covers every key in LIVE_COMMANDS; a spec entry added
  // without a branch lands here loudly instead of silently doing nothing.
  fail("unknown-command", `"${command}" is not a command.`, COMMANDS_HINT);
}

main().catch((err) => {
  fail("crashed", err instanceof Error ? err.message : String(err));
});
