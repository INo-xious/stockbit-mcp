/**
 * One pass of the watcher: fetch, detect, filter, report.
 *
 * This is the only file that knows about all the pieces at once. The detectors are pure and the
 * alert engine is pure; this is where they meet the network, and keeping that boundary sharp is what
 * makes everything else testable without a market.
 *
 * ## Cost, and why the order of operations matters
 *
 * `top-stock` covers a hundred symbols in ONE request and drives the value-surge detector. The
 * order-book detectors need a request PER SYMBOL, so they are run only on symbols that are in scope
 * AND actually traded in the window. Watching a hundred symbols would otherwise mean a hundred
 * requests every interval against an unofficial API on the user's own account, which is the thing
 * the research was explicit about not doing.
 */
import { getJson } from "../http/client.js";
import { MarketWatcher, type PollResult } from "./poller.js";
import { parseOrderBook, type OrderBook } from "./orderbook.js";
import { inScope, type ResolvedScope } from "./scope.js";
import {
  awakening,
  bandApproach,
  bookImbalance,
  floorLocked,
  umaFlag,
  valueSurge,
  wallChange,
  topFiveBidPercent,
  DEFAULTS,
  type Signal,
  type SignalKind,
  type Thresholds,
} from "./signals.js";
import { AlertEngine, FATIGUE_DEFAULTS, type EngineResult } from "./alertengine.js";
import type { WatchSpec } from "./promptspec.js";
import type { TradeDelta } from "./tape.js";

/** How many symbols may be book-checked in one pass. Each is a separate request. */
const MAX_BOOK_FETCHES = 12;

export interface PassResult {
  at: number;
  symbolsSeen: number;
  /** Null on the very first pass — a delta needs two snapshots. */
  deltas: TradeDelta[] | null;
  reason?: PollResult["reason"];
  signals: Signal[];
  engine: EngineResult | null;
  booksRead: string[];
  errors: string[];
}

/** Per-symbol memory the detectors need between passes. */
interface SymbolMemory {
  lastBook?: OrderBook;
  lastImbalance?: number;
  /** Previous session's total value, for the awakening detector. */
  previousSessionValue?: number;
}

export interface WatcherOptions {
  scope: ResolvedScope;
  spec: WatchSpec;
  thresholds?: Thresholds;
  /** Seconds of trading elapsed when the pass runs. Injected so this stays testable. */
  elapsedSeconds: () => number;
}

export class SignalWatcher {
  private readonly market = new MarketWatcher();
  private readonly engine: AlertEngine;
  private readonly memory = new Map<string, SymbolMemory>();

  constructor(private readonly opts: WatcherOptions) {
    // The prompt's severity floor has to reach the engine, which is the only thing that enforces it.
    // Compiling it and then not wiring it up is exactly the silent half-obedience the prompt
    // compiler exists to prevent.
    this.engine = new AlertEngine({ ...FATIGUE_DEFAULTS, floor: opts.spec.severityFloor });
  }

  private enabled(kind: SignalKind): boolean {
    return this.opts.spec.kinds.includes(kind);
  }

  private mem(symbol: string): SymbolMemory {
    let m = this.memory.get(symbol);
    if (!m) {
      m = {};
      this.memory.set(symbol, m);
    }
    return m;
  }

  /** Record what each symbol traded on a previous day, so the awakening detector has a baseline. */
  seedPreviousSession(values: Record<string, number>): void {
    for (const [symbol, value] of Object.entries(values)) {
      this.mem(symbol.toUpperCase()).previousSessionValue = value;
    }
  }

