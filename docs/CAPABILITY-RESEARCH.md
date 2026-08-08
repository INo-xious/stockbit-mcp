# What else this server could do

Research run 2026-08-05. 80 agents across six lenses, each proposed endpoint probed live before
being reported. **38 capabilities confirmed working, 36 rejected.**

Read the confidence note at the bottom before treating a rejection as a dead end — a third of the
verifiers ran out of session budget mid-run, and the rule they operate under is "default to
`real=false` when you cannot demonstrate it working". Several rejections mean *unverified*, not
*false*.

---

## The five worth building first

### 1. Watchlist read — closes a loop the project has had open since day one
**Effort: small.** `GET /watchlist` → `GET /watchlist/{id}?limit=500`

`STOCKBIT-API.md` §9 defines the whole two-stage product as *"for each watchlist symbol: GET
/marketdetectors/{SYM}"* — and the server has never had a way to learn what those symbols are. The
alert daemon must be fed tickers by hand. This is one GET, no new parsing concepts, and it turns
every existing per-symbol tool into a batchable scan.

Live: 26 symbols on your account (symbols omitted). Each
row carries 31 fields including `uma`, `corp_action.active`, `tradeable`, and an intraday price
series — so a watchlist sweep answers screening questions without a second call per symbol.

> *"Which of my watchlist stocks had brokers accumulating yesterday?"*

**Traps found by probing:** `limit` is required and capped at 500 (`0` and `501` both 400).
`total_items` reports **0** while the detail call returns 26 rows — do not use it as a count.
`sort_by`/`sort_dir` are accepted and **silently ignored**. Row `volume` is in **shares** where
`historical/summary` reports **lots** — a 100× difference between two endpoints in the same codebase.
`prices[]` is not a daily sparkline; it is a variable-length intraday tick series.

### 2. The screener — changes what the server is *for*
**Effort: medium.** `GET /screener/metric`, `/screener/preset`, `/screener/universe`

**539 filterable metrics, including a 23-metric Bandarmology group.** Presets and the full IDX index
catalogue (including syariah) come back as plain GETs, and the account is **not** gated — checked
against `/paywall/eligibility/check` rather than assumed.

This is the difference between *"answer questions about a symbol I name"* and *"find me the symbols
worth naming"*. A bandarmology screener over 900 issuers is something no generic charting tool can
offer, because nobody else has broker-level flow as a filterable metric.

**Caveat:** running a *custom* screen requires a POST — a write, needing its own ADR. Reading the
vocabulary and running the built-in presets does not. Build the read half first.

### 3. Corporate action calendar — the blind spot in every current analysis
**Effort: medium.** `GET /corpaction?date=YYYY-MM-DD` (market-wide) · `GET /corpaction/{action}?symbol=X`

Twelve action types: dividend, rightissue, rups, bonus, stocksplit, reversesplit, tenderoffer,
warrant, ipo, and more. All return 200; BBRI's dividend history is 24 rows.

A bandarmology read that misses tomorrow's ex-date is not merely incomplete, it is **actively
misleading** — the price gap will look like distribution. The `?date=` form is a true market-wide
calendar over any date, forward or historical, which is a scan primitive the current 26 tools have no
equivalent of.

Two companions confirmed separately: `GET /corpaction/status?symbol=BBRI,GOTO,BRMS` batch-checks UMA
and IDX special notations for many symbols in **one** call, and `GET /corpaction/ipo?limit=N` returns
the IPO pipeline with offering terms and underwriters.

**Trap:** `from`/`to` are accepted with 200 and **silently ignored** — four disjoint windows returned
byte-identical results. Only `date` works.

### 4. ARA/ARB auto-rejection bands — already in a response we throw away
**Effort: small.** `GET /company-price-feed/v2/orderbook/companies/{SYMBOL}`

The auto-rejection ceiling and floor are **served, not computed** — `data.ara`, `data.arb`,
`data.next_ara`, `data.next_arb` are already in a route the project calls today and currently
discards.

This is a hard IDX-specific trading constraint with no US equivalent, and it changes what a
recommendation *means*: a target 8% above spot is not reachable in one session if ARA is 6%. The same
response also carries `data.fbuy`, `data.fsell`, `data.fnet` — per-symbol foreign flow, likewise
already fetched and discarded.

