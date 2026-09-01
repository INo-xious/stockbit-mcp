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
| `shareholding` | **FIXED 2026-09-01.** Was 400 `Invalid company id`: the segment wants Stockbit's numeric company id, not a ticker. `getShareholdingCompanies` now resolves the ticker through `resolveCompanyId` (the reader `watchlist_add` already used) and the route segment is `:companyId`. Verified live — `/insider/shareholding/companies/134` for DEWA answers `Successfully fetched holders by company id`, with the list under `holders`. Only `mode=companies` is settled; `investors`, `network` and `ownership_composition` are still unprobed, so the tool stays `projected`. |
| `underwriters` | 404 `Unrecognized Command`, bare and with `{page,limit}` and `{symbol}` alike. `/order-trade/underwriters` does not exist. |
| `price_market` | 400 `Silahkan Periksa permintaan`, and still 400 when re-probed correctly against `pricesMarket` with the `:symbol` segment and with/without `date`. Which parameter it wants is unknown. |
| `shareholders` | PARTLY FIXED. The token endpoint answers `{"message":"Successfully retrieved Token","data":{"value":"<64 hex>"}}` — the token sits under `value`, which no `/token/i` key search can find, and `message` is the only string that mentions the word. Reading `data.value` on this one route settles the mint. The chart call behind it then failed differently: `rpc error: code = Unauthenticated desc = WebViewToken.FromContext: User Not Found`. **FIXED 2026-09-01, and promoted to Observed.** First narrowed by probing — the same 401 came back with a valid minted token, with no `token` parameter, and with `token=notarealtoken`, so no VALUE could fix it — then settled by driving a real browser over CDP and recording what Stockbit's own client sends: `Authorization: <the 64-hex minted token>`, RAW with no `Bearer` prefix and in place of the session bearer, and `?symbol=…&value_year=…&shareholder_type=…` with no token parameter at all. A new auth kind (`webviewToken`, placement `rawHeaderToken`) carries it; the route is the only one that uses it. Two further defects fell out of the first working response: `value_year` is a WINDOW LENGTH IN MONTHS, not a calendar year (12 → 13 monthly points, 36 → 37), where it had been validated as a year between 1990 and 2100; and the payload is SERIES rather than rows, so it is now projected into `series`/`timeframes`/`lastUpdate` instead of reporting `rows: []`. |
| `trade_book` | **FIXED 2026-09-01.** Was 400 `Group by is required` for every argument combination, because no `group_by` parameter existed anywhere in the tool or the core function. The key really is `group_by`: `1` and `2` are accepted, `0` reads as absent (same 400) and `3` answers `Your request is invalid`. `group_by=1` returns `data.book[]` grouped by price — each row carrying `price` and `buy`/`sell`/`pre_open`/`post_close`/`total` blocks of `lot`, `frequency`, `percentage`, `value`, `value_percentage` — beside `market_hour_steps`, `book_total`, `date`, `from`, `to`, `previous_price`. What distinguishes `2` is not established (it answered with an empty `book` outside session hours), so no meaning is documented for it. |
| `broker_flow_intraday` | **SETTLED 2026-09-01, and promoted to Observed.** Its docstring disclaimed knowing whether the endpoint broke the session down by broker, by price level or by side. It is by BROKER and by MINUTE: `data.price_chart_data` held 335 one-minute points spanning 09:00–16:14, and `data.broker_chart_data` held two series, `TYPE_CHART_VALUE` and `TYPE_CHART_VOLUME`, each with a `brokers` code list and `charts: [{broker_code, chart[]}]` on the same grid — five brokers, so it is the session's main participants rather than the whole market. Also `from`, `to`, `data_last_updated`, `date_session_info`. |
| `chartbit_drawings` | **FIXED 2026-09-01.** Was 400 `Silahkan Periksa permintaan` for every form tried. Two causes, both ours. (1) The `layoutId` transport segment was validated as `numericId` while real layout ids look like `53e5877c-…-3355424`, so every route taking one was refused before the request was built. (2) The endpoint is addressed by the CHART's id, not the layout's, and nothing surfaced one — it is inside the layout, three objects deep. With both fixed, `layout_id` + the derived `chart_id` returns real drawings (3 line tools on one layout, 0 on another). Note the projected `type` came back `unknown` for all three, so the drawing-type mapping does not recognise what this account has drawn; `raw` carries the original. |
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

