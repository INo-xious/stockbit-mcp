# ADR-0011 — Automatic login recovery

**Status.** Accepted and implemented — **never run against a live Stockbit session.**
**Supersedes nothing.** Extends [ADR-0007](0007-auth-tools-in-the-server.md) (auth tools in the
server) and depends on [ADR-0009](0009-browser-is-the-source-of-truth.md) (the browser is the source
of truth).

## What is verified, and what is not

The same qualifier [ADR-0004](0004-order-entry.md) carries, for the same reason: this describes a
thing the code does to a user's machine, and the description must not claim more than has been seen.
Read it on the evidence ladder in [`CONTEXT.md`](../../CONTEXT.md).

**Projected — the recovery end to end.** No 401 from Stockbit has ever driven this path in this
repo. The suite is offline, `fetch` is stubbed, and every capture in it is injected. So "a dead
session is silently replaced mid-task" is a projection from parts that work separately, not a
behaviour anyone has watched happen here.

**Verified offline — the safety properties, and these are the ones that matter.**
`test/relogin.test.ts` holds each of them, and `test/reap.test.ts` the last half of the last:

- every gate refuses in the state it exists for, and the five are independent;
- the one-attempt latch is spent exactly once, and never by a gate — standing aside for a human who
  is signing in leaves the attempt available;
- a capture that comes back with nothing is reported as `harvest-failed`, never as a recovery;
- no verdict and no error carries a token, and nothing reaped is reported by command line.

That split is deliberate. The unverified half is "does it fix the session"; the verified half is
"can it do harm while trying", and only the second is a reason the default could be wrong.

## The decision

The server may re-open the user's browser **by itself**, without any tool call having been made, to
harvest a replacement credential when the market-data session dies mid-task. It gets exactly one
attempt, and only with every one of five independent conditions satisfied.

This is the first thing this server does to a user's machine that no one asked it for in the moment,
so the reasoning is written down rather than left in the code.

## Why

The field report, in the user's words: *"it has to be able to detect if the session ended and if the
refresh token doesn't work anymore, and rerun login."* It happened twice in one session, both times
mid-task.

Every signal already existed and not one of them acted. `session-health.json` records refusals,
`status` computes `main.health: "failing"` and `webSession.rejected`, and a 401 becomes a good error
message at the call site. All three are **reports**. What was missing was not detection. It was the
action.

And the action was known to work: when the API token is dead but the browser session is still alive,
a forced login reads the credential straight out of the already-signed-in profile in about three
seconds, with nobody typing anything.

Where that figure comes from, because it is quoted elsewhere and reads like a measurement: it is
**the same field report**, from the account owner's own machine. Nothing in this repo has timed a
harvest — the suite is offline and every capture in it is injected — so "~3 s" is one person's
observation of the manual path this one automates, not a number produced by a call made here. It is
recorded because it is what made the decision, and qualified because a reader deciding whether to
set `STOCKBIT_AUTO_RELOGIN` should know which of the two it is. `UNATTENDED_TIMEOUT_MS` is 30 s, and
that ceiling is what the code actually relies on.

## What "gated" means here

Five conditions, each closing a different way of doing harm. All five, every time.

| Condition | Closes |
|---|---|
| The process called `armAutoRelogin()` — only `bin/stockbit-mcp.ts` does | Recovery firing inside `stockbit-batch` |
| `STOCKBIT_AUTO_RELOGIN` is set, parsed truthily | A window nobody opted into |
| `STOCKBIT_NO_BROWSER` is not set | The existing no-browser contract |
| `webSessionHealth().likelyValid` is **true** | Spending a rotation on a session already dead |
| `login.lock` is free — taken with `timeoutMs: 0`, never queued | Two windows driving one browser profile (every participant that can open one takes it: the `login` tool, this, and `stockbit-auth login` / `trading-login --browser`) |

Plus: `main` only, and one attempt per process.

The lock is a gate like the others, and it sits *before* the one-attempt latch: standing aside for a
human who is already signing in is not an attempt, and must not consume the one that exists.

### Arming is structural, not a convention