Nearly free. The request already happens.

### 5. Broker directory — makes every existing bandarmology output legible
**Effort: small.** `GET /findata-view/marketdetectors/brokers?page=1&limit=150`

`broker_summary` and `broker_distribution` currently emit bare two-letter codes. An agent reading
*"XL and XC are accumulating"* has no idea those are Stockbit Sekuritas and Ajaib. One call, cached
three hours by Stockbit's own client, and every existing broker output starts reading as
`CC (Mandiri Sekuritas)`.

It is also the lookup table any broker-code parameter validation should be built on.

---

## The bandarmology family — a whole dimension the server does not have

Everything today answers *"who traded this stock?"*. These answer the **inverse** and the **time
series**, which is where the real edge in broker data lives.

| capability | endpoint | effort |
|---|---|---|
| **Broker Activity** — which STOCKS did broker X trade | `/order-trade/broker/activity` | medium |
| **Broker Activity Historical** — per-day broker × stock series | `/order-trade/broker/activity/historical` | medium |
| **Broker Flow** — intraday cumulative net flow per broker, aligned to minutely OHLC | `/order-trade/running-trade/chart/{symbol}` | medium |
| **Top Broker** — market-wide broker league table | `/order-trade/broker/top` | small |
| **Broker-scoped bandar detector** — Stockbit's own Acc/Dist verdict for a broker's whole book | `/findata-view/marketdetectors/activity/{code}/detail` | medium |
| **Broker Activity Chart** — one broker's flow across its top symbols over time | `/order-trade/broker/activity-chart` | medium |

The two-hop workflow this unlocks: *ask for the biggest net seller today → feed that broker into
`/broker/activity` → get every stock they distributed*. That is a genuinely novel answer, and it maps
straight onto the existing `workflow_run` recipe format.

**Correction it also produced:** `/marketdetectors` accepts **11** period values, not the 2 recorded
in `STOCKBIT-API.md` — `_LATEST`, `_YESTERDAY`, `_LAST_7_DAYS`, `_THIS_MONTH`, `_LAST_1_MONTH`,
`_LAST_3_MONTHS`, `_LAST_6_MONTHS`, `_YEAR_TO_DATE`, `_LAST_1_YEAR`, `_PREVIOUS_MONTH`. The doc reads
as settled, so the next person would have trusted it. *"Who has been accumulating BBRI year to
date?"* is one call, not a computed date pair.

---

## Tick-level data

| capability | endpoint | effort |
|---|---|---|
| **Running Trade** — the per-trade tape | `/order-trade/running-trade` | medium |
| **Trade Book** — price-ladder buy/sell breakdown, incl. pre-open and post-close | `/order-trade/trade-book` | medium |
| **Market Mover** — richer movers with net foreign flow and pre-opening IEP/IEV | `/order-trade/market-mover` | medium |
| **Top Stock** — market-wide net buy/sell leaderboard by investor type | `/order-trade/top-stock` | small |

---

## Cheap additions

- **Seasonality** — `GET /company-price-feed/seasonality/{SYMBOL}?year=YYYY`. Ten years of
  month-by-month returns plus a precomputed win-probability per month, in **one** call. Deriving it
  from `historicalSummary` would take ~210 requests. *The documented path is stale* — the symbol is a
  path segment, and `year` is the END of a fixed 10-year lookback, not a lookback count.
- **Earnings recap** — `GET /earnings?page=1&order=desc&sort_column=1`. Consensus estimate vs actual
  EPS across all **912** IDX issuers, sortable. *"Who beat last quarter"* is one request rather than
  912. Nothing in the current tools touches consensus.
- **Market session clock** — `GET /company-price-feed/market-time/session`. Small but it fixes a real
  usability problem: an empty `top_movers` currently reads as broken rather than "the market is
  closed".
- **Index membership / special boards** — `GET /emitten/indexes/{INDEX}?limit=500` gives UMA,
  suspension, special-monitoring and syariah constituent lists.
- **`quote` is dropping data it already receives** — `emittenInfo` returns `indexes[]`, `catalogs[]`,
  `uma`, `notation[]`, `corp_action`, margin and day-trade eligibility. All discarded today.
