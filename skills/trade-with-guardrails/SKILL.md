---
name: trade-with-guardrails
description: Use Stockbit website virtual trading or the separate local paper ledger for simulated buy, sell, amend and cancel requests. Real-money execution is unavailable; brokerage portfolio tools are read-only.
---

# Simulated trading with guardrails

This server cannot execute real-money trades. Distinguish three accounts before selecting tools:

- Brokerage portfolio: `portfolio`, `position`, `cash_balance`, `orders` and `order_history` read the
  real account. Simulation mode does not redirect these tools.
- Stockbit website virtual account: `virtual_portfolio`, `virtual_position` and `virtual_orders`.
- Local paper ledger: `paper_portfolio`, `paper_position` and `paper_orders`.

If a request leaves the simulation account unclear, clarify which of the last two the user means.
Never present simulated holdings or fills as real money. A request for a real-money trade cannot be
fulfilled by silently substituting a simulation.

## Website virtual trading

Read `virtual_portfolio` and `virtual_orders` first. Use `virtual_config` for the website's fee
settings. Activate with `virtual_activate` only when the user intends to start the virtual account.

For a simulated order, state the account, symbol, side, limit price and lots before calling
`virtual_order`. Use `virtual_order_amend` or `virtual_order_cancel` with an order identifier read
from that virtual account. Every virtual write requires authorization for that specific change;
`confirm: true` conveys that authorization. These tools support day limit orders and do not publish
trades to the social stream.

## Local paper ledger

Read `trading_status`. When paper is off, the user can enable it at their terminal with
`stockbit-auth trading-enable --paper`; this cannot enable real trading.

Call `paper_order_preview` with the requested action, symbol, price and lots (or the existing paper
order identifier). Read the ticket's checks and relay its summary **verbatim**, including the PAPER
ACCOUNT label. After agreement, use the corresponding `paper_order_buy`, `paper_order_sell`,
`paper_order_amend` or `paper_order_cancel` with the ticket identifier. Tickets expire after two
minutes. Local simulated fill rules do not match exchange execution or Stockbit's virtual engine.

## Results and secrets

- Never set `confirm: true` on the user's behalf without authorization for that specific change.
- Never ask for the PIN, password, OTP, cookie or token in chat. Brokerage reads may require the
  user to unlock a securities session through their own terminal.
- Never resend an uncertain write. Read `outcome` and relay `message`; inspect current orders
  before deciding what happened. An accepted order record is not proof that it filled.
- Keep absent or unrecognised values absent. Do not turn missing cash, positions or quantities into zero.
