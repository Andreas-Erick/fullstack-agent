# ADR-0002: Mark turns that read outside content and ask again

Status: Accepted · Date: 2026-11-22

## Context

Tool results can carry prompt injection: a web page, a connector's
answer, an attached file, a document in the user's folders. The agent
also has tools that delete, contact people, open web hosts and write
notes that later turns read as the user's own (memories, profile,
priorities).

## Options considered

- **Trust all results.** Simplest; one injected page can delete or
  send mail with the user's standing approvals.
- **Block outside reads.** Safe; removes web research, connectors and
  attachments, most of the product.
- **Per-call allowlists.** Precise, but every new tool needs its own
  rule and they drift apart.
- **Mark the turn when an outside result arrives, then raise the bar
  for consequential actions for the rest of that turn.**

## Decision

The last option. `main/turnguard.js` `noteResult` is the one rule for
which results taint (app tools marked `untrusted`, WebFetch/WebSearch,
connectors, reads in the user's folders; the app's own refusals never
do). After that, `main/approvals.js`:

- `TAINT_ASKS` kinds ask even in auto mode, and no yes from before
  the taint counts;
- `TAINT_EACH_TIME` (shell commands) asks for every command;
- `askOutbound` asks per new web host, redirects included;
- connectors' deletes and invitations need a fresh yes;
- writes later turns trust go through `guardWrite`, and such a
  memory is stored with `source: outside`;
- no "Always allow" can be given from a tainted turn.

## Consequences

- More dialogs after browsing or attaching a file. That cost is the
  point; the setting `safety.taintGuard` can turn the extra asks off.
- The whole kind × mode × taint table is pinned by
  `test/taintgate.test.js`, from literal sets rather than the
  module's own constants, so removing a kind fails a test.
- Known gap: a page's own navigation after it loads in the agent
  window is not asked (tracked as inj-4).
