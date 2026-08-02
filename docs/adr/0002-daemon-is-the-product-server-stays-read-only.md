# The watch daemon is the product; the server stays read-only

The project was framed as workflow parity with `tradesdontlie/tradingview-mcp`, which drives a chart
GUI because TradingView exposes no usable data API. Stockbit is the opposite — a clean JSON backend
we already read directly — so GUI-shaped capabilities solve a problem we do not have. We are instead
committing to the differentiator an MCP server structurally cannot provide: an alert daemon that
wakes the user up. Chartbit Drawing writes move to a late, optional increment.

## The invariant, stated correctly

An earlier draft of this ADR claimed the server "cannot issue a write at all." That is false:
`src/auth/session.ts:162` POSTs to `/login/refresh`, and notification delivery is outbound HTTP by
definition. Method-level GET-only was never the real property.

The actual invariant is **no mutation of Stockbit account data**, enforced by an exact
host + method + path policy rather than by method alone. Exactly two authenticated request shapes
are permitted:

1. `GET` on the enumerated market-data routes on `exodus.stockbit.com`.
2. `POST https://exodus.stockbit.com/login/refresh`, the sole write, which mutates session state
   only.

Everything else — including any `/chartbit/*` write and any request carrying the Stockbit bearer to
a host not on the list — is rejected at the HTTP boundary, not by convention. Redirects are not
followed on authenticated requests: a 3xx that relocates a bearer-carrying request off an approved
origin is a rejection, not a hop.

**If M0 selects a streaming tick source**, the policy extends rather than bends: the WebSocket
handshake origin joins the approved list explicitly, and outbound frames are restricted to a typed
subscribe/unsubscribe allowlist. A socket that can carry arbitrary RPC re-opens exactly the
account-mutation surface this ADR closes, so a source that cannot be constrained that way is
rejected as a source.

Outbound notification delivery is a separate, non-Stockbit path and never carries the Stockbit
bearer; its own origins are pinned independently.

## The policy must be unbypassable, not merely present

A permitted-route test proves the policy accepts the right list; it does not prove every request
goes through the policy. `src/auth/session.ts:163` already calls `fetch` directly with a bearer,
outside `src/http/client.ts` entirely — so today the boundary has a hole that a route test would
pass straight over.

Therefore: **exactly one module constructs an authenticated request.** The refresh call moves inside
it as a declared route rather than remaining a special case, and CI rejects any other site that
builds an `Authorization` header or calls `fetch` with a Stockbit host. A boundary that can be
sidestepped by writing ordinary code is a convention, not a control.

## Consequences

- The policy is code, with a test asserting the permitted set *and* a check that no other call site
  can issue an authenticated request — so "we only read" fails CI when violated rather than being a
  claim in a README.
- This deletes the write-safety apparatus from near-term scope: PUT/DELETE support, route
  allowlists, blocked-route tables, read-before-write content hashes, post-write verification,
  in-memory rollback, confirmation tokens, and mutation logs.
- Chartbit *reads* remain desirable and carry no write surface — an agent seeing the user's existing
  markup is useful analysis context.
- If Chartbit writes are ever picked up, that increment must reintroduce the apparatus above as a
  whole. It is not a feature flag; it is a change of posture, and it supersedes this ADR.
