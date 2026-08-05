import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPine,
  buildPineScripts,
  codeOnly,
  declaredSeries,
  pineComment,
  pineIdent,
  pineString,
  validatePine,
  type PineSpec,
} from "../src/pine/emit.ts";

const BASE: PineSpec = {
  symbol: "BBRI",
  kind: "indicator",
  overlays: [{ kind: "sma", period: 20 }, { kind: "sma", period: 50 }, { kind: "bollinger", period: 20, k: 2 }],
  panels: [{ kind: "rsi", period: 14 }, { kind: "macd", fast: 12, slow: 26, signal: 9 }],
  levels: [
    { price: 4820, touches: 4, kind: "resistance" },
    { price: 4310, touches: 3, kind: "support" },
    { price: 4650, touches: 2, kind: "resistance" },
  ],
  levelsFrom: "2026-02-01",
  levelsTo: "2026-08-05",
  signals: [
    { name: "20/50 golden cross", left: "sma20", op: "crossover", right: "sma50" },
    { name: "RSI oversold", left: "rsi14", op: "<", right: 30 },
    { name: "break resistance", left: "close", op: "crossover", right: "res1" },
  ],
  alerts: true,
};

/* --------------------------- it agrees with our own maths --------------------------- */

test("every indicator maps to the Pine builtin with the SAME definition", () => {
  // This is the whole point of the feature. If a mapping drifts, TradingView draws a slightly
  // different line and the user has no way to tell which one is right.
  const src = buildPine(BASE);

  // Wilder-smoothed here, and ta.rsi/ta.atr smooth with ta.rma, which is Wilder.
  assert.match(src, /rsi14 = ta\.rsi\(close, 14\)/);
  // SMA-seeded EMA here; Pine's ta.ema is also SMA-seeded.
  assert.match(src, /macdLine = ta\.ema\(close, 12\) - ta\.ema\(close, 26\)/);
  assert.match(src, /macdSignal = ta\.ema\(macdLine, 9\)/);
  // Population SD here, and ta.stdev is population, not sample.
  assert.match(src, /bbDev = 2 \* ta\.stdev\(close, 20\)/);
  assert.match(src, /bbUpper = bbMiddle \+ bbDev/);
  assert.match(src, /sma20 = ta\.sma\(close, 20\)/);
});

