# Changelog

## Unreleased

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
