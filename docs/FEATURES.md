# User guide

Tools over Stockbit's private APIs, plus a standalone alert daemon. The complete, generated list —
every tool, its evidence and its arguments — is [`TOOLS.md`](TOOLS.md); this page is the tour.

Most of them read. Twenty-five write: the four order tools, the e-IPO subscription, the eight
Chartbit drawing and layout tools, the nine watchlist and screener edits, `login`/`logout`, and
`trading_forget` — which is a write only because it changes state, and can only ever make the server
ask you *more* questions. They are confirmation-gated; order entry defaults to per-action
confirmation, and where your client supports MCP elicitation **you are asked directly and your
answer decides it**, with a deliberately enabled, value-capped live autoconfirm exception. Trading is
**off** until you turn it on yourself at a terminal. If you never do, nothing here can reach your
money.

You do not call these yourself — you ask the assistant in plain language and it picks the tool. The
argument names below matter when you want to be specific ("broker summary for BBRI from 2026-07-01
to 2026-07-31").

**Conventions used everywhere:** symbols are IDX tickers (`BBRI`, `TLKM`, `GOTO`; `IHSG` is the
composite index). Money is IDR. **Volume is LOTS** — 1 lot = 100 shares. Dates are `YYYY-MM-DD`.
Empty results on a weekend or public holiday are normal, not errors.

---


## One verdict from all of it (added 2026-08-10)

### `analyze`
Weighs several readings of one stock into a single lean, with a confidence score and the evidence
behind both.

> "analyze BBRI"
> "analyze GOTO using year-to-date broker flow"

Every other tool here answers one question from one source, and `deep_dive` fetches five of them
without weighing any — the workflow engine deliberately cannot compute. This is the tool that
actually combines them.

**Four weighted pillars:**

| pillar | weight | what it reads |
|---|---|---|
| Broker flow & positioning | 0.35 | foreign net flow as a share of traded value, plus whether accumulation is concentrated while distribution is diffuse |
| Trend & timeframe alignment | 0.30 | the daily / weekly / monthly votes from `timeframe_alignment`, normalised |
| Valuation | 0.20 | PER, PBV, ROE, DER against absolute bands |
| Candlestick patterns | 0.15 | recent detections from `patterns`, weighted by shape fidelity and recency |

Broker flow leads because it is the one signal no other data source has, and because it reports
positioning rather than restating price.

**Confidence is not a probability.** It measures how complete and internally consistent the evidence
is — how much of it was readable (30), whether the pillars agree (30), how far the composite sits
from neutral (20), and how fresh the price data is (10). It therefore **stops at 90**, because
nothing in this data source could justify claiming more about a future price. Read it as "how much
this reading is worth", never as "how likely the price is to go up".

**A pillar that cannot be read is `missing`** — it contributes nothing, its weight is redistributed
across the pillars that were read, and it costs confidence. It never lands as a neutral vote,
because *"we could not see it"* and *"we looked and it was balanced"* are different answers and
averaging them turns the first into the second.

**When nothing at all could be read, this errors rather than answering.** A dead session token makes
every source fail, and a `lean: "neutral"` with a confidence of 15 would look like an analysis while
actually being a login prompt — the same shape as the `top_movers` bug that hid for months. You get
the real cause instead, which for an expired token is "run `stockbit-auth login`".

**What it cannot do**, stated in every response's `limits`:

- **No analyst consensus or price targets.** That data class is not in the route table, so nothing
  here reflects what analysts forecast.
- **Valuation is absolute, not peer-relative.** `ratios` can say what BBRI's PBV is; nothing here can
  ask "and is that cheap *for a bank*". Treat this pillar as weak for banks, property and cyclicals.
  The one reference it does report is the **IHSG median PE**, which ships in the same payload — so
  you get "PE 8.0 against a market median of 7.99". That is context only, never part of the score:
  the index is not a sector, and letting it move the number would change what the bands mean.
- **Community sentiment is counted, never scored.** Turning Indonesian-language retail posts into a
  directional number needs a classifier this server does not have, and a keyword tally would be
  noise wearing a label.

**Floor-locked stocks** get a downgraded flow pillar that says so: when the last close sits on the
auto-rejection floor, every broker on both sides fills at one price and accumulation-versus-
distribution carries no information. Read that as unreliable, not as bearish.

Cost is about 27 upstream requests at the default 260 bars — 22 bar pages plus five single-shot reads, issued **sequentially** — a fan-out of
concurrent first-calls is what invalidated the stored session token on 2026-08-05. Use `technicals`
or `timeframe_alignment` if you only want the numbers.

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
intraday feed is a minutely close-only series for the current session. The paged bar path caps at
about 500 sessions (~2 years), which is ~104 weekly and ~24 monthly bars, so a monthly RSI(14) is
reported `null` rather than computed from a window that has not converged. The `limits` field says
so in the payload. `chart_series` reaches further — `timeframe=5y` in a single request — but its
field mapping is **Projected**, so check `unmapped` before trusting a candle from it.

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
npx -y -p stockbit-mcp stockbit-alerts watch
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
| `strategy_check` | `symbol`*, `bars` | technicals → every built-in strategy over the same history → Pine for the winner |
| `screen_and_dive` | `max_symbols` | sweep today's movers for a condition → technicals and patterns for each hit |
| `portfolio_review` | — | what the account actually holds → bandarmology and a weighted reading per holding |

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
blank white page when signed out, which looks like a broken feature. Pin the browser that holds the
session with `STOCKBIT_WEB_BROWSER`, e.g. `STOCKBIT_WEB_BROWSER="Microsoft Edge"`.

Detection is honest about its limits: on macOS every tab of every running browser is checked; on
Windows and Linux only each window's **active** tab is visible, so a Stockbit tab sitting in the
background reports as "not in front" rather than "closed".

### Drawing on it — `chartbit_draw`, `chartbit_analyze`, `chartbit_study`

> "draw the support and resistance on BBRI's chart"
> "mark the trend line GOTO has been respecting"

These draw on the **real** Stockbit chart, by driving the browser you logged in with, in a window
you can see. Stockbit's own auto-save persists what appears. `chartbit_analyze` fits the geometry
from price and draws it in one step; `chartbit_draw` takes annotations you name.

Every line carries its evidence in the label — how many times a level was tested and when it was
last tested, or a trend line's fit — because a bare line invites more confidence than the data
supports.

`chartbit_clear` removes drawings and is confirm-gated: it can destroy work you did by hand that
this server never saw. Drawing is not gated, because a line is additive, visible, and one click to
delete. See [chartbit-drawing.md](chartbit-drawing.md).

### `chart_settings`
Reads your account-wide chart configuration — theme, resolution, drawing-toolbar state. Separate
from a chart's layout: TradingView persists the two independently, so an empty layout does not mean
you have configured nothing.

### The saved layouts — `chartbit_layouts`, `chartbit_layout`, `chartbit_layout_save`, `chartbit_layout_delete`

The REST side of the same thing: list your saved chart layouts, read one, round-trip one, delete
one. The writes are confirm-gated, snapshot before touching anything, and verify by reading back.

An earlier version of this project targeted `/chartbit/{symbol}/layout` and concluded that saving
was a server-side no-op. That was true of **those two routes**, which really are stubs, and wrong
about Chartbit — the chart page's own save adapter writes to `/chartbit/charts` and
`/chartbit/chart-drawings`. [research/chartbit-layout-format.md](research/chartbit-layout-format.md) keeps the
original investigation with a correction on top.

---

## Files it writes

All of it lives in one directory — `~/.stockbit` by default, or wherever
`STOCKBIT_STORE_DIR` points. Nothing is written outside it.

| path | what |
|---|---|
| `~/.stockbit/refresh.enc` | your session token, AES-256-GCM. On macOS the token is in the Keychain instead and this file does not exist |
| `~/.stockbit/access.enc` | the 24-hour access tokens, shared between processes so they do not each spend a rotation. AES-256-GCM, `0600`. `STOCKBIT_NO_ACCESS_CACHE=1` turns it off — see [SECURITY.md](../SECURITY.md) |
| `~/.stockbit/websession.enc` | the browser's own Stockbit session (cookies + Local Storage), which is what the chart tools run on. AES-256-GCM |
| `~/.stockbit/session-health.json` | what happened the last time each credential was used. **Plaintext, and holds no tokens** — only an outcome, a time, and an 8-character digest. Safe to read, and safe to paste |
| `~/.stockbit/charts/` | rendered `.svg` charts |
| `~/.stockbit/pine/` | generated `.pine` scripts |
| `~/.stockbit/alerts.json` | alert rules |
| `~/.stockbit/alerts.log` | every alert that fired, append-only |
| `~/.stockbit/layout-backups/` | pre-write chart-layout snapshots |
| `~/.stockbit/layout-mutations.log` | every chart write attempt, append-only |
| `~/.stockbit/settings.json` | the trading switches. Written by `stockbit-auth`, never by the server |
| `~/.stockbit/order-mutations.log` | every order and IPO subscription attempt, append-only |
| `~/.stockbit/account-mutations.log` | every watchlist and screener edit, append-only |
| `~/.stockbit/browser-profile.json` | which browser binary your session was created in |

## Environment

| variable | effect |
|---|---|
| `STOCKBIT_STORE_DIR` | where everything on disk lives (credentials, settings, alerts, logs, charts, Pine). Default `~/.stockbit` |
| `STOCKBIT_TRADING` | `off` (or `0`/`false`/`no`) forces trading off, whatever the settings file says. It can only lower the trading mode — no value of it turns trading on |
| `STOCKBIT_BROWSER` | absolute path to the Chromium binary used for the one-time login capture |
| `STOCKBIT_WEB_BROWSER` | which browser to open Stockbit in, e.g. `"Microsoft Edge"` — pin the one holding your session |
| `STOCKBIT_NO_BROWSER=1` | never open a browser window; login refuses and names the terminal command instead |
| `STOCKBIT_LOGIN_TIMEOUT_MS` | how long the login capture waits for you to sign in (default 15 minutes) |
| `STOCKBIT_ACCESS_TOKEN` | use this bearer token instead of the stored session. Memory only — it is never written to the access cache, because it belongs to whoever set it in *this* process |
| `STOCKBIT_NO_ACCESS_CACHE=1` | do not share the 24-hour access token between processes via `~/.stockbit/access.enc`. Costs one refresh per process, and each refresh rotates the refresh token — see SECURITY.md |
| `STOCKBIT_FORCE_FILE_STORE=1` | skip the macOS Keychain and use the encrypted file store (what the tests run under) |
| `STOCKBIT_ALERT_WEBHOOK` | https endpoint for fired alerts; off unless set |
| `STOCKBIT_TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather. Environment only — a token on the command line is visible to every user on the machine through `ps` |
| `STOCKBIT_TELEGRAM_CHAT_ID` | Numeric chat id (a group's is negative). Message your bot once, then read it from `https://api.telegram.org/bot<token>/getUpdates` |
| `STOCKBIT_DEBUG=1` | log response shapes on parse failures |

## When the session expires

The refresh token rotates on a sliding 7-day window. Use it at least weekly and login is one-time;
leave it idle longer and you will see `HTTP 401`. Fix:

```bash
npx -y -p stockbit-mcp stockbit-auth login
```

Run it in your own terminal. Google sign-in is broken on Stockbit's own site (deprecated `gapi.auth2`,
never migrated) — use username and password.

