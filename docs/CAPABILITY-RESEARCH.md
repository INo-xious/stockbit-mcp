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
