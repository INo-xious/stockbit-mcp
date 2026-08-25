# Documentation

Start at the [README](../README.md). This is everything else.

## For users

| | |
|---|---|
| [**User guide**](FEATURES.md) | Every feature, what it returns, and what to ask for. The long version of the README's tour. |
| [**Tool reference**](TOOLS.md) | All 138 tools, generated from the running server — family, evidence, arguments. Never stale: a test fails if it is. |
| [**Trading**](trading.md) | Paper mode, the live switches, the ticket protocol, the outcome table. |
| [**Chart drawing**](chartbit-drawing.md) | Reading and drawing on your real Stockbit chart. |
| [**Testing the login**](TESTING-LOGIN.md) | What the browser capture does, and what to do when it will not. |

## What is known, and what is not

| | |
|---|---|
| [**Verification status**](VERIFICATION.md) | The evidence ladder, what each family is, what was compared against what, and how to settle a projection. |
| [**Pending verification**](PENDING-VERIFICATION.md) | What is still guessed, in the order of what goes wrong if the guess is wrong. |

## Installing it somewhere

The [README](../README.md) has copy-paste config for each client. The manifests behind them:
`server.json` (MCP Registry), `.claude-plugin/` plus `.mcp.json` (Claude Code plugin, which also
ships the six skills under [`skills/`](../skills/)), and `mcpb/manifest.json` (Claude Desktop
Extension, built by `npm run build:mcpb`). All four repeat the version number, and
`test/distribution.test.ts` fails when they stop agreeing.

## For developers

| | |
|---|---|
| [**CONTRIBUTING**](../CONTRIBUTING.md) | Setup, the three invariants, what a pull request needs. |
| [**CONTEXT**](../CONTEXT.md) | The glossary. One meaning per word. |
| [**Decision records**](adr/README.md) | Every decision that changed what this server may do. |
| [**Stockbit API reference**](stockbit-api.md) | The reverse-engineered surface: hosts, auth, routes, response shapes. Unofficial. |
| [**SECURITY**](../SECURITY.md) | What to report, how, and where credentials live. |

## Historical

[`research/`](research/) holds the investigations this project came out of — a session log, a
capability sweep, and the recovery of Chartbit's layout format. They are kept as a record of how
things were found out, not as current guidance, and each carries a banner saying so.
