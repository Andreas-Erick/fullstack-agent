# ADR-0004: The user's Claude Code CLI as a brain, tools over MCP

Status: Accepted · Date: 2026-11-22

## Context

Many users have a Claude subscription but no API key. The app's
tools (vault, calendar, approvals, self-change…) live in the
Electron main process, behind the approval gate.

## Options considered

- **API only** (the Anthropic SDK path in `main/llm.js`). Full
  control; needs a key and pay-per-token billing. Kept as an option.
- **Embed an agent SDK in the app.** One process; still needs a key
  and duplicates what the CLI already does with a plan.
- **Spawn the user's own CLI headless (`stream-json`) and expose the
  app's tools to it as a local MCP server.**

## Decision

The last option, as one of several brains. `main/claudecode.js`
runs the CLI; `main/mcp-server.js` is the MCP server it starts, and
forwards each call to `main/bridge.js` in the main process, where
`approve()` and the approval gate decide. The project settings
source is not loaded, so the repo's own agent docs (~50k tokens)
stay out of every chat, and permission rules from the user's config
can't bypass `approve()`.

A conversation's session lives in `main/claudesession.js`: resumed
across restarts, rolled over past a size limit, pre-warmed so the
prompt cache is filled before the user's next message.

## Consequences

- Cost follows the user's plan, not the app; the title bar shows the
  plan's usage from the CLI's own rate-limit events.
- The app depends on the CLI's output format and wording (offline
  detection, auth errors); tests pin the parts it reads.
- Values reach a command line, which on Windows goes through
  cmd.exe: `cliValue` and `spawnCli` refuse anything but plain model
  ids and known effort levels (`test/claudesession.test.js`).
- Session warm-up, rollover and model choice add real complexity;
  it lives in one module so callers only say what they want.
