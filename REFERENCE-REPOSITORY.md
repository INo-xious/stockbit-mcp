# What `tradesdontlie/tradingview-mcp` Already Provides

Source: [`tradesdontlie/tradingview-mcp`](https://github.com/tradesdontlie/tradingview-mcp)  
Reviewed from the `main` branch on 2026-08-01.

## Summary

`tradesdontlie/tradingview-mcp` is a Node.js bridge that lets AI agents and shell users read and control a locally running TradingView Desktop application.

Unlike a market-data wrapper, it does not primarily query a separate stock or crypto API. It attaches to TradingView Desktop through the Chrome DevTools Protocol (CDP), evaluates JavaScript inside the Electron application, reads the current chart’s internal state, and invokes TradingView UI or application functions.

The repository already contains both major interfaces:

- An MCP server with **84 registered tools**.
- A substantial `tv` CLI with JSON and JSONL output.

Therefore, “turn this MCP repository into a CLI” is not an unfilled opportunity. It already has a CLI. Any new project must improve on this implementation or solve a different problem.

## At a glance

| Area | What already exists |
|---|---|
| Runtime | Node.js 18+ using ES modules |
| Desktop connection | CDP on `localhost:9222` |
| MCP | 84 tools over stdio |
| CLI | `tv` executable; 29 top-level commands and 71 nested subcommands in the reviewed source |
| Output | JSON for ordinary commands; JSONL for streams |
| Pine Script | Read, write, compile, analyze, save, open, and inspect errors/console output |
| Chart data | Quote, OHLCV, indicators, Pine graphics, strategy metrics, trades, equity, and DOM |
| Chart control | Symbol, timeframe, type, range, indicators, drawings, alerts, panes, tabs, and layouts |
| Streaming | Poll-and-diff streams for quotes, bars, values, Pine graphics, and multiple panes |
| Agent guidance | `CLAUDE.md`, five skills, and a strategy performance agent |
| Testing | Unit tests, CDP-dependent end-to-end tests, ESLint, and GitHub Actions CI |
| License | MIT for the repository’s source code |

The README contains older counts in a few places, including references to 70 or 78 tools and 30 commands with 66 subcommands. The current source registers 84 MCP tools, 29 top-level CLI commands, and 71 nested subcommands.

## How it works

```text
Claude or another MCP host
          │
          │ MCP over stdio
          ▼
Node.js MCP server
          │
          │ Chrome DevTools Protocol
          ▼
localhost:9222
          │
          ▼
TradingView Desktop (Electron)
```

The CLI uses the same core JavaScript modules:

```text
Person, shell script, or CLI-capable agent
          │
          │ tv command
          ▼
CLI router
          │
          ▼
Shared core modules
          │
          │ CDP
          ▼
TradingView Desktop
```

The repository separates its implementation into:

- `src/core/`: reusable chart, Pine, data, streaming, replay, and UI operations.
- `src/tools/`: MCP registrations and input schemas.
- `src/cli/commands/`: CLI routes that call the shared core.
- `src/server.js`: MCP server construction and stdio startup.
- `src/connection.js`: CDP discovery, connection, and JavaScript evaluation.

It has only two runtime dependencies:

- `@modelcontextprotocol/sdk`
- `chrome-remote-interface`

## Prerequisites and installation model

The project expects:

- TradingView Desktop installed locally.
- A valid TradingView subscription for the data and features being used.
- Node.js 18 or newer.
- TradingView launched with `--remote-debugging-port=9222`.

It includes launch scripts for macOS, Windows, and Linux. The `tv_launch` MCP tool and `tv launch` CLI command attempt to locate and relaunch TradingView automatically.

The documented CLI installation path is cloning the repository, running `npm install`, and optionally running `npm link` to create the global `tv` command.

## The MCP interface

The current source registers 84 MCP tools across the following groups.

### Connection and maintenance

- `tv_health_check`
- `tv_discover`
- `tv_ui_state`
- `tv_launch`
- `tv_update`

These tools check the CDP connection, inspect available internal APIs, describe visible UI state, launch TradingView with debugging enabled, and update the cloned repository.

### Chart state and navigation

- `chart_get_state`
- `chart_set_symbol`
- `chart_set_timeframe`
- `chart_set_type`
- `chart_manage_indicator`
- `chart_get_visible_range`
- `chart_set_visible_range`
- `chart_scroll_to_date`
- `symbol_info`
- `symbol_search`

These tools can inspect and mutate the active chart, search symbols, jump to dates, and zoom to exact ranges.

### Chart and strategy data

- `quote_get`
- `data_get_ohlcv`
- `data_get_indicator`
- `data_get_study_values`
- `data_get_strategy_results`
- `data_get_trades`
- `data_get_equity`
- `depth_get`

The project reads data already available inside the running TradingView application. It includes compact summary modes to reduce the amount of chart data sent to an AI model.

### Pine-generated chart objects

- `data_get_pine_lines`
- `data_get_pine_labels`
- `data_get_pine_tables`
- `data_get_pine_boxes`

These are a major capability. They inspect objects produced by custom Pine indicators, including support/resistance lines, text labels, tables, and price zones. Results can be filtered by study name and are compacted or deduplicated by default.

### Pine Script development

- `pine_get_source`
- `pine_set_source`
- `pine_compile`
- `pine_smart_compile`
- `pine_get_errors`
- `pine_get_console`
- `pine_save`
- `pine_new`
- `pine_open`
- `pine_list_scripts`
- `pine_analyze`
- `pine_check`

The repository supports a complete agent-assisted Pine workflow:

```text
read or create source
       ↓
static analysis
       ↓
inject into the Pine editor
       ↓
compile
       ↓
read errors and console output
       ↓
fix and repeat
       ↓
save the script
```

`pine_analyze` is an offline static checker for a limited collection of common mistakes. `pine_check` sends source to TradingView’s Pine compilation endpoint without requiring the desktop chart to be open.

### Indicators

- `indicator_set_inputs`
- `indicator_toggle_visibility`
- `indicator_search`
- `indicator_add`

These tools search for built-in, community, strategy, and personal indicators; add them to the chart; change inputs; and toggle visibility.

### Drawings and screenshots

- `capture_screenshot`
- `draw_shape`
- `draw_list`
- `draw_get_properties`
- `draw_remove_one`
- `draw_clear`

Supported drawing operations include horizontal lines, trend lines, rectangles, and text. Screenshots can target the full application, chart, or Strategy Tester region.

### Alerts and watchlists

- `alert_create`
- `alert_list`
- `alert_delete`
- `watchlist_get`
- `watchlist_add`
- `watchlist_add_bulk`
- `watchlist_remove`

The project can create and manage TradingView price alerts and mutate the active TradingView watchlist.

### Panes, tabs, and layouts

- `pane_list`
- `pane_set_layout`
- `pane_focus`
- `pane_set_symbol`
- `tab_list`
- `tab_new`
- `tab_close`
- `tab_switch`
- `layout_list`
- `layout_new`
- `layout_switch`

It can construct multi-chart grids, put different symbols into each pane, and manage TradingView tabs and saved layouts.

### Replay practice

- `replay_start`
- `replay_step`
- `replay_autoplay`
- `replay_trade`
- `replay_status`
- `replay_stop`

These tools automate TradingView’s Bar Replay feature. `replay_trade` is simulated replay trading, not live broker execution.

### Batch operations

- `batch_run`

This runs supported actions across multiple symbols and/or timeframes, such as gathering strategy results or taking screenshots.

### Low-level UI automation

- `ui_click`
- `ui_open_panel`
- `ui_fullscreen`
- `ui_keyboard`
- `ui_type_text`
- `ui_hover`
- `ui_scroll`
- `ui_mouse_click`
- `ui_find_element`
- `ui_evaluate`

The low-level tools provide a fallback when no purpose-built chart function exists. `ui_evaluate` can execute arbitrary JavaScript inside the TradingView page context, making it extremely powerful and correspondingly sensitive.

## The existing `tv` CLI

The repository already defines a package binary:

```json
{
  "bin": {
    "tv": "src/cli/index.js"
  }
}
```

Examples from its current command surface include:

```bash
tv status
tv launch
tv state
tv symbol AAPL
tv timeframe D
tv quote
tv ohlcv --summary
tv values
tv screenshot --region chart
tv pine compile
tv indicator add "Relative Strength Index"
tv pane layout 2x2
tv pane symbol 1 ES1!
tv alert create --price 200
tv replay start --date 2025-01-15
tv stream quote
```

### CLI command groups

The reviewed source contains these 29 top-level command names:

```text
status, launch, update
state, symbol, timeframe, type, info, search, range, scroll, discover, ui-state
quote, ohlcv, values, data
pine, screenshot, replay, draw, alert, watchlist, layout, indicator
ui, pane, tab, stream
```

Grouped commands provide 71 nested routes. Major groups include:

```text
data      lines, labels, tables, boxes, strategy, trades, equity, depth, indicator
pine      get, set, compile, raw-compile, analyze, check, save, new, open, list, errors, console
draw      shape, list, get, remove, clear
alert     list, create, delete
watchlist get, add, add-bulk, remove
indicator add, remove, toggle, set, get
pane      list, layout, focus, symbol
tab       list, new, close, switch
replay    start, step, stop, status, autoplay, trade
stream    quote, bars, values, lines, labels, tables, all
ui        click, keyboard, hover, scroll, find, eval, type, panel, fullscreen, mouse
```

### Current CLI contract

Ordinary commands:

- Serialize results as pretty-printed JSON to stdout.
- Serialize errors as JSON to stderr.
- Return exit code `0` for success.
- Return exit code `1` for general errors or unknown commands.
- Return exit code `2` for CDP connection failures.

The CLI does not currently switch to human-readable tables when attached to a terminal. It always emits JSON, and it does not expose a general `--format` option.

The argument parser uses non-strict parsing, so unknown or misspelled flags may not always be rejected as aggressively as a mature CLI should reject them.

The CLI broadly mirrors the MCP capabilities, but it is not literally a one-command-per-tool mapping. For example, the source has no dedicated top-level CLI route for `batch_run`; many MCP functions are instead grouped or represented through a different CLI route.

## Streaming

The `tv stream` implementation is a poll-and-diff loop over the local TradingView Desktop state.

It can stream:

- Current quote/bar changes.
- Latest bar updates.
- Visible indicator values.
- Pine-created lines.
- Pine-created labels.
- Pine-created tables.
- All panes in a multi-symbol layout.

Streaming behavior:

- Writes newline-delimited JSON to stdout.
- Writes lifecycle messages and warnings to stderr.
- Adds `_ts` and `_stream` metadata to emitted records.
- Suppresses exact duplicate objects by comparing serialized JSON.
- Uses polling intervals between roughly 300 ms and 2 seconds by default.
- Handles `SIGINT` and `SIGTERM` for clean shutdown.
- Retries CDP connection failures after two seconds.

This is a live data stream, but it is not a persistent alert/watch engine. It does not define predicates, crossings, hysteresis, cooldowns, durable state, missed-tick behavior, notification backends, or action hooks.

## Agent-oriented documentation already included

### `CLAUDE.md`

The repository contains a detailed decision tree teaching Claude which tools to call for common requests. It also includes context-management guidance such as using OHLCV summaries, filtering Pine objects by study, and avoiding large source retrieval unless necessary.

### Skills

Five workflow skills are included:

- `chart-analysis`
- `multi-symbol-scan`
- `pine-develop`
- `replay-practice`
- `strategy-report`

### Agent

The repository includes `agents/performance-analyst.md`, a strategy-performance analyst that gathers strategy metrics, trades, equity data, chart state, and screenshots before producing a structured evaluation.

These files make the project more usable by agents than raw MCP schemas or CLI help alone.

## Context-management features

The project intentionally reduces payload size:

- OHLCV supports a compact summary.
- Pine levels are deduplicated.
- Labels are capped.
- Tables are returned as formatted rows without all cell metadata.
- Boxes are reduced to price ranges.
- Indicator configuration filters encoded or encrypted blobs.
- `study_filter` narrows results to one indicator.
- `verbose` is opt-in.

Its research notes report that a typical chart-analysis workflow can be reduced from roughly 80 KB of context to 5–10 KB using these defaults.

## Testing and maintenance

The repository includes:

- Unit tests for CLI routing, static Pine analysis, sanitization, replay, launch behavior, chart indicators, chart history, and updates.
- End-to-end tests that require a live TradingView Desktop CDP session.
- ESLint.
- GitHub Actions on Node.js 20 and 22.
- `npm audit --audit-level=high`, currently configured as non-blocking.
- A guarded self-update operation that refuses dirty, diverged, non-main, or unsupported installations.

## Important limitations and risks

### It depends on undocumented TradingView internals

Much of the implementation reaches into internal chart widget objects, React state, Pine graphics collections, Monaco editor state, and application APIs. A TradingView Desktop update can break any of these paths without warning.

### It requires a live desktop session

Most capabilities do not work headlessly. TradingView Desktop must be installed, signed in, running, and launched with CDP enabled. This makes the project unsuitable for a normal GitHub Actions runner or a simple headless cloud server.

### CDP is a powerful local control surface

Port 9222 must never be exposed to a LAN or the public internet. A process that can reach this port may be able to inspect application state, access session-bound functionality, and execute arbitrary page-context JavaScript.

### The “no direct TradingView connection” claim has an exception

The README broadly says the tool communicates only with the local desktop application. However, the current `pine_check` implementation directly calls:

```text
https://pine-facade.tradingview.com/pine-facade/translate_light
```

Other Pine operations invoke authenticated TradingView endpoints from inside the page context. The overall system therefore does cause TradingView network activity, even though most chart control occurs through local CDP.

### Streaming is not production monitoring

The streaming loop has no durable state or alert semantics. Closing TradingView, restarting the computer, losing CDP, or changing undocumented internal structures can stop or degrade monitoring.

### It is not a trading bot

The project does not place live broker orders. Replay trades are simulated. Its own documentation forbids automated trading and algorithmic decision-making using extracted data.

### Data and account compliance remain the user’s responsibility

TradingView data, Pine source, community indicators, and exchange data remain governed by their respective terms. The repository’s MIT license applies only to its source code.

## What this means for a new project

This repository already covers the obvious “TradingView MCP plus CLI” product:

- MCP and CLI share a core.
- Agents can inspect and control the desktop application.
- Pine development is deeply integrated.
- Output is already machine-readable.
- Streaming already exists.
- Agent skills and workflow instructions already exist.

A new repository should not position itself merely as a CLI version of this project. Credible differentiation would need to come from capabilities it does not have, such as:

- A durable watch daemon with persisted state.
- Typed alert predicates and version-controlled watch definitions.
- Crossings, hysteresis, cooldowns, and market-session awareness.
- Missed-tick and restart semantics.
- Secure local action hooks and notification backends.
- A polished human interface with tables, CSV, and explicit format selection.
- Stable schemas and stricter argument validation.
- Operation without attaching to undocumented TradingView Desktop internals.

The central design question is therefore no longer “CLI or MCP?” It is whether to extend this desktop-control model or build a separate, durable monitoring product with a different data and reliability architecture.
