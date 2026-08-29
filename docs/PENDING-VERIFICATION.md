# Pending live verification

**Most of this is now done.** Probed against a live account on 2026-08-09; results are recorded in
`stockbit-api.md` §11 and in the code that consumes them.

## Settled

| | Result |
|---|---|
| `top_movers` casing | **Confirmed.** Same moment, same request: `topgainer` returned 6661 bytes of rows, `topGainer` returned `"data":[]` in 57 bytes. Both HTTP 200 — which is why it hid for so long. |
| `broker_summary` transaction types | **Confirmed.** `NET` and `GROSS` both work and genuinely differ (BBRI top buyer ZP: 801,071 lots net, 938,193 gross). `BUY` / `SELL` 400. |
| `broker_summary` market boards | **Confirmed.** `REGULER`, `ALL`, `NEGO`, `TUNAI` all work. `NEGOTIATED` / `CASH` 400. |
| `period` contradiction | **Resolved, and the catalogue was the wrong one.** Six preset windows work, including `YEAR_TO_DATE` — which aggregates Jan→Aug in a single request. Now exposed on the tool. |
| ARA/ARB field names | **Confirmed, and the shape was not what was assumed.** The bands arrive as `{"value":"3,910"}` while the foreign figures beside them are bare numbers. `price_bands` now reports `missing: []` on a live call. |
| Watchlist | **Confirmed and wired.** Several lists; the default one held over a hundred symbols. The index returns `data` as an array; the detail wraps rows in `data.result` — they are not interchangeable. |
| `/charts/{SYMBOL}` | **Resolved: the spelling was the problem.** The web client calls `/charts/{SYM}/daily?timeframe=1w\|1m\|3m\|ytd\|1y\|3y\|5y` — LOWERCASE, with `is_include_previous_historical=true` on `ytd` and `1w`. Every earlier probe sent an uppercase spelling (`1D`, `DAILY`, `TIMEFRAME_DAILY`) and was rejected, which is why the route looked real-but-unusable for months. Wired and covered by tests; a whole series now costs one request instead of the 12-row paged walk. |
| Screener | **Confirmed and wired.** Running a saved screen is a plain GET, not the POST an earlier pass assumed. Custom screens exist on the probed account and run. |

## Probed live on 2026-08-29

A second live pass, against a real account, with the market shut (Friday night WIB). 57 tools called
once each; key names recorded, values never. What it settled, and what it broke open:

### Settled — 19 tools moved from `projected` to `observed`

`company_subsidiaries` · `index_members` · `symbol_search` · `classification` ·
`corporate_actions` · `corporate_action_status` · `dividend_calendar` · `ipo_pipeline` ·
`insider_transactions` · `screener_favorites` · `screener_finitems` · `stream` · `news`

The bar was not "the route answered". It was: rows came back AND every field the tool names was read
out of them. `index_members` returning exactly 45 rows for LQ45 is the kind of agreement that settles
a mapping; a 200 with an empty page is not, and six tools that answered emptily stayed `projected`
(`company_contact`, `stream_pinned`, `prices_batch`, `broker_activity`, `research`, `calendar_today`).

`analyst_ratings` was promoted and then DEMOTED again before the commit. It returns two halves and
its own note said "neither response shape has been observed"; the probe found an array of three, and
nothing in that result says which half it was. A claim that cannot be told apart from the wrong claim
is not evidence.

### Broken, and not previously known to be

Every one of these is a live 4xx or a parse failure on the tool's own documented arguments. They are
NOT evidence problems — the mapping cannot be settled because the request never succeeds.

