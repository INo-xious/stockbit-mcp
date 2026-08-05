/**
 * Pine Script v6 generation.
 *
 * ## Why this is not a string-templating convenience
 *
 * The point of this project is that what the assistant shows and what Stockbit shows are the same
 * numbers. A Pine script pasted into TradingView is a third place those numbers appear, and it is
 * the easiest place for them to quietly diverge — a different smoothing, a sample standard
 * deviation instead of a population one, an EMA seeded differently — none of which announce
 * themselves. They just draw a slightly different line that the user trusts.
 *
 * So every indicator here is emitted as the Pine builtin whose definition matches what
 * `src/core/indicators.ts` computes, and the pairing is deliberate rather than approximate:
 *
 *   | ours                       | Pine        | why they agree                                    |
 *   |----------------------------|-------------|---------------------------------------------------|
 *   | `sma`                      | `ta.sma`    | plain mean of the window                          |
 *   | `ema` (SMA-seeded)         | `ta.ema`    | Pine seeds its EMA with an SMA of the same length |
 *   | `rsi` (Wilder-smoothed)    | `ta.rsi`    | Pine's RSI smooths with `ta.rma`, i.e. Wilder     |
 *   | `atr` (Wilder-smoothed)    | `ta.atr`    | same, `ta.rma` over true range                    |
 *   | `macd`                     | `ta.macd`   | EMA(fast) - EMA(slow), EMA signal                 |
 *   | `bollinger` (population SD)| `ta.bb`     | `ta.stdev` is population, not sample              |
 *
 * Support and resistance are the exception, and the interesting one. They come from pivot
 * clustering over Stockbit's bars — there is no Pine builtin with that definition, and
 * reimplementing the clustering in Pine would recompute it from *TradingView's* data, which is a
 * different source and would silently disagree. So they are emitted as literal price constants with
 * the window they were derived from written into the script. The script then shows exactly the
 * levels the user was shown, and says where they came from.
 *
 * ## Injection
 *
 * Everything that reaches the output goes through a closed vocabulary: series are declared here and
 * referenced by generated identifier, comparisons come from a fixed operator set, and free text is
 * escaped for a Pine string literal. A caller cannot smuggle arbitrary Pine through a title or a
 * signal name — which matters because the output is code the user is going to paste and run.
 */
import type { Level } from "../core/indicators.js";

/* ---------------------------------- the vocabulary ---------------------------------- */

/** Built-in series a signal may reference without declaring anything. */
export const PRICE_REFS = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "volume"] as const;
export type PriceRef = (typeof PRICE_REFS)[number];

/** Comparisons a signal may use. Closed on purpose: a free-text condition would be arbitrary Pine. */
export const OPERATORS = ["crossover", "crossunder", "cross", ">", "<", ">=", "<="] as const;
export type Operator = (typeof OPERATORS)[number];

export type Overlay =
  | { kind: "sma"; period: number }
  | { kind: "ema"; period: number }
  | { kind: "bollinger"; period: number; k: number };

export type Panel =
  | { kind: "rsi"; period: number }
  | { kind: "atr"; period: number }
  | { kind: "macd"; fast: number; slow: number; signal: number };

export interface Signal {
  /** Becomes a Pine identifier and an alert name; sanitised, never interpolated raw. */
  name: string;
  left: string | number;
  op: Operator;
  right: string | number;
  /** Alert text shown when it fires. */
  message?: string;
}

export interface StrategyRules {
  /** Signal name that opens a long. */
  longWhen?: string;
  /** Signal name that closes it. */
  exitWhen?: string;
  /** Percent stop-loss from entry, e.g. 3 for -3%. */
  stopLossPct?: number;
  /** Percent take-profit from entry. */
  takeProfitPct?: number;
}

export interface PineSpec {
  symbol: string;
  kind: "indicator" | "strategy";
  title?: string;
  overlays?: Overlay[];
  panels?: Panel[];
  /** Levels from Stockbit data, emitted as constants — see the note above on why. */
  levels?: Level[];
  /** The bar window the levels were derived from, written into the script for provenance. */
  levelsFrom?: string;
  levelsTo?: string;
  signals?: Signal[];
  /** Emit an `alertcondition` per signal (indicator scripts only — Pine forbids it in strategies). */
  alerts?: boolean;
  strategy?: StrategyRules;
}

