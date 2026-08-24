# Changelog

Notable changes to `stockbit-mcp`. Entries record *why* as well as *what*, because most of the
hazards here are undocumented API behaviours that are expensive to rediscover.

The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Where an entry says a mapping
was **Observed**, it was read off a live response with a real account rather than inferred from a
name; see [`CONTEXT.md`](CONTEXT.md) for the rest of the evidence ladder.

## [Unreleased]

## [1.0.0] – 2026-08-25

The first public release. Everything below the tag was already working; this is what it took to be
installable by someone who is not the author.

### Added

- **`status`, `login` and `logout` tools** (ADR-0007). `status` answers "is this working, and what
  do I run" — version, which of the three sessions exist (never the tokens), the trading mode, the
  IDX session clock in WIB, and one next command. It answers with no session at all, which is where
  every new user starts. `login` opens a browser and returns before the person finishes, because no
  MCP client's tool-call timeout is measured in minutes; `status` is the poll. The PIN and the
  trading switch stay at a terminal, and no result from any of the three ever carries a token.
- **Paper trading** (ADR-0008). `stockbit-auth trading-enable --paper` trades against a local
  ledger: no exchange, no session, no PIN, and the identical ticket protocol so nothing about the
  live path is a surprise later. Fills are approximate in three stated ways and every result says
  `PAPER ACCOUNT — no real money.`
- **MCP prompts** for the eight built-in workflows, each carrying guidance on how to present its own
  result rather than a generic instruction to be helpful.
- **`position_size`** — lots from a risk budget, floored, with commission, break-even, R targets and
  both prices checked against the IDX tick grid and today's auto-rejection band.
- **Telegram alert delivery.** The channel that reaches a phone, since a desktop toast fires at a
  laptop that is shut.
- **Tool profiles** — `STOCKBIT_TOOLS=all | core | families,tools`. `core` is 40 tools, which is
  Cursor's cap. `system` is never filtered out.
- **`docs/TOOLS.md`**, generated from the running server, with a test that fails when it is stale.
- **`README.id.md`** in Bahasa Indonesia, and two sample images rendered from synthetic data.
- **Distribution**: npm, the MCP Registry, a Claude Code plugin with six skills, and a Claude
  Desktop Extension.
- **`CONTEXT.md`** — a glossary, so "session" stops meaning two things.
- **`docs/VERIFICATION.md`** — the evidence ladder, what each family is, and how to settle a
  projection.

### Changed

- **Breaking: `stream_post` is now `stream_post_detail`.** It reads one post by id; it was named
  like a verb, and nothing here can post to the stream.
- **Breaking: Node 22 is the floor** (`src/auth/cdp.ts` needs a global `WebSocket`, so the ">=20" it
  claimed would have failed at login).
- **Breaking: `trading-enable` now requires `--paper` or `--live`.** A bare invocation is refused:
  the two differ by everything, and a default is a decision made for someone who did not make it.
- **Breaking: settings are v2.** `trading.enabled: boolean` becomes `trading.mode: off | paper |
  live`, migrated on read — a v1 `enabled: true` becomes `live`, because that is what it meant.
  `STOCKBIT_TRADING` can now lower `live` to `paper`, and still cannot raise anything.
- Tool registration goes through one door. The thirty-three older tools no longer bypass it by
  intercepting `server.tool`, which had made every one of them reachable from a saved workflow
  recipe. Each tool now carries its family and an evidence word on `_meta`.
- The MCP `instructions` enumerate the write tools from the surface itself. They said "the four
  order tools and the chartbit_* writes" while twenty-two tools could change something.
- `stockbit-auth status` renders the same report the `status` tool returns, and `--json` prints it
  redacted — which is what `SECURITY.md` asks a reporter to paste.
- The server reports the version from `package.json` rather than a literal that said `0.1.0` for as
  long as nobody remembered to change it.

### Fixed

