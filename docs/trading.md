# Trading

This server can place orders on the Indonesian exchange with the account owner's own money, and on
their behalf it can subscribe to an IPO. Both are **off** until they turn them on, and both take two
steps with a person in the middle. The decision records are [ADR-0004](adr/0004-order-entry.md) and
[ADR-0008](adr/0008-paper-trading.md); this page is how to use them.

## Try it on paper first

```
stockbit-auth trading-enable --paper          # Rp 100,000,000 to practise with
stockbit-auth trading-enable --paper --cash 250000000
stockbit-auth paper-reset                     # start over
stockbit-auth trading-status                  # which mode, and what the ledger holds
```

Paper mode gives you a **local ledger** to trade against. No real money, no exchange, no trading
session, and **no PIN** — none of that is involved, because there is no brokerage on the other end.

The protocol is deliberately identical. `order_preview` builds the same ticket, it still expires in
two minutes, the write tools still take a ticket id and nothing else, you are still asked directly
wherever your client can ask, and `confirm: true` is still required where it cannot — autoconfirm is
refused in paper, because a rehearsal that skips the confirmation step rehearses the wrong thing.
The point is that nothing about the live path is a surprise later.

Your portfolio, positions, cash, orders, order history and trade performance are served from the
ledger while paper is on. Every one of those results carries `mode: "paper"` and opens with
**"PAPER ACCOUNT — no real money."** Three reads still need a real session and say so — `account`,
`trading_info` and `stock_tradable` describe the brokerage relationship, and a ledger has no honest
answer for them. `eipo_order` refuses outright: an IPO allotment depends on national demand, and a
simulated one would be a number this project made up.

> [!IMPORTANT]
> **Paper fills are approximate, in three specific ways.** A limit order fills if the market is
> already there when you place it, or if the session's minutely **close** series later prints
> through your limit. So: a price that traded inside a minute and closed away from it is invisible
> (missed fills); there is no queue position, so paper is optimistic about getting filled at the
> touch; and there are no partial fills, so an order is whole or open. Do not backtest against this
> and believe the number.

Paper also does not make the trading tools any more verified. The carina field mappings are still
**Projected** — paper proves the protocol, not the wire.

## Turning it on for real

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
Only the resulting refresh token is kept, in its own store slot — the macOS Keychain, or the
encrypted file store on Windows and Linux — separate from the market-data one.

**2. Permission.** Trading is off by default, and the server cannot turn it on. `--live` is
required and cannot be defaulted into — a bare `trading-enable` is refused, because the two things
it could mean differ by everything:

```
stockbit-auth trading-enable --live --max-order-value 5000000 --max-lots 100
stockbit-auth trading-enable --live --symbols BBRI,TLKM   # optional allow-list
stockbit-auth trading-enable --live --auto-confirm        # only with a value cap
stockbit-auth trading-disable
```

That writes `~/.stockbit/settings.json`, which is read fresh on every order — no restart. Nothing
under `src/tools/`, `src/trading/` or `src/eipo/` can write it, and a test asserts that.

The environment can only move **down** the ladder — `live` → `paper` → `off` — and never up:

| Value | Effect |
|---|---|
| `STOCKBIT_TRADING=off` (or `0`, `false`, `no`) | Trading off, whatever the file says. |
| `STOCKBIT_TRADING=paper` | Lowers a `live` file to paper for this process. It cannot raise `off`. |
| anything else, including `live` | Ignored. Nothing in the environment turns trading on or makes it real. |

### `autoConfirm`

Skips the per-order confirmation — including the ask — and is honoured **only when
`maxOrderValueIdr` is set**. Without a cap it is ignored and `trading_status` says so. "I trust it
for small orders" should not silently become "I trust it for any order" the day the cap is removed.

It is also ignored outright when `elicitation` is `required`, because the two switches say opposite
things about whether a person is asked. The ask wins, and `trading_status` says which of the two is
not doing anything and how to resolve it.

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

`order_buy`, `order_sell`, `order_amend` and `order_cancel` take a **ticket id, an optional
confirmation, and nothing else** — no price, no quantity. What reaches the exchange is what the
ticket described.

Tickets expire after **two minutes**, because they were priced against a market that moves. An
expired ticket is refused, not quietly repriced.

