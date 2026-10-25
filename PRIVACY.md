# Privacy policy and disclaimers

*Last updated: October 24, 2026 · applies to Nexus Agent 1.1 and later*

Nexus Agent is a desktop app that runs on your own computer. It has **no server of its own, no account system, no analytics and no telemetry**. The project's authors never receive your data. This page explains what stays on your computer, what goes to the third-party services **you** choose to connect, and the limits of what the software promises.

## What stays on your computer

| Data | Where | Notes |
| --- | --- | --- |
| Your schedule | `Schedule.md` in the vault | Plain Markdown you can read and edit; never sent anywhere except as part of the agent's context and to devices you paired |
| Settings | App data folder (`%APPDATA%\Nexus Agent`, `~/Library/Application Support/Nexus Agent`, `~/.config/Nexus Agent`) | API keys and tokens are encrypted with your operating system's keychain (Electron `safeStorage`) where available |
| Conversations | App data folder → `conversations/` | Plain JSON. Screenshots from screen sharing are **never** stored in them |
| Memory, notes, journal, profile, priorities | Your Obsidian vault (default `Documents/Nexus Vault`) | Plain Markdown, versioned with a local git history |
| Skills | App data folder → `skills/` | Plain Markdown |
| Logs and bug reports | App data folder → `logs/` | Known key formats are masked. Bug reports stay local until **you** decide to share one |
| Speech recognition (default) | Runs locally (Whisper via transformers.js) | Your voice is not sent anywhere in the default "local" mode |
| PDF exports | Your workspace folder or `Documents/Nexus Exports` | |
| Paired devices (remote access) | App data folder → `remote-devices.json` | Device name, dates, how and from which IP address it last connected, and a SHA-256 of its token; never the token itself |
| "Where we left off" note | App data folder → `handoff.json`, and `Where We Left Off.md` in the vault | A short summary of the latest conversation, written when the app closes (by your AI provider, like the journal) and replaced each time. Turn it off in Settings → Obsidian vault |
| Android app | On the phone | The desktop's address and the device token (encrypted with an Android Keystore key, not included in backups). Notifications while the app is closed come over a direct connection to your desktop, not through a push service |

Uninstalling the app does not delete your data folder or vault, so nothing is lost by accident; delete them yourself to remove everything.

## What leaves your computer, and to whom

Only what is needed for a feature **you** turned on is sent, and only to the service that provides it. Each service's own privacy policy and terms apply to what it receives.

| Feature | Sent to | What is sent |
| --- | --- | --- |
| AI brain | The provider(s) you configure: Anthropic (Claude API or your Claude account via Claude Code), Google (Gemini), DeepSeek, Groq, Perplexity, or a FreeLLMAPI / OpenAI-compatible server you run | Your messages, the conversation context, the system prompt (which includes your persona, relevant memories, vault excerpts, your schedule for the next days, the current date/time and, with the Claude account brain, the names of your Claude connectors and plugins), tool results, and screenshots while you share your screen. In **multi-provider mode** a message can go to the next provider on your list when one is unavailable |
| Screen sharing | The AI provider answering that message | A screenshot of the screen or window **you** picked, only while sharing is on (red "Sharing" badge). Not recorded, not stored |
| Web search and pages | DuckDuckGo (default), or SearXNG, Brave or Tavily if you choose them, and the websites the agent opens | Search queries and page requests |
| Voice output | VoiceStudio (runs on your computer); when it is unreachable, the offline Kokoro voice (runs in the app) or your operating system's voice | The text to speak, which stays on this computer |
| Remote speech recognition (optional) | The transcription server you configure | Recordings of what you say |
| GitHub | GitHub, through the GitHub CLI you signed in to | Reads, and the pushes and pull requests you approve |
| Claude connectors and plugins (off by default) | The services you connected on claude.ai or added as Claude Code plugins (for example Todoist, Google Calendar, Canva, Slack), through Claude Code and your Claude account | What the agent puts into each call you approve (a task, a search, a design request…). Each call asks you first unless you ticked "always allow" for that service in Settings → AI brain. What the services return goes to the AI brain like any tool result |
| Model downloads | Hugging Face (and a CDN for runtime files) | Downloads the speech, voice-detection and offline-voice models (and the offline voices) once; no personal data |
| Remote access (preview, off by default) | Only the devices **you** pair, directly (this computer, or your local network if you allow it); no server of ours in between | Your conversations, the replies as they stream, approval requests, your schedule (read-only, only the days the phone shows), the agent's name and theme colors, and spoken replies (made by VoiceStudio on this computer) if you turn them on. Tool activity shows as names only: what a tool was given or returned (file contents, commands, notes) stays on this computer. Never settings, keys, the setup conversation or screenshots of this desktop. A device unused for 90 days is unpaired automatically. On the local network the connection is not encrypted yet. The phone keeps only its device token, the open conversation's id and the 🔈 choice, in its browser storage. Push-to-talk recordings (secure address only) are transcribed on this computer with your speech-to-text setting and not kept |
| Secure remote address (optional) | Cloudflare (Tunnel, and Access if you set it up) or Tailscale, under **your** account | The same traffic as above, encrypted from the phone to Cloudflare's or Tailscale's network and on to this computer. Cloudflare can see the traffic it relays (it ends HTTPS at its edge); Tailscale connections are end-to-end encrypted. The temporary Cloudflare address is public: protect it with pairing and turn it off after testing |