### `company_profile` percentages — and `symbol_search`'s row shape

Two things a live call must settle, both surfaced by the 2026-08-31 field report.

**`company_profile`.** A shareholder block was reported as
`{name, value: "3.24 M", percentage: "<0.0001%"}`, and the arithmetic disagrees: 3,242,500 of
40.69 B is 7.9688e-5. That single observation fits two readings, and nothing here can choose between
them, so the body is passed through untouched and `src/core/company.ts` records why.

| | What is guessed | How it fails |
|---|---|---|
| The unit of `"3.24 M"` | *miliar* (1e9) or *million* (1e6) | 1000× either way. `MAGNITUDES` in `src/live/promptspec.ts` already refuses a bare `"m"` for this reason. |
| What `percentage` means | A percent, or a fraction wearing a `%` | 7.9688e-5 is `<0.0001` as a FRACTION and `0.0080%` as a PERCENT, so "wrong by 80×" and "correct, differently scaled" are the same bytes. |
| Whether an unrounded count is there | A raw share count beside the rounded display string | Without one, any recomputation starts from 3,240,000 rather than 3,242,500 and is approximate before it begins. |

Until all three are captured, nothing computes a percentage. If one is ever added it must be a NEW
key naming both inputs, never a rewrite of the upstream field, and not inside `getCompanyProfile`,
which is ONE request by contract.

**`symbol_search`.** The row shape was never recorded, and the mapping was wrong. `/search/v2` rows
came back as `{id, name, desc, url}` — the ticker in `id` and in `name`, and `url` as
`symbol/<TICKER>` — with no `symbol` key at all, so the tool reported 8 of 8 rows ticker-less and
`symbols: []` on a query that matched eight emittens. Now read from the `symbol/<TICKER>` link, with
`readFrom` on each hit. What a live call should still confirm: whether any emitten row links by
something other than `symbol/<TICKER>`, and whether a ticker ever arrives lowercased.

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

---

## Probed live on 2026-09-01, ~18:15–18:55 WIB (P7a)

A third live pass, against a real account, on a **trading day after the ~18:00 WIB broker release**
and with the market shut. The timing is the point: it is the only window in which the R1/R2/R3
staleness question can be answered, and it settles the `MOVER_TYPE_*` vocabulary by echo rather than
by rows, which needs no open session at all.

Every row below is a transcript. Where a value was refused, the refusal is the finding.

### The `MOVER_TYPE_*` vocabulary — settled by echo, with a control

`/order-trade/market-mover` echoes `mover_type` back, so an accepted value returns as what was sent.
The decisive addition is a **deliberate nonsense control**: `MOVER_TYPE_DEFINITELY_NOT_REAL` answers
**400 `Your request is invalid`**. This endpoint therefore *rejects* unknown members rather than
silently falling back to its default — which is what makes every ACCEPTED verdict below evidence
rather than inference, and defeats this API's usual 200-with-the-default failure mode.

| Member | Verdict |
|---|---|
| `MOVER_TYPE_TOP_VALUE` | **ACCEPTED** — echoed verbatim |
| `MOVER_TYPE_BIG_MONEY_NET_VALUE` | **ACCEPTED** — echoed verbatim (was bundle-only until now) |
| `MOVER_TYPE_TOP_GAINER` | **ACCEPTED** — echoed verbatim |
| `MOVER_TYPE_TOP_LOSER` | **ACCEPTED** — echoed verbatim |
| `MOVER_TYPE_TOP_VOLUME` | **ACCEPTED** — echoed verbatim |
| `MOVER_TYPE_TOP_FREQUENCY` | **ACCEPTED** — echoed verbatim |
| `MOVER_TYPE_NET_FOREIGN_BUY` | **ACCEPTED** — echoed verbatim |
| `MOVER_TYPE_NET_FOREIGN_SELL` | **ACCEPTED** — echoed verbatim |
| `MOVER_TYPE_IEP_IEV` | 400 |
| `MOVER_TYPE_IEPIEV`, `_IEV`, `_IEP`, `_IEP_IEV_DETAIL`, `_INDICATIVE`, `_INDICATIVE_EQUILIBRIUM`, `_PRE_OPENING`, `_PREOPENING`, `_IEP_CHANGE`, `_TOP_IEP` | 400, all ten |
| `MOVER_TYPE_TOP_FREQ`, `_FOREIGN_BUY`, `_FOREIGN_SELL`, `_TOP_GAINERS`, `_TOP_LOSERS` | 400 — near-miss spellings, recorded so nobody re-guesses them |

