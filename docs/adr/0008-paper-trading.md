# ADR-0008 — Paper trading

**Status: ACCEPTED 2026-08-24**, on the account owner's instruction that order entry should ship
off by default *and* with a way to practise.

## Context

Order entry has never been run against a live brokerage account. Everything under `src/trading/` is
projected from Stockbit's web bundle; `docs/PENDING-VERIFICATION.md` says so, ADR-0004 says so, and
every one of those tools says so in its own description. Which means the first person to place an
order through this server does so with real money, on a route nobody has watched work, having never
once seen the protocol run end to end.

The protocol is the part that can be rehearsed. The preview, the ticket, the two-minute expiry, the
confirmation, the elicitation, the outcome classes, the audit line — none of that needs a real
exchange to be worth practising. What it needs is somewhere for the order to go.

## Decision

**Three states, not two.** `TradingSettings.enabled: boolean` becomes `mode: "off" | "paper" |
"live"`. This is the load-bearing part of the change rather than a refactor that came with it: with
a boolean, paper would have needed a second flag beside it, and the pair "enabled but paper" is
exactly the combination a reader gets wrong — either field on its own says the opposite of the
truth. One value, three names, and every reader has to look at all three.

`TradingPolicy` keeps `enabled` (`mode !== "off"`) so every existing gate reads the same, and adds
`live` because "is this real money" is the question that actually matters at a call site.

**The environment can only move down the ladder.** `STOCKBIT_TRADING=off` forces off, as before.
`STOCKBIT_TRADING=paper` lowers `live` to `paper`. Nothing raises anything: `paper` on an `off` file
stays off, and `live` in the environment is ignored entirely. A variable is the easiest thing in a
process tree to set by accident, and the accident must never be the expensive direction.

**No PIN, no session.** Paper reads its account from a local ledger, so the securities session — and
therefore the six-digit PIN — is not involved at all. That is not a shortcut around ADR-0004's rule;
it is the absence of the thing the rule is about.

**The same protocol, deliberately.** `order_preview` still builds a ticket, the ticket still expires
in two minutes, the write tools still take a ticket id and nothing else, the human is still asked
directly wherever the client can ask, and `confirm: true` is still required where it cannot. Paper
mode is not an easier path — it diverges from the live one at exactly one point, inside
`submitOrder`, after every gate has already run. Autoconfirm is refused in paper on purpose: a
rehearsal that skips the confirmation step rehearses the wrong thing.

That single divergence point is why [ADR-0010](0010-elicitation-is-decisive.md) needed no paper-mode
clause of its own: the shared confirmation gate runs above the split, so paper inherited the fix
rather than being patched to match it. The reported bypass reproduced in `--paper`, and the
regression test that pins it runs in both modes.

**Every paper result says so, three times over.** `mode: "paper"` for a machine, a `summary` that
opens with `PAPER ACCOUNT — no real money.` for a person, and a `PAPER_NOTE` in the tool description
telling the model to relay it. The redundancy is the point: the failure being prevented is a user
believing a paper fill was real.

## The fill model, and exactly how it is wrong

A limit **buy** fills if the market was already there when it was placed — the best offer is at or
below the limit — or if the session's minutely close series later prints at or below it. **Sell** is
the mirror. Fills are at the limit price, never better; assuming price improvement would be the
flattering assumption.

Three known errors, stated on every paper result rather than buried here:

| Limit | Direction of the error |
|---|---|
| **Close-only data.** `intraday_prices` is a minutely *close* series. A price that traded inside a minute and closed away from it is invisible. | Misses fills a real market would have given. |
| **No queue position.** A real limit order at the touch joins a queue and may never reach the front. Here, price alone is enough. | Optimistic: paper fills things that would not have filled. |
| **No partial fills.** An order is whole or open. | A strategy that depends on partials behaves differently here. |

These are the limits of a close-only series, not defects to be fixed by trying harder. Anyone
backtesting against this should know they are backtesting against a simulator, and the results say
so every time.

Settlement is lazy: open orders are checked at the start of every paper read rather than by a
background process. So `filledAt` is when the fill was *noticed*, not when it printed — also stated
on the result.

## Why e-IPO is excluded

`eipo_order_preview` and `eipo_order` refuse in paper mode.

An exchange fill is a function of price and a queue: approximable, and paper says how approximately.
An IPO **allotment** is a function of total demand across every subscriber in the country, which is
not knowable from here at any accuracy at all. A simulated allotment would be a number this project
invented and then displayed beside real ones — in a feature whose entire value is that it does not
flatter.

## What paper cannot answer

Three reads keep needing a live session in every mode, and say so: `account` (the holder's
identity), `trading_info` (their commission schedule) and `stock_tradable` (the exchange's verdict
on a symbol today). A ledger has no answer to any of them. Inventing one would be the first lie.

Commission in paper is the published retail rate with `source: "default"`, which is the truth and
also keeps the preview's existing warning about defaulted commission visible.

## Consequences

- Settings gain a version bump to 2 and a migration: a v1 `enabled: true` becomes `live`, because
  that is what it meant. An unrecognised `mode` is `off` — an ambiguous permission is no permission.
- The ledger is the only record of what a practice account did, so a corrupt one is an **error**
  rather than a silent reset, and `stockbit-auth paper-reset` is the deliberate way to start over.
- `trading-enable` with no flag is now refused. A default here would be a decision made for someone
  who did not make it, and the two things that command can do differ by everything.
- Paper does not make the carina projections any more Observed. When the live gate is finally run,
  every one of those field mappings is still a guess — paper proves the protocol, not the wire.
