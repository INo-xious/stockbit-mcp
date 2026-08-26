# ADR-0009 — The browser is the source of truth for the rotating token family

**Status: ACCEPTED 2026-08-26**, on the account owner's instruction that the server must survive
being used, and that the login command must stop hanging for fifteen minutes on an
already-signed-in browser. This record lands *before* the code it authorises, so the commits that
follow have something to be justified by; the Consequences below describe what those commits do, and
are written in the present tense of the decision, not of the tree at this commit.

## Context

`/login/refresh` rotates. Every successful call mints a new refresh token and retires the one
presented — Observed, and recorded in three places in this repo before this ADR existed. The lock in
`src/auth/reflock.ts` exists because two *processes* refreshing at once retire each other's
credential.

What none of that accounted for is that the **browser is a fourth process**, and it refreshes
without being asked. Every Chartbit tool goes through `withChart`, which opens a real Stockbit page
in a real profile. Loading that page boots Stockbit's SPA, and the SPA calls `/login/refresh` itself.
The family rotates: the browser now holds token N+1, and `refresh.enc` still holds N. The next REST
call presents N, gets a 401, and the user is told their session is gone and to log in again. This
fires on *every chart tool call*. No concurrency is required — one user, one process, one chart is
enough.

The rotated token was never out of reach. `withChart`'s `finally` block already re-captures the
browser session, and the blob it captures **contains** the new refresh token, inside the
`credentialStorage` cookie whose shape this project documented months ago:

```
{ "state": { "access": <JWT>, "refresh": <JWT>, "user": {…} }, "version": 0 }
```

The capture wrote that blob to `websession.enc` and stopped. Nothing in the codebase had ever read
`state.refresh` as a token; no parser for it existed. The credential that would have prevented the
lockout was being written to disk, encrypted, once per chart call, and never read.

The second failure has the same root. `stockbit-auth login` on an already-signed-in browser lands in
the app rather than on a form. No login response is ever issued, so nothing is captured, and after
fifteen silent minutes the command reports `Login timed out — no session captured.` Meanwhile the
browser sitting in front of the user holds a perfectly good credential in the cookie nobody reads.

So: which side of this is authoritative?

## Decision

**The browser is the writer; the store is the follower.** Not because the browser is more
trustworthy, but because it is the only side that can mint. Stockbit's JWTs carry a device binding —
`dvc` (device fingerprint) and `ses` (session id) inside the `data` claim — that the CLI's refresh
route does not reproduce. The store can spend the family; only the browser can start one.

**Only the browser → CLI direction is added.** The opposite direction was built, measured and
rejected, and the record of that sits in `src/auth/websession.ts` so it is not proposed again: a
token pair minted 0.6 seconds earlier, planted as all 16 cookies plus 53 localStorage keys into a
clean profile, is refused by the website — it redirects to `/login` and answers five requests with
401. Writing CLI tokens into `credentialStorage` does not extend the website session; it overwrites
a working one with credentials the site will not accept. This ADR adds the read, and does not weaken
that block.

**The ordering rule is not "the browser always wins."** A directional rule would walk the store
*backwards* in three cases this repo can already produce: `login --verify` and `bootstrap --verify`
call `forceRefresh()` *after* the capture, leaving the store legitimately ahead; `import-har` imports
a token of unknown vintage; and any second process refreshing while a chart is open. So the resync
compares, and refuses to guess:

```
if store absent           -> ADOPT (if it decodes and exp > now)
if identical              -> KEEP, write nothing
if browser exp <= now     -> KEEP, never adopt a dead token
if both have numeric iat  -> ADOPT iff browser.iat > store.iat
if both have numeric exp  -> ADOPT iff browser.exp > store.exp
if only browser decodes   -> ADOPT
otherwise                 -> KEEP, refuse to guess
```

The evidence under each rung differs and the code says so. That the refresh token carries `exp` is
**Observed** — `status` and `doctor` read it live today. That rotation issues a *fresh* window is
**Observed**. The step from "the window slides" to "`exp` orders issuance" is an **inference**, and
is labelled as one. `iat` is **unverified**, which is why it is preferred when both tokens carry one
and never required. `capturedAt` is not used at any rung: it records when the cookie was *read*,
never when the token was *issued*.

The empty-store rung earns its place alone. It recovers "the Keychain was wiped but the browser is
still signed in", which today forces a full interactive re-login for a credential that is sitting on
disk.

**A resync that cannot take the lock does nothing.** `doRefresh` proceeds without the lock because
its alternative is a guaranteed outage. Here the alternative is doing nothing, and doing nothing is
safe — the browser still holds a working token, and the next chart call will offer it again. Same
primitive, opposite policy, because the cost of being wrong is not the same. For the same reason the
resync never throws and never calls `resetSession`: rotating the refresh token does not invalidate
the access token, and dropping it would force exactly the refresh this is avoiding.

**Already-signed-in login becomes a three-tier ladder.** Harvest the credential out of
`credentialStorage` and succeed in about two seconds → if nothing usable is there, clear the
browser's own session and re-open the login page → and `--switch-account` skips the harvest tier
entirely and always clears first, because the whole point of it is to *not* reuse what is there.

**This server can clear the user's browser cookies.** That is a new power and it is written down
here rather than left implicit in a diff. It is bounded three ways: it happens only inside
`stockbit-auth login`, only on the pinned profile this project created, and only after a harvest has
already failed — except under `--switch-account`, where the user asked for it in the imperative. It
is done with `Storage.clearDataForOrigin` scoped to `https://stockbit.com` rather than
`Network.clearBrowserCookies`, so no `Network` or `Fetch` domain is enabled anywhere in this path.
ADR-0005 restricts the *Chartbit driver* to `Page` and `Runtime`, and `test/chartbit.test.ts` only
greps `src/chartbit/`, so `src/auth/` code would not trip it. Matching the restraint anyway is the
decision: the reason for the rule — this project does not enable the domains that read response
bodies unless it is capturing a login — applies just as much here.