**Eight members are settled. The IEP/IEV tab has no `mover_type` and must not be given one.**

### IEP/IEV is a FIELD, not a view

`iepiev_detail` is carried on **every row of every view**:
`{iep, iev, ieval, iep_change, iep_change_prev, iep_price_diff, iep_prev_price_diff}`, each a
`{raw, formatted}` pair. On this reading every value was `0`/`"-"`, which is expected: IEP/IEV is the
indicative equilibrium price computed during **pre-opening (08:45–09:00 WIB)** and there is none
outside it.

So the UI's eighth tab is reachable by projecting a field, not by requesting a view. That closes the
"all eight tabs" goal without shipping a guessed enum member.

### `market-mover` shape and paging

| | |
|---|---|
| Row container | `data.mover_list` — **50 rows with the market shut** |
| Row fields | `stock_detail{code,name,icon_url,has_uma,notations,corpaction}`, `price`, `change{value,percentage}`, `value{raw,formatted}`, `volume{raw,formatted}`, `frequency{raw,formatted}`, `net_foreign_buy`, `net_foreign_sell`, `net_buy`, `net_sell`, `iepiev_detail`, `big_money_net_value`, `buy_value_percentage`, `sell_value_percentage`, `big_money_buy_value_percentage`, `big_money_sell_value_percentage`, `bid_percent`, `catalog_detail`, `market_cap` |
| `limit` | **HONOURED.** `limit=5` → 5 rows; `limit=100` → 50, so 50 is the ceiling |
| `page`, `per_page` | **IGNORED.** `page=1` returns the same 50 rows |
| `data.pagination` | **DEAD.** Always `{page:0, limit:0, has_next:false, has_prev:false}` regardless of what is sent. It must be reported absent, never projected as meaningful — a `has_next:false` that is always false is not an answer about paging |
| Provenance | `mover_type` (echo), `is_show_net_foreign`, `net_foreign_updated_at`, `net_foreign_session_info{raw,formatted,date,is_last_session}` |

`market_cap` came back `null` on every row.

### R1 / R2 / R3 — the post-18:00 adjudication. **All three roll forward. Not staleness.**

The report asked whether these serve a stale date. Measured after the broker release on the same
trading day, every one of them serves **today**:

| Route | What it said |
|---|---|
| `runningTrade` (`symbols=BBRI&order_by=1`) | `data.date = "2026-09-01"` — today |
| `runningTradeChart` (broker_flow_intraday) | `from = to = "2026-09-01"`, `date_session_info = "1 Sep 2026"` — today |
| `marketMover` | `net_foreign_updated_at = "2026-09-01"`, `net_foreign_session_info.date = "2026-09-01"`, `is_last_session = true` — today |
| `marketMover` | `is_show_net_foreign = **true**` — the field report saw `false` intraday |

**This settles the reclassification.** R1, R2 and R3 are *documentation* items, not staleness bugs:
the data is correct and fails to announce which session it is from. `is_show_net_foreign` flipping
false→true across the release is the mechanism, observed on both sides.

`brokerDistribution` already carries `date_info`, `start_date` and `end_date`; `brokerTop` carries
`data.date{from,to,idx}`; `brokerActivity` carries `from`/`to`. Three of the four payloads that need
a `dataAsOf` already contain one.

### NEW, not in the report: `data_last_updated` is WIB stamped as UTC

`runningTradeChart` returned `data_last_updated = "2026-09-01T16:28:44Z"`. At the moment of the call
it was **11:28 UTC**, so a `Z` timestamp of 16:28 is five hours in the future. 16:28 **WIB** is
minutes after the 16:15 close, which is the only reading that makes sense. The `Z` suffix is wrong.

Anything that parses this field as UTC gets a timestamp five hours ahead of reality. It is the same
class as the mixed units in cross-cutting observation 3, and it should be read as WIB and re-stamped,
or surfaced verbatim with the discrepancy named — never parsed as the `Z` claims.

### D5 — the hotlist universe. **Nine symbols, and `limit` does nothing.**

