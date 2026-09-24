# Verification status — 2026-09-24

This records checks of the unreleased build on `codex/stockbit-safe-tools`, based on upstream
`194d429`. Use this checkout or its locally built extension; the published 1.3.1 package does not
contain these changes. This is a technical test record, not regulatory approval or a guarantee of
complete Stockbit website coverage.

## What the evidence means

A successful MCP call establishes that the tested arguments worked for this account at this time.
It does not establish every optional filter, every account entitlement, or the meaning of an empty
response. Tool metadata distinguishes **observed** mappings, writes verified by **read-back**, and
**projected** mappings. Some previously observed tools still contain unverified optional fields;
their descriptions state that limitation. The generated [tool reference](TOOLS.md) is the current
inventory; historical research in `PENDING-VERIFICATION.md` is not the current status.

## Safety boundary

- Real buy, sell, amend, cancel and e-IPO subscription tools and transport routes are removed.
  Legacy live settings and environment variables cannot restore them.
- Brokerage portfolio, cash, orders and history remain reads. They never switch to paper data.
- `paper_*` operates on the local simulation ledger. `virtual_*` operates only on Stockbit's
  `/virtualtrading/*` API using the ordinary market-data session.
- Credentials stay in the local credential store. No MCP tool accepts a PIN. Verification reports
  store statuses and counts, not account balances, identity records, tokens, or raw responses.

The offline suite checks the route boundary, legacy-setting refusal, simulation confirmation,
ambiguous write outcomes, account masking, cache separation, chart persistence verification, and
transport isolation. Tests never submit real orders.

## Authenticated checks

| Area | What was exercised | Result / limit |
|---|---|---|
| Ordinary login | Browser login and separate API process reads | Passed. The browser remains usable for charts. |
| Securities login | One-shot PIN exchange, read-only portfolio proof, then separate MCP process | Passed after fixing the grant envelope, storage-backend reporting, and encrypted access-cache handoff. The PIN is never saved by the client. |
| Securities renewal | Public frontend refresh headers/body checked; live renewal attempted | Renewal remains unverified: the refresh endpoint returned 401. Fresh login and cached access work. Re-run local `trading-login` when the securities session expires. Login/check use portfolio reads instead of unnecessarily rotating a new session. |
| Market, analysis and company data | Representative calls across the registered read tools | Reusable sweep covers quotes, books, broker flow, fundamentals, insider data, news, calendars, screeners, local calculations and renderers. See coverage below. |
| Real portfolio | Portfolio, absent position, cash, orders, history, performance, fees, tradability and masked account metadata | Actual nested response shapes were inspected without recording account values. Empty holdings/orders do not prove nonempty position/order mappings; synthetic regressions cover those branches. |
| Stockbit virtual account | Portfolio, held/absent position, orders and configuration | Reads passed against the website simulation account. |
| Stockbit virtual order lifecycle | One controlled simulated buy, followed by account read-back | Stockbit rejected the order because the market was closed. No order ID was created; holdings and order list stayed unchanged. Successful submit, amend and cancel still need a market-hours check. No blind retry was made. |
| Chart browser | Open, inspect shapes, analyze without drawing, draw one level, screenshot, save, REST read-back and selective cleanup | Passed. The created entity was found in saved drawings. Cleanup removed only that entity; the original two drawings remained and the saved count returned to two. |
| Watchlist edits | Temporary list: create, rename, add/remove BBRI, favorite/unfavorite, delete | Controlled scenario checks each write by reading it back and verifies existing lists remain unchanged. |
| Screener edits | Temporary screen: save, favorite/unfavorite, delete | Controlled scenario verifies the current frontend request shape and removes the test screen afterward. |
| Client protocols | stdio smoke, SDK initialize/list/call, loopback Streamable HTTP | Local protocol checks passed. Real Claude/ChatGPT account installation is a separate setup step; see [CLIENTS.md](CLIENTS.md). |

## Corrections driven by the live checks

