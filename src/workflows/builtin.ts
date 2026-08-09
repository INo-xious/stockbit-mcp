/**
 * The workflows that ship with the server.
 *
 * Each is a routine a person actually repeats — open a stock and look at everything, sweep the
 * movers, check who accumulated — expressed once so it runs the same way every time instead of
 * being reassembled from memory each session.
 *
 * They are deliberately short. A workflow's value is reproducibility, not cleverness: the moment
 * one grows conditional branches it stops being something you can read and predict, and the
 * assistant composing tools turn by turn is better at judgement than a fixed recipe could be.
 */
import type { Workflow } from "./run.js";

export const BUILTIN_WORKFLOWS: Workflow[] = [
  {
    name: "deep_dive",
    description:
      "Everything about one stock: quote, technical readings, an annotated chart, and who was on " +
      "each side of the tape. The chart also opens the live Stockbit page beside it.",
    inputs: [
      { name: "symbol", required: true, description: "IDX ticker, e.g. BBRI" },
      { name: "bars", required: false, description: "Sessions of history (default 200)" },
    ],
    steps: [
      { id: "quote", tool: "quote", describe: "Last price and best bid/offer", params: { symbol: "{{input.symbol}}" } },
      {
        id: "technicals",
        tool: "technicals",
        describe: "Indicator readings and support/resistance",
        params: { symbol: "{{input.symbol}}", bars: "{{input.bars}}" },
      },
      {
        id: "chart",
        tool: "price_chart",
        describe: "Candles with SMA/Bollinger, RSI and MACD panels, levels drawn",
        params: {
          symbol: "{{input.symbol}}",
          bars: "{{input.bars}}",
          overlays: ["sma20", "sma50", "bollinger"],
          panels: ["rsi", "macd"],
          show_levels: true,
        },
      },
      {
        id: "brokers",
        tool: "broker_distribution",
        describe: "Broker-to-broker flow for the latest session",
        // Optional: this one is gated behind a Rp 10,000,000 account balance, and a deep dive is
        // still worth having without it. A hard failure here would throw away the three steps above.
        optional: true,
        params: { symbol: "{{input.symbol}}", open_in_stockbit: false },
      },
    ],
  },

  {
    name: "morning_scan",
    description:
      "What moved, and whether the move has anything behind it: today's top gainers, then technical " +
      "readings for the leaders so a mover on no trend is distinguishable from a breakout.",
    inputs: [
      { name: "count", required: false, description: "How many movers to analyse (default 5)" },
      { name: "bars", required: false, description: "Sessions of history per stock (default 120)" },
    ],
    steps: [
      { id: "movers", tool: "top_movers", describe: "Today's top gainers", params: { type: "topGainer" } },
      {
        id: "readings",
        tool: "technicals",
        describe: "Indicators for each leader",
        // `steps.movers` is the tool envelope `{success, data}`, and `top_movers` returns its rows
        // as `data` directly — not wrapped in a `results` object. This path said `data.results` for
        // its whole life, which resolved to undefined, which is not an array, which aborted the run
        // on every single invocation. Nothing caught it because the engine tests stub a shape of
        // their own choosing, so they proved the engine works and said nothing about this recipe.
        // `test/workflows.test.ts` now runs every built-in against the tools' REAL response shapes.
        forEach: "steps.movers.data",
        limit: 5,
        params: { symbol: "{{item.symbol}}", bars: "{{input.bars}}" },
      },
    ],
  },

  {
    name: "bandar_watch",
    description:
      "Bandarmology for one stock over a window: per-broker net accumulation, then the " +
      "broker-to-broker flow diagram showing who bought from whom.",
    inputs: [
      { name: "symbol", required: true, description: "IDX ticker" },
      { name: "from", required: false, description: "Window start, YYYY-MM-DD" },
      { name: "to", required: false, description: "Window end, YYYY-MM-DD" },
    ],
    steps: [
      {
        id: "summary",
        tool: "broker_summary",
        describe: "Net accumulation per broker",
        params: { symbol: "{{input.symbol}}", from: "{{input.from}}", to: "{{input.to}}" },
      },
      {
        id: "distribution",
        tool: "broker_distribution",
        describe: "Who accumulated from whom",
        params: { symbol: "{{input.symbol}}", from: "{{input.from}}", to: "{{input.to}}" },
      },
    ],
  },

  {
    name: "alert_sweep",
    description:
      "Evaluate every stored alert and chart the ones that fired, so a fired alert arrives with the " +
      "picture that explains it rather than as a bare line of text.",
    inputs: [{ name: "symbol", required: false, description: "Only check rules for this ticker" }],
    steps: [
      { id: "check", tool: "alert_check", describe: "Evaluate stored rules", params: { symbol: "{{input.symbol}}" } },
      {
        id: "charts",
        tool: "price_chart",
        describe: "Chart each stock whose alert fired",
        forEach: "steps.check.data.fired",
        limit: 5,
        params: { symbol: "{{item.symbol}}", panels: ["rsi"], open_in_stockbit: false },
      },
    ],
  },

  {
    name: "pine_handoff",
    description:
      "Take an analysis to TradingView: read the levels from Stockbit data, then generate Pine that " +
      "plots those exact levels plus alert conditions for them.",
    inputs: [
      { name: "symbol", required: true, description: "IDX ticker" },
      { name: "bars", required: false, description: "Sessions to derive levels from (default 200)" },
    ],
    steps: [
      {
        id: "technicals",
        tool: "technicals",
        describe: "Levels and indicator state from Stockbit bars",
        params: { symbol: "{{input.symbol}}", bars: "{{input.bars}}" },
      },
      {
        id: "pine",
        tool: "pine_script",
        describe: "Pine v6 carrying those levels as constants",
        params: {
          symbol: "{{input.symbol}}",
          bars: "{{input.bars}}",
          overlays: ["sma20", "sma50", "bollinger"],
          panels: ["rsi", "macd"],
          include_levels: true,
          signals: [
            { name: "golden cross", left: "sma20", op: "crossover", right: "sma50" },
            { name: "death cross", left: "sma20", op: "crossunder", right: "sma50" },
            { name: "RSI oversold", left: "rsi14", op: "<", right: 30 },
            { name: "RSI overbought", left: "rsi14", op: ">", right: 70 },
          ],
        },
      },
    ],
  },
  {
    name: "strategy_check",
    description:
      "Has this actually worked? Read the current technical state, run every built-in strategy over " +
      "the same history, then generate TradingView Pine for the winner — one grammar the whole way, " +
      "so the script you paste into TradingView fires on the condition that was measured.",
    inputs: [
      { name: "symbol", required: true, description: "IDX ticker" },
      { name: "bars", required: false, description: "Sessions of history (default 500)" },
    ],
    steps: [
      {
        id: "technicals",
        tool: "technicals",
        describe: "Where the stock stands right now",
        params: { symbol: "{{input.symbol}}", bars: "{{input.bars}}" },
      },
      {
        id: "compare",
        tool: "strategy_compare",
        describe: "Every strategy over one history, ranked against buy-and-hold",
        params: { symbol: "{{input.symbol}}", bars: "{{input.bars}}" },
      },
      {
        id: "pine",
        tool: "pine_script",
        describe: "The winner as a TradingView script",
        // The ranking's first row. Reading it from the result rather than re-deciding here is the
        // point: the recipe cannot disagree with the comparison it just ran.
        params: {
          symbol: "{{input.symbol}}",
          kind: "strategy",
          title: "{{input.symbol}} — {{steps.compare.data.ranking.0.name}}",
          overlays: ["sma20", "sma50"],
          panels: ["rsi"],
          include_levels: true,
        },
      },
    ],
  },

  {
    name: "screen_and_dive",
    description:
      "Sweep today's movers for a condition, then look properly at the ones that matched: technical " +
      "readings and candlestick patterns for each hit, rather than a list of tickers to go and check " +
      "by hand.",
    // The condition is fixed rather than parameterised. The engine has no defaulting — an absent
    // optional input interpolates to undefined and is dropped before the tool sees it — so an
    // "optional" condition here would simply fail the scan's schema. And a workflow's value is
    // reproducibility, not configurability: a caller who wants a different condition should call
    // `scan` directly, which is one tool call rather than three.
    inputs: [{ name: "max_symbols", required: false, description: "How many movers to sweep (default 20)" }],
    steps: [
      {
        id: "scan",
        tool: "scan",
        describe: "Today's gainers, filtered to those trading above their 20-day average",
        params: {
          universe: "topGainer",
          overlays: ["sma20"],
          left: "close",
          op: ">",
          right: "sma20",
          report: ["close", "sma20"],
          max_symbols: "{{input.max_symbols}}",
        },
      },
      {
        id: "readings",
        tool: "technicals",
        describe: "Indicators for each hit",
        forEach: "steps.scan.data.hits",
        limit: 5,
        params: { symbol: "{{item.symbol}}" },
      },
      {
        id: "shapes",
        tool: "patterns",
        describe: "Candlestick patterns for each hit",
        forEach: "steps.scan.data.hits",
        limit: 5,
        params: { symbol: "{{item.symbol}}", since: 10 },
      },
    ],
  },
];

export function findWorkflow(name: string): Workflow | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.name === name);
}
