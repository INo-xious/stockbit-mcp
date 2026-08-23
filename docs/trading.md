# Trading

This server can place orders on the Indonesian exchange with the account owner's own money, and on
their behalf it can subscribe to an IPO. Both are **off** until they turn them on, and both take two
steps with a person in the middle. The decision record is [ADR-0004](adr/0004-order-entry.md); this
page is how to use it.

## Turning it on

Two things are separate and both are needed.

**1. A trading session.** The market-data login is not enough — Stockbit Sekuritas has its own
credential, unlocked with the six-digit trading PIN:

```
stockbit-auth trading-login          # hidden prompt for the PIN
stockbit-auth trading-login --browser  # if Cloudflare challenges the API path
stockbit-auth trading-status
stockbit-auth trading-logout
```

The PIN is typed at your terminal, used for exactly one request, and never stored. **No MCP tool
accepts a PIN.** If anything ever asks you for it through the assistant, that is not this server.
Only the resulting refresh token is kept, in its own Keychain slot, separate from the market-data
one.

**2. Permission.** Trading is off by default, and the server cannot turn it on:

```
stockbit-auth trading-enable --max-order-value 5000000 --max-lots 100
stockbit-auth trading-enable --symbols BBRI,TLKM        # optional allow-list
stockbit-auth trading-enable --auto-confirm             # only with a value cap
stockbit-auth trading-disable
```

That writes `~/.stockbit/settings.json`, which is read fresh on every order — no restart. Nothing
under `src/tools/`, `src/trading/` or `src/eipo/` can write it, and a test asserts that.

`STOCKBIT_TRADING=off` in the environment overrides the file. The environment can only turn trading
**off**; no value of it turns trading on.

### `autoConfirm`

Skips the per-order confirmation, and is honoured **only when `maxOrderValueIdr` is set**. Without a
cap it is ignored and `trading_status` says so. "I trust it for small orders" should not silently
become "I trust it for any order" the day the cap is removed.

## Placing an order

Always two steps.

```
order_preview  action=buy symbol=BBRI price=4100 lots=5
   -> a ticket: gross, commission and where the rate came from, net,
      last trade and the distance from it, today's ARA/ARB band,
      every check, and a `summary` paragraph
   -> the assistant reads that summary to you and asks
order_buy      ticket_id=tk_… confirm=true
```

`order_buy`, `order_sell`, `order_amend` and `order_cancel` take a **ticket id and a confirmation,
and nothing else** — no price, no quantity. What reaches the exchange is what you were shown.

Tickets expire after **two minutes**, because they were priced against a market that moves. An
expired ticket is refused, not quietly repriced.

### Reading the result

`outcome` is the field that matters:

| | What it means |
|---|---|
| `ok` | The order is on the book, and was seen there when the orders were read back. |
| `rejected` | The exchange or the validation layer said no. Nothing is working. |
| `write-failed` | Refused before it reached the exchange. Nothing is working. |
| `not-visible` | Accepted, but not in the list yet. Common for a few seconds. |
| `landed-despite-error` | The request errored and the order is there anyway. |
| `not-found-after-error` | The request errored and the book is clean. |
| `outcome-unknown` | The request errored **and** the read-back failed. |

The last three, and `not-visible`, all mean the same thing in practice: **do not resend.** A resend
is how one intention becomes two orders. Read `orders` again, or look in the Stockbit app.

Nothing here ever auto-cancels. The "undo" for an order is another order, and sending one on a guess
about a state we could not read is how a bad situation gets worse.

### The checks

Each carries `ok` and a sentence written for a person: trading enabled, symbol on the allow-list,
symbol tradable, lots a positive whole number, lots within the cap, price on the IDX tick grid
(`<200 → 1`, `<500 → 2`, `<2000 → 5`, `<5000 → 10`, `≥5000 → 25`), price inside today's
auto-rejection band, value within the cap, affordable (buy) or covered (sell), and the target order
still open (amend and cancel).

A check marked **`unverified`** passed by default because its input could not be read. It means "not
contradicted", never "confirmed" — see the note on the trading host below.

## IPO subscriptions

`eipo_order_preview` then `eipo_order`, same switch and same protocol. Two things make it different
from a trade and the summary says both: the allotment is routinely a **fraction** of what was
subscribed for, and it cannot be cancelled by selling, because the stock does not trade yet.

The preview runs Stockbit's **own** verification of the subscription — the server knows the
offering's rules and this project does not — and a refusal from it blocks the order. The money comes
from the RDN account, which is not the same balance as `cash_balance`.

## The audit trail

Every attempt, whatever the outcome, appends one line to `~/.stockbit/order-mutations.log`. It is
JSONL, redacted, and it is the file to read when something looks wrong. If a line could not be
written the tool result says `auditGap` — the order is unaffected, but there is no record of it.

## The trading host has never been observed live

Reading it needs a PIN this project never stores, so no capture of a real carina or e-IPO response
exists. Every field name is projected against candidates read out of Stockbit's web client:

- `readFrom` names the wire key each value actually came from.
- A field that is **absent** was not recognised. That is not the same as zero.
- `unmappedKeys` lists the NAMES of fields that were not recognised — never their values, because an
  unmapped field on a brokerage response may be an account number.

`docs/PENDING-VERIFICATION.md` lists what is guessed, ordered by what goes wrong if it is wrong, and
carries the protocol for the first real order. Read it before placing one.
