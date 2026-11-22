ENG-10 (part): voice.js and claudecode.js split, pure moves.

CLAUDE.md wording (for the one docs pass):

- Renderer, the voice paragraph (where it names `renderer/js/voice.js` parts): voice.js is now speech-to-text
  (the `stt` model host, `transcribe`, corrections, `analyzeClip`), utterance handling (the arbiter `input`,
  `finishUtterance`, the kept-recording Try again, push-to-talk start/stop, `recordClip`) and the public API
  every importer still uses (it re-exports `ctx`, `fallbackMode`, `speaker`, `replySpeech`, `recorder`,
  `listMics`). Its parts are modules of their own: `voicecommon.js` (the one AudioContext `ctx()`, the model
  hosts' `timers` and `byProfile`), `offlinevoice.js` (`localVoice`: Kokoro on the model host, jobs, pace,
  `fallbackMode`), `speaker.js` (the Speaker: `speaker`, `replySpeech`, fillers and kept lines, `fillerKey`,
  `quietFail`, the `first audio` log line with `noteSpeechEnd`, which voice.js's finishUtterance calls),
  `mic.js` (the configured mic, `toMono16k`, the push-to-talk `Recorder`/`recorder`, `concat`, `silentSink`)
  and `handsfree.js` (`neural`, the voice detector with `NEURAL_IDLE_MS`, and `HandsFree`; voice.js makes the
  one instance with `createHandsFree({ input, finishUtterance })` and keeps the devicechange restart). No
  module imports voice.js back. Mentions such as "voice.js `neural.stopSoon`", "Speaker.stop() →
  localVoice.cancelQueued()" and "speaker.warmFillers" now point at handsfree.js / speaker.js / offlinevoice.js.
- Main, the `claudecode.js` paragraph: "The sign-in check `status()` is cached (...)" now lives in
  `main/claudestatus.js`: `create({ findCli, collect })` returns `status`, `invalidateStatus`, `probeStatus`,
  `cliVersion` with their own cache (so each fresh load of claudecode.js has its own, as before); it also
  holds `STATUS_TTL_MS`, `STATUS_RETRY_MS`, `VERSION_TTL_MS` and `AUTH_ERROR`. claudecode.js makes one and
  still exports `status`, `invalidateStatus`, `STATUS_TTL_MS`, `STATUS_RETRY_MS` (callers and
  test/claudestatus.test.js unchanged). `openLogin` and `installHint` stay in claudecode.js.

CHANGELOG line:

- Internal: `renderer/js/voice.js` split into `voicecommon.js`, `offlinevoice.js`, `speaker.js`, `mic.js` and
  `handsfree.js`, and the Claude sign-in check moved from `main/claudecode.js` to `main/claudestatus.js`;
  no change in behaviour, importers unchanged.
