# Security Policy

## Supported Versions

Security updates are currently provided for the following versions:

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |
| < 1.0   | ❌        |

Use 1.4.1 or later for the build without real-money execution; older published versions may still
contain live order tools. Contributors should install dependencies using the committed lockfile.

## Dependency Security

The runtime dependency floors are `@modelcontextprotocol/sdk ^1.32.1` and `zod ^4.6.7`,
and the committed lockfile resolves those versions. These include fixes for SDK OAuth credential
binding, cross-origin redirects, task isolation, bearer-token audience validation, and oversized
collection validation. The lockfile also updates vulnerable transitive packages, including
`hono`, `proxy-addr`, `body-parser`, `fast-uri`, `ip-address`, and `qs`.

The SDK's collection guard is opt-in: upgrading alone does not enable it. Every production server
sets `maxToolInputElements: 10000`, bounding the total array elements and object members in a tool
call before Zod validation. HTTP requests are also limited to 1 MiB by our body reader and transport.
Calls exceeding either limit are refused. The CI audit job fails on high or critical findings.

The server uses stdio by default. The optional Streamable HTTP transport binds only to loopback,
requires a bearer secret, validates Host/Origin, and creates an isolated transport/server pair per
request. It serves one local Stockbit account. The bearer secret is compared directly; the adapter
does not use the SDK's OAuth `requireBearerAuth` or `verifyBearerToken` middleware, and no
experimental task store is configured. See [client setup](docs/CLIENTS.md).

`hono` is a transitive SDK dependency. The optional HTTP entry point uses Node's HTTP server and
the SDK's Streamable HTTP transport; it does not import Hono middleware.

## Fixed in

The version column names the release the fix ships in. `Unreleased` means it is
on `main` and in [`CHANGELOG.md`](CHANGELOG.md) but has not been tagged yet.

| Reported | Fixed in | |
|---|---|---|
| Order entry | 1.2.2; real-money execution removed in 1.4.0 | **`confirm: true` could skip the human entirely.** The confirmation gate trusted the caller's boolean before attempting MCP elicitation. The shared gate now asks first and refuses a declined dialog regardless of `confirm`. Clients without elicitation remain a documented weaker mode; `trading.elicitation: required` refuses that fallback. See [the published advisory](https://github.com/INo-xious/stockbit-mcp/security/advisories/GHSA-m78m-g6g8-4455), [ADR-0010](docs/adr/0010-elicitation-is-decisive.md), and [ADR-0012](docs/adr/0012-no-real-money-execution.md). |
| Dependencies | 1.2.2 | Four moderate GHSAs against `hono 4.12.33`; the affected middleware was not imported by this server. |
| Dependencies and MCP input limits | Unreleased | Patched SDK, Zod and transitive dependencies; enabled the SDK's collection limit alongside the existing HTTP body cap. See **Dependency Security** above. |

## Where credentials are stored

The refresh token for each of the three token domains lives in the macOS
Keychain when one is available. **Everywhere else it is an AES-256-GCM file
under `~/.stockbit` (or `$STOCKBIT_STORE_DIR`) whose key is derived from the
machine's hostname and username.** That is obfuscation, not a vault: anything
running as the same user on the same machine can derive the same key. Treat a
Windows or Linux install as "the token is on disk" and protect the account
accordingly.

**Access tokens are cached on disk too, and that is a change worth reading.**
This project used to promise that they never were. Stockbit rotates the refresh
token on every use, so several processes — Claude Code, Claude Desktop, a watch
daemon, a CLI — each minting their own access token retire each other's
credential and the account ends up logged out for reasons nobody can see. They
share one instead: `~/.stockbit/access.enc`, keyed by token domain, AES-256-GCM
at mode `0600`, with its own salt.

