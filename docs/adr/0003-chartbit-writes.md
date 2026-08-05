# ADR-0003 — Chartbit writes

**Status: ACCEPTED and implemented**, on the account owner's explicit instruction ("enable the
write"). It supersedes ADR-0002's "no mutation of account data" for exactly one route.

The sentence this ADR carried while it was proposed is kept, because it is the reason it stayed
proposed for as long as it did: a goal-completion check, a task runner, an automated reviewer, or an
assistant's own reasoning that a feature "should" be finished are none of them an instruction from
the account owner. A **fourth** ADR would be needed for any further write, and the same rule applies
to it.

ADR-0002 says a Chartbit write increment "must reintroduce the apparatus above as a whole. It is not
a feature flag; it is a change of posture, and it supersedes this ADR." This is that increment,
written before it is enabled so the decision can be judged rather than discovered in a diff.

## What is being proposed

One route: `POST {exodus}/chartbit/{symbol}/layout`, body `{ content }`, where `content` is the
value produced by `encodeLayoutForSave` in `src/core/layoutcodec.ts`.

That is a second non-GET route. `test/transport.test.ts` currently asserts `POST /login/refresh` is
the *only* one, and that assertion is the tripwire — accepting this ADR means deliberately editing
it, which is the point.

## What it actually does to the user

It **overwrites** the saved chart for that symbol. There is no merge, no versioning, and no undo on
Stockbit's side. Whatever the user had drawn is replaced by whatever is sent.

The blast radius today is small and that is luck, not design: every layout on this account is empty,
so there is nothing to destroy. That will stop being true the first time the user draws something,
and the apparatus below has to be in place before then, not after.

## Required before the route exists

Not negotiable individually — the value is in having all of them.

1. **Read-before-write snapshot.** `GET .../layout` first, persisted to disk with a timestamp under
   `~/.stockbit/layout-backups/`. A write that cannot snapshot does not proceed.
2. **Explicit per-call confirmation.** A required `confirm: true` argument, defaulted to nothing.
   Never an environment variable or a config file — those get set once and forgotten, and the whole
   risk here is a write nobody meant to make.
3. **Post-write verification.** Read the layout back and compare against what was sent. The codec's
   round-trip test exists precisely so this comparison is meaningful.
4. **Rollback on mismatch.** If verification fails, restore the snapshot and report both states. An
   unverified write that is left in place is worse than a failed one.
5. **Mutation log.** Append-only JSONL: timestamp, symbol, bytes before and after, snapshot path,
   verification result. The same reasoning as the alert log — a mutation nobody can audit is a
   mutation nobody can trust.
6. **Refusal to write a layout we did not compose or read.** `isPlausibleLayout` at minimum, and a
   hard stop on the `encodeLayoutForSave` corruption check, never `allowLossy` by default.

## What is still unknown, and why it matters here

Composing brand-new drawings needs the TradingView line-tool schema — what `state` a
`LineToolHorzLine` expects. Stockbit serves the charting library only to an authenticated chart
page, so it has not been read. Until it is, the honest scope of a write is:

- **round-trip** a layout unchanged (verifiable today), and
- **modify** an existing layout's fields (theme, timezone).

It is *not* "draw a trendline". Shipping the route while calling it drawing would overstate it.

## The alternative that is not being chosen

Leaving the server read-only forever, and handing the user a prepared payload to apply themselves.
This is genuinely defensible: it keeps ADR-0002 intact, and the payload work is already done and
tested. It is not proposed as the default only because the user asked for drawing to happen in
Stockbit, and this is what that means.

## What adversarial review caught before the first write

A 42-agent review of the implementation raised 38 findings; 29 survived an independent attempt to
refute them. One was a data-destroying defect that 336 green tests did not see, and it is recorded
here because the shape of it generalises.

`getChartLayout` is a **display** accessor: it omits the layout blob above 4,000 bytes so a tool
response is not flooded with chart state. The write path read the account's bytes through it. For
any real chart — an empty layout is already ~500 bytes, sixty drawn levels is ~7.5KB — the write path
therefore believed the account held nothing. It wrote a 0-byte "snapshot", reported `bytesBefore: 0`
into the audit log, failed verification unconditionally because it was comparing against an empty
string, and then "rolled back" by POSTing that empty string over the user's real chart — while
reporting *"Nothing was left changed."* An honest round-trip, the primary documented use, destroyed
the layout it was copying.

Every fixture in the test suite was ~495 bytes, so the truncation never triggered.

The rule that came out of it: **a truncating read and a byte-exact operation must not share an entry
point.** `getRawChartLayout` now exists for the write path, uncached and unbounded, and the display
accessor is for display.

Four other guarantees were strengthened in the same pass: the rollback is read back and confirmed
rather than inferred from a 2xx; a write whose request errored is read back before being called a
failure, because a timeout can arrive after the server committed; a verification that could not
*read* no longer triggers a blind rollback, since restoring over an unread state can itself be the
destructive act; and writes to one symbol take a lock.

## Consequences of accepting

- ADR-0002's "no mutation of account data" becomes "no mutation except session refresh and an
  explicitly-confirmed chart layout write". The closed route table stays the enforcement mechanism.
- Every future reviewer must understand that the boundary now has two shapes of exception, which is
  strictly harder to reason about than one.
- The first live write should be performed with the user watching, on a symbol they name, with the
  before and after shown to them.
