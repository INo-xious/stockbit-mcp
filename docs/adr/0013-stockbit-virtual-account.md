# ADR-0013 — Isolate Stockbit website virtual trading

Date: 2026-09-24. Updated: 2026-09-25. Status: accepted; authenticated reads observed;
virtual buy/sell full fills, sell-price amendment and cancellation verified by read-back.

The user requires Stockbit's own virtual trading and read-only access to the real
portfolio. A local paper ledger does not satisfy the website virtual-account
requirement. Real-money order entry is removed by ADR-0012.

## Decision

Expose a separate `virtual` tool family backed exclusively by literal
`https://exodus.stockbit.com/virtualtrading/*` routes using the normal main session.
There is no caller-selected host, account-mode flag, securities credential, live
fallback, or generic trade action path. Real portfolio tools and `paper_*` tools
remain distinct. Every virtual result identifies its website origin and simulation.

The tool family reads portfolio, a position, orders, and fee/formula configuration.
It can activate the virtual account, submit buy/sell limit orders, amend, and cancel.
Only the good-for-day forms traced in the virtual UI are supported. Each lot maps to
100 shares, prices must be valid tick prices, and `tradeshare` is always false.
Formula strings returned by Stockbit are data and are never evaluated.

Each mutation requires `confirm: true` for the requested change. Writes use the
shared POST client, which never retries network errors, 429, or 5xx responses. Its
existing authentication-only retry after a rejected 401 remains applicable. Each
mutation then reads fresh website state. A missing acknowledgement, failed readback,
unobserved order, or mismatched amendment returns `outcome: unknown` and an explicit
instruction not to retry blindly. An order record does not imply a fill. Cancellation
requires observing `WITHDRAWN`, rather than merely seeing an order disappear.

Amend/cancel require an open order read from the virtual endpoint. GTC orders,
unknown statuses, missing orders, and a mismatched symbol fail before any write.
HTTP 200 responses carrying an API error are never treated as successful data.

## Evidence

The public Stockbit frontend was fetched on 2026-09-24, Next build
`eCXUv0YjiEIhDng_Km-2W`, application commit marker `40f4d75e`. This is **frontend
evidence**. Subsequently, authenticated portfolio, order-list, configuration, and
position reads succeeded on 2026-09-24. These four tools are `observed`. The
`virtual_order`, `virtual_order_amend` and `virtual_order_cancel` tools have
`read-back` evidence from the controlled sell lifecycle and subsequent authorized
buy/sell fill test on 2026-09-25 described below. `virtual_activate` remains
`projected`; partial fills remain unverified.

All chunks are under `https://stockbit.com/_next/static/chunks/`:

| Chunk | Evidence |
| --- | --- |
| `32294-e8047ba0761e87ca.js` | Modules 63587 and 38959 define virtual order, amend, portfolio and position routes. Module 34493 maps virtual order IDs, statuses, quantities and portfolio fields separately from real trading. |
| `75402.cdd1abc883f440e4.js` | Virtual-only buy/sell/amend dialogs provide exact request bodies: `gtc: false`, `price`, `shares`; creation adds `tradeshare: false`, amendment adds `order_id` and `symbol`. Lot input multiplies by 100. |
| `8715-45f02d8ec9c0742a.js` | Modules 21238 and 8699 define virtual formula/cancel routes and the virtual cancel body (`order_id`, boolean `gtc`). Module 10190 reads `order_id`/`order_ids` from virtual acknowledgements. |
| `74744-1cd5b9234b50caa6.js` | Virtual login posts `/virtualtrading/account/activate`; account mode constants separate virtual from real. Status vocabulary includes `OPEN`, `PARTIAL`, `READY`, `MATCH`, `REJECTED`, `WITHDRAWN`. |
| `90330-f15effadf67c3d39.js` and `58354-9a9b3e028f498ca9.js` | The virtual route client is the default main-session Axios instance with exodus base URL and main access bearer. |

The SHA-256 of the virtual dialog chunk is
`1dd294842dafde21f7761c80eb8bb31256677b4efc0fbfb649ed6ea81481ec95`;
the virtual route chunk is
`bf3d3aa4fe41bbc4c61cc6ee6ecbd6de640b6619405c062ac1d8dfbd24045699`.
No authenticated payloads or credentials are stored in these research notes.

