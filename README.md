<div align="center">

<img src="assets/logo.png" alt="Nexus Agent" width="112" />

# Nexus Agent

**A personal AI assistant for your desktop: it talks, listens, remembers, and improves itself.**

Voice-first · Claude-powered · Obsidian memory · Runs on your own machine

![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron&logoColor=white)
![Node](https://img.shields.io/badge/Node-%E2%89%A5%2022-339933?logo=nodedotjs&logoColor=white)
![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-555)
![Claude](https://img.shields.io/badge/brain-Claude-D97757?logo=anthropic&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)

[Features](#features) · [Quick start](#quick-start) · [Talking to it](#talking-to-it) · [Safety](#safety-and-permissions) · [Troubleshooting](TROUBLESHOOTING.md) · [Architecture](CLAUDE.md)

</div>

---

Nexus is an assistant you talk to like a colleague. Hold a key (or just speak, hands-free), and it answers in a natural voice within a few seconds, with your calendar, your notes, your documents and your GitHub repos at hand. It keeps its memory in an Obsidian vault you can read and edit, asks before it does anything consequential, and can change its own code when you ask for a feature, with every change recorded and reversible.

> Inspired by [jaredrhod/fullstack-agent](https://github.com/jaredrhod/fullstack-agent): a warm Claude session, memory loaded on demand, standing rules, an agent that is its own mechanic, and hardened voice handling.

## Features

### 🎙️ Voice that feels like a conversation
- **Push-to-talk or hands-free.** Hands-free uses a **neural voice detector** (Silero VAD), so breathing, coughs and keyboard noise don't trigger it, and a quick "yes" still counts.
- **Fast, accurate local speech-to-text.** Whisper large-v3 turbo runs **on your GPU** (WebGPU), about 0.4 s for a sentence on a laptop RTX GPU, with an automatic CPU fallback.
- **Natural voice** through [VoiceStudio](https://github.com/debpalash/VoiceStudio), spoken sentence by sentence as the reply streams in, with the system voice as a fallback.
- **Make new voices by asking:** "make me a warm, low British voice", or clone your own by reading a short script.
- **Voice calibration** learns how your names and words get misheard and fixes them from then on.
- **Interruptible:** talk over it (with headphones) or press the key.
- A subtle **grandfather-clock tick** while it works on longer tasks (or soft, classic, or off).

### 🧠 A brain with memory
- **Your Claude account** through the Claude Code CLI, kept as a warm session. Spoken turns use the fast model, typed ones your default, switched **without restarting** the session. Also works with an Anthropic API key or any OpenAI-compatible server (e.g. FreeLLMAPI).
- **Memory in an Obsidian vault:** a living profile, active priorities, daily notes, reusable procedures ("Jobs") and atomic memories. Every note is versioned and restorable.
- **Standing rules** in every prompt: verify before claiming, treat external content as data, never expand its own access.

### 🧰 Works with your stuff
| | |
| --- | --- |
| 📄 **Documents** | Opens PDFs, Word files, Markdown, images… each in **its own window**. Finds files by name in your **workspace folder** first ("open the decision tree PDF"). |
| 🖥️ **Monitors** | "Move the decision tree to monitor 2", "make it full screen", "minimize the document", "which monitor is which?" |
| 📅 **Google Calendar** | Reads your schedule and **adds, moves and deletes events**. |
| 🐙 **GitHub** | Reads repos, issues and pull requests; clones a repo, works on a branch and commits. **Push and PRs always ask.** It never merges. |
| 🌐 **Web** | Searches and reads pages, citing sources. |

### 🛠️ Its own mechanic
- **Self-improvement:** ask for a feature; it states a plan you approve, edits its own code, checks it and commits it. The **Evolution** view shows every change with its diff, one click to revert.
- **Diagnostics:** health checks, and a log where every request is traceable end to end (`[turn=…]` tags, timings, error stacks, secrets masked).
- **One-click bug reports** with everything needed to find a problem, and no secrets.
- **Crash-resistant:** recovers from a damaged settings file, a crashed window, a lost microphone, a hung speech model or a Claude session that fails to start.

### 🎨 Yours to shape
- **Persona studio:** a master prompt, an image and an aesthetic; one click redesigns colours, fonts, face, greeting, tone and voice.
- **Animated faces:** Circuit Board, Radial, Code Rain, Neural Core, or your own (a folder with an `index.html`).

## Quick start

**Requirements**
- [Node.js](https://nodejs.org) 22 or newer
- A brain: **[Claude Code](https://claude.com/claude-code)** signed in to your Claude account (recommended), an Anthropic API key, or an OpenAI-compatible server
- Optional: [VoiceStudio](https://github.com/debpalash/VoiceStudio) for a natural voice, the [GitHub CLI](https://cli.github.com) (`gh auth login`) for GitHub, a GPU with WebGPU for the fastest speech recognition

```bash
git clone https://github.com/Andreas-Erick/fullstack-agent.git
cd fullstack-agent
npm install
npm start            # or start.bat (Windows) / ./start.sh
```

If npm skipped Electron's binary download, run `npx install-electron` once.

### First launch: it sets itself up by talking to you

1. **Brain.** A short scripted step that works before any model is configured: it finds your Claude account (or helps you connect one) and checks that it can think.
2. **Interview.** Then the agent asks, one question at a time, by voice or text: what to call you and itself, its personality, its look, its voice, push-to-talk or hands-free (with an optional voice calibration), its vault, your workspace folder, its face, its permissions, and what you're working on.
3. **Check.** It runs its health checks and tells you what works and what still needs attention.

Missing services (VoiceStudio, FreeLLMAPI) are diagnosed and connected step by step; API keys go into a secure field, never into the chat. You can say "later" or skip at any point; both setup styles (conversation or form) can be re-run from **Settings → Health**.

## Talking to it

- **Push-to-talk:** hold **F8** (configurable) or the mic button. **Ctrl/Cmd+Alt+Space** toggles listening from anywhere.
- **Hands-free:** say "go hands free". Wear headphones (and tick "I use headphones") to talk over it.

**Things to try**

> "What's on my calendar on Monday?" · "Move my dentist appointment to 4 pm."
> "Open the kNN slides on monitor 1." · "Make it full screen." · "Close the PDF."
> "Look at the open issues in my LanguageCoast repo and fix the first one." *(it asks before pushing)*
> "Make me a calmer voice." · "Calibrate my voice." · "Create a bug report."
> "Add a button that exports today's chat to my vault." *(self-improvement, with your approval)*

<details>
<summary><b>Voice commands</b> (spoken on their own, handled instantly without the model)</summary>

| Say | Does |
| --- | --- |
| "go hands free" / "push to talk" | Switch the microphone mode |
| "switch to the fast model" / "deep model" / "default model" | Switch the model |
| "stop asking for permission" / "start asking again" | Switch the permission mode |
| "clear the session" | Start a new conversation |
| "close the document" / "close the PDF" | Close the latest document window |
| "make it full screen" / "exit full screen" / "minimize the document" / "maximize it" / "bring back the PDF" | Control the latest document window |
| "stop" | Stop speaking |
| "mute" / "unmute" | Turn spoken replies off / on |

</details>

<details>
<summary><b>Keyboard shortcuts</b></summary>

| Keys | Action |
| --- | --- |
| Enter / Shift+Enter | Send / new line |
| F8 (hold) | Push-to-talk |
| Ctrl/Cmd+Alt+Space | Listen from anywhere |
| Ctrl/Cmd+1…7 | Chat, Face, Memory, Calendar, Vault, Documents, Evolution |
| Ctrl/Cmd+, | Settings |
| Ctrl/Cmd+N | New conversation |
| F11 (on Face) | Full-screen face |
| Esc | Stop speaking / exit full screen / close a document window |

</details>

## Safety and permissions

Choose **Ask** (approve consequential actions) or **Auto**. Approve by clicking or by saying "yes" ("yeah", "okay", "go ahead"…); "details" reads the action aloud; anything else declines, and your words go back to the agent as the reason. No answer within 75 s counts as no.

| Action | Ask mode | Auto mode |
| --- | --- | --- |
| Changing its own code, its settings, deleting things | asks | allowed (but code changes after reading a web page or document always ask) |
| Calendar changes to your own events, local commits | asks | allowed |
| Shell commands | **always asks** | **always asks** |
| Anything that emails other people (calendar invites) | **always asks, each time** | **always asks, each time** |
| Pushing to GitHub, opening a pull request | **always asks, each time** | **always asks, each time** |
| Cloning a voice from an audio file (recording yourself in the app is your consent) | **always asks, each time** | **always asks, each time** |

It can never change its own safety settings, permissions or code access, and it can't read secrets. Web pages, documents, issues and repository files are treated as data, never as instructions.

## Self-improvement and recovery

Ask for a feature and it calls `self_change_plan`; after your approval it edits its code, runs `npm run check`, and commits the change. You're offered **Reload** or **Restart**. If a change ever stops the app from starting:

```bash
npm run recover            # list recent changes
npm run recover -- undo    # revert the latest change
npm run recover -- <id>    # restore a version
```

## When something goes wrong

Ask it: *"what's wrong with your voice?"*. It runs its health checks, reads its log and fixes what it can. Or **Settings → Health → 🐞 Create bug report** writes one file with the environment, health checks, recent errors and log, and settings without secrets. [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) covers the rest (and is written for the agent as much as for you).

<details>
<summary><b>Where your data lives</b></summary>

- **App data** (`%APPDATA%\Nexus Agent` on Windows, `~/Library/Application Support/Nexus Agent` on macOS, `~/.config/Nexus Agent` on Linux): settings (secrets encrypted with the OS keychain, plus a last-good backup), conversations, `logs/`, custom faces, Google tokens.
- **Vault:** `Documents/Nexus Vault` by default, with its own git history for every note.
- **Cloned repos:** `~/NexusRepos` (configurable).
- **Code history:** the `.git` folder of the app itself.

Everything stays on your machine except what the brain, the web search and the services you connect need to do their job. `NEXUS_USER_DATA` overrides the data folder (portable installs, testing).

</details>

<details>
<summary><b>Project layout</b></summary>

```
main/       Electron main process: windows, IPC, the agent loop (llm.js), tools (tools.js),
            prompt, memory/vault, calendar, GitHub, documents & monitors, voice services, logging
renderer/   The UI (ES modules, no build step): chat, faces, voice I/O, settings, document viewer
preload.js  The only bridge between the two
scripts/    Syntax check, recovery
```

See [`CLAUDE.md`](CLAUDE.md) for the architecture and conventions; the agent reads it before changing itself.

</details>

## Credits

Built on [Electron](https://www.electronjs.org), [Claude](https://www.anthropic.com/claude) and [Claude Code](https://claude.com/claude-code), [transformers.js](https://github.com/huggingface/transformers.js) (Whisper, Silero VAD), [pdf.js](https://mozilla.github.io/pdf.js/), [marked](https://marked.js.org) and [DOMPurify](https://github.com/cure53/DOMPurify). Voice by [VoiceStudio](https://github.com/debpalash/VoiceStudio). Ideas from [jaredrhod/fullstack-agent](https://github.com/jaredrhod/fullstack-agent).

MIT licensed.