- **`orderbook` never sends parameters it supports** — `with_full_price_tick`, `direction`.
- **Company profile + symbol search** — `/emitten/{symbol}/profile`, `/search?keyword=`. The latter is
  parity with the TradingView MCP's `symbol_search`.
- **Underwriter IPO track record** — `/order-trade/underwriters/ipo-performance`.

## A bug the research found in shipped code

`broker_summary` advertises two `market_board` values that are almost certainly invalid — it sends
`MARKET_BOARD_NEGOTIATED` and `MARKET_BOARD_CASH` where the API expects `MARKET_BOARD_NEGO` and
`MARKET_BOARD_TUNAI`. Worth verifying and fixing regardless of what else gets built.

---

## Ruled out, with reasons

Kept so nobody re-walks these.

- **Negotiated-market turnover split** — the Nego and Cash buckets are structurally present but not
  populated. The field exists; the data does not.
- **Pre-opening IEP/IEV** — endpoint and field are real, but nobody has observed them populated
  during an actual pre-opening session. Unverified rather than dead; recheck at 08:45 WIB.
- **Per-board price/turnover series** — route is real, capability not demonstrated, and the central
  detail in the proposal was wrong.
- **Portfolio** — reachable only with a second credential behind your trading PIN. Out of scope, and
  it would be a very different risk posture.
- **Watchlist writes** — a full mutation surface exists (create, rename, add, remove, reorder). Each
  needs its own ADR. Enumerated so it can be **excluded deliberately** rather than by oversight.
- **Spurious 401s under load** — an agent proposed this as an API rate-limit finding. Rejected: the
  observation was real but the diagnosis was wrong. It was the refresh-token rotation race, from
  80 agents refreshing concurrently — see below.

---

## Confidence

**Do not read every rejection as a dead end.** 25 of 80 agents failed — the `verify:screener-watchlist`,
`verify:tradingview-gap` and `verify:internal-leverage` verifiers hit the session limit mid-run. Their
findings were rejected under the standing rule *"default to `real=false` when you cannot demonstrate
it working"*, which is the right rule but means several rejections read as "unverified", not "false".

The screener is the clearest case: `/screener/metric`, `/screener/preset` and `/screener/universe`
are in the **confirmed** list, while "run any of 81 built-in screens" sits in the rejected list purely
because its verifier ran out of budget. The screener is real. Only the run-a-preset claim is
unproven.

**The research burned the session token.** 80 agents in separate processes refreshing concurrently
outran the cross-process lock added earlier the same day: its 10-second acquire timeout is
best-effort by design, so under that much contention the losers proceed anyway and clobber each
other. The lock is correct for the two-or-three-process case it was built for and does not survive
eighty. Any future fan-out over this API should refresh **once** up front and pass the access token
to the agents, rather than letting each mint its own.

Re-authenticate with `node dist\bin\stockbit-auth.js login`.

---
---

# Pass 2 — 2026-08-05, evidence from the public CDN and the source tree

Run with the session token dead, so **nothing here was live-probed**. Every claim is anchored to a
quoted line in Stockbit's public bundle or in this repo, and each was independently re-checked by a
challenger who fetched the evidence rather than trusting the quote. 35 agents, 30 proposals,
**27 held up**.

That constraint turned out to be a feature: it forced the lenses onto ground pass 1 skipped, and the
first thing they found was that some of what already ships does not work.

## Bugs in shipped code — fix these before building anything new

### `morning_scan` aborts on every single run
`src/workflows/builtin.ts:71` · **reproduced against the shipped `dist/`**

The step iterates `steps.movers.data.results`, and `getTopMovers` returns `data` as an array — there
is no `.results` to resolve, **in any market condition**. One of five shipped workflows is 100% dead,
it is the one a user reaches for daily, and `workflow_list` advertises it with no indication it
cannot run. Fix is `forEach: "steps.movers.data"`.

### `top_movers` may never have returned a row
`src/http/transport.ts:43-51`, `src/core/emitten.ts:114`

The tool sends camelCase path segments (`topGainer`) where Stockbit's own client sends lowercase
(`topgainer`) — verified byte-for-byte in chunk `46906-1f5f18e9cfe92c41.js`.

