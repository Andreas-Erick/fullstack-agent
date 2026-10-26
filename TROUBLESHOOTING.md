# Troubleshooting

This guide is for the user, and for the agent itself: it is told to act as its own mechanic. It should diagnose first (the `diagnose` tool, or **Configuration → Health → Run diagnostics**), read the log, and only then fix things.

**Log:** `<app data>/logs/nexus.log` (Health → Show log, or the agent's `read_app_log`). It records:
- what was heard and said;
- tool calls and their failures;
- approvals;
- voice fallbacks;
- Claude session starts, stops and crashes;
- compaction and journaling.

Diagnose from the log rather than guessing.

## The brain doesn't answer

**Claude account:**
- "not installed": install Claude Code (`irm https://claude.ai/install.ps1 | iex` on Windows, `curl -fsSL https://claude.ai/install.sh | bash` elsewhere), then click Refresh. If it lives somewhere unusual, set the path to the executable in Settings → AI brain.
- "not signed in": Settings → AI brain → **Connect Claude account**. A terminal runs `claude auth login`. Choose your Claude subscription, not the Console.
- **Usage limit reached:** the error says so. Wait for the reset, or switch the model mode to *fast*.
- **Session exited mid-turn:** look for `claude session exited` in the log. The next message starts a new process and resumes the same conversation automatically.

**FreeLLMAPI:**
- Check that the server is running at the base URL. Test connection lists its models.
- "Model X is not offered": pick an available model. The agent can do this itself with `settings_update llm.model`.
- "rejected tool calls": that model doesn't support function calling. The app retries without tools. Choose a model that supports tools if you want memory, vault, web and self-change tools.

**Anthropic API key:** a 401 means the key is wrong. A 429 means a rate limit; retry later.

## Replies are slow (Claude account)

- **The first turn after launch is cold.** The app starts the session while the greeting plays. "Keep a warm session" must be on.
- **Sessions close after the idle timeout** (20 minutes by default). Raise it in Settings → AI brain.
- **Use the fast model:** say "switch to the fast model", or enable "Use the fast model for spoken turns" (on by default). The running session switches models in place (a `set_model` request), so alternating between speaking and typing doesn't restart it; the log shows `claude model switched`.
- **Higher effort means slower replies.**
- **Where the time goes:** each `reply` line in the log has `firstTextMs` (until the first words arrived) and `totalMs`; each `heard` line has `sttMs` (speech-to-text time). `speech-to-text ready` names the device local Whisper runs on; it should say WebGPU with the dedicated GPU (the app asks Chromium for the high-performance GPU). If it says CPU (WASM), WebGPU failed and the reason is in the same line.
- **A GPU does not speed up the brain**: Claude runs in the cloud. Locally the GPU helps speech-to-text (WebGPU) and the voice (VoiceStudio uses CUDA by itself; its `/system/info` shows `device`).

## The thinking sound

- Settings → Voice output → **Sound while thinking**: grandfather clock (default), mechanical clock, soft, classic or off, plus a volume slider; choosing one plays a preview. It starts only when a reply takes longer than 1.5 seconds. Code: `renderer/js/sounds.js`.

## GitHub

- Works through the GitHub CLI: install it and run `gh auth login` once; Settings → GitHub shows the connection. The tools appear only while gh is signed in (checked every 10 minutes).
- Repos are cloned into Settings → GitHub → Repos folder (default `~/SirenRepos`, or `~/NexusRepos` if it already existed). Work happens on a branch from `github_start_branch`; changes on the default branch are refused. Changing files and committing follow the permission mode; **push and opening a pull request always ask, every time**. There is no merge.
- **"Author identity unknown"** can't happen: without a git identity, commits use your GitHub account and its private no-reply email.
- **"Filename too long"**: clones use `core.longpaths`; if an old clone fails, delete it and clone again.
- With the Claude Code brain, its Read/Edit tools also work inside the repos folder; edits there get the same branch check and approval (`approveRepoEdit` in `main/claudecode.js`). Code: `main/github.js`.

## The agent is silent (no voice)

- Diagnostics shows the VoiceStudio status. If VoiceStudio is down, the app falls back to the offline voice (Kokoro, `renderer/js/tts-worker.js`; Settings → Voice output → "When VoiceStudio is unreachable") and logs `VoiceStudio failed`. While the offline voice is still downloading (first use: about 330 MB on the GPU, 90 MB on the CPU), or if it fails (`offline voice failed` in the log; a missing `phonemizer` package means `npm install`), the system voice fills in. `offline voice ready` names the device it runs on. Nexus starts VoiceStudio by itself (Settings → **Helper apps**: at launch, and again when the voice is needed and nothing answers; first start takes about 20 s while it loads its models). If it is not found, set its location there; if it is on another computer, start it there. The agent can fix the URL itself with `settings_update voice.baseUrl`, or start it with `helper_app_start`.
- **Helper apps** (VoiceStudio, FreeLLMAPI): started only when their address is on this computer and they are not running yet; their windows go minimized to the taskbar. "Close them when I quit Siren" closes only the ones Siren started. Log lines: `helper app starting`, `helper app ready` (with ms), `helper app did not come up`.
- Check that **Voice output → Speak replies automatically** is on, and that you haven't said "mute".
- A voice id that VoiceStudio doesn't know makes synthesis fail. Click **Load voices** and pick one.

## It doesn't hear me

- **Push-to-talk:** hold the key (F8 by default) while speaking and release when done. Recordings shorter than about 0.35 s are ignored.
- **Hands-free:**
  - The mic is ignored while the agent speaks, so it doesn't hear itself.
  - Wear headphones and enable "I use headphones" to talk over it.
  - Raise **Voice detection sensitivity** if quiet speech isn't picked up. Lower it if room noise triggers turns.
  - Speech is detected by a small neural model (Silero VAD, `renderer/js/vad-worker.js`), downloaded from Hugging Face on first use. The log says `neural voice detection ready`, or `neural voice detection unavailable` with the reason, and then the basic loudness detector is used. Settings → Voice input → Voice detector switches between them.
  - Interrupting the agent needs about a quarter-second of real voice, so breathing and coughs don't cut it off. Recordings with no voice in them are dropped before transcription.
  - **Pause that ends your turn** (default 0.6 s): raise it if the agent answers while you are still mid-thought, lower it for snappier replies.
- **It keeps mishearing a name or word, or understands you poorly:** ask the agent to "calibrate my voice" (also offered during setup). You read a short script containing your names and words; it reports how accurately you were understood, learns fixes for misheard names ("lexus" → Nexus, shown under Settings → Voice input, where "Forget what it learned" clears them), recommends a bigger Whisper model when accuracy is low, and tunes the basic detector's sensitivity. It does not retrain Whisper. With the remote engine the names also go along as Whisper's prompt. Code: `main/calibration.js`.
- **Wrong microphone:** pick it under Settings → Voice input → Microphone. If the chosen device disappears, the default is used and the log lists the inputs it found.
- **Headset plugged in or unplugged:** the mic reopens automatically (`audio devices changed` in the log).
- **Local Whisper:** the first use downloads the model. "Download / load model now" shows progress. On slow machines use `whisper-tiny.en`.
- **macOS:** allow microphone access for the app in System Settings → Privacy.

## "Approval needed" keeps popping up

- In **Ask** mode, the agent asks before changing its own code, its settings or deleting notes. One approval covers a whole change in that turn.
- Say "stop asking for permission" (or Settings → Safety) to switch to **Auto**. Even then it asks before running shell commands, and before changing its code in a turn that read web pages or documents.
- **Answering by voice:**
  - Approve with a yes spoken on its own ("yes", "yeah", "yep", "sure", "okay", "go ahead", "do it", "approved", "yes please"). Punctuation from the transcript is ignored.
  - "details" reads the change aloud.
  - Anything else declines, and your words are passed to the agent as the reason.
  - No answer within 75 seconds counts as no.

## A self-change broke something

- **Evolution** (Ctrl+7) lists every change. Use **Revert this change**, or **Restore to this version** on an earlier entry. Then reload the window (UI changes) or restart the app (main-process changes).
- If the app won't start at all, run from the app folder:
  - `npm run recover` lists recent changes.
  - `npm run recover -- undo` reverts the latest one.
  - `npm run recover -- <id>` restores a version.
- "Failed its checks or tests": the change was not recorded. A change is recorded only when every file parses, the cross-file integrity checks pass (`scripts/verify.js`: IPC ↔ preload ↔ renderer, imports, settings keys, tool names) and the tests pass (`npm test`). Evolution offers **Record** (after fixing) or **Discard**.
- **After a change goes live** (restart or reload) the app waits 45 s and checks its log. If the change logged problems, a notice appears, Evolution shows them with **Revert**, and the agent sees them in its next turn so it can fix them. Settings → Health → "Last self-change" shows the result too.
- The agent can't install npm packages. Run `npm install <pkg>` yourself if it asks.

## Vault and memory

- **Vault location:** Settings → Vault. The default is `Documents/Siren Vault` (`Documents/Nexus Vault` for installs from before 2.0). To move it, set the new folder there, then move the files.
- **Obsidian shows a welcome screen:** the vault isn't in Obsidian's vault list. Close Obsidian, then click **Register in Obsidian**, or use Obsidian's "Open folder as vault".
- **A note was overwritten or deleted by mistake:** open it in the Vault view, then **History** → pick a version → **Restore**. Deleted notes are in the vault's `.trash`.
- **Backups:** the vault's version history is local. For real backups, use File History, Time Machine or a private git remote. Don't run two sync services on one vault.
- **Daily notes are missing entries:**
  - Auto-journal writes a session entry after a conversation has been quiet for 15 minutes (`journaled` in the log).
  - Conversations from earlier runs are caught up about 20 seconds after launch.

## Calendar (the schedule)

- **Where it lives:** `Schedule.md` in the vault, one entry per line under `## Recurring` and `## Events` (fields separated by `|`). The agent adds what you tell it; the Calendar view and Obsidian edit the same file. Everything else in the note is left alone. Code: `main/calendar.js` (file), `main/schedulecore.js` (format and repeat rules), `renderer/js/calendar.js` (view).
- **"Unreadable line":** the Calendar view (side panel), Health and `calendar_list_entries` list lines that don't follow the format, with the reason. Accepted: `2026-10-28`, `2026-10-28 14:00-15:00`, `2026-12-21 to 2027-01-06`, `every Monday 10:00-11:30`, `every Tuesday, Thursday 08:15`, `every weekday 07:30`, `every 2 weeks on Friday`, `every day`, `every month on the 15th`, `every year on Mar 14`; extra fields `@ place`, `from DATE`, `until DATE`, `except DATE, DATE`, `note …`, `id …`. Lines that can't be read are kept, never deleted.
- **The calendar says it needs the vault:** the schedule is a vault note; turn the vault on (Settings → Vault).
- **A cancelled lecture:** "skip this day" (in the event's details, or ask the agent) adds the date to `except`; the rule stays.
- **Upgrading from 1.2:** Google Calendar sign-in and iCal links were removed; their settings and the saved Google sign-in are deleted at launch. Tell the agent your schedule once (or paste it in a message) and it fills `Schedule.md`.

## Phone on the secure address (Tailscale)

- **Set up:** Tailscale on the computer and the phone, same account. In Settings → Remote access → Tailscale press **Detect**: it reads this computer's name, whether HTTPS is enabled for your tailnet and whether Serve forwards to the app, and offers the fix. **Set up Serve for me** runs `tailscale serve --bg --yes <port>` (your tailnet only, never the internet). If Tailscale says HTTPS isn't enabled, the page to enable it opens (or: Tailscale admin console → DNS → HTTPS Certificates); enable it, then press the button again.
- **"Couldn't open https://…ts.net (ECONNREFUSED)":** Serve isn't forwarding to the app (or forwards to another port). Run Detect and **Set up Serve for me**. `tailscale serve status` shows what it forwards.
- **The Android app (or phone browser) still uses the Wi-Fi address:** open it at home; the banner offers **Switch** (also in the menu: *Switch to the secure address*). It asks the computer for a one-time secret, opens the `https://…ts.net` address and finishes there: same pairing, new token (the old one stops working). The secret works once, for 2 minutes, and only through the secure address. Or type the `https://` address on the Android setup screen and pair again.
- **"Can't reach the assistant" on a .ts.net address:** the Tailscale app on the phone must be connected. If it is, check `tailscale serve status` on the computer.

## Multi-provider brain

- Settings → AI brain → **Multi-provider**: the list shows each provider's status (Ready, Not set up, or *Skipped for N min* after a rate limit / credit cap / bad key). ↺ tries a resting one again now.
- The log line `route` shows the order chosen for a turn; `provider failed` shows why one was skipped (`kind`: rate, credits, auth, down, other) and for how long.
- **"…after it had already used tools, so this reply was not repeated"**: a provider failed mid-task; the reply isn't re-run elsewhere so no action happens twice. Send the message again; it goes to the next provider.
- Perplexity has no tools (no calendar, notes or memory writes); smart routing only sends it web questions. Providers without image support skip the screenshot (a notice says so).
- Default model names for Gemini, DeepSeek, Groq and Perplexity can go out of date: use **Load models** on the provider and pick a current one.

## Screen sharing

- **Share screen** in the chat picks a screen or window; the red **Sharing** badge stops it. While sharing, each message carries a screenshot (turn that off under Settings → Safety) and the agent can call `look_at_screen`.
- **macOS:** allow Siren Assistant under System Settings → Privacy & Security → Screen Recording, then restart it.
- Sharing stops by itself when the shared window closes. Screenshots are never written to disk or into the conversation. Code: `main/screenshare.js`, `renderer/js/layout.js`.

## Skills

- Skills are Markdown files in `<userData>/skills/` (Skills view → Folder). Run one with `/name` in the chat, its trigger phrase, or ▶ Run. The agent saves skills with `skill_save` (replacing one asks first).

## New voices (VoiceStudio)

- The agent creates voices in VoiceStudio itself: `voice_design` from a description, `voice_clone` from a recording (the user reads a script in the app, or an audio file the agent may open under Settings → Documents). Code: `main/voicestudio.js`.
- **"VoiceStudio is not reachable":** start VoiceStudio; the URL is Settings → Voice output (default `http://localhost:3900`).
- **The sample sounds like the system voice, or takes long:** VoiceStudio loads its speech model on first use, which can take a minute; the offline voice fills in if synthesis fails. Try again once VoiceStudio shows the model as ready.
- **Design ignored part of the description:** VoiceStudio understands gender, age, pitch, speaking style and accent; the tool result lists the words it ignored.
- Cloning from a file always asks first and records whose voice it is (the user's own, or someone who agreed).

## Documents

- **Workspace folder** (Settings → Documents): where you keep your files. "Open the quarterly report PDF" without a location makes the agent call `find_document`, which searches the workspace first (then the other document folders) by file and folder names, in milliseconds. The workspace is always an allowed folder, and relative paths resolve into it first.
- The agent opens each document (PDF, Word, Markdown, text, HTML, images) in **its own window** (`open_document`; up to 8, the oldest closes beyond that; opening an open one brings it forward). Windows open without taking focus, so the push-to-talk key keeps working. Close one with its Close button, Esc, by asking the agent ("close the quarterly report", "close all documents"), or by saying just "close the document" / "close the PDF" (a voice command for the latest one, instant).
- **Full screen / minimize**: "make it full screen", "exit full screen", "minimize the document", "maximize it", "bring back the PDF" act instantly on the latest document window (voice commands); for a specific one ("make the quarterly report full screen") the agent uses `set_window_state`.
- **Monitors**: named by position: Left / Center / Right (Center-left / Center-right with four, Far left / Far right with five, Top / Bottom when stacked; a single monitor is "Main"). "Move the quarterly report to the right monitor", "put it on the left monitor, full screen", "move yourself to the center monitor" (`move_window`: center, maximize, fullscreen, left/right half). Numbers still work (1 = leftmost). "Which monitor is which?" flashes the names (`identify_monitors`). `list_monitors` reports the monitors and where each window is.
- **Zoom in a document**: Ctrl + mouse wheel over it, the − / + buttons, or ⤢ to fit the width. In the pop-out window Ctrl + / Ctrl − / Ctrl 0 work too.
- **PDF export** (`create_pdf`, "PDF" on a reply, ⋯ → Export this chat as PDF): saved in the workspace folder, or `Documents/Siren Exports` (`Nexus Exports` if it already existed), never overwriting a file. Remote images are left out on purpose (the PDF is rendered offline).
- The Documents view has **Pop out** for the file shown there. Code: `main/docwindows.js` (windows and monitors), `renderer/viewer.html` + `js/viewer.js` (a document window), `js/docview.js` (rendering, shared with the Documents view).
- "Access … is not allowed": the agent opens files only in the folders under Settings → Documents (plus files you opened yourself).

## Reading the log

The log is `<userData>/logs/nexus.log` (Settings → Health → Show log / Open log folder; older parts in `nexus.1.log` … `nexus.3.log`). Each line: `time LEVEL [turn=… conv=…] event {details}`.

0. **See the distinct problems first:** `analyze_errors` groups the warnings and errors of the last 24 h (numbers, ids and paths normalized, so one problem repeated 50 times is one line) with counts, first/last time, example `turn` ids and the code locations (`main/voice.js:32`) from the stack traces.
1. **Find the failure:** `read_app_log` with `level: "error"` (or `"warn"`), optionally `since_minutes`.
2. **Trace that request:** take the `turn=` id from the failing line and read the log with `turn: "<id>"`. That shows everything the request did: the `turn` line (provider, model, voice), every tool call with its duration and arguments, approvals, Claude session start/stop/retry, the `reply` line with `firstTextMs`/`totalMs`, or `turn failed` with the error, its cause and the app's stack frames.
3. **Know the setup:** each launch starts with `==================== app start` and an `environment` line (versions, code commit and uncommitted files, OS, CPU, RAM, GPU, monitors, the settings that change behaviour).
4. **Voice timing:** `heard` (sttMs), `reply` (firstTextMs), `first audio` (synthMs, sinceSpeechEndMs).

Also in the log: failed IPC calls (`ipc failed` + channel), console errors of every window, `heartbeat` every 15 minutes (memory, uptime), `tool slow` (> 5 s). A line repeated within 10 s is collapsed into "(previous line repeated N more times)". Secrets (API keys, tokens) are masked before writing.

**Bug report:** Settings → Health → 🐞 Create bug report, or ask the agent (`create_bug_report`): one Markdown file in the log folder with the environment, health checks, all errors and warnings of the last 24 h, the last 600 log lines and the settings without secrets. That file is what to share when asking for help.

## Crashes and recovery (what the app does by itself)

- **Settings file damaged:** restored from `settings.backup.json` (the copy from the last good launch); the damaged file is kept as `settings.corrupt-<time>.json` and a notice appears. Without a backup, defaults are used and the notice says so.
- **Saving:** every JSON file is written atomically (temp file + rename, retried while Windows briefly locks the file) and through one queue per file, so a crash never leaves half a file and an older save never overwrites a newer one.
- **Window crash:** the window reloads (up to 3 times a minute). The GPU/audio helper processes restart on their own (`helper process gone` in the log).
- **Claude session:** a replaced process can no longer end its successor's turn; a process that dies before answering is retried once with a fresh session (`failed to start; retrying`). One that dies mid-work is not retried, so nothing runs twice.
- **Speech-to-text:** a hung or failed transcription restarts the model (`timed out; restarting it` / `reloading the model`), so the mic never waits forever. If the mic stream ends (sleep, USB mic unplugged), hands-free reopens it with retries.
- **Speaking:** playback can't get stuck "speaking" (which would keep the mic ignored): every sentence has a time limit.
- **Deleting a conversation while it replies** stops the reply; it is not saved back.
- **UI errors** are logged as `ui error` / `ui unhandled rejection` (once a minute per message) and never stop the app.
- Leftover temp files (`nexus-cc-*` session folders, `*.tmp` from interrupted saves) are cleaned up at startup.

## Faces

- **The face stays idle while the agent talks:** the system-voice fallback has no audio analyser, so the face uses a synthetic level. Check VoiceStudio.
- **Red face / ALERT:** something failed recently. The status panel and log say what.
- **Custom faces:**
  - Put a folder with `index.html` (and optionally `face.json`) in `<app data>/faces/`. Start by copying `pulse-rings`.
  - Include `<script src="core.js"></script>`, call `AV.init()`, and read `AV.state`, `AV.level`, `AV.samples` and `AV.env`.
  - Faces run sandboxed, without network access.
