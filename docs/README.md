# Documentation

Start with the [README](../README.md) or [Bahasa Indonesia guide](../README.id.md).
Use this checkout or verified 1.4.1-or-later release artifacts; the 1.3.1 npm build still exposes
real-money tools. The `v1.4.0` GitHub tag points to a 1.3.1 package manifest and has no built assets.

| Guide | Contents |
| --- | --- |
| [Client setup](CLIENTS.md) | Build and connect this checkout to Claude or ChatGPT. |
| [Tool reference](TOOLS.md) | Generated tool inventory, arguments, evidence and limitations. |
| [Verification](VERIFICATION.md) | What was tested, remaining prerequisites and observed upstream failures. |
| [Security](../SECURITY.md) | Credential storage and account boundaries. |

This build supports brokerage portfolio reads, Stockbit website virtual trading, and a separate local
paper ledger. Real-money execution routes are removed. Old `live` settings cannot restore them.
This technical restriction is not a statement of OJK approval or legal certification.

Additional architecture records and historical research are available in the repository checkout.
Use the current guides above for supported behavior and installation instructions.
