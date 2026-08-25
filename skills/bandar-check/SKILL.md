---
name: bandar-check
description: Answer "who is accumulating this stock?" for an IDX ticker using Stockbit broker-flow data. Use when the user asks about bandar, big money, accumulation, distribution, foreign flow, asing, or who is on the other side of the tape.
---

# Bandar check

Broker flow is the one thing this server has that no general market API does. It is also the
easiest thing to over-read, so the order below is not optional: establish that the tape is
meaningful before saying anything about who is on it.

## The sequence

1. **`market_session`** — is the market open, pre-open, or closed? Today's flow is partial until it
   closes. Say so rather than quietly presenting half a day as a day.
2. **`broker_summary symbol=… `** — the ledger. Every broker's buy and sell over the window.
   - `period` takes one of ten calendar windows (`LAST_1_DAY`, `LAST_7_DAYS`, `LAST_1_MONTH`,
     `LAST_3_MONTHS`, `LAST_6_MONTHS`, `LAST_1_YEAR`, `PREVIOUS_DAY`, `PREVIOUS_MONTH`,
     `THIS_MONTH`, `YEAR_TO_DATE`). Or give `from`/`to` for an explicit range. Do not do both.
   - `transaction_type` is `NET` or `GROSS`. **NET is the question people mean.** GROSS tells you
     who was busy; NET tells you who ended up holding.
   - `market_board` defaults to the regular board. `NEGO` and `TUNAI` are crossings and cash
     settlement — real, but not the same signal. If the user's question is about accumulation, say
     which board the number came from.
   - `investor_type` splits Asing (foreign), Lokal (domestic) and Pemerintah (government).
3. **`broker_distribution symbol=…`** — who bought *from whom*. This is the part that turns a list
   of names into a story: it pairs the accumulating brokers with the ones supplying them.
4. **`bandar_detector symbol=…`** for a ranked read, or **`broker_activity broker_code=…`** to ask
   the opposite question — what else has this broker been doing.

`workflow_run name=bandar_watch` runs a version of this in one call.

## Reading it honestly

- **A broker is not an investor.** Brokers execute for clients. A house code accumulating means
  *its clients, in aggregate,* accumulated. Institutional-looking flow through a retail-heavy broker
  is usually many small orders, not one big one.
- **A floor-locked stock carries no flow signal.** If the price sat at ARB (auto-reject bottom) all
  session, the only trades that printed were the ones that could. Check `price_bands` before
  reading intent into the tape. The same goes for ARA on the way up.
- **Foreign flow is not smart money.** It is one investor class with its own mandate and its own
  redemption calendar.
- **One day is noise.** Persistence over a week or a month is the claim worth making. If the user
  asked about today, give today, and then say what the longer window shows.

## How to phrase it

Lead with the net position over the window, name the top accumulators and distributors with their
lot counts, then say what would change your mind. Confidence is a description of the evidence
("five straight sessions of net buying by the same three brokers"), never a percentage. Do not
predict a price. End anything that reads like a recommendation with a reminder that this is
historical flow, not advice.