- **`STOCKBIT_STORE_DIR` is honoured everywhere.** `src/render/write.ts` hard-coded `~/.stockbit` at
  three sites, so chart SVGs, generated Pine and Chartbit screenshots escaped the store — including
  under a test that had carefully pointed it at a temp directory. The escape *succeeded*, which is
  why nobody noticed.
- The Telegram bot-token redaction pattern could not match the one place the token actually leaks —
  inside the Bot API URL — because a `\b` anchor never matches after the letters `bot`.
- `npm pack` shipped 247 files and 3 MB, including the source tree, the tests and a `dist/` left
  over from an earlier refactor. It now ships 129, checked by an allow-list on every push.

### Security

- `SECURITY.md` now states that off macOS the credential file's key is derived from hostname and
  username — **obfuscation, not a vault** — and asks for the redacted `status --json` in reports.
- Bot tokens are redacted by shape and dropped by key.

### Docs

- A public README with install instructions per client, a decision table, the verification status,
  the safety model and a long disclaimer; `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CLAUDE.md`, a
  documentation index, and an ADR index.
- Private material removed from the tree and from every blob in the history: a collaborator's
  brokerage balance, a real watchlist, Windows home paths in end-user instructions, and the
  maintainer's own name as a test fixture.
- `STOCKBIT-API.md` became `docs/stockbit-api.md` and carries the unofficial/ToS disclaimer the
  README had carried alone.

## [0.1.0] – 2026-08-24

Everything below is the development history that led to 1.0.0, kept because most of it is about
undocumented API behaviour that is expensive to rediscover.

### Full Stockbit coverage, confirm-gated trading, and drawing on the real chart (2026-08-24)

35 tools became 134; 544 tests became 1041. The read surface now covers what the web UI shows, and
for the first time this server can do things to an account: place an order, subscribe to an IPO,
draw on the chart, and edit watchlists and saved screens. Each is off by default or per-action
confirmed, and each has a decision record.

**One host became three, with three credentials.** `exodus` (market data), `carina` (Stockbit
Sekuritas), `api-sekuritas` (e-IPO), each with its own store slot, its own refresh chain and its own
placement rule: the main session refreshes with a header, carina with a `refresh_token` in the
BODY, e-IPO with the token in a QUERY parameter. `AuthKind` distinguishes all three rather than
assuming a bearer, because assuming one is how a credential gets sent somewhere it was never issued
for. `docs/stockbit-api.md` claimed carina needed an `Authorization-Carina` header; the current bundle
says a plain bearer, and it was wrong.

**`/charts/{SYM}` was never locked — the spelling was wrong.** This project recorded it for months
as "real, and still unusable" after probing `timeframe` / `tf` / `interval` / `resolution` against
`daily`, `1D`, `D`, `DAILY`, `TIMEFRAME_DAILY`. Every one of those was uppercase. The client sends
lowercase *windows*: `?timeframe=1w|1m|3m|ytd|1y|3y|5y`. A whole series in one request, against the
12-row paged walk it replaces — roughly 40x fewer requests for every scan, backtest and alignment.
The lesson kept in `docs/stockbit-api.md` §11d: a 400 naming a parameter means the route is real, and
says nothing about whether the values tried were the right *shape* of value.

**Chartbit saving was never retired; this project was reading the retired half.**
`/chartbit/{symbol}/layout` really is a server-side stub that accepts every valid body and stores
nothing — twelve probes established that and they were right about those two routes. The chart page's
own `save_load_adapter` writes to `/chartbit/charts` and `/chartbit/chart-drawings`, content encoded
as base64 of a ZIP holding one `layout.json`. `src/core/layout.ts`, `src/core/layoutwrite.ts` and the
tools `chart_layout` / `chart_layout_save` are gone; `src/chartbit/` replaces them, and the account
owner had said drawings persist before the bundle confirmed it.

**Drawing happens in the user's own browser** (ADR-0005), over CDP, in a visible window, through the
TradingView widget's own API. That bypasses the transport tripwire entirely — the requests are made
by Stockbit's JavaScript with Stockbit's credential — which is why it needed its own decision record
rather than being an implementation detail. The driver enables only the `Page` and `Runtime` CDP
domains: never `Network` or `Fetch`, which can read response bodies, and a drawing driver that could
read traffic could read the session token. A test asserts it on the source.

