# Stockbit MCP

Stockbit market data, analysis, chart drawing, read-only brokerage portfolios, and simulated trading
for Claude, ChatGPT and other MCP clients. Unofficial and unaffiliated with Stockbit or IDX.

**This build cannot execute real-money trades.** Real buy, sell, amend, cancel and e-IPO subscription
tools and their HTTP routes have been removed. Deposits and withdrawals are not supported. Old
`live` settings fail closed; there is no switch to restore live execution. This is a technical
boundary, not a claim of OJK approval or a legal compliance certification.

[Bahasa Indonesia](README.id.md) · [Tool reference](docs/TOOLS.md) ·
[Client setup](docs/CLIENTS.md) · [Security](SECURITY.md) · [Verification](docs/VERIFICATION.md)

## Build and sign in

Use **this checkout** or verified **1.4.1 or later** release artifacts. The 1.3.1 npm package does
not contain these changes; the earlier `v1.4.0` GitHub tag also points to a 1.3.1 package manifest.

```bash
npm ci
npm run build
node dist/bin/stockbit-auth.js login
node dist/bin/stockbit-auth.js status
```

Requires Node.js 22+ and a Chromium-family browser for login and interactive chart drawing. Sign in
on Stockbit's own page; passwords and OTPs are never requested through an assistant. Credentials are
saved locally in the OS Keychain, or an encrypted file fallback. A browser session and the API
session are separate; `status` explains which one needs attention.

## Connect a client

Claude Desktop's `claude_desktop_config.json` can launch the built server:

```json
{
  "mcpServers": {
    "stockbit": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/stockbit-mcp/dist/bin/stockbit-mcp.js"],
      "env": {
        "STOCKBIT_MCP_TRANSPORT": "stdio",
        "STOCKBIT_TOOLS": "core,chartbit,virtual"
      }
    }
  }
}
```

Use `command -v node` (PowerShell: `(Get-Command node).Source`) to find Node's path, and replace both example paths. Restart the client after
changing its config. `STOCKBIT_TOOLS=all` exposes the complete supported tool set; `core` is the
smaller default. Profiles select capabilities, not permission to move real money.

You can also build a local Claude Desktop extension with `npm run build:mcpb`. See
[client setup](docs/CLIENTS.md) for installation and profile selection.

For ChatGPT, use its supported Secure MCP Tunnel or a properly secured remote MCP deployment.
The stdio server does not become accessible to ChatGPT by pasting a local file path into a connector.
[Client setup](docs/CLIENTS.md) explains current requirements, the optional local HTTP transport,
and what remains a deployment step.

## Capabilities

| Task | Tools / family |
| --- | --- |
| Quotes, orderbook, movers, market hours, trade tape | `market` |
| Broker accumulation, distribution, flow | `bandarmology` |
| Indicators, patterns, strategy comparison, backtests, scans | `analysis` |
| Fundamentals, ownership, insiders, corporate actions, IPO information | `fundamentals`, `company`, `insider`, `corpaction`, `eipo` |
| News, Stockbit posts and research reads | `stream` |
| Watchlists and saved screens, including edits | `account`, `screener` |
| Read, draw, inspect, screenshot and save Stockbit charts | `chartbit` |
| Real portfolio, positions, cash and order history — reads only | `portfolio`, `position`, `cash_balance`, `orders`, `order_history` |
| Stockbit website's simulated account | `virtual_*` |
| Separate local simulated ledger | `paper_*` |
| Local alerts, Pine scripts and saved read workflows | `alerts`, `pine`, `workflows` |

This is the supported API surface, not a promise that every feature on Stockbit's website has an
equivalent tool. Feature entitlements, undocumented upstream changes, login and browser availability
can limit individual tools. Evidence labels distinguish observed responses from projected mappings;
an unrecognised account value stays absent instead of becoming zero.

## Portfolio and simulations are separate

Real brokerage reads require a securities session. Unlock it yourself at your terminal:

```bash
node dist/bin/stockbit-auth.js trading-login
```

The PIN is entered locally and never stored or passed to an MCP tool. Unlocking the session does
not enable trading: this build has no real order submission route.

`virtual_*` uses Stockbit's website virtual account with the ordinary Stockbit login. It is distinct
from the real portfolio and from the local paper ledger. Only routes under `/virtualtrading/` may
submit those simulated orders. Read each tool's verification caveats before relying on its result.

For the independent **local paper ledger**:

```bash
node dist/bin/stockbit-auth.js trading-enable --paper
```

Use `paper_order_preview`, review the ticket, then the matching `paper_order_buy`, `paper_order_sell`,
`paper_order_amend` or `paper_order_cancel`. Inspect `paper_portfolio` and `paper_orders` for simulation
results. `portfolio` always reads the real brokerage portfolio, even when local paper mode is enabled.

## Chart drawing

Enable the `chartbit` family and sign in using the saved browser profile. A typical flow is
`chartbit_open` → `chartbit_shapes` → `chartbit_draw` → `chartbit_screenshot` → `chartbit_save`.
Get the matching layout ID from `chartbit_layouts` and pass it to `chartbit_save` for a scoped
persistence check. Without enough layout metadata, the save result reports verification as unknown.
Read existing drawings first. Clear only server-created shapes with `scope: "ours"`; deleting all
shapes or replacing a saved layout requires explicit confirmation. Save paths verify persistence
against Stockbit's stored layout/drawings.

Example requests: “Analyze BBRI and draw its support and resistance,” “Show my portfolio,”
“Compare broker flow for BBRI and TLKM,” or “Show my Stockbit virtual orders.”

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run docs:tools
npm run smoke
npm run check:pack
```

After login, run the reusable read-only MCP sweep:

```bash
npm run verify:tools -- --live
```

It inventories every registered tool and records passed reads, upstream failures, missing
prerequisites, and mutations/browser actions needing controlled scenarios. It never places orders,
edits account state or opens a browser. Its report is stored under ignored `.stockbit/` and contains
no response payloads. `--only quote,analyze` narrows a follow-up check. The isolated test suite covers
mutation guards and simulated write scenarios without touching an account.

The API is private and may change. This project does not provide investment advice or assurance that
automated access is permitted by Stockbit's terms. See [security boundaries](SECURITY.md) and the
[verification record](docs/VERIFICATION.md) for practical limits.
