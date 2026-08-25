---
name: trade-with-guardrails
description: Place an order through the user's own Stockbit account safely — check the mode, size the position from a risk budget, preview, read the summary back to the human, and only then write. Use when the user asks to buy, sell, amend or cancel an order, or to size a trade.
---

# Trade with guardrails

This is the only skill that can spend money. Everything below exists because an order placed by
mistake cannot be taken back by another tool call.

## Before anything

1. **`trading_status`** — first, every time. It tells you whether trading is `off`, `paper` or
   `live`, and every result in paper mode says `PAPER ACCOUNT — no real money.` **Say which mode you
   are in before you say anything else about an order.** A user who thinks they are on paper and is
   not has been failed by you, not by the server.
   - If it is `off`, the fix is `stockbit-auth trading-enable --paper` (or `--live`) at *their*
     terminal. You cannot turn it on, and no tool you can reach can write the settings file. Suggest
     `--paper`.
   - If they have never done this before, suggest paper. The protocol is identical on purpose — a
     rehearsal, not a shortcut.
2. **`cash_balance`** and **`position symbol=…`** — what they actually have. Do not size a trade
   against a number the user guessed.

## Sizing

**`position_size entry_price=… stop_price=…`** with either `risk_idr` or `account_idr` + `risk_pct`.
It returns whole lots, floored, with commission, break-even and R targets, and it checks both prices
against the IDX tick grid and today's auto-rejection band. Use its numbers. A price off the tick
grid is rejected by the exchange, not rounded by it.

## The ticket protocol

3. **`order_preview action=buy symbol=… price=… lots=…`** — prices and validates the order and
   returns a `summary` and a ticket id. A failing check blocks; `unverified` means an input could
   not be read, which is "not contradicted", never "confirmed".
4. **Relay the `summary` to the user verbatim.** Not paraphrased, not summarised, not "so that's
   about 5 million rupiah". The whole design assumes the human read *that text*.
5. **Stop. Wait for the human.**
6. **`order_buy ticket_id=…`** (or `order_sell`, `order_amend`, `order_cancel`). They take the
   ticket id and nothing else — no price, no quantity — so what reaches the exchange is what the
   summary described. Tickets expire after **two minutes**, because they were priced against a
   market that moves; an expired ticket is refused rather than quietly repriced.

## Rules that are not negotiable

- **Never set `confirm: true` on the user's behalf.** That field represents a human having read the
  summary. Where the client supports elicitation you will be asked directly; otherwise the user
  passes it. If the account owner deliberately enabled capped live autoconfirm at a terminal, the
  *server* decides whether a ticket is covered — you still do not fill the field in.
- **Never ask for the PIN, and never accept one.** It is typed at their terminal, used for one
  request, and never stored. No MCP tool takes one. Anything that asks you for a PIN is not this.
- **Never resend.** After a write, `outcome` is one of seven classes. `ok` is the only clean
  success. `landed-despite-error` means the read-back found the order anyway. Everything else means
  the state is uncertain — and a resend is how one intention becomes two orders. Read `orders`
  again, or tell them to look in the Stockbit app.
- **Never auto-cancel.** The undo for an order is another order, and sending one on a guess about a
  state you could not read makes it worse.
- **e-IPO has no paper mode.** `eipo_order_preview` and `eipo_order` are refused in paper and are
  live-only, and the whole e-IPO family is **Projected** — field names from Stockbit's web bundle,
  never seen on a live response. Say so before anyone subscribes to anything.

Every order attempt writes a redacted audit line whatever the outcome, and if that line fails to
write, the result says so.