**Order entry (ADR-0004) inverts three of ADR-0003's rules**, because an order has no undo. Lock
contention refuses instead of proceeding; a failed verification never rolls back, and nothing ever
auto-cancels, because the rollback for an order is another order sent on a guess; and nothing throws
after the request goes out, because a thrown error is a caller's licence to retry and a retry here
is a duplicate. Seven outcome classes, and only `ok` means the order is on the book and was seen
there.

The protocol is two steps with a person in the middle: `order_preview` builds a ticket, the write
tools take a **ticket id and a confirmation and nothing else** — no price, no quantity — so the order
placed is the order described. Tickets live in memory, expire in two minutes, are spent before the
request goes out, and are fingerprinted so one altered between the steps is caught. Where the client
supports MCP elicitation the human is asked directly, in addition to the caller's confirmation.

**Checks that failed and checks that could not be RUN are different facts.** Nothing on the trading
host has been observed live — reading it needs a PIN this project never stores — so a projection that
does not recognise an account's key names leaves buying power or a position unknown. Failing those
closed would make order entry impossible the first time a key name did not match, for a reason with
nothing to do with the order. They pass, marked `unverified`, named in the warnings, and counted in
the summary the user reads.

**The account modules project and never pass a row through**, which is the opposite of the rule
every market-data module follows. There, an unmapped field is a metric nobody has named and hiding
it loses information. On a brokerage response it is as likely to be an account number, and a tool
result is text a model relays — so `unmappedKeys` reports the NAMES and drops the values. Names,
account, RDN and SID are masked inside the core module rather than at the tool boundary, so no
future call site can reach the unmasked value.

**Writes are unreachable from a saved workflow.** `define.write` registers a tool with the client
and deliberately does not add it to the handler map `workflow_run` looks names up in — enforced by
construction, asserted on a real server. A recipe is data: a name and a list of steps.

**A bug the e-IPO tests caught, worth recording because the shape generalises:** a failed read-back
and a read-back that says "nothing there" were both `null`, so a 4xx that left nothing behind
reported as `outcome-unknown` — "we cannot tell, do not resend" — when the honest answer was a clean
failure. Two facts that are opposites must not share a representation.

**Also:** watchlist and screener edits (ADR-0006) with their own audit log, `screener_save` as a
separate route row from `screener_run` because the only difference on the wire is one body field;
`progress/build.mjs` scanning every module under `src/tools/` rather than one file; and the route
guard reading code rather than prose, so a module can name the endpoint it calls in its own
documentation.


### `analyze` — the synthesis layer (2026-08-10)

One new tool. 35 tools, 544 tests. No new route, no new request shape: it composes sources the
server already reads, so the closed route table and ADR-0002's boundary are untouched.

**The gap it fills.** Every other tool answers one question from one source. `deep_dive` fetches
five of them and weighs none, because the workflow engine deliberately refuses to compute — steps
are declarative, there are no conditionals and no arithmetic over results. So nothing here has ever
turned six readings into a position on them. Four weighted pillars now do: broker flow (0.35), trend
across timeframes (0.30), valuation (0.20), candlestick patterns (0.15). Broker flow leads because
it is the only pillar no other data source in the world can serve.

**Confidence is capped at 90 by construction, and the cap is the honest part.** It scores evidence
quality — completeness (30), agreement (30), distance from neutral (20), freshness (10) — and is
explicitly not a probability that price moves the way the lean points. A scale running to 100 invites
exactly the reading the data cannot support.

There is a second reason the word needed care. `Detection.confidence` in `patterns.ts` already means
something else — how closely a candle matches its textbook proportions — and that module is emphatic
it is not a probability either. The two must never be summed or averaged. Pattern confidence is used
only as a within-pillar ranking weight and cannot reach `Confidence.value`; a test asserts the cap
holds when every pillar is saturated.

