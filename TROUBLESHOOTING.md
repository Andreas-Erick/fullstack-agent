# Troubleshooting

This guide is for the user, and for the agent itself: it is told to act as its own mechanic. It should diagnose first (the `diagnose` tool, or **Configuration → Health → Run diagnostics**), read the log, and only then fix things.

**Log:** `<app data>/logs/nexus.log` (Health → Show log, or the agent's `read_app_log`). It records:
- what happened in each turn: lengths, times and which tools ran (with the first 300 characters of what each tool was given, such as a search or a memory to save) and approval titles; not the text of your messages, replies or what you said, unless you turn on Detailed logging (Settings → Health);
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
- "Couldn't check your Claude account": the sign-in check timed out or failed. It doesn't mean you're signed out. The light checks again when you come back to the window (at most every 15 s while it shows a problem) and every 5 minutes; ⟳ Refresh in Settings → AI brain checks at once.
- The title bar's brain light reuses its sign-in check for 10 minutes (30 s while Claude Code is signed out or not found; an answer that fails on the sign-in clears it, so the next check is real). The lights refresh every 5 minutes and when you come back to the window (at most every 5 minutes, every 15 s while one shows a problem). Settings → AI brain → ⟳ Refresh checks at once.
- **Usage limit reached:** the error says so (Claude's newer "You've hit your limit · resets …" too), with the reset time when it is known (from the message or the plan meter), ↻ Try again and Open AI brain settings. Wait for the reset, or switch the model mode to *fast*.
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
- **The log says `claude setting ignored` (field model or effort):** a stored model or effort isn't a plain id (for example a value with % or & in it), so it is left off the CLI's command line and Claude Code's default is used. Pick the model or effort again in Settings → AI brain.
- **A long tool through the Claude account brain:** a rehearsal, a big clone or running a routine may take up to 20 minutes. Past that, the call ends with "The app's tool didn't finish in 20 minutes." (the tool may still finish in the app). "The app closed the connection before the tool finished." means the app's tool bridge stopped mid-call (a restart): ask again.
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
- **The voice light is red ("The offline voice failed: …"):** the offline voice couldn't load, often because the computer was offline while the model was first downloaded. It tries again with the first reply after a minute, and the light turns green once it loads.
- Check that **Voice output → Speak replies automatically** is on, and that you haven't said "mute".
- A voice id that VoiceStudio doesn't know makes synthesis fail. Click **Load voices** and pick one.
- **The greeting or a "one moment" line sounds wrong** (cut off, noise, an old voice): those lines play from audio kept from the last time they were said (Cache Storage beside the offline voice's model; never anything from a conversation). Settings → Voice output → **Forget saved voice lines**; they are made again the next time. `kept voice lines unavailable` (info) in the log means the storage can't be opened and every line is made by the voice as before.
- **The offline voice downloads again on every start, or kept lines never stick** (the model load takes ~25 s each time): the data folder's path is so long that Cache Storage's files pass 260 characters (a `NEXUS_USER_DATA` override in a deep folder), and every write fails with "Entry already exists". Use a shorter path (or a junction).

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
- **"Couldn't write down what you said … The recording is kept":** fix the cause (the Groq key in Settings → Voice input, the connection), then press **Try again** on the notice: the same recording is sent. Only the latest recording is kept, with one notice; **Later** lets it go. While an approval is open, Try again waits until you've answered it.
- **"Couldn't reach Groq" / "… took too long to answer" / "… answered with an error (503)":** Groq (or your own transcription server) couldn't be reached, was too slow, or failed. Speech-to-text already tries up to three times when the service is busy or the connection drops (`stt retry` in the log); the service's own error is in the log (`transcription failed`).
- **macOS:** allow microphone access for the app in System Settings → Privacy.

## "Approval needed" keeps popping up

- In **Ask** mode, the agent asks before changing its own code, its settings or deleting notes. One approval covers a whole change in that turn.
- Say "stop asking for permission" (or Settings → Safety) to switch to **Auto**. The reply: "Okay, I'll stop asking. I still ask before changing my code, running commands, publishing, sending invitations and using services you haven't allowed, and, after reading outside content, before deleting or inviting in your services or opening new websites." Saving a routine or a skill after outside content asks too.
- **It asked before deleting (or inviting) although the service is at Allow everything:** the reply had read outside content (the guard in Settings → Safety). A yes covers that service's next deletes, or its next invitations, for the rest of the reply; deleting and inviting are asked separately.
- **"Open <site>" approval:** a page or a result led to a site you didn't name, or a page redirected there. In a routine, name the site in its instructions, or the question waits and is declined. In the agent window, a page's own move to another site after it has loaded (a click, its script, a meta refresh) isn't asked.
- **It asks before every command:** the reply had read outside content, so each command is shown and asked on its own, by click.
- **Saving a routine asked after it read my services:** saving a routine or a skill after outside content asks, in "Just do it" mode too. In "Just do it" mode a routine that only pauses itself (nothing else changed) doesn't ask.
- **"This one needs a click on the screen":** a command or a code change after outside content isn't approved by voice.
- **"Hold <talk key> and say yes, or click Approve":** with hands-free on, the approvals that always ask (commands, code changes, publishing, invitations, your services, new websites, and after outside content routine and skill saves) take a spoken yes only through the talk key.
- **My words went into the message box:** you started speaking before the question appeared.
- **The approval closed when I pressed Stop:** Stop ends the reply's questions too, on the computer, the phone and the notification.
- **An approval appeared while I was typing in a form:** answer it; your form is still there underneath, with your text, and gets the focus back.
- **Esc on an approval** says no. While the question is being read out, the first Esc only stops the voice.
- **Answering by voice:**
  - Approve with a yes spoken on its own ("yes", "yeah", "yep", "sure", "okay", "go ahead", "do it", "approved", "yes please", "approve", "okay, go ahead"). Punctuation from the transcript is ignored. The agent says whether it approved or declined.
  - "details" reads the change aloud.
  - Anything else declines, and your words are passed to the agent as the reason. The log keeps only how many characters you said (the words only with Detailed logging on).
  - No answer within 75 seconds counts as no.

## A self-change broke something

- **Evolution** (Ctrl+7) lists every change. Use **Revert this change**, or **Restore to this version** on an earlier entry. Then reload the window (UI changes) or restart the app (main-process changes).
- If the app won't start at all, run from the app folder:
  - `npm run recover` lists recent changes.
  - `npm run recover -- undo` reverts the latest one.
  - `npm run recover -- <id>` restores a version.
- **A view shows "couldn't start"** (with Reload and Open Evolution): that part of the window failed to start and the rest works. Open Evolution to revert the last self-change, then Reload.
- **Tests time out** after 2 minutes per test and 9 minutes in all (`test timed out after 120000ms`, `# fail tests timed out after 9 minutes`); a test stuck in a loop is ended by the 9-minute limit. The app's own check and test runs stop after 2 and 10 minutes (`Tests timed out after 10 minutes`); on Windows the processes they started end with them.
- "Failed its checks or tests": the change was not recorded. A change is recorded only when every file parses, the cross-file integrity checks pass (`scripts/verify.js`: IPC ↔ preload ↔ renderer, imports, settings keys, tool names) and the tests pass (`npm test`). Evolution offers **Record** (after fixing) or **Discard**.
- **After a change goes live** (restart or reload) the app waits 45 s and checks its log. If the change logged problems, a notice appears, Evolution shows them with **Revert**, and the agent sees them in its next turn so it can fix them. Settings → Health → "Last self-change" shows the result too.
- The agent can't install npm packages. Run `npm install <pkg>` yourself if it asks.

## Vault and memory

- **Vault location:** Settings → Vault. The default is `Documents/Siren Vault` (`Documents/Nexus Vault` for installs from before 2.0). To move it, set the new folder there, then move the files.
- **Obsidian shows a welcome screen:** the vault isn't in Obsidian's vault list. Close Obsidian, then click **Register in Obsidian**, or use Obsidian's "Open folder as vault".
- **A note was overwritten or deleted by mistake:** open it in the Vault view, then **History** → pick a version → **Restore**. Deleted notes are in the vault's `.trash`; right after you delete one in the Notes view, **Undo** on the notice brings the file back as it was (tags and properties included; if another note took its name meanwhile, it comes back as `<name> 2`).
- **Backups:** the vault's version history is local. For real backups, use File History, Time Machine or a private git remote. Don't run two sync services on one vault.
- **Daily notes are missing entries:**
  - Auto-journal writes a session entry after a conversation has been quiet for 15 minutes (`journaled` in the log).
  - Conversations from earlier runs are caught up about 20 seconds after launch.
- **A memory doesn't show up:** a memory file that can't be read (locked by a sync tool for a moment) is left out of the Memory view and the agent's memories until it can be read again (`memory unreadable` in the log, with a count). A Memory folder that can't be read shows the error with **Try again**. Import (⋯ → Import JSON…) takes a JSON export of memories (⋯ → Export as JSON); any other file says it isn't one.
- **"Discard your changes?" when pressing Esc or clicking beside a form:** the form had edits. Keep editing goes back to it; Discard closes it (Cancel discards without asking).
- **The Vault editor says the note changed elsewhere:** the assistant or another app wrote it while you were editing. Save keeps your text (you're asked first; the vault's history keeps the other version), Cancel loads the new one.
- **Undo after deleting a note says it isn't in the bin any more:** another app emptied the vault's `.trash`, so Undo has nothing to bring back. With the vault's version history on (Settings → Knowledge → Keep a version history of every note; on by default) its last version is still there: the history is a git repository in the vault folder, where `git log --oneline -- "Notes/<name>.md"` lists the note's versions (the newest is the delete) and `git checkout <the version before it> -- "Notes/<name>.md"` brings it back.

## Calendar (the schedule)

- **Where it lives:** `Schedule.md` in the vault, one entry per line under `## Recurring` and `## Events` (fields separated by `|`). The agent adds what you tell it; the Calendar view and Obsidian edit the same file. Everything else in the note is left alone. Code: `main/calendar.js` (file), `main/schedulecore.js` (format and repeat rules), `renderer/js/calendar.js` (view).
- **"Unreadable line":** the Calendar view (side panel), Health and `calendar_list_entries` list lines that don't follow the format, with the reason. Accepted: `2026-10-28`, `2026-10-28 14:00-15:00`, `2026-12-21 to 2027-01-06`, `every Monday 10:00-11:30`, `every Tuesday, Thursday 08:15`, `every weekday 07:30`, `every 2 weeks on Friday`, `every day`, `every month on the 15th`, `every year on Mar 14`; extra fields `@ place`, `from DATE`, `until DATE`, `except DATE, DATE`, `note …`, `id …`. Lines that can't be read are kept, never deleted.
- **The calendar says it needs the vault:** the schedule is a vault note; turn the vault on (Settings → Vault).
- **"Couldn't read your schedule":** `Schedule.md` is there but can't be read (locked by a sync app or a virus scan, or only in the cloud, e.g. OneDrive Files On-Demand). Nothing is written while it can't be read; press **Try again**. The title bar's calendar light turns amber meanwhile.
- **TickTick or Todoist times:** a due time that carries a time zone (`…T23:00:00.000+0000`) is shown in your own time zone; a task due at local midnight from such a time counts as all day.
- **A cancelled lecture:** "skip this day" (in the event's details, or ask the agent) adds the date to `except`; the rule stays.
- **Upgrading from 1.2:** Google Calendar sign-in and iCal links were removed; their settings and the saved Google sign-in are deleted at launch. Tell the agent your schedule once (or paste it in a message) and it fills `Schedule.md`.

## Phone on the secure address (Tailscale)

- **Set up:** Tailscale on the computer and the phone, same account. In Settings → Remote access → Tailscale press **Detect**: it reads this computer's name, whether HTTPS is enabled for your tailnet and whether Serve forwards to the app, and offers the fix. **Set up Serve for me** runs `tailscale serve --bg --yes <port>` (your tailnet only, never the internet). If Tailscale says HTTPS isn't enabled, the page to enable it opens (or: Tailscale admin console → DNS → HTTPS Certificates); enable it, then press the button again.
- **"Couldn't open https://…ts.net (ECONNREFUSED)":** Serve isn't forwarding to the app (or forwards to another port). Run Detect and **Set up Serve for me**. `tailscale serve status` shows what it forwards.
- **The Android app (or phone browser) still uses the Wi-Fi address:** open it at home; the banner offers **Switch** (also in the menu: *Switch to the secure address*). It asks the computer for a one-time secret, opens the `https://…ts.net` address and finishes there: same pairing, new token (the old one stops working). The secret works once, for 2 minutes, and only through the secure address. Or type the `https://` address on the Android setup screen and pair again.
- **"Can't reach the assistant" on a .ts.net address:** the Tailscale app on the phone must be connected. If it is, check `tailscale serve status` on the computer.
- **"Remote: unreachable":** the Tailscale address didn't answer from this computer. Is Tailscale on, and is `tailscale serve` running? The address is checked again every 5 minutes.
- **"Remote: not running":** the remote access server couldn't start, usually because another program uses its port. Pick another port in Settings → Remote access.
- **An error on the phone or the watch shows "…" where a path was:** error messages sent to paired devices never include file paths from this computer, also when a folder name has spaces or an apostrophe (the computer's log keeps the whole message). A malformed request from a device gets a 4xx answer ("Send a JSON object", "Invalid conversation id") and is not logged as a failure.

## Phone and watch

- **The watch shows "Thinking…" and its screen goes off:** the question keeps waiting; the answer is shown (and spoken) when it comes, also if you opened Today meanwhile. The screen stays on while she thinks, up to a minute.
- **After moving to a new phone:** pair it again. Nothing of the app is transferred (the device token included), and nothing of it is in the phone's cloud backup.
- **The phone says "Your computer isn't answering right now" after about 30 s:** the computer is asleep or the link stalled. Your message stays with Try again; tap it once the computer answers.
- **A notification about a change to the app's own code (or letting a service run without asking) has no Allow or Deny:** those are answered only on the computer; the notification says "Approve or deny this one on your computer."
- **You updated the phone app before the computer:** the older computer's page still loads and "Change the address" works, but the notifications and app-lock switches, and Disconnect's sign-out of the app, do nothing until the computer runs the same version.

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

- Skills are Markdown files in `<userData>/skills/` (Skills view → Folder). Run one with `/name` in the chat, its trigger phrase, or ▶ Run. The agent saves skills with `skill_save` (replacing one asks first; after outside content, saving any asks).

## Routines

- **A routine shows "waiting, tries again soon":** its brain wasn't ready, or the internet was down; the line under it says which ("Waiting for the AI brain" / "Waiting for the internet connection"). It tries again every 10 minutes, at most three times (`routine waits` in the log, with `for`).
- **"cut off when the app closed":** the app closed while it ran. That run isn't repeated; the next run first checks what was already done.
- **"stopped":** the chat reply that ran it was stopped, or it was switched off while it ran. "Stopped before it started." means that happened just as it began. A routine that switches itself off or deletes itself at the end of its own run finishes that run and reports.
- **"schedule needs fixing":** its entry in `routines.json` isn't valid (edited by hand or left by an older version: a weekly routine without days, a time like "8", no creation time). It doesn't run, the others do. Open it with Edit and save it (`routine schedule unreadable` in the log, once).
- **A routine that reads your services waits for an approval and is declined:** after outside content (a connector's data, a page), opening a site its instructions don't name, deleting or inviting through a service, or saving a routine or skill asks, and an unanswered question counts as no. Name the sites in its instructions. In "Just do it" mode a routine that only pauses itself doesn't ask.

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
- **Open externally refuses a file:** by design, ↗ Open externally (in a document window: ↗, "Open in its default app") opens only documents, data and pictures: PDF, Word (.docx), Markdown (.md, .markdown), text, CSV/TSV, JSON, logs, PNG/JPEG/GIF/WebP/BMP. Scripts and web pages (.js, .bat, .py, .html, .svg…), which Windows would run, are refused. So is other text the app shows (YAML, XML, code). Use **Show in folder** and open it yourself.
- **A link in a reply or a document does nothing:** a relative link (`[notes](Notes/a.md)`) never navigates the app window; the log says `navigation blocked`. Web links (https://…) open in your browser. For a note, use a [[wikilink]].
- **The Documents view shows a different document than the one I clicked:** it shows the one you opened last; a slower one opened before it no longer lands on top.
- **An attachment was refused or “expired”:** the chat takes up to 6 attachments per message (4 of them images), files up to 25 MB, images up to 50 MB before they are redrawn (to 1568 px). PowerPoint, Excel, old .doc files, archives, programs, sound and video, and HEIC/TIFF pictures are refused with a hint (save as PDF, CSV, .docx, JPEG or PNG). A file that isn't sent within 30 minutes of being added expires, and reloading the window empties the tray (at most 24 files or 150 MB wait at once; the oldest go first): add it again. The log has `attachment prepared` / `attachment refused` (kind, extension and size only, never names or text). Code: `renderer/js/attach.js`, `main/attachments.js`, the rules in `renderer/js/attachcore.mjs`.
- **A PDF or Word file shows “no text found”:** it is scanned, or its text couldn't be read here. The log says why: `text extraction failed` with `took too long` (20 s), `needed too much memory` (the app grew by more than 1 GB while reading it) or the reader's error; or `text extraction skipped` (a Word file whose zip says it unpacks to more than 300 MB, a zip bomb; read_document and the Documents view refuse it too). The brain can still read the saved copy (with the Claude account, Read shows its pages). Copies are in the app data folder → `attachments/<conversation id>/`: deleting the chat deletes them; folders of chats deleted any other way are removed a little after the next start.
- **Try again on a message that was only a picture:** pictures aren't kept with the conversation (only a small preview), so there is nothing to send again: attach the picture again and send it. ✎ Edit with new words sends the words without the picture.
- **Taint is per turn:** a message with attachments is marked as outside content (a change to the app's own code asks and names the files; connector permissions can't be raised in it), but text from an attached file stays in the conversation's context for later messages, which aren't marked.

## Replies and notes on screen

- **A reply's or note's own HTML (a style, a form, a class, a label) shows as plain text or does nothing:** rendered Markdown can't style or operate the app.
- **A formula inside an SVG drawing in a note shows as its source text:** KaTeX's HTML can't go inside SVG.
- **The face slows down when the window isn't in front:** while nothing is happening it rests at 30 fps (20 asleep); so does the village (20).
- **In the Face layout, the state label sits lower in a narrow window:** it stays below the header when the header wraps onto two lines.
- **Clicking through History quickly:** the chat you clicked last opens; a chat that can't be opened says so and leaves the open one.

## Settings and personas

- **"Not saved: the persona changed meanwhile":** personas were switched (in the title bar, by the agent, on your phone or watch, or by a routine) while a change was waiting to be saved. Settings now shows the persona that is active. Make the change again on the persona you want. The app decides this at the moment it saves, so the change never lands in the other persona (`settings change dropped` in the log). A switch in the title bar saves what you just typed first.
- **A Settings section says it couldn't load:** press its **Try again**; the other sections work meanwhile.
- **Reset settings** (Settings → Memory & history): your personas, API keys, and connector and folder permissions go back to the defaults, and the setup wizard opens at the next start; memories, notes and conversations are kept. It takes effect at once: remote access stops (it is off by default), the voice shortcut, logging and helper apps follow, and paired phones and the watch show the default persona. A copy of the old settings is kept (see Crashes and recovery).

## Reading the log

The log is `<userData>/logs/nexus.log` (Settings → Health → Show log / Open log folder; older parts in `nexus.1.log` … `nexus.3.log`). Each line: `time LEVEL [turn=… conv=…] event {details}`.

0. **See the distinct problems first:** `analyze_errors` groups the warnings and errors of the last 24 h (numbers, ids and paths normalized, so one problem repeated 50 times is one line) with counts, first/last time, example `turn` ids and the code locations (`main/voice.js:32`) from the stack traces.
1. **Find the failure:** `read_app_log` with `level: "error"` (or `"warn"`), optionally `since_minutes`.
2. **Trace that request:** take the `turn=` id from the failing line and read the log with `turn: "<id>"`. That shows everything the request did: the `turn` line (provider, model, voice, chars), every tool call with its duration and arguments, approvals, Claude session start/stop/retry, the `reply` line with `firstTextMs`/`totalMs`, or `turn failed` with the error, its cause and the app's stack frames. With Detailed logging on, `turn text`, `reply text` and `heard text` (DEBUG) carry the start of the words (200, 160 and 200 characters).
3. **Know the setup:** each launch starts with `==================== app start` and an `environment` line (versions, code commit and uncommitted files, OS, CPU, RAM, GPU, monitors, the settings that change behaviour).
4. **Voice timing:** `heard` (chars, sttMs), `reply` (firstTextMs), `first audio` (synthMs, the whole wait; for the offline voice also its parts: loadWaitMs = the model still loading, queueMs = sentences ahead of it in the worker, modelMs; `cached: true` = a kept line played from saved audio, with no run, as the launch greeting does from the second start on; sinceSpeechEndMs). For the offline voice:
   - `offline voice ready`: device, importMs, phonemizerMs, tokenizerMs, sessionMs, warmupMs, warmupSkipped (a sentence was already waiting, usually the launch greeting, so that sentence's run warmed the model up), sinceStartMs.
   - The first 40 `offline voice sentence` lines since the window opened (a reload of the voice doesn't start the count again): tokens, phonemeMs, modelMs, audioSec, ahead (sentences queued behind it), and what the window was doing (view, layout, fx, lite, faceFps, focused, visible); the old newLength field is gone. `faceFps` is the most frames a second the faces were allowed while that sentence was made (60 while the voice works, 30 on Balanced, 0 = no limit): a slow sentence with a high or no limit points at the face competing for the graphics card. Fillers made ahead don't count.
   - `offline voice fillers ready` (n, kept, ms, engine): the filler lines and the launch greeting's lines are ready; `n` were made now, `kept` came from the saved audio of an earlier run.
   - `kept voice lines unavailable` (info): the saved voice lines can't be opened in this session, so every line is made by the voice.
   - `filler not made` (info): a filler made ahead failed, for example at a cloud limit; the next quiet moment tries again.
   - The warning `offline voice stopped responding; restarting it`: a sentence ran over 30 s and the worker then stayed silent for another 30 s, so it is restarted and the model loads again.

Also in the log: failed IPC calls (`ipc failed` + channel), console errors of every window, `heartbeat` every 15 minutes (memory, uptime), `tool slow` (> 5 s), `app restart` ("Restart now" after a change to the app's code). A line repeated within 10 s is collapsed into "(previous line repeated N more times)" at that line's level, and `analyze_errors` counts the repeats. Stack frames are short paths from the app's own folders (`main/llm.js:499:23`), never your user folder; a file outside the app shows only its name. One failure is one line. `tool declined` (INFO) is a call you said no to, not a fault; when you said why, it shows "(N characters said)" instead of your words. The `approval` line has `reason` only for the app's own answers (Deny, Esc, the time limit, Stop); for a spoken answer it has `reasonChars`, and the words go to `approval reason` (DEBUG, only with Detailed logging on). `turn not ready` (WARN) is a routine waiting for its AI brain; it tries again by itself. `voice shortcut not registered` (WARN, with the keys and why: in use by another app, or keys that can't be read): choose other keys in Settings → Voice input → Global toggle shortcut. `settings sections reset` (WARN): see Crashes and recovery. `settings change dropped` (INFO): a change typed for a persona that was no longer active (see Settings and personas). `helper app not started` (INFO, `why: 'launch check'`): `npm run smoke` never starts VoiceStudio or FreeLLMAPI. A failed reply's plain message in the chat comes from `chatcore.errorHelp`; the raw text is under Details and in the log (`turn failed`, `ui: reply failed`). Running a message again logs `turn again` (kind again, regenerate or edit; fresh = a new Claude session; acted = how many tools of the replaced reply or attempt had changed something (at most 12 are counted); uncertain; from window or device). `could not record the attempt` / `could not record the failed attempt` (WARN): the record of an unanswered message wasn't written, so after a restart it counts as uncertain and Try again asks first. Secrets (API keys, tokens) are masked before writing.

- **"<tool>: "<option>" must be one of …"** in a tool result: the model sent an option value the tool doesn't have (another case or extra spaces are corrected silently). The call didn't run, and the model usually retries with a listed value. A vault write with an unknown mode is refused the same way, and the note is not changed.

**Bug report:** Settings → Health → 🐞 Create bug report, or ask the agent (`create_bug_report`): one Markdown file in the log folder with the environment, health checks, all errors and warnings of the last 24 h, the last 600 log lines and the settings without secrets. That file is what to share when asking for help.

## Crashes and recovery (what the app does by itself)

- **Settings file damaged:** restored from `settings.backup.json` (the copy from the last good launch); the damaged file is kept as `settings.corrupt-<time>.json` and a notice appears. Without a backup, defaults are used and the notice says so.
- **Some settings went back to their defaults:** a part of settings.json had the wrong shape (null, a string or a list, for example after a hand edit). That part gets its defaults and the notice names it. What belongs to your persona (name, master prompt, look, face, voice) comes back from its saved copy, and the file as it was is kept as `settings.corrupt-<time>.json`. Valid JSON that isn't settings at all (`null`, a list) is treated like a damaged file. The backup is written only after a start that needed no repair, so it stays the last good copy.
- **Reset settings keeps a copy:** `settings.before-reset-<time>.json` in the app data folder, with every persona and the (encrypted) keys. To go back, close the app and rename it to `settings.json`.
- **One damaged conversation file** (a hand edit, an older version) no longer breaks History or New chat: it shows with the messages that can be read. A History list that couldn't be read is read again next time, without a restart.
- **Saving:** every JSON file is written atomically (temp file + rename, retried while Windows briefly locks the file) and through one queue per file, so a crash never leaves half a file and an older save never overwrites a newer one.
- **Window crash:** the window reloads (up to 3 times a minute). The GPU/audio helper processes restart on their own (`helper process gone` in the log).
- **Claude session:** a replaced process can no longer end its successor's turn; a process that dies before answering is retried once with a fresh session (`failed to start; retrying`). One that dies mid-work is not retried, so nothing runs twice.
- **Speech-to-text:** a hung or failed transcription restarts the model (`timed out; restarting it` / `reloading the model`), so the mic never waits forever. If the mic stream ends (sleep, USB mic unplugged), hands-free reopens it with retries.
- **Speaking:** playback can't get stuck "speaking" (which would keep the mic ignored): every sentence has a time limit. The offline voice's worker is restarted if it hangs (`offline voice stopped responding; restarting it`). A stop drops the sentences of the old reply that were still waiting to be made.
- **Deleting a conversation while it replies** (or Settings → Memory & history → Clear history) stops the reply, and the chat leaves "generating" on every brain; it is not saved back. A delete while the message is still being set up stores nothing, and the attached files just copied are removed.
- **UI errors** are logged as `ui error` / `ui unhandled rejection` (once a minute per message) and never stop the app.
- Leftover temp files (`nexus-cc-*` session folders, `*.tmp` from interrupted saves) are cleaned up at startup.

## The old Nexus logo still shows (Windows)

`assets/icon.ico` and the installer carry Siren's face since 2.0.0; the window, taskbar and installer use it. If a
computer still shows the old "N" logo:

- **An older version is installed there.** Help → About (or the title bar's tooltip) shows the version; install the
  current release from GitHub.
- **Windows' icon cache.** Windows keeps icons by file path and may show the old picture for a shortcut or pinned
  taskbar button long after the program changed. Unpin and pin the app again, or rebuild the cache: close the app,
  run `ie4uinit.exe -show` in a Command Prompt (or delete `%LOCALAPPDATA%\IconCache.db` and sign out and in).
- **A shortcut you made yourself** (pointing at the old `Nexus Agent.exe` or a copied folder) keeps whatever icon it
  was made with: make a new one from the installed `Siren Assistant.exe`.

## Faces

- **The face stays idle while the agent talks:** the system-voice fallback has no audio analyser, so the face uses a synthetic level. Check VoiceStudio.
- **Red face / ALERT:** something failed recently. The status panel and log say what.
- **Custom faces:**
  - Put a folder with `index.html` (and optionally `face.json`) in `<app data>/faces/`. Start by copying `pulse-rings`.
  - Include `<script src="core.js"></script>`, call `AV.init()`, and read `AV.state`, `AV.level`, `AV.samples` and `AV.env`.
  - Faces run sandboxed, without network access.
  - **A custom face moves slower while the window isn't in front (and nothing is happening) or Siren sleeps:** it rests at 30 frames a second (20 asleep), like the built-in faces.
  - **A custom face moves slower while the voice speaks:** while the offline voice is loading or making a sentence, and on Balanced, core.js holds the face's requestAnimationFrame to at most 60 (Balanced: 30) frames a second (`AV.maxFps`). Move by the timestamp, never by frame count.
