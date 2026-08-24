---
name: morning-scan
description: The pre-open and first-hour routine for IDX — session state, movers, a scan over a universe, and a catalyst check on the leaders. Use when the user asks what is moving today, for a morning briefing, or what to watch.
---

# Morning scan

## The sequence

`workflow_run name=morning_scan` does this end to end. The parts, if you want to steer:

1. **`market_session`** — first, always. It returns the IDX clock in WIB. Mondays to Thursdays the
   session runs 09:00–12:00 and 13:30–15:50; Fridays 09:00–11:30 and 14:00–15:50. **It does not
   model exchange holidays**, so "open" on a holiday is the clock's answer, not the exchange's. If
   the market is closed, say which session the numbers are from.
2. **`top_movers type=…`** — gainers, losers, most active. Cheap, and it frames everything after.
3. **`scan`** over the universe that matters to the user — `watchlist_id`, an explicit `symbols`
   list, or a `universe`. Give it a condition (`left`, `op`, `right`). Mind `max_symbols` and
   `max_seconds`: the whole server is capped at roughly 6.6 upstream requests a second on purpose,
   so a 200-symbol scan takes real time. Say what it will cost before starting a big one.
4. **`technicals symbol=…`** on the handful that survived the scan.
5. **`news symbol=…`** on those — a mover with a catalyst and a mover without one are different
   stories.

## Reading it

- **Separate the mover from the setup.** A stock up 8% on no trend and no volume is a different
  thing from one breaking a level it has tested four times. Say which one you are looking at.
- **Check for ARA/ARB.** A limit-locked stock cannot be scanned meaningfully — the printed range is
  the band, not the market. `price_bands` gives today's limits.
- **Pre-open is not a price.** Before 09:00 the numbers are indications.

## Presenting it

Short. A handful of names, each with one line on why it is on the list and one on what to watch for.
Then the session state and the time. If nothing passed the scan, say that — an empty scan is a
result, and padding it with the least-bad name is how a briefing becomes noise.
