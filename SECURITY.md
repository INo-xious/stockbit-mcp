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

## Scope

Security issues may include:

- Exposure of Stockbit credentials or session data
- Unauthorized access to MCP tools or returned financial data
- Sensitive information appearing in logs or error messages
- Dependency vulnerabilities reachable through this project
- Denial-of-service vulnerabilities
- MCP transport or client-isolation failures

This project is read-only and does not place or modify trades. Reports about
Stockbit's own services should be submitted directly to Stockbit through its
official security or support channels.