`/emitten/hotlist/topgainer` at `limit` = 5, 25, 50 and 100 returned the **same nine rows every
time**: `SOTS, APLI, KOBX, BOBA, ENAK, DIVA, UNIC, DFAM, HBAT`.

So `limit` is ignored *and* the universe is nine. This confirms the plan's second correction: the
report's "not ranking by change" reading is wrong — a contiguous descending sort over nine symbols is
what a correct ranking over a nine-symbol universe looks like. There is no sort bug to fix; the tool
must state its universe.

For contrast, `market-mover`'s `MOVER_TYPE_TOP_GAINER` returned 50 rows whose codes include
structured warrants (`ELSAZPCF7A`, `MAPIHDCZ6A`, `ACESDRCU6A`). **The two tools serve genuinely
different universes**, which is the repo's existing position on them and is now measured.

### D7 — `prices_batch` is not a batch endpoint

| Request | Result |
|---|---|
| `stock_code=BBRI` | 200, `data.prices` = **array(20) of bare numbers** (`[3280, …]`) |
| `stock_code=BBRI,BBCA,TLKM` | 200, `data.prices` = **array(0)** |
| `stock_code=BBRI&stock_code=BBCA&stock_code=TLKM` | **400 `too many values for field "stock_code"`** |
| `stock_code[]=…` (repeated) | **400 `too many values for field "stock_code"`** |
| `symbols=BBRI,BBCA,TLKM` | 400 `Silahkan Periksa permintaan` |
| `stock_code=BBRI\|BBCA\|TLKM` | 200, empty |

`/company-price-feed/prices` takes **one** `stock_code` and returns a **series of prices for it** —
not one last price per symbol. The repeated-key encoding the report proposed is explicitly refused,
so there is no encoding left to find. **The tool is built on a false premise**, and the honest fix is
to say the route is single-symbol rather than to keep returning an empty batch that reads as "no
prices".

### D9 — `price_market` cannot be called at all

`/company-price-feed/prices/BBRI/market` answers **400 `Silahkan Periksa permintaan` with no
parameters at all**, and with every one of: `market` = `REGULER`, `RG`, `regular`, `REGULAR`, `TN`,
`NG`, `CASH`, `ALL`, `MARKET_TYPE_REGULAR`, `MARKET_TYPE_ALL`, `BOARD_REGULAR`, `1`, `0`; and with
the keys `board`, `market_type` and `type`.

**This is not a vocabulary problem.** A bare call with no query at all is refused, so no argument
combination can fix it. The tool should say it cannot be called and point at `orderbook`'s
`market_data[]`, which already returns the per-board split.

### D10 — two chart routes, two vocabularies, and `1w` is the discriminator

| timeframe | `/charts/:symbol` | `/charts/:symbol/daily` |
|---|---|---|
| `1w` | **400 `Kurun waktu tidak valid`** | **200** |
| `1m`, `1d`, `3m`, `ytd`, `1y` | 200 | 200 |
| `1D`, `1W`, `1M`, `daily`, `weekly`, `5`, `15`, `60`, `1`, `D`, `W` | 400 | — |

The two routes also return **different shapes**. `/charts/:symbol` answers `{chart_points: []}` — a
near-empty container. `/charts/:symbol/daily` answers the rich payload the projection reads:
`prices`, `cagr`, `change`, `drawdown`, `markingpoint`, `percentage`, `timeframe`, `xaxisopt`,
`previous`, `line_weight`, `previous_timeframe_price`, `chart_type`, `interval_in_minutes`,
`allowed_chart_type`, `max_candles`.

That is the whole of D10, measured: `getChartRaw` reads `charts` while `getSeriesBars` reads
`chartsDaily`, and hands the first the second's vocabulary. `1w` → 400 and `1m` → empty are both
explained by the route being wrong, not the value.

### D11 — `broker_activity` has no `period`, and the row container exists without one

The control is what settles it:

| Call | Result |
|---|---|
| `brokerDistribution` + `period=TB_PERIOD_LAST_1_DAY` | **200** |
| `brokerActivity` + `period=TB_PERIOD_LAST_1_DAY` | **400** |
| `brokerActivity` + all ten `BROKER_PERIODS` members | **400**, every one |
| `brokerActivity` + `period=TB_PERIOD_DAILY`/`_1D`/`_ONE_DAY`/`_WEEKLY`/`_MONTHLY`/`DAILY`/`1D`/`daily` | **400**, every one |
| `brokerActivity` + **no** `period` | **200, with rows** |
| `brokerActivity` + `tb_period`/`periode`/`range`/`time_period` | 200 — unknown keys are silently ignored, so the 400 on `period` is a *validated* field refusing a value, not an unknown one |

