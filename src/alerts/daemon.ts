/**
 * The alert daemon: the part of this project an MCP server structurally cannot be.
 *
 * ADR-0002's argument was that the differentiator here is not another way to read data — Stockbit
 * has a perfectly good API and the assistant can call it — but something that runs when nobody is
 * asking. An MCP server only exists while a client holds it open, so a rule that fires at 14:20 on
 * a Tuesday reaches nobody unless a separate process is watching. This is that process.
 *
 * ## What it does, once a minute by default
 *
 *   1. Loads the rules from the same store the MCP tools write to, every tick — so creating a rule
 *      in chat takes effect without restarting anything.
 *   2. Fetches bars once per SYMBOL, not once per rule.
 *   3. Evaluates, delivers what fired, and records the fire so it cannot fire twice for one bar.
 *
 * ## Market hours
 *
 * IDX trades roughly 09:00–16:00 WIB (UTC+7), Monday to Friday. Outside that the daily bar does not
 * change, so polling only burns requests and rate limit for a guaranteed no-op. `--always` overrides
 * this for testing and for anyone whose rules are not price-driven.
 *
 * ## Failure posture
 *
 * A tick that throws is logged and the loop continues. A daemon that dies on the first network
 * blip is worse than no daemon, because the user believes it is still watching — the same reason
 * the delivery log is written before any other channel is attempted.
 */
import type { Bar } from "../core/bars.js";
import { evaluateRule, warmupBars, type AlertEvaluation, type AlertRule } from "./rules.js";
import { loadRules, updateRule } from "./store.js";
import { deliver, type DeliveryOptions, type DeliveryResult } from "./notify.js";
import { isWithinPollingWindow } from "../core/sessionclock.js";

export interface TickResult {
  at: string;
  checked: number;
  fired: AlertEvaluation[];
  deliveries: DeliveryResult[];
  errors: string[];
  skipped?: "market-closed" | "no-rules";
}

/**
 * Whether IDX is plausibly open at `now`. Deliberately generous at the edges.
 *
 * 08:45 to 16:15 WIB: wide enough to catch pre-open and the post-close print, and deliberately
 * blind to the midday break — stopping at a session boundary would drop an alert that fires on the
 * post-closing print. The WIB conversion itself lives in `src/core/sessionclock.ts`, so the daemon
 * and `status` cannot disagree about what day it is in Jakarta.
 */
export function isMarketOpen(now: Date): boolean {
  return isWithinPollingWindow(now);
}

export interface TickOptions extends DeliveryOptions {
  /** Evaluate even when the market is closed. */
  always?: boolean;
  /** Only rules for this symbol. */
  symbol?: string;
  /** Evaluate and report without recording fires or delivering. */
  dryRun?: boolean;
}

/**
 * One pass over every stored rule.
 *
 * `fetchBars` is injected so this is testable without a network, and so the daemon cannot acquire a
 * second way of reaching Stockbit that bypasses the transport boundary.
 */
export async function tick(
  fetchBars: (symbol: string, bars: number) => Promise<Bar[]>,
  now: Date,
  options: TickOptions = {},
): Promise<TickResult> {
  const at = now.toISOString();
  const base: TickResult = { at, checked: 0, fired: [], deliveries: [], errors: [] };

  if (!options.always && !isMarketOpen(now)) return { ...base, skipped: "market-closed" };

  const rules = loadRules().filter((r) => r.enabled && (!options.symbol || r.symbol === options.symbol));
  if (rules.length === 0) return { ...base, skipped: "no-rules" };

  // Grouped by symbol: ten rules on BBRI are one fetch, not ten.
  const bySymbol = new Map<string, AlertRule[]>();
  for (const rule of rules) {
    const list = bySymbol.get(rule.symbol) ?? [];
    list.push(rule);
    bySymbol.set(rule.symbol, list);
  }

  const fired: AlertEvaluation[] = [];
  const deliveries: DeliveryResult[] = [];
  const errors: string[] = [];
  let checked = 0;

  for (const [symbol, group] of bySymbol) {
    let bars: Bar[];
    try {
      bars = await fetchBars(symbol, Math.max(...group.map((r) => warmupBars(r)), 60));
    } catch (err) {
      // One dead symbol must not end the tick; the other rules still have answers.
      errors.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const rule of group) {
      checked++;
      let result: AlertEvaluation;
      try {
        result = evaluateRule(rule, bars, now);
      } catch (err) {
        errors.push(`${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!result.fired) continue;
      fired.push(result);
      if (options.dryRun) continue;

      // Recorded BEFORE delivery: if delivery throws, the alert must not fire again on the next
      // tick sixty seconds later, and again, and again.
      updateRule(rule.id, { lastFiredBar: result.barDate, lastFiredAt: at });
      try {
        deliveries.push(await deliver(result, at, options));
      } catch (err) {
        errors.push(`deliver ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { at, checked, fired, deliveries, errors };
}

export interface WatchOptions extends TickOptions {
  intervalMs?: number;
  /** Called after every tick, for logging. */
  onTick?: (result: TickResult) => void;
  /** Stop signal. */
  signal?: AbortSignal;
}

/**
 * Poll forever.
 *
 * Errors inside a tick are already collected into its result; a throw that escapes is caught here
 * and reported, because the loop surviving is more valuable than the process exiting cleanly.
 */
export async function watch(
  fetchBars: (symbol: string, bars: number) => Promise<Bar[]>,
  options: WatchOptions = {},
): Promise<void> {
  const interval = options.intervalMs ?? 60_000;
  for (;;) {
    if (options.signal?.aborted) return;
    try {
      const result = await tick(fetchBars, new Date(), options);
      options.onTick?.(result);
    } catch (err) {
      options.onTick?.({
        at: new Date().toISOString(),
        checked: 0,
        fired: [],
        deliveries: [],
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