**Widening `tokenUrlAllowed` to accept `/login/refresh` is rejected.** It looks like the natural fix
and is worse. The SPA's boot refresh fires on *every* page load, so `--switch-account` would capture
the **previous** account's token before the user had signed in as the new one. The cookie harvest
gets the identical token with none of that risk, because it reads *after* the app has landed
signed-in.

**`stockbit_web` cannot become a resync site.** `openUrl` is a detached `spawn` with
`stdio: "ignore"` and no debugging port, usually pointed at a different binary from the pinned login
profile — that is the entire purpose of `STOCKBIT_WEB_BROWSER`. Giving it a port would mean a *read*
tool that can read cookies out of the user's everyday browser, which is far beyond what ADR-0005
argued for.

## The access-token cache, and what it costs

Rotation makes N processes expensive: Claude Code, Claude Desktop, a daemon and a CLI each mint
their own access token, and each minting retires the previous credential. The fix is for them to
share one. `~/.stockbit/access.enc` holds the 24-hour access tokens, keyed by domain, AES-256-GCM at
`0600`, with its own salt — **one file, not three**, because three means three fsyncs for no benefit
and makes logout three truncations instead of one. It is deliberately not a fourth `StoreSlot`, for
the same reason the website session is not: a slot holds one JWT and the whole Keychain path is
built around that shape.

Two details are load-bearing and neither is obvious:

- **Double-checked locking is the whole feature.** Without it, two processes both miss the cache,
  both queue on the refresh lock, and the second refreshes anyway — a wasted rotation, which is
  precisely what the cache exists to prevent. `doRefresh` re-reads the cache *after* acquiring the
  lock and before issuing the request.
- **`forceRefresh` must clear the cache.** Without that line, the next `ensureFresh` re-hydrates the
  token that just 401'd, and the session 401s forever.

No lock guards the cache, and the reason is worth stating: a lost update here costs a cache miss; a
lost update on `refresh.enc` costs a forced re-login. The two are not the same kind of write and do
not deserve the same ceremony.

**The honest cost:** an access token is now written to disk, and this project's `SECURITY.md`
previously promised that no access token ever is. On Linux and Windows the protection is exactly
what already guards the refresh token — AES-256-GCM under `~/.stockbit`, `0600`, key derived from
machine and user. **On macOS this is a genuine reduction**, because there the refresh token lives in
the Keychain and this file does not. That clause is not softened anywhere it appears.
`STOCKBIT_NO_ACCESS_CACHE=1` turns both directions off for anyone who would rather pay the
rotations.

## What this still cannot answer

**Whether a stored refresh token is live.** You cannot prove it without spending it, and spending it
is the thing that breaks the user's website session. So this project stops inferring validity and
starts *recording* it: `~/.stockbit/session-health.json` (0600, plaintext, **no tokens**) keeps the
last refresh outcome per slot and a token **fingerprint** — `"sha256:"` plus the first eight hex
characters of a SHA-256 of the JWT. Eight hex characters is not a credential, is not JWT-shaped, and
is not reversible; it is exactly enough to tell *"the token that failed is the token you still
hold"* from *"it has been replaced since."* That distinction is what lets `status` report a revoked
token at **zero requests**, which nothing in this project could do before.

A `check: true` that spent one GET on an already-cached access token would prove liveness without
touching the refresh family — but whether revoking a session also kills its outstanding access
tokens is **unverified**, so such a tool would make a claim nobody has measured. It goes to
`docs/PENDING-VERIFICATION.md`, not into the surface.

## Consequences

- The refresh lock's wait and its staleness threshold must both exceed **2 × `requestTimeoutMs`**,
  because the 401 retry means a legitimate holder can hold for two full request timeouts. Raising
  one without the other breaks a slow-but-honest holder's lock out from under it. The arithmetic is
  derived in the code and asserted in `test/reflock.test.ts`, so changing `requestTimeoutMs` breaks
  a test rather than the behaviour.
- On macOS the credential is in the Keychain, which is machine-global, while the lock resolved under
  `$STOCKBIT_STORE_DIR` — so two clients configured with different store dirs took **different locks
  over one shared credential**. The lock path is now backend-aware. The file backend keeps its lock
  beside the file it guards, so every `STOCKBIT_FORCE_FILE_STORE=1` test is unaffected.
- `TokenStore` gains `readState(): "present" | "absent" | "unavailable"`. A locked or
  access-denied Keychain used to read as "no session", which sends a user to destroy a credential
  that was fine. `get()` is unchanged for every existing caller.
- A rotated refresh token that cannot be written is no longer thrown away. The in-memory access
  token is kept — it is valid for a day and the presented refresh token is already spent either way
  — and the rotated token is held in memory for this process's next refresh, with a warning that
  names what the user will have to do.
- `stockbit-auth status` stops rotating by default. `--verify` opts in; `--offline` stays as a
  no-op because `SECURITY.md` tells vulnerability reporters to paste its output. The `status` tool's
  description stops selling `live: true` as "one request to prove it still works" and says what it
  actually does: it rotates the refresh token and ends the website session.
- `logout` through the MCP tool now clears the website session. It did not, while its own
  description called the browser profile "a SECOND copy of the session" — so a logout left a
  working, decryptable Stockbit session on disk. A logout that leaves a usable credential is not
  one.
- The macOS Keychain write stops passing the token as a process argument, where `ps` exposes it to
  every process running as the same user and bypasses the Keychain ACL that would otherwise prompt.
  The argv form is kept as a recorded fallback, and `doctor` reports which one worked.