- Securities grants now accept the observed `data.token` with target `2`; unsupported targets are
  refused before a PIN request. An unsuccessful PIN exchange is never retried automatically.
- Earnings supplies the required page, sort and order defaults. Trade-book probes supply both
  symbol and `group_by`. One-week chart series preserves hourly Jakarta timestamps instead of
  pretending it is daily data.
- `price_market` explicitly reads current orderbook market data because the old price endpoint
  rejects the documented request. Unsupported historical-date requests fail explicitly.
- Stream post detail uses the website's empty-body POST. Watchlist search includes the required
  watchlist ID and one-based page; cache keys retain those filters.
- Chart drawing reads supply both symbol and chart ID, deriving them only from unambiguous layout
  metadata. Drawing-template reads specify their line-tool type. Save verification bypasses stale
  cache; REST drawing writes check changed values and deleted keys, not just key presence.
- Chart labels preserve literal JavaScript replacement characters. Selective cleanup can name
  specific server-owned shape IDs and refuses IDs the server does not own.
- Watchlist names respect Stockbit's 25-character limit; favorite changes send `is_favorite`
  explicitly and preserve other favorites. Ad-hoc screener runs use the observed encoded filter
  and universe payload and expose pagination.

## Coverage and reproducibility

Run these from the checkout:

```bash
npm run typecheck
npm test
npm run build
npm run docs:tools
npm run smoke
npm run check:pack
npm run build:mcpb
```

The generated inventory currently contains **152 tools** with the `all` profile; the default `core`
profile contains **41**. The read-only live sweep inventories every registered tool:

```bash
npm run verify:tools -- --live
npm run verify:tools -- --live --only quote,portfolio --output .stockbit/verification-subset.json
```

Its private, ignored report is `.stockbit/verification.json`. A `passed` row means the MCP call
returned successfully, not that all optional variants were tested. `blocked` means a prerequisite
was unavailable. `not-run` includes mutations, browser effects and local paper tools that can settle
a ledger; those need isolated tests or the separate controlled scenarios above. The sweep does not
place virtual orders or modify watchlists, saved screens or charts.

The full integration suite passed **1,978 tests** with no failures. Typecheck, generated tool docs,
stdio smoke and npm package checks passed. A real-browser fixture timed out during an earlier
parallel run; it passed in isolation and in the subsequent complete run.

The final authenticated read sweep inventoried all **152 tools**: **101 passed**, **43 were
deliberately excluded from the read-only sweep**, and **8 were blocked**. The blocked set is one
real `order_detail` without an available order ID and seven e-IPO tools whose handoff/prerequisite
is unavailable. There were **zero failed calls** in that final sweep. Watchlist/screener mutations
and chart browser checks were verified separately as described above.

## Remaining limitations

- Stockbit's virtual submit/amend/cancel success path needs a market-hours check. Activation was
  not repeated on an already active virtual account. Offline tests cover request construction,
  confirmation, rejection, ambiguous outcomes and exact read-back matching.
- No order detail was called with a fabricated ID when the real account had no orders.
- The authenticated e-IPO handoff endpoint returns 404. Dependent e-IPO reads remain unavailable;
  public `ipo_pipeline` information works. Real-money subscription capability is removed entirely.
- The underwriters directory endpoint returns 404; the explicitly scoped underwriter-code read
  works. These are different capabilities, and the server reports the directory failure plainly.
- Existing chart layouts/studies were not destructively replaced merely to exercise those tools.
  Browser study addition and low-level layout replacement remain covered by isolated fixtures;
  the controlled live check covers additive drawing, persistence and exact cleanup.
- ChatGPT needs its supported Secure MCP Tunnel or a properly secured remote deployment. The
  optional bearer-protected loopback HTTP endpoint is not a public OAuth deployment. Neither a
  ChatGPT tunnel nor a Claude account connection was installed during these tests.
- Private upstream APIs and account permissions can change. This build exposes its supported
  tools; it does not implement every Stockbit website action.
