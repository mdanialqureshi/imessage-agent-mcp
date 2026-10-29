# Security

Messages Agent reads your private message history, so security reports are very welcome.

## Reporting a vulnerability

Please report it privately: on this repository, go to **Security → Report a vulnerability**. Don't open a public issue, and don't include anyone's real messages, phone numbers or contacts in a report. Describe the problem and how to reproduce it with made-up data.

You'll get a reply within a few days. Fixes ship as a new release, which the app offers to install.

## Scope

How the app is meant to be safe, and what it does and doesn't protect against, is in [docs/security.md](docs/security.md). In short:

- Only the tiny reader holds Full Disk Access, and it only copies Messages and Contacts into a private folder.
- Nothing listens on the network. Agents reach the service through a Unix socket only your account can open.
- Message text is treated as untrusted: it can't make the interpreter run tools, and agents are told to treat it as information, never as instructions.
- Updates are verified against a signing key built into the app before they're installed.
