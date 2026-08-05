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
        forEach: "steps.movers.data.results",
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
];

export function findWorkflow(name: string): Workflow | undefined {
  return BUILTIN_WORKFLOWS.find((w) => w.name === name);
}
