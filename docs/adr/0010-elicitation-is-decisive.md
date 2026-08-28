# ADR-0010 — Elicitation is decisive, and `confirm` cannot skip the ask

**Status: ACCEPTED and implemented**, 2026-08-28. It amends [ADR-0004](0004-order-entry.md) — see
Amendment 1 there — and applies unchanged to [ADR-0008](0008-paper-trading.md)'s paper path, because
paper diverges from live *after* this gate and nowhere earlier.

No route changes. The route table is untouched; this is about who has to agree before one of the
five existing order routes is used.

## The defect

`src/trading/orders.ts` opened its gate like this:

```ts
let via: ConfirmationSource | null = options.confirm === true ? "explicit" : null;
…
if (!via && policy.autoConfirm)  { … }
if (!via && options.elicit)      { … }   // never reached when confirm was true
if (!via)                        { refuse(…) }
```

`confirm` is a boolean **the calling model** sets. MCP elicitation is the only channel in the
protocol that reaches **a person**. Seeding `via` from the boolean and guarding the ask behind
`!via` meant `confirm: true` did not add a gate to the human's — it removed the human's. A model
could place an order the account holder never saw by asserting that the account holder had already
agreed, and there is no undo for an order.

Three things made it worse than a single wrong line.

**It was duplicated.** `src/eipo/order.ts` carried a second copy of the same six branches, for the
one commitment in this project that cannot be undone even by selling. It had already drifted: a
shorter cap-missing message, no guard for a commitment with no gross value, and it had lost the
sentence "Do not set it on their behalf" — the single most load-bearing sentence in the refusal.

**The log could not tell the two cases apart.** Both paths wrote `via: "explicit"`. The audit trail
exists so that afterwards someone can establish what happened, and on exactly the question this
defect turns on, it could not.

**Four places in this repo said it worked the other way**, and the fifth did it right.
`src/tools/_define.ts`, `src/tools/trading.ts`, ADR-0004 and `SECURITY.md` all asserted the ask was
additive; the comment in `trading.ts` sat directly above the call that did not do it. Meanwhile
`login` (`src/tools/system.ts`) called `elicit` unconditionally and refused on `declined` regardless
of `confirm`, with a test pinning it. **Order entry was weaker than opening a browser window.**

`SECURITY.md` had already classified this in advance: "A path that **satisfies a confirmation the
user did not give** … is a vulnerability in this project, whatever else it looks like."

## The decision

**One gate, in `src/trading/confirmation.ts`, called by both order entry and e-IPO. The ask runs
before the `confirm` check, and behind no `via` test at all.**

The order of branches is the security property:

1. `autoConfirm` — the owner's deliberate, capped exception, set at a terminal. The only thing that
   skips the ask. Never in force in paper, never without a value cap, never against `required`.
2. A live "don't ask again" the person granted themselves, inside its bounds.
3. The owner having set `elicitation: never`.
4. **Ask the person.** Unconditional.
5. Only then, with nobody reachable, does `confirm: true` mean anything.

`accepted` proceeds. `declined` refuses, whatever `confirm` said. `unavailable` falls through to 5.

## Why the ask precedes `confirm` rather than joining it

The literal reading of ADR-0004 — require *both* — was considered and rejected, and this is the part
of the decision most worth writing down, because "require both" sounds strictly safer.

It is not. When a human has clicked yes in a dialog, the model's boolean adds no security: the
strongest evidence the protocol can produce is already in hand. What requiring it *does* add is a
reason for every model to send `confirm: true` on every call as a matter of routine — and that habit
is corrosive precisely where the boolean is the only gate that exists, on clients that cannot
elicit. Requiring both would trade a real improvement on capable clients for a degradation on the
weakest ones.

Putting the ask first also keeps two things literally true that would otherwise have become
awkward fictions: the existing `elicit`-without-`confirm` path keeps working, and
`skills/trade-with-guardrails/SKILL.md`'s "Never set `confirm: true` on the user's behalf" remains
advice a model can actually follow without breaking anything.

## Why a client that cannot ask is allowed through, and only marked

ADR-0004's "a client that cannot ask must not become a client that cannot trade" is kept. Refusing
by default would have broken every existing install of a client without elicitation support on the
day this shipped — a breaking change dressed up as a default.

But it is never silent. `via` becomes `explicit-unelicited` in the audit log, `elicitation` becomes
`unavailable` on the result, and the `message` a model is told to relay says in words that no human
was asked directly and names the switch that would refuse instead. An account owner who wants the
stricter posture chooses it themselves: `trading-enable --elicitation required`.

The old `via: "explicit"` is **removed** rather than kept alongside the new values. Keeping it would
have preserved exactly the ambiguity this ADR exists to end. The log is append-only JSONL, so lines
written before this change keep their old value and mean what they meant.

## The three switches

`trading.elicitation` is one tri-state, not two booleans — the same reasoning that made
`TradingMode` three values rather than `enabled` plus a flag. Two booleans can be set to a
combination that says nothing, or to one where each half read alone says the opposite of the truth.

| | |
|---|---|
| `required` | Refuse rather than send when no person can be reached. `confirm: true` never substitutes, and `autoConfirm` is ignored outright. |
| `when-available` | Ask wherever the client can; fall back to `confirm: true` where it cannot. **The default.** |
| `never` | Do not ask at all. `confirm: true` becomes the only gate. |