## Your portfolio and trading

Reading the account needs a trading session, which needs your 6-digit PIN typed at your own
terminal (`stockbit-auth trading-login`). The PIN is used for one request and never stored, and **no
tool here accepts one** — if anything asks you for it through the assistant, that is not this server.

`portfolio`, `position`, `cash_balance`, `orders`, `order_history`, `trade_performance`,
`trading_info`, `stock_tradable` and `account` read it. Identifiers are masked before they leave:
your name becomes initials, account and RDN numbers become their last four characters.

Placing an order is off by default and always two steps — `order_preview` builds a ticket you read
and agree to, then `order_buy` takes that ticket id and nothing else. Read
[trading.md](trading.md) before turning it on; it explains the outcome classes, which matter more
than the happy path.

## What this cannot do

- **It cannot turn trading on.** That is `stockbit-auth trading-enable`, run by you.
  `STOCKBIT_TRADING` only moves a session **down** the ladder — never up — and no module the
  assistant can reach may write the settings file.
- **It cannot place an order outside the policy you chose.** The write tools take a ticket id, an
  optional confirmation, and no price or quantity. The default requires per-order agreement; capped
  live autoconfirm is an operator-enabled exception that a model cannot switch on or widen.
- **It cannot talk its way past you.** Where your client supports MCP elicitation, the server asks
  you directly *before* it looks at the assistant's `confirm` flag, and your answer is the decisive
  one — declining refuses the order however the assistant set that flag. Where your client cannot
  ask, the result and the audit line both say plainly that no human was asked, and
  `stockbit-auth trading-enable --elicitation required` makes that case refuse instead.
- **A saved workflow recipe cannot reach anything that writes.** Recipes are data — a name and a
  list of steps — and `define.write` deliberately never registers a tool in the map the workflow
  engine looks names up in.
- **It cannot reach a route that is not in the table.** Every request shape the project may make is
  enumerated in `src/http/transport.ts`; a caller names a route, never a path. Day-trade orders,
  smart orders, bulk cancels, withdrawals, deposits and stream posting are all deliberately absent.

See [ADR-0002](adr/0002-daemon-is-the-product-server-stays-read-only.md),
[ADR-0003](adr/0003-chartbit-writes.md), [ADR-0004](adr/0004-order-entry.md),
[ADR-0005](adr/0005-browser-driven-chartbit.md) and [ADR-0006](adr/0006-account-writes.md).