/* ------------------------------------- escaping ------------------------------------- */

/** Escape free text for a Pine double-quoted string literal. */
export function pineString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;
}

/**
 * Flatten free text so it is safe inside a `//` comment.
 *
 * A comment runs to end of line, so a newline in caller text ends the comment and puts whatever
 * follows on its own line as executable Pine. That is a real escape and it was live here: a title
 * of `evil"\nstrategy.close_all()\n//` emitted `strategy.close_all()` as a statement, while the
 * *string* use of the same title was correctly escaped — which is exactly why escaping has to be
 * per-context rather than done once at the door.
 */
export function pineComment(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * A source's lines with string literals and trailing comments removed.
 *
 * Shared by the validator and by tests that need to ask "does this dangerous text appear as CODE",
 * which is a different and much more useful question than "does this substring appear anywhere" —
 * properly escaped text still contains its own characters.
 */
export function codeOnly(source: string): string[] {
  return source.split(/\r?\n/).map((line) => scanLine(line).code);
}

/**
 * One pass over a line: the code outside strings and comments, and whether a string was left open.
 *
 * Both answers come from the same walk because they cannot be computed independently — counting
 * quotes on the raw line calls a comment like `// he said "hi` unterminated, and stripping comments
 * first requires already knowing which `//` are inside strings.
 */
function scanLine(line: string): { code: string; unterminated: boolean } {
  let code = "";
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    // A `//` inside a string is not a comment, which is why this check lives after the string branch.
    if (ch === "/" && line[i + 1] === "/") return { code, unterminated: false };
    code += ch;
  }
  return { code, unterminated: inString };
}

/**
 * Turn a caller's label into a safe Pine identifier.
 *
 * Falls back to a positional name rather than throwing, because a signal called "20/50 cross" is a
 * perfectly reasonable thing to ask for and should not be an error.
 */
export function pineIdent(raw: string, fallback: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1");
  return cleaned.length ? cleaned : fallback;
}

/** A finite number, formatted for Pine. Rejects NaN/Infinity rather than emitting them. */
function pineNumber(value: number, what: string): string {
  if (!Number.isFinite(value)) throw new Error(`${what} must be a finite number, got ${value}`);
  return String(value);
}

function requirePeriod(period: number, what: string): number {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`${what} period must be a positive integer, got ${period}`);
  }
  return period;
}

/* ------------------------------------ the emitter ------------------------------------ */

interface Declared {
  /** Pine identifier holding the series. */
  id: string;
  /** Human label for plots and legends. */
  label: string;
  /** Where it is drawn. */
  where: "price" | "rsi" | "macd" | "atr";
  /** The right-hand side of `id = ...`. */
  expr: string;
  /** Plot colour. */
  color: string;
  style?: "line" | "histogram";
}

/** Cycled so two moving averages never land in the same colour. */
const MA_COLORS = ["#58a6ff", "#d29922", "#a371f7", "#3fb950", "#f778ba"];