An unrecognised value in the file coerces to the **default**, deliberately unlike `mode`, whose
fallback is `off`. An unreadable *permission* is no permission; this is not a permission. Falling
back to `never` would silently weaken an account over a typo, and to `required` would silently brick
one.

`required` and `autoConfirm` contradict each other. The contradiction is resolved in favour of the
switch that produces a question, and reported through the `autoConfirmIgnored` channel that already
exists for "you set this and it is not doing anything" — rather than through a new field nobody
reads. `trading-disable` also stamps a revocation but deliberately does **not** reset `elicitation`:
two of its three values are stricter than the default, and quietly loosening a stricter setting on
the way to "off" would mean turning trading back on later restored it weaker than the user left it.

## Why "don't ask again" is in memory, and granted by the person

Asking about every order is the point. Asking about the fourth deliberate order in a row is how a
dialog becomes a thing people click through without reading — and a confirmation nobody reads is
worse than none, because it still produces the record saying they agreed.

So the ask can be waived, but only by the person doing the answering, by ticking a second box in
the dialog they were already reading, and inside five bounds that must all hold at once: it is a
**new order** — a buy or a sell; the value of the order they actually approved; fifteen minutes; a
fingerprint of the policy in force when they ticked it; and any later revocation.

The first of those, `ConfirmationRequest.waivable`, is **stated by the caller and not inferred
here**, and that is worth recording because the first implementation got it wrong in exactly the way
this ADR is otherwise about. It inferred waivability from `valueIdr === null`, reasoning that a
cancel and an amend carry no gross value — which is false of an amend, whose ticket resolves price
and lots from the working order and therefore has a real gross. Every amend was silently waived by a
box ticked on a buy, for a commitment `order_amend`'s own description calls "a real order decision
and not an edit". A second instance of the same shape: the grant store is one slot shared with
e-IPO, so a tick on a share order also waived an IPO subscription — a commitment whose dialog says
the allotment may be smaller than the subscription and cannot be cancelled by selling, which the
person never saw. Both were found by an adversarial review pass before this shipped. **A security
bound that depends on a field happening to be null somewhere else is not a bound**, and that is the
general lesson, not the two instances.

An amend and a cancel are excluded on their merits too, not merely for safety: they change something
already working, and agreeing to commit X rupiah is not agreeing to move or withdraw an order
already on the book.

A third instance of the same shape, found in the same review: the grant was created *inside* the
gate. The gate runs against a peeked ticket precisely so a refusal costs the user nothing — so it
must not leave anything behind either. Every refusal after it kept the waiver: an expired ticket,
failed checks, a fingerprint mismatch. And the common trigger is not a corner case at all, because
the dialog runs at human speed while a ticket lasts two minutes: a person who read the summary
properly could watch the order be refused and have silently turned their own confirmations off in
the process, with nothing in the refusal saying so. The gate now only *reports* the tick
(`ConfirmationVerdict.rememberRequested`) and the caller creates the grant after the ticket is spent
and proven. The waiver rides with the commitment.

Two smaller consequences of the ask running before the ticket is spent, both now handled: a ticket
whose own checks have already failed is refused *before* anyone is asked — approving an order that
cannot be placed whatever the answer spends a person's attention on nothing, and is how a dialog
stops being read — and when a ticket does expire mid-dialog, the refusal says so rather than leaving
the reader to connect an expiry to the box they were looking at.

What the grant deliberately does **not** bound: there is no cumulative budget, no symbol list and no
side. Any number of new orders, each within the cap, proceed unasked until it expires — the fifteen
minutes is what bounds the total. The box says "each new order this size or smaller" rather than
"orders up to", because the per-order-versus-cumulative reading is the one a person is likeliest to
get wrong.

The cap being *the approved order's own value* means the waiver needs no new setting and cannot
outgrow what was consented to. It mirrors this project's existing rule that a waiver must be capped.

It is never written to disk, for two reasons either of which would be sufficient. A grant that
survived a restart would outlive the conversation in which the person agreed to something. And
writing it would mean a module under `src/trading/` editing the settings file, which invariant 3
forbids and `test/settings.test.ts` enforces: a server that can widen its own permissions has no
permissions.

Revocation therefore has to cross a process boundary the other way. `stockbit-auth trading-forget`
cannot reach a running server's memory, so it writes a moment into
`trading.confirmationsRevokedAt`; every order re-reads the policy before the gate, so a grant made
before that moment stops covering anything, including in servers that were already running.

## Why the reporter's suggested fix was declined

The report proposed a short-lived, single-use token issued by `order_preview` and required by the
write. `ticket_id` already **is** that token: in memory, 120-second TTL, spent by `take()` before
the request goes out, fingerprinted and rechecked immediately before the wire.

A second secret changes nothing, because the same model that reads the ticket id from the preview
response reads the second token from the same response. The gap was never token binding. It was that
nothing ever reached a human.

## What this costs

The audit log's `via` vocabulary changed, so anything parsing it for the string `explicit` needs
updating — that is called out in the release notes and the old lines are untouched.

An order on a client that supports elicitation now always produces a dialog, where previously a
model that sent `confirm: true` produced none. That is the intended cost, and the remember box is
the release valve for it.

`trading_forget` is a 139th tool. It is **not** in the `core` profile: `core` is capped at 40 tools
to fit under Cursor's ceiling, it deliberately registers no order writes, and a profile that cannot
place an order can never create a grant to forget. It arrives with the `trading` family, alongside
the tools that can create one.
