# Pending live verification

**Most of this is now done.** Probed against a live account on 2026-08-09; results are recorded in
`STOCKBIT-API.md` §11 and in the code that consumes them.

## Settled

| | Result |
|---|---|
| `top_movers` casing | **Confirmed.** Same moment, same request: `topgainer` returned 6661 bytes of rows, `topGainer` returned `"data":[]` in 57 bytes. Both HTTP 200 — which is why it hid for so long. |
| `broker_summary` transaction types | **Confirmed.** `NET` and `GROSS` both work and genuinely differ (BBRI top buyer ZP: 801,071 lots net, 938,193 gross). `BUY` / `SELL` 400. |
| `broker_summary` market boards | **Confirmed.** `REGULER`, `ALL`, `NEGO`, `TUNAI` all work. `NEGOTIATED` / `CASH` 400. |
| `period` contradiction | **Resolved, and the catalogue was the wrong one.** Six preset windows work, including `YEAR_TO_DATE` — which aggregates Jan→Aug in a single request. Now exposed on the tool. |
| ARA/ARB field names | **Confirmed, and the shape was not what was assumed.** The bands arrive as `{"value":"3,910"}` while the foreign figures beside them are bare numbers. `price_bands` now reports `missing: []` on a live call. |
| Watchlist | **Confirmed and wired.** 5 lists, 116 symbols in the default one. The index returns `data` as an array; the detail wraps rows in `data.result` — they are not interchangeable. |
| `/charts/{SYMBOL}` | **Resolved: the spelling was the problem.** The web client calls `/charts/{SYM}/daily?timeframe=1w\|1m\|3m\|ytd\|1y\|3y\|5y` — LOWERCASE, with `is_include_previous_historical=true` on `ytd` and `1w`. Every earlier probe sent an uppercase spelling (`1D`, `DAILY`, `TIMEFRAME_DAILY`) and was rejected, which is why the route looked real-but-unusable for months. Wired and covered by tests; a whole series now costs one request instead of the 12-row paged walk. |\n| Screener | **Confirmed and wired.** Running a saved screen is a plain GET, not the POST an earlier pass assumed. Five custom screens on the probed account. |

## Still open

### Unmapped orderbook fields

`iepiev` (pre-opening indicative price/volume), `has_foreign_bs`, `total_bid_offer`, `market_data`,
`autoreject_*`. `iepiev` in particular is worth a look during the pre-opening auction (08:45 WIB) —
a previous pass listed it as "unobserved" rather than absent.

### The whole trading host — `carina.stockbit.com`

**Nothing on this host has been observed live.** Reading it needs a securities session, which needs
the account owner's six-digit PIN at their own terminal — this project never stores one, so there is
no capture and no fixture taken from a real response. Everything in `src/trading/account.ts` is
projected against candidate key names read off Stockbit's web bundle.

That is why those reads behave differently from every other family here:

- **Unrecognised fields are dropped, and only their NAMES are reported** (`unmappedKeys`). Elsewhere
  this project returns the raw row; on a brokerage response an unmapped field is as likely to be an
  account number as a metric, and a tool result is text a model relays.
- **`readFrom` names the wire key every value was read from**, so a wrong guess shows up as a field
  that is absent next to a pile of unknown key names — never as a confident wrong number.
- **A thousand-separated number is refused rather than parsed.** The two Indonesian conventions
  disagree about which separator is decimal, and a money figure read under the wrong one is off by a
  factor of a thousand while still looking like money.

What to settle first, in order of what goes wrong if it is wrong:

| | What is guessed | How it fails |
|---|---|---|
| Lots vs shares | Which of `lot`/`lots`/`balance`/`shares`/`quantity` holds which | Silently 100× out; a wrong position size still looks like a position size. `derived` marks anything computed rather than read. |
| Commission | `buy_fee`/`sell_fee` on `/formula/v2`, and whether a value like `0.0015` is a fraction or a percentage (split at 0.05) | A net proceed quoted on the wrong rate — the one number a user checks before agreeing to an order. `fees.source: "default"` means it could not be read at all. |
| `order/v2/detail` parameter | `order_id` | Most likely a 400 or the whole list, so it is visible; a wrong order returned under the right id would not be. |
| Order status vocabulary | `status`, `order_status`, `state` and the words in them | An order reported as open that is not, or vice versa. |
| Account identity keys | `name`, `account_number`, `rdn`, `sid` | Masked before they leave, so a miss loses information rather than leaking it. |
| `/history/v3` period tokens | Not guessed — passed through verbatim | The server rejects an unknown token, which is the right place for it to fail. |

**How to settle it:** run `stockbit-auth trading-login` on the account owner's machine, then call the
ten read tools once each and record the actual key names. That is one session and it converts every
row above into a fact.

### Order entry — the first real order is a live gate, not a test run

The order apparatus is written, tested against a fake account that lies in every way a real one can,
and **off by default**. What it has never done is send a real order, and three things about the wire
are still read rather than observed:

| | What is guessed | What settles it |
|---|---|---|
| `platform_order_type` | **Not sent at all.** It is in Stockbit's own body and its vocabulary is unknown; an invented enum member is how a request gets accepted meaning something other than what the user was shown. | The HAR. If it is required, the first attempt is a 400 that names it. |
| `split_order` | Sent as `false`. A boolean whose meaning is not in question. | The HAR. |
| The error envelope | `rejected` vs `write-failed` is decided by matching the message against /reject\|insufficient\|invalid/. | The HAR, plus one deliberately-rejected order. |
| The order-list shape | Whether a placed order comes back carrying our `ui_ref`. Verification falls back to an id diff when it does not. | One placed order, read back. |

**The protocol for the first live order** (the ADR-0003 precedent, with the user watching the web UI):

1. With trading disabled, call `order_buy` — it must refuse, and `~/.stockbit/order-mutations.log`
   must record nothing but the refusal.
2. The user places and cancels **one 1-lot order in the Stockbit web UI with DevTools recording a
   HAR**. That fixes `platform_order_type`, the error envelope and the list/detail shapes before this
   code sends anything.
3. `stockbit-auth trading-enable --max-order-value <small>`.
4. `order_preview` a BUY of 1 lot of a liquid, low-priced stock, far below the market but above ARB.
   Read the summary aloud. The user says yes. `order_buy confirm:true`.
5. Compare the `orderId` and status against what the web UI shows.
6. `order_preview` a cancel of it, then `order_cancel`. Read the mutation log together.
7. `stockbit-auth trading-disable`, and confirm the refusal returns.

Amend gets the same treatment on another session.