What makes this nasty is the cover story: the tool's own description says an empty result is normal
when the market is closed, so an always-empty hotlist is **indistinguishable from correct behaviour**
and nothing in the system can notice. It is also the input to `morning_scan`, so both halves of that
workflow are broken independently.

### `broker_summary` sends three enum values that do not exist
`src/core/marketdetectors.ts:13-14`, `:49-50`

- `transaction_type`: the tool advertises `BUY` and `SELL`. Neither is in the API's enum. The one
  real alternative to `NET` is `GROSS`, and the tool cannot reach it.
- `market_board`: sends `MARKET_BOARD_NEGOTIATED` / `MARKET_BOARD_CASH` where the API wants `NEGO` /
  `TUNAI`, and `ALL` is missing entirely.

The second one stings: **the correct vocabulary was measured, written down, and applied to
`broker_distribution` in this same codebase** — and `broker_summary` kept the guess. Given this API's
documented habit of answering 200 and ignoring what it does not understand, the likely outcome is not
a 400 but a silent fallback to the default.

### `getBars` with `to` and no `from` lies about completeness
`src/core/bars.ts:197`

The stop condition never consults `to`. Asking for `technicals(symbol:"BBRI", to:"2026-01-15")` pages
~17 upstream requests for the *most recent* 200 sessions, filters nearly all of them away, and
returns a short series — or, for a `to` more than ~200 sessions back, **zero bars with every
indicator null** — while reporting `truncated: false`.

### A 100× unit error pre-loaded for the next maintainer
`src/core/brokerdistribution.ts:62`, `:146`, `:265`

Three doc comments say VOLUME is in **shares**; the code, the tool, the tests and the doc's own
arithmetic proof all say **lots**. The runtime output is currently correct, so this is not a live
wrong number — it is a trap. A maintainer reading the interface comment and "correcting" the code to
match would ship exactly the 100× mistake this project has already shipped once.

### `sectors` discards the fields that make rotation possible
`src/core/emitten.ts::getSectors` drops `parent` and the performance field. Restoring them plus N
calls on the already-declared `pricePerformance` route gives a ranked sector-rotation table with no
new endpoint.

---

## The screener is fully decoded — and the read half needs no ADR

Pass 1 left this as "running a screen requires a POST". **Half right, and the useful half is a GET.**

**Run a built-in preset — pure GET, ships today:**
`GET /screener/templates/{id}?type=TEMPLATE_TYPE_GURU` (module `71914`, `getLoadPresetScreener`)

That is *"run Stockbit's Big Accumulation screen and tell me what showed up"* as a one-GET,
one-parser tool, ahead of and independent of any write decision.

**The query language, quoted from the bundle:** two rule types, operators `[">", "<", "<=", "=", ">="]`,
combined with **implicit AND — there is no OR**. Small enough to expose as a typed MCP schema with a
closed operator enum, which means the model *cannot* emit an invalid screen. The no-OR limit needs
encoding up front: "foreign accumulation OR bandar accumulation" is two screens and a union.

**A watchlist is a first-class screening scope** — `{"scope":"wl","scopeID":"5455717"}`. Combined with
pass 1's watchlist read, *"which of MY stocks is bandar accumulating"* becomes one call instead of 26.

**`operator:"all"` projects a metric as an output column without filtering on it.** This quietly turns
the screener into a **batch fundamentals fetcher** — scope to the watchlist, one trivially-true rule,
eight `operator:"all"` columns, and you get market cap, PER, foreign flow and bandar value for every
holding in *one* request. The server has no equivalent of that today.

**Running a custom screen** is `POST /screener/templates` with `save:"0"` — Stockbit's own UI
distinguishes run from save with that one field, and the reducer only adopts a new `screenerid` when
`save === "1"`. So a run need not create anything on the account. It is still a fourth non-GET route
and still needs its own ADR; the point is that the *account-mutating* reading of pass 1 was wrong.

---

## New data classes the server has no coverage of

| capability | endpoint | effort |
|---|---|---|
| **Analyst ratings + consensus** — target prices, buy/hold/sell | `/analyst-ratings/{symbol}` · `/{symbol}/consensus` | small |
| **Sector constituents** — the cross-sectional primitive | `/emitten/v3/sector/{id}/company` | small |
| **Comparison service** — peer ratios *and an industry benchmark* | `/comparison/{SYMBOL}/ratios` · `/industries` | medium |
| **Order queue** — individual open orders and queue positions | `/order-trade/order-queue` | medium |
| **Ownership suite** — incl. a traversable ownership *graph* | `/insider/shareholding/{investors,companies,network,composition}` | large |

