# stockbit-mcp

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for **Stockbit**
(Indonesian / IDX market data) — broker summary / *bandarmology*, quotes, top movers, orderbook,
fundamentals, and sentiment. It talks to the same JSON backend the Stockbit apps use, with **your
own** session. It never places or modifies orders.

> ⚠️ **Unofficial.** Not affiliated with, endorsed by, or associated with Stockbit or TradingView.
> Automated access may conflict with Stockbit's Terms of Use — you use this at your own risk on your
> own account. Data is delayed/unofficial and is **not** financial advice.

## Why an HTTP client (not desktop automation)

Stockbit Desktop is a **Tauri (WKWebView)** app — the Chrome-DevTools approach used by TradingView
MCPs doesn't apply, and isn't needed: the desktop app is a thin client over
`https://exodus.stockbit.com`. This server is just another client of that API. See
[`STOCKBIT-API.md`](./STOCKBIT-API.md) for the full reverse-engineered surface.

## Auth model

- One credential: a bearer **access token** (24h), minted from a **refresh token** via
  `POST {exodus}/login/refresh` (refresh token in the `Authorization` header; no reCAPTCHA on refresh).
- Initial login is OAuth + reCAPTCHA gated, so a human logs in **once**. `stockbit-auth login` drives
  your own browser over the DevTools Protocol (no extra browser download — Node 24's built-in
  WebSocket) and captures the refresh token from the login response automatically.
- The refresh token is stored in the **macOS Keychain** (AES-encrypted file fallback elsewhere).
  Access tokens are never written to disk. All logs/errors are secret-redacted.

## Setup

```bash
npm install
npm run build

# One-time login. Opens your existing Chrome/Edge/Brave; log into Stockbit normally and the
# session is captured automatically — no DevTools, no copy-paste.
node dist/bin/stockbit-auth.js login
node dist/bin/stockbit-auth.js status   # check backend + expiry
node dist/bin/stockbit-auth.js doctor   # diagnose browsers + the capture path
```

`doctor` checks every stage the login depends on and reports each separately, including a
**self-test that runs the real capture against a local fixture serving its token from a
self-closing popup** — no account, credentials, or open market required. See
[`docs/TESTING-LOGIN.md`](./docs/TESTING-LOGIN.md).

> ⚠️ **Google / Facebook login does not work on Stockbit's website** — in any browser, with or
> without this tool. Their login page still loads `gapi.auth2`, the Google Sign-In platform Google
> retired, and never migrated to Google Identity Services; the button opens a popup that renders
> nothing. **Use username + password.** This is upstream of anything this project can reach.

On macOS, the first login may ask once for permission to update the `stockbit-mcp` Keychain item.
The server does not grant unrestricted Keychain access, and subsequent token rotations should not
reset the item's access permissions.

After this single login, the server auto-refreshes indefinitely — you won't log in again until the
refresh token itself expires. The one interactive login is unavoidable (Stockbit's OAuth + reCAPTCHA
require a human once); only the *token handling* is automated away.

**Fallback — any browser.** `login` drives a Chromium-family browser over CDP. Firefox removed CDP
in v141 and Safari exposes no reachable debugging protocol to third parties, so for those, log in
however you like and import the network log instead:

```bash
node dist/bin/stockbit-auth.js import-har login.har --shred
```

Turn on **Preserve log** in DevTools before logging in, and export with the **download** button —
Chrome's "Copy all as HAR" omits response bodies. A login HAR contains your password, cookies and
the token in plain text, so `--shred` deletes it after import; the command warns you if you don't.

Or paste a refresh token manually — input is hidden:

```bash
node dist/bin/stockbit-auth.js bootstrap
```

### Quick test without a refresh token

If you can only grab the 24h **access** token (the `Bearer eyJ…` on any `/marketdetectors` request),
run in access-token-only mode — no refresh, stops working at expiry, good for a smoke test:

```bash
STOCKBIT_ACCESS_TOKEN='eyJ...' node dist/bin/stockbit-mcp.js
```

For hands-off operation, bootstrap a refresh token instead (above). The refresh token is in the
**response body** of a fresh login (log out → log in with DevTools Network open, filter `login`),
not in a request header.

### MCP client registration

Register with your MCP client (e.g. Claude Desktop `mcpServers`):

```json
{
  "mcpServers": {
    "stockbit": { "command": "node", "args": ["/absolute/path/to/dist/bin/stockbit-mcp.js"] }
  }
}
```

## How this compares

