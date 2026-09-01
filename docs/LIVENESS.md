# How fresh is each reading?

**No tool in this server answers "what just traded."** That is the conclusion, and it is written
here once so it does not have to be half-stated in three tool descriptions that disagree with each
other.

This question kept being re-asked because the obvious answer looks right and is wrong: there is a
running-trade tape, it returns prints with times and sizes, and reading it feels like reading a
tape. It is not live. What follows is what was measured, what it rules out, and what to use instead.

---

## The table

| Source | Freshness | Measured |
|---|---|---|
| `/order-trade/top-stock` (`top_stocks`) | **Live** — moves continuously | 2026-08, 25 s window |
| Order book (`orderbook`, `order_queue`) | **Live** | 2026-08 |
| A symbol's cumulative volume | **Live** | 2026-08 |
| `/order-trade/running-trade` (`running_trade`) | **8–10 minutes behind**, in bursts | 2026-08 |
| `/order-trade/running-trade/chart` (`broker_flow_intraday`) | **Previous session until ~18:00 WIB** | 2026-09-01 |

---

## Why the tape cannot answer it

`running_trade` fails on two independent counts, and either alone would be disqualifying.

**It is late.** Measured against the live API during an open session it runs about eight to ten
minutes behind and refreshes in bursts — its head sat unchanged for over three minutes while the lag
grew second for second. `cache-control: max-age=1` with `x-cache: Miss from cloudfront` places the
staleness at Stockbit's own origin, not in a CDN. The project's API notes agree from the other
direction: live data flows over WebSocket, and REST is the snapshot.

**It cannot reach the end of the day at all.** Measured 2026-08-28: the window always starts at the
SESSION OPEN, at most 100 rows come back however large `limit` is, and `offset`/`page` are accepted
and move nothing. `order_by` is not a time ordering — `1` is chronological from the open, `2` and
`3` are lot-ascending and returned nothing but 1-lot trades. So on a busy ticker the tool can only
ever show the first hundred prints of the day, and **the last trade before the close is not
reachable at any argument**.

## Why the minute chart cannot either

`broker_flow_intraday` covers 09:00 to 16:14 at one-minute resolution, which makes it the
highest-resolution view of a session this server has — and `running_trade`'s description sends you
here for exactly that reason.

That referral is right about resolution and wrong about recency. Broker-derived data across this API
publishes at roughly **18:00 WIB**, and before that release this endpoint serves the *previous*
session. It says so honestly in its own `from`, `to` and `date_session_info` — which is why those
fields must be read rather than assumed — but it means that during the session you are asking about,
this tool is describing yesterday. Correct and unpublished is not the same as stale, and neither is
the same as live.

> Its `data_last_updated` is stamped with a `Z` suffix but the value is WIB. A reading of
> `2026-09-01T16:28:44Z` was taken when UTC was 11:28 — five hours in the future.

## What is actually live, and what it can honestly tell you

`/order-trade/top-stock` moves continuously: over 25 seconds DSSA moved +1,394,039,000 in value
across +91 transactions, BBCA +55,665,000 across +19. One request covers the hundred most-active
symbols, which is also the only place a large transaction can occur — a stock with no turnover
cannot print one.

`src/live/tape.ts` is built on it, and on one idea: `frequency` is a count of transactions, so
between two snapshots

```
Δvalue / Δfrequency  =  the average rupiah size of the trades that printed in that window
```

**That is an average, and it is not a trade.** With a Δfrequency of 40 it cannot tell one 4-billion
print from forty 100-million ones. The `confidence` field on every delta says which case you are in
— `single` (exactly one transaction printed, so the average *is* that trade, and only here is "a
transaction of X just went through" literally true), `few` (2–5), or `averaged` (more than five).

**One thing is still unmeasured.** These aggregates were observed changing in under two minutes, but
their *absolute* lag against the exchange was never established. So "live" here means "moving
continuously", not "at the exchange's own clock", and `src/live/interval.ts` sets the floor at 20
seconds rather than pretending the loop can spin faster than the data.

---

## So what do I use?

| The question | The answer |
|---|---|
| What just traded? | **Nothing here answers this.** The closest is a `single`-confidence delta from the live watcher. |
| Something big just went through — what? | The live watcher (`src/live/`), reading `top-stock` deltas, with its `confidence` reported. |
| What is resting on the book right now? | `order_queue` — the most perishable reading here, cached 3 seconds. |
| Who traded this stock today, and how much? | `broker_summary`, or `broker_activity` for one broker across stocks. |
| How did flow move through the session? | `broker_flow_intraday`, **after ~18:00 WIB** for the current day. |
| What were the first hundred prints of the day? | `running_trade`. That is genuinely all it offers. |

An empty answer from any of these may simply mean the market is shut. `market_session` asks Stockbit
rather than guessing from a weekly schedule, and is the thing to check before concluding a tool is
broken.
