/**
 * MCP tool registration. Each tool is a thin wrapper over `core/`, mapped to a confirmed endpoint
 * (see docs/stockbit-api.md §4).
 *
 * The tools here read. The ones that write live in the family modules registered at the bottom of
 * `registerTools`, go through `define.write`, and are therefore unreachable from a saved workflow
 * recipe. What actually enforces any of that is the transport's route table, not this comment.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as core from "../core/index.js";
import { runImageTool, runTool } from "./_format.js";
import { renderSankey } from "../render/sankey.js";
import { renderCandles, type Annotation, type SubPanel } from "../render/candles.js";
import { defaultChartPath, defaultPinePath, writePine, writeSvg } from "../render/write.js";
import {
  buildPineScripts,
  validatePine,
  type Overlay,
  type Panel,
  type PineSpec,
} from "../pine/emit.js";
import {
  describeCondition,
  evaluateRule,
  validateRule,
  warmupBars,
  type AlertRule,
} from "../alerts/rules.js";
import { addRule, loadRules, newRuleId, removeRule, updateRule } from "../alerts/store.js";
import { StockbitError } from "../http/errors.js";
import { detectStockbit, ensureStockbitOpen, installedBrowsers, stockbitUrl } from "../desktop/browser.js";
import {
  OPERATORS,
  OVERLAY_NAMES,
  PANEL_NAMES,
  defineSeries,
  overlaysFrom,
  panelsFrom,
} from "../analysis/series.js";
import { backtest, compareStrategies } from "../analysis/backtest.js";
import { walkForward, type Fold } from "../analysis/robustness.js";
import { PRESET_IDS, presetSpec, type StrategySpec } from "../analysis/strategy.js";
import { detectPatterns, type PatternId } from "../analysis/patterns.js";
import { alignment } from "../analysis/timeframe.js";
import { analyze, type AnalyzeDeps } from "../analysis/analyze.js";
import { scan, symbolOf, type UniverseSource } from "../analysis/scan.js";
import { normalizeSymbol } from "../symbol.js";
import { BUILTIN_WORKFLOWS, findWorkflow } from "../workflows/builtin.js";
import { runWorkflow, validateWorkflow } from "../workflows/run.js";
import { makeDefiner } from "./_define.js";
import { registerStreamTools } from "./stream.js";
import { registerCompanyTools } from "./company.js";
import { registerFundamentalsTools } from "./fundamentals.js";
import { registerInsiderTools } from "./insider.js";
import { registerMarketTools } from "./market.js";
import { registerBrokerTools } from "./brokers.js";
import { registerCorpactionTools } from "./corpaction.js";
import { registerScreenerTools } from "./screener.js";
import { registerChartbitTools } from "./chartbit.js";
import { registerTradingTools } from "./trading.js";
import { registerEipoTools } from "./eipo.js";
import { registerAccountWriteTools } from "./account.js";

/** Sub-panel titles, matching the periods `PANEL_PRESETS` declares. */
const PANE_LABELS = { rsi: "RSI(14)", macd: "MACD(12,26,9)", atr: "ATR(14)" } as const;

/**
 * A strategy from tool arguments: a preset, or a hand-written condition pair.
 *
 * A preset that also carries stop/target/hold overrides is the common case, so the two are not
 * exclusive — but a half-specified custom condition is refused rather than silently ignored, since
 * a caller who passed `entry_left` and forgot `entry_op` would otherwise get a preset they did not
 * ask for and no indication of it.
 */
function specFrom(a: {
  strategy?: (typeof PRESET_IDS)[number];
  overlays?: readonly string[];
  panels?: readonly string[];
  entry_left?: string | number;
  entry_op?: (typeof OPERATORS)[number];
  entry_right?: string | number;
  exit_left?: string | number;
  exit_op?: (typeof OPERATORS)[number];
  exit_right?: string | number;
  stop_loss_pct?: number;
  take_profit_pct?: number;
  max_hold_bars?: number;
}): StrategySpec {
  const custom = a.entry_left !== undefined || a.entry_op !== undefined || a.entry_right !== undefined;

  let spec: StrategySpec;
  if (custom) {
    if (a.entry_left === undefined || a.entry_op === undefined || a.entry_right === undefined) {
      throw new StockbitError(
        "invalid_param",
        "A custom entry needs all three of entry_left, entry_op and entry_right.",
      );
    }
    const exitGiven = a.exit_left !== undefined || a.exit_op !== undefined || a.exit_right !== undefined;
    if (exitGiven && (a.exit_left === undefined || a.exit_op === undefined || a.exit_right === undefined)) {
      throw new StockbitError("invalid_param", "A custom exit needs all three of exit_left, exit_op and exit_right.");
    }
    spec = {
      name: "custom",
      overlays: overlaysFrom(a.overlays),
      panels: panelsFrom(a.panels),
      entry: { left: a.entry_left, op: a.entry_op, right: a.entry_right },
      exit: exitGiven ? { left: a.exit_left!, op: a.exit_op!, right: a.exit_right! } : undefined,
    };
  } else if (a.strategy) {
    spec = presetSpec(a.strategy);
  } else {
    throw new StockbitError(
      "invalid_param",
      `Pass a \`strategy\` (${PRESET_IDS.join(", ")}) or a custom entry_left/entry_op/entry_right.`,
    );
  }

  if (a.stop_loss_pct !== undefined) spec.stopLossPct = a.stop_loss_pct;
  if (a.take_profit_pct !== undefined) spec.takeProfitPct = a.take_profit_pct;
  if (a.max_hold_bars !== undefined) spec.maxHoldBars = a.max_hold_bars;
  return spec;
}

/** A fold without its two full backtests — those would be two trade logs and two equity curves. */
function foldSummary(fold: Fold) {
  return {
    index: fold.index,
    trainFrom: fold.trainFrom,
    trainTo: fold.trainTo,
    testFrom: fold.testFrom,
    testTo: fold.testTo,
    trainBars: fold.trainBars,
    testBars: fold.testBars,
    trainReturnPct: fold.train.metrics.totalReturnPct,
    testReturnPct: fold.test.metrics.totalReturnPct,
    testTrades: fold.test.metrics.trades,
  };
}

