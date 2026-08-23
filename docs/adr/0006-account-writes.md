# ADR-0006 — Watchlist and screener edits

**Status: ACCEPTED and implemented**, on the account owner's explicit instruction (2026-08-24:
watchlist edits and screener save are in scope; stream posting, liking and following are not).

## Scope

Nine tools over ten routes, all on exodus:

- **Watchlist:** create, rename, delete, add a symbol, remove a symbol, set the favourite.
- **Screener:** save a screen, delete a saved screen, set or clear its favourite flag.

Deliberately out, and each would need the argument made again: posting to the stream, liking,
replying, following, and writing the `/user-setting/configurations` blob that holds the real chart
configuration.

## Why these need a decision at all

None of them touches money, and every one is reversible by hand in the Stockbit app in seconds. The
temptation is to treat them as harmless.

They are not harmless, because they change what **later answers are about**. `scan`, `screener_run`
and several saved workflows take "the user's watchlist" as the universe they sweep. A symbol quietly
added changes the result of every scan that follows it; `watchlist_favorite` repoints every tool
that says "the user's watchlist" at a different set of symbols. A saved screen is the most direct
statement the user has made about what they look for, and deleting one destroys something they
curated.

So: `confirm: true` on every one, a read-back on every one, and an audit line on every one.

## The apparatus, minus the rollback

ADR-0003's shape — read before, write, read after, report what the read-back actually showed rather
than what the status code implied — with one part removed.

**Nothing here rolls back.** Undoing a failed `watchlist_add` means sending a delete, on a guess,
about a state we just said we could not read; and if the add actually worked, that delete is the
destructive operation. Every edit here is one action a person can reverse in the app. So the result
says what happened, including "we could not tell", and stops.

The outcome classes are the same vocabulary the order path uses: `ok`, `not-visible`,
`landed-despite-error`, `outcome-unknown`, `write-failed`.

## The two refusals worth naming

1. **A non-empty watchlist refuses deletion twice.** `confirm: true` is the ordinary gate; a list
   that still holds symbols is refused with the **count named**, and only
   `confirm_delete_members: true` gets past it. A model that has learned to pass `confirm: true`
   will pass it here too, and 116 symbols would go with it. The second flag has a different name for
   exactly that reason.
2. **Saving a screen under a name that already exists is refused rather than posted.** Whether
   Stockbit replaces or duplicates has never been observed, and those are very different outcomes
   for someone who curated a screen. That refusal can be relaxed once one save over an existing name
   has been watched.

Deleting one of Stockbit's own built-in screens is refused by type: they are not the user's to
remove.

## `screenerSave` is a separate route row on purpose

Saving a screen is the **same method and the same path** as running an ad-hoc one. The only
difference on the wire is one body field: `save: "1"` against `save: "0"`.

`screenerRun` is filed in `test/transport.test.ts` under "POSTs that read". If the save shared that
row, a write would ride along under a read and the write classes would stop meaning anything. Two
route keys keeps the classification honest, and a test asserts the pair still shares a path and
still sits in different classes.

`buildScreenBody` types its `save` field as the literal `"0"` so no assignment can widen it; the
saved body is built by its own function, which reuses the same rule validation rather than
reimplementing it.

## The audit trail

`~/.stockbit/account-mutations.log`, separate from `order-mutations.log`. "What did this server do
to my money" and "what did it do to my lists" are asked at different times and by different people,
and interleaving them makes the first one harder to read — which is the one that matters when
something has gone wrong.

## Annotations are graded

`destructiveHint` is true for the two deletions and for removing a symbol, and false for creating,
renaming, adding and favouriting. Marking every write destructive teaches a client to ignore the
flag, which would make the deletions **less** visible rather than more. `test/tools.test.ts` asserts
the grading rather than the count.