**A missing pillar is not a neutral vote.** Its weight is redistributed across what was readable and
it costs completeness, so a three-pillar report stays on the −100…+100 scale while reading as the
thinner report it is. Folding it in as a zero instead would drag every lean toward neutral and
nothing in the output would show why. The same distinction runs through the pillars themselves: an
**unreadable timeframe abstains** rather than voting flat, because `alignment()` scores both
"genuinely flat" and "the averages could not be computed" as 0 and only the second is an abstention.

**A total failure errors instead of answering.** This is the correction the first stdio smoke test
forced: against a dead token every source threw, and the tool returned `success: true` with
`lean: "neutral"` and a confidence of 15 — a result that looks like an analysis and is actually a
login prompt. That is the `top_movers` failure shape exactly, where an always-empty list was
indistinguishable from a working tool. Partial failure still degrades per source and names what it
lost; only a report with nothing in it throws, and it rethrows the **original** error so an expired
token is reported as an expired token rather than as "no valuation metric could be located".

**Two limits are structural and are stated in every response** rather than left for a reader to
discover: there is no analyst consensus anywhere in this server, and valuation is scored against
absolute bands because Stockbit's industry aggregate is not in the route table — so "is that cheap
*for a bank*" cannot be asked, and the pillar is systematically wrong in a predictable direction for
banks, property and cyclicals. Community sentiment is fetched and **counted, never scored**: a
keyword tally over ~30 Indonesian-language retail posts would be noise wearing a label.

**The fetches are sequential on purpose.** Concurrent first-calls are what outran the refresh lock
and invalidated the stored token on 2026-08-05. A test asserts no two upstream reads overlap —
mutation-checked by rewriting them as `Promise.all`, which fails it.

### Analytics parity with the TradingView MCPs (2026-08-09)

Six new tools — `backtest`, `strategy_compare`, `patterns`, `timeframe_alignment`, `scan`,
`price_bands` — plus two workflows. 32 tools, 498 tests.

**Eight shipped defects fixed first.** Two of them meant an advertised feature had never worked:
`morning_scan` aborted on every single run (it fanned out over `steps.movers.data.results`, but
`top_movers` returns its rows as `data`), and `top_movers` sent a camelCase spelling this project
invented while Stockbit's own client sends `topgainer` — the endpoint answers 200 with an empty
list, and the tool's description explained an empty hotlist away as a closed market, so a request
that never worked looked exactly like one that did. Also: three `broker_summary` enum values that
do not exist upstream (`BUY`/`SELL` where the modes are `NET`/`GROSS`; `NEGOTIATED`/`CASH` where
the boards are `NEGO`/`TUNAI`, with `ALL` missing entirely); `getBars` with `to` and no `from`
returning 4 bars where 24 were asked for while reporting `truncated: false`; doc comments saying
"shares" where the runtime means lots; `sectors` dropping every field but three, including the
`parent` its own schema declared; a grammar invariant claimed in a comment and not held; and
`stockbit-auth status` reporting a dead token as healthy because it read the JWT expiry rather than
trying a refresh.

**Backtesting.** Entry and exit use the condition grammar the alerts and the Pine emitter already
share, so one strategy is a local backtest, a live alert and a TradingView script rather than three
that drift. The execution model is the feature: signals read at the bar close and fill at the
**next** bar's open, stops win ties on an ambiguous bar, gaps fill at the open rather than the
level, and an ARA/ARB-locked session cannot be filled at all. Absence of lookahead is proved
structurally — a backtest over the first N bars must be a prefix of the backtest over all of them.

**Walk-forward**, with two things it would be easy to get wrong: efficiency is measured **per bar**
(dividing total returns compares a 65% train segment against a 35% test segment, which scored a
deliberately stationary series at 0.54 and would have graded every honest result "overfit"), and
`inconclusive` is checked before any other verdict. On ~500 real daily bars it usually will be.

