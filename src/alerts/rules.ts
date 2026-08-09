/**
 * Alert rules: the same condition grammar the Pine emitter uses, evaluated here against Stockbit
 * bars.
 *
 * ## The property that matters, stated exactly
 *
 * **For every indicator, a rule created here and the Pine `alertcondition` emitted from it agree.**
 * Neither surface owns its indicators — both expand the same overlays and panels through
 * `src/analysis/series.ts`, which carries the Pine expression and the local compute function side by
 * side, chosen to match. "RSI 14 below 30" means one thing in this project.
 *
 * The vocabularies are *not* identical, and it is worth being precise about the one place they
 * differ rather than claiming a symmetry that does not exist. A Pine signal may also name a support
 * or resistance constant (`support1`, `resistance2`); an alert may not. That is not an oversight to
 * be closed by teaching alerts to resolve those names:
 *
 *   - In Pine, a level is a **literal baked into the script at emission**, precisely so TradingView
 *     plots the level derived from Stockbit's bars rather than recomputing a different one from its
 *     own data. That is the whole reason `pine/emit.ts` emits constants.
 *   - An alert is evaluated later, against a window that has moved. Resolving `support1` at fire
 *     time would recompute the pivot clustering over newer bars and get a *different price* — so
 *     the two surfaces would then share a name while disagreeing on its value, which is worse than
 *     not sharing it at all.
 *
 * The alert equivalent of a Pine level is therefore the numeric literal — `close crossover 4820` —
 * which `resolveOperand` already accepts and which carries exactly the semantics Pine's constant
 * does: a fixed price, captured when the rule was written. `technicals` reports the levels to copy.
 *
 * ## Firing
 *
 * An alert fires on a *closed bar*, once. Two separate guards, because they stop different things:
 *
 *   - **Same-bar suppression** (`lastFiredBar`). Checking twice in an afternoon must not fire twice
 *     for Tuesday's close. This is the guard that actually matters for daily bars, and a
 *     time-based cooldown cannot replace it — a cooldown short enough to be useful intraday is
 *     shorter than a trading day.
 *   - **Cooldown** (`cooldownMinutes`). Rate-limits a rule that would otherwise fire on every check
 *     of a fast series. Defaults to 0, since same-bar suppression already handles the daily case.
 *
 * ## Warm-up is not "false"
 *
 * An RSI that has not warmed up yet is `null`, and `null` is not "below 30". Treating it as zero
 * would fire every rule on every symbol the first time it was checked. `evaluateAt` returns false
 * for a null on either side, and the evaluation reports `warming-up` so the caller can tell "the
 * condition is not met" from "there is not enough history to say yet" — two answers a user would
 * act on differently.
 */
import type { Bar } from "../core/bars.js";
import {
  compileCondition,
  defineSeries,
  isOperator,
  resolveOperand,
  warmupFor,
  type Operator,
  type Overlay,
  type Panel,
} from "../analysis/series.js";

export interface AlertRule {
  id: string;
  symbol: string;
  /** Human name, shown when it fires. */
  name: string;
  /** Series the condition needs, declared exactly as a Pine spec would. */
  overlays: Overlay[];
  panels: Panel[];
  left: string | number;
  op: Operator;
  right: string | number;
  /** Minimum minutes between fires. 0 relies on same-bar suppression alone. */
  cooldownMinutes: number;
  enabled: boolean;
  createdAt: string;
  /** Date of the bar this last fired on — the guard against firing twice for one session. */
  lastFiredBar?: string;
  lastFiredAt?: string;
  lastCheckedAt?: string;
  note?: string;
}

export type NotFiredReason =
  | "condition-false"
  | "warming-up"
  | "already-fired-this-bar"
  | "cooldown"
  | "disabled"
  | "no-data";

export interface AlertEvaluation {
  ruleId: string;
  symbol: string;
  name: string;
  fired: boolean;
  reason?: NotFiredReason;
  /** The bar the verdict is about. */
  barDate?: string;
  leftValue?: number | null;
  rightValue?: number | null;
  /** Rendered condition, e.g. "rsi14 < 30". */
  condition: string;
}

