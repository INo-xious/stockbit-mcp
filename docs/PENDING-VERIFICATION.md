# Pending live verification

Everything here needs a working Stockbit session and could not be done offline. The stored refresh
token was already dead when this work started — `docs/CAPABILITY-RESEARCH.md` records 80 concurrent
agents outrunning the best-effort lock in `src/auth/reflock.ts` and burning it.

```bash
npm run dev:auth login     # opens your browser; log in normally
npm run dev:auth status    # now does a REAL refresh, not just a JWT expiry read
```

**Run the probes sequentially.** One refresh up front, then pass the access token down. Do not fan
out: that is exactly what killed the last token.

---

## 1. Confirm the two enum fixes

Both were changed on the strength of Stockbit's own bundle rather than a live response, and both
answer HTTP 200 whether they are right or wrong — which is why they went unnoticed for so long.

| Check | Expectation |
|---|---|
| `top_movers` during market hours (09:00–16:00 WIB, Mon–Fri) | Returns **rows**. An empty list outside those hours is still normal. |
| `broker_summary` with `transaction_type: GROSS` | Differs from `NET`. If identical, `GROSS` is not the right spelling. |
| `broker_summary` with `market_board: NEGO` / `TUNAI` / `ALL` | `ALL` should be materially larger than `REGULER` — it folds in negotiated blocks. On BRMS the distribution endpoint showed 8×. |

If any of these is wrong, the fix is one table: `MOVER_WIRE` in `src/http/transport.ts`, or
`TRANSACTION_TYPES` / `MARKET_BOARDS` in `src/core/marketdetectors.ts`.

## 2. Confirm the ARA/ARB field names

`price_bands` reports which fields it **found** and which were **missing**, so this is self-checking:

```
price_bands { "symbol": "BBRI" }
```

If `missing` lists everything, the wire spellings in `BAND_FIELDS` (`src/core/pricefeed.ts`) are
wrong — inspect a raw `orderbook` response and correct the map. The extractor tolerates absence by
design; it will not invent a value.

## 3. Routes designed but deliberately NOT wired

Both were verified in `STOCKBIT-API.md` at some point but not against a session this work could
reach, and a route in `ROUTES` that never returns anything is worse than an absent one.

### Watchlist — the biggest remaining gap

`GET /watchlist`, `GET /watchlist/{id}?limit=500`. Recorded traps: `limit` is required and capped at
500, `total_items` reports 0, `sort_by` is silently ignored, and **`volume` here is in shares where
`historical/summary` uses lots**.

The `scan` tool already declares `{ kind: "watchlist" }` in its universe type and throws a clear
error rather than returning an empty universe. Wiring it means: two rows in `ROUTES`, an accessor in
`src/core/`, the `resolveUniverse` branch in `src/tools/register.ts`, and updating the exact
permitted-set assertion in `test/transport.test.ts` — which exists precisely so a new authenticated
request shape gets its own review.

### Screener

`GET /screener/templates/{id}?type=TEMPLATE_TYPE_GURU`, plus `/screener/metric|preset|universe`.
Running a built-in preset is a pure GET. Operators are a closed set with implicit AND and no OR, and
`operator: "all"` projects a metric as an output column without filtering — which turns the screener
into a batch fundamentals fetcher. A watchlist is a first-class scope.

Read-only: no `POST /screener/templates`, no saved custom screens.

## 4. Reconcile a contradiction in the docs

`docs/CAPABILITY-RESEARCH.md` says `/marketdetectors` accepts **11** `period` values
(`_YESTERDAY`, `_LAST_7_DAYS`, `_YEAR_TO_DATE`, …). `STOCKBIT-API.md` §4a says a 16-candidate sweep
left **only** `_LATEST` and `_UNSPECIFIED`, and reads as settled. One of them is wrong, and the
catalogue is the document people trust.

## 5. Probe `/charts/{SYMBOL}/daily`

The highest-leverage unknown in the whole project. Bars currently cost 12 rows a page — about 19
requests for 220 sessions, and it is the constraint behind every cost number in `scan`,
`timeframe_alignment` and `backtest`. If this route returns a full series in one request it relaxes
that ceiling by roughly 40× and most of the scan budget machinery becomes unnecessary.

Recorded as "verified in the bundle, dropped in challenge, needs a probe".

---

## End-to-end checks once the session is live

```
workflow_run   { "name": "morning_scan" }          # must return readings, not abort
workflow_run   { "name": "strategy_check", "input": { "symbol": "BBRI" } }
backtest       { "symbol": "BBRI", "strategy": "sma_cross", "walk_forward": true }
scan           { "universe": "topGainer", "left": "close", "op": ">", "right": "sma20",
                 "overlays": ["sma20"] }
timeframe_alignment { "symbol": "BBRI" }
patterns       { "symbol": "BBRI", "since": 30 }
price_bands    { "symbol": "BBRI" }
```

What to look for:

- `backtest` — the first trade's `entryDate` is on or after `firstTradeableDate`, and `warnings`
  says something honest about the sample size.
- `scan` — completes inside the stated budget and reports `cost.pagesFetched`. Run it twice: the
  second should be far cheaper, because settled bar pages are cached for six hours.
- `timeframe_alignment` — `limits` contains the "no 4H/1H/15m OHLC" sentence and the monthly RSI is
  `null`.