**Warm-up arithmetic, measured rather than assumed.** SMA and Bollinger terminate, so an SMA 50
needs 51 bars and not the 151 the old flat 3× asked for — five upstream pages instead of thirteen
per symbol, which is what makes a universe scan viable. Wilder and EMA converge, and 3× is *not*
enough: the residual at 3× is 2.75 RSI points, the difference between 29.9 and 32.6 and therefore
between a screen hit and a miss. Raised to a measured 5×.

**One vocabulary.** The overlay/panel preset table was declared three times — twice identically in
`register.ts` and once hand-rolled inside `price_chart`, which had fallen behind and drew no
`ema50` and no ATR panel. A chart that silently omits a line the alert it explains references is
worse than one that refuses the argument.

Still pending live verification (the stored token was already dead): the watchlist and screener
routes, the two enum fixes, and the ARA/ARB field spellings. See `docs/PENDING-VERIFICATION.md`.


### Fixed — counterparty bars are now fully connected

A counterparty's bar is its TRUE total, but the drawn buyers explain only part of it — 23–44% on a
typical stock. The remainder had nothing attached to it, so every bar read as two disconnected
pieces with the ribbons touching only the top one.

The remainder is now fed by a synthetic **"other buyers"** source in the left column, mirroring the
"+N others" band already used on the counterparty side. Every bar is fully connected, every ribbon
still means the same thing (an amount that moved between two parties), and the totals reconcile on
both sides. Shading the shortfall was tried first and rejected: two tones on one bar read as two
bars, which is the confusion it was meant to remove.

No synthetic source is created when nothing is missing.

### Fixed — counterparty bars showed a partial sum; the chart is now buyer→seller only

**A seller's bar was labelled with only the flow from the buyers drawn**, not that seller's actual
total. Measured on TPIA over 27 Jul–3 Aug 2026, XL's bar read **374.54B against a real total of
615.57B** — 61% — and a thinner broker read 16%. That is the worst kind of wrong: a plausible number
that quietly understates. Bars now carry the counterparty's true total from `top_broker_sell`, so a
partly-filled bar means the buyers shown explain only part of what that broker sold — which is
information, not a rendering fault. A `max(drawn, true)` guard keeps ribbons inside their bar if the
two ever disagree.

**The `side` option is gone.** The chart is always laid out BUYER → SELLER, matching Stockbit's own
Broker Distribution. Rendering the mirror view invited exactly the confusion it caused: a
sellers-first chart compared against Stockbit's buyers-first UI looks like a data discrepancy when
the underlying numbers are identical.

### Fixed — market board, and the diagram now names its columns

**`market_board` was being omitted entirely.** An earlier probe sent broker summary's
`MARKET_BOARD_REGULER`, got a 400, and concluded this endpoint takes no board. Wrong: the parameter
is right, the value prefix is `MARKET_TYPE_`. The endpoint was therefore running on its default,
which happens to be REGULER, so numbers were correct by luck rather than by request. Now sent
explicitly, with `ALL` / `NEGO` / `TUNAI` exposed — and it matters: BRMS over 27 Jul–3 Aug 2026 has a
top buyer of 120.33B on REGULER and 978.15B on ALL, because ALL folds in negotiated blocks.

**The chart now labels its columns BUYER and SELLER**, coloured and swapping sides with `side`, and
the subtitle states the direction ("who the top buyers bought FROM") plus the board. Previously the
only hint was "top sellers → counterparties", which is easy to read backwards — and comparing a
sellers-view chart against Stockbit's buyer-first UI looks like a data discrepancy when it is not.

**Verified against Stockbit's own UI**, same stock and window: top buyer XL 120.33B and its seven
largest counterparties match to the decimal. Their UI labels a non-contiguous subset of ribbons,
which is what made it look like values were missing.

### Changed — `broker_distribution` always renders an SVG

The diagram is no longer a separate tool. `broker_distribution` now renders the flow, writes the
`.svg` (to `~/.stockbit/charts/` unless `save_path` says otherwise), returns it as an image, and
reports the path in `savedTo`. It deliberately returns **no per-broker table** — the picture is the
output, and `broker_summary` is where the figures live.

