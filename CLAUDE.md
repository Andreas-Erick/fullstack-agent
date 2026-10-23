# Nexus Agent — notes for the agent modifying itself

This file is read by the assistant (and Claude Code) before changing this codebase. Keep it accurate when the architecture changes.

## Shape of the app
Electron app, plain JavaScript, **no build step**. Node ≥ 22. Run `npm start`; syntax-check with `npm run check`.

- `main/` — Electron main process (CommonJS, Node APIs).
  - `main.js` window, `app://` protocol (serves only whitelisted folders, see `SERVED`), every IPC handler (`handle('ns:method', fn)`).
  - `llm.js` providers + agent tool loop: `openai` (FreeLLMAPI, SSE), `anthropic` (Anthropic SDK), `claude-code` (delegates to `claudecode.js`).
  - `claudecode.js` runs the user's Claude Code CLI headless (`stream-json`); app tools reach it through `mcp-server.js` → `bridge.js`.
  - `tools.js` all agent tools: `{ name, group, description, parameters (JSON Schema), run(args, ctx) }`. `ctx.emit({type,...})` sends events to the UI. Groups are filtered in `activeTools()`.
  - `prompt.js` builds the system prompt (persona, aesthetic, capabilities, memory, vault index, calendar, time).
  - `store.js` settings (`DEFAULTS`, secrets encrypted via `SECRET_FIELDS`) and conversations.
  - `memory.js` (Markdown files in `<vault>/Memory`), `obsidian.js` (the vault system: VAULT-INDEX, Profile, Active Priorities, daily notes, Jobs, auto folder indexes, startup context), `vaultgit.js` (note version history), `calendar.js`, `documents.js`, `voice.js`, `websearch.js`, `persona.js`, `selfchange.js` (code history), `codebase.js`.
  - `approvals.js` permission gate (ask/auto, per-turn approval, external-content taint). Tools call `requireApproval(ctx, kind, …)`; `ctx.turn` holds the turn state.
  - `logger.js` diagnostic log, `diagnostics.js` health checks, `journal.js` auto daily-note entries.
  - `prompt.js` returns `{ stable, context }`: stable = persona, standing rules, capabilities, vault startup context; context = per-turn (time, calendar, memory changes). Claude Code sessions get `stable` once at spawn and `context` with each message.
- `preload.js` — the only bridge to the renderer. To expose a new IPC handler, add it in `main.js` **and** list the method in `channels` here. Renderer calls `api.ns.method(...)`.
- `renderer/` — UI as ES modules loaded from `app://bundle/renderer/...`.
  - `index.html` static layout (views are `<section class="view" id="view-NAME">`, rail buttons `data-view="NAME"`).
  - `styles.css` — all colors are theme tokens: use `rgba(var(--c1), a)` (accent), `--c2`, `--c3`, `--ok`, `--warn`, `--err`, `var(--text)`, `var(--glass)`, `var(--radius)`, `var(--font-display)`… never hard-code colors.
  - `js/faces/` the face gallery (`host.js` switches faces; `common.js` palette/audio helpers; `radial.js`, `rain.js`, `neural.js`; the circuit face is `js/visualizer.js`). Custom faces live in `<userData>/faces/<name>/` and use `renderer/faces/core.js`.
  - `js/setup.js` first-run setup by conversation (scripted brain bootstrap, then the agent's interview in a conversation flagged `setup: true`, which uses `prompt.buildSetup()` and only the `setup_*` tools from `main/tools.js`).
  - `js/approval.js` approval dialog (click or spoken yes), `js/commands.js` voice commands, `js/sounds.js` thinking sound, `js/onboarding.js` setup wizard, `js/pcm-worklet.js` mic capture.
  - `js/app.js` boot + wiring (voice routing: pending approval → voice command → chat), `js/nav.js` `switchView()`, `js/state.js` shared state & `saveSettings()`, `js/util.js` (`el()`, `toast()`, `modal()`, `renderMarkdown()`, event bus `on/emit`), `js/theme.js` theme engine, `js/visualizer.js` the face, `js/voice.js`, one module per view (`chat.js`, `memory.js`, `calendar.js`, `knowledge.js`, `docs.js`, `evolution.js`, `settings.js`).
  - Content Security Policy is in `index.html`; external scripts are not allowed — vendor libraries via `node_modules` and add the folder to `SERVED` in `main.js`.

## Conventions
- Match the surrounding style: 2-space indent, single quotes, semicolons, small focused functions, short comments only where they add context.
- New setting: add a default in `store.js` `DEFAULTS`, a control in `renderer/js/settings.js` (`text()`, `toggle()`, `select()` helpers bind to `section.key` paths and auto-save).
- New tool: add it to `TOOLS` in `main/tools.js` with a clear description; give it a label in `TOOL_LABELS` in `renderer/js/chat.js`.
- New view: rail button + `<section>` in `index.html`, a module with `init*()`/`refresh()`, wire it in `app.js`.
- Renderer-only changes need a window reload; `main/`, `preload.js` or `package.json` changes need an app restart.
- New npm dependencies can't be installed by the agent; ask the user to run `npm install <pkg>`.

## When something is broken
Read `TROUBLESHOOTING.md`, run the `diagnose` tool, read the log (`read_app_log`) — then fix the cause.

## Safety rails (do not remove)
- `approvals.js` gating, the external-content notice in `tools.js`, the `SETTABLE` allowlist (the agent can't change safety/permissions/code access/secrets), and the standing rules in `prompt.js`.
- `selfchange.js` records every change in git; `scripts/recover.js` undoes the last change if the app no longer starts.
- Path checks in `files.js`/`codebase.js`/`documents.js`, the private-network block in `websearch.js`, and the IPC surface in `preload.js` protect the user — keep them.
