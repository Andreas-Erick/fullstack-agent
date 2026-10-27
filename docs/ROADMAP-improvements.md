# Improvement roadmap (October 27, 2026)

What else is worth upgrading, found while fixing the 2.0.3 batch and adding the history replays. Each
item says why it matters, what it would take, and a rough effort (S < 1 h, M ≈ half a day, L ≈ a day
or more). Ordered by how much it matters day to day. The Inner World's own ideas stay in
`ROADMAP-inner-world.md`, the phone's in `ROADMAP-mobile.md`; the October audit (`AUDIT-2026-10.md`)
is done and not repeated here.

Pick an item, read `ENGINEERING.md`, and start; tick the box and note the version when it ships.

## 1. Self-updating desktop and Android apps — L

- [x] **Done in 2.1.0, as an update *check*:** `main/updates.js` asks GitHub's releases API (no new
  dependency), the title bar's Update pill opens the download, and paired Android apps learn the newest
  APK through `/api/info`. Still open: installing in place with `electron-updater` (the user runs
  `npm install electron-updater`; needs the signing secrets so it installs without warnings).
- **Why:** releases publish to GitHub, but nothing checks for them. Every version is a manual
  download, which is how the laptop ended up on an old build with the old logo.
- **What:** `electron-updater` (a new npm dependency: the user runs `npm install electron-updater`)
  against the existing GitHub publish; a "new version ready, restart to update" pill in the title bar
  (a fold rule in `styles.css`), a setting `updates.check` (user-only), the check on start and once a
  day. The Android app asks the GitHub releases API for the newest `Siren-Android-*.apk` and offers it
  (the watch APK comes with the phone's). Needs the signed Windows and macOS builds (release.yml
  secrets) so the update installs without warnings.
- **Where:** `main/main.js` (startup), a new `main/updates.js`, `renderer/js/usage.js`-style pill,
  `android/.../MainActivity.java` (a menu entry in the drawer), `PRIVACY.md` (one request to GitHub).

## 2. A browser test for the phone and tablet client — M

- [x] **Done in 2.1.0** with Electron as the browser (no Playwright): `npm run test:browser`. WebKit
  (Safari) is still untested: it needs Playwright's WebKit.
- **Why:** `renderer/remote/app.js` and `screens.js` (about 2,300 lines) have no tests; the
  tablet's black village and the Safari question could not be checked from the desktop.
- **What:** a test that starts the companion server with stand-ins (as `test/companion.test.js`
  does), pairs a device, loads the real page in headless Chromium (pre-installed with Playwright in the
  cloud environment; locally `npx playwright install chromium`) at phone and tablet sizes, opens every
  screen (the Inner World and the Architecture map included) and fails on any console error or
  unhandled rejection. WebKit the same way when available, for Safari. Marked slow and skipped when no
  browser is installed, so `npm test` stays fast.
- **Where:** `test/remoteclient.browser.test.js`, `scripts/test.js` (a `--browser` flag).

## 3. Testable renderer views — L (incremental)

- [ ] **Started in 2.1.0:** chat (`renderer/js/chatcore.js`). Next: the settings cards' field definitions.
- **Why:** 14 of 59 test files touch `renderer/js`, all pure modules. The views (`settings.js`
  at 1,600 lines, `chat.js`, `voice.js`) have none; layout bugs like the vertical "Remove" button
  live there.
- **What:** the pattern already used elsewhere, pure core plus thin host: move chat's message
  rendering (Markdown, tool chips, stamps) and the settings cards' field definitions into modules
  that take data and return nodes or descriptions, test those with a stand-in document, keep the
  hosts thin. One view at a time; chat first.

## 4. Split `main/tools.js` — M

- [x] **Done in 2.1.0:** `main/tools/<group>.js` + `main/tools/common.js`.
- **Why:** 1,900 lines, every tool in one file; the architecture map, self-changes and reviews all
  get coarser because of it.