export function registerTools(server: McpServer): void {
  /**
   * Every tool handler registered below, so `workflow_run` can call them.
   *
   * Captured by intercepting `server.tool` rather than by maintaining a second table: a hand-kept
   * list would drift the first time a tool was renamed, and the workflow would fail at run time
   * naming a tool that no longer exists. The interception is undone at the end of this function so
   * nothing outside it sees a patched server.
   */
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();

  /**
   * The read/write registration pair.
   *
   * `define.read` adds a tool to `handlers`; `define.write` deliberately does not, so a saved
   * workflow recipe cannot reach a tool that changes anything. See `src/tools/_define.ts` — that
   * split is the whole mechanism, enforced by construction rather than by a list to remember.
   *
   * The families below register through it. The older tools in this file still use `server.tool`
   * and are captured by the interception; both routes end up in the same map.
   */
  const define = makeDefiner(server, handlers);

  const realTool = server.tool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { tool: (...args: unknown[]) => unknown }).tool = (...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1];
    if (typeof handler === "function") {
      handlers.set(name, handler as (a: Record<string, unknown>) => Promise<unknown>);
    }
    return realTool(...args);
  };

  /* ------------------------------ broker / bandar ------------------------------ */

  server.tool(
    "broker_summary",
    "Broker summary for an IDX stock: which brokers net-bought/sold, in lots and IDR value, with " +
      "foreign/local/govt classification. This is the core bandarmology signal — TradingView has " +
      "no equivalent.\n" +
      "DATES: omit from/to for the latest completed session. Supply BOTH from and to (YYYY-MM-DD) " +
      "for a historical window — the server aggregates net flow across it in one request, so a " +
      "multi-month range is as cheap as one day. For a single past day pass the same date twice. " +
      "Both ends are required; a half-specified range is rejected because the API would silently " +
      "return the latest session instead.\n" +
      "An empty result for a weekend or public holiday is expected, not an error.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      from: z.string().optional().describe("Range start, YYYY-MM-DD. Requires `to`."),
      to: z.string().optional().describe("Range end, YYYY-MM-DD (inclusive). Requires `from`."),
      // Accepted because a caller may reasonably reach for these spellings. The API ignores both —
      // it answers 200 with the latest session — so they are normalized onto from/to and never sent.
      date_from: z.string().optional().describe("Alias for `from`."),
      date_to: z.string().optional().describe("Alias for `to`."),
      start_date: z.string().optional().describe("Alias for `from`."),
      end_date: z.string().optional().describe("Alias for `to`."),
      limit: z.coerce.number().optional().describe("Max brokers per side (default 50; API default 25 truncates)"),
      transaction_type: z
        .enum(core.TRANSACTION_TYPES)
        .optional()
        .describe("NET (default) nets each broker's buys against its sells; GROSS does not."),
      market_board: z
        .enum(core.MARKET_BOARDS)
        .optional()
        .describe(
          "Default REGULER — the ordinary order book, and what bandarmology means. ALL folds in " +
            "negotiated blocks and can be several times larger. NEGO and TUNAI select those boards alone.",
        ),
      investor_type: z.enum(core.INVESTOR_TYPES).optional().describe("Default ALL"),
      period: z
        .enum(core.BROKER_SUMMARY_PERIODS)
        .optional()
        .describe(
          "Preset window instead of from/to — LATEST (default), YESTERDAY, LAST_7_DAYS, " +
            "LAST_3_MONTHS, YEAR_TO_DATE. The server aggregates the whole window in ONE request, so " +
            "YEAR_TO_DATE costs the same as today. Ignored when from/to are given.",
        ),
    },
    async (a) =>
      runTool(() =>
        core.getBrokerSummary({
          symbol: a.symbol,
          limit: a.limit,
          period: a.period,
          transactionType: a.transaction_type,
          marketBoard: a.market_board,
          investorType: a.investor_type,
          from: a.from,
          to: a.to,
          date_from: a.date_from,
          date_to: a.date_to,
          start_date: a.start_date,
          end_date: a.end_date,
        }),
      ),
  );

  server.tool(
    "broker_distribution",
    "Broker-to-broker flow for an IDX stock, ALWAYS rendered as an SVG diagram laid out " +
      "BUYER -> SELLER exactly like Stockbit's own Broker Distribution: top buyers on the left, " +
      "the sellers they bought from on the right. Each seller's bar is that seller's TOTAL, so a " +
      "partly-filled bar means the buyers shown account for only part of what it sold. For each top " +
      "broker, WHICH brokers were on the other side of their trades and how much moved between " +
      "them. broker_summary says how much a broker accumulated; this shows who they accumulated " +
      "it from.\n" +
      "Returns the diagram as an image AND writes a .svg file, reporting the path in `savedTo` " +
      "(pass `save_path` to choose where). It deliberately does NOT return a table of numbers — " +
      "the picture is the output. Use broker_summary for per-broker figures.\n" +
      "DATES: pass a `period` preset, or BOTH `from` and `to` (YYYY-MM-DD). from/to override period.\n" +
      "data_type=VALUE is IDR, VOLUME is LOTS (1 lot = 100 shares); the summary states which.\n" +
      "REQUIRES a Stockbit account with at least Rp 10,000,000 total balance — Stockbit gates this " +
      "feature. If the account does not qualify the tool returns an error saying so.\n" +
      "An empty diagram on a weekend or public holiday is expected, not an error.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      data_type: z.enum(["VALUE", "VOLUME"]).optional().describe("Default VALUE (IDR). VOLUME returns lots (1 lot = 100 shares)."),
      investor_type: z.enum(["ALL", "FOREIGN", "DOMESTIC"]).optional().describe("Default ALL"),
      market_board: z
        .enum(core.DISTRIBUTION_BOARDS)
        .optional()
        .describe("Default REGULER, matching Stockbit's UI. ALL folds in negotiated blocks and changes the numbers a lot."),
      period: z
        .enum(core.DISTRIBUTION_PERIODS)
        .optional()
        .describe("Preset window; default LAST_1_DAY. Ignored when from/to are given."),
      from: z.string().optional().describe("Window start, YYYY-MM-DD. Requires `to`."),
      to: z.string().optional().describe("Window end, YYYY-MM-DD (inclusive). Requires `from`."),
      date_from: z.string().optional().describe("Alias for `from`."),
      date_to: z.string().optional().describe("Alias for `to`."),
      start_date: z.string().optional().describe("Alias for `from`."),
      end_date: z.string().optional().describe("Alias for `to`."),
      theme: z.enum(["dark", "light"]).optional().describe("Palette. Default dark."),
      top_sources: z.coerce.number().optional().describe("Source brokers to draw (default 8)"),
      top_targets: z.coerce.number().optional().describe("Counterparties to draw; the rest merge into an 'others' band (default 12)"),
      save_path: z.string().optional().describe("Where to write the .svg. Defaults to ~/.stockbit/charts/."),
      open_in_stockbit: z
        .boolean()
        .optional()
        .describe("Open the symbol's Stockbit page in the user's browser. Default true."),
      browser: z
        .string()
        .optional()
        .describe("Browser to open Stockbit in, by name, e.g. \"Edge\". Defaults to STOCKBIT_WEB_BROWSER, else the OS default."),
    },
    async (a) =>
      runImageTool(async () => {
        const d = await core.getBrokerDistribution({
          symbol: a.symbol,
          dataType: a.data_type,
          investorType: a.investor_type,
          marketBoard: a.market_board,
          period: a.period,
          from: a.from,
          to: a.to,
          date_from: a.date_from,
          date_to: a.date_to,
          start_date: a.start_date,
          end_date: a.end_date,
        });
        // Always buyers -> sellers, matching Stockbit. Each seller's bar is its TRUE total, so
        // the picture states the seller's whole position rather than only the slice the drawn
        // buyers account for.
        const brokers = d.topBuyers;
        const sellerTotals = new Map(d.topSellers.map((s) => [s.code, s.amount]));
        const svg = renderSankey(brokers, {
          symbol: d.symbol,
          unit: d.amountUnit,
          from: d.from,
          to: d.to,
          targetTotals: sellerTotals,
          topSources: a.top_sources,
          topTargets: a.top_targets,
          theme: a.theme,
          board: `${d.marketBoard.toLowerCase()} board`,
        });

        // Always written, not only on request: the file is the durable artifact, and MCP clients
        // differ in whether they render an inline SVG. A caller whose client shows nothing still
        // has a path to open.
        const savedTo = writeSvg(
          a.save_path ??
            defaultChartPath({ symbol: d.symbol, side: "buy-to-sell", from: d.from, to: d.to, dataType: d.dataType }),
          svg,
        );

        // The symbol page, not a broker deep link: Stockbit's Broker Analysis route carries no
        // symbol and redirects away when one is appended, so a guessed URL would open the wrong
        // stock. See `stockbitUrl`.
        const stockbit =
          a.open_in_stockbit === false
            ? { url: stockbitUrl(d.symbol, "symbol"), action: "skipped" as const, via: undefined }
            : await ensureStockbitOpen({ symbol: d.symbol, view: "symbol", browser: a.browser });

        return {
          base64: Buffer.from(svg, "utf8").toString("base64"),
          mimeType: "image/svg+xml",
          // Metadata only — no per-broker table. The diagram is the answer; broker_summary is
          // where the figures live.
          summary: {
            success: true,
            data: {
              symbol: d.symbol,
              direction: "buyers bought from sellers",
              from: d.from,
              to: d.to,
              amountUnit: d.amountUnit,
              dataType: d.dataType,
              marketBoard: d.marketBoard,
              brokersCharted: Math.min(brokers.length, a.top_sources ?? 8),
              savedTo,
              stockbitUrl: stockbit.url,
              stockbitBrowser: stockbit.action,
              stockbitOpenedIn: stockbit.via,
            },
          },
        };
      }),
  );

  /* ----------------------------------- alerts ----------------------------------- */

  server.tool(
    "alert_create",
    "Create a price or indicator alert on an IDX stock, stored on this machine.\n" +
      "The condition uses the SAME grammar as `pine_script` signals and is evaluated with the same " +
      "indicator maths, so an alert and the Pine alertcondition for it agree.\n" +
      "Reference a declared series (sma20, sma50, rsi14, macdLine, macdSignal, bbUpper…), a price " +
      "field (close, high, low, volume, hl2…), or a number. Declare what you reference via " +
      "`overlays`/`panels` — the tool refuses a condition it cannot evaluate rather than storing a " +
      "rule that silently never fires.\n" +
      "Alerts fire once per bar. Nothing is delivered automatically — `alert_check` evaluates them; " +
      "there is no background daemon yet.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      name: z.string().describe("What this alert means, e.g. 'RSI oversold'"),
      left: z.union([z.string(), z.coerce.number()]).describe("Series id, price field, or number"),
      op: z.enum(["crossover", "crossunder", "cross", ">", "<", ">=", "<="]),
      right: z.union([z.string(), z.coerce.number()]),
      overlays: z
        .array(z.enum(OVERLAY_NAMES))
        .optional()
        .describe("Price series the condition references"),
      panels: z.array(z.enum(PANEL_NAMES)).optional().describe("Oscillators the condition references"),
      cooldown_minutes: z.coerce.number().optional().describe("Minimum minutes between fires. Default 0 (once per bar)."),
      note: z.string().optional().describe("Free text for your own reference"),
    },
    async (a) =>
      runTool(async () => {
        const rule: AlertRule = {
          id: newRuleId(),
          symbol: normalizeSymbol(a.symbol),
          name: a.name,
          overlays: overlaysFrom(a.overlays),
          panels: panelsFrom(a.panels),
          left: a.left,
          op: a.op,
          right: a.right,
          cooldownMinutes: a.cooldown_minutes ?? 0,
          enabled: true,
          createdAt: new Date().toISOString(),
          note: a.note,
        };
        // Fails here rather than at fire time: a rule referencing a series nobody declared would
        // otherwise sit in the file looking healthy and never fire.
        validateRule(rule);
        addRule(rule);
        return {
          created: rule,
          condition: describeCondition(rule),
          barsNeeded: warmupBars(rule),
          note: "Run alert_check to evaluate. No background delivery yet — nothing fires on its own.",
        };
      }),
  );

  server.tool(
    "alert_list",
    "List the alert rules stored on this machine, with when each last fired.",
    { symbol: z.string().optional().describe("Only rules for this ticker") },
    async (a) =>
      runTool(async () => {
        const symbol = a.symbol ? normalizeSymbol(a.symbol) : undefined;
        const rules = loadRules().filter((r) => !symbol || r.symbol === symbol);
        return {
          count: rules.length,
          rules: rules.map((r) => ({ ...r, condition: describeCondition(r) })),
        };
      }),
  );

  server.tool(
    "alert_delete",
    "Delete an alert rule by id, or disable it instead with `disable_only`.",
    {
      id: z.string().describe("Rule id from alert_list"),
      disable_only: z.boolean().optional().describe("Keep the rule but stop it firing. Default false."),
    },
    async (a) =>
      runTool(async () => {
        if (a.disable_only) {
          const updated = updateRule(a.id, { enabled: false });
          if (!updated) throw new StockbitError("not_found", `No alert rule with id ${a.id}`);
          return { disabled: updated.id, name: updated.name };
        }
        const removed = removeRule(a.id);
        if (!removed) throw new StockbitError("not_found", `No alert rule with id ${a.id}`);
        return { deleted: removed.id, name: removed.name };
      }),
  );

  server.tool(
    "alert_check",
    "Evaluate stored alert rules against current Stockbit bars and report which fired.\n" +
      "Fetches only the symbols with rules, and only as much history as the slowest indicator needs. " +
      "A rule that fires is recorded so it does not fire again for the same bar.\n" +
      "`reason` on a rule that did not fire distinguishes 'condition-false' from 'warming-up' — the " +
      "second means there is not yet enough history to judge, which is NOT the same as a no.",
      {
      symbol: z.string().optional().describe("Only check rules for this ticker"),
      dry_run: z.boolean().optional().describe("Evaluate without recording fires, so a check can be repeated. Default false."),
    },
    async (a) =>
      runTool(async () => {
        const symbol = a.symbol ? normalizeSymbol(a.symbol) : undefined;
        const rules = loadRules().filter((r) => !symbol || r.symbol === symbol);
        if (rules.length === 0) return { checked: 0, fired: [], evaluations: [] };

        // One instant for the whole batch, so two rules with the same cooldown cannot disagree
        // about whether it has elapsed.
        const now = new Date();

        // Grouped by symbol: ten rules on BBRI are one bar fetch, not ten.
        const bySymbol = new Map<string, AlertRule[]>();
        for (const rule of rules) {
          const list = bySymbol.get(rule.symbol) ?? [];
          list.push(rule);
          bySymbol.set(rule.symbol, list);
        }

        const evaluations = [];
        for (const [sym, group] of bySymbol) {
          const need = Math.max(...group.map((r) => warmupBars(r)), 60);
          let bars: Awaited<ReturnType<typeof core.getBars>>["bars"] = [];
          let error: string | undefined;
          try {
            bars = (await core.getBars({ symbol: sym, bars: need })).bars;
          } catch (err) {
            // One dead symbol must not abort the whole check — the other rules still have answers.
            error = err instanceof Error ? err.message : String(err);
          }
          for (const rule of group) {
            if (error) {
              evaluations.push({
                ruleId: rule.id, symbol: sym, name: rule.name, fired: false,
                reason: "no-data" as const, condition: describeCondition(rule), error,
              });
              continue;
            }
            const result = evaluateRule(rule, bars, now);
            if (result.fired && !a.dry_run) {
              updateRule(rule.id, { lastFiredBar: result.barDate, lastFiredAt: now.toISOString() });
            }
            if (!a.dry_run) updateRule(rule.id, { lastCheckedAt: now.toISOString() });
            evaluations.push(result);
          }
        }

        return {
          checked: evaluations.length,
          dryRun: a.dry_run === true,
          fired: evaluations.filter((e) => e.fired),
          evaluations,
        };
      }),
  );

  /* --------------------------------- pine script --------------------------------- */

  server.tool(
    "pine_script",
    "Generate TradingView Pine Script v6 for an IDX stock — indicators, support/resistance, " +
      "signals, alert conditions, or a backtestable strategy.\n" +
      "The indicators are emitted as the TradingView builtins whose definitions MATCH what " +
      "`technicals` computes (ta.sma/ta.ema/ta.rsi/ta.atr/ta.macd, and ta.stdev for Bollinger, " +
      "which is population SD like ours), so the script plots the same numbers the user was shown.\n" +
      "Support/resistance are written in as CONSTANTS from Stockbit's bars, not recomputed in " +
      "Pine — recomputing would use TradingView's data, a different source that would quietly " +
      "disagree. Set `include_levels: false` to skip them, which also means NO Stockbit API call " +
      "is made and the tool works without a live session.\n" +
      "Returns one script per pane: price plus a separate one for each oscillator, because " +
      "TradingView puts a script in exactly one pane and an RSI on an overlay flattens the price " +
      "axis. Each is also written to a .pine file.\n" +
      "`validation` is a STRUCTURAL check only — brackets, pragma, duplicate assignments. It is " +
      "not a compiler and passing it does not guarantee TradingView will accept the script.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      kind: z.enum(["indicator", "strategy"]).optional().describe("Default indicator. strategy adds orders and is backtestable."),
      title: z.string().optional().describe("Script title shown in TradingView"),
      overlays: z
        .array(z.enum(OVERLAY_NAMES))
        .optional()
        .describe("Price overlays. Default sma20 + sma50."),
      panels: z.array(z.enum(PANEL_NAMES)).optional().describe("Oscillators, each as its own script. Default rsi."),
      include_levels: z
        .boolean()
        .optional()
        .describe("Embed support/resistance from Stockbit bars (default true). false skips the API call entirely."),
      bars: z.coerce.number().optional().describe("Sessions to derive levels from (default 200)"),
      from: z.string().optional().describe("Earliest session, YYYY-MM-DD"),
      to: z.string().optional().describe("Latest session, YYYY-MM-DD"),
      signals: z
        .array(
          z.object({
            name: z.string().describe("Signal name; becomes the alert title"),
            left: z.union([z.string(), z.coerce.number()]).describe("A declared series (sma20, rsi14, macdLine, bbUpper, res1, sup1…), a price ref (close, high…), or a number"),
            op: z.enum(["crossover", "crossunder", "cross", ">", "<", ">=", "<="]),
            right: z.union([z.string(), z.coerce.number()]),
            message: z.string().optional().describe("Alert text; defaults to 'SYMBOL: name'"),
          }),
        )
        .optional()
        .describe("Conditions to compute. Only declared series and price refs may be referenced."),
      alerts: z.boolean().optional().describe("Emit alertcondition() per signal. Default true for indicators."),
      strategy_long_when: z.string().optional().describe("Signal name that opens a long (kind=strategy)"),
      strategy_exit_when: z.string().optional().describe("Signal name that closes it"),
      stop_loss_pct: z.coerce.number().optional().describe("Percent stop from entry, e.g. 3"),
      take_profit_pct: z.coerce.number().optional().describe("Percent target from entry, e.g. 6"),
      save_dir: z.string().optional().describe("Where to write the .pine files. Defaults to ~/.stockbit/pine/."),
    },
    async (a) =>
      runTool(async () => {
        const kind = a.kind ?? "indicator";
        const wantLevels = a.include_levels !== false;

        // Only touched when levels are wanted, so a script with no embedded Stockbit data needs no
        // session at all — which is the difference between this tool working and not when the
        // refresh token has expired.
        let levels: core.Level[] = [];
        let from: string | undefined;
        let to: string | undefined;
        if (wantLevels) {
          const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 200, from: a.from, to: a.to });
          levels = core.levels(series.bars, 5, 1.5).filter((l) => l.touches >= 2).slice(0, 6);
          from = series.from;
          to = series.to;
        }

        const spec: PineSpec = {
          symbol: normalizeSymbol(a.symbol),
          kind,
          title: a.title,
          overlays: overlaysFrom(a.overlays ?? ["sma20", "sma50"]),
          panels: panelsFrom(a.panels ?? ["rsi"]),
          levels,
          levelsFrom: from,
          levelsTo: to,
          signals: a.signals as PineSpec["signals"],
          alerts: kind === "indicator" && a.alerts !== false,
          strategy: {
            longWhen: a.strategy_long_when,
            exitWhen: a.strategy_exit_when,
            stopLossPct: a.stop_loss_pct,
            takeProfitPct: a.take_profit_pct,
          },
        };

        const scripts = buildPineScripts(spec);
        return {
          symbol: spec.symbol,
          kind,
          levelsFrom: from,
          levelsTo: to,
          levelsEmbedded: levels.length,
          scripts: scripts.map((s) => {
            const validation = validatePine(s.source);
            return {
              title: s.title,
              pane: s.pane,
              savedTo: writePine(
                a.save_dir ? `${a.save_dir}/${spec.symbol}-${s.pane}` : defaultPinePath(spec.symbol, s.pane),
                s.source,
              ),
              structurallyValid: validation.ok,
              issues: validation.issues,
              source: s.source,
            };
          }),
          note:
            "Paste each script into TradingView's Pine Editor and 'Add to chart'. Structural validation " +
            "is not a compiler — TradingView is the authority on whether it compiles.",
        };
      }),
  );

  /* --------------------------------- the browser --------------------------------- */

  server.tool(
    "stockbit_web",
    "Check whether Stockbit is already open in the user's browser, and open it if it is not.\n" +
      "Use this when the user should be LOOKING at Stockbit — before walking them through a chart, " +
      "after drawing one, or when they ask to see something on the site. `price_chart` and " +
      "`broker_distribution` already call it themselves.\n" +
      "IT MATTERS WHICH BROWSER. Stockbit's chart page renders a BLANK WHITE PAGE when signed out " +
      "— no login prompt, nothing — so opening it where the user has no session looks like a broken " +
      "feature. Pass `browser` (e.g. \"Edge\") to target the one they are signed into, or set " +
      "STOCKBIT_WEB_BROWSER once. Without either, the OS default is used, which may be the wrong " +
      "one. `installed` in the result lists what is available.\n" +
      "DETECTION IS NOT EXACT EVERYWHERE. On macOS every tab of every running browser is checked. " +
      "On Windows and Linux only each window's ACTIVE tab is visible, so Stockbit sitting in a " +
      "background tab reports as closed and opening it adds a duplicate tab. `exact` in the result " +
      "says which case applied — do not tell the user Stockbit is closed when `exact` is false; " +
      "say it is not in front.\n" +
      "`check_only` reports without opening anything. `force` opens even if it looks open already.",
    {
      symbol: z.string().optional().describe("IDX ticker to open, e.g. BBRI. Omitted opens the Stockbit home page."),
      view: z
        .enum(["chart", "symbol", "home"])
        .optional()
        .describe("chart = the symbol's Chartbit page (default), symbol = its overview, home = stockbit.com"),
      check_only: z.boolean().optional().describe("Report presence without opening anything. Default false."),
      force: z.boolean().optional().describe("Open even when it already looks open. Default false."),
      browser: z
        .string()
        .optional()
        .describe("Browser to open in, by name, e.g. \"Edge\" or \"Chrome\". Must be one that is installed."),
    },
    async (a) =>
      runTool(async () => {
        const url = stockbitUrl(a.symbol, a.view);
        if (a.check_only) {
          const presence = await detectStockbit();
          return { ...presence, action: "checked-only", url, installed: installedBrowsers() };
        }
        return ensureStockbitOpen({ symbol: a.symbol, view: a.view, force: a.force, browser: a.browser });
      }),
  );

  /* ------------------------------ charts & technicals ------------------------------ */

  server.tool(
    "technicals",
    "Technical indicator readings for an IDX stock, computed from daily bars: SMA/EMA, RSI, MACD, " +
      "Bollinger Bands, ATR, and support/resistance levels found by pivot clustering.\n" +
      "Returns NUMBERS for reasoning — use `price_chart` when you want the picture. Every reading " +
      "reported is the latest defined value of its series.\n" +
      "Deep history is paged 12 sessions at a time upstream, so a large `bars` is slow; " +
      "`pagesFetched` reports what the query cost.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce.number().optional().describe("Sessions to analyse (default 200). Ignored if `from` is given."),
      from: z.string().optional().describe("Earliest session, YYYY-MM-DD"),
      to: z.string().optional().describe("Latest session, YYYY-MM-DD"),
    },
    async (a) =>
      runTool(async () => {
        const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 200, from: a.from, to: a.to });
        const bars = series.bars;
        const close = bars.map((b) => b.close);
        const m = core.macd(close);
        const bb = core.bollinger(close, 20, 2);
        const last = bars[bars.length - 1];
        return {
          symbol: series.symbol,
          from: series.from,
          to: series.to,
          sessions: bars.length,
          truncated: series.truncated,
          pagesFetched: series.pagesFetched,
          last: last && {
            date: last.date,
            open: last.open,
            high: last.high,
            low: last.low,
            close: last.close,
            volumeLots: last.volume,
            valueIdr: last.value,
            netForeignIdr: last.netForeign,
          },
          indicators: {
            sma20: core.latest(core.sma(close, 20)),
            sma50: core.latest(core.sma(close, 50)),
            sma200: core.latest(core.sma(close, 200)),
            ema20: core.latest(core.ema(close, 20)),
            rsi14: core.latest(core.rsi(close, 14)),
            macd: core.latest(m.macd),
            macdSignal: core.latest(m.signal),
            macdHistogram: core.latest(m.histogram),
            bollingerUpper: core.latest(bb.upper),
            bollingerMiddle: core.latest(bb.middle),
            bollingerLower: core.latest(bb.lower),
            atr14: core.latest(core.atr(bars, 14)),
          },
          levels: core.levels(bars, 5, 1.5).slice(0, 8),
        };
      }),
  );

  server.tool(
    "price_chart",
    "Candlestick chart for an IDX stock, ALWAYS rendered as an SVG: daily candles with volume, " +
      "optional overlays (SMA/EMA/Bollinger) and sub-panels (RSI, MACD), plus support/resistance " +
      "levels drawn on.\n" +
      "Returns the image AND writes a .svg, reporting the path in `savedTo`. Use `technicals` for " +
      "the numbers; this is the picture.\n" +
      "`annotations` draws your own levels, zones, trend lines and markers, which is how you show " +
      "the evidence behind an analysis. Drawing happens on this render only — nothing is written to " +
      "the Stockbit account.\n" +
      "Whenever this draws, it also opens the symbol's Stockbit chart in the user's own default " +
      "browser so they can compare the drawing against the live chart in their own session. " +
      "`stockbitUrl` in the result is that page; pass `open_in_stockbit: false` to skip opening it.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce.number().optional().describe("Sessions to plot (default 120)"),
      from: z.string().optional().describe("Earliest session, YYYY-MM-DD"),
      to: z.string().optional().describe("Latest session, YYYY-MM-DD"),
      overlays: z
        .array(z.enum(OVERLAY_NAMES))
        .optional()
        .describe("Price overlays. Default sma20 + sma50."),
      panels: z.array(z.enum(PANEL_NAMES)).optional().describe("Sub-panels below price. Default rsi."),
      show_levels: z.boolean().optional().describe("Draw support/resistance from pivot clustering. Default true."),
      show_volume: z.boolean().optional().describe("Default true"),
      annotations: z
        .array(
          z.object({
            kind: z.enum(["level", "zone", "trend", "marker"]),
            price: z.coerce.number().optional(),
            from: z.coerce.number().optional().describe("zone: one edge"),
            to: z.coerce.number().optional().describe("zone: other edge"),
            from_date: z.string().optional().describe("trend: start session"),
            from_price: z.coerce.number().optional(),
            to_date: z.string().optional().describe("trend: end session"),
            to_price: z.coerce.number().optional(),
            date: z.string().optional().describe("marker: session"),
            label: z.string().optional(),
            color: z.string().optional(),
          }),
        )
        .optional()
        .describe("Your own drawings on top of the chart"),
      theme: z.enum(["dark", "light"]).optional().describe("Default dark"),
      save_path: z.string().optional().describe("Where to write the .svg. Defaults to ~/.stockbit/charts/."),
      open_in_stockbit: z
        .boolean()
        .optional()
        .describe("Open the symbol's Stockbit chart in the user's browser. Default true."),
      browser: z
        .string()
        .optional()
        .describe("Browser to open Stockbit in, by name, e.g. \"Edge\". Defaults to STOCKBIT_WEB_BROWSER, else the OS default."),
    },
    async (a) =>
      runImageTool(async () => {
        const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 120, from: a.from, to: a.to });
        const bars = series.bars;

        // Drawn from the same registry the alerts and the Pine emitter use. This block used to
        // recompute each indicator inline — a third implementation of one vocabulary, and one that
        // had quietly fallen behind: it drew no ema50 and no ATR panel, so a chart asked for the
        // overlays of an alert rule came back missing lines with no error. A chart that disagrees
        // with the alert it is supposed to explain is worse than no chart.
        const defs = defineSeries(
          overlaysFrom(a.overlays ?? ["sma20", "sma50"]),
          panelsFrom(a.panels ?? ["rsi"]),
        );
        const plot = (d: (typeof defs)[number]) => ({
          label: d.label,
          series: d.compute(bars),
          color: d.color,
          // A band edge or a basis reads as context, not as a signal line.
          dashed: (d.alpha ?? 0) > 0,
        });

        const overlays = defs.filter((d) => d.pane === "price" && d.color && d.label).map(plot);

        const panels: SubPanel[] = [];
        for (const pane of ["rsi", "macd", "atr"] as const) {
          const members = defs.filter((d) => d.pane === pane && d.color);
          if (members.length === 0) continue;
          const histogram = members.find((d) => d.style === "histogram");
          panels.push({
            label: PANE_LABELS[pane],
            ...(pane === "rsi" ? { range: [0, 100] as [number, number], guides: [30, 70] } : {}),
            ...(histogram ? { histogram: histogram.compute(bars) } : {}),
            series: members.filter((d) => d !== histogram).map(plot),
          });
        }

        const annotations: Annotation[] = [];
        if (a.show_levels !== false) {
          for (const l of core.levels(bars, 5, 1.5).filter((x) => x.touches >= 2).slice(0, 5)) {
            annotations.push({ kind: "level", price: l.price, label: `${l.kind} ${l.price} (x${l.touches})` });
          }
        }
        for (const raw of a.annotations ?? []) {
          if (raw.kind === "level" && raw.price !== undefined) {
            annotations.push({ kind: "level", price: raw.price, label: raw.label, color: raw.color });
          } else if (raw.kind === "zone" && raw.from !== undefined && raw.to !== undefined) {
            annotations.push({ kind: "zone", from: raw.from, to: raw.to, label: raw.label, color: raw.color });
          } else if (
            raw.kind === "trend" &&
            raw.from_date &&
            raw.to_date &&
            raw.from_price !== undefined &&
            raw.to_price !== undefined
          ) {
            annotations.push({
              kind: "trend",
              fromDate: raw.from_date,
              fromPrice: raw.from_price,
              toDate: raw.to_date,
              toPrice: raw.to_price,
              label: raw.label,
              color: raw.color,
            });
          } else if (raw.kind === "marker" && raw.date && raw.label) {
            annotations.push({ kind: "marker", date: raw.date, price: raw.price, label: raw.label, color: raw.color });
          }
        }

        const svg = renderCandles({
          symbol: series.symbol,
          bars,
          subtitle: `${series.from} → ${series.to}  ·  ${bars.length} sessions  ·  daily`,
          overlays,
          subPanels: panels,
          annotations,
          showVolume: a.show_volume !== false,
          theme: a.theme,
        });

        const savedTo = writeSvg(
          a.save_path ??
            defaultChartPath({
              symbol: series.symbol,
              side: "price",
              from: series.from,
              to: series.to,
              dataType: "DAILY",
            }),
          svg,
        );

        // Opened after the render succeeds, so a failed chart never throws a browser window at the
        // user. The user's own browser, not an automation one — theirs holds the Stockbit session,
        // and a signed-out chart is worse than no chart because it still looks like it worked.
        const stockbit =
          a.open_in_stockbit === false
            ? { url: stockbitUrl(series.symbol, "chart"), action: "skipped" as const, via: undefined }
            : await ensureStockbitOpen({ symbol: series.symbol, view: "chart", browser: a.browser });

        return {
          base64: Buffer.from(svg, "utf8").toString("base64"),
          mimeType: "image/svg+xml",
          summary: {
            success: true,
            data: {
              symbol: series.symbol,
              from: series.from,
              to: series.to,
              sessions: bars.length,
              lastClose: bars[bars.length - 1]?.close,
              overlays: overlays.map((o) => o.label),
              panels: panels.map((p) => p.label),
              levelsDrawn: annotations.filter((x) => x.kind === "level").length,
              truncated: series.truncated,
              savedTo,
              stockbitUrl: stockbit.url,
              stockbitBrowser: stockbit.action,
              stockbitOpenedIn: stockbit.via,
            },
          },
        };
      }),
  );

  /* ---------------------------------- quotes ---------------------------------- */

  server.tool(
    "quote",
    "Real-time quote for an IDX symbol: last price, change, and best bid/offer. Also resolves the " +
      "symbol's internal company id.",
    { symbol: z.string().describe("IDX ticker, e.g. BBRI, or index e.g. IHSG") },
    async (a) => runTool(() => core.getQuote(a.symbol)),
  );

  server.tool(
    "top_movers",
    "Top gainers, losers, or most-active IDX stocks (hotlist). Returns an empty list when the " +
      "market is closed — that is expected, not an error.",
    {
      type: z.enum(["topGainer", "topLoser", "mostActive"]).describe("Which hotlist"),
      limit: z.coerce.number().optional().describe("Default 25"),
    },
    async (a) => runTool(() => core.getTopMovers(a.type, a.limit ?? 25)),
  );

  server.tool(
    "trending",
    "Trending IDX stocks right now (community-driven).",
    {},
    async () => runTool(() => core.getTrending()),
  );

  server.tool(
    "sectors",
    "List IDX sectors (id, name).",
    {},
    async () => runTool(() => core.getSectors()),
  );

  /* --------------------------------- price feed --------------------------------- */

  server.tool(
    "intraday_prices",
    "Intraday minutely close-price series for a symbol (the basis for volume/price-move signals).",
    {
      symbol: z.string().describe("IDX ticker"),
      interval: z.coerce.number().optional().describe("Minutes per point (default 1)"),
    },
    async (a) => runTool(() => core.getIntradayPrices(a.symbol, a.interval ?? 1)),
  );

  server.tool(
    "price_performance",
    "Multi-timeframe price performance (1D/1W/1M/…): close, high, low, and % change per timeframe.",
    { symbol: z.string().describe("IDX ticker") },
    async (a) => runTool(() => core.getPricePerformance(a.symbol)),
  );

  server.tool(
    "orderbook",
    "Full order-book depth ladder for a symbol.",
    { symbol: z.string().describe("IDX ticker") },
    async (a) => runTool(() => core.getOrderbook(a.symbol)),
  );

  /* -------------------------------- fundamentals -------------------------------- */

  server.tool(
    "keystats",
    "Key statistics for a company (valuation, size, performance metrics).",
    { symbol: z.string().describe("IDX ticker") },
    async (a) => runTool(() => core.getKeystats(a.symbol)),
  );

  server.tool(
    "ratios",
    "Financial ratios for a company.",
    { symbol: z.string().describe("IDX ticker") },
    async (a) => runTool(() => core.getRatios(a.symbol)),
  );

  server.tool(
    "financials",
    "Financial statements (structured tables; the large HTML report is stripped). data_type/" +
      "report_type/statement_type are integer selectors matching Stockbit's UI toggles.",
    {
      symbol: z.string().describe("IDX ticker"),
      data_type: z.coerce.number().optional(),
      report_type: z.coerce.number().optional(),
      statement_type: z.coerce.number().optional(),
    },
    async (a) =>
      runTool(() =>
        core.getFinancials({
          symbol: a.symbol,
          dataType: a.data_type,
          reportType: a.report_type,
          statementType: a.statement_type,
        }),
      ),
  );

  /* ---------------------------------- sentiment ---------------------------------- */

  server.tool(
    "sentiment_stream",
    "Recent community posts mentioning a symbol (sentiment/news proxy — not price data).",
    {
      symbol: z.string().describe("IDX ticker"),
      limit: z.coerce.number().optional().describe("Default 30"),
    },
    async (a) => runTool(() => core.getSentimentStream(a.symbol, a.limit ?? 30)),
  );

  /* ------------------------------- chart layout ------------------------------- */

  server.tool(
    "chart_settings",
    "Read the user's saved chart CONFIGURATION — theme, chart properties, drawing-toolbar state, " +
      "last-used resolution.\n" +
      "This is a different store from `chart_layout`: TradingView persists a chart's properties and " +
      "its layout separately, and Stockbit keeps them in different places. A symbol can have no " +
      "saved layout while the account still has full chart settings, so do not conclude from an " +
      "empty `chart_layout` that the user has configured nothing.\n" +
      "Account-wide, not per-symbol. Read-only.",
    {},
    async () => runTool(() => core.getChartSettings()),
  );

  /* ---------------------- backtesting, patterns & screening ---------------------- */

  server.tool(
    "backtest",
    "Run a trading strategy over Stockbit's own daily history and report what it would actually " +
      "have done: every trade, an equity curve, and metrics (return, CAGR, Sharpe, max drawdown, " +
      "win rate, profit factor, expectancy, exposure) against buy-and-hold over the SAME window.\n" +
      "Use a preset name, or supply your own entry/exit in the same condition grammar alert_create " +
      "and pine_script use — so a backtested rule, a live alert and a TradingView strategy are one " +
      "object rather than three that drift.\n" +
      "The execution model is deliberately pessimistic and it matters: signals are read at the bar " +
      "CLOSE and filled at the NEXT bar's open (never at the price the signal was computed from); a " +
      "bar that hits both stop and target resolves to the STOP; a gap through a level fills at the " +
      "open, not the level; and a session locked by IDX auto-rejection (high === low) cannot be " +
      "filled at all. Costs default to Indonesian retail: 0.15% to buy, 0.25% to sell (the extra " +
      "0.1% is the sale tax), plus 0.1% slippage, in whole 100-share lots.\n" +
      "ALWAYS read `warnings` before quoting a number. Under ten trades it says so, and it means it.\n" +
      "Set walk_forward for an out-of-sample check. Long-only: retail shorting is not available on IDX.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      strategy: z.enum(PRESET_IDS).optional().describe("A preset. Omit to supply entry/exit yourself."),
      bars: z.coerce.number().optional().describe("Sessions of history (default 500, the practical maximum)"),
      from: z.string().optional().describe("Earliest session, YYYY-MM-DD"),
      to: z.string().optional().describe("Latest session, YYYY-MM-DD"),
      overlays: z.array(z.enum(OVERLAY_NAMES)).optional().describe("Series the conditions reference"),
      panels: z.array(z.enum(PANEL_NAMES)).optional().describe("Oscillators the conditions reference"),
      entry_left: z.union([z.string(), z.coerce.number()]).optional().describe("Entry condition, left side"),
      entry_op: z.enum(OPERATORS).optional(),
      entry_right: z.union([z.string(), z.coerce.number()]).optional(),
      exit_left: z.union([z.string(), z.coerce.number()]).optional().describe("Exit condition, left side"),
      exit_op: z.enum(OPERATORS).optional(),
      exit_right: z.union([z.string(), z.coerce.number()]).optional(),
      stop_loss_pct: z.coerce.number().optional().describe("Percent below the fill price, e.g. 5"),
      take_profit_pct: z.coerce.number().optional().describe("Percent above the fill price"),
      max_hold_bars: z.coerce.number().optional().describe("Force an exit after this many bars"),
      initial_capital: z.coerce.number().optional().describe("IDR, default 10,000,000"),
      commission_buy_pct: z.coerce.number().optional().describe("Default 0.15"),
      commission_sell_pct: z.coerce.number().optional().describe("Default 0.25 (includes the 0.1% sale tax)"),
      slippage_pct: z.coerce.number().optional().describe("Default 0.1"),
      walk_forward: z.boolean().optional().describe("Also run an out-of-sample check. Costs no extra requests."),
      folds: z.coerce.number().optional().describe("Walk-forward folds, default 3"),
      include_trades: z.boolean().optional().describe("Include the full trade log. Default true."),
      include_equity: z.boolean().optional().describe("Include the equity curve, one point per bar. Default false."),
    },
    async (a) =>
      runTool(async () => {
        const spec = specFrom(a);
        const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 500, from: a.from, to: a.to });
        const options = {
          symbol: series.symbol,
          initialCapital: a.initial_capital,
          costs: {
            ...(a.commission_buy_pct === undefined ? {} : { commissionBuyPct: a.commission_buy_pct }),
            ...(a.commission_sell_pct === undefined ? {} : { commissionSellPct: a.commission_sell_pct }),
            ...(a.slippage_pct === undefined ? {} : { slippagePct: a.slippage_pct }),
          },
        };

        const result = backtest(series.bars, spec, options);
        const walk = a.walk_forward ? walkForward(series.bars, spec, { folds: a.folds, backtest: options }) : undefined;

        return {
          ...result,
          trades: a.include_trades === false ? undefined : result.trades,
          equity: a.include_equity === true ? result.equity : undefined,
          barsTruncated: series.truncated,
          pagesFetched: series.pagesFetched,
          walkForward: walk
            ? { folds: walk.folds.map(foldSummary), inSample: walk.inSample, outOfSample: walk.outOfSample, efficiency: walk.efficiency, verdict: walk.verdict }
            : undefined,
        };
      }),
  );

  server.tool(
    "strategy_compare",
    "Run every built-in strategy over ONE stock's history and rank them — the bars are fetched once " +
      "for all nine, so this costs the same as a single backtest.\n" +
      "Ranked by return ABOVE buy-and-hold over the same window and costs, not by raw return: over a " +
      "rising window every long-only strategy shows a profit, and the only question worth asking is " +
      "whether the trading added anything to owning the stock.\n" +
      "Taking the winner of nine on one window is a SELECTION, not a finding. Run `backtest` with " +
      "walk_forward on the winner before believing it.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce.number().optional().describe("Sessions of history (default 500)"),
      from: z.string().optional(),
      to: z.string().optional(),
      strategies: z.array(z.enum(PRESET_IDS)).optional().describe("Which to compare. Default: all nine."),
      stop_loss_pct: z.coerce.number().optional().describe("Applied to every strategy"),
      take_profit_pct: z.coerce.number().optional(),
      initial_capital: z.coerce.number().optional(),
    },
    async (a) =>
      runTool(async () => {
        const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 500, from: a.from, to: a.to });
        const specs = (a.strategies ?? PRESET_IDS).map((id) => {
          const spec = presetSpec(id);
          if (a.stop_loss_pct !== undefined) spec.stopLossPct = a.stop_loss_pct;
          if (a.take_profit_pct !== undefined) spec.takeProfitPct = a.take_profit_pct;
          return spec;
        });

        const comparison = compareStrategies(series.bars, specs, {
          symbol: series.symbol,
          initialCapital: a.initial_capital,
        });
        return {
          ...comparison,
          // The full result per strategy would be nine trade logs and nine equity curves; the
          // ranking plus each one's warnings is what a caller can actually read.
          results: comparison.results.map((r) => ({
            strategy: r.strategy,
            description: r.description,
            metrics: r.metrics,
            trades: r.metrics.trades,
            warnings: r.warnings,
          })),
          pagesFetched: series.pagesFetched,
        };
      }),
  );

  server.tool(
    "patterns",
    "Candlestick patterns on an IDX stock's daily bars — 16 classic formations with the prior trend " +
      "they were read against.\n" +
      "The prior trend is PART of the pattern, not decoration: a hammer and a hanging man are the " +
      "same candle, as are an inverted hammer and a shooting star, and only what came before them " +
      "tells the two apart. Set ignore_context to see the raw shapes anyway.\n" +
      "`confidence` scores how closely the candle matches the TEXTBOOK PROPORTIONS. It is not a " +
      "probability, it is not backtested, and it says nothing about what happened next — use " +
      "`backtest` for that question.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce.number().optional().describe("Sessions to search (default 120)"),
      from: z.string().optional(),
      to: z.string().optional(),
      only: z.array(z.string()).optional().describe("Restrict to these pattern ids"),
      min_confidence: z.coerce.number().optional().describe("0-1, default 0.5"),
      ignore_context: z.boolean().optional().describe("Report reversal shapes regardless of prior trend. Default false."),
      since: z.coerce.number().optional().describe("Only the last N sessions"),
    },
    async (a) =>
      runTool(async () => {
        const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 120, from: a.from, to: a.to });
        const detections = detectPatterns(series.bars, {
          only: a.only as PatternId[] | undefined,
          minConfidence: a.min_confidence,
          ignoreContext: a.ignore_context,
          since: a.since,
        });
        return {
          symbol: series.symbol,
          from: series.from,
          to: series.to,
          detections,
          count: detections.length,
          note:
            "confidence scores the SHAPE against the textbook proportions. It is not a probability " +
            "and says nothing about what followed.",
        };
      }),
  );

  server.tool(
    "timeframe_alignment",
    "Whether the daily, weekly and monthly views of a stock agree, and what each one can actually " +
      "support.\n" +
      "Stockbit serves DAILY bars only — weekly and monthly here are resampled from those sessions, " +
      "not exchange-published candles. There is NO 4H/1H/15m data: the intraday feed is a minutely " +
      "close-only series for the current session, with no open, high, low or history.\n" +
      "About 500 sessions are reachable, which is ~104 weekly and ~24 monthly bars — so a monthly " +
      "RSI(14) is reported as null rather than computed from a window that has not converged. The " +
      "`limits` field says what could not be computed and why; read it.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce.number().optional().describe("Daily sessions to fold up (default 500 — monthly needs all of them)"),
    },
    async (a) =>
      runTool(async () => {
        const series = await core.getBars({ symbol: a.symbol, bars: a.bars ?? 500 });
        return {
          ...alignment(series.bars, { symbol: series.symbol }),
          dailySessions: series.bars.length,
          barsTruncated: series.truncated,
          pagesFetched: series.pagesFetched,
        };
      }),
  );

  server.tool(
    "scan",
    "Run a condition across many IDX stocks at once — alert_check for stocks you have no rules for.\n" +
      "COST: bars are the expensive part. Throughput is capped at roughly 6.6 upstream requests a " +
      "second, so a 20-symbol moving-average screen takes ~15s and anything referencing sma200 takes " +
      "~50s. Defaults are set at that honest ceiling; raising max_symbols much past 30 will time out " +
      "before it finishes. A SECOND scan over an overlapping universe is far cheaper — bar pages are " +
      "cached for six hours once settled — so sweep broadly once, then iterate on the condition.\n" +
      "Misses distinguish `condition-false` from `warming-up` (not enough history to say yet) and " +
      "`no-data`. Truncation is always reported with its reason, so a capped sweep never reads as a " +
      "complete one.",
    {
      symbols: z.array(z.string()).optional().describe("Explicit tickers. Omit to use movers or trending."),
      universe: z
        .enum(["symbols", "watchlist", "topGainer", "topLoser", "mostActive", "trending"])
        .optional()
        .describe("Default symbols. `watchlist` sweeps your own list — usually the one you want."),
      watchlist_id: z.string().optional().describe("Which watchlist, from the `watchlist` tool. Defaults to your default list."),
      overlays: z.array(z.enum(OVERLAY_NAMES)).optional(),
      panels: z.array(z.enum(PANEL_NAMES)).optional(),
      left: z.union([z.string(), z.coerce.number()]).describe("Condition left side, e.g. close"),
      op: z.enum(OPERATORS),
      right: z.union([z.string(), z.coerce.number()]).describe("Condition right side, e.g. sma20"),
      report: z.array(z.string()).optional().describe("Series to report for each hit, e.g. [\"close\", \"rsi14\"]"),
      max_symbols: z.coerce.number().optional().describe("Default 20. See the cost note."),
      max_seconds: z.coerce.number().optional().describe("Default 45"),
    },
    async (a) =>
      runTool(async () => {
        const kind = a.universe ?? "symbols";
        const universe: UniverseSource =
          kind === "symbols"
            ? { kind: "symbols", symbols: (a.symbols ?? []).map(normalizeSymbol) }
            : kind === "watchlist"
              ? { kind: "watchlist", id: a.watchlist_id }
              : kind === "trending"
                ? { kind: "trending" }
                : { kind: "movers", type: kind };

        if (kind === "symbols" && (a.symbols ?? []).length === 0) {
          throw new StockbitError("invalid_param", "Pass `symbols`, or set `universe` to a hotlist or trending.");
        }

        return scan(
          {
            universe,
            overlays: overlaysFrom(a.overlays),
            panels: panelsFrom(a.panels),
            conditions: [{ left: a.left, op: a.op, right: a.right }],
            report: a.report,
            budget: {
              ...(a.max_symbols === undefined ? {} : { maxSymbols: a.max_symbols }),
              ...(a.max_seconds === undefined ? {} : { maxMs: a.max_seconds * 1000 }),
            },
          },
          {
            getBars: async (opts) => {
              const series = await core.getBars(opts);
              return { bars: series.bars, pagesFetched: series.pagesFetched };
            },
            resolveUniverse: async (u) => {
              if (u.kind === "symbols") return u.symbols;
              if (u.kind === "trending") return (await core.getTrending()).map(symbolOf);
              if (u.kind === "movers") return (await core.getTopMovers(u.type, 50)).map(symbolOf);
              return core.getWatchlistSymbols(u.id);
            },
            now: () => Date.now(),
          },
        );
      }),
  );

  server.tool(
    "price_bands",
    "The IDX auto-rejection band (ARA/ARB) and the session's foreign flow for a stock.\n" +
      "A stock at its ARA has no seller at any price and one at its ARB has no buyer — \"1,200 and " +
      "rising\" means something different when 1,200 IS the ceiling. Costs no extra request: these " +
      "fields already arrive inside the orderbook response.\n" +
      "A field that was not in the payload is reported as null and named in `missing`, never as zero " +
      "— zero is a real value for foreign net flow.",
    { symbol: z.string().describe("IDX ticker, e.g. BBRI") },
    async (a) => runTool(() => core.getPriceBands(a.symbol)),
  );


  server.tool(
    "watchlist",
    "The user's own Stockbit watchlists, and the symbols in one.\n" +
      "Call with no arguments to list them; pass `id` to read a list's contents. This is usually the " +
      "universe a user means by \"my stocks\" — `scan` can sweep it directly with universe=watchlist.\n" +
      "Note `volume` here is in SHARES, while daily bars report volume in LOTS (1 lot = 100 shares). " +
      "The field is named `volumeShares` so the two are never compared by accident.",
    {
      id: z.string().optional().describe("Watchlist id. Omit to list all watchlists."),
      limit: z.coerce.number().optional().describe("Max symbols (default and cap 500)"),
    },
    async (a) =>
      runTool(async () => {
        if (!a.id) {
          const lists = await core.getWatchlists();
          return {
            watchlists: lists,
            count: lists.length,
            note:
              "Stockbit reports total_items as 0 for every list regardless of contents, so it is " +
              "not returned. Pass an `id` to see what a list actually holds.",
          };
        }
        return core.getWatchlist(a.id, a.limit);
      }),
  );

  server.tool(
    "screener",
    "Stockbit's stock screener — the user's own saved screens, and the results of running one.\n" +
      "Call with no arguments to list saved screens; pass `template_id` (and the `type` from the " +
      "listing) to RUN one and get the matching stocks with their metric values. Running a screen is " +
      "a read: nothing is created, edited or saved.\n" +
      "This is IDX-specific in a way no TradingView screener can match — the metric catalogue " +
      "includes a Bandarmology group built on broker-level flow. Use `catalogue` to see what can be " +
      "screened on, or `presets` for Stockbit's built-in Guru screens.",
    {
      template_id: z.string().optional().describe("Run this saved screen. Omit to list them."),
      type: z.string().optional().describe("From the listing, e.g. TEMPLATE_TYPE_CUSTOM. Must match the template's own."),
      limit: z.coerce.number().optional().describe("Cap the matches returned"),
      catalogue: z.boolean().optional().describe("Return the screenable-metric catalogue instead (large)"),
      presets: z.boolean().optional().describe("Return Stockbit's built-in screens instead"),
      universe: z.boolean().optional().describe("Return the index scopes a screen can be limited to"),
    },
    async (a) =>
      runTool(async () => {
        if (a.catalogue) return { metrics: await core.getScreenerMetrics() };
        if (a.presets) return { presets: await core.getScreenerPresets() };
        if (a.universe) return { universe: await core.getScreenerUniverse() };
        if (!a.template_id) {
          const templates = await core.getScreenerTemplates();
          return {
            templates,
            count: templates.length,
            note: "Pass template_id AND the matching type to run one.",
          };
        }
        return core.runScreenerTemplate(a.template_id, a.type ?? "TEMPLATE_TYPE_CUSTOM", a.limit);
      }),
  );

  /* ---------------------------------- synthesis ---------------------------------- */

  server.tool(
    "analyze",
    "Weigh several readings of one IDX stock into a single lean — bullish, neutral or bearish — with " +
      "a confidence score and the evidence behind both.\n" +
      "CONFIDENCE IS NOT A PROBABILITY. It measures how complete and internally consistent the " +
      "evidence is — how many pillars were readable, whether they agree, how far the composite sits " +
      "from neutral, and how fresh the data is. It STOPS AT 90 by construction, because nothing in " +
      "this data source could justify claiming more about a future price.\n" +
      "Four weighted pillars: broker flow and positioning (0.35 — the signal no other data source " +
      "has), trend across daily/weekly/monthly (0.30), valuation (0.20), candlestick patterns (0.15). " +
      "A pillar that cannot be read is reported as MISSING, contributes nothing, and its weight is " +
      "redistributed — it never lands as a neutral vote, because 'we could not see it' and 'we looked " +
      "and it was balanced' are different answers.\n" +
      "WHAT IT CANNOT DO: there is no analyst consensus or price target anywhere in this server, so " +
      "nothing here reflects what analysts forecast. Valuation is scored against ABSOLUTE bands, not " +
      "sector peers — treat it as weak for banks, property and cyclicals. Community sentiment is " +
      "counted, never scored.\n" +
      "FLOOR-LOCKED STOCKS: when the last close sits on the auto-rejection floor, broker " +
      "accumulation-versus-distribution carries no information; the flow pillar is downgraded and says " +
      "so. Read that as unreliable, not as bearish.\n" +
      "COST: about 27 upstream requests at the default 260 bars — 22 bar pages (12 rows each) plus " +
      "five single-shot reads — issued sequentially. Use `technicals` or `timeframe_alignment` if you " +
      "only want the numbers.",
    {
      symbol: z.string().describe("IDX ticker, e.g. BBRI"),
      bars: z.coerce
        .number()
        .optional()
        .describe("Daily sessions to pull (default 260 ≈ one trading year; 500 also fills the monthly view)"),
      broker_period: z
        .enum(core.BROKER_SUMMARY_PERIODS)
        .optional()
        .describe("Broker-flow window (default LAST_7_DAYS). YEAR_TO_DATE costs the same one request."),
      pattern_window: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Sessions of candlesticks to read (default 10). Must be at least 1."),
      include_sentiment: z
        .boolean()
        .optional()
        .describe("Fetch the community post count for context (default true). Never scored."),
    },
    async (a) =>
      runTool(() => {
        const deps: AnalyzeDeps = {
          bars: (symbol, count) => core.getBars({ symbol, bars: count }),
          brokerSummary: (symbol, period) => core.getBrokerSummary({ symbol, period }),
          priceBands: (symbol) => core.getPriceBands(symbol),
          keystats: (symbol) => core.getKeystats(symbol),
          ratios: (symbol) => core.getRatios(symbol),
          sentiment: (symbol, limit) => core.getSentimentStream(symbol, limit),
        };
        return analyze(
          {
            symbol: a.symbol,
            bars: a.bars,
            brokerPeriod: a.broker_period,
            patternWindow: a.pattern_window,
            includeSentiment: a.include_sentiment,
          },
          deps,
        );
      }),
  );

  /* ------------------------------- tool families ------------------------------- */
  // One module per section of the Stockbit UI. They register through `define`, so a read joins the
  // workflow handler map and a write never does.
  registerStreamTools(define);
  registerCompanyTools(define);
  registerFundamentalsTools(define);
  registerInsiderTools(define);
  registerMarketTools(define);
  registerBrokerTools(define);
  registerCorpactionTools(define);
  registerScreenerTools(define);
  registerChartbitTools(define);
  registerTradingTools(define);
  registerEipoTools(define);
  registerAccountWriteTools(define);

  /* --------------------------------- workflows --------------------------------- */
  // Registered last, so every handler above is already captured.

  /**
   * Call a registered tool the way the MCP client would, and hand back the JSON it returned.
   *
   * Going through the real handler rather than re-implementing the call is the point: a workflow
   * that reconstructed a tool's logic would be a second implementation to keep in step, and the
   * first divergence would be invisible.
   */
  async function invokeTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const handler = handlers.get(tool);
    if (!handler) throw new Error(`Unknown tool ${JSON.stringify(tool)}`);
    // Drop keys whose template resolved to nothing, so an absent optional input stays absent
    // rather than arriving as an explicit undefined that a schema may treat differently.
    const cleaned = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== ""));
    const raw = (await handler(cleaned)) as { content?: Array<{ type: string; text?: string }> };

    const text = raw?.content?.find((c) => c.type === "text")?.text;
    if (!text) return raw;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text; // a tool that returned prose, not JSON
    }
    // A tool reports failure in its payload rather than by throwing; the workflow engine decides
    // what a failure means, so surface it as one.
    const asRecord = parsed as { success?: boolean; error?: string };
    if (asRecord && asRecord.success === false) {
      throw new Error(asRecord.error ?? `${tool} failed`);
    }
    return parsed;
  }

  server.tool(
    "workflow_list",
    "List the saved multi-step workflows and what each one needs.\n" +
      "A workflow runs several tools in one call, always the same way — use it when the user wants " +
      "a routine (a full look at one stock, a morning sweep, a bandarmology check) rather than a " +
      "single reading.",
    {},
    async () =>
      runTool(async () => ({
        count: BUILTIN_WORKFLOWS.length,
        workflows: BUILTIN_WORKFLOWS.map((w) => ({
          name: w.name,
          description: w.description,
          inputs: w.inputs,
          steps: w.steps.map((s) => ({ id: s.id, tool: s.tool, describe: s.describe, fansOut: Boolean(s.forEach) })),
        })),
      })),
  );

  server.tool(
    "workflow_run",
    "Run a saved workflow by name — several tools in one call, the same way every time.\n" +
      "Returns each step's output in order, with the time it took. A step that fails ABORTS the run " +
      "and the result names which step and why, unless that step is marked optional (its error is " +
      "recorded and the run continues). A capped fan-out reports how many items it skipped, so a " +
      "partial sweep never reads as a complete one.\n" +
      "Use `workflow_list` first to see names and required inputs.",
    {
      name: z.string().describe("Workflow name from workflow_list, e.g. deep_dive"),
      input: z
        .record(z.unknown())
        .optional()
        .describe("Inputs for the workflow, e.g. { \"symbol\": \"BBRI\" }"),
    },
    async (a) =>
      runTool(async () => {
        const workflow = findWorkflow(a.name);
        if (!workflow) {
          throw new StockbitError(
            "invalid_param",
            `No workflow named ${JSON.stringify(a.name)}. Available: ${BUILTIN_WORKFLOWS.map((w) => w.name).join(", ")}`,
          );
        }
        // Fails before running half the recipe if a step names a tool that no longer exists.
        validateWorkflow(workflow, new Set(handlers.keys()));

        const started = Date.now();
        const run = await runWorkflow(workflow, (a.input ?? {}) as Record<string, unknown>, invokeTool, () =>
          Date.now(),
        );
        return { ...run, description: workflow.description, totalMs: Date.now() - started };
      }),
  );

  // Undo the interception: nothing outside this function should see a patched server.
  (server as unknown as { tool: unknown }).tool = realTool;
}
