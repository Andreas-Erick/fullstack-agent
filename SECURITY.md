# Security policy

Nexus Agent runs on your own computer with access to your files, calendar, vault and (if you allow
it) its own source code, and it can open a server for paired phones. Security reports are taken
seriously.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub:
**Security → Report a vulnerability** on this repository
([direct link](https://github.com/Andreas-Erick/fullstack-agent/security/advisories/new)).

Include what an attacker can do, the steps to reproduce, and the version (Settings → Health shows
it, or `package.json`). You'll get an answer within a week; fixes for confirmed issues are released
as soon as they are ready and credited in the [changelog](CHANGELOG.md) unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes.

## What is in scope

Especially welcome are reports about anything that gets around the app's safety rails:

- **Remote access** (`main/companion.js`, `main/tunnel.js`): reaching the assistant without a valid
  pairing, getting data a paired device should not see (tool inputs and results, settings, secrets,
  the setup conversation), answering approvals that are not meant for devices, bypassing the
  Host/Origin checks or the Cloudflare Access verification.
- **Approvals** (`main/approvals.js`): actions that should ask but don't, including through web pages,
  documents or other external content ("prompt injection") that make the agent act on its own.
- **Self-modification**: the agent widening its own access (settings it may change, path checks,
  approvals), or a change that bypasses the checks and the change history.
- **Files and network**: reading or writing outside the allowed folders, reaching private network
  addresses through web fetching, secrets ending up in logs, notes or conversations.
- **The renderer**: script injection through replies, documents or notes.

Out of scope: problems that need an attacker who already controls your user account or computer, and
the behaviour of the AI providers and services you connect (report those to them).

See [PRIVACY.md](PRIVACY.md) for what data goes where.