/** Everything a spec declares, in emission order, with the identifiers signals may reference. */
export function declaredSeries(spec: PineSpec): Declared[] {
  const out: Declared[] = [];

  for (const o of spec.overlays ?? []) {
    if (o.kind === "sma") {
      const p = requirePeriod(o.period, "sma");
      // Distinct colours per line: two SMAs in the same blue are indistinguishable on a chart.
      const shade = MA_COLORS[out.filter((s) => /^(sma|ema)/.test(s.id)).length % MA_COLORS.length];
      out.push({ id: `sma${p}`, label: `SMA ${p}`, where: "price", expr: `ta.sma(close, ${p})`, color: `color.new(${shade}, 0)` });
    } else if (o.kind === "ema") {
      const p = requirePeriod(o.period, "ema");
      const shade = MA_COLORS[out.filter((s) => /^(sma|ema)/.test(s.id)).length % MA_COLORS.length];
      out.push({ id: `ema${p}`, label: `EMA ${p}`, where: "price", expr: `ta.ema(close, ${p})`, color: `color.new(${shade}, 0)` });
    } else {
      const p = requirePeriod(o.period, "bollinger");
      const k = pineNumber(o.k, "bollinger k");
      // One ta.bb call, destructured — calling it three times would recompute the same stdev.
      out.push(
        { id: `bbMiddle`, label: `BB basis (${p})`, where: "price", expr: `ta.sma(close, ${p})`, color: "color.new(#8b949e, 40)" },
        { id: `bbDev`, label: "", where: "price", expr: `${k} * ta.stdev(close, ${p})`, color: "" },
        { id: `bbUpper`, label: `BB upper`, where: "price", expr: `bbMiddle + bbDev`, color: "color.new(#8b949e, 0)" },
        { id: `bbLower`, label: `BB lower`, where: "price", expr: `bbMiddle - bbDev`, color: "color.new(#8b949e, 0)" },
      );
    }
  }

  for (const p of spec.panels ?? []) {
    if (p.kind === "rsi") {
      const n = requirePeriod(p.period, "rsi");
      out.push({ id: `rsi${n}`, label: `RSI ${n}`, where: "rsi", expr: `ta.rsi(close, ${n})`, color: "color.new(#a371f7, 0)" });
    } else if (p.kind === "atr") {
      const n = requirePeriod(p.period, "atr");
      out.push({ id: `atr${n}`, label: `ATR ${n}`, where: "atr", expr: `ta.atr(${n})`, color: "color.new(#3fb950, 0)" });
    } else {
      const f = requirePeriod(p.fast, "macd fast");
      const s = requirePeriod(p.slow, "macd slow");
      const g = requirePeriod(p.signal, "macd signal");
      if (f >= s) throw new Error(`macd fast (${f}) must be shorter than slow (${s})`);
      out.push(
        { id: "macdLine", label: "MACD", where: "macd", expr: `ta.ema(close, ${f}) - ta.ema(close, ${s})`, color: "color.new(#58a6ff, 0)" },
        { id: "macdSignal", label: "Signal", where: "macd", expr: `ta.ema(macdLine, ${g})`, color: "color.new(#d29922, 0)" },
        { id: "macdHist", label: "Histogram", where: "macd", expr: `macdLine - macdSignal`, color: "color.new(#8b949e, 20)", style: "histogram" },
      );
    }
  }

  return out;
}

/** Identifiers a signal is allowed to name: declared series, price builtins, and level constants. */
function operandExpr(
  operand: string | number,
  declared: Set<string>,
  levelIds: ReadonlySet<string>,
  side: string,
): string {
  if (typeof operand === "number") return pineNumber(operand, side);
  if ((PRICE_REFS as readonly string[]).includes(operand)) return operand;
  if (declared.has(operand) || levelIds.has(operand)) return operand;
  throw new Error(
    `${side} references "${operand}", which is not a declared series. ` +
      `Available: ${[...declared, ...levelIds, ...PRICE_REFS].join(", ")}`,
  );
}

function comparison(left: string, op: Operator, right: string): string {
  if (op === "crossover") return `ta.crossover(${left}, ${right})`;
  if (op === "crossunder") return `ta.crossunder(${left}, ${right})`;
  if (op === "cross") return `ta.cross(${left}, ${right})`;
  return `${left} ${op} ${right}`;
}

/**
 * Build a complete, paste-ready Pine v6 script.
 *
 * Throws rather than emitting a script that will not compile — a broken script that looks fine is
 * worse than an error, because the user finds out in TradingView's console with no idea which
 * argument caused it.
 */