  async pass(now = new Date()): Promise<PassResult> {
    const t = this.opts.thresholds ?? DEFAULTS;
    const errors: string[] = [];
    const poll = await this.market.poll(now.getTime());

    if (!poll.deltas) {
      return {
        at: poll.at,
        symbolsSeen: poll.symbolsSeen,
        deltas: null,
        reason: poll.reason,
        signals: [],
        engine: null,
        booksRead: [],
        errors,
      };
    }

    const mine = poll.deltas.filter((d) => inScope(this.opts.scope, d.symbol));
    const signals: Signal[] = [];

    // ---- value surge (#1): free, one request already spent ----
    if (this.enabled("value-surge")) {
      for (const d of mine) {
        if (this.opts.spec.minValue !== null && d.value < this.opts.spec.minValue) continue;
        // A symbol that has been firing all session gets a harder gate, per the adaptive rule.
        const widen = this.engine.widenFactor(d.symbol);
        const scaled: Thresholds = widen === 1 ? t : { ...t, concentration: t.concentration * widen, rate: t.rate * widen };
        const s = valueSurge(
          {
            delta: d,
            sessionValue: d.sessionValue,
            sessionFrequency: d.sessionFrequency,
            elapsedSeconds: this.opts.elapsedSeconds(),
          },
          scaled,
        );
        if (s) signals.push(s);
      }
    }

    // ---- awakening (#7): also free ----
    if (this.enabled("awakening")) {
      for (const d of mine) {
        const prev = this.mem(d.symbol).previousSessionValue;
        if (prev === undefined) continue;
        const s = awakening({ symbol: d.symbol, todayValue: d.sessionValue, previousSessionValue: prev }, t);
        if (s) signals.push(s);
      }
    }

    // ---- the book detectors: one request each, so choose carefully ----
    const needsBook =
      this.enabled("band-approach") ||
      this.enabled("book-imbalance") ||
      this.enabled("wall-change") ||
      this.enabled("uma-flag") ||
      this.enabled("floor-locked");

    const booksRead: string[] = [];
    if (needsBook) {
      // Busiest first: a symbol that did not trade cannot have moved its book meaningfully, and the
      // budget is better spent where something happened.
      const candidates = mine.filter((d) => d.trades > 0).slice(0, MAX_BOOK_FETCHES);
      for (const d of candidates) {
        let book: OrderBook | null = null;
        try {
          book = parseOrderBook(await getJson("orderbook", { segments: { symbol: d.symbol } }));
        } catch (err) {
          errors.push(`${d.symbol}: ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (!book) {
          errors.push(`${d.symbol}: order book did not parse`);
          continue;
        }
        booksRead.push(d.symbol);
        const m = this.mem(d.symbol);

        if (this.enabled("band-approach")) {
          const s = bandApproach({ book, recentVolumeShares: d.lots * 100, windowSeconds: d.seconds }, t);
          if (s) signals.push(s);
        }
        if (this.enabled("book-imbalance")) {
          const s = bookImbalance({ book, previousPercent: m.lastImbalance ?? null }, t);
          if (s) signals.push(s);
        }
        if (this.enabled("wall-change") && m.lastBook) {
          const s = wallChange({ book, previous: m.lastBook, tradedShares: d.lots * 100 }, t);
          if (s) signals.push(s);
        }
        if (this.enabled("uma-flag")) {
          const s = umaFlag(book);
          if (s) signals.push(s);
        }
        if (this.enabled("floor-locked")) {
          const s = floorLocked(book);
          if (s) signals.push(s);
        }

        m.lastBook = book;
        m.lastImbalance = topFiveBidPercent(book) ?? undefined;
      }
    }

    // The severity floor lives on the engine (set from the spec in the constructor). Only the money
    // floor and the symbol filter have been applied above.
    const engine = this.engine.process(signals, now, mine.length || poll.symbolsSeen);

    return {
      at: poll.at,
      symbolsSeen: poll.symbolsSeen,
      deltas: mine,
      signals,
      engine,
      booksRead,
      errors,
    };
  }

  get alertsSpent(): number {
    return this.engine.spent;
  }

  get overFiring(): SignalKind[] {
    return this.engine.overFiringKinds();
  }
}
