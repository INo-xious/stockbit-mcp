# Security Policy

## Supported Versions

Security updates are currently provided for the following versions:

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

Users should run the latest available release and install dependencies using
the committed lockfile.

## Dependency Security

This project requires a patched version of `@modelcontextprotocol/sdk`.

Versions older than `1.26.0` are affected by one or more high-severity
vulnerabilities, including:

- Cross-client data leakage through shared server or transport reuse
- Regular expression denial of service in URI templates
- Missing default DNS-rebinding protection for HTTP-based servers

Project releases must resolve `@modelcontextprotocol/sdk` to version `1.26.0`
or newer. Version `1.30.0` or newer is recommended.

The current server uses the stdio transport. It does not expose an HTTP or SSE
listener by default.

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

- **Order entry** (`order_buy`, `order_sell`, `order_amend`, `order_cancel`) and
  **IPO subscription** (`eipo_order`) place real orders with real money. They
  are **off by default**, require a per-order confirmation against a ticket the
  user was shown, and cannot be reached from a saved workflow recipe. See
  `docs/adr/0004-order-entry.md`.
- **Chart drawing** drives the browser the user logged in with, over the Chrome
  DevTools Protocol. It enables only the `Page` and `Runtime` CDP domains — never
  `Network` or `Fetch`, which can read response bodies. See
  `docs/adr/0005-browser-driven-chartbit.md`.
- **Watchlist and screener edits** change what later answers are about. See
  `docs/adr/0006-account-writes.md`.

Anything that lets one of those happen without the user's explicit,
per-action agreement is a vulnerability in this project, whatever else it looks
like. In particular:

- A path that turns trading on without the account owner running
  `stockbit-auth trading-enable` themselves. The environment can only turn
  trading **off**; there is deliberately no variable that turns it on, and no
  module under `src/tools/`, `src/trading/` or `src/eipo/` may write the
  settings file.
- A path that satisfies a confirmation the user did not give, or that redeems
  an order ticket twice.
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
- Any write performed without the confirmation described above
- Unauthorized access to MCP tools or returned financial data
- Sensitive information appearing in logs or error messages
- Dependency vulnerabilities reachable through this project
- Denial-of-service vulnerabilities
- MCP transport or client-isolation failures

Reports about Stockbit's own services should be submitted directly to Stockbit
through its official security or support channels.
