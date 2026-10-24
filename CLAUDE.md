# Nexus Agent — notes for the agent modifying itself

This file is read by the assistant (and Claude Code) before changing this codebase. Keep it accurate when the architecture changes.

## Shape of the app
Electron app, plain JavaScript, **no build step**. Node ≥ 22. Run `npm start`; syntax-check with `npm run check`.

- `main/` — Electron main process (CommonJS, Node APIs).
  - `main.js` window, `app://` protocol (serves only whitelisted folders, see `SERVED`), every IPC handler (`handle('ns:method', fn)`).
  - `llm.js` providers + agent tool loop: `openai` (FreeLLMAPI, SSE), `anthropic` (Anthropic SDK), `claude-code` (delegates to `claudecode.js`), `auto` (multi-provider: `router.js`).
  - `router.js` multi-provider mode: the user's ranked list (`routing.order`), smart per-task preference, cooldowns after rate limits / credit caps. Gemini, DeepSeek, Groq, Perplexity run through the OpenAI path via `router.concrete(settings, id)`. A turn falls back to the next provider only before any tool ran (no action runs twice); streamed text is retracted. `runTurn` returns `provider`, stored on the assistant message.
  - `screenshare.js` screen sharing (desktopCapturer thumbnails): started/stopped only by the user; `capture()` gives a JPEG data URL. Images reach the model as `images` on `runTurn` and as `__image` in tool results (`look_at_screen`); `stripImages` keeps them out of stored conversations.
  - `skills.js` Agent Skills (`<userData>/skills/*.md`, frontmatter + steps); `/slug args` in `chat:send` is expanded to the steps (`display` keeps what the user typed). `pdf.js` Markdown/HTML → PDF in a hidden, script-less, offline window. `hardware.js` hardware scan + recommendations. `ics.js` read-only iCal feeds merged into `calendar.events()`.
  - `companion.js` remote access (docs/ROADMAP-mobile.md): HTTP + SSE server, off by default (`remote.*`, desktop-only, not in `SETTABLE`), 127.0.0.1 or LAN. Pairing code → device token (only its hash in `remote-devices.json`). Host/Origin checks, token on every call. Scope: chat (`startTurn` in `main.js`, never a screenshot, never the setup conversation: its events go through `toWindow`), conversations read-only, approvals it was sent (`send()` publishes `chat:event` / `approval:*` to devices). Devices get trimmed copies (`chatForDevice`, `messageForDevice`: tool names only, never inputs or results); a device unused for 90 days is unpaired. Also serves the phone client `renderer/remote/` (plain files, no build, own CSP; only the paths listed in `STATIC`), `/api/info`, `/api/speak` and `/api/transcribe` (phone push-to-talk; the window transcribes via `remote:transcribe`, see `renderer/js/remote.js`, which also runs the title-bar "Remote" pill).
    Pairing: 6-digit code or the QR code (`renderer/js/qr.js`, no library) whose link carries a one-time secret in `#pair=`; the phone strips it from the address bar before pairing.
  - `handoff.js` "where we left off": on closing (`closeWithHandoff` in `main.js`, also before quit) the agent writes a note about the latest conversation (`<userData>/handoff.json`, mirrored to `Where We Left Off.md` in the vault). Time-limited, Skip-able, basic fallback without the model. Read by `prompt.js` (stable part), the chat's empty state (`renderer/js/handoff.js`) and the launch greeting. Setting `journal.handoffOnClose`.
  - `tunnel.js` HTTPS from anywhere (`remote.tunnel`: quick / cloudflare / tailscale): runs the user's cloudflared, reports the public hostname that `companion.js` accepts, and verifies Cloudflare Access logins (`verifyAccess`). `remote.tunnelToken` is a secret.
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
  - `hud.css` + `js/hud.js` — the futuristic HUD layer (`ui.fx`: hud | subtle | off): ambient grid, corner brackets, telemetry stamps (`data-stamp` on reply bubbles, set in `chat.js`), command-bar clock, energy border, materialize transitions, boot screen. Every rule is scoped to `body.fx-hud` / `body.fx-subtle` (off = the plain look), uses theme tokens only, animates transform/opacity only, and stops under reduce motion (`body.fx-still`). The phone client mirrors it (`renderer/remote/styles.css` HUD section, `fx` from `/api/info`); the Android app's native screens use `android/.../Hud.java`.
  - `styles.css` — all colors are theme tokens: use `rgba(var(--c1), a)` (accent), `--c2`, `--c3`, `--ok`, `--warn`, `--err`, `var(--text)`, `var(--glass)`, `var(--radius)`, `var(--font-display)`… never hard-code colors.
  - `js/faces/` the face gallery (`host.js` switches faces; `common.js` palette/audio helpers and `baseState()`; `radial.js`, `rain.js`, `neural.js`, `companion.js`; the circuit face is `js/visualizer.js`). Agent states: idle, listening, thinking, working (tools running), speaking, happy (reply done), sleeping (`ui.sleepAfterMin`), plus alert; derived in `state.js` `refreshAgentState()`.
  - `js/layout.js` zoom (`ui.zoom`, per-window via `win:zoom`), chat layouts (`ui.chatLayout` chat|split|face, resizable face panel), full screen, screen-share UI, quick notes, chat PDF export. `js/skills.js` Skills view. `js/hwscan.js` hardware scan results (wizard + Health). Custom faces live in `<userData>/faces/<name>/` and use `renderer/faces/core.js`.
  - `js/setup.js` first-run setup by conversation (scripted brain bootstrap, then the agent's interview in a conversation flagged `setup: true`, which uses `prompt.buildSetup()` and only the `setup_*` tools from `main/tools.js`).
  - `viewer.html` + `js/viewer.js` the pop-up document window (opened by `open_document` / "Pop out", closed by `close_document`); `js/docview.js` renders documents for it and for the Documents view (`docs.js`).
  - `js/approval.js` approval dialog (click or spoken yes), `js/commands.js` voice commands, `js/sounds.js` thinking sound, `js/onboarding.js` setup wizard, `js/pcm-worklet.js` mic capture (frames + RMS + a voicing check), `js/vad-worker.js` neural voice detection (Silero via transformers.js) for hands-free mode, `js/stt-worker.js` local Whisper.
  - `js/app.js` boot + wiring (voice routing: pending approval → voice command → chat), `js/nav.js` `switchView()`, `js/state.js` shared state & `saveSettings()`, `js/util.js` (`el()`, `toast()`, `modal()`, `renderMarkdown()`, event bus `on/emit`), `js/theme.js` theme engine, `js/visualizer.js` the face, `js/voice.js`, one module per view (`chat.js`, `memory.js`, `calendar.js`, `knowledge.js`, `docs.js`, `evolution.js`, `settings.js`).
  - Content Security Policy is in `index.html`; external scripts are not allowed — vendor libraries via `node_modules` and add the folder to `SERVED` in `main.js`.

- `android/` — the Android app (plain Java, no libraries; built with Gradle, not part of the desktop package). It wraps `renderer/remote/` and talks to it through `window.NexusAndroid`; changing that bridge or the client's `nexusShare` / `nexusTalk` / `nexusBackgroundChanged` hooks means changing both sides. See `android/README.md`.

## Conventions
- Match the surrounding style: 2-space indent, single quotes, semicolons, small focused functions, short comments only where they add context.
- New setting: add a default in `store.js` `DEFAULTS`, a control in `renderer/js/settings.js` (`text()`, `toggle()`, `select()` helpers bind to `section.key` paths and auto-save).
- New tool: add it to `TOOLS` in `main/tools.js` with a clear description; give it a label in `TOOL_LABELS` in `renderer/js/chat.js`.
- New view: rail button + `<section>` in `index.html`, a module with `init*()`/`refresh()`, wire it in `app.js`.
- Renderer-only changes need a window reload; `main/`, `preload.js` or `package.json` changes need an app restart.
- New npm dependencies can't be installed by the agent; ask the user to run `npm install <pkg>`.

## Engineering method, checks and tests
- `docs/ENGINEERING.md` is how to change this app well: the loop (understand → design → plan → implement → verify → review → commit → learn), design principles, cross-file checklists, security review, tests, debugging, definition of done. Read it before anything beyond a small fix.
- `npm run check` = syntax of every file, then `scripts/verify.js`: integrity across files (IPC handler ↔ preload channel ↔ renderer `api.*` call, relative imports/requires and the names they import, settings keys bound in Settings or in `SETTABLE` exist in DEFAULTS, unique tool names; tool labels as a warning). It reads the code statically through `main/codemap.js` (also behind `code_map` / `code_outline`).
- `npm test` = `test/*.test.js` with Node's built-in runner (no dependencies, offline, a few seconds). Load main modules with stand-ins via `test/helpers.js` (`stub`, `load`, `fileStore`). New logic gets tests; a bug fix gets a regression test.
- `selfchange.commit` (and so every self-change) records a change only if check and tests pass, then marks it pending; after the next restart/reload `verifyAfterLoad` checks the log (`main/errorinsight.js` groups problems) and reports problems to the user, the agent's context (`prompt.turnContext`), Health and Evolution.
- Engineering mode (`main/engineering.js`): coding, self-change and debugging turns get `llm.engineeringToolRounds` (40) tool rounds and at least "high" effort on the Claude API; a turn that starts a self-change is upgraded mid-way.

## When something is broken
Read `TROUBLESHOOTING.md` (→ Reading the log), run `analyze_errors` (distinct problems with code locations) and `diagnose`, read the log (`read_app_log` with the failing line's `turn` id) — then fix the cause, with a regression test.

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
- `companion.js` / `tunnel.js`: the Host/Origin checks, the Cloudflare Access verification, the tunnel token kept out of the command line and logs, the "Remote" pill's one-click off, token check on every route, the approval-id allowlist (`openApprovals`: secret and recording prompts share the pending map and must never be answerable remotely), and the narrow route list. Never add settings, secrets, tools or files to it.
- Screen sharing starts only from the user's click (never from a tool), screenshots are tainted as external content and never stored; the PDF renderer keeps JavaScript off and the network blocked. See `PRIVACY.md` and keep it accurate when data flows change.

## Releases
`package.json` `build` (electron-builder): NSIS setup, MSI and portable for Windows, `asar: false` so an installed copy can still change itself. `.github/workflows/release.yml` builds and publishes on a `v*` tag. Add a `CHANGELOG.md` entry for every version.
