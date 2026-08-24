# Verification status

What is known about this server's field mappings, how it became known, and how to settle what is
still a guess. Every tool carries one of three words; they are defined once in
[`CONTEXT.md`](../CONTEXT.md) and repeated here because this is the page people arrive at.

## The evidence ladder

| Word | Meaning |
|---|---|
| **Observed** | A real response from a live account was seen and the code was written against it. |
| **Read-back** | A write whose effect is verified by re-reading the account afterwards. The request body shape may still be a guess — but a wrong guess shows up as `not-visible`, never as a false success. |
| **Projected** | Field names taken from Stockbit's web bundle, never seen on a live response. `readFrom` names the wire key each value came from, and an absent field means "not recognised", not zero. |

Projected is not a warning that a tool is broken. It is a statement that nobody has checked it, and
that the code is built so an unchecked guess fails loudly rather than quietly.

## By family

| Family | Evidence | What was compared against what |
|---|---|---|
| bandarmology | **Observed** | NET vs GROSS, the four market boards and the six period windows confirmed on a live account 2026-08-09; broker distribution cross-checked against Stockbit's own screens. |
| market (core) | **Observed** | `quote`, `orderbook`, `price_bands`, `top_movers`, daily bars — all read from live responses; the ARA/ARB shape and the `topgainer` casing were both corrected against them. |
| market (internals) | **Projected** | `running_trade`, `trade_book`, `order_queue`, `prices_batch`, `market_prices`, `chart_series` — routes are real, field names come from the web bundle. |
| analysis | **Observed** | Local mathematics over observed bars. Indicators, patterns and backtests are computed here, not read; walk-forward usually returns `inconclusive` on ~500 daily bars, which is the honest answer. |
| company · fundamentals · insider · corpaction | **Mixed** | Per tool — see the evidence column in [`TOOLS.md`](TOOLS.md). |
| stream | **Mixed** | The per-symbol stream is **Observed**; the rest is **Projected**. |
| screener · watchlist (reads) | **Observed** | Confirmed 2026-08-09: the index returns `data` as an array, the detail wraps rows in `data.result`, and running a saved screen is a plain GET. |
| account (writes) | **Read-back** | Every watchlist and screener edit re-reads the account and reports what it found (ADR-0006). |
| chartbit | **Observed / Read-back** | Layout persistence confirmed 2026-08-24 on `/chartbit/charts`; the retired per-symbol routes accept a valid body and store nothing (ADR-0003 Amendment 2). |
| alerts · workflows | **Observed** | Live end-to-end run 2026-08-05: rules fired, notifications delivered, every workflow completed. |
| **trading (carina)** | **Projected — never observed live** | Nothing on `carina.stockbit.com` has been seen. Reading it needs a securities session, which needs the account owner's PIN at their own terminal. |
| **e-IPO (api-sekuritas)** | **Projected** | Same reason. |
| paper | **Observed by construction** | The ledger is local; there is no wire shape to guess. Fills are approximate and every result says so. |
| system | **Observed** | `status`, `login`, `logout` read local state only. |

## Checks that were run

Recorded when they were run; each is a specific comparison, not a claim that a feature "works".

| Check | Result | Evidence |
|---|---|---|
| Volume unit is LOTS, not shares | pass | BBRI value/volume = 303,668 against an average price of 3,037 — exactly price × 100. |
| Support/resistance labelled correctly | pass | BBRI, TLKM, GOTO: zero levels labelled support above the close or resistance below it. Was broken; fixed in `1c4e52c`. |
| Quote matches Stockbit | pass | BBRI 3020, −40 (−1.31%), best bid 3020 / offer 3030. |
| Bars reach back far enough | pass | 220 sessions (2025-09-03 to 2026-08-05) in 19 requests, not truncated. |
| The write boundary is enumerated, not assumed | pass | Every non-GET route is sorted into a named class citing the ADR that admitted it: session refresh, Chartbit persistence (ADR-0003), the four order routes plus the e-IPO pair (ADR-0004), and watchlist/screener edits (ADR-0006), with a fifth class for POSTs that read. `test/transport.test.ts` asserts nothing else mutates; `test/tools.test.ts` asserts on a real server exactly which tools can change anything and that none of them is reachable from a saved workflow recipe. |
| Broker distribution against live data | pass | BBRI 2026-08-05, REGULER board, IDR: 8 brokers charted, returned in 156 ms as part of the `deep_dive` workflow. |
| Workflows run end to end on live data | pass | `deep_dive` on BBRI: quote 388 ms, technicals 2542 ms, chart 630 ms, brokers 156 ms — no step failed. |
| Alert daemon fires and delivers on live data | pass | BBRI: `close > 2000` fired at 3020 and `rsi14 < 70` at 56.18; desktop notifications delivered, both logged; a second pass fired 0. |

Route-level probes settled on 2026-08-09 — `top_movers` casing, `broker_summary` transaction types
and market boards, the `period` catalogue, the ARA/ARB shape, the watchlist index/detail split, the
`/charts/{SYM}/daily` timeframe spelling and the screener GET — are recorded with their exact
evidence in [`PENDING-VERIFICATION.md`](PENDING-VERIFICATION.md). Refresh-token rotation was
observed on 2026-08-03; Chartbit persistence on 2026-08-24.

## How to settle a projection

It takes one live call per tool, and it is the same four steps every time.

1. Call the tool once against a live session.
2. Read `unmapped.sampleKeys` (market data) or `unmappedKeys` (account data) on the result. Those
   are the wire keys the code did not recognise.
3. Make one edit to the candidate key list in the relevant `src/` module, so the value is read from
   the real name.
4. Re-tag the tool's evidence from `projected` to `observed`, regenerate `docs/TOOLS.md`
   (`npm run docs:tools`), and record the comparison in the table above.

The trading and e-IPO families are the whole outstanding set, and
[`PENDING-VERIFICATION.md`](PENDING-VERIFICATION.md) lists them in the order of what goes wrong if
the guess is wrong. Order entry itself is a **live gate**, not a test run: the first real order is
placed by the account owner, with their own money, watching it.