`stockbit-batch` reaches `forceRefresh` through the same `src/http/client.ts` as everything else, and
there is no run-mode marker anywhere in this repo. A check inside the auth layer would therefore have
nothing to test — it would have to infer the entry point, and inference is what quietly stops being
true. A capability the batch process never grants itself cannot be got wrong by a later edit to some
condition. `test/relogin.test.ts` pins the caller list to exactly `bin/stockbit-mcp.ts`, so a second
caller is a failing test rather than a surprise at 3am in the middle of a nine-hour backfill.

### The environment variable raises a permission, and that is new

`src/settings.ts` argues that no environment variable should: `STOCKBIT_TRADING` can only *lower* the
trading mode, on the stated reasoning that "a variable is the easiest thing in a process tree to set
by accident, and an accident that disables trading is harmless while the reverse is not."

`STOCKBIT_AUTO_RELOGIN` is the first that raises one. The brief asked for it by name, and the
mitigation is that it is necessary but never sufficient — it grants nothing on its own, since the
process must also be armed, unsuppressed, holding a provably live browser session, asking for the
`main` slot, and on its first attempt. An accidental set opens no window unless the session is
already broken, and then opens exactly one.

It is parsed the way `browserSuppressed` parses its own value — an accept-set, never `=== "1"` —
because Claude Desktop substitutes a ticked boolean setting as the string `"true"`, and an exact
match against `"1"` would read a deliberate opt-in as off.

### Elicitation is not the gate, and could not be

Elicitation lives on the `Definer`, in the tool layer. A 401 raised inside `getBars` has no definer
in scope. [ADR-0010](0010-elicitation-is-decisive.md) makes elicitation decisive **for orders**,
where a tool handler is always on the stack; that is a different situation from a credential dying
three frames below any tool. A switch is what is available at this depth, which is why the switch
defaults to off and why the window that opens closes itself.

## One attempt. Not a policy — a mechanism

Refresh tokens rotate and are single-use. On v1.2.2 each blind retry **spent** a good token to mint a
replacement that was then discarded, so retrying actively made things worse.

Recovery is worse still, in a way worth stating plainly: the proof that a harvested credential works
is itself a refresh, and rotation stales the browser web session the harvest reads. So attempt *n+1*
is **guaranteed** to start from a worse position than attempt *n*. Looping here does not merely waste
a credential, it destroys the thing recovery depends on.

The latch is per process and per domain, and it is set *before* the attempt runs, so a consistently
throwing browser also consumes it rather than becoming a loop.

It records **which history happened**, not merely that one did. `already-recovered` and
`already-attempted` are different answers, and only the second means "the session is stale, here is
what to do". Conflating them made a later failure tell the user that a recovery which had worked
hours earlier "did not fix it", and recommend signing their browser out on the strength of a
website-session reading taken before the harvest that replaced it. For the same reason the caller
reports back when its proof refresh refuses the harvested credential: only that frame knows.

And an attempt that is still **in flight** is a third answer. A dead session 401s every request
already on the wire, and the client runs three at a time, so concurrent failures land inside the
recovery window by construction rather than by bad luck. Those callers are told
`recovery-in-flight` and given no advice at all, because nothing is known yet — the alternative was
recommending a destructive `switch_account` at the precise moment a recovery that would have fixed
everything was still running.

## The retry is the proof

A harvested credential is not known-good. Four in a row were rejected on first use while login,
doctor and status all reported healthy — the defect `captureNeedsProof` was extracted to close. So
recovery never reports success on the strength of a capture.

After a harvest, `forceRefresh` re-enters `ensureFresh` once. Because `forcedRefreshes` is still
raised at that point, both cheap sources — the shared access cache and browser-token adoption — are
switched off, so that call **cannot** be answered locally and is forced to the wire. A real refresh
with the newly harvested token is the proof. If it also fails, the escalation below fires and nothing
claims to have recovered.

## Escalating to the login that actually works

When recovery cannot help, the next step named must be the one that succeeds. With a stale website
session Stockbit shows an expiry dialog over the login form and closes the window before anything can
be typed — measured: a plain login never once produced a usable form, while `switch_account` cleared
the session and worked four times out of four.

