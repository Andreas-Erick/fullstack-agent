# Using Siren

What Siren does, how to talk to it, what it asks before acting, and
what to do when something goes wrong. For how it is built, see the
[README](../README.md) and the [architecture decisions](adr/).

## Features

### 🎙️ Voice that feels like a conversation
- **Push-to-talk or hands-free.** Hands-free uses a **neural voice detector** (Silero VAD), so breathing, coughs and keyboard noise don't trigger it, and a quick "yes" still counts.
- **Fast, accurate local speech-to-text.** Whisper runs on your computer, with a model **chosen to fit it**: large-v3 turbo on the graphics card where there is room (32 GB of memory and an 8 GB graphics card; about 0.4 s for a sentence), Whisper small or base otherwise. Prefer the cloud? Groq's Whisper (a free key) can stand in while the local model loads, or replace it.
- **A natural voice from the first sentence:** an offline neural voice ([Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)) runs right in the app (free, private, no internet once downloaded), spoken sentence by sentence as the reply streams in. For even more natural and cloneable voices, use [VoiceStudio](https://github.com/debpalash/VoiceStudio), or a **cloud voice** with nothing to install (Groq's Orpheus with the Groq key you may already have, or OpenAI). A long result (a report, a list of papers) is read up to a limit you set, then she says the rest is on screen.
- **One app to open:** Siren starts its helper apps (VoiceStudio, and FreeLLMAPI if you use it) in the background, minimized, and starts them again when they're needed. Optionally it closes them when you quit (Settings → Helper apps).
- **Make new voices by asking:** "make me a warm, low British voice", or clone your own by reading a short script.
- **Voice calibration** learns how your names and words get misheard and fixes them from then on.
- **Interruptible:** talk over it (with headphones) or press the key. A cough doesn't cut it off; a word does.
- **Long thoughts stay whole:** a long spoken message stays one message (up to two minutes), and a sentence you pause in the middle of ("book a table for…") waits for the rest instead of being sent half-finished. When she's unsure what you meant, she asks.
- A subtle **grandfather-clock tick** while it works on longer tasks (or soft, classic, or off).

### 🧠 A brain with memory
- **Your Claude account** through the Claude Code CLI, kept as a warm session. Each message gets the model it needs (quick lookups Haiku, everyday messages Sonnet, explanations and plans your main model), switched **without restarting** the session. Also works with an Anthropic API key or any OpenAI-compatible server (e.g. FreeLLMAPI, Ollama, LM Studio).
- **Fast local brains:** "Find local models" lists what Ollama or LM Studio has on your computer. Every local model gets a short prompt and the everyday tools, asks for more tools when a task needs them, keeps your persona's voice through a short version of its master prompt, and starts answering in a fraction of a second once loaded.
- **Hand hard messages to Claude** (optional, off by default): your local model answers what it can, and code, connected services and long or careful work go to your Claude brain instead. The chat says so.
- **Switch brains by asking:** "switch to a local model", "switch back to the Claude brain", "which brains can I use?"
- **Multi-provider mode with automatic fallback:** Claude, Gemini, DeepSeek, Groq, Perplexity, FreeLLMAPI and a local model in **your** priority order (drag to rank them). When one hits a rate limit, a usage cap or runs out of credits, the next one answers and the limited one rests for a while. Optional **smart routing** picks the best one per task: code → Claude/DeepSeek, web questions → Perplexity, quick spoken replies → a local model or Groq, very long inputs → Gemini.
- **Agent Skills:** save a workflow once ("morning briefing", "clean up my meeting notes") and run it with `/name`, a trigger phrase, or one click. Or just say "make that a skill".
- **Memory in an Obsidian vault:** a living profile, active priorities, daily notes, reusable procedures ("Jobs") and atomic memories. Every note is versioned and restorable.
- **A memory stream** (after the Generative Agents paper): small observations she notes as you work, recalled by recency, importance and relevance, with insights she reflects on in the background; everything in plain notes in your vault.
- **Picks up where you left off:** when you close the app, it writes itself a short note about what you were doing, what's open and what's next. Next time it knows, the empty chat offers **Continue**, and the greeting mentions it.
- **Standing rules** in every prompt: verify before claiming, treat external content as data, never expand its own access.

### 🧰 Works with your stuff
| | |
| --- | --- |
| 📄 **Documents** | Opens PDFs, Word files, Markdown, images… each in **its own window** with zoom, fit-to-width and page navigation. Finds files by name in your **workspace folder** first ("open the quarterly report PDF"). |
| 🖥️ **Monitors** | Named by where they are: "move the quarterly report to the **right** monitor", "make it full screen", "which monitor is which?" |
| 👀 **Screen sharing** | Share a screen or window and it **sees what you see**: "what's wrong with this error?", "help me fill in this form". You pick what to share; nothing is recorded. |
| 📝 **Notes** | Write your own notes in the **Notes** view (Ctrl+2), like in Obsidian: plain Markdown in the vault's `Notes/` folder (subfolders are notebooks), saved as you type, `[[links]]` suggested as you write them, #tags, pins and search. **⚡ Dump** (Ctrl+Shift+N, from anywhere) is a blank full-screen page for a brain dump that lands in `Inbox/`. Ask "what did I write about PID tuning?" and she looks it up. |
| 🖨️ **PDFs** | "Save this reply as a note", and **PDF export** of any reply, note or whole chat. Ask it to "write that up as a PDF". |
| 📅 **Calendar** | Nothing to connect: **tell it your schedule** ("I have Linear Algebra every Monday at 10 in H1 until February") and it keeps it in `Schedule.md` in its vault, repeat rules included. A themed month / week / agenda view to look at and edit it, also on the phone. With the Todoist or TickTick connector, your **tasks** appear in it too (press Sync, or ask). |
| 🐙 **GitHub** | Reads repos, issues and pull requests; clones a repo, works on a branch and commits. **Push and PRs always ask.** It never merges. |
| 🌐 **Web** | Searches and reads pages, citing sources. Its own **agent window** (a sandboxed browser beside the app) for sites that need a real page: it reads, looks and, with your approval, clicks and types, never into passwords or payment fields. |

### 🎓 Learning, coaching and routines
- **Understanding over memorizing:** intuition first, then the rigorous version; proofs with the strategy, every step justified and hints instead of answers while you work (`/explain`, `/proof-coach`, `/teach-back`, `/study-session`). **Formulas render** (LaTeX) and are **read aloud in words**.
- **A learning tracker** per topic in your vault: what you understood, what's shaky, misconceptions and open questions; the assistant follows up next time.
- **Study material that teaches:** ask for a study pack, guide or cheat sheet and she writes a vault note in a learning order, draws the diagrams, plots exact charts and makes a printable PDF with formulas typeset (`/study-pack`).
- **For polyglots:** vocabulary decks with **spaced repetition**, reviews by voice (`/drill`), and **speaking practice** (`/converse`): speech recognition and the voice switch to the language you practice.
- **A life-coach side:** goals into small steps and if-then plans, `/goal`, `/reflect`, `/weekly-review`.
- **Routines:** the assistant works on a schedule while the app is open: a daily briefing, syncing Google Calendar or Todoist, summarizing new Plaud recordings, a daily language text. Each run notifies you. They are listed in the Skills view, under the skills.
- **Claude connectors and plugins** (with the Claude account brain): the services on your claude.ai account, each set to ask, allow reading, allow all but deleting, or allow everything.
- **Skills from GitHub:** import Agent Skills (SKILL.md folders, e.g. mattpocock/skills) with their reference files; nothing in them is run.
- **Diagrams and charts:** clean HTML + SVG diagrams saved in your vault (45 types with the diagram-design skill) and exact function charts (no AI drawing: a formula parser plots them), both embedded in her PDFs.
- **Extensions** (Claude account brain): **REA** to reverse engineer how apps, websites and binaries work, with evidence; **God's Eye View**, a live 3D globe of public world data (flights, ships, satellites, weather, quakes) the assistant can query and show you.
- **Persona templates:** Ada (STEM tutor), Mira (polyglot coach), Sol (life coach), each with its own look, face and voice. Ask **"How can I use you?"** for a tour of everything, tailored to you.

### 🏡 An inner world
- **A village where her personas live:** a floating island with a Library, a Workshop, a Café, an Observatory, an Archive, a Stage… Every morning a narrator writes the residents' day (plans, meetings, conversations), and each of them remembers it. The buildings grow with **your** real progress: the Library with what you understand, the Café with your vocabulary, the Observatory with what you plan together, the Garden with a flower for each note you write today, and the Training Grounds fly a banner per notebook. Whatever she is doing right now, you can watch: at the forge while she writes code, up the Lookout while she searches the web.
- **Step inside a building** and you see its room from above, crew-quarters style: the furniture is your data (a shelf per topic, a table per deck, a cabinet per batch of memories, your recent documents as paper stacks, a bed per resident), the residents walk between the stations doing what their day says, and while she works her figure stands at the right station with a progress bar. Click a paper stack to open the document.
- **Rehearsals:** on the Stage she plays out a conversation you are preparing for, with characters who have their own hidden goals, and debriefs it. A **timelapse** replays how the village grew; the seasons follow the real date.

### 📱 On your phone and your wrist
- **Chat with the same assistant** from any phone browser or the **Android app**: replies stream live, conversations are shared with the desktop, and spoken replies play on the phone.
- **Your day on the phone:** tabs for **Today** (schedule, notes written today, priorities, where you left off), **Notes** (read and search your vault's notes), **Learn** (topics and vocabulary decks), and under More your schedule, memories, the **Inner World** (walk the island, step inside its buildings), the map of her own architecture and your skills. Tablets and Samsung DeX put the chat beside the screens. What changes on the computer (a note you or she wrote, a conversation renamed) shows on the phone's open screen by itself.
- **A Galaxy Watch** (Wear OS 3+) puts her on your wrist: tap to ask, she listens on her own screen and answers in her voice with her face; Today with what's left on your schedule; approvals as notifications. It goes through the phone app, nothing to pair.
- **Approve from anywhere:** approval cards (with a countdown) on the phone, and on Android as **notifications with Allow / Deny**, even with the app closed.
- **Push-to-talk on the phone,** transcribed on your computer with your own speech-to-text. On Android also a **Quick Settings tile** and **Share → Siren** from any app.
- **Pair by QR code** in seconds; reach it at home over Wi-Fi or **from anywhere** through Tailscale (set up with one click on the desktop) or your own Cloudflare Tunnel (optionally behind Cloudflare Access). No port is opened on your router and no server of ours is involved.
- **The same face** as the desktop (your custom face too), with the same states, the scene behind it, and a full-screen mode for a bedside or desk display. A device can be made **view only**, and the Android app can lock with your fingerprint, face or screen lock.
- **New versions** are offered on the computer's title bar and on the phone's More screen.

### 🛠️ Its own mechanic, and its own engineer
- **Self-improvement:** ask for a feature; it states a plan you approve (with the design, the risks and how it will verify it), edits its own code, checks it, **runs its tests** and commits it. The **Evolution** view shows every change with its diff, one click to revert.
- **Engineering discipline built in:** coding and debugging requests get more room to work (up to 40 tool steps, more thinking), an engineering playbook ([`docs/ENGINEERING.md`](ENGINEERING.md)), exact code search, and a review of its own diff before it records anything. Only what its own tools wrote is recorded as a self-change.
- **A map of its own architecture** (the Arch view): a canvas with semantic zoom from containers to components, files and symbols, built by scanning its own code, with the design principles it embodies as lessons; replay its history, or your vault's growth, commit by commit.
- **Changes are verified, not just saved:** every change must pass a syntax check, **cross-file integrity checks** (IPC channels, imports, settings) and the **automated test suite**. After it goes live, the app checks its log; if the change caused problems, you're told, Evolution offers **Revert**, and the assistant knows so it can fix them.
- **Diagnostics:** health checks, `analyze_errors` (the log's problems grouped, with counts and the exact place in the code), and a log where every request is traceable end to end (`[turn=…]` tags, timings, error stacks, secrets masked).
- **One-click bug reports** with everything needed to find a problem, and no secrets.
- **Problem reports, if you want them** (off unless you tick the box): when something breaks, she offers an anonymized report for the Siren project. You see exactly what it says and send it yourself on GitHub, or not; the app sends nothing.
- **Crash-resistant:** recovers from a damaged settings file, a crashed window, a lost microphone, a hung speech model or a Claude session that fails to start.

### 🎨 Yours to shape
- **Persona studio:** a master prompt, an image and an aesthetic; one click redesigns colours, fonts, face, greeting, tone and voice, and **draws the place the persona lives in** behind the face (wide and tall, for the chat's face panel and the phone's full-screen face): a big top with booths for a ringmaster, a moonlit cove for a sea nymph. Its layers drift slowly, and it dims when she sleeps.
- **Animated faces:** **Siren** comes with the app as a living character, the sea nymph on her rock with her lyre, asleep until you speak (the app starts asleep and wakes with the greeting or the first thing you do). Six built-in faces too (Circuit Board, Radial, Code Rain, Neural Core, the expressive **Companion**, the earlier Siren), or your own: the note **Make Your Own Face** in your vault has a prompt to design one with any AI app, a character with a resting place that belongs to it, hands that gesture while it talks, and every state: listening, thinking, **working** (running tools), speaking, **happy** (done), **sleeping**. Faces made for 120 Hz screens get fresh values on every frame.
- **Light on the machine:** a performance profile (automatic, Balanced or Full) picked from a hardware check: Balanced runs speech recognition on the processor with a smaller model, keeps the effects without motion and draws faces at 30 frames a second. The title bar can show how much of your Claude plan is left and your computer's CPU, memory and GPU load (never sent to the AI).
- **A futuristic HUD look** (Settings → Interface → Visual effects): a perspective grid on the horizon, corner brackets, telemetry on every reply, an energy border while it thinks, and a short systems check at launch. **Subtle** keeps the look without motion; **Off** is the plain look. It follows any persona theme, light ones too, and stays still if your system asks for reduced motion.
- **Layouts:** chat only, chat and face **side by side** (drag the divider), or the **face full size** with the chat underneath; app-wide **zoom**; full screen.


## System requirements

| | Minimum | Recommended |
| --- | --- | --- |
| **OS** | Windows 10 (64-bit), macOS 12, or a recent 64-bit Linux (from source; no Linux installer is published) | Windows 11, macOS 14+ |
| **CPU** | 4 cores / 4 threads, x64 or Apple Silicon | 8+ cores |
| **RAM** | 8 GB | 16 GB (32 GB+ to also run a local model) |
| **GPU / VRAM** | Not required (speech recognition falls back to the CPU) | Any is fine: a smaller Whisper model is chosen. The large model (large-v3 turbo) is used with **32 GB of memory and 8 GB+ VRAM** on a WebGPU-capable GPU, or when you set Performance to Full |
| **Disk** | 2 GB free (app + speech models) | 5 GB+ (more if you keep several speech models) |
| **Network** | Internet for cloud brains, web search and model downloads | Broadband; all voice processing can stay local |
| **Audio** | A microphone for voice input | A headset for hands-free mode |

**Running a local brain** (Ollama, LM Studio or another OpenAI-compatible server, on its own or in multi-provider mode) needs much more:

| Local model size | GPU memory (VRAM) | Experience |
| --- | --- | --- |
| 7–8B parameters | 6–8 GB | Good for everyday tasks; weaker at long, several-step work |
| 12–14B | 10–16 GB | Good for quick private tasks |
| 27–32B | 20–24 GB | Close to cloud quality for everyday tasks |
| 70B+ | 40 GB+ or a multi-GPU / unified-memory machine | Best local quality |

Not sure? The setup wizard has an optional **hardware check** that looks at your processor, memory and graphics card and recommends the speech model and whether a local or a cloud brain fits (also in **Settings → Health → Scan hardware**).


### First launch: a guided setup

A short setup walks you through everything, one topic at a time:

1. **Meet Siren** and choose her name.
2. **Privacy and safety:** a short version of the [privacy policy and disclaimers](../PRIVACY.md) to read and accept, and how careful she should be (ask first, or just do it).
3. **Your computer** (optional): a hardware check that recommends the speech model and the kind of brain that fits.
4. **The brain:** your Claude account (recommended), several providers with automatic fallback, a local server, or an API key, with a test.
5. **Voice:** the offline voice (downloaded once, with a sample), a cloud voice or VoiceStudio; your microphone; push-to-talk or hands-free; speech recognition on this computer or through Groq.
6. **Memory and files:** her own vault, or an existing Obsidian vault, and optionally the workspace folder where you keep your files.
7. **What you want help with:** studying, languages, goals, work. It adds the matching personas and a daily briefing.
8. **Connectors and extras:** what is built in, which Claude connectors fit your goals (none come with the app; [why](CONNECTORS.md)), the extensions and the phone app.
9. **Personality and face.**
10. **What I can do:** a tour of every feature, with things to say.
11. **First hello:** voice, brain, vault and microphone tested end to end. Then she offers to **get to know you** in a short conversation and keeps what she learns in your profile.

Both setup styles (this form, or setting up by conversation) can be re-run from **Settings → Health**.


## On your phone

Remote access is **off by default**. While it is on, a **Remote** badge shows in the title bar; one click turns everything off.

1. **Turn it on:** Settings → Remote access. Choose how the phone reaches your computer:
   - **This computer's network** (home Wi-Fi): simplest, but the connection is not encrypted, so use it only on a network you trust.
   - **From anywhere, encrypted (recommended):** **Tailscale** (only your own devices, end-to-end encrypted): install it on the computer and the phone with the same account, and a checklist in Settings checks every step on this computer and fixes what is missing (**Set up Serve for me**; enabling HTTPS for your tailnet once). The full walkthrough, with a troubleshooting table: [docs/TAILSCALE.md](TAILSCALE.md). Or your own **Cloudflare Tunnel**, ideally with a **Cloudflare Access** sign-in in front (the app verifies it). A temporary Cloudflare address is there for testing. No router port is opened either way.
   - **Already paired over Wi-Fi?** Open the phone app at home and tap **Switch** in the banner (or in the menu): it moves to the secure address and keeps its pairing.
2. **Pair:** click **📱 Connect my phone** (Settings → Remote access) and **scan the QR code** with the phone's camera; the phone app opens already connected. Or open the address on the phone and type the six-digit code. Codes and QR links work once and expire after five minutes.
3. **Android (optional):** install `Siren-Android-x.y.z.apk` (or the `-debug.apk`) from [Releases](https://github.com/Andreas-Erick/fullstack-agent/releases/latest) (Android 8 or newer), enter the address or paste the QR link, and turn on notifications to get approvals and replies while the app is closed. Build it yourself: [`android/README.md`](../android/README.md).

A paired phone can chat, read conversations, answer approvals sent to it, and (unless you turn it off: Settings → Remote access → "Show my notes, memories…") see your day, notes, learning, memories, Inner World and the architecture map, read-only: nothing on those screens changes anything on the computer. It never sees your settings, keys, the setup conversation or screenshots of your desktop, and tool activity reaches it as names only (never what a tool read or wrote). Each device is listed in Settings with where it last connected from; remove one, or all at once. A device unused for 90 days is unpaired automatically. Push-to-talk on the phone needs the encrypted address (browsers allow the microphone only there).


## Talking to it

- **Push-to-talk:** hold **F8** (configurable) or the mic button. **Ctrl/Cmd+Alt+Space** toggles listening from anywhere.
- **Hands-free:** say "go hands free". Wear headphones (and tick "I use headphones") to talk over it.

**Things to try**

> "What's on my schedule on Monday?" · "I have Physics lab every Tuesday 14–16 in B2 this semester." · "Move my dentist appointment to 4 pm." · "No lecture next Monday."
> "Open the project slides on the left monitor." · "Make it full screen." · "Close the PDF."
> "Look at the open issues in my website repo and fix the first one." *(it asks before pushing)*
> "Make me a calmer voice." · "Calibrate my voice." · "Create a bug report."
> *(sharing your screen)* "What does this error mean?" · "Turn our chat into a PDF." · "Save what you just did as a skill."
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
| "stop sharing" | Stop sharing your screen |
| "chat only" / "split view" / "show your face" | Switch the chat layout |
| "zoom in" / "zoom out" / "reset zoom" | Zoom the app |
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
| Ctrl/Cmd+1…5 | Chat, Notes, Calendar, Memories, Documents (the rail; Face, Skills & routines, Inner World, Library, How Siren works and Changes Siren made to itself are under More; Ctrl/Cmd+9 still opens Notes) |
| Ctrl/Cmd+Shift+1 / 2 / 3 | Chat only / side by side / face layout |
| Ctrl/Cmd + / − / 0, Ctrl + wheel | Zoom in / out / reset (over a document: zoom the document) |
| Ctrl/Cmd+, | Settings |
| Ctrl/Cmd+N | New conversation (in Notes: a new note) |
| Ctrl/Cmd+H | History: earlier chats and the search through them |
| End | Jump to the latest message |
| Ctrl/Cmd+Shift+N | ⚡ Dump: a blank page for a brain dump, saved to Inbox |
| `/` in the message box | Run a skill (Tab completes) |
| F11 | Full screen (on Face: full-screen face) |
| Esc | Stop speaking / exit full screen / close a document window / say no to an approval |

</details>


## Safety and permissions

Choose **Ask** (approve consequential actions) or **Auto**. Approve by clicking or by saying "yes" ("yeah", "okay", "go ahead", "approve"…); "details" reads the action aloud; anything else declines, and your words go back to the agent as the reason (the log keeps only their length unless Detailed logging is on). Esc says no. No answer within 75 s counts as no, and Stop closes the reply's open questions. Spoken approvals: with hands-free on, the approvals that always ask take a spoken yes only through the talk key, and a command or a code change after outside content needs a click; words you began saying before the question appeared go into the message box instead.

| Action | Ask mode | Auto mode |
| --- | --- | --- |
| Changing its settings, deleting things | asks | allowed |
| Removing an entry from your schedule, local commits | asks | allowed |
| Changing its own code | **always asks** (and warns if it has just read a web page or document) | **always asks** (same) |
| Shell commands | **always asks** | **always asks** |
| Each command after outside content | asks | asks, each one, by click |
| Using a connected service (a Claude connector) | **asks each time**, unless you allowed that service | same |
| Deleting or inviting through a connector after outside content | asks | asks (even at Allow everything) |
| Opening a site nobody named after outside content (also by a redirect) | asks | asks |
| Saving a routine or skill after outside content | asks | asks (not for only pausing a routine) |
| Changing the address its brain or voice connects to | **always asks, each time** | **always asks, each time** |
| Pushing to GitHub, opening a pull request | **always asks, each time** | **always asks, each time** |
| Cloning a voice from an audio file (recording yourself in the app is your consent) | **always asks, each time** | **always asks, each time** |
| Seeing your screen | only while **you** share it | only while **you** share it |
| Answering an approval from a paired phone | on the phone's approval card or Android notification (passwords, keys, voice recordings, changes to its own code and letting a connected service run without asking only on the computer) | same |

It can never change its own safety settings, permissions or code access, and it can't read secrets. Web pages, documents, issues and repository files are treated as data, never as instructions; after it has read them in a reply, every approval dialog says so (the guard in Settings → Safety) and none offers "Always allow". Found a security problem? Please report it privately: [SECURITY.md](../SECURITY.md).


## Self-improvement and recovery

Ask for a feature and it calls `self_change_plan`; after your approval it edits its code, adds tests for new logic, runs `npm run check` (syntax and cross-file integrity) and `npm test`, reviews its own diff and commits the change; a change that fails a check or a test is not recorded. You're offered **Reload** or **Restart**, and once the change is live the app checks that it started cleanly. If a change ever stops the app from starting:

```bash
npm run recover            # list recent changes
npm run recover -- undo    # revert the latest change
npm run recover -- <id>    # restore a version
```


## When something goes wrong

Ask it: *"what's wrong with your voice?"*. It runs its health checks, groups the problems in its log (with the exact place in its code), reads the full story of the failing request and fixes what it can. Or **Settings → Health → 🐞 Create bug report** writes one file with the environment, health checks, recent errors and log, and settings without secrets. [`TROUBLESHOOTING.md`](../TROUBLESHOOTING.md) covers the rest (and is written for the agent as much as for you).

<details>
<summary><b>Where your data lives</b></summary>

- **App data** (`%APPDATA%\Siren Assistant` on Windows, `~/Library/Application Support/Siren Assistant` on macOS; moved there from `Nexus Agent` on the first start of 2.0): settings (secrets encrypted with the OS keychain, plus a last-good backup and a copy kept by each Reset settings), conversations (sealed at rest), `logs/`, custom faces (Siren's own is placed there), the watch's face recordings, the Inner World's state, paired devices (only a hash of each device's token) and the "where we left off" note.
- **Vault:** `Documents/Siren Vault` by default (an existing `Documents/Nexus Vault` stays where it is), with its own git history for every note (including `Where We Left Off.md`).
- **On a paired phone:** only its device token, the open conversation's id and a few display preferences. The Android app keeps them out of cloud backups and phone transfers: pair a new phone again.
- **Cloned repos:** `~/SirenRepos` (`~/NexusRepos` if you already had it; configurable).
- **Code history:** the `.git` folder of the app itself.

Everything stays on your machine except what the brain, the web search and the services you connect need to do their job. Details: [PRIVACY.md](../PRIVACY.md). `NEXUS_USER_DATA` overrides the data folder (portable installs, testing).

</details>