What that costs is not the same on every platform, and the difference is the
part that matters. On Windows and Linux it is exactly the protection the refresh
token already has — the same encryption, the same mode, the same derived key —
so nothing changes. **On macOS this is a genuine reduction:** there the refresh
token is in the Keychain, and this file is not. A 24-hour bearer token for your
Stockbit account now sits in an encrypted file rather than behind the Keychain,
and anything running as you on that machine can derive the key.

Set `STOCKBIT_NO_ACCESS_CACHE=1` to turn it off in both directions — nothing is
read and nothing is written — and pay one refresh per process instead.
`stockbit-auth logout` clears it, as it clears everything else.

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through GitHub Security
Advisories:

1. Open this repository's **Security** tab.
2. Select **Advisories**.
3. Select **Report a vulnerability**.

Please do not disclose security vulnerabilities through public issues,
discussions, or pull requests.

Include the following information when possible:

- A description of the vulnerability and its potential impact
- The affected version or commit
- Steps required to reproduce the issue
- A proof of concept, logs, or screenshots
- Any suggested mitigation or fix
- The **redacted** output of `stockbit-auth status --offline --json` and
  `stockbit-auth doctor` — both are written to be safe to paste, but read them
  before you do

Do not include Stockbit credentials, session cookies, access tokens, or other
secrets in the report. Replace sensitive values with redacted examples.

## Response Process

After receiving a report, the maintainers will:

1. Confirm receipt and begin triage.
2. Determine the affected versions and severity.
3. Keep the reporter informed while the issue is investigated.
4. Prepare and test a fix when the vulnerability is accepted.
5. Coordinate disclosure and publish a security update when appropriate.

If a report is declined, the maintainers will explain why it is not considered
a vulnerability or why it is outside the project's scope.

## What this server can do to an account

Most of it reads. Some of it writes, and the writes are what a security report
should be aimed at:

- **Real-money execution is removed**, including all real brokerage order mutations and e-IPO
  subscriptions. Legacy live settings fail closed; profiles and environment variables cannot restore
  those routes. Brokerage portfolio, balances and order history remain read-only.
- **Local paper tools** mutate a separate simulated ledger and require preview tickets and
  confirmation. **Stockbit virtual tools** use only fixed `/virtualtrading/` routes on the market-data
  host, require per-action confirmation, and read back results without resending uncertain writes.
  Neither simulation represents a real holding or exchange fill.
- **Chart drawing** drives the browser the user logged in with, over the Chrome
  DevTools Protocol. It enables only the `Page` and `Runtime` CDP domains — never
  `Network` or `Fetch`, which can read response bodies. See
  `docs/adr/0005-browser-driven-chartbit.md`.
- **Watchlist and screener edits** change what later answers are about. See
  `docs/adr/0006-account-writes.md`.

Any path to real-money execution, or to a simulation/account mutation that bypasses its documented
confirmation, is in scope for security reports. In particular:

- A route outside the closed HTTP allowlist, a virtual route reaching a live brokerage host, or
  stale settings reviving real-order execution.
- A saved workflow reaching a write tool, a paper ticket redeemed twice, or an uncertain virtual
  write automatically retried.
- A tool writing its own settings or widening permissions.
- A trading PIN reaching disk, a log, a tool result, or a model. The PIN is
  typed at a terminal, used for one request, and never stored; no MCP tool
  accepts one.
- A credential reaching a host it was not issued for. The three tokens have
  three separate store slots and the route table decides which one each request
  carries.
- Account identifiers leaving in a tool result. Names, account numbers, RDN and
  SID are masked inside the core module, and unrecognised fields on a brokerage
  response have their **values dropped** and only their key names reported.

## Scope

Security issues may include:

- Exposure of Stockbit credentials or session data
- Any write performed without the confirmation or exact policy exception described above
- Unauthorized access to MCP tools or returned financial data
- Sensitive information appearing in logs or error messages
- Dependency vulnerabilities reachable through this project
- Denial-of-service vulnerabilities
- MCP transport or client-isolation failures

Reports about Stockbit's own services should be submitted directly to Stockbit
through its official security or support channels.