| Tool | What the server actually said |
|---|---|
| `earnings` | 400 `Page must be 1 or greater;SortColumn is a required field;Order is a required field;`. Supplying `sort_column`/`order` changes the error to `Your request is invalid`, so the NAMES are right and the values are not: `date`, `symbol`, `company_symbol`, `earnings_date`, `period`, `name` and `id` were all refused. The vocabulary is unknown. |
| `watchlist_search` | 400 `WatchlistID is a required field;` — the tool takes only `keyword` |
| `order_queue` | 400 `Stock code is required` — with `symbol` supplied, so it is not being forwarded |
| `shareholding` | 400 `Invalid company id`. Re-probed with the ticker as a PATH SEGMENT (the route is `/insider/shareholding/companies/:symbol`) and it still refuses, so the segment wants a numeric company id and a symbol→id resolution step is missing. |
| `underwriters` | 404 `Unrecognized Command`, bare and with `{page,limit}` and `{symbol}` alike. `/order-trade/underwriters` does not exist. |
| `price_market` | 400 `Silahkan Periksa permintaan`, and still 400 when re-probed correctly against `pricesMarket` with the `:symbol` segment and with/without `date`. Which parameter it wants is unknown. |
| `shareholders` | PARTLY FIXED. The token endpoint answers `{"message":"Successfully retrieved Token","data":{"value":"<64 hex>"}}` — the token sits under `value`, which no `/token/i` key search can find, and `message` is the only string that mentions the word. Reading `data.value` on this one route settles the mint. The chart call behind it then fails differently: `rpc error: code = Unauthenticated desc = WebViewToken.FromContext: User Not Found`. How the minted token must be presented is still unknown, so the tool stays `projected`. |
| `chart_series` | schema drift: points carry no recognisable close field. Keys present: `date`, `formatted_date`, `xlabel`, `value`, `percentage`, `change`, `open`, `high`, `low`. `raw: true` succeeds |

Three more that are not errors but are not right either:

- **`stream_user` names 1 of 60 wire keys.** `src/core/stream.ts:127` says four named fields are the
  design; this route delivers one. The `/stream/non-login/user/:username` envelope differs from the
  others and the projection does not reach it.
- **`broker_flow_intraday` returns 1.1 MB** of unprojected payload. Not a mapping fault — it is
  `getRunningTradeChart` returning what it is asked for — but it is a tool result a model is meant
  to read, and 1.1 MB is not readable.

RETRACTED, and left here rather than deleted: an earlier pass recorded `brokers` and `broker_top` as
returning ~53 KB while reporting `count: 0`. That was wrong, and the fault was in the probe, not the
server — a provenance extractor that took the first `count` it found at any depth rather than the
one on the result. Checked directly, `brokers` maps 112 rows and `broker_top` maps 89, both with
`readFrom` populated. Both are now `observed`.

### Fixed in the same pass

| Tool | What was wrong | How it was settled |
|---|---|---|
| `order_queue` | sent `symbol`; the endpoint wants `stock_code` | `symbol`, `code`, `emiten_code`, `stockCode` and `company` each returned 400 "Stock code is required"; `stock_code` answered. The tool had never once returned data. |
| `chart_series` | no `close` key on the wire, so the whole series was refused | the daily route carries the price in `value`. Proven by arithmetic on the payload rather than by assumption: a BBRI point read `value: "2930"`, `change: -20`, `percentage: "-0.68"`, and 20/2930 = 0.68%. |
| `chart_series` | flat candles with NO warning | open/high/low/volume arrive as EMPTY STRINGS. The keys are present, so `unmapped` stayed clean and the flat-candle warning never fired, while `numberish("")` returned null and every bar silently took its close for all three. A field that reads null on every row now counts as flat. |
| `stream_trending` | dropped `date`, which the endpoint REQUIRES | 400 "Silakan periksa konten anda" without it, and 400 to `{page, limit}` too — only a date makes the route reply. An omitted date now defaults to today in WIB, which is what "trending" means when nobody named a day. Returns 30 posts. |
| `stock_conversion` | sent no paging, and the endpoint has no default | 400 "Page is a required field;Limit is a required field;". Both are now defaulted (page 1, limit 20) rather than made mandatory on the tool: a caller asking a company for its conversions should not have to know the API needs paging to answer at all. |
| `stream_user` | named 1 of its 4 fields | `/stream/non-login/user/:username` spells them `postid`, `created` and a FLAT `username`/`fullname`, where the per-symbol route uses `stream_id`, `created_at` and a nested `user`. All four now map. |

Four more tools moved to `observed` on the strength of these: `brokers`, `broker_top`,
`chart_series` and `stream_user` — 18 in total across the day.

`order_queue` stayed `projected` on purpose. The route is proven and the request is now correct, but
it answered `{"orders": [], "is_open_market": false}` with the market shut, so no row ever exercised
the mapping. A working request is not a settled field map.

### Blocked, and by what

- **The trading host — still nothing observed.** Needs the six-digit PIN at the account owner's own
  terminal. Nine reads returned the same honest auth refusal.
