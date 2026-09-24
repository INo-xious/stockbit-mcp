# CLAUDE.md

Notes for an AI assistant working on this repository. Human contributors want
[`CONTRIBUTING.md`](CONTRIBUTING.md), which this does not duplicate.

## What this is

An MCP server over Stockbit's private JSON API. Real-money execution is removed. Brokerage
portfolio and history are read-only; paper_* is the local ledger and virtual_* is Stockbit's
website simulation. Never add a live-order, subscription, deposit or withdrawal route. The generated
`docs/TOOLS.md` is the authoritative tool inventory.

## Commands

```bash
npm run typecheck     # src/, bin/, scripts/
npm test              # the whole suite, offline, no skips
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
| `src/http/routes/` | The closed route table — Explicit request shapes. The security boundary. |
| `src/http/transport.ts` | What enforces it. |
| `src/auth/` | Login capture, three token stores, refresh with a cross-process lock. |
| `src/core/` | One module per Stockbit domain. The readers everything else stands on. |
| `src/analysis/` | Indicators, patterns, strategies, backtests, scans, position sizing. |
| `src/render/` | Pure SVG. No browser. |
| `src/tools/` | MCP registration, one module per family. `_define.ts` is the door. |
| `src/trading/`, `src/eipo/`, `src/virtual/` | Read-only accounts and explicitly separated simulations. |
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
- **Never widen an evidence claim.** Every tool DECLARES its evidence — `{ evidence }` on the tool
  or on `define.family()` — and one that declares nothing fails to register rather than defaulting
  to `observed`. A description that says the route has never been observed while the declaration
  claims more throws at registration. The full map is hand-written in `test/tools.test.ts` beside
  `WRITES`, and for the same reason. Settling one takes a live call, not an edit.
- **Never write a secret anywhere.** Tokens, PINs and bot tokens are matched by shape as well as by
  key. When adding an error path, ask what the message could contain: a `fetch` failure quotes the
  URL, and a Telegram URL contains the bot token.
- **The tests are offline.** `fetch` is stubbed; every test file sets `STOCKBIT_FORCE_FILE_STORE=1`
  and a temp `STOCKBIT_STORE_DIR` *before* its imports, because module state is captured at import.
- **Fixtures carry no real data.** No real account numbers, names or watchlists.
- **No AI co-author trailers in commits.** Never commit on `main`; use a task branch.

## Vocabulary

[`CONTEXT.md`](CONTEXT.md) is the glossary — one meaning per word, and the code uses those words.
The evidence ladder (**Observed / Read-back / Projected**) is load-bearing, not decoration.

## Execution boundaries

Real-money routes and execution modules have been removed. Historical order-entry ADRs are
superseded by ADR-0012. Local paper orders still require preview tickets, and simulated Stockbit
orders may only use the virtual route allowlist. Never claim a simulation reached the exchange.
Unknown write outcomes must never be automatically retried. No tool accepts a trading PIN.
