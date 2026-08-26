# CLAUDE.md

Notes for an AI assistant working on this repository. Human contributors want
[`CONTRIBUTING.md`](CONTRIBUTING.md), which this does not duplicate.

## What this is

An MCP server over Stockbit's private JSON API — the Indonesian exchange. 138 tools in 17 families
(40 of them registered by default — `STOCKBIT_TOOLS` defaults to `core`),
three token domains, and, behind switches the account owner turns on themselves, order entry against
a real brokerage account.

## Commands

```bash
npm run typecheck     # src/, bin/, scripts/
npm test              # ~1,160 tests, offline, no skips
npm run build         # cleans dist/ first
npm run smoke         # starts the built binary over stdio and asks it what it registered
npm run check:pack    # asserts npm publish would ship the build and nothing else
npm run docs:tools    # regenerates docs/TOOLS.md — run it after touching ANY tool
```

The full gate before a commit is all six. CI runs them on three operating systems and two Node
versions.

## The map

| Path | |
|---|---|
| `src/http/routes/` | The closed route table — 153 request shapes. The security boundary. |
| `src/http/transport.ts` | What enforces it. |
| `src/auth/` | Login capture, three token stores, refresh with a cross-process lock. |
| `src/core/` | One module per Stockbit domain. The readers everything else stands on. |
| `src/analysis/` | Indicators, patterns, strategies, backtests, scans, position sizing. |
| `src/render/` | Pure SVG. No browser. |
| `src/tools/` | MCP registration, one module per family. `_define.ts` is the door. |
| `src/trading/`, `src/eipo/` | Tickets, previews, submission, the paper ledger. |
| `src/alerts/` | Rules, the daemon, delivery. |
| `docs/adr/` | Every decision that changed what this server may do. |

## Three invariants. Do not break them; each has a test.

1. **Nothing reaches a Stockbit host outside `src/http/routes/`.** Adding a **non-GET** route
   requires an ADR *before* the code lands. `test/transport.test.ts`.
2. **`define.write` never adds to the handler map** `workflow_run` reads. A saved recipe is data,
   and data must not be able to place an order. `test/tools.test.ts`.
3. **No module under `src/tools/`, `src/trading/` or `src/eipo/` may import `saveSettings`.** A
   server that can widen its own permissions has no permissions. `test/settings.test.ts`.

## Rules that are easy to get wrong

- **Run `npm run docs:tools` after touching a tool.** `docs/TOOLS.md` is generated and a test fails
  if it is stale.
- **Add a new write tool's name to `WRITES` in `test/tools.test.ts`.** That list is deliberately
  hand-written; deriving it would make the test agree with the code.
- **Never invent a number.** If a field could not be read, it is absent — not zero, not a default.
  `readFrom` names the wire key a value came from; `unmappedKeys` names what was not recognised, and
  on account data the *values* are dropped because an unmapped field there may be an account number.
- **Never widen an evidence claim.** A tool whose description says the route has never been observed
  is `projected`, and saying otherwise throws at registration. Settling one takes a live call, not
  an edit.
- **Never write a secret anywhere.** Tokens, PINs and bot tokens are matched by shape as well as by
  key. When adding an error path, ask what the message could contain: a `fetch` failure quotes the
  URL, and a Telegram URL contains the bot token.
- **The tests are offline.** `fetch` is stubbed; every test file sets `STOCKBIT_FORCE_FILE_STORE=1`
  and a temp `STOCKBIT_STORE_DIR` *before* its imports, because module state is captured at import.
- **Fixtures carry no real data.** No real account numbers, names or watchlists.
- **No AI co-author trailers in commits.** Commit on `marvel-testing`, never on `main`.

## Vocabulary

[`CONTEXT.md`](CONTEXT.md) is the glossary — one meaning per word, and the code uses those words.
The evidence ladder (**Observed / Read-back / Projected**) is load-bearing, not decoration.

## Where the money is

`src/trading/` and `src/eipo/`. If a change touches the ticket protocol, the confirmation gates, the
outcome classes or the settings file, read [ADR-0004](docs/adr/0004-order-entry.md) and
[ADR-0008](docs/adr/0008-paper-trading.md) first. The rule those encode: a user must never be able to
place an order they did not read, and the server must never say "placed" when it does not know.
