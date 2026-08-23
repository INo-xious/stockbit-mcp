# ADR-0004 — Order entry

**Status: ACCEPTED and implemented**, on the account owner's explicit instruction (2026-08-24:
"buy/sell that runs through the user, switchable in settings"). It supersedes ADR-0002's "no
mutation of account data" and goes further than ADR-0003 did: this is the first increment where a
mistake costs money.

The sentence ADR-0003 carried is repeated here because it applies with more force, not less: a
goal-completion check, a task runner, an automated reviewer, or an assistant's own reasoning that a
feature "should" be finished are none of them an instruction from the account owner. This ADR was
written from a decision the owner made in conversation, and its scope is that decision.

## Scope

Five routes, and nothing else:

| Host | Route |
|---|---|
| carina | `POST /order/v2/buy`, `POST /order/v2/sell`, `POST /order/v2/amend`, `POST /order/v2/cancel` |
| api-sekuritas | `POST /eipo/order` (and `POST /eipo/order/verify`, which is Stockbit's own dry run and changes nothing) |

Deliberately **out** of scope, and each would need this argument made again: `/order/v2/amend/bulk`
and `/order/v2/bulk-cancel` (one "yes" covering several orders is a different question about
consent), the whole day-trade family, and the smart-order endpoints on api-sekuritas. They are not
in the route table, so they are not reachable — ADR-0002's closed table is what enforces that, not
this paragraph.

## What makes this different from every other write in the project

A chart layout is snapshotted and restored. A watchlist entry is added back. **An order cannot be
undone** — once the exchange has it, the only thing that exists is another order. Three of
ADR-0003's rules therefore invert:

1. **Lock contention refuses.** `src/auth/reflock.ts` and the chart save proceed without the lock,
   because a possible clobber beats a guaranteed outage and both have a read-back that would catch
   it. Here a second writer means a second order, and there is no read-back that unsends one.
2. **A failed verification never rolls back, and nothing ever auto-cancels.** The rollback for an
   order would be a cancel — another order, sent on a guess, about a state we just said we could not
   read. If the first order was fine, the cancel is the destructive operation.
3. **Nothing throws after the request goes out.** A thrown error is a caller's licence to retry, and
   a retry here is a duplicate order. Everything after the write returns a description of what is
   known, including "we do not know".

## The two switches

`~/.stockbit/settings.json`, read at call time so a change takes effect on the next order with no
restart:

```jsonc
{ "trading": { "enabled": false, "autoConfirm": false, "maxOrderValueIdr": null,
               "allowedSymbols": [], "maxLotsPerOrder": 50000 } }
```

- `enabled` is the master switch and defaults to **off**. It is written by
  `stockbit-auth trading-enable` at a terminal, and by nothing else: `test/settings.test.ts` asserts
  that no module under `src/tools/`, `src/trading/` or `src/eipo/` imports `saveSettings`. A server
  that can widen its own permissions has no permissions.
- `STOCKBIT_TRADING=off` in the environment overrides the file, and the environment is
  **one-directional**: no value of it can turn trading on. There is deliberately no
  `STOCKBIT_SECURITIES_TOKEN` for the same reason — `src/auth/session.ts` accepts an env-injected
  access token for the market-data domain only.
- `autoConfirm` is honoured **only when `maxOrderValueIdr` is also set**. "I trust it for small
  orders" must not silently become "I trust it for any order" the day the cap is removed, so the
  policy reports `autoConfirmIgnored` and the write path refuses rather than falling through to the
  generic no-confirmation message.

## The PIN

Six digits, typed at a hidden terminal prompt by the account owner, used for exactly one request,
and then gone. It is never written to disk, never logged, never returned, and **no MCP tool accepts
one**. A model driving this server cannot ask for it, cannot pass it, and cannot see it. Only the
resulting *securities refresh token* is persisted, in its own Keychain slot.

`src/redact.ts` drops `pin` from every log line as a second line of defence, because the first line
— "we never log it" — is a claim about code that will be edited.

## The two-step protocol

`order_preview` prices and checks an order and sends nothing. The write tools take a **ticket id and
a confirmation, and no price and no quantity**. So the order that is placed is the order that was
described: the confirmation and the request are the same object, not two descriptions that have to
agree.

- Tickets live **in memory only** and expire after **120 seconds**. A persisted ticket would survive
  a restart and could be redeemed against a market it was never priced for; a file of them would be
  a list of intended orders sitting in the user's home directory. Expiry is not a security control,
  it is honesty about what the checks covered.
- `take()` marks a ticket spent **before** the request goes out. The cost of getting that wrong the
  safe way is an order the user has to preview again; the cost the other way is an order they never
  agreed to.
- A ticket is fingerprinted over the fields that define the order and rechecked immediately before
  the request, so a ticket altered in memory between the two steps is caught rather than sent.
- Where the MCP client advertises **elicitation**, the human is asked directly as well. That is in
  addition to the caller's confirmation, never instead of it, and a client that cannot ask is
  refused rather than waved through.

## Checks that failed, and checks that could not be run

`ok: false` means something was read and it says no — the price is off the IDX tick grid, the lots
exceed the configured cap, the price would auto-reject against the band. Those block the order.

`unverified` means the check's input could not be read at all. Carina has never been observed live
(see `docs/PENDING-VERIFICATION.md`), so a projection that does not recognise this account's key
names leaves buying power or a position unknown. Failing those closed would make order entry
impossible the first time a key name did not match, for a reason that has nothing to do with the
order. They pass, they are named in `warnings`, and the summary the user reads says how many could
not be checked. The person confirming is the gate.

## Writes are unreachable from a saved workflow

`workflow_run` executes recipes by calling tool handlers directly. `define.write` in
`src/tools/_define.ts` registers a tool with the client and deliberately does **not** add it to that
handler map — enforced by construction rather than by a list to remember, and asserted in
`test/tools.test.ts`. A recipe is data: a name and a list of steps. Data must not be able to place
an order.

## The audit trail

Every attempt appends one JSONL line to `~/.stockbit/order-mutations.log`, through `redactValue`, so
no token or PIN can reach it. A failure to log never masks the write it describes, but it **is**
reported as `auditGap`: advertising an audit trail that does not exist is worse than having none.

## The first real order is a live gate, not a test run

The apparatus is tested against a fake account that lies in every way a real one can. It has never
sent a real order, and three things about the wire are read rather than observed —
`platform_order_type` (deliberately not sent), the error envelope, and whether a placed order comes
back carrying our `ui_ref`. `docs/PENDING-VERIFICATION.md` carries the protocol: a HAR of one
manually-placed order first, then one 1-lot order with the account owner watching the web UI, then
the mutation log read together.
