# ENG-10 (part): the Settings view split into renderer/js/settings/: doc wording

## CLAUDE.md, the `js/settings.js` paragraph (renderer list): replace its opening
- `js/settings/` the Settings view (`js/settings.js` only re-exports what app.js, onboarding.js and setup.js import). `index.js` draws it: `initSettings`, the tabs and search, `CARDS`, `render`/`safeCard`, `renderGen`, `drawingFor`, `scrollTarget`, `refocus`. `core.js` is the one shared saving state: `renderedPersona` (set only through `setRenderedPersona`, by render), `save`, `saveForPersona`, `switchedAway`, the waiting saves (`queueSave`, `flushSaves`), `PERSONA_CHANGED` (the one wording) and `render`, a hook index.js registers (`setRenderer`), so cards redraw without importing index.js (no import cycle). `fields.js` the field builders (`text`, `area`, `toggle`, `select`, `fillSelect`, `field`, `folder`, `debounceAfter`) and `card`/`result`/`showResult`/`showFailure`. One module per group of cards: `persona.js` (Persona studio, scene, theme editor, `themeEdits`, `saveFromClick`, `shrinkImage`), `brain.js` (AI brain, multi-provider list, `localFinder`, `connectClaude`, `testOutcome`), `connectors.js` (permission levels, Extensions, Claude connectors), `voice.js` (Voice output and input, microphone), `workspace.js` (Learning, Calendar, GitHub, Obsidian, Internet, Self-improvement, Documents, Inner World, Memory & history), `remote.js` (Remote access, Tailscale, the watch), `system.js` (Safety, Helper apps, Health, Performance, Interface). A card module never keeps its own copy of shared state: it imports it from core.js. Typed values wait in `settingsave.js` (… the rest of the paragraph as it is, with "settings.js" read as the folder).
- Tests that check the view's source read all of it through `test/helpers.js` `settingsSource()` (settings.js, then index.js, core.js, fields.js and the card modules).

## CLAUDE.md, Conventions, "New setting"
- New setting: add a default in `store.js` `DEFAULTS`, a control in the card's module in `renderer/js/settings/` (the builders in `settings/fields.js`: `text()`, `toggle()`, `select()` (… as now) bind to `section.key` paths and auto-save). `scripts/verify.js` checks the keys bound in `renderer/js/settings.js` and every module in `renderer/js/settings/`. A new card: its builder in the fitting module (or a new one), listed in `CARDS` in `settings/index.js` and placed in a tab in `settingstabs.js`.

## CLAUDE.md, "Engineering method", the `npm run check` bullet
- "settings keys bound in Settings (renderer/js/settings.js and renderer/js/settings/) or in `SETTABLE` exist in DEFAULTS".

## CHANGELOG.md
- The Settings view is split into `renderer/js/settings/` (the view and its tabs, the shared saving state, the field builders, and one module per group of cards) instead of one 2,260-line file; nothing changes on screen. The settings-key check in `npm run check` reads the whole folder.

## Notes for the reviewer
- Pure moves: every original line is in exactly one module (checked by a sorted line diff); the only code changes are `renderedPersona = persona` → `setRenderedPersona(persona)` (an imported binding can't be assigned) and the `render` hook in core.js.
- Live bindings imported read-only by index.js: `sttProgressEl`/`ttsProgressEl` (voice.js), `extensionProgress` (connectors.js), `refreshRemote`/`refreshRemoteStatus` (remote.js), `refreshHelperApps` (system.js); each is still set by its card before the card's first await.
- Tests updated to read the folder: brainrows, brains, codemap (the planted bad key now in settings/workspace.js, and check still fails on it), connectors, desktopui, dialogs, safetycopy, settingsreset, settingstabs, settingsview, toolenums, viewerrors. archcore: `settings/` joined the `ui-settings` component.
