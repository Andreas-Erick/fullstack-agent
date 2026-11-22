# ADR-0001: Plain JavaScript with no build step

Status: Accepted · Date: 2026-11-22

## Context

The assistant edits its own installed code (see ADR-0003). Whatever
it edits must be exactly what runs: an edit to source that a bundler
later transforms would need a toolchain on every user's machine and a
rebuild before the change could be checked.

The renderer and main process also share pure modules (attachment
rules, chart engine, redo rules, history search, performance limits).

## Options considered

- **TypeScript + bundler (Vite/esbuild).** Types and tree-shaking.
  Every self-change needs a build; installed copies ship output, not
  source; the agent edits files it can't run directly.
- **TypeScript via `tsc` only, no bundler.** Types, but still a
  compile step between edit and run.
- **Plain JS, ES modules in the renderer, CommonJS in main, shared
  `.mjs` files.** What you edit is what runs.

## Decision

Plain JavaScript, no build step. The renderer loads ES modules over
the private `app://` protocol (`main/main.js`, `SERVED`). Modules
both sides need are `.mjs` files that main `require`s (Node 24 /
Electron 45 can require an ES module): `renderer/js/attachcore.mjs`,
`chartcore.mjs`, `redocore.mjs`, `historycore.mjs`, `perfcore.mjs`.

## Consequences

- No static types. Cross-file contracts are checked instead by
  `scripts/verify.js` (IPC handler ↔ preload channel ↔ renderer call,
  settings keys, imported names, unique tool names) and tool
  arguments at runtime (`main/toolargs.js`).
- Types are opt-in and need no build: `jsconfig.json` checks the
  pure `main/*core.js` modules with JSDoc and shared typedefs in
  `main/types.d.ts`. `npm run typecheck` runs TypeScript through
  npx (not a dependency, and not part of the offline `npm test`).
  Most of the code is still untyped.
- Vendor libraries are served from `node_modules` folders listed in
  `SERVED`; there is no CDN and no bundling, so the CSP stays strict.
- Startup loads more, smaller files than a bundle would.
