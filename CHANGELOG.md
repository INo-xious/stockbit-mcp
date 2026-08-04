# Changelog

Notable changes to `stockbit-mcp`. Entries record *why* as well as *what*, because most of the
hazards here are undocumented API behaviours that are expensive to rediscover.

Everything marked **measured** was verified against the live API with a real account, not inferred
from naming.

## Unreleased

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