- **What:** `main/tools/<group>.js` (calendar, learning, habits, vault, world, browser…), each
  exporting its tools, registered into the same `TOOLS` list in `tools.js`; nothing else changes
  (`TOOL_LABELS`, `activeTools()`, `SETTABLE` stay). `archcore.js` COMPONENTS gets the folder;
  `test/modules.test.js` already checks every tool's schema.

## 5. A health signal for the phone link — S/M

- [x] **Done in 2.1.0.**
- **Why:** the title-bar pill knows only whether the tunnel is up, not whether a phone is
  connected, when a device was last seen, or that the background connection gave up (now silent by
  design).
- **What:** the pill's tooltip and Settings → Remote access show connected devices and last-seen
  times (the data is in `remote-devices.json` and `companion.status()`); a toast when a device
  connects or drops for long; the watch's face freshness ("face from 09:12") on its device row.
- **Where:** `renderer/js/remote.js`, `renderer/js/settings.js` (remoteCard), `main/companion.js`
  (`status()` already carries `connected`).

## 6. Inner World: the cheap roadmap items — S each

- [x] **Timelapse** (2.1.0; `ROADMAP-inner-world.md` item 7): the replay built for the Architecture map
  (`renderer/js/replay.js`), pointed at the village's chronicle days instead of git: buildings
  rising level by level, banners appearing.
- [x] **Level-up celebrations** (2.1.0; item 1): a glow on the building and a line in the panel when a place
  gains a level, driven by `world:event`.
- Leave the expensive ones (talking to a resident, soundscape) as they are.

## 7. Vault links and the index — L (when wanted)

- [x] **Done in 2.1.0:** `main/linkindex.js` (links and backlinks, map edges, the `vault_links` tool).
  Search does not use it yet.
- **Why:** the Growth replay and the vault map (`main/replaycore.js` vaultMap) have no edges; the
  audit deferred an inverted index until about 10,000 notes.
- **What:** a link index (`[[wikilinks]]`, kept by `obsidian.js` when notes are written, rebuilt on
  demand) feeding the vault map's edges and backlinks in the Vault view; the same index speeds up
  search later. Only worth it when the links are wanted.

## 8. Keyboard and screen-reader pass on the desktop — M

- [x] **Done in 2.1.0:** `docs/KEYBOARD.md`, a live region for finished replies (not `aria-live` on the
  whole list, which would read every streamed word), focus rings, arrow keys on the rail.
- **Why:** the canvas views (village, map, replay, skill tree) mirror their content in HTML
  panels, which is right, but focus order across the rail and views is uneven and streamed replies
  have no `aria-live` on the desktop (the phone has it).
- **What:** `aria-live="polite"` on the chat's message list, a visible focus style on the rail and
  cards, the replay bar reachable by Tab, Esc behaviour documented per view.

## 9. Electron upgrades with a launch check — S per upgrade

- [x] **Done in 2.1.0:** `npm run smoke`, in `release.yml` on Windows and macOS.
- **Why:** Electron majors arrive about every eight weeks; the fuses test and the `runAsNode`
  requirement (`claudecode.js`, `selfchange.js`) mean each upgrade needs a real launch, which nothing
  automates.
- **What:** the browser test from item 2 extended with an Electron launch (`npx electron . --smoke`
  that opens the window, waits for `app:ready`, and quits), run in `release.yml` before publishing.

## 10. macOS verification — needs a Mac

- [ ] Still open (no Mac here). The CI launch check now starts the macOS build once per release, but
  nobody has used it. The macOS build has only ever been produced by CI; nobody has launched it. First start
  (ad-hoc signature prompt), microphone permission, the offline voice, the vault picker and the
  Claude Code CLI path on macOS are the things to try. Note results here.

## Done from the earlier notes

From "Next Features-IMPORTANT.md": the rename to Siren with the Siren face and the offline voice by
default (2.0.0), the onboarding with the privacy step and the connectors (2.0.0), the Android catch-up
with Tailscale (2.0.0–2.0.3), the release flow with tags (2.0.0). Still open there: the macOS check
(item 10 above).