## Validation and limits

`test/virtual.test.ts` exercises strict host/route isolation, input and confirmation
refusals, exact simulation request bodies, failure/no-replay behavior, fresh readback,
rejected orders, and absence of false cancellation/amendment success. These are
deterministic fixtures, not live exchange or website validation.

Authenticated reads used the user's normal Stockbit login on 2026-09-24: the
portfolio returned three holdings, the order list was empty, configuration returned
buy/sell/portfolio formulas, and a held position returned the frontend-mapped object.
An unheld BBRI position returned `data: null`; the tool now returns `found: false`
and a null position, with a regression fixture. No account balances are recorded here.

At 12:46 UTC on 2026-09-24, one authorized virtual BBCA buy was attempted for one
lot at 5,300 IDR, the lower band returned by Stockbit's price feed (quote: 6,225 IDR).
The service refused it outside market hours. The order list remained empty and a
before/after holdings comparison was unchanged. No retry, amendment, cancellation,
or activation followed. This establishes the service's market-hours refusal, not a
successful order lifecycle.

At 11:09:59 WIB on 2026-09-25, actual MCP calls completed an authorized virtual
sell/amend/cancel lifecycle. A one-lot SUPA limit sell at 610 IDR returned
`order_ids: [string]` and was read back as `OPEN`. Amendment to 605 IDR returned
`order_id: string` and `command: string`; the new order was read back as `OPEN`
and the original as `AMENDED`. Both prices were above the observed 484 IDR bid
and 486 IDR offer. Cancellation was confirmed by reading the replacement order
as `WITHDRAWN`. The symbol, action, limit price, total lots and good-for-day fields
matched the requests. No fills occurred, no open orders remained, and final
comparisons showed unchanged holding quantities, costs and reservations and
unchanged virtual trading balance. No order IDs or account values are recorded here.

Earlier on 2026-09-25, a one-lot BBCA buy at 5,300 IDR returned HTTP 400 for
insufficient virtual cash and created no order. This is evidence of buy rejection
handling, not of successful buy submission. No blind retry was made.

At 11:22:40 WIB on 2026-09-25, a separate user-authorized test sold one virtual
SUPA lot with a 484 IDR limit to fund a one-lot virtual GOTO buy with a 50 IDR
limit. Both actual MCP submissions were read back as `MATCH` with `total: 1`,
`done: 1` and `open: 0`. Portfolio `balance_lot` decreased by one for SUPA and
increased by one for GOTO. Virtual cash increased by 48,255 IDR for the sell and
decreased by 5,010 IDR for the buy. The net test cash change was 43,245 IDR;
unrelated holdings and preexisting orders were unchanged, with zero open orders
remaining. These authorized fills intentionally changed the two simulated holdings.
No account balances or order IDs are recorded here.

The sell returned raw `price_average: 482.548`, `amount.matched: 48254.8` and
`amount.fee: 145.2`; the buy returned `price_average: 50.1`,
`amount.matched: 5010` and `amount.fee: 10`. In these responses, the sell matched
amount was the 48,400 IDR limit notional minus its fee, while the buy matched
amount was the 5,000 IDR limit notional plus its fee. Thus these raw fields were
fee-adjusted: `price_average` must not be relabeled as the exchange execution
price. The sell's cash credit exceeded its raw matched amount by 0.2 IDR;
this observation does not establish a general rounding rule. The buy's cash
debit matched exactly.

The configuration formula strings contained buy/sell rates of 0.0015/0.0025,
but the observed order fees were 0.002/0.003 of the test limit notionals. This
disagreement is recorded rather than hiding it behind a calculated fee. Formula
strings remain uninterpreted upstream data, and these two observed rates are not
a universal fee contract.

Virtual activation and partial fills remain unverified live. Amendment and
cancellation evidence covers an unfilled sell and a price-only change. Support
for GTC, virtual history, resetting balances, or other virtual features must wait
for their own frontend and live contracts; no speculative paths are allowed.