The app never sells, shares or uploads data on its own initiative. The private-network block in web fetching, the approval gate for consequential actions, and the "external content is data" rule are described in the [README](README.md#safety-and-permissions).

## Your choices

- Use **local** speech recognition and a **local** model server to keep conversations entirely on your computer.
- Turn features off in **Settings** (internet, calendar, GitHub, Claude connectors, journaling, screen-sharing screenshots per message).
- Remove individual memories, notes, conversations and skills at any time, or clear them all in **Settings → Memory & history**.
- Delete API keys in each provider's console. (Earlier versions could sign in to Google Calendar; that is gone, and its saved sign-in is deleted at launch. You can also remove the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).)

## Disclaimers

- **Provided "as is".** Nexus Agent is open-source software under the MIT License, without warranty of any kind. To the maximum extent permitted by law, the authors are not liable for any damages arising from its use. See [LICENSE](LICENSE).
- **AI output can be wrong.** Language models make mistakes and can state false things confidently. Check important information (medical, legal, financial, safety-related) with a qualified source. The agent is not a professional adviser.
- **Actions on your behalf.** The agent can add to your schedule, write notes, change files in its workspace, push code to GitHub and change its own code, within the permissions you set. Consequential actions ask for approval in "Ask" mode; in "Auto" mode many do not. You are responsible for what you approve and for the permission mode you choose.
- **Self-modification.** Code changes the agent makes to itself are recorded and can be reverted, but they can still break the app; `npm run recover` undoes the last change. Installing an update replaces the app's files, including changes the agent made to itself.
- **Third-party services and costs.** You are responsible for complying with the terms of every service you connect (including acceptable-use policies and rate limits) and for any charges they bill. Multi-provider mode can send a message to a paid provider when a free one is unavailable; order and switch providers in Settings → AI brain.
- **Other people's data.** If you share your screen, calendar, documents or voice recordings that contain other people's information, make sure you are allowed to. Only clone a voice that is yours or whose owner agreed.
- **Not for high-risk use.** Do not use Nexus Agent where a failure could cause injury, significant financial loss or harm to others.

## Children

Nexus Agent is not directed at children, and the AI providers it connects to set their own minimum ages.

## Changes and contact

Changes to this policy are recorded in the repository history and the [changelog](CHANGELOG.md). Questions or concerns: open an issue at [github.com/Andreas-Erick/fullstack-agent/issues](https://github.com/Andreas-Erick/fullstack-agent/issues).