The same member that its sibling accepts is refused here. **`broker_activity` must stop sending
`period`** and say the endpoint has no period filter; its window is fixed and already reported.

Row container, from a call with no `period`:
`data` = `{broker_activity_transaction, from, to, broker_code, broker_name}`. So
**`broker_activity_transaction` belongs in `ROW_CONTAINERS`**, and `from`/`to` give the result its
provenance for free.

### D12 — `broker_top`: `limit` ignored, sorted ASCENDING, and the report's dead fields are alive

| | |
|---|---|
| Row container | `data.list` — **89 rows** bare, at `limit=3` and at `limit=5` alike. `limit` is ignored |
| Sort | **ASCENDING by `total_value`**, verified across all 89: first `22,485,000`, last `5,636,360,451,396`. The tool documented as "which brokers moved the most" puts the biggest broker last |
| `sort_by=total_value`, `sort_by=TOTAL_VALUE`, `order_by=desc`, `sort_direction=DESC` | 200 — accepted, and **none reversed the order** |
| `order=desc`, `sort=desc` | 400 — recognised fields refusing a value |
| Provenance | `data.date{from, to, idx}`, all `2026-09-01` |
| Row shape | `{code, name, investor_type, total_value, net_value, buy_value, sell_value, total_volume, total_frequency, group}` — **plain strings, not `{raw,formatted}`** |

**Correction to the report.** It records `net_value`, `buy_value` and `sell_value` as `"0"` on every
row and calls them three dead fields. On this reading all three carry **89 distinct values** —
e.g. first row `net_value: "-15025000"`, `buy_value: "3730000"`, `sell_value: "18755000"`. They are
populated and must not be reported absent. Whatever produced the zeroes was not the schema.

No `sort_by` value reverses the order, so the descending sort has to be done client-side and said so.

### D13 — `calendar_today` is buckets, and the first one is empty

`/corpaction` returned, in this order:

```
bonus: 0    dividend: 1    economic: 8    ipo: 0    pubex: 0    rightissue: 0
rups: 1     stock_reverse: 0    stocksplit: 0    tender: 0    warrant: 9
stock_dividend: 0    today: <string>
```

`rowsOf` (`src/core/corpaction.ts`) takes the **first** key whose value is an array of records.
`bonus` is first and empty, so it binds there and reports `rows: []` — while **19 real rows**
(dividend 1, economic 8, rups 1, warrant 9) go unread into `meta`. Exactly the reported defect,
reproduced from a capture.

`today` is present, so `date` can stop being `null`.

### P7g item 3 — the recovery path was driven against a live account, and it did not run

The attempt ADR-0011 has been waiting for. Run last, deliberately, because it breaks the session
everything else depends on; the store was backed up first and restored afterwards, and live calls
were re-verified working after the restore.

**Method.** The stored `main` refresh token was replaced with a well-formed but dead JWT (future
`exp`, nonsense signature, so it is STOCKBIT that rejects it rather than anything local), the shared
access cache was cleared, and the **built** server — the only entry point that calls
`armAutoRelogin()` — was started with `STOCKBIT_AUTO_RELOGIN=1` and no `STOCKBIT_NO_BROWSER`, then
asked for a quote over stdio.

**Result: the quote answered in 0.3 s and recovery never ran.** No browser opened, no 401 was
raised, and `access.enc` was still empty afterwards — so nothing refreshed.

**Why, and this is the finding.** `ensureFresh` has a **level three**
(`src/auth/session.ts`, `domain === "main" && slotState.forcedRefreshes === 0`) that adopts the
**browser's own access token** out of the web session before any refresh is attempted. With a live
browser session, a dead stored refresh token therefore produces no 401 at all — the request is
served from the browser's copy, which is exactly what that level was built to do.

So the window in which automatic recovery can fire is **narrower than "the credential died"**. All
three must hold at once:

1. the stored refresh token is rejected by Stockbit, **and**
2. the web session's ACCESS token is expired or unreadable, so level three declines — note it is
   skipped anyway once `forcedRefreshes > 0`, which is the path a real 401 takes, **and**