test("Bollinger computes its deviation once rather than three times", () => {
  const src = buildPine({ ...BASE, panels: [], signals: [] });
  assert.equal((src.match(/ta\.stdev\(/g) ?? []).length, 1, "upper and lower must share one stdev call");
});

test("support and resistance are CONSTANTS from Stockbit, never recomputed in Pine", () => {
  // Recomputing pivots in Pine would use TradingView's bars — a different data source that would
  // quietly disagree with what the user was shown.
  const src = buildPine(BASE);
  assert.match(src, /res1 = 4820/);
  assert.match(src, /sup1 = 4310/);
  assert.equal(/ta\.pivot(high|low)/.test(src), false, "levels must not be recomputed from TradingView data");
  assert.match(src, /2026-02-01 to 2026-08-05/, "the script should record where the levels came from");
});

test("levels are numbered per kind, so a list does not read as if one went missing", () => {
  const src = buildPine(BASE);
  for (const id of ["res1", "sup1", "res2"]) assert.match(src, new RegExp(`\\b${id} = `));
  assert.equal(/\bsup2 = /.test(src), false, "there is only one support level");
});

/* ----------------------------------- correctness ----------------------------------- */

test("moving averages get distinct colours", () => {
  // Two SMAs in the same blue are indistinguishable on a chart, which makes the plot useless.
  const src = buildPine({ ...BASE, panels: [], signals: [], levels: [] });
  const maColors = [...src.matchAll(/plot\((?:sma|ema)\d+.*?color\.new\((#[0-9a-f]{6})/g)].map((m) => m[1]);
  assert.equal(new Set(maColors).size, maColors.length, `colours repeat: ${maColors.join(", ")}`);
});

test("a signal may only reference a declared series", () => {
  assert.throws(
    () => buildPine({ ...BASE, signals: [{ name: "bad", left: "sma999", op: ">", right: 0 }] }),
    /not a declared series/,
  );
  // …and the error says what IS available, rather than leaving the caller to guess.
  assert.throws(() => buildPine({ ...BASE, signals: [{ name: "bad", left: "nope", op: ">", right: 0 }] }), /Available:/);
});

test("price builtins and level constants are valid operands", () => {
  const src = buildPine(BASE);
  assert.match(src, /sig_break_resistance = ta\.crossover\(close, res1\)/);
});

test("an invalid period or operator fails loudly instead of emitting a broken script", () => {
  assert.throws(() => buildPine({ ...BASE, overlays: [{ kind: "sma", period: 0 }] }), /positive integer/);
  assert.throws(() => buildPine({ ...BASE, overlays: [{ kind: "sma", period: 1.5 }] }), /positive integer/);
  assert.throws(
    () => buildPine({ ...BASE, panels: [{ kind: "macd", fast: 26, slow: 12, signal: 9 }] }),
    /must be shorter than/,
  );
  assert.throws(
    () => buildPine({ ...BASE, signals: [{ name: "x", left: "close", op: "≈" as never, right: 1 }] }),
    /Unknown operator/,
  );
});

test("duplicate signal names are rejected rather than silently colliding", () => {
  assert.throws(
    () =>
      buildPine({
        ...BASE,
        signals: [
          { name: "cross", left: "sma20", op: "crossover", right: "sma50" },
          { name: "cross!", left: "sma20", op: "crossunder", right: "sma50" },
        ],
      }),
    /Duplicate signal name/,
  );
});

/* ------------------------------------- injection ------------------------------------- */

/** Does `needle` appear as executable Pine, rather than inside a string or comment? */
function appearsAsCode(source: string, needle: string): boolean {
  return codeOnly(source).some((line) => line.includes(needle));
}

test("SECURITY: free text cannot escape a string literal OR a comment", () => {
  // Both contexts, because escaping is per-context: the title is used in a `//` header AND in
  // indicator(). Escaping it for one and not the other was a live injection here — a newline ends
  // a comment, so `strategy.close_all()` landed on its own line as a statement.
  const src = buildPine({
    ...BASE,
    title: 'evil", overlay = false)\nstrategy.close_all()\n//',
    signals: [{ name: "x", left: "close", op: ">", right: 1, message: 'a" + str.tostring(close) + "' }],
  });
  assert.equal(appearsAsCode(src, "strategy.close_all"), false, "raw code reached the output as code");
  assert.equal(appearsAsCode(src, "str.tostring"), false, "an alert message escaped its literal");
  assert.match(src, /\\"/, "the quote should be escaped, not dropped");
  assert.equal(validatePine(src).ok, true, "an escaped script must still be structurally sound");
});

test("SECURITY: a hostile title cannot add a second declaration", () => {
  const src = buildPine({ ...BASE, title: 'a")\nindicator("b' });
  const declarations = codeOnly(src).filter((l) => /^\s*(indicator|strategy)\s*\(/.test(l));
  assert.equal(declarations.length, 1, `two declarations emitted: ${declarations.join(" | ")}`);
});

test("SECURITY: a signal name cannot inject an identifier", () => {
  const src = buildPine({
    ...BASE,
    signals: [{ name: "x = 1\nstrategy.close_all()\ny", left: "close", op: ">", right: 1 }],
  });
  assert.equal(appearsAsCode(src, "strategy.close_all()"), false);
  assert.match(src, /sig_x_1_strategy_close_all_y = /);
});

test("pineString and pineIdent are conservative on their own", () => {
  assert.equal(pineString('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(pineString("a\nb"), '"a b"', "a newline would end the statement");
  assert.equal(pineIdent("20/50 cross", "fallback"), "_20_50_cross");
  assert.equal(pineIdent("!!!", "fallback"), "fallback");
  assert.equal(pineIdent("9lives", "fallback"), "_9lives", "an identifier may not start with a digit");
  assert.equal(pineComment("a\nb"), "a b", "a newline would end the comment and free what follows");
  assert.equal(pineComment("  x  "), "x");
});

/* ------------------------------------- strategy ------------------------------------- */

test("a strategy emits orders and refuses to reference a signal that does not exist", () => {
  const src = buildPine({
    ...BASE,
    kind: "strategy",
    alerts: false,
    strategy: { longWhen: "20/50 golden cross", exitWhen: "RSI oversold", stopLossPct: 3, takeProfitPct: 6 },
  });
  assert.match(src, /^strategy\(/m);
  assert.match(src, /strategy\.entry\("long", strategy\.long\)/);
  assert.match(src, /strategy\.close\("long"\)/);
  assert.match(src, /stop = strategy\.position_avg_price \* \(1 - 3 \/ 100\)/);
  assert.match(src, /limit = strategy\.position_avg_price \* \(1 \+ 6 \/ 100\)/);

  assert.throws(
    () => buildPine({ ...BASE, kind: "strategy", strategy: { longWhen: "no such signal" } }),
    /unknown signal/,
  );
});

test("alertcondition is not emitted in a strategy, where Pine forbids it", () => {
  const src = buildPine({ ...BASE, kind: "strategy", alerts: true, strategy: { longWhen: "RSI oversold" } });
  assert.equal(src.includes("alertcondition"), false);
});

test("an indicator emits one alert per signal", () => {
  const src = buildPine(BASE);
  assert.equal((src.match(/alertcondition\(/g) ?? []).length, BASE.signals!.length);
  assert.match(src, /message = "BBRI: RSI oversold"/, "the default message should name the symbol");
});

/* --------------------------------------- panes --------------------------------------- */

test("each oscillator gets its own script, because a script lives in exactly one pane", () => {
  const scripts = buildPineScripts(BASE);
  assert.deepEqual(scripts.map((s) => s.pane), ["price", "rsi", "macd"]);
  assert.match(scripts[0].source, /overlay = true/);
  for (const panel of scripts.slice(1)) {
    assert.match(panel.source, /overlay = false/);
    assert.equal(panel.source.includes("display.none"), false, "a hidden plot tells the user it drew nothing");
  }
});

test("the price script still DECLARES panel series a signal references", () => {
  // "RSI oversold" lives in the price script; without rsi14 declared there it will not compile.
  const price = buildPineScripts(BASE)[0].source;
  assert.match(price, /rsi14 = ta\.rsi\(close, 14\)/);
  assert.equal(/^plot\(rsi14/m.test(price), false, "but it must not be plotted on the price pane");
});

test("the RSI pane draws its 30/70 guides and MACD its zero line", () => {
  const scripts = buildPineScripts(BASE);
  const rsi = scripts.find((s) => s.pane === "rsi")!.source;
  assert.match(rsi, /hline\(30,/);
  assert.match(rsi, /hline\(70,/);
  assert.match(scripts.find((s) => s.pane === "macd")!.source, /hline\(0,/);
});

/* ------------------------------------ validation ------------------------------------ */

test("everything this module generates passes its own structural check", () => {
  for (const spec of [
    BASE,
    { ...BASE, kind: "strategy" as const, alerts: false, strategy: { longWhen: "RSI oversold", stopLossPct: 2 } },
    { ...BASE, levels: [], signals: [], panels: [] },
    // Signals dropped along with the series they referenced — keeping them is correctly an error,
    // which the "may only reference a declared series" test covers.
    { ...BASE, overlays: [], signals: [], levels: [], panels: [{ kind: "atr" as const, period: 14 }] },
  ]) {
    for (const script of buildPineScripts(spec)) {
      const result = validatePine(script.source);
      assert.equal(result.ok, true, `${script.title}: ${JSON.stringify(result.issues)}`);
    }
  }
});

test("the validator catches the mistakes generation can actually make", () => {
  const cases: Array<[string, RegExp]> = [
    ["indicator(\"x\")\nplot(close)", /version/],
    ["//@version=6\nplot(close", /unclosed/],
    ["//@version=6\nplot close)", /no opener/],
    ["//@version=6\nx = 1", /no indicator/],
    ['//@version=6\nindicator("a")\nstrategy("b")', /more than one/],
    ['//@version=6\nindicator("a")\nx = 1\nx = 2', /assigned again/],
    ['//@version=6\nindicator("a\nplot(close)', /unterminated string/],
  ];
  for (const [source, pattern] of cases) {
    const result = validatePine(source);
    assert.equal(result.ok, false, `should have rejected: ${JSON.stringify(source)}`);
    assert.ok(
      result.issues.some((i) => pattern.test(i.message)),
      `expected ${pattern} in ${JSON.stringify(result.issues)}`,
    );
  }
});

test("brackets inside strings and comments are not counted", () => {
  // The naive version of this check rejects every script with a parenthesis in a title.
  const src = '//@version=6\nindicator("a (b) [c]")  // and ) here\nplot(close)';
  assert.deepEqual(validatePine(src).issues, []);
});

test("more plots than Pine allows is reported", () => {
  const many = Array.from({ length: 65 }, (_, i) => `plot(close, title = "p${i}")`).join("\n");
  const result = validatePine(`//@version=6\nindicator("x")\n${many}`);
  assert.ok(result.issues.some((i) => /at most 64/.test(i.message)));
});

/* ------------------------------------- plumbing ------------------------------------- */

test("declaredSeries is the single source of the identifiers signals may use", () => {
  const ids = declaredSeries(BASE).map((s) => s.id);
  assert.deepEqual(ids, [
    "sma20", "sma50", "bbMiddle", "bbDev", "bbUpper", "bbLower", "rsi14", "macdLine", "macdSignal", "macdHist",
  ]);
});

test("an empty spec still produces a valid, if plain, script", () => {
  const src = buildPine({ symbol: "TLKM", kind: "indicator" });
  assert.equal(validatePine(src).ok, true);
  assert.match(src, /indicator\(/);
});

test("a missing symbol is refused", () => {
  assert.throws(() => buildPine({ symbol: "", kind: "indicator" }), /symbol is required/);
});
