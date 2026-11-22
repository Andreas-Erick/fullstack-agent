# ADR-0005: Paired devices get a small, trimmed, mostly read-only API

Status: Accepted · Date: 2026-11-22

## Context

The phone app, any phone browser and a Galaxy Watch should reach the
assistant, while the brain, memory and keys stay on the desktop. A
phone is easier to lose than a desktop, and the server may be
reachable over a LAN or a tunnel.

## Options considered

- **Hosted relay / cloud backend.** Easy reach from anywhere; user
  data leaves the machine and there is a server to run and secure.
- **Expose the desktop's IPC surface over HTTP.** Little new code;
  every setting, secret and tool would be one bug away from a phone.
- **A separate, narrow HTTP + SSE server with its own route list,
  pairing, and trimmed copies of what it serves.**

## Decision

The last option, in `main/companion.js`. It is off by default and
desktop-only to switch on (never in the agent's `SETTABLE`).

- Pairing: a 6-digit code or QR secret becomes a device token; only
  its hash is stored. Every route checks the token, Host and Origin.
- Scope: chat, conversations and the schedule read-only, the data
  screens through `main/companiondata.js` behind `remote.shareData`.
  No settings, secrets, tools or arbitrary files.
- What devices see is decided in `main/projections.js`: tool names
  but never inputs or results; paths scrubbed from errors.
- Approvals: a device may answer only the kinds in `DEVICE_OK`;
  everything else (commands, self-change, permissions) is shown as
  desktop-only and refused.
- Reach from outside the LAN goes through the user's Tailscale or
  Cloudflare Tunnel (Access logins verified), never a hosted relay.

## Consequences

- Every new phone screen needs a route, a trimmed projection and a
  contract test (`test/sync.test.js` checks that every streamed
  event has a phone handler and every data call a route).
- Some actions are only possible at the desktop, by design.
- No push without the desktop running; an independent security
  review is still open (see `docs/ROADMAP-mobile.md`).