3. the web session's REFRESH token is still alive, because gate 4 requires
   `webSessionHealth().likelyValid === true` and that verdict is computed from the refresh token.

Conditions 2 and 3 are the interesting pair: the same artefact must be half dead and half alive, in
the right halves. That is a real state — a web session whose access token has aged out while its
refresh token has days left is ordinary — but it is not the state a tester lands in by killing the
stored credential, which is why this path has never been observed.

**What is therefore still unmeasured:** the harvest itself, and the ~3 s figure. This run did not
reach `attemptAutoRelogin`, so it neither confirms nor refutes it. ADR-0011 stays **Projected** on
the strength of this, and now says so with a reason rather than an absence.

**To settle it:** expire the web session's ACCESS token while leaving its REFRESH token alive, then
repeat the method above.

`scripts/probe-relogin.ts` is that harness, with the step. (An earlier note here named a
`scripts/p7-recovery-probe.mjs` "in the P7 worktree"; that file was never committed and does not
exist.) It has three modes — `inspect` changes nothing and reports which of the three conditions
hold, `stage` backs up the store directory first and then arranges all three, `restore` puts the
backup back. Between them, drive the BUILT server with `STOCKBIT_AUTO_RELOGIN=1`.

The step that had never been staged is condition 2, and the reason it is awkward is worth keeping:
`saveWebSession` guards against going backwards by comparing the incoming ACCESS token's expiry
against the stored one, and ageing out the access half is exactly a backwards write. Without
`{ allowOlder: true }` the save is a silent no-op, so the stage appears to succeed and changes
nothing.


---

## Probed live on 2026-09-01/02 (P8)

Read-only GETs through the route table, via `scripts/probe-route.ts`.

### D11 reopened — `broker_activity` HAS a window, and was dropping 1704 rows

Two findings, and the second was hiding under the first.

**The window.** The earlier D11 pass concluded "no period filter" and stopped. It was right about
the `period` KEY — 400 on all ten members, 400 on eight other spellings, and unknown keys answering
200-and-ignored, so no spelling of the name could ever work. But every probe in that table varied
the `period` key or its value. Nobody tried the form its sibling on the same path prefix accepts,
and which this route already **echoes back in every response**:

| Call | Result |
|---|---|
| `brokerActivity` + no dates | 200, `data.from` = `data.to` = today |
| `brokerActivity` + `from=2026-08-17&to=2026-08-21` | **200, echo moved to those exact dates**, 1034 buy rows vs 868 |
| `brokerActivity` + `from=2026-07-06&to=2026-07-10` | 200, echo moved again, rows' own `date` inside the window |
| `brokerActivity` + `date_from`/`date_to` | 200, **silently ignored** — fell back to today |
| `brokerActivity` + `from` alone | 200, `from`..today, honestly echoed |

So the window is choosable by date pair. `period` is now accepted and resolved locally into
`from`/`to`; the name is still never sent.

The local arithmetic was checked against Stockbit's own, by asking `broker_summary` — which resolves
the same names server-side and echoes the result:

| Period | Stockbit resolved to | This server |
|---|---|---|
| `LAST_7_DAYS` | 2026-08-26 .. 2026-09-01 | same |
| `LAST_3_MONTHS` | 2026-06-01 .. 2026-09-01 | same |
| `YEAR_TO_DATE` | 2026-01-**02** .. 2026-09-01 | 2026-01-**01** |

The YTD difference is the first *trading* day versus the first calendar day. It cannot move a
figure, and that was measured too: `from=2026-08-15` (a Saturday) and `from=2026-08-17` (the
Monday) returned byte-identical rows. Computing the first trading day would need a holiday table,
which this project refuses to hard-code.

**The dropped rows.** `data.broker_activity_transaction` is an **object** holding `brokers_buy` and
`brokers_sell`, not an array. The container lookup tests `Array.isArray`, so it matched nothing and
the tool returned `count: 0, rowsFrom: null` for YP on a session where the wire carried **868 buy
rows and 836 sell rows**. Naming the container in `ROW_CONTAINERS` — which the previous pass did —
could never have fixed it.

Both sides send POSITIVE figures, and the row shape is
`{stock_code, broker_code, type, date, value, lot, avg_price, freq, company_detail, nval_trend}`
with the four figures as **JSON numbers**, not the numeric strings `brokerTop` sends.