- **e-IPO — `eipo_list`, `eipo_price_groups`, `eipo_rdn_balance` all 404 `Unrecognized Command`.**
  The routes are wrong. The browser's own traffic during login named the real ones:
  `GET /eipo/social/company/list?filter=ongoing`, `GET /auth/eipo/webview/link` and
  `POST /partner/eipo/access_token`, all on `api-sekuritas.stockbit.com`.
- **The six intraday feeds** — the market was shut. An empty tape settles nothing.

### Two defects in the login path itself, found by using it

1. **`bin/stockbit-auth.ts` opened `https://stockbit.com/trade` for the browser trading login.**
   That path is a Stockbit *username* route, so it lands on a profile page and the PIN form is never
   shown. Reported by the account owner, who read the page.

   There is **no trading page to open instead** — confirmed by the same account owner: the PIN
   prompt is a MODAL raised by clicking buy or sell, anywhere on the site. Any URL here would have
   been wrong again, so the command opens the site and says what to click.
2. **The already-signed-in harvest tier was slot-blind.** `harvestFromBrowser` reads
   `credentialStorage` — the stockbit.com web session, a market-data credential by construction —
   and `accept()` wrote it to whatever slot was asked for. `trading-login --browser` therefore stored
   a MAIN token in the SECURITIES slot and printed "Trading session captured"; only the test refresh
   afterwards produced the 401. The `slot` guard was one-directional. Fixed, and pinned by a test.

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

### e-IPO — a whole host, and a session nobody has minted

`api-sekuritas.stockbit.com` is the third token domain and the least observed of the three. Its
session is derived from the ordinary market-data login through a webview grant, and neither half of
that exchange has been captured:

| | What is guessed | How it fails |
|---|---|---|
| The webview grant | `GET /auth/eipo/webview/link` is searched for a token-shaped field, then for a URL with one in its query string. | No grant found → an auth error naming `stockbit-auth login`. Loud. |
| The exchange body | `POST /partner/eipo/access_token` is sent `{token, access_token}` — both spellings, because an extra field is more likely to be ignored than a missing one is to be defaulted. | A 400. Loud. |
| The subscription body | `{emiten_code, price, lot}`. Lots, not shares — which is the opposite of the exchange orders, and is how every Indonesian e-IPO flow expresses a subscription. | A 400 on the first attempt. |
| The verify verdict | `POST /eipo/order/verify` is read for a boolean under valid / is_valid / success / eligible / can_order / verified, then for a message that names a refusal. | Unreadable is treated as `unverified`, NOT as a no — otherwise an unrecognised response would make subscription impossible for a reason unrelated to the subscription. |
| Allotment fields | `allotment_lot` / `allotted_lot` / `result_lot` and their share and amount forms. | Absent means allotment has not happened; the tool description says to report that rather than zero. |

**The first real subscription is a live gate**, same shape as the exchange one: capture a HAR of the
web e-IPO flow first, then subscribe for the minimum lot on an open offering with the user watching,
then read `eipo_my_order` and the mutation log together.

### Watchlist and screener edits

Every one of these is verified by reading the account back, so a wrong body shape shows up as
`not-visible` rather than as a false success. What is not known:

| | What is guessed | How it fails |
|---|---|---|
| `POST /watchlist` body | `{name, description}` | The list does not appear on the re-listing → `not-visible`. |
| `PUT /watchlist/:id` body | `{name}` | The name does not change → `not-visible`. |
| `POST /watchlist/:id/company/item` body | `{company_id}`, resolved from the ticker through the quote endpoint | The symbol is not in the list afterwards → `not-visible`. |
| `POST /screener/templates` with `save: "1"` | That `"1"` is what persists, against the `"0"` that does not. `"0"` IS observed; `"1"` is inferred from the same bundle reducer. | Nothing new appears on the template listing → `not-visible`. |
| `POST`/`DELETE /screener/favorites` body | `{template_id}` | The `favorite` flag on the listing does not change → `not-visible`. |

`screener_save` refuses a name that already exists rather than posting it, because whether Stockbit
replaces or duplicates has not been observed and those are very different outcomes for someone who
curated a screen. That refusal can be relaxed once one save over an existing name has been watched.

### The market-data read families

The 2026-08-24 expansion wired around fifty new exodus routes read out of Stockbit's web bundle
rather than probed one at a time. Most answer plainly and their shapes are ordinary; a minority have
**never been seen return a row**, and those are handled differently from everything else in this
document.

