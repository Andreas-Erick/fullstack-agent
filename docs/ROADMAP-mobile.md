# Roadmap (R&D): mobile access and remote connectivity

*Status: all four steps are implemented as a preview. Step 1 is the companion server and pairing in `main/companion.js` (Settings → Remote access). Step 2 is the phone client in `renderer/remote/`, served by that server at `/`. Step 3 is secure remote access in `main/tunnel.js`. Step 4 is the Android app in `android/` (see `android/README.md`). Before a public release: the security checklist below, especially an independent review.*

### Step 4 (as built)
- Neither of the options considered below: a native shell in plain Java with no third-party libraries. A Trusted Web Activity needs one fixed origin baked into the APK, but every user has their own address. Capacitor would add a build toolchain for features the framework already has.
- WebView locked to the user's address (plus `*.cloudflareaccess.com` for the Access sign-in when the address is https); other links open in the browser. The bridge `window.NexusAndroid` answers only while that address is loaded.
- Optional background connection (foreground service, type `remoteMessaging`) to `/api/events`: approval notifications with Allow / Deny (`POST /api/approvals/:id`), and reply notifications for turns started on this phone (matched by the device name in `userMessage.remote`). Uses the Access cookie from the WebView when present.
- The server now keeps open approvals and replays them to a device when it connects, and every answered approval is broadcast as `approval:cancel`, so a card or notification closes everywhere once it is answered anywhere.
- Quick Settings tile and app shortcut "Talk" (`nexusTalk()`, tap-to-stop), share sheet (`nexusShare(text)`).
- Device token encrypted with an Android Keystore key; `allowBackup=false`.
- Distribution: the release workflow attaches the APK to each GitHub Release (signed with the maintainer's key when the signing secrets are set, debug-signed otherwise); it can also be built locally (README). Not done: Play Store.

### Step 3 (as built)
- `remote.tunnel`: `quick` (cloudflared, temporary `trycloudflare.com` address, testing only), `cloudflare` (the user's named tunnel; connector token encrypted in settings and passed via `TUNNEL_TOKEN`, never on the command line), `tailscale` (the user runs `tailscale serve --bg <port>`; we accept its hostname, can detect it and check it end to end). A device paired on the LAN moves to the secure address with a one-time secret (`/api/move`, redeemed only through the tunnel), which rotates its token. cloudflared is found on PATH or the usual install folders, restarted after a drop (5 times per 10 minutes), and stopped with remote access.
- Requests through the tunnel are recognized by the public hostname (Host header) and need an `https://` Origin. With `accessTeam` + `accessAud` set, every tunnel request must carry a valid `Cf-Access-Jwt-Assertion` (RS256 against the team's published certs; issuer, audience and expiry checked).
- Push-to-talk on the phone (HTTPS only): `POST /api/transcribe` with a 16 kHz mono 16-bit WAV (≤ 60 s, 30 per minute). The window transcribes it with the configured speech-to-text (`remote:transcribe` → `remote:transcribed`), then the phone sends the text as a message.
- Desktop status pill "Remote" (title bar) while remote access is on; one click turns everything off.
- Since added: pairing by QR code (a one-time secret in the link's fragment), background notifications in the Android app (step 4, without a push service). Not done: an independent security review.

### Step 2 client (as built)
- Pairing screen, then chat with live streaming, tool chips, a conversation drawer, a small animated face, and approval cards (Allow / Deny).
- 🔈 reads replies aloud through the desktop's VoiceStudio (`POST /api/speak`; the text goes to VoiceStudio on the desktop, the audio comes back to the phone).
- Name and colors come from the desktop theme (`GET /api/info`).
- Turns started on the desktop or another device in the open conversation show up live.
- **Needs HTTPS (step 3):** push-to-talk (browsers allow the microphone only on secure pages; until then the phone keyboard's dictation works), the offline app shell (`sw.js`, registered only in a secure context) and a full "install app" prompt. On plain HTTP, "Add to Home Screen" makes a shortcut.

### Step 1 API (as built)
All routes except `ping` and `pair` need `Authorization: Bearer <token>`; POST bodies are JSON (≤ 64 KB).
- `GET /api/ping` → `{ app, api }`
- `POST /api/pair` `{ code, name }` → `{ token, deviceId, name }` (code from Settings; 5 min, one use, 5 tries)
- `GET /api/events` → Server-Sent Events: `chat.event`, `approval.request`, `approval.cancel` (same payloads as the desktop IPC events)
- `GET /api/conversations`, `GET /api/conversations/:id`
- `POST /api/chat` `{ text, conversationId? }` → `{ requestId, conversationId }` (20 per minute per device)
- `POST /api/chat/:requestId/abort` (own turns only)
- `POST /api/approvals/:id` `{ allow }` (only approvals streamed to devices)
- `GET /api/info` → `{ name, colors, voice }`; `POST /api/speak` `{ text }` → audio (60 per minute per device)
- Without a token: the client's static files only (a fixed list in `STATIC`, strict CSP).

- `POST /api/transcribe` (body `audio/wav`) → `{ text }` (step 3)

## Goal

Talk to the same assistant (same memory, vault, skills, calendar and tools) from a phone or another computer, while the brain and data stay on the user's own desktop.

## Principles

- **The desktop stays the hub.** Data, keys and tools never move to the phone or to a cloud we run. A mobile client is a remote control and a microphone/speaker.
- **Nothing is exposed by default.** Remote access is off until the user turns it on and pairs a device.
- **The same safety rails.** Approvals, the permission mode and the external-content rule apply to remote turns exactly as to local ones; approvals can be answered on the phone.

## Building blocks

### 1. A local companion server (needed by every option)
- A small HTTP + WebSocket server inside the main process, bound to `127.0.0.1` by default.
- Endpoints reuse the existing IPC handlers: `chat:send` and its streamed `chat:event`s, `approval:respond`, conversation list/history, push-to-talk audio upload (transcribed with the configured speech-to-text), and spoken replies as audio.
- **Pairing:** the desktop shows a QR code with a one-time code; the device receives a long-lived token (stored encrypted on the desktop, revocable per device in Settings). Every request is authenticated; tokens are scoped (chat and approvals only, no settings or secrets).
- Rate limiting, request size limits and an audit line in the log for every remote turn.

### 2. Installable PWA (first client; smallest step)
- A responsive web UI served by the companion server: chat with streaming, a hold-to-talk button, approval cards, the face (Companion and Circuit render fine on a phone canvas).
- Installable from the browser ("Add to Home Screen"); a service worker caches the app shell only, never conversations.
- **Limits:** iOS restricts background audio and push notifications for PWAs; microphone access requires HTTPS, which the tunnel (below) provides.

### 3. Remote access through Cloudflare Tunnel
- `cloudflared` runs on the desktop and connects **outbound** to Cloudflare, so no port is opened on the user's router and the home IP stays private.
- **Cloudflare Access** (Zero Trust, free tier for small teams) in front of the tunnel: the user signs in with their email or identity provider before any request reaches the app, in addition to the device token.
- Quick tunnels (`*.trycloudflare.com`) are useful for testing only; a named tunnel on the user's own domain is the supported setup.
- The app would manage `cloudflared` (detect, start, stop, show status) but never ship Cloudflare credentials.
- **Alternatives to evaluate:** Tailscale (private network, no public URL at all; simplest for one user), a LAN-only mode (same Wi-Fi, no internet exposure).

### 4. Android app (after the PWA proves the flow)
- Option A: a **Trusted Web Activity** wrapping the PWA (small, auto-updates with the desktop).
- Option B: **Capacitor** for native features the PWA lacks: background audio, push notifications for approvals and finished replies, a home-screen widget and a quick-settings tile for push-to-talk, Android share-sheet ("send to assistant").
- Distribution: GitHub Releases (APK) first; Play Store later.

## Security checklist before any release
- Threat model covering a stolen phone, a leaked token, a malicious web page reaching the local server (CSRF / DNS rebinding: check `Origin` and `Host`, require the token on every call), and prompt injection arriving through remote input.
- No secrets ever sent to the device; settings and permission changes remain desktop-only.
- Remote access is clearly visible on the desktop (status pill), with one click to cut it off.
- Independent review of the companion server and pairing flow.

## Order of work
1. Companion server + pairing, LAN only.
2. PWA client (chat, push-to-talk, approvals).
3. Cloudflare Tunnel + Access integration (and/or Tailscale guide).
4. Android wrapper with notifications.

Feedback and ideas: open an issue with the `mobile` label.
