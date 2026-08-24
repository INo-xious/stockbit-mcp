---
name: stock-deep-dive
description: Work through one IDX symbol properly — trend, patterns, timeframe alignment, fundamentals and broker flow — and present a lean with its evidence. Use when the user asks what you think of a stock, or to look at, research or analyse one.
---

# Stock deep dive

One symbol, every angle the server has, presented so the user can disagree with a specific part
rather than with the whole thing.

## The sequence

The fast path is **`workflow_run name=deep_dive input={"symbol":"BBRI"}`**, which runs the whole
thing in one call and returns the pillars already assembled.

To drive it yourself, or to go deeper on one part:

1. **`analyze symbol=…`** — the engine. Indicators, trend, support and resistance, broker flow and
   a lean, in one result. It costs about 27 upstream requests at the default 260 bars, issued
   sequentially, so call it once and work from the result.
2. **`patterns symbol=…`** — 16 candlestick patterns with the context that makes them mean
   anything. A hammer in a downtrend is a signal; a hammer in chop is a candle.
3. **`timeframe_alignment symbol=…`** — daily against weekly against monthly. A setup that only
   exists on one timeframe is worth saying out loud.
4. **Fundamentals** — `keystats`, `ratios`, `financials`, `ownership_composition` and
   `shareholders` for the balance-sheet half.
5. **`news symbol=…`** — a catalyst, or its absence.

## Presenting it

- **Lead with the lean and its confidence**, then the pillars that produced it. `analyze` returns
  these; use its words rather than inventing your own.
- **Name the missing pillars.** If fundamentals came back empty, say "fundamentals unavailable",
  not nothing. A silent gap reads as a checked box.
- **Say what is Projected.** Anything from the trading or e-IPO families has field names taken from
  Stockbit's web bundle and never seen on a live response. `readFrom` on the result names the wire
  key each value came from, and an absent field means "not recognised", not zero. Never fill a gap
  with a plausible number.
- **Confidence is not a probability.** "Three of four pillars agree" is a claim. "68% likely to go
  up" is not one this data supports.
- **Give the chart.** `price_chart` writes an SVG and returns its path; `chartbit_open` puts the
  real Stockbit chart in front of the user.

End with what would invalidate the lean — a level, a date, an earnings print — and then say plainly
that this is analysis of historical data and not investment advice.
