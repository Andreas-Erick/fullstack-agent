# Changelog

## 1.3.0 — 2026-10-24

- The calendar no longer needs Google. *(Tell the assistant your schedule, "I have Linear Algebra every Monday at 10 in H1 until February", "dentist on the 28th at 2", and it keeps it in `Schedule.md` in its vault, repeating entries included: every day, weekdays, chosen weekdays, every few weeks, monthly, yearly, with a first and last day and skipped dates ("no lecture next Monday"). You can read and edit the note in Obsidian. Google Calendar sign-in and iCal links are gone; their settings and the saved Google sign-in are removed when you start the app.)*
- A new Calendar view in the app's look. *(Month grid, a week time grid with a live "now" line, and an agenda; today's readout with what's next, your repeating entries and any unreadable lines on the side. Add and edit entries (one-time or repeating, all day or with times), skip a single day, delete. Each entry keeps its color; with the futuristic effects on it gets instrument-panel details. Keys: ← → to move, T for today, N for a new entry.)*
- A Schedule screen on the phone and in the Android app. *(Calendar button in the header: the week with a dot per entry, the chosen day as a timeline, "now" and "next" with a countdown; swipe for the next day. Read-only; "Tell the assistant" adds new things.)*
- One tap to move the phone to the secure address. *(Paired over Wi-Fi and a secure address is set up (Tailscale or Cloudflare)? The phone shows "Switch": it moves to the https address and keeps its pairing, with a new token, so the one that crossed the plain network stops working. In the Android app too.)*
- Easier Tailscale. *(Settings → Remote access → Tailscale: "Detect" reads this computer's Tailscale name and whether Tailscale Serve forwards to Nexus (and gives the command if not); "Check" opens the address from this computer to prove it works; the status says so. The Android setup and error screens explain Tailscale, Cloudflare and Wi-Fi addresses, have a Paste button and scroll on small screens.)*
- A more polished phone app. *(Suggestions to start a chat, conversations grouped by day, tool activity in words ("Added to schedule"), a recording bar with time and level while you hold the mic, and the connection (encrypted or not) in the menu.)*

## 1.2.0 — 2026-10-24

- Only one app to open. *(Nexus now starts VoiceStudio and FreeLLMAPI itself when your settings use them: at launch, in the background with their windows minimized, and again when the voice or the FreeLLMAPI brain is needed and not running. Only apps on this computer, from their install folder or a location you set, and never one that is already running. Settings → Helper apps shows their status with a "Start now" button, and can close them when you quit Nexus (only the ones it started). Health shows them too, and the assistant can start one when you ask.)*

- The phone and Android app now show the same face as the desktop. *(All five built-in faces (Circuit Board, Radial, Code Rain, Neural Core, Companion) with the theme's colors and shape, and the full set of states: listening, thinking, working, speaking, the short "done" glow after a reply, and sleeping after quiet minutes. The face reacts to your voice while you hold the mic and to the spoken replies, and follows the assistant whoever started the reply, desktop or phone. Changing the face on the desktop reaches the phone when it reconnects. Custom faces stay on the computer; the phone shows the default face then.)*

- A more futuristic look: the HUD layer. *(Desktop: a perspective grid drifting toward a glowing horizon, fine scanlines, corner brackets on every panel, numbered monospace instrument labels, a command bar with the time and session uptime, replies stamped with name, time and model, hexagonal avatars, a holographic shimmer while a reply streams, an energy border around the message box while the assistant thinks, a reactor around the empty-chat orb, views that materialize, time-stamped notifications, and a short systems-check boot screen that shows what is actually set up. Phone and Android: the same language, a "link" readout, an instrument ring around the face and a connect splash; the Android app's own setup and error screens and its launch splash match. Settings → Interface → Visual effects: Futuristic, Subtle (no motion) or Off. It follows every persona theme, light ones too, and stays still when your system asks for reduced motion.)*

- Stronger coding and self-improvement. *(Coding, self-change and debugging requests now get room to work: up to 40 tool steps instead of 8, and more thinking on the Claude API. The assistant follows an engineering playbook (`docs/ENGINEERING.md`): understand the code and every caller, design with risks and a verification plan the user approves, implement, test, review its own diff, then record. New tools: exact code search with context, a file outline, an architecture map, a review of its own uncommitted changes, and running the tests.)*
- Self-changes are verified more deeply. *(Besides the syntax check, every change must pass new cross-file checks that catch the mistakes that break the app at runtime (a missing IPC channel, an import that no longer exists, a setting without a default) and an automated test suite (`npm test`, 29 tests, about two seconds). After a change goes live, the app checks its log; if the change caused problems you get a notice, Evolution shows them with a Revert button, and the assistant knows so it can fix them.)*
- Better self-diagnosis. *(New `analyze_errors`: the log's problems grouped into distinct issues with how often, when, and where in the code. Health shows the last self-change's result, recent problems grouped, free disk space, and how exposed remote access is.)*

- Added remote access (preview), step 1 toward a mobile app. *(Settings → Remote access: a companion server, off by default, on this computer or your local network. Pair a phone or another computer with a one-time code; it can chat, read conversations and answer approvals, never change settings. Devices can be removed at any time.)*
- Added a phone app (preview), served by remote access. *(Open the address shown in Settings → Remote access in the phone's browser and enter the pairing code. Chat with live replies, conversations, approval cards, a face, and replies read aloud. Push-to-talk comes with secure remote access.)*
- Added secure remote access from anywhere (preview). *(HTTPS through your own Cloudflare Tunnel (optionally behind Cloudflare Access, whose sign-in the app also verifies), Tailscale Serve, or a temporary Cloudflare address for testing. No router port is opened. Push-to-talk works on the phone over it. A "Remote" badge in the title bar shows while remote access is on; click it to turn everything off.)*
- Added an Android app (preview, `android/`). *(Wraps the phone app. Approvals arrive as notifications with Allow / Deny, and replies arrive while the app is closed; a Quick Settings tile and a shortcut start push-to-talk; Share → Nexus from any app. No third-party libraries, and no push service.)*
- Approvals now close everywhere once answered anywhere (desktop, phone or notification), and a device that connects later still sees approvals that are waiting.
- Tightened what paired devices receive. *(Tool activity reaches them as names only, never a tool's inputs or results; the setup conversation never reaches them; a device unused for 90 days is unpaired; stricter security headers, with HSTS on the secure address; pairing codes other than six digits count as a wrong try.)*
- Added pairing by QR code. *(Settings → Remote access → Pair a device shows a QR code next to the six-digit code: scan it with the phone's camera and the phone app opens already connected. The link carries a one-time secret that never reaches a server log, works once and expires after 5 minutes. In the Android app, paste the link, or share it to Nexus, on the setup screen.)*
- More remote-access hardening. *(Remove all devices at once; each device shows where it last connected from (secure address, local network, address); slow or idle connections are cut and the number of connections is capped.)*
- Added "Where we left off". *(When you close the app, the assistant writes itself a short note about the latest conversation: where it stands, open threads, next steps. Next time it knows, the empty chat shows the note with a "Continue" button, and the spoken greeting mentions it. Takes a few seconds at most; "Skip" closes at once. Also saved as "Where We Left Off" in the vault. Settings → Obsidian vault: "When I close the app, note where we left off".)*
- Improved the phone app. *(It no longer jumps to the bottom while you read further up; a button jumps to the latest instead. It shows a banner when the computer can't be reached and a notice on the unencrypted local-network address. Approvals show a countdown and the outside sources that were read, and their buttons wait a moment so a stray tap can't answer them. Also: copy a reply, search conversations, the pairing code connects on its sixth digit, crisp icons, focus outlines, reduced motion, and no face panel on short screens. Links in replies open outside the app.)*
- Made the example custom face "Pulse Rings" look like a finished face. *(Glowing orb, rippling rings, a waveform while speaking.)*

## 1.1.0 — 2026-10-24

### UI, layout & visuals
- Added zoom and scroll navigation controls. *(Zoom the whole app with the title-bar control, Ctrl + / Ctrl − / Ctrl 0 or Ctrl + mouse wheel; a "↓ Latest" button jumps back to the newest message; documents zoom on their own with Ctrl + wheel.)*
- Improved multi-monitor selection with positional labels. *(Monitors are Left / Center / Right, with Center-left / Center-right for four and Top / Bottom when stacked; "move the PDF to the right monitor". Numbers still work.)*
- Added new facial visualization animations. *(New states on every face: working while tools run, happy when a reply is done, sleeping after a quiet while; plus a new expressive "Companion" face with eyes, brows and a mouth that moves with the voice.)*
- Polished the document popup modal UI. *(Custom title bar with file type, name and folder; page navigation, zoom, fit to width; "Save as PDF" for Markdown and text.)*
- Added full-screen toggle for chat and visualization panels. *(Chat only, side by side with a draggable divider, or the face full size with the chat underneath; F11 for full screen; Ctrl+Shift+1/2/3.)*

### AI, providers & agent capabilities
- Added multi-LLM routing and automatic quota fallback. *(Claude account, Claude API, Gemini, DeepSeek, Groq, Perplexity and FreeLLMAPI; optional smart routing picks the best provider for each task; rate limits, usage caps and exhausted credits switch to the next provider and rest the limited one.)*
- Added customizable API provider priority ordering in settings. *(Drag to reorder, switch providers on and off, live status of each one.)*
- Added customizable Agent Skills for task automation. *(A Skills view, `/slash` commands with suggestions, trigger phrases, and agent tools to save and run skills.)*
- Added real-time screen sharing support. *(Pick a screen or window; each message carries a fresh screenshot and the agent can look again; nothing is recorded.)*
- Added native note-taking and PDF generation tools. *(Quick notes with Ctrl+Shift+N, "Save as note" and "PDF" on any reply, export a whole chat as PDF; agent tools `create_pdf` and `quick_note`.)*
- Simplified calendar integration setup. *(Connect read-only in a minute by pasting an iCal link; Google sign-in now imports the downloaded OAuth JSON file and opens the sign-in right away.)*

### Onboarding, installation & cross-platform
- Updated setup wizard with optional hardware detection and model recommendations.
- Added standalone Windows installer to GitHub Releases. *(Setup .exe, .msi and portable .exe, built by a GitHub Actions workflow when a version tag is pushed.)*
- Roadmap: researching mobile companion app, PWA support, and Cloudflare remote access. *(See [docs/ROADMAP-mobile.md](docs/ROADMAP-mobile.md).)*

### Documentation & compliance
- Added minimum and recommended hardware specifications to README.
- Added privacy policy and usage disclaimers. *(See [PRIVACY.md](PRIVACY.md).)*

## 1.0.0

- Initial release: streaming chat, voice in and out, memory vault, Obsidian knowledge base, Google Calendar, documents and monitors, GitHub, self-improvement with history, diagnostics.