So the auth error now names `switch_account`, and `login` refuses a *plain* login outright when the
website session is provably rejected or expired. Both say out loud that it signs the user out of
Stockbit in that browser profile, because it does.

Only on the provable verdicts. `likelyValid` and `expired` are not complements — "unknown" is a third
state — and refusing on the negative is what once demanded a fresh login every day on a session with
six days left.

## Reaping browser processes

Recovery would fail on arrival without this: eleven orphaned processes holding
`user-data-dir=~/.stockbit/browser-profile` blocked every login until they were killed by hand.

Killing a browser is destroying something a person may be using, and that profile is shared with the
Chartbit driver, which deliberately keeps its browser open across calls.

An earlier draft of this ADR claimed reaping was safe because it fires only on the
"exited immediately without opening a debugging port" failure, so "a browser that is genuinely
working answers its port and is never a candidate." **That was wrong, and the code never implemented
it.** Every launch picks a *fresh random* debugging port and polls only that one. A perfectly healthy
browser answering on the port *it* was started with still causes the new child to hand off and exit —
which is that same failure. The condition does not distinguish an orphan from a working browser at
all; it only tells you something holds the profile.

So reaping is **not** automatic. `reapOrphans` defaults to off on every launch, and exactly one
caller sets it: `login { reap_orphans: true }`, where a person has read what it does and asked for
it. The unattended recovery path passes `false` — it would otherwise `SIGKILL` the chart the user is
looking at, 1.5 seconds after asking politely, with nothing having gone wrong. When something holds
the profile, recovery fails and escalates honestly instead.

That still answers the reported problem: the eleven orphans needed a manual `pkill`, and now they
need one tool call.

The match is the exact `--user-data-dir` at an argument boundary on both sides. A plain substring
test would have matched `--user-data-dir=/x/profile-other` for `/x/profile` and killed a browser
holding a sibling directory; a test pins that.

Nothing reaped is ever reported by command line. A Chromium argv can carry a URL, and a Stockbit URL
can carry a token in its query string.

## What was deliberately not built

**A liveness probe at server start.** The brief offered it as a *cheaper alternative* to full
recovery, and full recovery subsumes it: the user does not find out three tool calls in, because
there is nothing to find out. It is also the wrong shape — `instructions` are frozen in the `Server`
constructor with no setter, so a live verdict there would make `createServer` async and put a network
call in every client's startup, including ones the user never types in. That contradicts the stated
and tested registration-purity property in `src/tools/surface.ts`.

**A fourth system tool.** Recovery that needs a tool call is not recovery. The surface stays
`status` / `login` / `logout`.

## Consequences

- A user who sets `STOCKBIT_AUTO_RELOGIN` will occasionally see a browser window appear and vanish
  mid-task. That is the intrusion being traded for not losing the task, and it is why the default is
  off and `status` says which mode it is in.
- `login` now refuses a plain login in a state where it previously started one. The refusal names
  the flow that works, so it is strictly more useful than the window that used to close on the user.
- Recovery never ends a browser process. Clearing orphans is a separate, explicit request.
- Recovery takes the same `login.lock` a human login takes, so the two can never drive one browser
  profile at once — in either direction. It never queues on it: a recovery that waits is a tool call
  that hangs, and there is nothing left to recover by the time someone finishes signing in.
  - Amended 2026-09-01 (P7g): that was true of the `login` TOOL and not of the CLI, which took no
    lock at all — so this gate read "free" throughout a `stockbit-auth login`, which is the one
    participant the tool's own comment names. `stockbit-auth login` and `trading-login --browser`
    now take it too, through the single `src/auth/loginlock.ts`, and release it on every exit path
    including a failure. Three participants, one rule; `test/authcli.test.ts` holds both halves.
- An auth failure keeps its own error `kind`. Recovery adds a sentence; it never reclassifies a
  transport failure as an authentication one, which would make a dropped Wi-Fi read as a dead
  session to every consumer that branches on `kind`.
