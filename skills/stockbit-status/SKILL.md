---
name: stockbit-status
description: Check whether the Stockbit session is still valid — token present, days until expiry, and a live check against Stockbit. Use when the user asks "am I still logged in to Stockbit", "has my session expired", or when any stockbit MCP tool starts failing with an auth error.
---

# Stockbit session status

Report whether the stored refresh token is still alive, and what to do if it is not.

## Run

```bash
stockbit-auth status
```

If the bin is not on PATH, run it from the repo root: `node dist/bin/stockbit-auth.js status`.

Add `--offline` only when the user explicitly wants to skip the network round-trip. Offline reports expiry arithmetic from the stored token — it can say "present" for a token the server has already rejected, so it answers "when does this expire" but never "is this still good".

## Judge by the printed text, not the exit code

On Windows this command can print its full result correctly and *then* die on a libuv assertion (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`), exiting non-zero. The crash is intermittent and happens after the work is done.

**Parse the output text.** Never report a healthy session as broken because the exit code was non-zero, and never surface the assertion line to the user as though it were the diagnosis.

## Interpret

| Output | Meaning | What to tell the user |
|---|---|---|
| `Validity: OK` | Session live | Logged in. Report the `expires in ~N day(s)` figure. Every refresh slides the window forward, so regular use keeps it alive indefinitely. |
| `Validity: OK`, expiry < 2 days | Live but closing | Warn that no activity before then means a re-login; a single call resets the window. |
| `Validity: FAILED`, `HTTP 401`, or negative days | Token expired or revoked | The session is dead and every stockbit tool will fail. Offer to re-authenticate (see the `stockbit-auth` skill). |
| no token / empty store | Never logged in here, or logged out | Offer to log in. The token store is bound to this machine and user — it cannot be copied from another machine. |

Keep the report to two or three sentences: state, days remaining, and the action if one is needed.
