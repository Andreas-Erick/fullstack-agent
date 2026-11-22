# Architecture decisions

Why Siren is built the way it is. Each record states the problem,
the options weighed, the choice and what it costs.

- [0001](0001-no-build-step.md) — Plain JavaScript, no build step
- [0002](0002-outside-content-taint.md) — Mark turns that read
  outside content, and ask again
- [0003](0003-gated-self-change.md) — Self-change only behind
  check, tests and git
- [0004](0004-claude-code-cli-as-brain.md) — The user's Claude Code
  CLI as a brain, tools over MCP
- [0005](0005-companion-server-surface.md) — Paired devices get a
  small, trimmed, mostly read-only API
- [0006](0006-pure-core-io-shell.md) — Rules in pure core modules,
  I/O in thin shells

New record: copy the shape of an existing one (Context, Options
considered, Decision, Consequences), number it next, link it here.
