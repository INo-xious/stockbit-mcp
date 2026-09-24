# ADR-0012 — Remove real-money execution permanently

**Status: ACCEPTED 2026-09-24**, on the account owner's instruction to remove buying,
trading and other operations involving real money while retaining portfolio access
and virtual trading. This supersedes ADR-0004's permission to submit real orders,
ADR-0008's live mode, and the real-money portions of ADR-0010.

## Decision

The server cannot submit, amend or cancel brokerage orders, or commit e-IPO
subscriptions. The four Carina order POST routes and both e-IPO order and verify
POST routes are removed from the closed route table. The code that issued those
requests is removed, as are their MCP registrations. Authentication POST routes
remain solely to permit reading the securities account and existing e-IPO data.

There is no replacement switch: `--live` and automatic-confirmation CLI flags are
rejected, the settings schema supports only `off` and `paper`, and old `live` or
`enabled: true` settings are read as `off`. An environment variable cannot restore
the capability. Upgrades never silently reinterpret an old real-money permission
as a simulated trade.

Brokerage `portfolio`, positions, balances, orders and history always read the
actual securities account, regardless of the paper-simulation setting. The local
simulator has explicit `paper_*` names and a PAPER ACCOUNT banner. Its orders are
stored only in a local ledger. This simulator is not Stockbit's hosted virtual
trading account; that integration needs separately named tools and its own ADR.

The local simulator retains expiring, single-use preview tickets, caller consent,
decisive MCP elicitation and an audit log. These protect the integrity of the local
simulation; they do not authorize a securities request. Simulation fills remain
approximate and their limitations stay visible.

## Consequences and verification

Clients using the removed `order_*` or `eipo_order*` tools must update their tool
selection. The server has no aliases redirecting a real-order name to a simulation.
Only explicitly named `paper_order_*` tools can change the local ledger.

Offline regression tests verify old settings and environment permutations remain
off, the CLI rejects live-enablement flags, e-IPO exposes only reads, and real
portfolio reads cannot be redirected into the paper ledger. Existing numerical,
privacy, ticket, elicitation and paper-ledger tests remain. Tests that asserted
successful real-order submission are replaced by absence/refusal tests because
that capability no longer exists.

This is a product capability boundary, not a determination of regulatory status.