`broker_activity` moves to **observed**.

### `calendar_today` — the dated form is the same shape, and `today` echoes the request

`GET /corpaction?date=2026-08-28` answered with the **same twelve buckets** as the undated form,
that day's own rows (dividend 1, pubex 1, rups 1, warrant 1 — different from 2026-09-01's), and
`today: "2026-08-28"`.

Two things settled. The tool moves **projected → observed**: both wire forms it sends are now
measured, and `from`/`to` are never sent at all. And `today` **echoes the date requested** rather
than naming the server's current day — so comparing the two is a real detector for this family's
characteristic failure, answering a different question convincingly. The code previously recorded
this as unknown.

### The two calendar spellings ARE the path kinds

The open question was whether `tender`/`stock_reverse` name the same things as
`tenderoffer`/`reversesplit`. They do, and the service says so itself:

```
GET /corpaction/tenderoffer   -> data.{ tender }
GET /corpaction/reversesplit  -> data.{ stock_reverse }
```

It answers a request in the path vocabulary with a container named in the calendar vocabulary. That
justifies the translation `corporate_actions` now applies. Note the `tenderoffer` payload is also a
worked example of the **one-array** case: a single bucket beside no siblings, which is exactly the
rows-under-a-key shape `rowsOf` handles — so `bucketsOf`'s threshold of two is confirmed correct
rather than merely documented.

### Still open

- **P7f's absolute lag.** `top-stock` aggregates were measured *changing* continuously; how far
  behind the exchange they are was never established. Recorded in `docs/LIVENESS.md` as a known
  hole rather than left implicit.
- **`broker_top` date range.** It takes the ten-member enum and has no `from`/`to`. Given
  `brokerActivity` turned out to accept dates nobody had tried, this is the obvious next probe.

### P7g item 3 — SETTLED, and the answer is that recovery cannot fire (P8, 2026-09-01)

The third attempt, and the first to reach the state the previous two were blocked short of.
`scripts/probe-relogin.ts stage` produced all three conditions at once for the first time:

```
storedRefresh: present            (a well-formed but upstream-dead JWT)
accessHoursLeft: -1.0             -> browserAccessTokenUsable: false, so level three DECLINES
refreshHoursLeft: 162.2           -> likelyValid: true, so the relogin gate PASSES
readyToObserveRecovery: "yes — all three conditions hold"
```

Then the built server, `STOCKBIT_AUTO_RELOGIN=1`, no `STOCKBIT_NO_BROWSER`, asked for a quote.

**Result: a 401 in 1.8 seconds. No browser opened. Recovery did not run.**

Not for the previous reason. Level three declined exactly as intended, and Stockbit really did refuse
the stored credential — condition 1 and condition 2 both did their job. The refusal is structural,
and it is one layer lower than anyone had looked:

- `attemptAutoRelogin` has exactly ONE call site: `src/auth/session.ts`, inside `forceRefresh`'s
  `catch`.
- `forceRefresh` has exactly TWO callers, both in `src/http/client.ts`, and both run only on a **401
  response to an API request** — i.e. after a token was successfully obtained and then rejected.
- But `getJson` calls `credentialFor(route, …)` → `ensureFresh(domain)` **before** the fetch. With a
  dead stored refresh token and no usable browser access token, `ensureFresh` throws at level four.
  The request is never made, so there is no 401 response, so the retry branch never runs, so
  `forceRefresh` is never called, so `attemptAutoRelogin` is never reached.

**So automatic recovery can only fire when the stored refresh token still works well enough to mint
an access token that the API then refuses.** The ordinary "my session was revoked" case — the one
ADR-0011 is written for — fails in `ensureFresh`, where there is no recovery hook at all.

That is why three attempts have failed. The first two concluded "level three adopts the browser's
token, so no 401 is produced", which was true and hid this. Disabling level three did not reveal a
working recovery; it revealed that there was never a path to one.

**Not fixed here.** Moving the hook is a change to the auth failure path, it needs its own decision
record, and the point of this run was to measure rather than to redesign. What is now known, and was
not before: the fix is not "stage the conditions better", and ADR-0011's ~3 s harvest figure remains
unmeasured because nothing has yet reached the harvest.

The store was backed up before staging, restored afterwards, and the restore was proved with a live
call returning real broker rows — not merely with a file listing.
