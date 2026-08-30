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
   - `period` takes one of FIVE windows, and only these five: `LATEST`, `YESTERDAY`, `LAST_7_DAYS`,
     `LAST_3_MONTHS`, `YEAR_TO_DATE`. The longer ten-value list belongs to `broker_activity`,
     `broker_top` and `broker_distribution`, which are different endpoints; sending one of those
     here is rejected, and `LAST_1_DAY` / `LAST_30_DAYS` return a 400 from Stockbit itself. Or give
     `from`/`to` for an explicit range. Do not do both — the API ignores the dates and answers with
     the latest session, silently.
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
   - In the ranked read, `topDistributors` is largest seller FIRST, and sell figures are NEGATIVE
     because that is how the wire sends them. Do not negate them again.

`workflow_run name=bandar_watch` runs steps 2 and 3 in one call. It does NOT call `market_session`
or `bandar_detector`, so if you use it, check the session yourself before presenting today's flow
as a day's flow.

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
  asked about today, give today, and then say what the longer window shows. Institutions build over
  weeks; a single session of net buying sits inside ordinary two-way flow.
- **Low concentration is not evidence of absence.** The same beneficial owner can spread orders
  across several brokers precisely so this reading shows nothing. "No one broker dominates" and
  "nobody is accumulating" are different statements, and only the first is supported.
- **Net flow is not a motive.** Nothing here separates accumulation from a client rotating between
  accounts, a market maker hedging, an index fund tracking a reweight, or a block crossed by prior
  agreement. `bandar_detector` returns no verdict, no score and no direction, and neither should you.
- **The board changes the numbers.** The default REGULER excludes negotiated blocks; `ALL` can
  multiply the figures several times over. Say which board a number came from.

## How to phrase it

Lead with the net position over the window, name the top accumulators and distributors with their
lot counts, then say what would change your mind. Confidence is a description of the evidence
("five straight sessions of net buying by the same three brokers"), never a percentage. Do not
predict a price. End anything that reads like a recommendation with a reminder that this is
historical flow, not advice.
