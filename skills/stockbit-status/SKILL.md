---
name: stockbit-status
description: Check whether the Stockbit session is still valid — main session expiry, whether trading credentials are stored, and the current trading mode. Use when the user asks "am I still logged in to Stockbit", "has my session expired", "is trading on", or when a stockbit MCP tool starts failing with an auth error.
---

# Stockbit session status

Report whether the stored session is alive, and what to do if it is not.

## Run

```bash
stockbit-auth status --json
```

If the bin is not on PATH, run `node dist/bin/stockbit-auth.js status --json` from the repo root.

Prefer `--json`: it is redacted and safe to paste, and it spares you parsing prose. Add `--offline` when the user only wants expiry arithmetic without a network round-trip — offline can report a token as `stored` that the server would reject, so it answers "when does this expire", never "is this still good".

## Read the report

```jsonc
{
  "auth": {
    "main":       { "stored": true,  "expiresInDays": 7 },  // the market-data session
    "securities": { "stored": false },                      // trading; optional
    "eipo":       { "stored": false }                       // minted on first use
  },
  "trading": { "mode": "off", "live": false, "enabled": false },
  "store": {
    "loggedInAt": "2026-08-26T08:15:28.943Z",  // when `stockbit-auth login` last ran
    "loginAgeHours": 19.7,                     // how long ago, for the user's actual question
    "browserPinned": "chrome.exe 152.0.7977.64",
    "defaultBrowser": "C:\...\opera.exe",    // what the OS opens links with
    "defaultBrowserIsPinned": false
  }
}
```

- **`auth.main`** is the one every market-data tool depends on. `stored: false`, or a failed live check, means every stockbit tool will fail until the user logs in again — see the `stockbit-auth` skill.
- **`expiresInDays`** counts down a sliding window. Every refresh pushes it back out, so ordinary use keeps the session alive indefinitely; only a long idle gap forces a new login. Warn when it is under 2.
- **`auth.securities`** is only needed for portfolio, positions and orders. `stored: false` is the normal, safer state — do not treat it as a problem to fix unless the user asked for trading.
- **`trading.mode`** is the thing to state plainly. `off` means no orders can be placed at all. If it is `paper`, say so. **If it is live, say that first and clearly** — with `live: true` the order tools reach a real brokerage account.

## Login age — say it, it is what people are asking

`store.loginAgeHours` is **how long ago the user logged in**, and it is the number they mean when they ask "how old is my login". Report it in natural units: minutes under an hour, hours under two days, days beyond that.

Do **not** present it as a countdown. A login does not expire on a fixed schedule — `auth.main.expiresInDays` is the deadline, and it slides forward on every refresh, so a login from three weeks ago can be perfectly healthy while one from yesterday is not. State the age as a fact and the expiry as the deadline; they answer different questions.

`loggedInAt: null` means either no login has happened, or the profile predates this field. Say which: `browserPinned` tells them apart.

## The browser

`defaultBrowser` is what the operating system opens links with. `browserPinned` is what Chartbit actually drives, chosen at login time and authoritative afterwards, because a Chromium profile is not portable between browsers.

When `defaultBrowserIsPinned` is `false`, mention it once and move on — it is not a fault. Charting works fine in the pinned browser; logging in again is what moves it to the default.

If a `default browser` check appears with `status: "warn"`, the user's default is Safari or Firefox, which cannot be driven for charting at all — they do not implement the Chrome DevTools Protocol. Relay that check's `detail` verbatim: it names what to install and states that everything except chart drawing is unaffected.

Never run `trading-enable`, `trading-login`, or anything else that changes the trading posture as part of a status check. Reporting state and changing state are different jobs, and this one only reports.

## Exit codes

Judge by the report, not the exit code. Current builds exit 0 cleanly, but older Windows builds could print a correct result and then die on a libuv assertion (`UV_HANDLE_CLOSING`) — if you see that, the crash came after the work and the report above it is still valid. Never surface the assertion line as though it were the diagnosis.

Keep the answer to two or three sentences: session state, days remaining, trading mode, and the one action needed if any.