The file is written on every call rather than on request, because MCP clients differ in whether they
render an inline SVG; a caller whose client shows nothing still has a path to open. Filenames are
deterministic (`SYMBOL-side-window-dataType.svg`) so repeating a query overwrites instead of piling
up.

Renders the broker-to-broker flow as an SVG Sankey: source brokers on the left, the counterparties
they traded against on the right, ribbon thickness proportional to the amount, coloured by
Asing/Lokal/Pemerintah. Dark theme by default, `light` available. Returned as an MCP image content
block plus a text summary, with an optional `save_path`.

**No new dependencies.** A raster renderer would mean a native build and a platform matrix; the SVG
is built as a string, so this costs nothing at install time and scales losslessly.

**Escaping is a security control here.** Broker codes come from the API and are interpolated into
markup a browser executes, so every value goes through `esc()`, with tests firing `</text><script>`
payloads through both the broker code and the symbol.

**Node sizes are derived from the ribbons that are actually drawn.** An earlier revision sized target
nodes from one population while routing ribbons from another; the two disagreed, so ribbons
overflowed their bar and ran off the bottom of the canvas across the legend, counterparties ranked
just past the per-source cap received no ribbon at all, and when nothing was globally folded a
source's tail was discarded in silence. Deriving bars from ribbons makes that unrepresentable — a
node height IS the sum of what lands on it — and four invariant tests pin it (nothing off-canvas,
nothing silently dropped, no node without an incoming ribbon, and asking for more never charts less).

### Added — `broker_distribution` (broker-to-broker flow matrix)

New tool. Where `broker_summary` reports *how much* each broker net-bought or net-sold,
`broker_distribution` reports *who was on the other side*: for each top broker, the counterparties
and the amount that moved between them.

```jsonc
{ "detail":        { "code": "AK", "type": "Asing", "amount": 445525972000 },
  "distribute_to": [ { "code": "BK", "amount": 77101438000 }, … ] }
// AK accumulated Rp 445.5B, of which Rp 77.1B came from BK
```

`data_type=VALUE` returns IDR; `data_type=VOLUME` returns **lots** (1 lot = 100 shares), matching the
convention broker summary uses. The unit was verified arithmetically, not assumed — value/volume
lands on the right per-share price only after dividing by 100, so labelling it "shares" would have
understated every quantity by 100x.

Served by a different backend service (`/order-trade/broker/distribution`) which takes the symbol as
a **query parameter**, not a path segment. Accepts either a `period` preset (`TB_PERIOD_*`) or an
explicit `from`/`to` window, reusing the date validation added for `broker_summary`.

> ⚠️ **`market_board` is rejected by this endpoint (400)** — unlike `broker_summary`, where it is
> expected. Copying the summary parameter builder breaks it. There is a regression test.

> ⚠️ **`period` and `from`/`to` are mutually exclusive here too**, and built as separate return
> shapes for the same reason as `broker_summary`.

**Entitlement.** Stockbit gates this feature behind a minimum account balance of **Rp 10,000,000**.
In their web app the gate is enforced **client-side** — the micro-frontend receives an `isEligible`
prop and, when false, renders a blurred overlay over placeholder data and never issues the request.
Whether the server independently refuses an ineligible account is **unverified**: it could not be
observed from an entitled account. The ineligible path is therefore handled defensively — an HTTP
403 names the balance gate as the **most likely** cause while preserving the server's own message and
`error_type`, and 401 remains a genuine auth failure that is never blamed on the balance. Asserting
the balance outright would have been wrong: this project's config already documents that these
routes "400s/403s ... without browser-shaped Origin/Referer", so a Cloudflare or header 403 would
have told the user to deposit Rp 10,000,000 to fix something money cannot fix — with the real error
text destroyed. Both mappings are asserted by test.

### Added — `broker_summary` date ranges

