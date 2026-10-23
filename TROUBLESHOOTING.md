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
- **Use the fast model:** say "switch to the fast model", or enable "Use the fast model for spoken turns".
- **Higher effort means slower replies.**

## The agent is silent (no voice)

- Diagnostics shows the VoiceStudio status. If VoiceStudio is down, the app falls back to the system voice and logs `VoiceStudio failed`. Start VoiceStudio or fix its URL. The agent can fix the URL itself with `settings_update voice.baseUrl`.
- Check that **Voice output → Speak replies automatically** is on, and that you haven't said "mute".
- A voice id that VoiceStudio doesn't know makes synthesis fail. Click **Load voices** and pick one.

## It doesn't hear me

- **Push-to-talk:** hold the key (F8 by default) while speaking and release when done. Recordings shorter than about 0.35 s are ignored.
- **Hands-free:**
  - The mic is ignored while the agent speaks, so it doesn't hear itself.
  - Wear headphones and enable "I use headphones" to talk over it.
  - Raise **Voice detection sensitivity** if quiet speech isn't picked up. Lower it if room noise triggers turns.
- **Wrong microphone:** pick it under Settings → Voice input → Microphone. If the chosen device disappears, the default is used and the log lists the inputs it found.
- **Headset plugged in or unplugged:** the mic reopens automatically (`audio devices changed` in the log).
- **Local Whisper:** the first use downloads the model. "Download / load model now" shows progress. On slow machines use `whisper-tiny.en`.
- **macOS:** allow microphone access for the app in System Settings → Privacy.

## "Approval needed" keeps popping up

- In **Ask** mode, the agent asks before changing its own code, its settings or deleting notes. One approval covers a whole change in that turn.
- Say "stop asking for permission" (or Settings → Safety) to switch to **Auto**. Even then it asks before running shell commands, and before changing its code in a turn that read web pages or documents.
- **Answering by voice:**
  - Approve with an exact "yes".
  - "details" reads the change aloud.
  - Anything else declines, and your words are passed to the agent as the reason.
  - No answer within 75 seconds counts as no.

## A self-change broke something

- **Evolution** (Ctrl+7) lists every change. Use **Revert this change**, or **Restore to this version** on an earlier entry. Then reload the window (UI changes) or restart the app (main-process changes).
- If the app won't start at all, run from the app folder:
  - `npm run recover` lists recent changes.
  - `npm run recover -- undo` reverts the latest one.
  - `npm run recover -- <id>` restores a version.
- "Failed the syntax check": the change was not recorded. Evolution offers **Record** (after fixing) or **Discard**.
- The agent can't install npm packages. Run `npm install <pkg>` yourself if it asks.

## Vault and memory

- **Vault location:** Settings → Vault. The default is `Documents/Nexus Vault`. To move it, set the new folder there, then move the files.
- **Obsidian shows a welcome screen:** the vault isn't in Obsidian's vault list. Close Obsidian, then click **Register in Obsidian**, or use Obsidian's "Open folder as vault".
- **A note was overwritten or deleted by mistake:** open it in the Vault view, then **History** → pick a version → **Restore**. Deleted notes are in the vault's `.trash`.
- **Backups:** the vault's version history is local. For real backups, use File History, Time Machine or a private git remote. Don't run two sync services on one vault.
- **Daily notes are missing entries:**
  - Auto-journal writes a session entry after a conversation has been quiet for 15 minutes (`journaled` in the log).
  - Conversations from earlier runs are caught up about 20 seconds after launch.

## Google Calendar

- "Not signed in" or "token error": Settings → Google Calendar → Sign in again. Google refresh tokens expire after 7 days while the OAuth consent screen is in *Testing* mode. Publishing the app (even unverified) stops that.

## Faces

- **The face stays idle while the agent talks:** the system-voice fallback has no audio analyser, so the face uses a synthetic level. Check VoiceStudio.
- **Red face / ALERT:** something failed recently. The status panel and log say what.
- **Custom faces:**
  - Put a folder with `index.html` (and optionally `face.json`) in `<app data>/faces/`. Start by copying `pulse-rings`.
  - Include `<script src="core.js"></script>`, call `AV.init()`, and read `AV.state`, `AV.level`, `AV.samples` and `AV.env`.
  - Faces run sandboxed, without network access.
