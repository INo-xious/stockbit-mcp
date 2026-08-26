# Architecture decision records

One file per decision that changed what this server is allowed to do. Each records the context, the
decision, and what it cost — not a specification. Read them when a change would cross a boundary
one of them drew.

**Numbering starts at 0002.** The first decision — the closed route table, which is what makes every
later ADR enforceable — is recorded in the code that enforces it, `src/http/transport.ts`. 0001 stays
unassigned rather than back-filled.

| ADR | Decision | Status |
|---|---|---|
| [0002](0002-daemon-is-the-product-server-stays-read-only.md) | The watch daemon is the product; the server stays read-only | ACCEPTED 2026-08-05 — daemon-first stands; the read-only posture is superseded by 0003–0006 |
| [0003](0003-chartbit-writes.md) | Chartbit layout writes, with snapshot, verify and rollback | ACCEPTED and implemented (amended twice: the per-symbol routes are a server-side stub, real persistence is `/chartbit/charts`) |
| [0004](0004-order-entry.md) | Order entry: off by default, two-step tickets, a human in the middle | ACCEPTED and implemented — never observed against a live brokerage session |
| [0005](0005-browser-driven-chartbit.md) | Drawing on the user's chart through their own browser over CDP | ACCEPTED and implemented |
| [0006](0006-account-writes.md) | Watchlist and screener edits — nine tools, read back after every write | ACCEPTED and implemented |
| [0007](0007-auth-tools-in-the-server.md) | `status`, `login` and `logout` as tools; the PIN and the trading switch stay terminal-only | ACCEPTED 2026-08-24 |
| [0008](0008-paper-trading.md) | Paper trading: three modes, not two; the same order protocol against a local ledger | ACCEPTED 2026-08-24 |
| [0009](0009-browser-is-the-source-of-truth.md) | The browser is the source of truth for the rotating token family; the store follows it | ACCEPTED 2026-08-26 |

## Writing a new one

Any change that adds a **non-GET route** to `src/http/routes/` needs an ADR before the code lands —
that is the rule `test/transport.test.ts` exists to keep honest. Say what the route does, why the
existing surface could not do it, what happens when it fails halfway, and how a caller finds out.
Use the vocabulary in [`CONTEXT.md`](../../CONTEXT.md).