`broker_summary` accepts an optional `from`/`to` window (`YYYY-MM-DD`). `from == to` queries a
single historical day; a range queries a window. Omitting both keeps the previous behaviour exactly.

```jsonc
{ "symbol": "BBRI" }                                            // latest session
{ "symbol": "BBRI", "from": "2026-07-30", "to": "2026-07-30" }  // one past day
{ "symbol": "BBRI", "from": "2026-07-28", "to": "2026-08-01" }  // a window
```

The server aggregates net flow across the window in **one request** — there is no day-by-day
looping and no client-side weighting to do.

> **⚠️ `period` and `from`/`to` are mutually exclusive, and violating that fails silently.**
> With `period` present the dates are ignored and the API answers **HTTP 200 with the latest
> session** — a caller asking for last week receives today's numbers, with no error and no schema
> drift to catch it.

For that reason the two query shapes are built as separate return statements rather than "set
`period`, then delete it when dates exist". The delete form leaves one line between correct
behaviour and a confident wrong answer, and its removal would look innocuous in review.

Measured API behaviour (see `docs/stockbit-api.md` §4a):

| Input | Result |
|---|---|
| `from`+`to`, dashed, no `period` | real range |
| `from` alone (or `to` alone) | **200, latest session** — the lone date is ignored |
| `date_from`/`date_to`, `start_date`/`end_date` | **200, latest session** — names ignored |
| `20260728` or `2026/07/27` | error — dashes required |
| `from` > `to` | error |
| span | no server limit found; 7d…1825d all served in one request |

`date_from`/`date_to` and `start_date`/`end_date` are accepted at the tool layer as **aliases**,
normalised onto `from`/`to`, and never sent. Two different values for the same end are rejected
rather than resolved by a precedence rule.

- **New:** `src/core/dates.ts` — the single door a user-supplied date passes through before it can
  shape a request, in the same spirit as `src/symbol.ts`. Anchored format, real-calendar validation
  (`2026-02-30` matches the pattern but `Date` would roll it to 03-02 and silently return the wrong
  day), both-ends-or-neither, `from <= to`.
- **Caching is range-aware:** a window that ended before today is immutable and caches for 6h;
  anything touching today keeps 60s. The comparison is in UTC while IDX trades in WIB (UTC+7),
  which is safe in the only direction that matters — UTC's date is never *ahead* of WIB's, so a
  live session can never be classified settled. Verified across all 24 UTC hours.

### Fixed — login capture

Four defect classes, all found on Windows 11 / Node 24 / Edge.

**Failures that looked like success**

- Closing the browser mid-login exited **`0`**. The DevTools socket was the only handle keeping the
  event loop alive and the timeout timer was `unref()`'d, so the loop drained with the capture
  promise still pending and the process exited cleanly having stored nothing.
- A token-store write failure was swallowed by a `catch` that logged at debug level, and surfaced
  ~15 minutes later as *"no session captured"* — the opposite of what happened.
- Launching against a profile another window already had open hung for the full login timeout. The
  new process hands off to the running instance and exits, so the debugging port never opens.
  Startup is now bounded separately and watches the child.

**The token could be destroyed before it was read**

`Network.getResponseBody` resolves against a target that must still exist, so a login finishing in a
popup that closes itself — the shape every OAuth provider uses — took the body with it. Capture now
intercepts at `Fetch`'s Response stage, which *pauses* the request while the body is read, with the
`Network` route kept as a fallback.

> **`armSession`'s ordering is load-bearing — do not "simplify" it.** `waitForDebuggerOnStart`
> freezes each new target, and for worker-class targets `Network.enable` is dispatched to that
> frozen thread, so its reply cannot arrive until the `Runtime.runIfWaitingForDebugger` an `await`
> would be blocking on. Circular: the target stays frozen for the whole login window. Every enable
> is therefore **bounded**, and the resume runs in a **`finally`**. `CDP.send` gained an optional
> timeout for the same reason — it previously had none and no rejection on session detach.

**Security**

