# Pending live verification

**Most of this is now done.** Probed against a live account on 2026-08-09; results are recorded in
`STOCKBIT-API.md` §11 and in the code that consumes them.

## Settled

| | Result |
|---|---|
| `top_movers` casing | **Confirmed.** Same moment, same request: `topgainer` returned 6661 bytes of rows, `topGainer` returned `"data":[]` in 57 bytes. Both HTTP 200 — which is why it hid for so long. |
| `broker_summary` transaction types | **Confirmed.** `NET` and `GROSS` both work and genuinely differ (BBRI top buyer ZP: 801,071 lots net, 938,193 gross). `BUY` / `SELL` 400. |
| `broker_summary` market boards | **Confirmed.** `REGULER`, `ALL`, `NEGO`, `TUNAI` all work. `NEGOTIATED` / `CASH` 400. |
| `period` contradiction | **Resolved, and the catalogue was the wrong one.** Six preset windows work, including `YEAR_TO_DATE` — which aggregates Jan→Aug in a single request. Now exposed on the tool. |
| ARA/ARB field names | **Confirmed, and the shape was not what was assumed.** The bands arrive as `{"value":"3,910"}` while the foreign figures beside them are bare numbers. `price_bands` now reports `missing: []` on a live call. |
| Watchlist | **Confirmed and wired.** 5 lists, 116 symbols in the default one. The index returns `data` as an array; the detail wraps rows in `data.result` — they are not interchangeable. |
| Screener | **Confirmed and wired.** Running a saved screen is a plain GET, not the POST an earlier pass assumed. Five custom screens on the probed account. |

## Still open

### `/charts/{SYMBOL}` — the one worth chasing

Real: `GET /charts/BBRI` returns 400 with `errors: [{ key: "Timeframe" }]`, and a 400 naming a
parameter means the route exists. But every timeframe spelling tried was rejected — `timeframe`,
`tf`, `interval`, `resolution`, each with `daily`, `1D`, `D`, `DAILY`, `TIMEFRAME_DAILY`.

Left unwired rather than guessed at further, the same way `/chartbit/{symbol}/price/daily` was.

**Why it matters more than anything else on this list:** bars cost 12 rows a page today, which is
the constraint behind every cost number in `scan`, `backtest` and `timeframe_alignment`. A route
returning a whole series in one request would relax it by roughly 40x.

**How to settle it:** open a Stockbit chart in a browser with DevTools recording, and read the exact
call off the Network panel. That is one observation and it ends the guessing — which is precisely
how the Chartbit layout format was recovered.

### Unmapped orderbook fields

`iepiev` (pre-opening indicative price/volume), `has_foreign_bs`, `total_bid_offer`, `market_data`,
`autoreject_*`. `iepiev` in particular is worth a look during the pre-opening auction (08:45 WIB) —
a previous pass listed it as "unobserved" rather than absent.
