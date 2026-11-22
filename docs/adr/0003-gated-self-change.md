# ADR-0003: Self-change only behind check, tests and git

Status: Accepted · Date: 2026-11-22

## Context

The assistant can change its own code when the user asks for a
feature. A broken edit can stop the app from starting, and the user
may not be a developer.

## Options considered

- **No self-modification.** Safe; drops a core feature.
- **Apply edits directly.** Fast; one bad edit bricks the install.
- **Build a separate staged copy and swap it in.** Strong isolation;
  doubles disk use and needs an updater.
- **Edit in place, keep the change only if checks pass, record it
  as a git commit, verify again after the next start.**

## Decision

The last option, in `main/selfchange.js` `commit`: syntax and
integrity checks (2-minute limit), then the full test suite
(10-minute limit), then a prefixed git commit, then a pending marker.
After the restart `verifyAfterLoad` reads the log through
`main/errorinsight.js` and reports problems to the user, the agent,
Health and Evolution. `scripts/recover.js` (`npm run recover`)
undoes the last change from a terminal when the app won't start.

## Consequences

- Installed copies ship with `asar: false` (`package.json`), so the
  source is editable, and the `runAsNode` fuse stays on because
  checks and tests run with `ELECTRON_RUN_AS_NODE`. Both weaken
  tamper resistance; `build.electronFuses` hardens the rest.
- Every self-change waits for the whole suite (about a minute).
- Self-changes always ask the user (`ALWAYS_ASK`), even in auto mode.
- A commit holds only the files the agent's own tools wrote in that
  turn (`selfchange.touchedBy`, noted per turn), so an edit someone
  else has open in the repo is never swept in. A shell command in the
  turn could have changed anything, so then everything dirty counts.
- A change that can't be marked for the after-load check is logged
  and reported to the agent (`verifyPending: false`), never silent.
  Both are pinned by `test/selfchangecommit.test.js`.
