---
name: strategy-backtest
description: Compare strategies on an IDX symbol, backtest the survivor walk-forward, and hand the result to TradingView as Pine Script. Use when the user asks whether a strategy works, to test an idea, or for a Pine script.
---

# Strategy backtest

## The sequence

1. **`strategy_compare symbol=…`** — nine built-in strategies over the same bars, ranked. This is
   the cheap first pass: it tells you whether anything on this symbol has an edge worth testing
   properly, and the bars are fetched once for all of them.
2. **`backtest symbol=… strategy=…`** on the one or two that stood out. Set **`walk_forward=true`**
   and give it `folds`. An in-sample result on two years of daily bars is a description of the past,
   and presenting one as a strategy is the single most misleading thing this server can be used to
   do.
   - Set `commission_buy_pct` and `commission_sell_pct` to the user's real fees. IDX defaults are
     roughly 0.15% buy and 0.25% sell, and the difference between gross and net is where most paper
     edges live.
   - `stop_loss_pct`, `take_profit_pct` and `max_hold_bars` change the answer more than the entry
     rule usually does.
3. **`pine_script symbol=… kind=strategy`** to hand it to TradingView, with the entry and exit
   conditions carried across.

`workflow_run name=strategy_check` and `name=pine_handoff` package steps 1–2 and 3.

## What to report, and what not to

- **`warnings` and `inconclusive` are the result**, not a footnote. Read them out. If the backtest
  says the sample was too small, that is the answer to the user's question.
- **ARA/ARB-locked bars break fills.** A limit-up day has no liquidity at the printed price. The
  backtester flags these; a strategy whose returns come from limit-locked entries did not happen.
- **Two years of daily bars is about 480 sessions.** That supports claims about daily setups. It
  does not support a claim about monthly seasonality, and it does not survive being sliced by
  regime.
- **Trade count matters more than return.** Nine trades with a 60% win rate is not a 60% win rate.
- **Never annualise a backtest** or extrapolate it forward.

## Presenting it

Give the net return after commission, the trade count, the maximum drawdown, and the walk-forward
folds side by side — if fold three lost money, that belongs in the first paragraph. Then the
warnings. Then, plainly: backtested results do not predict future returns, and this is not advice.
