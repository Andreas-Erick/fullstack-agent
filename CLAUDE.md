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
  - `memory.js` (Markdown files in `<vault>/Memory`), `obsidian.js` (the vault system: VAULT-INDEX, Profile, Active Priorities, daily notes, Jobs, auto folder indexes, startup context), `vaultgit.js` (note version history), `calendar.js` (read and write events; writes need the `calendar.events` scope), `documents.js`, `voice.js`, `voicestudio.js` (create/clone/delete VoiceStudio voices), `calibration.js` (voice calibration: script, transcript alignment, learned corrections), `github.js` (GitHub via the gh CLI and git: read, clone, branch, commit, push, PRs; work only on branches), `docwindows.js` (document windows and monitors: open/close/move/full screen, numbering left to right), `envinfo.js` (environment snapshot for the log and bug reports), `websearch.js`, `persona.js`, `selfchange.js` (code history), `codebase.js`.
  - `approvals.js` permission gate (ask/auto, per-turn approval, external-content taint). Tools call `requireApproval(ctx, kind, …)`; `ctx.turn` holds the turn state.
  - `logger.js` diagnostic log, `diagnostics.js` health checks, `journal.js` auto daily-note entries.
  - `prompt.js` returns `{ stable, context }`: stable = persona, standing rules, capabilities, vault startup context; context = per-turn (time, calendar, memory changes). Claude Code sessions get `stable` once at spawn and `context` with each message.
- `preload.js` — the only bridge to the renderer. To expose a new IPC handler, add it in `main.js` **and** list the method in `channels` here. Renderer calls `api.ns.method(...)`.
- `renderer/` — UI as ES modules loaded from `app://bundle/renderer/...`.
  - `index.html` static layout (views are `<section class="view" id="view-NAME">`, rail buttons `data-view="NAME"`).
  - `styles.css` — all colors are theme tokens: use `rgba(var(--c1), a)` (accent), `--c2`, `--c3`, `--ok`, `--warn`, `--err`, `var(--text)`, `var(--glass)`, `var(--radius)`, `var(--font-display)`… never hard-code colors.
  - `js/faces/` the face gallery (`host.js` switches faces; `common.js` palette/audio helpers; `radial.js`, `rain.js`, `neural.js`; the circuit face is `js/visualizer.js`). Custom faces live in `<userData>/faces/<name>/` and use `renderer/faces/core.js`.
  - `js/setup.js` first-run setup by conversation (scripted brain bootstrap, then the agent's interview in a conversation flagged `setup: true`, which uses `prompt.buildSetup()` and only the `setup_*` tools from `main/tools.js`).
  - `viewer.html` + `js/viewer.js` the pop-up document window (opened by `open_document` / "Pop out", closed by `close_document`); `js/docview.js` renders documents for it and for the Documents view (`docs.js`).
  - `js/approval.js` approval dialog (click or spoken yes), `js/commands.js` voice commands, `js/sounds.js` thinking sound, `js/onboarding.js` setup wizard, `js/pcm-worklet.js` mic capture (frames + RMS + a voicing check), `js/vad-worker.js` neural voice detection (Silero via transformers.js) for hands-free mode, `js/stt-worker.js` local Whisper.
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
Read `TROUBLESHOOTING.md` (→ Reading the log), run the `diagnose` tool, read the log (`read_app_log` with `level: "error"`, then the failing line's `turn` id) — then fix the cause.

## Logging (`main/logger.js`)
- `log.info|warn|error(event, data)`: short event name, details as an object. Pass the Error object itself (`{ error: err }` or as data), not `err.message`: the logger keeps message, code, cause and stack.
- Work that belongs to a turn runs inside `log.withContext({ turn, conv })` (set in `main.js` `chat:send`; tools get it through `ctx.logTags`, Claude Code output through `Session.inTurn`). New async entry points should do the same.
- Never log secrets or whole documents/prompts; the logger masks known key formats, but don't rely on it. `log.debug` only writes when debug logging is on.
- Renderer code logs through `logEvent(level, event, data)` (lines appear as `ui: …`).

## Safety rails (do not remove)
- `approvals.js` gating, the external-content notice in `tools.js`, the `SETTABLE` allowlist (the agent can't change safety/permissions/code access/secrets), and the standing rules in `prompt.js`.
- `selfchange.js` records every change in git; `scripts/recover.js` undoes the last change if the app no longer starts.
- Crash safety nets (see TROUBLESHOOTING.md → Crashes and recovery): the per-file write queue and settings backup/recovery in `store.js`, the per-child handlers and start-failure retry in `claudecode.js`, the speech-to-text timeout/reload and playback time limits in `renderer/js/voice.js`, window-crash reload in `main.js`.
- Path checks in `files.js`/`codebase.js`/`documents.js`, the private-network block in `websearch.js`, and the IPC surface in `preload.js` protect the user — keep them.