Two are worth spelling out.

**Analyst ratings** is a whole data class at zero risk: two GETs, symbol-only, no enums to get wrong.
The 26 tools cover price, fundamentals, broker flow and sentiment — and nothing about what analysts
actually forecast.

**Sector constituents** is the answer to "the server is single-symbol". Every existing tool takes a
symbol you already decided to ask about; this hands back a *population*. ~22 sector ids, one request
each, and breadth, rotation, leadership and relative strength all reduce to arithmetic over data you
now have.

**Comparison** matters because `ratios` answers *"what is BBRI's PBV"* and nobody can currently ask
*"and is that cheap for a bank"*. `/industries` is Stockbit's own industry aggregate — the
denominator — so relative valuation stops being a client-side computation over N peer fetches.

---

## Build from what is already here

### The honest half of "backtesting" — *medium*
`src/alerts/rules.ts:138` is `const i = bars.length - 1;`. The engine computes every indicator across
**all** bars and then throws away every index but the last.

So *"how often has my RSI-oversold rule fired in the last year, and what did price do in the 10
sessions after each fire?"* is **~15 lines of loop plus a forward-return table** — not a backtester.
The compute cost is already being paid. This is the highest value-per-line item in the report.

### Event detectors that draw themselves — *small*
Gap = `bars[i].low > bars[i-1].high`. Inside bar = two comparisons. Volume spike needs no new maths
because `sma()` takes a bare `number[]`. Each returns a set of **dates**, and dates are exactly what
the chart's marker annotation already consumes — `indicators.ts:215 levels()` is the same
`(bars, opts) => detections` shape already wired to annotations, so this is a *second instance of a
proven pattern*, not a new mechanism.

Two gotchas the challenger caught: the marker guard requires a truthy `label`, so labelless events
are **silently dropped**; and there is no collision avoidance, so a chatty detector needs a cap the
way `levels` already caps to 5.

### Relative strength as a sub-panel — *small*
The precise thing `renderCandles` lacks is a second y-axis and a date-keyed x-mapping — and it needs
**neither** if the comparison is drawn as a ratio in a sub-panel. That reduces "relative strength vs
IHSG" to a date-join and a rebase.

### Universe scan with the existing rule grammar — *medium*
*"Of today's top gainers, which have SMA20 crossing above SMA50?"* — a grammar already built,
already validated, and already agreeing with the Pine output.

### CSV/JSON export — *small*
Bars are expensive (12 rows per upstream page) and there is currently **no way to get them out of the
process at all**. Every tool returns a derived reading or a picture.

### An invariant this project claims and does not hold — *medium*
`src/alerts/rules.ts:5-10` states that a rule "can be emitted as a Pine `alertcondition` and
evaluated server-side, and both must agree". But the alert grammar cannot reference support or
resistance while the Pine grammar can — `close crossover res1` is a valid Pine signal and an
**impossible alert**. The levels are the one thing this server computes that TradingView cannot.

---

## Reference artifacts

**143 protobuf enums extracted verbatim** from Stockbit's generated schemas — authoritative rather
than inferred. This is the durable win of the pass: the project has guessed enum values wrong at
least three times (documented above), and this ends that class of bug. Several unlock capability
directly, e.g. `MOVER_TYPE_BIG_MONEY_NET_VALUE`.

**The remote inventory was wrong: 15 Module Federation remotes, not 9.** Pass 1 mined 9 and about 20%
of the site chunks, so its "we have swept the CDN" conclusion was unsound — every new endpoint above
came from the remainder.

## Dropped in challenge

- **The 23 Bandarmology metric names** — the challenger could not reproduce the quoted list against a
  freshly fetched bundle. The *group* is confirmed to exist; the specific metric names are not.
- **Three conflicting BoardType numberings** — bundle half impeccable, project half did not hold.
- **`/charts/{SYMBOL}/daily`** — a whole price series in one request. Bundle text verified, but this
  is the same shape as the single-request bars idea that already failed live once; needs a probe
  before anyone trusts it.