/** A rule as a readable string, for reports and alert messages. */
export function describeCondition(rule: Pick<AlertRule, "left" | "op" | "right">): string {
  const word =
    rule.op === "crossover" ? "crosses above" : rule.op === "crossunder" ? "crosses below" : rule.op === "cross" ? "crosses" : rule.op;
  return `${rule.left} ${word} ${rule.right}`;
}

/**
 * Check a rule against a window of bars, oldest first.
 *
 * `now` is injected rather than read from the clock so cooldown behaviour is testable without
 * sleeping — and so a batch check evaluates every rule against one consistent instant.
 */
export function evaluateRule(rule: AlertRule, bars: Bar[], now: Date): AlertEvaluation {
  const base = { ruleId: rule.id, symbol: rule.symbol, name: rule.name, condition: describeCondition(rule) };

  if (!rule.enabled) return { ...base, fired: false, reason: "disabled" };
  if (bars.length === 0) return { ...base, fired: false, reason: "no-data" };

  const defs = defineSeries(rule.overlays, rule.panels);
  const condition = compileCondition(rule, bars, defs);

  const i = bars.length - 1;
  const barDate = bars[i].date;
  const leftValue = condition.left[i] ?? null;
  const rightValue = condition.right[i] ?? null;
  const withValues = { ...base, barDate, leftValue, rightValue };

  // Warm-up is reported before the condition is judged: "not enough history" and "condition not
  // met" are different answers, and only one of them is worth waiting on. Backtest and scan get
  // this same distinction from `compileCondition` rather than each re-deriving it.
  if (condition.warmingUpAt(i)) {
    return { ...withValues, fired: false, reason: "warming-up" };
  }

  if (!condition.holdsAt(i)) {
    return { ...withValues, fired: false, reason: "condition-false" };
  }

  // The condition holds. Everything below decides whether this is a NEW event.
  if (rule.lastFiredBar === barDate) {
    return { ...withValues, fired: false, reason: "already-fired-this-bar" };
  }
  if (rule.cooldownMinutes > 0 && rule.lastFiredAt) {
    const elapsedMs = now.getTime() - Date.parse(rule.lastFiredAt);
    if (Number.isFinite(elapsedMs) && elapsedMs < rule.cooldownMinutes * 60_000) {
      return { ...withValues, fired: false, reason: "cooldown" };
    }
  }

  return { ...withValues, fired: true };
}

/**
 * How many bars a rule needs before it can say anything, so a caller can fetch enough.
 *
 * The arithmetic lives in `warmupFor` beside the registry that knows how each series settles — a
 * scan asking "how many bars must I buy for this screen" is asking the same question and must get
 * the same answer.
 */
export function warmupBars(rule: Pick<AlertRule, "overlays" | "panels">): number {
  return warmupFor(rule.overlays, rule.panels);
}

/** Reject a rule that could never evaluate, at creation rather than at fire time. */
export function validateRule(rule: AlertRule, sample: Bar[] = []): void {
  if (!rule.symbol) throw new Error("symbol is required");
  if (!rule.name.trim()) throw new Error("name is required");
  if (!isOperator(rule.op)) throw new Error(`Unknown operator ${JSON.stringify(rule.op)}`);
  if (!Number.isFinite(rule.cooldownMinutes) || rule.cooldownMinutes < 0) {
    throw new Error(`cooldownMinutes must be zero or positive, got ${rule.cooldownMinutes}`);
  }
  // Resolving against an empty window is enough to prove the identifiers exist; it throws with the
  // same "Available: …" message the Pine emitter gives, so the two surfaces fail identically.
  const defs = defineSeries(rule.overlays, rule.panels);
  resolveOperand(rule.left, sample, defs, "left");
  resolveOperand(rule.right, sample, defs, "right");
}
