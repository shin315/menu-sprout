# Security Policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, which creates a private security advisory visible only to the maintainers.
Please do not open a public issue, pull request, or discussion for a suspected vulnerability.

Include what you found, the steps to reproduce it, the Menu Sprout version or commit, and the macOS version.
You will get an acknowledgement in the advisory thread, and a fix and credit are coordinated there before anything is disclosed.

## Supported versions

Menu Sprout has no published releases yet.
Fixes land on the `main` branch, and once releases exist only the latest release is supported.

## What Menu Sprout trusts by design

Some behavior is deliberate and documented in [PRIVACY.md](PRIVACY.md) and [docs/architecture.md](docs/architecture.md#security-boundaries), so a report that only restates it is not a vulnerability:

- The embedded agent runs without permission prompts (`approve-all`, plus each bundled adapter's bypass flag), and its tools are not sandboxed to the extension workspace.
- An extension's `server.ts` runs in the main process with full Node access.
- All extensions share one SQLite database.
- Quota recipes have the agent build server code that reads another tool's credential file or the macOS Keychain.

In scope, for example:

- A widget or other renderer code reaching Node, the filesystem, or credentials without going through an extension server action.
- Bypassing the popover's `contextIsolation` or `nodeIntegration` settings, or the preload bridge.
- Reaching the widget-capture endpoint without its per-launch token, or from off the loopback interface.
- A Keep / Undo rollback that destroys files outside the change session, or that can be skipped.
- Secrets or raw provider payloads reaching the renderer, logs, or telemetry.
- Telemetry sending anything beyond what [PRIVACY.md](PRIVACY.md) lists, or sending while switched off.
