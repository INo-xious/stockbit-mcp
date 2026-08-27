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
import { StockbitError } from "../src/http/errors.js";
import { parseInterval, describeInterval, IntervalParseError } from "../src/live/interval.js";
import { parseScope, resolveScope, describeScope, inScope, ScopeParseError } from "../src/live/scope.js";
import { MarketWatcher } from "../src/live/poller.js";

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

async function main(): Promise<void> {
  const command = positionals()[0] ?? "scan";
  if (command === "scan") return scan();
  fail("unknown-command", `"${command}" is not a command.`, "The only command is: scan <scope> <time-frame>");
}

main().catch((err) => {
  fail("crashed", err instanceof Error ? err.message : String(err));
});
