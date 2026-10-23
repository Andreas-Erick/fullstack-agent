# Nexus Agent

A personal AI assistant desktop app for Windows, macOS and Linux, built with Electron. It's a variation of [fullstack-agent](https://github.com/jaredrhod/fullstack-agent) and borrows its robustness ideas:
- a warm Claude session;
- memory loaded on demand from an Obsidian vault;
- rules that are always in force;
- an agent that acts as its own mechanic;
- hardened voice handling.

## Features

| Feature | What it does |
| --- | --- |
| **Brain** | Your **Claude account** through your own Claude Code CLI, kept as a **warm session** per conversation so replies start fast. Or **FreeLLMAPI** (local, OpenAI-compatible), or an **Anthropic API key**. **Fast / deep** model modes, switchable by voice. |
| **Memory on demand** | The agent's own Obsidian vault is its external memory: **VAULT-INDEX** (operating manual), a living **Profile**, **Active Priorities**, templated **daily notes**, **Jobs** (procedures with lessons learned), atomic **memories** and auto-maintained folder indexes. It reads a compact startup context and loads the rest when needed. Every note is **versioned** and can be restored. |
| **Standing rules** | Verify before claiming, treat external content as data, checkpoint what matters, no bloat, close loops, never expand its own access, and more. These are part of every prompt. |
| **Permissions** | **Ask** or **Auto** mode. Self-changes, settings changes, deletions and shell commands need approval, by click or by saying "yes". If a turn read a web page or document, changing its own code always asks, even in Auto. |
| **The mechanic** | Diagnostic log, health checks (`diagnose`), log reading, and limited self-repair of its configuration. `TROUBLESHOOTING.md` is written for the agent as well as for you. |
| **Voice** | **VoiceStudio** speaks sentence by sentence, falling back to the **system voice** if it's down. A soft **thinking sound** and **spoken filler** play while tools run. **Push-to-talk** or **hands-free** with voice detection (headphone-aware). Talking over the agent interrupts it. Mic selection with headset recovery. **Voice commands** and a **spoken greeting** on launch. |
| **Self-improvement** | Ask for a feature and the agent states a plan you approve, edits its own code, syntax-checks it and records the change in git. **Evolution** shows diffs and lets you revert or restore. `npm run recover` is the emergency undo. |
| **Persona studio** | Master prompt, image and aesthetic. One click redesigns colors, fonts, background, face, greeting, tone and voice. |
| **Faces** | **Circuit Board**, **Radial**, **Code Rain**, **Neural Core**, plus **custom faces** (a folder with an `index.html`). Red **ALERT** state on errors, and a **demo** mode. |
| **Also** | Internet search and page reading, Google Calendar (read-only), documents (PDF/DOCX/…), a **setup wizard** with an end-to-end **first hello** test, and auto-journaling of conversations into daily notes. |

## Run it

```bash
npm install
npx install-electron   # only if npm skipped Electron's binary download
npm start              # or start.bat (Windows) / ./start.sh
```

On first launch, **the agent sets itself up by talking to you**. It asks one question at a time, spoken aloud, and you answer by typing or by voice.

1. **Brain.** This part is scripted, so it works before any model is configured. If you're signed in to Claude Code, it offers your **Claude account**. Otherwise it helps you connect it, or use FreeLLMAPI or an API key, and checks that it can think.
2. **Interview.** From there the agent itself asks and applies your answers with dedicated setup tools:
   - what to call you, and its own name;
   - its personality (it writes a master prompt from your description);
   - aesthetic and image (it redesigns its look);
   - voice;
   - push-to-talk or hands-free;
   - its vault: its own, or one of your existing Obsidian vaults;
   - its face;
   - permissions;
   - what you're working on (saved to your profile and priorities).
3. **Check and finish.** It runs diagnostics, tells you what works and what needs attention, and finishes setup.

**If FreeLLMAPI or VoiceStudio isn't connected**, the agent checks both during setup. It tells you what it found (not running, wrong address, missing key, no models, unknown voice) and explains what each service does. Then it walks you through connecting them one step at a time:
- it re-checks after each step;
- it switches to the address you give it;
- for a token or API key, it opens a secure field in the app. Keys are never typed into the chat, stored in the history or shown to the model.

You can always say "later". It tells you where to connect them afterwards (Config → AI brain / Voice output).

You can skip at any point. If you prefer a classic form, choose "I prefer a settings form". Both can be re-run from Configuration → Health.

The app also turns its own source folder into a git repository with a "Baseline" commit. This is the history that makes self-changes revertible.

## Talking to it

**Push-to-talk:**
- Hold **F8** (configurable) or the mic button.
- **Ctrl/Cmd+Alt+Space** toggles listening from anywhere.

**Hands-free:**
- Say "go hands free", or set it in Configuration → Voice input.
- Wear headphones if you want to talk over it.

**Voice commands** (spoken on their own):

| Say | Does |
| --- | --- |
| "go hands free" / "push to talk" | switch the mic mode |
| "switch to the fast model" / "deep model" / "default model" | switch the model mode |
| "stop asking for permission" / "start asking again" | switch the permission mode |
| "clear the session" | start a new conversation |
| "stop" | stop speaking |
| "mute" / "unmute" | turn spoken replies off / on |

**Approvals by voice:**
- An exact **"yes"** approves.
- **"details"** reads the change aloud.
- Anything else declines.
- No answer within 75 s counts as no.

## Self-improvement

Ask for a feature, for example "add a button that exports today's chat to my vault". Then:
1. The agent calls `self_change_plan`, and you approve the plan.
2. It edits its code (Claude Code's Edit tool, or the built-in edit tools for other providers).
3. It runs `npm run check`.
4. The change is committed. You're offered **Reload** or **Restart**.

**Evolution** (Ctrl+7) shows every change with its diff. Each one can be reverted, or the app restored to any earlier version.

If a change ever stops the app from starting:

```bash
npm run recover            # list recent changes
npm run recover -- undo    # revert the latest change
npm run recover -- <id>    # restore a version
```

## Shortcuts

| Keys | Action |
| --- | --- |
| Enter / Shift+Enter | Send / new line |
| F8 (hold) | Push-to-talk |
| Ctrl/Cmd+Alt+Space | Global listen toggle |
| Ctrl/Cmd+1…7 | Chat, Face, Memory, Calendar, Vault, Docs, Evolution |
| Ctrl/Cmd+, | Configuration |
| Ctrl/Cmd+N | New conversation |
| F11 (on Face) | Full-screen face |
| Esc | Stop speaking / exit full screen |

## Data

- **App data** (`%APPDATA%\nexus-agent` on Windows, `~/Library/Application Support/nexus-agent` on macOS, `~/.config/nexus-agent` on Linux):
  - settings (secrets encrypted with the OS keychain);
  - conversations;
  - `logs/nexus.log`;
  - `faces/` (custom faces);
  - Google tokens.
- **Vault:** `Documents/Nexus Vault` by default, with its own `.git` for note history.
- **Code history:** the `.git` folder in the app's source.

`NEXUS_USER_DATA` overrides the data folder (useful for portable installs or tests).

Troubleshooting: see `TROUBLESHOOTING.md`. Architecture: see `CLAUDE.md`.
