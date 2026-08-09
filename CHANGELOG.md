# Changelog

Notable changes to `stockbit-mcp`. Entries record *why* as well as *what*, because most of the
hazards here are undocumented API behaviours that are expensive to rediscover.

Everything marked **measured** was verified against the live API with a real account, not inferred
from naming.

## Unreleased

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

Measured API behaviour (see `STOCKBIT-API.md` §4a):

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

- `STOCKBIT-API.md` §4a previously documented the `period` enum as having "likely date-range
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
