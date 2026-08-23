# Stockbit API — Reverse-Engineered Reference

**Purpose:** Everything needed to build a read-only Stockbit MCP / CLI without re-deriving the
API surface. Mapped against the TradingView-MCP feature set for parity.

**Status:** Endpoints below are marked **[CONFIRMED]** (I called them, got 200, saw the body),
**[EXISTS]** (returned 400/param-error, so the route is real but params unverified), or
**[JS-ONLY]** (found in the web frontend bundle, not yet called).

**Last mapped:** 2026-08-02, against Stockbit Desktop v1.68.0 (build 20260724) + web app
(Next.js). Reviewer: Claude, driven by account owner Marvel Harisson on his own authenticated
session. All calls were read-only GETs.

> ⚠️ **No credentials are stored in this repo.** Auth is a per-user bearer token the user
> supplies at runtime (see [Auth](#auth)). Never commit a token; it grants full account access.

---

## 1. The app is Tauri, not Electron

Stockbit Desktop is a **Tauri** app (588 `tauri` strings in the binary; single 57MB Mach-O;
links system `WebKit.framework`, no bundled Chromium). **Consequence:** the Chrome DevTools
Protocol approach used by `tradesdontlie/tradingview-mcp` **does not apply** — Tauri on macOS
uses WKWebView, which speaks the Safari Web Inspector protocol, not CDP. `--remote-debugging-port`
does nothing.

**You don't need it.** The desktop and web apps are thin clients over a plain JSON REST API.
The MCP should be an **HTTP client**, not a browser-automation bridge. This is simpler and more
robust than the TradingView approach.

---

## 2. Hosts (from JS bundle `baseURL` assignments)

| Host | Role | Notes |
|---|---|---|
| `https://exodus.stockbit.com` | **Market data (DEFAULT)** | Everything in §4 lives here. Go backend, grpc-gateway style. |
| `https://api.stockbit.com/v2.5` | Legacy, version-gated | **AVOID.** Rejects with `"Silahkan update aplikasi kamu…"` (update-your-app). |
| `https://carina.stockbit.com` | **Stockbit Sekuritas**: portfolio, cash, orders, history | A **plain** `Authorization: Bearer <securities token>` — **not** `Authorization-Carina`, which this document claimed until it was checked against the current bundle (2026-08-24). |
| `https://api-sekuritas.stockbit.com` | e-IPO, smart orders | Its own token chain; see §3. |
| `https://trading.masonline.id` | Legacy MAS broker backend | Not used by this account. Deliberately absent from the route table. |

**Websockets (real-time — REST 404s for live data because it flows over WS):**
- `wss://ws3.stockbit.com/` — Primus (running trade, orderbook ticks)
- `wss://wss-trading.stockbit.com/ws` (append `?type=chart` for chart feed)
- `wss://ws-gen.stockbit.com/v1`
- `wss://wssocial.stockbit.com?wskey=<key>` — social stream

The real-time protobuf service is named `securities.transactional.datafeed.v1.Top20` (seen in JS)
— relevant if you later want live top-20 movers / running trade instead of the REST snapshot.

---

## 3. Auth

- **Scheme:** `authorization: Bearer <JWT>`. Only credential. **No cookies.**
- **Algorithm:** RS256 (asymmetric; server-signed, you can't forge — just carry the login's token).
- **Lifetime:** **24 hours** (`iat`→`exp`). Friendlier than typical 15-min tokens.
- **Payload (base64, readable):** `{data:{use,ema,ful,ses,dvc,uid,cou}, exp, iat, iss:"STOCKBIT", jti, ver}`.
  Carries username, email, full name, session id, device fingerprint, user id.
- **Required request headers** (match browser or some routes 400/403):
  ```
  authorization: Bearer <token>
  accept: application/json
  origin: https://stockbit.com
  referer: https://stockbit.com/
  user-agent: Mozilla/5.0 ... Chrome/150.0.0.0 ...
  ```
- **Refresh — TWO distinct token domains (confirmed via frontend source + live endpoint probes 2026-08-02):**
  - **Main/session token** (authorizes exodus market data — what this MCP uses):
    `POST https://exodus.stockbit.com/login/refresh`, header `Authorization: Bearer <refresh_token>`,
    **empty body**, response nested `{ data: { data: {...} } }`. Live probe with an invalid bearer
    returns `401 UNAUTHORIZED` (endpoint exists). Frontend: `post(q7 + "/login/refresh", null, {headers:{Authorization: Bearer <UR().refresh.token>}})`.
  - **Securities/trading token** (portfolio, orders — now used, see ADR-0004). Unlock chain:
    `GET exodus/sekuritas/auth/token` → `{login_token}` → `POST carina/auth/v2/login {login_token, pin}`
    → `{access_token, refresh_token}`. Refresh: `POST carina/auth/refresh` with a `{refresh_token}`
    **body** and no Authorization header — that is what Stockbit's own client does, and it is the one
    thing about this chain that differs from the main session. `POST carina/auth/pin/validate
    {pin, purpose}` exists for actions that demand the PIN again.
  - **e-IPO token** (`api-sekuritas`): `GET exodus/auth/eipo/webview/link` → the grant in that link →
    `POST sekuritas/partner/eipo/access_token` → `{access_token, refresh_token}`. Refresh:
    `GET sekuritas/partner/refresh_token?token=` — the credential goes in the **query string**, with
    no header at all. Minted automatically from the main login; needs no PIN.
  - **Cloudflare Turnstile:** a `403` carrying the response header `cf-mitigated: challenge` is a
    browser challenge, **not** an entitlement problem and **not** a wrong PIN. Saying so matters: the
    natural response to "403 on a PIN login" is to retype the PIN, which is useless and is how an
    account gets locked. The optional request header `X-Force-Challenge: true` triggers one
    deliberately.
  - **Still unverified** (needs one real refresh with a valid token): success-response field names and
    whether the refresh token rotates. `src/auth/session.ts::parseRefresh` handles both defensively.
- **Login (JS-ONLY, reCAPTCHA-gated — do NOT automate):** `/auth/v2/login`, `/login/v3/username/browser`
  (body `{user,password,verification_token,recaptcha_version,player_id}`).

**MCP token handling rules (bake in from day one):** read token from env or OS keychain; never
write plaintext to disk; **redact it from every log line and error/stack trace** (the #1 real-world
leak vector).

---

## 4. Endpoints (all on `exodus.stockbit.com` unless noted)

Symbol convention: most market endpoints take the **ticker** directly (`BBRI`), *not* a numeric id.
Exceptions that need numeric ids: `/orderbook/{orderbookid}`, `/watchlist/{watchlist_id}`.
Resolve ids via `/emitten/{SYMBOL}/info` (returns company `id`) — see resolver note in §5.

### 4a. Broker summary + bandar detector — THE core feature [CONFIRMED]
```
GET /marketdetectors/{SYMBOL}
    ?transaction_type=TRANSACTION_TYPE_NET
    &market_board=MARKET_BOARD_REGULER
    &investor_type=INVESTOR_TYPE_ALL
    &limit=25
    &period=BROKER_SUMMARY_PERIOD_LATEST
```
`{SYMBOL}` may be a stock (`BBRI`) or index (`IHSG`, returns empty broker arrays).
**⚠️ `limit=25` truncates** — response `bandar_detector.total_seller` can exceed 25. Raise limit.

**Response:** `data.broker_summary.{brokers_buy[], brokers_sell[]}`, plus `data.bandar_detector`,
plus `data.from` / `data.to` (the session date, e.g. `2026-07-31`). `PERIOD_LATEST` = last
**completed** session — i.e. "previous day", exactly the semantics needed for the alert use-case.

**Broker row fields (units VERIFIED arithmetically):**
| Field | Meaning |
|---|---|
| `netbs_broker_code` | Broker code (`XL`, `XC`, `YU`, `CC`, …) |
| `blot` / `slot` | **Net lots** (sell negative) |
| `bval` / `sval` | **Net value, IDR** (sell negative). Check: `lots×100×avgprice ≈ bval` ✓ |
| `blotv` / `slotv` | **Gross shares** (÷100 = gross lots) |
| `bvalv` / `svalv` | **Gross value, IDR** |
| `netbs_buy_avg_price` / `netbs_sell_avg_price` | Broker's avg price |
| `type` | `Asing` (foreign) / `Lokal` (local) / `Pemerintah` (govt) — free foreign-flow signal |
| `freq` | Transaction count |
| `netbs_date` | `YYYYMMDD` |

**`bandar_detector` (Stockbit's precomputed read):** `broker_accdist` ("Acc"/…), `number_broker_buysell`,
`total_buyer`, `total_seller`, `value`, `volume`, `average`, and `avg`/`avg5`/`top1`/`top3`/`top5`/`top10`
each `{accdist:"Big Acc"|…, amount, percent, vol}`.

**Enum values** (confirmed = ✓, rest inferred from protobuf naming — verify before relying):
- `transaction_type`: `TRANSACTION_TYPE_NET` ✓ · likely `_BUY`, `_SELL`
- `market_board`: `MARKET_BOARD_REGULER` ✓ · likely `_NEGOTIATED`, `_CASH`. **Use REGULER** for
  bandarmology (negotiated block trades distort accumulation signals).
- `investor_type`: `INVESTOR_TYPE_ALL` ✓ · `_FOREIGN` · `_DOMESTIC`
- `period` [**CORRECTED 2026-08-09, live**]: date-range variants **do** exist. A previous revision of
  this document said only `_LATEST` and `_UNSPECIFIED` were accepted and that "there are no
  date-range period variants"; `docs/CAPABILITY-RESEARCH.md` disagreed, and **the research doc was
  right**. The earlier sweep tested plausible-sounding names (`_TODAY`, `_1W`, `_YTD`, `_ALL`, bare
  forms) and none of them happen to be the real spellings, which is how a wrong conclusion survived
  sixteen probes.

  Measured, with the window each returns:

  | value | | `data.from` → `data.to` |
  |---|---|---|
  | `BROKER_SUMMARY_PERIOD_LATEST` | ✅ | last session only |
  | `BROKER_SUMMARY_PERIOD_UNSPECIFIED` | ✅ | identical to `_LATEST` |
  | `BROKER_SUMMARY_PERIOD_YESTERDAY` | ✅ | the session before |
  | `BROKER_SUMMARY_PERIOD_LAST_7_DAYS` | ✅ | 2026-08-01 → 2026-08-07 |
  | `BROKER_SUMMARY_PERIOD_LAST_3_MONTHS` | ✅ | 2026-05-07 → 2026-08-07 |
  | `BROKER_SUMMARY_PERIOD_YEAR_TO_DATE` | ✅ | 2026-01-02 → 2026-08-07 |
  | `BROKER_SUMMARY_PERIOD_LAST_30_DAYS` | ❌ 400 | |
  | `BROKER_SUMMARY_PERIOD_LAST_1_DAY` | ❌ 400 | |

  This is a real capability, not a spelling note: the server aggregates net broker flow across the
  whole window in **one request**, so "who accumulated year to date" costs the same as "who bought
  today" and needs no dates computed client-side.
- `transaction_type` [**CORRECTED 2026-08-09, live**]: `TRANSACTION_TYPE_NET` ✓ and
  `TRANSACTION_TYPE_GROSS` ✓ — and they genuinely differ (BBRI top buyer ZP: 801,071 lots net vs
  938,193 gross). `_BUY` and `_SELL` **400**; they never existed. Every response already carries
  both sides as `brokers_buy` and `brokers_sell`.
- `market_board` [**CORRECTED 2026-08-09, live**]: `MARKET_BOARD_REGULER` ✓ `_ALL` ✓ `_NEGO` ✓
  `_TUNAI` ✓. `_NEGOTIATED` and `_CASH` **400** — those were English translations of the board
  names, not the board names. Note the prefix differs from broker *distribution*, which uses
  `MARKET_TYPE_` for the same four boards.

#### Date ranges — `from` / `to` [CONFIRMED 2026-08-03, live]

```
GET /marketdetectors/{SYMBOL}?...&from=2026-07-28&to=2026-08-01     # NO period parameter
```

> ⚠️ **`period` and `from`/`to` are mutually exclusive, and violating that fails silently.** If
> `period` is present the dates are ignored and the API returns **HTTP 200 with the latest session**.
> A caller asking for last week receives today's numbers with no error. Omit `period` entirely when
> sending dates.

Verified behaviour:

| Input | Result |
|---|---|
| `from`+`to`, `YYYY-MM-DD`, no `period` | ✅ real range; `data.from`/`data.to` echo it back |
| `from`=`to` | ✅ that single session — the way to query one historical day |
| `from` alone (or `to` alone) | ⚠️ **200, latest session** — the lone date is silently ignored |
| `date_from`/`date_to`, `start_date`/`end_date`, `start`/`end` | ⚠️ **200, latest session** — names ignored |
| `20260728` (compact) or `2026/07/27` (slashed) | ❌ `Please check your request` |
| `from` > `to` | ❌ `The Start date must be earlier than the End date` |
| future range | ✅ 200, empty broker arrays |
| span | **no server limit found** — 7d, 30d, 90d, 180d, 365d, 730d and 1825d all served in one request |

**Aggregation is server-side and is a true net.** For 2026-07-28→08-01 on BBRI, only 1 of the top 8
brokers matched the sum of their daily *buy-side* rows, and the range value was consistently lower —
the signature of a broker's buy days being netted against their sell days. The one exact match (BB)
never appeared on the sell side. So there is **no need to loop day-by-day and no client-side
weighting to do**: one request returns the aggregate.

Rows in a range response carry `netbs_date` equal to the range **start**, not one row per day —
there is no per-day breakdown in a ranged response.

Non-trading days (weekends, holidays) return `200` with empty `brokers_buy`/`brokers_sell`. That is
normal, not an error.

### 4b. Quote + resolver [CONFIRMED]
```
GET /emitten/{SYMBOL}/info      → company id, name, last price, change, exchange,
                                   inline best bid/offer {price,volume}, followers…
GET /emitten/IHSG/info          → index snapshot (same shape)
```
This is the **symbol→id resolver** (`data.id`, e.g. BBRI=59) and a lightweight quote in one call.

### 4c. Top gainers / losers / most active [CONFIRMED — path & 200; body empty after-hours]
```
GET /emitten/hotlist/{type}?limit=N     type ∈ topGainer | topLoser | mostActive
```
Maps to TV-MCP `top_gainers` / `top_losers`. Returns `[]` when IDX is closed (verify during session).

### 4d. Trending [CONFIRMED]
```
GET /emitten/trending    → 25 stocks; rich rows incl symbol, last, change, percent,
                           company_id, tradeable, day_trade_info, margin_info, icon_url
```

### 4e. Intraday minutely prices [CONFIRMED]
```
GET /company-price-feed/prices/close?symbol={SYMBOL}&interval=1
    → data[0].prices = ["3000","3010",...]  (minutely close series; interval in minutes)
```
This is the intraday price/volume source for the alert engine's Stage 2.

### 4f. Price performance (multi-timeframe) [CONFIRMED]
```
GET /company-price-feed/price-performance/{SYMBOL}
    → data.prices[] = {close,high,low,percentage,timeframe}  timeframe: 1D,1W,1M,...
```

### 4g. Full orderbook [CONFIRMED]
```
GET /company-price-feed/v2/orderbook/companies/{SYMBOL}   (~19KB depth ladder)
```
Alt id-based route: `GET /orderbook/{orderbookid}` [EXISTS] (numeric id from `/emitten/{SYM}/info`).

### 4h. Key stats / ratios [CONFIRMED]
```
GET /keystats/{SYMBOL}              (~16-21KB)
GET /keystats/ratio/v1/{SYMBOL}
```
Maps to TV-MCP fundamentals.

### 4i. Financial statements [CONFIRMED]
```
GET /findata-view/company/financial?symbol={SYMBOL}&data_type=1&report_type=2&statement_type=1
    → currency[], default_currency, rounding_value, data_tables, html_report  (~1.3MB!)
```
Params (from JS): `data_type`, `report_type`, `statement_type` (integers; enumerate by observing
the web UI's statement/period toggles).

### 4j. Corporate actions [CONFIRMED]
```
GET /corpaction/{action}?symbol={SYMBOL}      (~18KB; action segment varies)
```

### 4k. Seasonality [EXISTS — needs year]
```
GET /company-price-feed/seasonality?symbol={SYMBOL}&year={YYYY}   (400 without year)
```

### 4l. Sectors [CONFIRMED]
```
GET /emitten/sectors    → 22 sectors {id,name,alias1,parent,symbol}
```
Subsector routes `/emitten/sector...` exist (JS `getSectorList`, `getSpecialBoardIndex`).

### 4m. Social / sentiment stream [CONFIRMED]
```
GET /stream/v3/symbol/{SYMBOL}   → 30 community posts mentioning $SYMBOL (NOT price data)
```
Maps to TV-MCP `market_sentiment` / news. Rows: content, user, created_at, cashtags.

### 4n. Watchlists [CONFIRMED]
```
GET /watchlist                   → all watchlists {watchlist_id,name,category_type,...}
GET /watchlist/{watchlist_id}    [EXISTS] (numeric id required)
```

### 4o. Earnings [JS-ONLY — path confirmed in JS]
```
GET /earnings?page&order&sortcol&year&quarter&companySymbol&filter...
```

---

## 5. Feature-map vs TradingView-MCP (parity checklist)

| TV-MCP capability | Stockbit equivalent | Status |
|---|---|---|
| `yahoo_price` / quote | `/emitten/{SYM}/info` | ✅ CONFIRMED |
| `top_gainers` / `top_losers` | `/emitten/hotlist/{topGainer\|topLoser\|mostActive}` | ✅ CONFIRMED |
| `market_snapshot` | `/emitten/IHSG/info` + hotlist | ✅ |
| Intraday OHLCV | `/company-price-feed/prices/close` + WS | ✅ (REST) |
| Orderbook / depth | `/company-price-feed/v2/orderbook/companies/{SYM}` | ✅ |
| Fundamentals / ratios | `/keystats/*`, `/findata-view/company/financial` | ✅ |
| Screener | `/screener` + Redux `GET_SCREENER*` (see §6) | ⚠️ JS-ONLY |
| `market_sentiment` / news | `/stream/v3/symbol/{SYM}` | ✅ |
| Corp actions / calendar | `/corpaction/*`, `/calendar/*` | ⚠️ corpaction ✅, calendar JS-ONLY |
| Seasonality | `/company-price-feed/seasonality` | ⚠️ EXISTS |
| **Broker summary / bandarmology** | `/marketdetectors/{SYM}` | ✅ **CONFIRMED — TV has NO equivalent** |

**Bandar/broker data is Stockbit's unique value** — TradingView's data model has zero
broker/participant fields (verified against its 3,771-field IDX screener metainfo). This is the
reason to build on Stockbit rather than TradingView.

---

## 6. Feature inventory from Redux action names (JS-ONLY — features that exist, paths TBD)

Found as `GET_*`/`POST_*` action strings; confirms these features exist and are worth mapping later:
- **Screener:** `GET_SCREENER`, `_PRESET`, `_CUSTOM`, `_UNIVERSE`, `_METRICS`, `_FINANCIAL`, `_FAVORITES`, `SAVE_OR_RUN_SCREENER`, `POST_SCREENER_LIST_RESULT`
- **Valuation:** `RUN_VALUATION`, `GET_VALUATION_METRICS/EPS/GROWTH/MULTIPLE/TEMPLATE`, template CRUD
- **Comparison:** `GET_COMPARISON`, `ADD_COMPARISON`
- **Broker analysis:** `GET_BROKER_ACTIVITY`, `GET_BROKER_LIST`, `GET_TOP_BROKER`, `/broker-analysis/{broker,stock}`, `/broker-activity` (host/prefix TBD — 404 on exodus root)
- **Calendar:** `/calendar/{dividend,ipo,economic,rups,bonus,stocksplit,reversesplit,rightissue,warrant,tenderoffer,pubex}` (Next.js page routes; API host TBD)
- **Company:** `GET_COMPANY_INSIDER`, `GET_COMPANY_SEASONALITY`, `GET_FINANCIAL_REPORT`, `GET_FUNDACHART`, `GET_EARNINGS`, `GET_RESEARCH_INDICATOR`, `/insider/*`, `/ownership`
- **Sectors:** `GET_SECTOR_LIST`, `FETCH_SUBSECTOR_COMPANIES`

---

## 7. WRITE endpoints — what is in, what is out, and why

This section used to say "do not implement any of these". That was right for a read-only server and
is no longer the posture; each write below was admitted by a decision record, and each is enforced
by the closed route table rather than by this prose.

**In scope, confirm-gated:**

| | Routes | Record |
|---|---|---|
| Chart persistence | `POST/PUT/DELETE /chartbit/charts[/{id}]`, `POST /chartbit/chart-drawings`, `POST/PUT/DELETE /chartbit/settings[/{name}]` | ADR-0003 (+ Amendment 2) |
| Order entry | `POST carina/order/v2/{buy,sell,amend,cancel}` | ADR-0004 |
| IPO subscription | `POST sekuritas/eipo/order` (and `/eipo/order/verify`, a dry run) | ADR-0004 |
| Watchlist | `POST /watchlist`, `PUT/DELETE /watchlist/{id}`, `POST /watchlist/{id}/company/item`, `DELETE /watchlist/{id}/company/{companyId}/item`, `PUT /watchlist/favorite/{id}` | ADR-0006 |
| Screener | `POST /screener/templates` with `save:"1"`, `DELETE /screener/templates/{id}`, `POST/DELETE /screener/favorites` | ADR-0006 |

**Deliberately out**, and each would need its own argument: `/order/v2/amend/bulk`,
`/order/v2/bulk-cancel`, `/order/day-trade/v1/*`, `/smart-order/*`, `/withdraw/balance`,
`/securities/deposit`, `/intraservice/multi-portfolio/v1/{move-cash,move-stock}`,
`/virtualtrading/order`, `/bond/v1/orders`, stream posting/liking/following, and
`POST /user-setting/configurations`. None of them is in the route table, which is what actually
stops them.

`test/transport.test.ts` sorts every non-GET route into a named class citing its ADR, and asserts
that nothing else mutates. Editing that list is the deliberate act that lets a new write in.

---

## 8. Method notes & gotchas

- **grpc-gateway error envelope** is helpful for discovery: `{"message":...,"error_type":"INVALID_PARAMETER","errors":[{"key":...,"error":...}]}`. A **400 with a param name = the route is real**; probe params from there. A **404** (34-byte body) = route/host wrong.
- **After-hours:** hotlist/running-trade return empty during closed market. Verify live-market behavior during an IDX session (roughly Mon–Fri; confirm current hours/Friday split from IDX — they've changed over time).
- **`api.stockbit.com` is a dead end** (version gate). Everything market-related is on `exodus`.
- **Rate limits:** Cloudflare + CloudFront front the API. Keep request rate human-ish; you're on
  the user's own KYC'd account and looking like a scraper is what gets accounts flagged. Batch,
  back off, cache (TTL shorter than data staleness).
- **Pin & fail loud:** private undocumented API; schemas can change without notice. Version the
  parsers, assert on shape, surface errors instead of silently mis-parsing.

---

## 9. Two-stage product this enables (the actual goal)

```
STAGE 1  (nightly cron / pre-open, deterministic — no LLM)
  for each watchlist symbol:
    GET /marketdetectors/{SYM}?...&limit=HIGH&period=LATEST
    rule: e.g. XL & XC both in brokers_sell above a materiality threshold (% of day value)
  → candidates.json   (+ archive raw response daily — baseline history can't be backfilled)

STAGE 2  (session-1 live, only the candidates)
  GET /company-price-feed/prices/close (+ WS) → time-normalized rel-volume + resistance break
  → notify (Telegram/ntfy)
```
LLM belongs at the edges only (compile English→rule once; phrase the alert). Never in the poll loop
(cost/nondeterminism/fragility). See prior design notes.

**Step zero, start now:** a daily cron that archives `/marketdetectors/{SYM}` for your universe.
"Broker X is *unusually* selling" needs a baseline, and IDX/Stockbit don't let you backfill it.

---

## 10. "Like tradesdontlie" — attaching to the desktop app (three architectures)

The `tradesdontlie/tradingview-mcp` model = attach to the running desktop app, reuse the
already-logged-in session, user never handles a token. Whether that ports to Stockbit:

**Why tradesdontlie NEEDS the desktop app:** TradingView has no usable public data API; the
value (charts, drawings, indicators) is locked in the GUI, so CDP browser-automation is the only
way in. **Stockbit is the opposite** — the desktop app is a thin client over a clean JSON API
(§4) you already have full token access to. So "drive the GUI" solves a problem Stockbit doesn't
have.

| Option | How | Verdict |
|---|---|---|
| **A. Attach to running app (true parity)** | Inject JS into the live WKWebView via Safari Web Inspector protocol | **Bad fit.** Tauri is WKWebView, not Chromium — **no CDP**. Production Tauri builds ship `isInspectable=false`; `defaults write com.stockbit.desktop WebKitDeveloperExtras -bool true` at most enables right-click Inspect, not remote automation. Safari-inspector tooling is thin/clumsy vs `chrome-remote-interface`. Fragile, wrong tool. |
| **B. Read the persisted session from disk** | Tokens live in WKWebView localStorage (below) | **Feasible but brittle/dubious.** Values are **client-side encrypted** (see finding). You'd have to replicate the app's decryption from the JS bundle — defeating protection the app deliberately added. |
| **C. HTTP client + token (RECOMMENDED)** | User supplies a bearer token, or the MCP does its own headless login → `/auth/v2/login` → store refresh token in OS keychain → auto-refresh | **Right architecture.** Robust, no GUI automation, no client-crypto reversing. Uses the same account/session. For "no-paste" UX, do the one-time login flow yourself. |

**Finding — desktop session storage (macOS, verified 2026-08-02):**
`~/Library/WebKit/com.stockbit.desktop/WebsiteData/.../LocalStorage/localstorage.sqlite3`
(table `ItemTable`). Session keys present:
- `at` (len ~2272) = **access token**, `ate` (56) = its expiry, `ats` (2120)
- `ar` (len ~2336) = **refresh token**, `are` (56) = its expiry, `ars` (2200)
- `au` (736) = user/auth blob
- **Values do NOT start with `eyJ`** (prefixes `Z…`/`M…`) → **encrypted/obfuscated client-side**,
  not raw JWTs. This is why Option B is not a clean shortcut. (Only key names/lengths/prefixes
  were read; no values extracted.)

**Bottom line:** build the HTTP client (Option C). It *is* an "MCP for the Stockbit desktop
account" — it just talks to the same backend the desktop talks to, instead of puppeteering the
window. If you specifically want zero token-pasting, implement headless login + keychain-stored
refresh token, not GUI attachment.

---

## 11. Repro / continue

- Verified response samples were captured to a scratchpad during mapping (not committed).
- To re-verify any endpoint: `curl` with the §3 headers + a fresh bearer token.
- To discover more: download the web app JS (`https://stockbit.com` → `/_next/static/chunks/*.js`),
  grep for `q7` (=exodus base), `baseURL`, `.get("`, and Redux `GET_*` action names. The frontend
  is the authoritative endpoint catalog.
- Prior context (why not TradingView, why not a scraper, the daemon analysis) is in
  `CODEX-BRIEF.md` and `REFERENCE-REPOSITORY.md` in this repo.

### 4p. Broker Distribution — broker-to-broker flow matrix [CONFIRMED 2026-08-03, live]

```
GET /order-trade/broker/distribution
    ?symbol=BBRI
    &data_type=BROKER_DISTRIBUTION_DATA_TYPE_VALUE     # or _VOLUME
    &investor_type=INVESTOR_TYPE_ALL                    # _FOREIGN | _DOMESTIC
    &period=TB_PERIOD_LAST_7_DAYS                       # XOR from/to (see below)
```

Different service from `/marketdetectors` (`financial.order_trade.*`), and the **symbol is a query
parameter, not a path segment**.

> ⚠️ **`market_board` uses a different VALUE prefix here: `MARKET_TYPE_`, not `MARKET_BOARD_`.**
> Sending broker summary's `MARKET_BOARD_REGULER` returns `400 Your request is invalid` — an earlier
> revision of this document misread that as "this endpoint takes no board at all". It does, and it
> matters: for BRMS over 27 Jul–3 Aug 2026, `MARKET_TYPE_REGULER` gives a top buyer of **120.33B**
> while `MARKET_TYPE_ALL` gives **978.15B**, because ALL folds in negotiated blocks.
>
> Accepted: `MARKET_TYPE_REGULER` (default, matches Stockbit's UI), `_ALL`, `_NEGO`, `_TUNAI`,
> `_UNSPECIFIED` (behaves as REGULER). Rejected: `_NEGOTIATED`, `_CASH`.

> ⚠️ **`period` and `from`/`to` are mutually exclusive**, same as broker summary. Stockbit's own
> client picks one (`period ? {period} : {from,to}`) and never sends both.

| Parameter | Values |
|---|---|
| `data_type` | `BROKER_DISTRIBUTION_DATA_TYPE_` + `VALUE` (IDR) \| `VOLUME` (shares) \| `UNSPECIFIED` |
| `investor_type` | `INVESTOR_TYPE_` + `ALL` \| `FOREIGN` \| `DOMESTIC` |
| `period` | `TB_PERIOD_` + `LAST_1_DAY`, `LAST_7_DAYS`, `LAST_1_MONTH`, `LAST_3_MONTHS`, `LAST_6_MONTHS`, `LAST_1_YEAR`, `PREVIOUS_DAY`, `PREVIOUS_MONTH`, `THIS_MONTH`, `YEAR_TO_DATE` |
| `from` / `to` | `YYYY-MM-DD`, both required together |

**Response:** `data.{date_info, start_date, end_date, by_value, by_volume}`. Each of `by_value` /
`by_volume` holds `{top_broker_buy[], top_broker_sell[]}` (12 entries each observed). Only the block
matching `data_type` is populated; the other comes back empty.

**Units VERIFIED arithmetically.** `VOLUME` amounts are **lots, not shares** — matching the `blot`/`slot` convention in 4a. Check: value/volume for the top BBRI and TLKM brokers gives ~296,000 and ~260,000, absurd per share but correct per lot (2,964 and 2,609 IDR, against last prices ~3,020 and ~2,600).

Each entry is the flow matrix itself:

```jsonc
{ "detail":        { "code": "AK", "type": "Asing", "amount": 445525972000 },
  "distribute_to": [ { "code": "BK", "type": "Asing", "amount": 77101438000 }, … ] }
```

i.e. *broker AK accumulated Rp 445.5B, of which Rp 77.1B came from BK*. So `top_broker_buy[].detail`
is a **buyer** and its `distribute_to` are the **sellers** it bought from; `top_broker_sell` is the
mirror. **Verified against Stockbit's own UI** for BRMS 27 Jul–3 Aug 2026: top buyer XL 120.33B, and
its counterparties CC 14.41B, AK 13.89B, ZP 11.84B, XL 11.03B, XC 7.22B, YP 7.10B, BB 4.67B — all
identical. (Their UI labels a non-contiguous subset of ribbons, which can look like missing data.) `broker_summary` gives the
net per broker; this gives the counterparties behind it.

**Entitlement:** Stockbit requires a minimum total balance of **Rp 10,000,000** for this feature. In
their web app the gate is **client-side** — the micro-frontend
(`storage.stockbit.com/broker-distribution/*/static/remoteEntry.js`) takes an `isEligible` prop and,
when false, renders a blurred `broker-distribution-not-eligible-overlay` over placeholder data and
**never issues the request**. Whether the server independently refuses an ineligible account is
**UNVERIFIED** — it could not be observed from an entitled account. Client code should therefore treat a `403` as *probably* the entitlement gate while preserving the
server's own message — these routes also 403 on missing browser-shaped headers (see §3), so
asserting the balance outright misdiagnoses a WAF block as an empty wallet.


---

## 11. Watchlist, screener and price bands [CONFIRMED 2026-08-09, live]

Probed sequentially against a real account. All reads.

### 11a. Watchlists

```
GET /watchlist                       → the user's lists
GET /watchlist/{watchlist_id}?limit  → one list's contents
```

**The two endpoints have different response shapes and look interchangeable.** The index returns
`data` as a bare array of lists; the detail wraps its rows in **`data.result`**. Assuming the array
shape for both fails at the first real call.

Index row: `watchlist_id`, `name`, `is_default`, `is_favorite`, `category_type`, `total_items`.

> ⚠️ **`total_items` on the index is always 0**, whatever the list holds — the account probed had a
> list reporting 0 and containing 116 symbols. Never use it as a count. `data.total` on the *detail*
> endpoint is correct.

> ⚠️ **`limit` is required** and capped at 500. Omitting it does not mean "everything".

Detail row: `symbol`, `name`, `last`, `change`, `percent`, `previous`, `volume`, `id`, `orderbook`,
`notations`, `uma`, `corp_action`, plus display metadata.

> ⚠️ **`volume` here is in SHARES**, while `/company-price-feed/historical/summary` reports volume in
> **LOTS** for the same stock on the same day. One lot is 100 shares; comparing them is a 100x error.

### 11b. Screener — running a saved screen is a plain GET

```
GET /screener/templates                     → the user's saved screens
GET /screener/templates/{id}?type=…         → RUNS one; returns matched companies
GET /screener/metric                        → ~52KB catalogue of screenable fields
GET /screener/preset                        → Stockbit's built-in Guru screens
GET /screener/universe                      → index scopes (IHSG, IDX30, …)
```

An earlier research pass assumed running a screen required a POST and therefore its own ADR. **It
does not** — it is a read, and nothing here creates, edits or saves a screen.

`type` must match the template's own (`TEMPLATE_TYPE_CUSTOM` / `TEMPLATE_TYPE_GURU`); a custom screen
run as GURU is simply not found. Results arrive as `data.calcs[]`, each with a `company` object and a
`results[]` of projected metric columns.

Creating or saving a screen is deliberately **not** in the route table.

### 11c. ARA/ARB and foreign flow — already inside the orderbook response

No new route. `GET /company-price-feed/v2/orderbook/companies/{SYMBOL}` already carries these, in
**two different shapes**:

```
ara       {"value":"3,910","visible":true}     ← wrapped, string, thousands separator
arb       {"value":"2,670","visible":true}
next_ara  {"value":"3,910","visible":true}
next_arb  {"value":"2,670","visible":true}
fbuy      789081065000                          ← a bare number
fsell     282200351000
fnet      506880714000
```

Also present and unmapped: `iepiev`, `has_foreign_bs`, `total_bid_offer`, `market_data`,
`autoreject_*`, `domestic`, `foreign`, `up`/`down`/`unchanged`.

### 11d. `/charts/{SYMBOL}` — RESOLVED (2026-08-24). The spelling was the problem.

`GET /charts/BBRI` answers **400** with `errors: [{ key: "Timeframe" }]`, and this document spent
months recording that as "real, and still locked" after trying `timeframe` / `tf` / `interval` /
`resolution` against `daily`, `1D`, `D`, `DAILY`, `TIMEFRAME_DAILY`.

Every one of those attempts was **uppercase**. The web client calls:

```
GET /charts/{SYM}/daily?timeframe=1w|1m|3m|ytd|1y|3y|5y
        (+ &is_include_previous_historical=true for ytd and 1w)
GET /charts/{SYM}/daily?from&to&interval&chart_type&timeframe
GET /charts/{SYM}?timeframe=…
```

Lowercase, and the vocabulary is windows rather than bar sizes. Wired, tested, and it does what the
old note predicted: a whole series in one request instead of the 12-row paged walk, roughly 40x
fewer requests for every scan, backtest and alignment.

The lesson generalises and is worth keeping: **a 400 naming a parameter means the route is real, and
says nothing about whether the values tried were the right shape of value.**

---

## Appendix A — the route table, in full

Generated from `src/http/transport.ts`, which is the only place a Stockbit URL exists in this
project. A caller names a **route key**; it never supplies a path. That is ADR-0002's closed table,
and `test/transport.test.ts` snapshots the permitted set per host so that adding a row is a visible
edit rather than a side effect.

`Credential` is the auth kind the route carries: `main` / `securities` / `eipo` present a bearer for
that domain; `refreshMain` / `refreshSecurities` / `refreshEipo` are the three refresh chains, which
put the credential in a header, a body field and a query parameter respectively; `none` means the
route is called with no credential of ours at all, which is correct for the two token exchanges —
sending one there would be a token presented somewhere it was never issued for.

### `exodus.stockbit.com`

Market data, stream, screener, watchlist, Chartbit. Main session token.

| Route key | Method + template | Credential |
|---|---|---|
| `chartbitChartDelete` | DELETE /chartbit/charts/:layoutId | main |
| `chartbitSettingDelete` | DELETE /chartbit/settings/:templateName | main |
| `screenerFavoriteRemove` | DELETE /screener/favorites | main |
| `screenerTemplateDelete` | DELETE /screener/templates/:templateId | main |
| `watchlistDelete` | DELETE /watchlist/:watchlistId | main |
| `watchlistRemoveItem` | DELETE /watchlist/:watchlistId/company/:companyId/item | main |
| `analystRatings` | GET /analyst-ratings/:symbol | main |
| `analystConsensus` | GET /analyst-ratings/:symbol/consensus | main |
| `eipoWebviewLink` | GET /auth/eipo/webview/link | main |
| `chartbitDrawings` | GET /chartbit/chart-drawings | main |
| `chartbitCharts` | GET /chartbit/charts | main |
| `chartbitChart` | GET /chartbit/charts/:layoutId | main |
| `chartbitDrawingTemplates` | GET /chartbit/drawings | main |
| `chartbitInitial` | GET /chartbit/initial/:symbol | main |
| `chartbitSettings` | GET /chartbit/settings | main |
| `chartbitSetting` | GET /chartbit/settings/:templateName | main |
| `chartbitStudies` | GET /chartbit/studies | main |
| `chartbitVersion` | GET /chartbit/version | main |
| `charts` | GET /charts/:symbol | main |
| `chartsDaily` | GET /charts/:symbol/daily | main |
| `historicalSummary` | GET /company-price-feed/historical/summary/:symbol | main |
| `marketSession` | GET /company-price-feed/market-time/session | main |
| `pricePerformance` | GET /company-price-feed/price-performance/:symbol | main |
| `pricesBatch` | GET /company-price-feed/prices | main |
| `pricesMarket` | GET /company-price-feed/prices/:symbol/market | main |
| `pricesClose` | GET /company-price-feed/prices/close | main |
| `seasonality` | GET /company-price-feed/seasonality/:symbol | main |
| `orderbook` | GET /company-price-feed/v2/orderbook/companies/:symbol | main |
| `comparisonIndustries` | GET /comparison/:symbol/industries | main |
| `comparisonRatios` | GET /comparison/:symbol/ratios | main |
| `comparisonSymbolTemplates` | GET /comparison/:symbol/templates | main |
| `comparisonMetrics` | GET /comparison/metrics | main |
| `comparisonTemplates` | GET /comparison/templates | main |
| `corpactionToday` | GET /corpaction | main |
| `corpaction` | GET /corpaction/:actionType | main |
| `stockConversion` | GET /corpaction/:symbol/stock_conversion | main |
| `corpactionStatus` | GET /corpaction/status | main |
| `earnings` | GET /earnings | main |
| `shareholdersChart` | GET /emitten-metadata/shareholders/:symbol/chart | main |
| `emittenSubsidiary` | GET /emitten-metadata/subsidiary/:symbol | main |
| `emittenContact` | GET /emitten/:symbol/contact | main |
| `emittenInfo` | GET /emitten/:symbol/info | main |
| `emittenProfile` | GET /emitten/:symbol/profile | main |
| `emittenClassification` | GET /emitten/classification | main |
| `emittenClassificationCompany` | GET /emitten/classification/company | main |
| `emittenHotlist` | GET /emitten/hotlist/:moverType | main |
| `indexMembers` | GET /emitten/indexes/:indexCode | main |
| `emittenSectors` | GET /emitten/sectors | main |
| `emittenTrending` | GET /emitten/trending | main |
| `emittenFinItems` | GET /emitten/v2/:emittenType/:symbol/fin-items | main |
| `emittenTypedInfo` | GET /emitten/v2/:emittenType/:symbol/info | main |
| `sectorCompanies` | GET /emitten/v3/sector/:sectorId/company | main |
| `financial` | GET /findata-view/company/financial | main |
| `brokerDirectory` | GET /findata-view/marketdetectors/brokers | main |
| `fundachartMetrics` | GET /fundachart/metrics | main |
| `fundachartTemplates` | GET /fundachart/templates | main |
| `insiderTransactions` | GET /insider/company/majorholder | main |
| `insiderOwnership` | GET /insider/majorholder/ownership | main |
| `shareholdingCompanies` | GET /insider/shareholding/companies/:symbol | main |
| `shareholdingComposition` | GET /insider/shareholding/composition/companies/:symbol | main |
| `shareholdingInvestors` | GET /insider/shareholding/investors/:insiderId | main |
| `shareholdingNetwork` | GET /insider/shareholding/network | main |
| `keystats` | GET /keystats/:symbol | main |
| `keystatsRatio` | GET /keystats/ratio/v1/:symbol | main |
| `marketDetectors` | GET /marketdetectors/:symbol | main |
| `brokerActivity` | GET /order-trade/broker/activity | main |
| `brokerDistribution` | GET /order-trade/broker/distribution | main |
| `brokerTop` | GET /order-trade/broker/top | main |
| `marketMover` | GET /order-trade/market-mover | main |
| `orderQueue` | GET /order-trade/order-queue | main |
| `runningTrade` | GET /order-trade/running-trade | main |
| `runningTradeChart` | GET /order-trade/running-trade/chart/:symbol | main |
| `runningTradeGroup` | GET /order-trade/running-trade/group | main |
| `topStock` | GET /order-trade/top-stock | main |
| `tradeBook` | GET /order-trade/trade-book | main |
| `tradeBookChart` | GET /order-trade/trade-book/chart | main |
| `underwriters` | GET /order-trade/underwriters | main |
| `underwriterPerformance` | GET /order-trade/underwriters/:underwriterCode/ipo-performance | main |
| `paywallEligibility` | GET /paywall/eligibility/check | main |
| `researchCategories` | GET /research/categories | main |
| `researchIndicator` | GET /research/indicator/new | main |
| `screenerFavorites` | GET /screener/favorites | main |
| `screenerFinItems` | GET /screener/finitem-watchlist | main |
| `screenerMetrics` | GET /screener/metric | main |
| `screenerPresets` | GET /screener/preset | main |
| `screenerTemplates` | GET /screener/templates | main |
| `screenerRunTemplate` | GET /screener/templates/:templateId | main |
| `screenerUniverse` | GET /screener/universe | main |
| `search` | GET /search | main |
| `searchV2` | GET /search/v2 | main |
| `sekuritasAuthToken` | GET /sekuritas/auth/token | main |
| `streamUser` | GET /stream/non-login/user/:username | main |
| `streamAll` | GET /stream/v3 | main |
| `streamPost` | GET /stream/v3/post/:postId | main |
| `streamSymbol` | GET /stream/v3/symbol/:symbol | main |
| `streamSymbolPinned` | GET /stream/v3/symbol/:symbol/pinned | main |
| `userSettings` | GET /user-setting/configurations | main |
| `watchlists` | GET /watchlist | main |
| `watchlistDetail` | GET /watchlist/:watchlistId | main |
| `watchlistSymbols` | GET /watchlist/:watchlistId/symbols | main |
| `watchlistSearchCompany` | GET /watchlist/search/company | main |
| `chartbitDrawingsSave` | POST /chartbit/chart-drawings | main |
| `chartbitChartCreate` | POST /chartbit/charts | main |
| `chartbitSettingsCreate` | POST /chartbit/settings | main |
| `shareholdersToken` | POST /emitten-metadata/shareholders/token | main |
| `loginRefresh` | POST /login/refresh | refreshMain |
| `screenerFavoriteAdd` | POST /screener/favorites | main |
| `screenerRun` | POST /screener/templates | main |
| `screenerSave` | POST /screener/templates | main |
| `streamTrending` | POST /stream/v3/trending | main |
| `watchlistCreate` | POST /watchlist | main |
| `watchlistAddItem` | POST /watchlist/:watchlistId/company/item | main |
| `chartbitChartUpdate` | PUT /chartbit/charts/:layoutId | main |
| `chartbitSettingUpdate` | PUT /chartbit/settings/:templateName | main |
| `watchlistRename` | PUT /watchlist/:watchlistId | main |
| `watchlistFavorite` | PUT /watchlist/favorite/:watchlistId | main |

### `carina.stockbit.com`

Stockbit Sekuritas. Securities token, plain bearer. Nothing here has been observed live.

| Route key | Method + template | Credential |
|---|---|---|
| `account` | GET /account | securities |
| `balanceCash` | GET /balance/cash | securities |
| `balanceCashInfo` | GET /balance/cash/info | securities |
| `tradingFormula` | GET /formula/v2 | securities |
| `historyDetail` | GET /history/detail | securities |
| `historyPortfolioPerformance` | GET /history/performance/portfolio/:performanceKind | securities |
| `historyTradePerformance` | GET /history/performance/trade | securities |
| `historyRealized` | GET /history/realized | securities |
| `historyRealizedDetail` | GET /history/realized/detail | securities |
| `historyList` | GET /history/v3 | securities |
| `orderDetail` | GET /order/v2/detail | securities |
| `orderList` | GET /order/v2/list | securities |
| `portfolioDetail` | GET /portfolio/v2/detail | securities |
| `portfolioList` | GET /portfolio/v2/list | securities |
| `portfolioSummary` | GET /portfolio/v2/summary | securities |
| `stockTradable` | GET /stock/tradable | securities |
| `tradingInfo` | GET /trading/info | securities |
| `subAccountList` | GET /v2/sub-account/list | securities |
| `carinaAuthLogout` | POST /auth/logout | securities |
| `carinaAuthPinValidate` | POST /auth/pin/validate | securities |
| `carinaAuthRefresh` | POST /auth/refresh | refreshSecurities |
| `carinaAuthLogin` | POST /auth/v2/login | none |
| `orderAmend` | POST /order/v2/amend | securities |
| `orderBuy` | POST /order/v2/buy | securities |
| `orderCancel` | POST /order/v2/cancel | securities |
| `orderSell` | POST /order/v2/sell | securities |

### `api-sekuritas.stockbit.com`

e-IPO. Its own token, minted from the main login. Nothing here has been observed live.

| Route key | Method + template | Credential |
|---|---|---|
| `eipoCompanyDetail` | GET /eipo/company/detail | eipo |
| `eipoUnboxing` | GET /eipo/company/unboxing | eipo |
| `eipoOrderDetail` | GET /eipo/order/detail | eipo |
| `eipoPriceGroup` | GET /eipo/price_group | eipo |
| `eipoRdnBalance` | GET /eipo/rdn_balance | eipo |
| `eipoCompanyList` | GET /eipo/social/company/list | eipo |
| `eipoStatus` | GET /eipo/status | eipo |
| `eipoRefreshToken` | GET /partner/refresh_token | refreshEipo |
| `eipoOrderPlace` | POST /eipo/order | eipo |
| `eipoOrderVerify` | POST /eipo/order/verify | eipo |
| `eipoAccessToken` | POST /partner/eipo/access_token | none |
