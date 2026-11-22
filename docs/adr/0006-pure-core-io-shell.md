# ADR-0006: Rules in pure core modules, I/O in thin shells

Status: Accepted · Date: 2026-11-22

## Context

Most of the app's behaviour is rules: when a routine runs, which
brain answers, what a paired phone may see, how a message is run
again, how a vocabulary card is scheduled. Electron windows, the file
system and model calls make that hard to test, and the app changes
itself, so its tests are its safety net (ADR-0003).

## Options considered

- **Logic inside the Electron modules, tested by launching the app.**
  Realistic; slow, flaky and hard to cover edge cases with.
- **Mock Electron and the file system everywhere.** Fast; tests end
  up checking the mocks.
- **Pure modules that take data and return decisions, called by thin
  modules that do the I/O.**

## Decision

The last option. A rule lives in a `*core` module (39 of them, e.g.
`main/routinecore.js`, `main/schedulecore.js`, `main/localcore.js`,
`renderer/js/attachcore.mjs`, `renderer/js/turnstate.js`) that never
requires `electron`, `fs` or `child_process`. Its shell
(`main/routines.js`, `main/calendar.js`, `main/attachments.js`…)
reads and writes, then asks the core. Modules both processes need
are shared `.mjs` files (ADR-0001), so the desktop and the phone run
the same rules.

## Consequences

- Most of the ~1,500 tests run in plain Node in about a minute, and
  can be seeded property tests (persona switches, theme contrast,
  schedules).
- A real launch is still needed for what only a window shows:
  `npm run smoke` and `npm run test:browser`.
- More files: a feature is often a core, a shell and a view. The
  Architecture view (rail "Arch") draws the map from the code.
- The rule must be kept by hand; `test/electronboundary.test.js` and
  `test/faces.test.js` enforce the import limits that matter most.
