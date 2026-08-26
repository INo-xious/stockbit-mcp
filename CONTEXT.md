# CONTEXT.md — the language of stockbit-mcp

A glossary, not a spec. One meaning per word; the code and the docs use these words this way.

## Market
- **Symbol** — an IDX ticker (`BBRI`, `TLKM`, `GOTO`); uppercase, optional one hyphenated suffix (`BUKA-W` warrant, `BBRI-R` right). `IHSG` is the composite index. The only user-facing word for it: tool arguments say `symbol`. `emiten_code` and `company_id` exist only on the wire.
- **Lot** — 100 shares. Tools take and report lots; shares are the wire's business.
- **Bandarmology** — broker-flow analysis: which brokers accumulated, which distributed, and who was on the other side. The data no other market API has.
- **Broker code** — the two-letter IDX code (`ZP`, `CC`, `YP`); the broker directory maps it to a name.
- **Asing / Lokal / Pemerintah** — foreign / domestic / government-classified brokers or flow.
- **ARA / ARB** — auto-rejection ceiling / floor for a session; a price outside the band is rejected by the exchange. A stock "floor-locked" on ARB carries no flow signal.
- **Fraksi harga (tick)** — the price grid a limit order must sit on (<200 → 1, <500 → 2, <2000 → 5, <5000 → 10, ≥5000 → 25).
- **Session** (market) — IDX session I / II, pre-opening, post-closing; WIB (UTC+7).

## Account and credentials
- **Token domain** — which credential a request carries: `main` (exodus, market data), `securities` (carina, Stockbit Sekuritas), `eipo` (api-sekuritas).
- **Credential** — the stored refresh token for one domain. **Access token** — the 24-hour bearer minted from it; held in memory and, unless `STOCKBIT_NO_ACCESS_CACHE=1`, shared between processes through `access.enc` (see `SECURITY.md`). **Session** (auth) — a domain's live login: a credential that still refreshes.
- **Website session** — the FOURTH credential, and deliberately not a token domain: the browser's own cookies and Local Storage, captured to `websession.enc`. It is what the chart runs on, it lasts about a day, and no refresh token can mint one — only a real login. `status` reports it separately because a healthy refresh token says nothing about it.
- **Rotation** — a successful `/login/refresh` mints a new refresh token and retires the one presented. Observed, not assumed. It is why two processes refreshing at once lock each other out, and why the browser loading a Stockbit page spends the CLI's credential.
- **Store / backend** — where credentials live: macOS Keychain, or an encrypted file elsewhere.
- **PIN** — the six-digit Stockbit Sekuritas trading PIN. Typed only at a terminal; no tool accepts one.
- **Trading mode** — `off` (default), `paper` (local ledger, no real money, no PIN), `live` (real orders). Set only by `stockbit-auth trading-enable --paper|--live`.
- **Paper account** — the local ledger paper mode trades against; every paper result says "PAPER ACCOUNT".

## Orders
- **Ticket** — an order intent priced and checked by `order_preview`; in memory, expires in two minutes, spent before the request goes out. Write tools take a ticket id, an optional confirmation, and nothing else. By default confirmation is explicit or directly elicited; capped live autoconfirm is an operator-enabled exception enforced by server policy.
- **Outcome** — what is known after a write: `ok` · `rejected` · `not-visible` · `landed-despite-error` · `not-found-after-error` · `outcome-unknown` · `write-failed`. `ok` is the only clean success; `landed-despite-error` is also visible on read-back but followed an errored request. Never resend a non-`ok` outcome.
- **Check** — one preview validation; `ok:false` blocks; `unverified` means the input could not be read ("not contradicted", never "confirmed").

## Provenance
- **Evidence** — how a tool's field mapping is known: **Observed** (a real response from a live account was seen and the code written against it) · **Read-back** (a write verified by re-reading the account; the body shape may still be a guess, and a wrong guess shows as `not-visible`) · **Projected** (field names taken from Stockbit's web bundle, never seen live). Every tool carries one. The API reference's `[CONFIRMED]/[EXISTS]/[JS-ONLY]` describe *routes*: CONFIRMED routes back Observed tools; EXISTS/JS-ONLY routes back Projected ones.
- **readFrom** — the wire key a value was read from. **unmappedKeys** — names of unrecognised fields on an account response (values dropped). **unmapped.sampleKeys** — the same on market data, where the raw row is returned. **derived** — a value computed rather than read.

## The server
- **Tool** — one MCP tool. **Read tool** (a noun: `quote`, `orders`) reads; **write tool** (a verb: `order_buy`, `watchlist_add`) changes something and is confirm-gated.
- **Family** — one registration module = one Stockbit UI section (market, bandarmology, analysis, company, fundamentals, insider, corpaction, stream, screener, account, chartbit, alerts, pine, workflows, trading, eipo, system).
- **Profile** — which families/tools a server instance registers (`STOCKBIT_TOOLS`).
- **Recipe / workflow** — a saved sequence of read tools (`workflow_run`); recipes cannot reach a write tool. **Prompt** — the same workflow offered as an MCP prompt.
- **Daemon** — `stockbit-alerts`, the process that evaluates alert rules while no client is open.
- **Chartbit** — Stockbit's TradingView-based chart page; the server draws on it through the user's own browser.