Two good MCP servers exist for TradingView: [atilaahmettaner/tradingview-mcp](https://github.com/atilaahmettaner/tradingview-mcp)
(screener + backtesting, Python) and [tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp)
(drives the TradingView desktop app over the Chrome DevTools Protocol). Neither covers IDX in any
depth, and neither has broker-flow data at all.

| | atila | tradesdontlie | **stockbit-mcp** |
|---|---|---|---|
| **Broker-to-broker flow (*bandarmology*)** | — | — | ✅ *nobody else has this* |
| IDX coverage | thin | thin | ✅ native |
| Backtesting + walk-forward | ✅ | — | ✅ |
| Candlestick patterns | ✅ | — | ✅ |
| Multi-timeframe | ✅ | — | ✅ (daily→weekly→monthly; see the caveat below) |
| Universe scan | ✅ | — | ✅ |
| Pine generation | — | ✅ | ✅ |
| Chart rendering | — | ✅ (screenshots) | ✅ (SVG, no browser) |
| Alerts | — | ✅ | ✅ + a standalone daemon |
| Drives a desktop app | — | ✅ | — *deliberately: see below* |
| Needs a running desktop app | — | ✅ | — |

**Why no desktop automation.** Stockbit Desktop is a Tauri/WKWebView app, so the CDP approach does
not apply — and it is not needed, because the desktop app is a thin client over the same JSON API
this server talks to. Writing chart drawings back to Stockbit was attempted, measured across nine
variables, and found to be a server-side no-op: their own web bundle has no save path either. That
is recorded in `docs/SESSION-2026-08-05.md` rather than quietly dropped.

## Tools

**Bandarmology** — the thing no other MCP has.

| Tool | What it returns |
|---|---|
| `broker_summary` | Net buyers/sellers per broker (lots + IDR + foreign/local/govt). Optional `from`/`to` query any historical window — the server aggregates net flow across it in a single request. |
| `broker_distribution` | Broker-to-broker flow, **always an SVG diagram** written to `~/.stockbit/charts/`, laid out buyer → seller like Stockbit's own view. Each seller bar is that seller's true total. Returns the picture, not a table. Requires a Stockbit balance of Rp 10,000,000. |

**Strategy & analysis**

| Tool | What it returns |
|---|---|
| `backtest` | Every trade a strategy would have taken, an equity curve, and metrics against buy-and-hold over the **same** window. Next-bar fills, stops win ties, gaps fill at the open, ARA/ARB-locked sessions cannot be filled. Optional walk-forward. Read `warnings` before quoting a number. |
| `strategy_compare` | All nine built-in strategies over one history — one bar fetch — ranked by return *above* buy-and-hold. |
| `technicals` | Indicator readings plus support/resistance from pivot clustering. |
| `patterns` | 16 candlestick formations, each with the prior trend it was read against. `confidence` scores the shape, not the outcome. |
| `timeframe_alignment` | Whether daily, weekly and monthly agree — and, in `limits`, exactly what the data cannot support. |
| `scan` | One condition across many symbols. Misses distinguish "condition false" from "not enough history yet". |
| `price_chart` | Candles + volume + overlays + RSI/MACD panels + annotations, as SVG. No browser involved. |
| `pine_script` | TradingView Pine v6, with Stockbit-derived levels embedded as constants. |

**Alerts** — `alert_create`, `alert_list`, `alert_delete`, `alert_check`, plus a standalone
`stockbit-alerts` daemon (an MCP server only lives while a client holds it open).

**Market data** — `quote`, `orderbook`, `price_bands` (ARA/ARB + foreign flow), `intraday_prices`,
`price_performance`, `top_movers`, `trending`, `sectors`.

**Fundamentals** — `keystats`, `ratios`, `financials`, `sentiment_stream`.

**Chart state** — `chart_layout`, `chart_settings`, `stockbit_web`, and `chart_layout_save` (the one
write, confirm-gated).

**Workflows** — `workflow_list` / `workflow_run`: seven recipes including `deep_dive`,
`bandar_watch`, `strategy_check` and `screen_and_dive`.

### One grammar, three consumers

`sma20 crosses above sma50` means exactly one thing here. The same condition is evaluated locally to
fire an alert, replayed over history by the backtester, run across a universe by `scan`, and emitted
as Pine for TradingView — all from one registry (`src/analysis/series.ts`) that carries each
indicator's Pine expression and its local implementation side by side. Written twice, those drift:
one gets a Wilder-smoothed RSI and the other a simple one, and then the alert fires on a day the
chart says it should not have.

### What this data cannot do

Stated here rather than discovered at run time:

- **Daily bars only.** Weekly and monthly are resampled from them. There is no 4H/1H/15m OHLC — the
  intraday feed is a minutely *close-only* series for the current session.
- **~500 sessions (about two years).** That is ~104 weekly and ~24 monthly bars, so a monthly
  RSI(14) is reported as `null` rather than computed from a window that has not converged.
- **Scans cost real time.** Throughput caps at roughly 6.6 upstream requests a second, so a
  20-symbol moving-average screen takes ~15s and anything using `sma200` takes ~50s. Bar pages are
  cached for six hours once settled, so a second scan over an overlapping universe is far cheaper.
- **Walk-forward will usually say `inconclusive`** on real data, because three folds over two years
  yields single-digit trade counts. That is the honest answer, not a bug.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test (redaction, error mapping, refresh rotation, schema drift)
npm run dev:mcp     # run from source via tsx
```

## Status / roadmap

v1 is read-only MCP tools. The `src/core/` layer is intentionally UI-agnostic so a CLI and a
**watch/alert daemon** (the two-stage broker-summary → intraday screener) can be added as v2 without
touching the data layer.

> **Refresh contract** (confirmed via source + live endpoint probe): the main/session token renews at
> `POST {exodus}/login/refresh` with the refresh token in the `Authorization: Bearer` header and an
> empty body (see `STOCKBIT-API.md` §3).
>
> **Rotation: CONFIRMED** against a live account (2026-08-03). Each refresh mints a **new** refresh
> token with a fresh 7-day expiry, which `parseRefresh` + the store persist immediately. So the
> single interactive login really is one-time *provided the server runs at least weekly* — the
> expiry keeps sliding forward. Go idle past the window and a re-login is required.