- Browser discovery no longer shells out to `where`, which on Windows **searches the current
  directory before PATH**. A `chrome.exe` dropped in the working directory would have been launched
  as "the browser" — with a remote debugging port open, for the user to type brokerage credentials
  into. PATH is now resolved in-process with the working directory excluded.
- A browser profile that has logged in is a second copy of the credential (session cookies + Login
  Data). Profiles are created `0o700`, throwaway profiles are deleted after use, and `logout`
  removes the profile as well as the token (`--keep-profile` opts out).
- HAR parse errors no longer interpolate V8's `SyntaxError` message, which quotes the offending
  source text — that printed fragments of a file containing the user's password and cookies.

### Added — browser support, HAR import, diagnostics

- **Discovery rewritten**: `STOCKBIT_BROWSER` → Windows *App Paths* registry → `PATH` → known
  paths, deduplicated and drivable-first, across win32/darwin/linux. The previous three hard-coded
  Windows paths missed per-user Chrome under `%LOCALAPPDATA%` (the install you get without admin
  rights) and every Chromium fork. Firefox is detected and reported as **unsupported** rather than
  silently ignored — it removed CDP in v141 and speaks only WebDriver BiDi.
- **`stockbit-auth import-har`** — log in with any browser, export the DevTools network log, import
  it. This is the only route for Safari, which exposes no debugging protocol to third parties. A
  login HAR is parsed in memory, never logged, size-capped, and `--shred` deletes it after import.
- **`stockbit-auth doctor`** — preflight checklist whose self-test drives the *real* capture path
  against a local fixture serving its token from a self-closing popup. No account, credentials, or
  open market required, and `persist: false` so it cannot overwrite a stored token. Non-zero exit on
  failure. See `docs/TESTING-LOGIN.md`.
- **`stockbit-auth login --fresh-profile`** for a throwaway profile; the default is now persistent,
  so a re-login does not mean re-entering password and OTP.

### Changed — documentation

- `docs/stockbit-api.md` §4a previously documented the `period` enum as having "likely date-range
  variants". **It does not** — 16 candidates were swept and rejected, leaving only
  `BROKER_SUMMARY_PERIOD_LATEST` and `_UNSPECIFIED`. Replaced with the measured behaviour table.
- **Refresh rotation confirmed.** The README listed it as unverified. Comparing SHA-256 digests of
  the stored token across a refresh shows each one mints a **new** refresh token with a fresh 7-day
  expiry, so the single interactive login is genuinely one-time *provided the server runs at least
  weekly*.
- Recorded that **Google and Facebook login are broken on Stockbit's own website**, in any browser,
  with or without this tool: the login page loads `gapi.auth2` (the Google Sign-In platform Google
  retired) and never migrated to Google Identity Services. Verified in an ordinary browser with no
  automation involved. Use username + password; nothing in this repository can fix it.

### Testing — 48/49 → 95/95

- The pre-existing Windows failure is fixed. Two assertions in `auth.test.ts` are gated to
  non-win32: NTFS cannot express mode `0o600`, and `chmod` cannot revoke write access, so neither
  the mode check nor the unwritable-directory case is constructible there. Both remain fully
  asserted on POSIX.
- Wire-level assertions for the date range: the ranged request must carry `from`/`to` and **no**
  `period`; the no-dates request must be byte-identical to the pre-feature behaviour; aliases must
  never appear in the query string; invalid input must not reach the network.

> **A note on the wire-level tests.** An earlier revision asserted only on the exported helper that
> *builds* the params. Replacing the call site in `getBrokerSummary` with the pre-feature object
> left the entire suite green — the test named "the invariant this whole feature depends on"
> guarded a function nothing proved production called. If you add coverage here, assert the request
> that actually goes out, and check that your test fails when the feature is deleted.

[Unreleased]: https://github.com/INo-xious/stockbit-mcp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/INo-xious/stockbit-mcp/releases/tag/v1.0.0
[0.1.0]: https://github.com/INo-xious/stockbit-mcp/commits/v1.0.0