Where a market-data route is unobserved, the module returns **the raw row** beside the one or two
fields it is willing to claim it recognised, with `readFrom` naming the wire key each came from and
`unmapped.sampleKeys` listing what the row actually contained. A wrong guess therefore shows up as
`code: undefined` next to a visible raw row — never as a confident wrong value, and never as a key
that is always undefined. That is the opposite of the rule the account modules follow, and the
reason for the difference is the same one in both directions: here an unmapped field is a metric
nobody has named yet, and hiding it loses information.

The tools say so themselves. Every one whose route is unobserved carries `PENDING VERIFICATION` in
its description, and the modules say it in their doc comments — `grep -rn "not been observed" src/`
is the current list, which is better than a copy here that would go stale. The families carrying
most of them are the broker directory and league table (`src/core/brokers.ts`), parts of market
internals (`src/core/market.ts`), the comparison and fundachart routes
(`src/core/fundamentals.ts`), and the research feed.

**How to settle any of them:** call the tool once against a live session and read `unmapped.sampleKeys`
off the result. One call per route, and the projection's candidate list is the single edit.

---

## The auth work of 2026-08-26 (ADR-0009)

Five things that pass their tests and are still not *measured*. Each says what would settle it, and
the one-line experiment is the point — none of these needs a rewrite, they need one live call.

### Whether a revoked session also kills its outstanding access tokens

**Unverified, and it is why a tool was NOT built.** `status` could prove a session live by spending
one GET on an already-cached access token — no refresh, no rotation, no cost to the website session.
That would be strictly better than `live: true`. But it only proves anything if revoking a session
also invalidates the access tokens minted from it, and nobody has watched that happen. A `check:
true` built on the assumption would report "your session works" from a token that outlived the
session it came from.

**To settle it:** log in, let the access cache fill, revoke the session from Stockbit's own web UI
("log out of all devices"), then issue one authenticated GET with the cached access token. If it
401s, the check is sound and worth building. If it succeeds, the answer is that access tokens
outlive revocation and `status` must keep saying so.

### Whether `iat` is present on Stockbit's refresh tokens

**Unverified.** `decideAdoption` in `src/auth/resync.ts` prefers `iat` when BOTH tokens carry one,
and falls through to `exp` when they do not. It is written that way precisely because nobody has
confirmed the claim exists — requiring it would have made the best rung unreachable, and asserting
it would have been a guess dressed as a rule.

**To settle it:** `stockbit-auth status --json` does not print claims, deliberately. Decode a stored
refresh token by hand once and look. If `iat` is always there, the `exp` rung becomes a fallback for
malformed tokens rather than the ordinary path.

### That `exp` orders issuance

**An inference, not a measurement**, and labelled as one in the code. What is Observed is that the
refresh token carries `exp` (`status` and `doctor` read it live) and that rotation issues a *fresh*
window (`doctor`: "it keeps sliding"). The step from "the window slides" to "a later `exp` means a
later issue" is reasoning, and it is the rung the resync leans on most.

**To settle it:** rotate twice in quick succession and compare the two tokens' `exp` values. If the
second is strictly greater, the inference holds for the case that matters.

### Whether `security` takes a prompted value from stdin everywhere

**Verified on macOS 26 at every write, and deliberately not trusted beyond that.** `security
add-generic-password -w` prompts twice — for the value and for a retype — and reads both from the
pipe. Feeding it once exits 0 and stores an EMPTY STRING, which is why the write reads the value
back before keeping it and falls back to the `argv` form when it does not match.

The residual unknown is which macOS versions behave differently, and the answer is reported rather
than assumed: `stockbit-auth doctor` says which mechanism ran. A "Keychain write" row reading
*"`security` would not take the value on stdin here"* is the fallback in use, and worth an issue with
the macOS version attached.

### The refresh lock across two `$TMPDIR` values

On the Keychain backend the lock now lives under `os.tmpdir()`, because the credential itself is
machine-global and a lock under `$STOCKBIT_STORE_DIR` let two clients take different locks over one
credential. Every client that matters inherits the user's `$TMPDIR` — but a process launched from a
context with a different one (a system daemon, some CI runners) would take a different lock. Strictly
narrower than the hole it replaces, and unmeasured beyond that.

**To settle it:** print `os.tmpdir()` from each client that runs this server on the same machine.

