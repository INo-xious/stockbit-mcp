---
name: stockbit-auth
description: Log in to Stockbit and capture the session for this server — opens the browser login flow and verifies the token was stored. Use when the user asks to log in or re-authenticate to Stockbit, or after a status check reports the session expired, HTTP 401, or logged out.
---

# Stockbit login

Launch the browser login and confirm the refresh token was captured.

## Step 1 — launch it detached

```bash
stockbit-auth login
```

(or `node dist/bin/stockbit-auth.js login` from the repo root; add `--fresh-profile` if a saved browser profile is stuck.)

**If you are an agent running this through a tool harness, do not run it as a foreground or backgrounded shell call.** Harnesses that reap the process tree when a turn ends will kill node mid-login, and node's cleanup closes the browser with it — the login never completes and the failure looks like a browser problem. Launch it as a detached process instead, so it outlives the turn. On Windows:

```powershell
Start-Process -FilePath "node" -ArgumentList "dist\bin\stockbit-auth.js", "login" `
  -WorkingDirectory <repo-root> -WindowStyle Hidden `
  -RedirectStandardOutput "$env:TEMP\stockbit-login.out.log" `
  -RedirectStandardError  "$env:TEMP\stockbit-login.err.log"
```

On macOS/Linux, detach with `nohup ... &` or an equivalent that survives the caller.

## Step 2 — hand the browser to the user

A browser window opens on the Stockbit login page. **The user logs in there themselves.** The session is captured automatically the moment login completes, and the window may close itself. The flow allows up to 15 minutes.

Never ask for the user's Stockbit password and never type credentials on their behalf — the browser session is theirs. Then wait for them to say they are done; do not poll in a loop.

## Step 3 — verify

Read the redirected logs (success prints `Session captured` and a passing test refresh), then confirm the stored token independently:

```bash
stockbit-auth status
```

Expect `Validity: OK`. Note that `status` can print correctly and then crash on a libuv assertion on Windows — judge by the text, not the exit code. Remind the user that ordinary use keeps the window sliding, and only a long idle gap forces another login.

## If the browser flow fails

Offer the fallbacks in this order:

1. `stockbit-auth doctor` — diagnoses browsers, the token store, and the capture path.
2. `stockbit-auth import-har` — the user logs in with any browser, exports a DevTools HAR, and imports it.
3. `stockbit-auth bootstrap` — paste a refresh token manually.

Two things that cause confusing failures: the capture only watches the browser **it** launched, so logging in through a normal window is invisible to it; and the stored token is encrypted against this machine and user, so it cannot be copied to another host — every machine logs in once for itself.
