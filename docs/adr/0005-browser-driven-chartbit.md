# ADR-0005 — Drawing on the user's chart, through their own browser

**Status: ACCEPTED and implemented**, on the account owner's explicit instruction (2026-08-24: drive
the logged-in browser profile over CDP, visible window, using the TradingView widget API in the
page).

## Why this needs its own ADR

Every other write in this project goes through `src/http/transport.ts`, and `test/transport.test.ts`
asserts that no module outside it can reach a Stockbit host: no bearer assembled at a call site, no
path string held outside the route table, no `fetch` to a Stockbit origin. That tripwire is the
project's main structural guarantee.

**This bypasses it entirely.** The driver attaches to a browser that is already logged in and asks
the page to do things. Nothing it does appears as an HTTP request this project made; the requests
are made by Stockbit's own JavaScript, with Stockbit's own credential, exactly as if the user had
clicked. The route table cannot see any of it and the tripwire cannot check it.

That is the whole reason this is a separate decision rather than an implementation detail.

## What it may touch

The driver evaluates a fixed set of scripts from `src/chartbit/page-scripts.ts` against the
TradingView widget in the chart page. Those scripts create shapes, list them, remove them, set the
visible range, add a study, and call the widget's own save. They are **constants**, assembled by
concatenation, and the file contains no template interpolation at all — a test asserts there is no
dollar-brace anywhere in it, because a script built by interpolation is a script an argument can
rewrite. Values reach a script only through `substitute()`, which replaces named placeholders with
`JSON.stringify`d values on word boundaries.

The window is **visible** by default. A drawing appearing on a chart the user is looking at is the
cheapest possible audit trail, and Cloudflare blanks headless Chrome on stockbit.com anyway.

## What it may not do

**The driver never enables the `Network` or `Fetch` CDP domains.** Only `Page` and `Runtime`. Those
two domains are what `src/auth/capture.ts` uses to read response bodies during login, and a drawing
driver that could read traffic could read the session token — a second place the credential lives,
in a component whose job has nothing to do with credentials. `test/chartbit.test.ts` asserts it on
the source, with the comments stripped so the rule can be *explained* in the file it governs, and
with a negative control proving the guard is not vacuous.

## Browser identity is pinned

The account owner runs several browsers. A profile directory is only valid in the browser that
created it, so the driver must launch **the exact binary** `stockbit-auth login` used, not "whatever
Chrome is on the PATH". The choice is recorded at login time in `~/.stockbit/browser-profile.json`
and read back here; a pinned browser that no longer exists is an error that says so rather than a
silent fallback that produces a logged-out page.

## Why `draw` needs no confirmation and `clear` does

Drawing is additive and visible: a line appears on a chart the user is watching, and they can delete
it in the UI in one click. It is closer to a suggestion than a mutation, and requiring a
confirmation for each line would make the feature unusable for its actual purpose — showing someone
the level you are talking about while you talk about it.

**Removing** drawings is not symmetrical. `chartbit_clear` can destroy work the user did by hand,
which this server never saw and cannot reconstruct, so it is confirm-gated. The same asymmetry
applies to `chartbit_layout_delete`.

## What is still true from ADR-0002

The transport tripwire keeps its meaning for everything else. This ADR does not open a general
"drive the browser" capability: the driver's surface is the fixed script set above, the tools that
use it are registered through `define.write`, and anything new it should be able to do is another
argument to make in another file — not an extra script quietly added here.
