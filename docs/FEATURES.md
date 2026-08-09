# Features and how to use them

26 tools over Stockbit's private API, plus a standalone alert daemon. Everything reads; one tool
writes (`chart_layout_save`) and it requires explicit confirmation.

You do not call these yourself — you ask the assistant in plain language and it picks the tool. The
argument names below matter when you want to be specific ("broker summary for BBRI from 2026-07-01
to 2026-07-31").

**Conventions used everywhere:** symbols are IDX tickers (`BBRI`, `TLKM`, `GOTO`; `IHSG` is the
composite index). Money is IDR. **Volume is LOTS** — 1 lot = 100 shares. Dates are `YYYY-MM-DD`.
Empty results on a weekend or public holiday are normal, not errors.

---


## Strategy testing (added 2026-08-09)

`backtest` runs a strategy over Stockbit's own daily history and reports every trade, an equity
curve, and metrics against buy-and-hold over the *same* window. `strategy_compare` runs all nine
presets over one bar fetch and ranks them by return above buy-and-hold.

Entry and exit use the condition grammar `alert_create` and `pine_script` already share, so one
strategy is a backtest, a live alert and a TradingView script rather than three things that drift.

The execution model is deliberately pessimistic, and each choice avoids a specific way a backtest
flatters itself:

- signals read at the bar **close**, filled at the **next** bar's open — never at the price the
  signal was computed from;
- a bar that hits both stop and target resolves to the **stop**, because daily OHLC does not record
  which came first;
- a gap through a level fills at the **open**, not the level;
- a session locked by IDX auto-rejection (`high === low`) **cannot be filled at all**;
- buy-and-hold is measured from the strategy's own first tradeable bar, with the same costs;
- Sharpe comes from the equity curve, never from trade returns, and `exposurePct` is reported
  beside it.

Costs default to Indonesian retail: 0.15% to buy, 0.25% to sell (the extra 0.1% is the sale tax),
0.1% slippage, whole 100-share lots, 246 trading days a year. Long-only, because retail shorting is
not available on IDX.

**Read `warnings` before quoting anything.** Under ten trades it says so.

`walk_forward` adds an out-of-sample check at no extra request cost. Its verdict reaches
`inconclusive` before it can reach `robust` — and on ~500 real daily bars it usually will, because
three folds of two years yields single-digit trade counts. That is the honest answer.

## Patterns and timeframes (added 2026-08-09)

`patterns` detects 16 candlestick formations. The prior trend is part of the pattern rather than
decoration: a hammer and a hanging man are the same candle, and only what came before separates
them. `confidence` scores how closely the candle matches the textbook proportions — it is not a
probability and says nothing about what followed.

`timeframe_alignment` folds daily bars into weekly and monthly and reports whether they agree.
Stockbit serves daily bars only, so those are resampled, and there is **no** 4H/1H/15m OHLC — the
intraday feed is a minutely close-only series for the current session. About 500 sessions are
reachable, which is ~104 weekly and ~24 monthly bars, so a monthly RSI(14) is reported `null`
rather than computed from a window that has not converged. The `limits` field says so in the
payload.

## Screening (added 2026-08-09)

`scan` runs one condition across many symbols — `alert_check` for stocks you have no rules for.
Misses distinguish `condition-false` from `warming-up` from `no-data`, and truncation always
reports its reason so a capped sweep never reads as a complete one.

Throughput caps at roughly 6.6 upstream requests a second, so a 20-symbol moving-average screen
takes ~15s and anything using `sma200` takes ~50s. Bar pages are cached for six hours once settled,
so a second scan over an overlapping universe costs about one page per symbol.

`price_bands` reports the ARA/ARB auto-rejection band and the session's foreign flow, from fields
already inside the orderbook response — no extra request. A field absent from the payload is `null`
and named, never zero: zero is a real value for foreign net flow.


## Bandarmology

The thing no free data source gives you: who actually bought and sold.

### `broker_summary`
Which brokers net-bought or net-sold, in lots and IDR, with foreign/local/government classification.

> "broker summary for BBRI"
> "who accumulated GOTO between 2026-07-01 and 2026-07-31"

Omit the dates for the latest completed session. For a window, give **both** `from` and `to` — the
server aggregates true net across it in one request, so a multi-month range costs the same as one
day. A half-specified range is rejected rather than silently returning the latest session.

### `broker_distribution`
Who was on the *other side*. For each top buyer, which brokers sold to them and how much moved —
rendered as a Sankey diagram, always as SVG, never a table.

> "broker distribution for BRMS"
> "show me the broker flow on TPIA for last week"

Needs a Stockbit account with **≥ Rp 10,000,000** total balance; Stockbit gates it. `market_board`
defaults to `REGULER` (what the Stockbit UI shows) — `ALL` folds in negotiated blocks and changes
the numbers substantially.

---

## Chart analysis

### `technicals`
Indicator readings as **numbers**, for reasoning: SMA/EMA (20/50/200), RSI, MACD, Bollinger Bands,
ATR, and support/resistance from pivot clustering.

> "technicals for BBRI"
> "RSI and MACD on TLKM over the last 300 sessions"

Support/resistance are labelled by where price is **now** — a level below the last close is support,
above is resistance. An old pivot low that price has fallen through is overhead supply, not a floor.

### `price_chart`
The picture: daily candlesticks with volume, overlays (`sma20`, `sma50`, `sma200`, `ema20`,
`bollinger`), sub-panels (`rsi`, `macd`), and support/resistance drawn on. Always SVG, saved to
`~/.stockbit/charts/`.

> "chart BBRI with bollinger bands and a MACD panel"
> "draw a chart of GOTO for the last 6 months"

`annotations` lets the assistant draw its own levels, zones, trend lines and markers — that is how an
analysis shows its evidence instead of just asserting it. Drawing happens on the rendered image;
nothing is written to your Stockbit account.

It also **opens the real Stockbit chart in your browser** alongside, so you can compare. Set
`open_in_stockbit: false` to skip, or `browser: "Edge"` to choose where.

---

## Pine Script

### `pine_script`
Generates TradingView Pine v6 — indicators, alert conditions, or a backtestable strategy. Written to
`~/.stockbit/pine/` and returned inline.

> "give me Pine for BBRI with a golden cross alert"
> "make a Pine strategy on TLKM, buy the 20/50 cross, 3% stop, 6% target"

Two things make the output trustworthy:

- Indicators are emitted as the TradingView builtins whose **definitions match** what `technicals`
  computes (`ta.rsi`/`ta.atr` smooth with Wilder's, `ta.ema` is SMA-seeded, `ta.stdev` is a
  population SD). So the script plots the same numbers you were shown.
- Support/resistance are written in as **constants from Stockbit's bars**, not recomputed in Pine.
  Recomputing would use TradingView's data — a different source that would quietly disagree.

You get one script per pane: price, plus a separate one for each oscillator, because TradingView puts
a script in exactly one pane and an RSI on an overlay flattens the price axis.

`validation` is a **structural** check (brackets, pragma, duplicate assignments). It is not a
compiler — TradingView is the authority on whether a script compiles.

Set `include_levels: false` to skip the Stockbit lookup entirely; the tool then needs no live session.

---

## Alerts

Rules are stored on your machine, evaluated with the **same indicator maths** the Pine emitter uses —
so an alert and its `alertcondition` cannot disagree.

### `alert_create`
> "alert me when BBRI's RSI drops below 30"
> "tell me if TLKM's 20-day crosses above its 50-day"

Reference a declared series (`sma20`, `rsi14`, `macdLine`, `bbUpper`…), a price field (`close`,
`high`, `volume`, `hl2`…), or a number. Operators: `crossover`, `crossunder`, `cross`, `>`, `<`,
`>=`, `<=`. Declare what you reference via `overlays`/`panels` — a condition the tool cannot evaluate
is refused at creation rather than stored as a rule that silently never fires.

### `alert_list` / `alert_delete`
List rules with when each last fired; delete by id, or `disable_only: true` to keep but silence it.

### `alert_check`
Evaluate now and report what fired. `reason` distinguishes `condition-false` from `warming-up` —
the second means there is not yet enough history to judge, which is **not** the same as "no".

### The daemon — `stockbit-alerts`

Alerts only fire on their own if this is running. An MCP server exists only while a client holds it
open; a rule that triggers at 14:20 on a Tuesday needs a separate process.

```bash
node "C:\Users\<you>\stockbit-mcp\dist\bin\stockbit-alerts.js" watch
```

| command | what it does |
|---|---|
| `watch` | poll every 60s during IDX hours |
| `watch --interval 30` | …every 30s |
| `watch --always` | ignore market hours |
| `check` | one pass, then exit |
| `check --dry-run` | evaluate without firing or delivering |
| `test` | send a sample notification through every channel |

Flags: `--symbol BBRI`, `--no-desktop`, `--webhook <https url>`.

**Delivery.** An append-only log at `~/.stockbit/alerts.log` is written **first and always** — every
other channel can fail unnoticed (a toast on a locked screen, a webhook that 500s), and an alert that
fired and was never seen is worse than one that never fired. A native desktop notification is on by
default and needs no setup. A webhook is **off** unless you set `STOCKBIT_ALERT_WEBHOOK`; it is the
one channel that sends data off your machine, and it refuses plaintext to a remote host.

Alerts fire **once per bar**. Checking twice in an afternoon will not alert you twice for Tuesday's
close.

---

## Workflows

Several tools in one call, the same way every time. `workflow_list` shows them; `workflow_run` runs
one.

| workflow | inputs | what it does |
|---|---|---|
| `deep_dive` | `symbol`*, `bars` | quote → technicals → annotated chart → broker distribution |
| `morning_scan` | `count`, `bars` | top gainers → technicals for each leader |
| `bandar_watch` | `symbol`*, `from`, `to` | broker summary → broker distribution |
| `alert_sweep` | `symbol` | evaluate alerts → chart whatever fired |
| `pine_handoff` | `symbol`*, `bars` | read levels from Stockbit → Pine that plots those exact levels |

> "run a deep dive on BBRI"
> "do the morning scan"

A failing step **aborts** the run and the result names which step and why — unless that step is
marked optional (in `deep_dive`, broker distribution is, so a Rp10m-gated account still gets the
other three steps). A capped fan-out reports how many items it skipped, so a partial sweep never
reads as a complete one.

---

## Market data

| tool | what you get |
|---|---|
| `quote` | last price, change, best bid/offer |
| `orderbook` | full depth ladder |
| `intraday_prices` | minutely series for the current session |
| `price_performance` | 1D / 1W / 1M / … returns |
| `top_movers` | top gainers, losers, most active (empty when the market is closed) |
| `trending` | trending tickers |
| `sectors` | IDX sector list |

## Fundamentals

| tool | what you get |
|---|---|
| `keystats` | headline statistics |
| `ratios` | valuation and financial ratios |
| `financials` | statements |
| `sentiment_stream` | community posts about a symbol, as a sentiment proxy |

---

## Your chart on Stockbit

### `stockbit_web`
Checks whether Stockbit is already open in your browser and opens it if not.

> "open BBRI on Stockbit"

It opens **your own** browser, because that is the one holding your session — Chartbit renders a
blank white page when signed out, which looks like a broken feature. `STOCKBIT_WEB_BROWSER` is set to
`Microsoft Edge` in your config for that reason.

Detection is honest about its limits: on macOS every tab of every running browser is checked; on
Windows and Linux only each window's **active** tab is visible, so a Stockbit tab sitting in the
background reports as "not in front" rather than "closed".

### `chart_layout` / `chart_settings`
Read your own saved chart markup and configuration. `chart_settings` is account-wide (theme,
resolution, drawing-toolbar state); `chart_layout` is per-symbol.

These are **different stores** — TradingView persists a chart's properties separately from its
layout. An empty `chart_layout` does not mean you have configured nothing.

### `chart_layout_save` — the only write

Saves a chart layout to your Stockbit account. Requires `confirm: true` on every call, snapshots the
current layout to `~/.stockbit/layout-backups/` before touching anything, verifies by reading back,
restores automatically if it does not match, and appends to `~/.stockbit/layout-mutations.log`.

**It currently does nothing, and that is Stockbit's end.** Their server accepts the write with HTTP
200 and discards it; their own web app has no save code path at all. See
[chartbit-layout-format.md](chartbit-layout-format.md) for the full elimination. The tool reports
`verified: false` and says nothing was altered, rather than claiming a save that did not happen.

---

## Files it writes

| path | what |
|---|---|
| `~/.stockbit/refresh.enc` | your session token, AES-256-GCM |
| `~/.stockbit/charts/` | rendered `.svg` charts |
| `~/.stockbit/pine/` | generated `.pine` scripts |
| `~/.stockbit/alerts.json` | alert rules |
| `~/.stockbit/alerts.log` | every alert that fired, append-only |
| `~/.stockbit/layout-backups/` | pre-write chart-layout snapshots |
| `~/.stockbit/layout-mutations.log` | every write attempt, append-only |

## Environment

| variable | effect |
|---|---|
| `STOCKBIT_WEB_BROWSER` | which browser to open Stockbit in (set to `Microsoft Edge`) |
| `STOCKBIT_ALERT_WEBHOOK` | https endpoint for fired alerts; off unless set |
| `STOCKBIT_NO_BROWSER=1` | never open a browser |
| `STOCKBIT_DEBUG=1` | log response shapes on parse failures |

## When the session expires

The refresh token rotates on a sliding 7-day window. Use it at least weekly and login is one-time;
leave it idle longer and you will see `HTTP 401`. Fix:

```bash
node "C:\Users\<you>\stockbit-mcp\dist\bin\stockbit-auth.js" login
```

Run it in your own terminal. Google sign-in is broken on Stockbit's own site (deprecated `gapi.auth2`,
never migrated) — use username and password.

## What this cannot do

It cannot place, modify or cancel an order, and has no portfolio access. The transport enforces that
with a closed route table, not a convention: every request shape the project may make is enumerated
in `src/http/transport.ts`, and a test fails if that list changes. See
[ADR-0002](adr/0002-daemon-is-the-product-server-stays-read-only.md) and
[ADR-0003](adr/0003-chartbit-writes.md).