export function buildPine(spec: PineSpec): string {
  if (!spec.symbol) throw new Error("symbol is required");
  const title = spec.title ?? `${spec.symbol} — ${spec.kind === "strategy" ? "strategy" : "analysis"}`;
  const series = declaredSeries(spec);
  const declaredIds = new Set(series.map((s) => s.id));

  const lines: string[] = [];
  lines.push("//@version=6");
  // pineComment, not raw: a newline here ends the comment and the rest becomes executable Pine.
  lines.push(`// ${pineComment(title)}`);
  lines.push(`// Generated by stockbit-mcp for ${pineComment(spec.symbol)} (IDX).`);
  lines.push("//");
  lines.push("// Indicators use TradingView builtins whose definitions match what this server");
  lines.push("// computes, so the values here and the values you were shown are the same.");

  /* -- levels: constants, because recomputing them here would use a different data source -- */
  const levels = (spec.levels ?? []).filter((l) => Number.isFinite(l.price));
  const levelIds = new Map<string, Level>();
  if (levels.length) {
    const window =
      spec.levelsFrom && spec.levelsTo
        ? pineComment(`${spec.levelsFrom} to ${spec.levelsTo}`)
        : "the requested window";
    lines.push("//");
    lines.push("// Support/resistance below are CONSTANTS taken from Stockbit's bars over");
    lines.push(`// ${window}, found by pivot clustering. They are not recomputed from`);
    lines.push("// TradingView data, which would be a different source and would disagree.");
  }
  lines.push("");

  const declaration =
    spec.kind === "strategy"
      ? `strategy(${pineString(title)}, overlay = true, initial_capital = 10000000, default_qty_type = strategy.percent_of_equity, default_qty_value = 100, currency = "IDR")`
      : `indicator(${pineString(title)}, overlay = true)`;
  lines.push(declaration);
  lines.push("");

  if (series.length) {
    lines.push("// ---- series ----");
    for (const s of series) lines.push(`${s.id} = ${s.expr}`);
    lines.push("");
  }

  if (levels.length) {
    lines.push("// ---- support & resistance (from Stockbit) ----");
    // Numbered per kind, not by array index: res1/sup2 reads as if sup1 went missing.
    const seen = { support: 0, resistance: 0 };
    levels.forEach((l, i) => {
      const id = `${l.kind === "support" ? "sup" : "res"}${++seen[l.kind]}`;
      levelIds.set(id, l);
      lines.push(`${id} = ${pineNumber(l.price, `level ${i + 1}`)}  // ${l.kind}, ${l.touches} touch${l.touches === 1 ? "" : "es"}`);
    });
    lines.push("");
  }

  /* -- signals -- */
  const signals = spec.signals ?? [];
  const signalIds = new Map<string, string>();
  const levelNames = new Set(levelIds.keys());
  if (signals.length) {
    lines.push("// ---- signals ----");
    signals.forEach((sig, i) => {
      if (!(OPERATORS as readonly string[]).includes(sig.op)) {
        throw new Error(`Unknown operator ${JSON.stringify(sig.op)}; expected one of ${OPERATORS.join(", ")}`);
      }
      const id = `sig_${pineIdent(sig.name, `signal${i + 1}`)}`;
      if ([...signalIds.values()].includes(id)) throw new Error(`Duplicate signal name ${JSON.stringify(sig.name)}`);
      signalIds.set(sig.name, id);
      const left = operandExpr(sig.left, declaredIds, levelNames, `signal "${sig.name}" left`);
      const right = operandExpr(sig.right, declaredIds, levelNames, `signal "${sig.name}" right`);
      lines.push(`${id} = ${comparison(left, sig.op, right)}`);
    });
    lines.push("");
  }

  /* -- plots -- */
  // Only price series are plotted here. Panel series are still DECLARED above, because a signal
  // may reference one — but they are drawn by their own script (see `buildPineScripts`). Plotting
  // an RSI on an overlay chart squashes the price axis into a line; hiding it with `display.none`
  // is worse, because the user is told it was plotted and sees nothing.
  const plotted = series.filter((s) => s.color && s.where === "price");
  if (plotted.length) {
    lines.push("// ---- plots ----");
    for (const s of plotted) {
      lines.push(`plot(${s.id}, title = ${pineString(s.label)}, color = ${s.color}, linewidth = 2)`);
    }
  }
  for (const [id, level] of levelIds) {
    const shade = level.kind === "support" ? "#3fb950" : "#f85149";
    lines.push(
      `hline(${id}, title = ${pineString(`${level.kind} ${level.price}`)}, color = color.new(${shade}, 30), linestyle = hline.style_dashed)`,
    );
  }
  if (plotted.length || levelIds.size) lines.push("");

  /* -- alerts / strategy -- */
  if (spec.kind === "strategy") {
    const rules = spec.strategy ?? {};
    lines.push("// ---- orders ----");
    if (rules.longWhen) {
      const id = signalIds.get(rules.longWhen);
      if (!id) throw new Error(`strategy.longWhen references unknown signal ${JSON.stringify(rules.longWhen)}`);
      lines.push(`if ${id}`);
      lines.push(`    strategy.entry("long", strategy.long)`);
    }
    if (rules.exitWhen) {
      const id = signalIds.get(rules.exitWhen);
      if (!id) throw new Error(`strategy.exitWhen references unknown signal ${JSON.stringify(rules.exitWhen)}`);
      lines.push(`if ${id}`);
      lines.push(`    strategy.close("long")`);
    }
    if (rules.stopLossPct !== undefined || rules.takeProfitPct !== undefined) {
      const sl = rules.stopLossPct;
      const tp = rules.takeProfitPct;
      if (sl !== undefined && !(sl > 0)) throw new Error(`stopLossPct must be positive, got ${sl}`);
      if (tp !== undefined && !(tp > 0)) throw new Error(`takeProfitPct must be positive, got ${tp}`);
      const parts = ['strategy.exit("exit", "long"'];
      if (sl !== undefined) parts.push(`stop = strategy.position_avg_price * (1 - ${sl} / 100)`);
      if (tp !== undefined) parts.push(`limit = strategy.position_avg_price * (1 + ${tp} / 100)`);
      lines.push(`if strategy.position_size > 0`);
      lines.push(`    ${parts.join(", ")})`);
    }
    if (!rules.longWhen && !rules.exitWhen && rules.stopLossPct === undefined && rules.takeProfitPct === undefined) {
      lines.push("// No rules given — add signals and a strategy block to place orders.");
    }
  } else if (spec.alerts && signals.length) {
    lines.push("// ---- alerts ----");
    for (const sig of signals) {
      const id = signalIds.get(sig.name)!;
      const message = sig.message ?? `${spec.symbol}: ${sig.name}`;
      lines.push(`alertcondition(${id}, title = ${pineString(sig.name)}, message = ${pineString(message)})`);
    }
  }

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/* ------------------------------------ validation ------------------------------------ */

export interface PineIssue {
  line: number;
  message: string;
}

/**
 * Structural checks on a Pine script.
 *
 * **This is not a compiler and does not claim to be.** It catches the mistakes that generation can
 * actually make — an unbalanced bracket, a missing version pragma, a reference to an identifier
 * that was never assigned, more plots than Pine allows — and says nothing about the rest. Reporting
 * "valid" here means "nothing structurally wrong was found", not "TradingView will accept this",
 * and the tool that surfaces it says so in those words.
 */
export function validatePine(source: string): { ok: boolean; issues: PineIssue[] } {
  const issues: PineIssue[] = [];
  const rawLines = source.split(/\r?\n/);

  if (!/^\/\/@version=\d+\s*$/m.test(rawLines[0] ?? "")) {
    issues.push({ line: 1, message: "missing //@version pragma on the first line" });
  }

  // One walk gives both the code outside strings/comments and whether a literal was left open.
  const scanned = rawLines.map(scanLine);
  const code = scanned.map((s) => s.code);
  scanned.forEach((s, i) => {
    if (s.unterminated) issues.push({ line: i + 1, message: "unterminated string literal" });
  });

  let depth = 0;
  code.forEach((line, i) => {
    for (const ch of line) {
      if (ch === "(" || ch === "[") depth++;
      if (ch === ")" || ch === "]") depth--;
      if (depth < 0) {
        issues.push({ line: i + 1, message: "closing bracket with no opener" });
        depth = 0;
      }
    }
  });
  if (depth !== 0) issues.push({ line: rawLines.length, message: `${depth} unclosed bracket(s)` });

  const declarations = code.filter((l) => /^\s*(indicator|strategy|library)\s*\(/.test(l));
  if (declarations.length === 0) issues.push({ line: 1, message: "no indicator()/strategy() declaration" });
  if (declarations.length > 1) issues.push({ line: 1, message: "more than one indicator()/strategy() declaration" });

  // Pine allows at most 64 plots per script.
  const plots = code.filter((l) => /^\s*plot\s*\(/.test(l)).length;
  if (plots > 64) issues.push({ line: 0, message: `${plots} plots; Pine allows at most 64` });

  // Duplicate top-level assignment. Pine allows shadowing, so this is not an error in the language —
  // but from a generator it means two features picked the same identifier and one silently won.
  //
  // There is deliberately NO "references an undeclared identifier" check here. The obvious regex
  // version of it produced eighty false positives on this module's own output — it truncated every
  // builtin it saw ("plot" as "plo", "title" as "titl") — and a validator that cries wolf gets
  // ignored, which is worse than not having it. Undeclared references are prevented where they can
  // actually be prevented: `buildPine` resolves every operand against its declared series and
  // throws. Deciding it properly here needs a parser, not a pattern.
  const assignedAt = new Map<string, number>();
  code.forEach((line, i) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/.exec(line);
    if (!m) return;
    const prev = assignedAt.get(m[1]);
    if (prev !== undefined) {
      issues.push({ line: i + 1, message: `"${m[1]}" is assigned again here; first assigned on line ${prev}` });
    } else {
      assignedAt.set(m[1], i + 1);
    }
  });

  return { ok: issues.length === 0, issues };
}

/* --------------------------------- panes as scripts --------------------------------- */

export interface PineScript {
  /** Suggested script title. */
  title: string;
  /** Which pane it belongs in. */
  pane: "price" | "rsi" | "macd" | "atr";
  source: string;
}

const PANEL_GUIDES: Record<string, number[]> = { rsi: [30, 70] };

/**
 * The full set of scripts a spec implies: the price script, plus one per requested panel.
 *
 * TradingView puts a script in exactly one pane. An RSI plotted on an overlay script compresses the
 * price axis to a flat line, so RSI, MACD and ATR each get their own `overlay = false` script. This
 * uses nothing but bedrock Pine — no `force_overlay`, whose availability varies by version and
 * which would fail to compile on the user's chart with an error that points nowhere useful.
 */
export function buildPineScripts(spec: PineSpec): PineScript[] {
  const out: PineScript[] = [
    { title: spec.title ?? `${spec.symbol} — price`, pane: "price", source: buildPine(spec) },
  ];

  for (const panel of spec.panels ?? []) {
    const only = declaredSeries({ symbol: spec.symbol, kind: "indicator", panels: [panel] });
    const title = pineComment(`${spec.symbol} — ${panel.kind.toUpperCase()}`);
    const lines = [
      "//@version=6",
      `// ${title}`,
      "// Its own pane: an oscillator on an overlay script flattens the price axis.",
      "",
      `indicator(${pineString(title)}, overlay = false)`,
      "",
    ];
    for (const s of only) lines.push(`${s.id} = ${s.expr}`);
    lines.push("");
    for (const s of only) {
      const style = s.style === "histogram" ? ", style = plot.style_histogram" : "";
      lines.push(`plot(${s.id}, title = ${pineString(s.label)}, color = ${s.color}${style}, linewidth = 2)`);
    }
    for (const guide of PANEL_GUIDES[panel.kind] ?? []) {
      lines.push(`hline(${guide}, title = ${pineString(String(guide))}, color = color.new(#8b949e, 40), linestyle = hline.style_dashed)`);
    }
    if (panel.kind === "macd") lines.push(`hline(0, title = "zero", color = color.new(#8b949e, 40))`);
    out.push({ title, pane: panel.kind, source: `${lines.join("\n").trimEnd()}\n` });
  }

  return out;
}