### Who confirms

Two different things can confirm an order, and they are not interchangeable. `confirm: true` is a
boolean **the model** sets. MCP elicitation is the only channel in the protocol that reaches **a
person**. This server used to accept either, in that order, which meant a model could skip the
person entirely by asserting the person had already agreed — and the audit log said `via:
"explicit"` for both cases, so afterwards nothing could tell them apart. That is fixed;
[ADR-0010](adr/0010-elicitation-is-decisive.md) is the record.

Now, on a client that supports elicitation, **you are asked first — before `confirm` is looked at —
and your answer decides it.** Declining refuses the order however `confirm` was set. On a client
that cannot ask, `confirm: true` is the only gate there is: the order proceeds, and both the result
and the audit line say plainly that no human was asked. A client that cannot ask must not become a
client that cannot trade.

The audit log records **how** the gate was satisfied, in one of five values:

| `via` | |
|---|---|
| `elicited` | You clicked yes in the dialog. The strongest evidence this protocol can record. |
| `remembered` | A "don't ask again" you granted yourself covered it. |
| `auto-confirm` | Your capped `autoConfirm` policy, set at a terminal. |
| `explicit-unelicited` | `confirm: true`, and the client advertises no way to ask you. |
| `explicit-elicit-disabled` | `confirm: true`, and you set `elicitation: never` yourself. |

The result carries `elicitation` instead — `accepted`, `remembered`, `unavailable`,
`disabled-by-policy` or `waived-by-auto-confirm` — because "was I asked?" is the fact a person
needs, and the five-way distinction is evidence for the log rather than advice for you.

### `elicitation` — three values, one dial

```bash
stockbit-auth trading-enable --live --elicitation required        # or --require-elicitation
stockbit-auth trading-enable --live --elicitation when-available  # the default
stockbit-auth trading-enable --live --elicitation never           # or --no-elicitation
```

| | |
|---|---|
| `required` | Refuse rather than send when no person can be reached. `confirm: true` never substitutes, and `autoConfirm` is ignored outright — the two contradict, and the ask wins. |
| `when-available` | Ask wherever the client supports it; fall back to `confirm: true` where it does not. **The default**, and what every existing install gets. |
| `never` | Do not ask at all, whatever the client supports. `confirm: true` becomes the only gate. |

`trading_status` and `status` both report which is in force.

### "Don't ask again"

The confirmation dialog carries a second box **you** tick, and only you: it waives the dialog for
later new orders, inside five bounds that must all hold at once.

- **Fifteen minutes.** One sitting, not one day.
- **New orders only.** A buy or a sell. An amend and a cancel change something already working, and
  agreeing to spend X rupiah is not agreeing to move or withdraw an order already on the book — so
  those are *never* covered and are always asked about. Neither is an e-IPO subscription: it is a
  different commitment, and the box you ticked on a share order never showed you that an allotment
  may be smaller than the subscription and cannot be cancelled by selling.
- **The value you approved.** You agreed to an order of X rupiah, so it covers orders up to X and
  nothing larger. That is *each* order, not a total — any number of them can go through inside the
  fifteen minutes, and that window is what bounds the total. It does not restrict which symbol or
  which side.
- **The policy that was in force.** Change the mode, a cap, the symbol list or this switch and every
  outstanding grant dies with it.
- **Revocation.** `stockbit-auth trading-forget` at a terminal ends every grant everywhere,
  *including in server processes that are already running* — the CLI stamps a moment into the
  settings file and every order re-reads the policy before the gate.

The grant is created only once the order it was ticked on has actually been committed to — so an
order that is then refused, including one whose two-minute ticket ran out while you were reading the
dialog, leaves no waiver behind. If that happens the refusal says so.

It is held in memory and never written to disk, so a restart ends it too. Inside a conversation, the
`trading_forget` tool ends it immediately; it is safe to call when there is nothing to clear, and it
can only ever make this server ask *more* questions. `status` and `trading_status` report whether one
is live, what it is capped at, and when it expires.

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

Every result other than `ok` means the same thing in one practical respect: **do not resend.** For
`landed-despite-error`, the read-back already found the order; for uncertain cases, another read may
settle the state. Read `orders` again, or look in the Stockbit app.

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
