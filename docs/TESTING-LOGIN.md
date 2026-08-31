# Testing the login capture

The one-time login is the hardest part of this project to verify, because the interesting failures
only happen with a real browser, a real human, and a real account. This document splits that into
what a machine can check on its own and what still needs a person.

## 1. Start here — `doctor`

```bash
node dist/bin/stockbit-auth.js doctor
```

Checks every stage the login depends on and reports each one separately, so a failure names itself
instead of being "it didn't work":

```
  ✓ Browsers       Microsoft Edge · 151.0.4129.59
                   C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
                 Opera · 133.0.5932.85
                   C:\Users\<you>\AppData\Local\Programs\Opera\opera.exe
  ! Token store    AES-256-GCM file (machine+user derived key) — this build integrates the macOS Keychain only.
  ✓ Refresh token  present, expires in ~6.9 day(s).
  ✓ Popup capture  token recovered from a self-closing popup in 1054 ms
```

**"Popup capture" is the row that matters.** It runs the *real* `captureViaBrowserLogin` against a
local fixture whose token is served from a popup that closes itself ~30 ms later — the exact shape
that used to lose the token. It needs no Stockbit account, no credentials, no open market, and it
never touches your stored token (`persist: false`).

Add `--skip-self-test` to skip the browser launch (fast, offline).

Exit code is non-zero if any check fails, so it works in CI.

## 2. Automated tests

```bash
npm test
```

Every test is offline and there are no skips. The count is deliberately not written down here — it
goes stale the next time anyone adds a file, and a number in a document nobody regenerates is worse
than no number. `npm test` prints it. Relevant to login:

| File | Covers |
|---|---|
| `test/login.test.ts` | `tokenUrlAllowed` audience rules, `extractRefresh` envelope shapes |
| `test/har.test.ts` | HAR parsing, base64 bodies, body-less entries, **no secret in any error** |
| `test/browsers.test.ts` | discovery order, `STOCKBIT_BROWSER` override, Firefox marked unsupported |
| `test/auth.test.ts` | atomic credential writes, rotation |

Two assertions in `auth.test.ts` are gated to non-Windows: NTFS cannot express POSIX mode `0o600`,
and `chmod` cannot revoke write access, so neither the mode check nor the unwritable-directory case
can be constructed there. On Windows the credential is protected by the profile directory ACL plus
AES-256-GCM at rest.

## 3. Manual matrix

Automated coverage stops where a real login begins. Tick these by hand after touching
`src/auth/login.ts`, `capture.ts`, or `browsers.ts`.

Run with `STOCKBIT_DEBUG=1` to get the target/network trace.

| # | Scenario | Command | Expected |
|---|---|---|---|
| 1 | Username + password, persistent profile | `stockbit-auth login` | captured; `status` shows ~7 days |
| 2 | Username + password + OTP / new device | `stockbit-auth login` | captured on the verification response |
| 3 | Second login, same profile | `stockbit-auth login` | **no re-typing password** — profile persisted |
| 4 | Throwaway profile | `stockbit-auth login --fresh-profile` | full login required again |
| 5 | **Close the window before logging in** | `stockbit-auth login`, then close it | **exits non-zero with an explanatory message — never exit 0** |
| 6 | Timeout | `STOCKBIT_LOGIN_TIMEOUT_MS=15000 stockbit-auth login`, wait | "Login timed out" |
| 7 | No browser | `STOCKBIT_BROWSER=/nope stockbit-auth login` | clear error naming `import-har` as the alternative |
| 8 | Explicit browser | `STOCKBIT_BROWSER=<path> stockbit-auth login` | uses exactly that browser |
| 9 | HAR import (any browser) | `stockbit-auth import-har login.har` | token imported; warns the file still holds secrets |
| 10 | HAR from "Copy all as HAR" | same, on a body-less export | tells you to use the Export button instead |
| 11 | Profile already open | open a window on the profile, then `login` | tells you to close it; does not hang |
| 12 | **Already signed in** | sign in to Stockbit in the profile, then `stockbit-auth login` | **captured in seconds** by reading the browser's own session — not fifteen minutes of nothing |
| 13 | Signed in, nothing usable in the cookie | as 12, then delete the `credentialStorage` cookie in DevTools before running | signs the profile out and re-opens the login form by itself |
| 14 | Switch account | `stockbit-auth login --switch-account` | a real login form, not the app; signing in as a second account stores THAT account's token |
| 15 | **Chart, then market data** | any `chartbit_*` tool, then immediately a quote | **the quote succeeds.** This one sequence is the whole rotation bug: before the resync it 401s every time |

Scenario **5** is the regression that motivated most of this work: the process used to exit `0`
having stored nothing, which is indistinguishable from success. It must fail loudly.

### Browsers to sweep

| Browser | Expected |
|---|---|
| Chrome / Edge / Brave / Vivaldi / Opera | full capture works |
| **Firefox** | listed by `doctor` as **unsupported** — CDP was removed in v141; use `import-har` |
| **Safari** | not discoverable, not drivable — `import-har` only |

## 4. Known-broken, not our bug

**Google and Facebook login do not work on Stockbit's website**, in any browser, with or without
this tool. Their login page loads `gapi.auth2` (via `apis.google.com/js/api.js`) — the Google
Sign-In platform Google retired — and never migrated to Google Identity Services. Google's own
deprecation warning is emitted on their page, and clicking the button opens a popup that renders
nothing.

Verified 2026-08-03 against buildId `9-m667T1nDwrwYTqlxCQl` in an ordinary browser with no
automation involved. **Use username + password.** Nothing in this repository can fix it; the fix
belongs to Stockbit.

`tokenUrlAllowed` already accepts `/login/v{N}/social` (and the legacy `/login/v{N}/google`), so if
Stockbit repairs their integration, capture should work with no change here.
