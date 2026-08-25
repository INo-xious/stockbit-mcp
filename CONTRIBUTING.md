# Contributing

Thanks for looking. This project reads and — under switches you turn on yourself — writes to a real
brokerage account, so a few of the rules below are firmer than they would be elsewhere. Everything
else is ordinary.

## Setup

```bash
git clone https://github.com/INo-xious/stockbit-mcp && cd stockbit-mcp
npm ci
```

Node 22 or newer (`.nvmrc` says 22). `src/auth/cdp.ts` needs a global `WebSocket`, which is why 20
is not enough.

| Command | |
|---|---|
| `npm run typecheck` | `src/`, `bin/` and `scripts/`. |
| `npm test` | ~1,160 tests. Offline. |
| `npm run build` | Cleans `dist/` first, so an orphan cannot survive a rename. |
| `npm run smoke` | Starts the built binary over stdio and asks it what it registered. |
| `npm run check:pack` | Asserts `npm publish` would ship the build and nothing else. |
| `npm run docs:tools` | Regenerates `docs/TOOLS.md`. |
| `npm run docs:images` | Regenerates the README's sample SVGs. |
| `npm run docs:icon` | Regenerates `mcpb/icon.png`. Committed, but generated — no unreviewable blob. |
| `npm run build:mcpb` | Builds the Claude Desktop Extension, `stockbit-mcp-<version>.mcpb`. |
| `npm run dev:mcp` | The server from source, through `tsx`. |

CI runs typecheck, test, build, smoke, check:pack and a `docs/TOOLS.md` freshness check on Ubuntu,
macOS and Windows against Node 22 and 24.

## The tests are offline, and must stay that way

`fetch` is stubbed. Nothing in the suite touches the network, a real Keychain, a real browser or a
real store: every file sets `STOCKBIT_FORCE_FILE_STORE=1` and a temp `STOCKBIT_STORE_DIR` **before**
importing anything, because module-level state is captured at import.

There are no `.skip`, `.only` or `.todo` tests. A test that is not run is a test that is not true.

**Fixtures must not contain real data.** Not a real account number, not a real name, not a real
watchlist. Invent them.

## Adding a tool

1. Put it in the family module it belongs to under `src/tools/`, or start a new family in
   `FAMILIES` (`src/tools/_define.ts`).
2. Register it with `define.read` or `define.write` on that family's definer.
3. Write the description for a **model**, not for a person. It is the only documentation the model
   gets: say when to use it, what an empty result means, and what could be wrong with the numbers.
   If the route has never been observed live, say so in the description — the evidence word is
   derived from that sentence, and claiming `observed` while the description denies it throws at
   registration.
4. Run `npm run docs:tools` and commit the regenerated `docs/TOOLS.md`.
5. For a **write**, add its name to the `WRITES` list in `test/tools.test.ts`. That list is spelled
   out rather than derived on purpose: deriving it would make the test agree with whatever the code
   does, which is the one thing it must not do.

## The three invariants

Each is enforced by a test rather than by a convention, and each exists because of a specific way
this could hurt someone.

**1. Nothing reaches a Stockbit host outside the route table.** Every request shape lives in
`src/http/routes/` and `test/transport.test.ts` asserts nothing else can get through.

> **Any new non-GET route needs an ADR before the code lands.** See `docs/adr/`. Say what the route
> does, why the existing surface could not do it, what happens when it fails halfway, and how a
> caller finds out. There are 32 non-GET routes and every one of them is admitted by a named
> decision.

**2. A write tool is never reachable from a saved workflow recipe.** `define.read` adds a handler to
the map `workflow_run` looks names up in; `define.write` deliberately does not. A recipe is data — a
name and a list of steps — and data must not be able to place an order.

**3. Nothing that serves a model can write the settings file.** No module under `src/tools/`,
`src/trading/` or `src/eipo/` may import `saveSettings`. A server that can widen its own permissions
has no permissions. `test/settings.test.ts` greps for it.

## Vocabulary

[`CONTEXT.md`](CONTEXT.md) is a glossary, not a spec: one meaning per word. Use those words. In
particular:

- **symbol** is the only user-facing word for a ticker. `emiten_code` and `company_id` exist on the
  wire and nowhere else.
- **lot** is 100 shares. Tools take and report lots.
- **family** is one registration module, which is one section of the Stockbit UI.
- **Observed / Read-back / Projected** is the evidence ladder, and it is not decoration — it is the
  difference between a number you can act on and a number nobody has checked.

## Verifying something against a live account

The trading and e-IPO families are entirely **Projected**: field names read off Stockbit's web
bundle, never seen on a live response. Settling one is four steps:

1. Call the tool once against a live session.
2. Read `unmapped.sampleKeys` (market data) or `unmappedKeys` (account data) on the result — those
   are the wire keys the code did not recognise.
3. Make one edit to the candidate key list in the relevant `src/` module.
4. Re-tag the evidence, run `npm run docs:tools`, and record the comparison in
   `docs/VERIFICATION.md` — what was compared against what, and on what date.

Report evidence as evidence. "It returned 200" is not the same as "the field I read is the field I
thought it was".

## Commits and branches

Work happens on `marvel-testing` and reaches `main` through a pull request.

Commit subjects are imperative and conventional (`feat(alerts):`, `fix:`, `docs:`, `refactor(tools):`).
Bodies explain **why**, and specifically what was wrong before — this repository's history is
readable, and that is deliberate.

**No AI co-author trailers.** If a tool helped you write something, that is between you and the
tool.

## What a pull request needs

- `npm run typecheck && npm test && npm run build && npm run smoke && npm run check:pack` all pass.
- `docs/TOOLS.md` regenerated if you touched a tool.
- An ADR if you added a non-GET route.
- No fixtures with real data.
- A `CHANGELOG.md` entry under `## [Unreleased]`.
- The evidence words used correctly.

## Reporting a bug

`stockbit-auth doctor` and `stockbit-auth status --json` are both written to be safe to paste — read
them before you do anyway. The issue template asks for both.

**Security issues go through GitHub Security Advisories, never a public issue.** See
[`SECURITY.md`](SECURITY.md).
