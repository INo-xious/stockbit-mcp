# ADR-0007 — `status`, `login` and `logout` as tools

**Status: ACCEPTED 2026-08-24**, on the account owner's explicit instruction. It extends ADR-0002's
single admitted write — the session refresh — to *initiating* a login and *clearing* credentials.

## Context

Everything in this server needs a session, and until now there was exactly one way to get one: quit
the client, find a terminal, run `stockbit-auth login`, come back, restart the client. For the
audience this is being published for — IDX retail traders installing an MCP server, often on
Windows, often from Claude Desktop where there is no terminal in sight — that is not a step in the
quick start. It is where the quick start ends.

The server was not, however, credential-inert before this. ADR-0002 admitted one write: the session
refresh persists a rotated refresh token, because Stockbit rotates on every use and not persisting
it logs the user out. So "the server never touches credentials" was already not the rule. The rule
was narrower and worth naming: **the server never *acquires* a credential the user did not already
give it, and never destroys one.** This ADR changes exactly that, under gates.

What is genuinely new is that `login` launches a visible browser window on the user's machine and
`logout` destroys stored credentials. Both are actions a model could take because they seemed
helpful, and neither is recoverable by a retry.

## Decision

Three tools, in a `system` family that no tool profile can filter out — they are how a user finds
out why everything else is missing.

**`status`** (read). The whole report: version, Node, which of the three sessions are stored, how
long the market-data token claims it has, the trading mode and why, the IDX session clock in WIB,
and a `nextStep` naming the single next command. It must answer with no store at all, because that
is the state every new user is in. `live: true` refreshes once to prove the token actually works;
the payload expiry is a claim about time, not evidence of validity.

**`login`** (write, `destructiveHint: false`, `idempotentHint: true`). Gates, all of them:

| Gate | Why |
|---|---|
| `confirm: true` | The caller states the user agreed. |
| Elicitation, where the client supports it | The user themselves clicks yes. This is the only channel in MCP that reaches a person rather than a model. |
| `STOCKBIT_NO_BROWSER=1` refuses outright | A headless box, a CI runner and a locked-down desktop all set it, and all of them mean "not from here". The refusal names the terminal command. |
| A directory lock on `login.lock` | Two logins fighting over one browser profile corrupts it. A second client, or a terminal, is refused rather than queued. |
| Already-stored session refuses unless `force: true` | Re-logging-in is not free: it opens a window in front of whatever the user was doing. |

**`logout`** (write, `destructiveHint: true`). `confirm: true`, a `scope` of `main` / `trading` /
`eipo` / `all`, and an optional `remove_browser_profile`. Trading logs out at Stockbit's end as well
as locally. The browser profile matters more than it looks: it holds Stockbit cookies, so clearing
the token without it leaves a second copy of the session that can log straight back in.

### `login` returns before the login finishes

A person takes minutes — password manager, 2FA, a failed attempt. Every MCP client has a tool-call
timeout and none of them is measured in minutes, so a blocking call would time out on the client
while the browser sat there working. The tool starts the capture, returns in about a second, and
`status` is the poll.

The cost is stated in the result rather than hidden: **a server restarted mid-login abandons the
capture**, nothing is stored, and `status` will say the session is still missing. Login progress is
module state, not a file, precisely so it describes this process and cannot report "in progress"
about a capture that died with another one.

### What stays at a terminal, and why

- **The six-digit PIN** (`stockbit-auth trading-login`). ADR-0004's rule is unchanged and this ADR
  does not soften it: no tool accepts a PIN, nothing stores one, and a PIN typed to an assistant has
  travelled through a model and a client's logs before it reaches the server. The browser login has
  no equivalent exposure — the user types their password into Stockbit's own page, and this server
  sees only the response.
- **The trading switch** (`trading-enable --paper|--live`). A tool that could turn trading on would
  make every other gate decorative. `SECURITY.md` names "a path that turns trading on without the
  account owner running `trading-enable` themselves" as a vulnerability, and that stays true.

## Invariant

**No result from any of these tools ever carries a token.** Not in a field, not in an error message,
not in a capture failure that happens to quote a URL. Every return value goes through
`redactValue`, and `test/system.test.ts` asserts nothing JWT-shaped survives into the serialised
output. `status` decodes the stored JWT for its expiry and copies out one number.

## Consequences

- A Claude Desktop Extension can be one click for the read-only half: install, say "log me into
  Stockbit", sign in in the window that opens. That was the motivation.
- A restart mid-login loses the attempt. Acceptable, and reported.
- `status` becomes the thing to call when anything looks wrong, so the MCP `instructions` say so
  before anything else. It is also the first place a support conversation starts:
  `stockbit-auth status --json` prints the same report, redacted, for pasting into an issue.
- Three more tools on a surface that already worries about client tool caps. All three are in
  `core`, and `system` is exempt from filtering — a server whose `status` tool had been profiled
  away would be one nobody could debug.
