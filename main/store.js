// Persistent settings + conversation history, stored as JSON in the app's userData folder.
// Secrets (API keys, tokens) are encrypted at rest with the OS keychain via safeStorage when available.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const personas = require('./personacore');
const brand = require('./brand');

// The master prompt of installs from before 2.0 that never edited theirs (see brand.LEGACY).
const NEXUS_PERSONALITY = `You are warm, sharp and concise. You speak like a capable co-pilot: direct, a little playful, never robotic.
You remember what matters to the user and proactively use what you know about them, their calendar and their notes.
When you are not sure, you say so instead of guessing.`;
const LEGACY = [...brand.LEGACY, ['agent', 'personality', NEXUS_PERSONALITY]];

const DEFAULTS = {
  onboarded: false, // first-run setup wizard completed
  // acceptedAt: when the user accepted the privacy policy and disclaimers in the setup wizard; encryptConversations:
  // conversations sealed with the OS keychain on disk (both user-only, never SETTABLE)
  privacy: { acceptedAt: 0, encryptConversations: true },
  agent: {
    name: brand.AGENT_NAME,
    personality: brand.MASTER_PROMPT, // the master prompt
    avatar: null,
    aesthetic: '', // the overall aesthetic / style / theme the persona should embody
  },
  appearance: {
    theme: brand.THEME, // generated or edited theme object; null = the "Neon Circuit" theme
    personaNotes: '', // tone/style notes derived from the aesthetic, injected into the system prompt
    greeting: '', // welcome line on the empty chat and spoken on launch; empty = a default greeting
    applyVoice: true, // let persona generation pick a matching VoiceStudio voice
  },
  // The user's saved personas (main/personacore.js). The live agent/appearance/ui.face/voice settings
  // are the active one and are copied into its entry on every save; switching swaps them in.
  personas: {
    active: '', // id of the active persona
    list: [], // [{ id, name, personality, aesthetic, avatar, theme, personaNotes, greeting, face, voice, localVoice }]
  },
  llm: {
    provider: 'claude-code', // 'claude-code' = Claude account, 'openai' = FreeLLMAPI / OpenAI-compatible, 'anthropic' = Claude API key, 'auto' = multi-provider (see routing)
    baseUrl: 'http://localhost:3001/v1',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
    useTools: true,
    maxToolRounds: 8,
    engineeringToolRounds: 40, // coding, self-change and debugging turns (llm.js engineering mode)
    historyLimit: 30,
    compaction: true, // summarize older turns instead of dropping them
    modelMode: 'default', // default | fast | deep (switchable by voice)
    voiceUsesFast: true, // use the fast model for spoken turns (switched in place, no session restart)
    autoPace: true, // per message: lookups get the fast model at low effort, explanations more (pace.js; model mode Default only)
    fastModel: '',
    deepModel: '',
  },
  claudeCode: {
    cliPath: '', // empty = auto-detect the `claude` CLI
    model: 'default', // default | opus | sonnet | haiku | fable | full model id
    effort: 'default',
    fastModel: 'haiku',
    deepModel: 'opus',
    idleMinutes: 20, // keep the warm session alive this long between turns
    warmOnLaunch: true,
    // The user's claude.ai connectors and plugin MCP servers (main/connectors.js). Only the user turns
    // this on and picks what runs without asking: never in tools.js SETTABLE.
    connectors: false,
    connectorsAllowed: [], // server keys (e.g. claude_ai_AccuWeather) whose calls don't ask each time
    connectorsReadOnly: [], // server keys whose reading tools (list, get, search…) don't ask; the rest still asks
    connectorsWrite: [], // server keys where everything but deleting (delete, remove, archive…) runs without asking
  },
  anthropic: {
    apiKey: '',
    model: 'claude-opus-5-5',
    effort: 'medium',
    fallbacks: true,
    maxTokens: 64000,
    fastModel: 'claude-haiku-5-5',
    deepModel: 'claude-opus-5-5',
  },
  // Multi-provider mode (llm.provider = 'auto'): the user's ranked list of brains. A turn goes to the
  // first available one (or the best one for the task, with smart routing); when a provider hits a
  // rate limit, a usage cap or runs out of credits, the next one takes over and the limited one is
  // skipped for a while.
  routing: {
    order: ['claude-code', 'anthropic', 'gemini', 'deepseek', 'groq', 'perplexity', 'openai'],
    disabled: [], // providers in the list that are switched off
    smart: true, // pick the best provider for each task (code, web questions, quick spoken replies…)
    cooldownMin: 15, // how long a provider that hit a limit is skipped
  },
  // OpenAI-compatible cloud providers (used in multi-provider mode).
  gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', fastModel: '', deepModel: 'gemini-2.5-pro' },
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', fastModel: '', deepModel: 'deepseek-reasoner' },
  groq: { apiKey: '', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', fastModel: '', deepModel: '' },
  perplexity: { apiKey: '', baseUrl: 'https://api.perplexity.ai', model: 'sonar', fastModel: '', deepModel: 'sonar-pro' },
  voice: {
    ttsEnabled: true,
    autoSpeak: true,
    engine: 'local', // local = the offline Kokoro voice in the app | voicestudio = VoiceStudio at baseUrl (falls back as below)
    baseUrl: 'http://localhost:3900',
    apiKey: '',
    model: 'tts-1',
    voice: '',
    speed: 1.0,
    format: 'mp3',
    greetOnLaunch: true,
    thinkingSound: 'grandfather', // grandfather | clock | soft | classic | off (starts after a short pause)
    thinkingVolume: 0.5,
    filler: true, // short spoken lines while tools run
    fallback: 'local', // when VoiceStudio is unreachable: local (offline Kokoro voice) | system (the OS voice) | off
    localVoice: 'af_heart', // Kokoro voice id (renderer/js/kokorotext.js KOKORO_VOICES)
  },
  stt: {
    enabled: true,
    engine: 'local', // 'local' = Whisper in-app (transformers.js), 'groq' = Groq's Whisper Large v3 Turbo (cloud, the groq.apiKey), 'remote' = OpenAI-compatible /audio/transcriptions
    cloudFallback: false, // local engine: when local Whisper is still loading or fails, transcribe with Groq (needs groq.apiKey)
    groqModel: 'whisper-large-v3-turbo',
    localModel: 'onnx-community/whisper-large-v3-turbo', // without WebGPU the worker falls back to base.en
    remoteUrl: '',
    remoteKey: '',
    remoteModel: 'whisper-1',
    language: 'en',
    pttKey: 'F8',
    globalShortcut: 'CommandOrControl+Alt+Space',
    autoSend: true,
    micMode: 'ptt', // ptt = push-to-talk, open = hands-free with voice detection
    micDevice: '', // device label (substring) or empty for the system default
    headphones: false, // allows talking over the agent in hands-free mode
    vadSensitivity: 0.5,
    vadEngine: 'neural', // 'neural' = Silero VAD (falls back to energy if it can't load), 'energy' = loudness + voicing
    endSilenceMs: 600, // pause that ends an utterance in hands-free mode
    vocabulary: [], // names/words from voice calibration (prompt for remote Whisper)
    corrections: [], // [{ heard, meant }] misheard words learned by voice calibration
    calibratedAt: 0,
  },
  github: {
    enabled: true, // tools appear when the GitHub CLI (gh) is signed in
    workspace: '', // where repos are cloned; empty = ~/SirenRepos (~/NexusRepos if that exists)
  },
  calendar: {
    enabled: true, // the schedule in the vault (Schedule.md, main/calendar.js)
    daysAhead: 7, // days of the schedule in the agent's context
  },
  screen: {
    attachToMessages: true, // while the screen is shared, each message carries a fresh screenshot
  },
  obsidian: {
    enabled: true,
    vaultPath: '', // empty = the agent's own vault in Documents/Siren Vault (Nexus Vault if that exists)
    injectIndex: true,
    maxIndexEntries: 300,
    gitHistory: true, // version every note so agent edits can be undone
  },
  web: {
    enabled: true,
    provider: 'duckduckgo', // duckduckgo (no key) | searxng | brave | tavily
    searxngUrl: '',
    braveKey: '',
    tavilyKey: '',
    maxResults: 6,
  },
  code: {
    enabled: true,
    rootPath: '', // empty = this app's own source
    allowSelfModify: true, // the agent may change its own code (tracked in git, revertible)
  },
  safety: {
    permissionMode: 'ask', // ask = confirm self-changes, settings changes and deletions; auto = only when external content was read
    taintGuard: true, // always ask before self-modification in a turn that read web pages or documents
    approvalTimeoutSec: 75,
  },
  remote: {
    enabled: false, // companion server for paired phones / other computers (desktop-only setting)
    lan: false, // false = this computer only (127.0.0.1); true = reachable on the local network
    port: 7823,
    tunnel: 'off', // off | quick (temporary trycloudflare.com address) | cloudflare (named tunnel) | tailscale (Tailscale Serve)
    tunnelToken: '', // Cloudflare connector token (secret)
    publicHost: '', // the tunnel's public hostname (named tunnel / Tailscale Serve)
    accessTeam: '', // Cloudflare Access team (myteam or myteam.cloudflareaccess.com); with accessAud, every tunnel request must be signed in
    accessAud: '', // the Access application's AUD tag
    cloudflaredPath: '', // empty = find cloudflared on PATH
    shareData: true, // paired devices also see notes, memories, habits, learning, the skill tree and the Inner World (companiondata.js; user-only)
  },
  // VoiceStudio and FreeLLMAPI are separate apps; Nexus starts the ones its settings use (helperapps.js).
  // Only the user changes these (never in tools.js SETTABLE: the paths are programs Nexus runs).
  helperApps: {
    autoStart: true, // start them with Nexus, and again when they are needed and not running
    minimize: true, // keep their windows minimized (in the taskbar), without taking focus
    stopOnQuit: false, // close the ones Nexus started when Nexus quits
    voicestudioPath: '', // empty = the usual install folder
    freellmapiPath: '',
  },
  logging: {
    debug: false, // also write DEBUG lines (e.g. Claude Code's raw error output) to the log
  },
  journal: {
    enabled: true, // write a session entry to the daily note after a conversation goes quiet
    idleMinutes: 15,
    handoffOnClose: true, // on closing the app, note where we left off (handoff.js) for the next session
  },
  // Extensions (main/extensions.js): MCP servers Nexus runs for the Claude account brain. Only the user
  // changes these (never in tools.js SETTABLE: they decide what Nexus runs).
  extensions: {
    rea: false, // REA, reverse engineering (npx rea-agents mcp)
    godseye: false, // God's Eye View, the live globe
    godseyePath: '', // the user's checkout of gods-eye-view
  },
  // The agent window (main/agentwindow.js): a browser window the agent controls (websites, the globe).
  // User-only, like the other permissions (never in tools.js SETTABLE).
  agentWindow: {
    enabled: true,
  },
  // Learning support (main/learning.js). Language practice switches speech recognition and the voice to
  // the target language (renderer/js/voice.js); the agent turns it on and off with language_practice.
  learning: {
    practiceLanguage: '', // ISO code of the language being practiced; empty = off
    practiceVoice: 'system', // system = a Windows voice for that language | assistant = keep the persona's voice (if it speaks the language)
  },
  memory: {
    vaultPath: '', // empty = <vault>/Memory
    stream: true, // the memory stream (stream.js): observations in Stream/, recalled by recency + importance + relevance
    reflect: true, // draw insights from the stream in the background once enough has piled up (a model call)
  },
  // The Inner World (innerworld.js): the personas live a small fictional day in a village that grows
  // with the user's real progress. Off until the user wakes it (it costs a few model calls a day).
  innerWorld: {
    enabled: false,
    townsfolk: true, // two residents of the village's own besides the personas
    season: 'auto', // auto (follows the date, on the user's half of the world) | spring | summer | autumn | winter
    art: 'rendered', // rendered (sprites from tools/world-art) | drawn (everything drawn by code)
    fps: 'auto', // the village's frame rate: auto (30, 15 on Balanced) | 15 | 30 | 60 | 120 (120 needs a 120 Hz display)
  },
  documents: {
    allowedRoots: [], // folders the user added beyond the workspace (Settings → Documents); never set by the agent
    workspace: '', // the agent's workspace folder: by default the only folder of the user's it may use (documents.userFolders)
  },
  ui: {
    showVisualizerInChat: true,
    captions: true,
    face: 'siren', // siren | circuit | radial | rain | neural | companion | custom:<folder>
    zoom: 1, // whole-window zoom (Ctrl + / Ctrl − / Ctrl 0, Ctrl + wheel)
    chatLayout: 'split', // chat | split | face — what the chat view shows
    facePanelWidth: 300, // width of the face next to the chat in the split layout (drag the divider)
    sleepAfterMin: 10, // the face dozes off after this long without activity (0 = never)
    fx: 'hud', // visual effects (renderer/hud.css): hud = futuristic, with motion | subtle = static | off
    showClaudeUsage: true, // title-bar meter: how much of the Claude plan is left (main/claudeusage.js)
    showSystemStats: true, // title-bar system monitor: CPU, RAM, GPU, disk (main/sysmon.js; never sent to the AI)
  },
  // New versions (main/updates.js): one request a day to GitHub's releases API. User-only (never SETTABLE).
  updates: {
    check: true,
    skipped: '', // a version the user chose to skip: no pill for it
  },
  perf: {
    mode: 'auto', // auto | balanced | full (renderer/js/perfcore.js, main/perfcore.js); user-only
    detected: '', // what the hardware check found: '' (not yet) | low | high
    hw: null, // { ramGB, vramGB, gpu, reason } from that check
    detectedAt: 0,
  },
};

const SECRET_FIELDS = [
  ['llm', 'apiKey'],
  ['anthropic', 'apiKey'],
  ['voice', 'apiKey'],
  ['stt', 'remoteKey'],
  ['gemini', 'apiKey'],
  ['deepseek', 'apiKey'],
  ['groq', 'apiKey'],
  ['perplexity', 'apiKey'],
  ['web', 'braveKey'],
  ['web', 'tavilyKey'],
  ['remote', 'tunnelToken'],
];

function dataDir() {
  return app.getPath('userData');
}

function encrypt(value) {
  if (!value) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(value).toString('base64');
  }
  return 'b64:' + Buffer.from(value, 'utf8').toString('base64');
}

function decrypt(value) {
  if (!value || typeof value !== 'string') return '';
  try {
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
  } catch {
    return '';
  }
  return value;
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

// A missing file gives the fallback. A file that exists but can't be parsed also gives the
// fallback, unless onCorrupt is passed (then it decides), and it is reported, never silently lost.
async function readJson(file, fallback, { onCorrupt } = {}) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (onCorrupt) return onCorrupt(err);
    console.error(`[store] unreadable JSON in ${file}: ${err.message}`);
    return fallback;
  }
}

// Writes go through one queue per file, in call order, so an older state can never land last.
// Each write goes to a unique temp file and is renamed over the target (atomic: a crash leaves the
// old or the new file, never half of one). Windows briefly locks files that antivirus or search
// indexing is reading, so the rename is retried.
const writeQueues = new Map();

function writeJsonAtomic(file, data) {
  return writeTextAtomic(file, JSON.stringify(data, null, 2)); // snapshot now; later changes to data don't leak in
}

/** The same for text (vault notes): queued per file, temp file + rename, retried while Windows locks it. */
function writeTextAtomic(file, text) {
  const next = (writeQueues.get(file) || Promise.resolve()).catch(() => {}).then(() => writeNow(file, String(text)));
  writeQueues.set(file, next);
  next.then(
    () => writeQueues.get(file) === next && writeQueues.delete(file),
    () => writeQueues.get(file) === next && writeQueues.delete(file),
  );
  return next;
}

/** Reads and rewrites a file inside its write queue (fn returns the new text, or null to leave it); true if written. */
function updateInQueue(file, fn) {
  let wrote = false;
  const next = (writeQueues.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
    const text = await fn();
    if (text == null) return;
    await writeNow(file, String(text));
    wrote = true;
  });
  writeQueues.set(file, next);
  const clear = () => writeQueues.get(file) === next && writeQueues.delete(file);
  next.then(clear, clear);
  return next.then(() => wrote);
}

async function writeNow(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 40 * 2 ** attempt));
    }
  }
}

// Temp files from writes interrupted by a crash or power loss (older than an hour).
async function sweepStaleTemp() {
  for (const dir of [dataDir(), path.join(dataDir(), 'conversations')]) {
    const names = await fsp.readdir(dir).catch(() => []);
    for (const name of names.filter((n) => n.endsWith('.tmp'))) {
      const file = path.join(dir, name);
      const st = await fsp.stat(file).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 3600000) await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
}

// ---------- Settings ----------
let settingsCache = null;

function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

let settingsLoad = null;
let settingsRecovered = null; // set when the settings file was damaged and restored from backup

// A damaged settings file must not silently reset everything (and lose the encrypted keys): it is
// kept as settings.corrupt-<time>.json and the last good copy (settings.backup.json) is used.
async function loadSettingsFile() {
  const file = settingsFile();
  const backup = path.join(dataDir(), 'settings.backup.json');
  const raw = await readJson(file, {}, {
    onCorrupt: async (err) => {
      const kept = path.join(dataDir(), `settings.corrupt-${Date.now()}.json`);
      await fsp.copyFile(file, kept).catch(() => {});
      const good = await readJson(backup, null, { onCorrupt: () => null });
      settingsRecovered = { error: err.message, kept, restored: Boolean(good) };
      if (good) await writeJsonAtomic(file, good).catch(() => {});
      return good || {};
    },
  });
  // Remember this launch's settings as the last good copy.
  if (Object.keys(raw).length) await writeJsonAtomic(backup, raw).catch(() => {});
  return raw;
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  // Concurrent first calls share one load (and one recovery).
  settingsLoad ||= loadSettingsFile().finally(() => (settingsLoad = null));
  const raw = await settingsLoad;
  if (settingsCache) return settingsCache;
  // Installs from before the setup wizard existed are already configured.
  if (Object.keys(raw).length && raw.onboarded === undefined) raw.onboarded = true;
  // Installs from before the rename (Nexus Agent) keep their name, look, face and voice (brand.LEGACY).
  if (Object.keys(raw).length) {
    for (const [section, key, value] of LEGACY) if (raw[section]?.[key] === undefined) raw[section] = { ...raw[section], [key]: value };
  }
  const merged = deepMerge(DEFAULTS, raw);
  // The thinking sound used to be on/off; it is now a style.
  if (typeof merged.voice.thinkingSound === 'boolean') merged.voice.thinkingSound = merged.voice.thinkingSound ? 'grandfather' : 'off';
  if (merged.voice.thinkingSound === 'tick') merged.voice.thinkingSound = 'clock';
  // The system-voice toggle became a choice of fallback voice (1.4); an "on" toggle gets the offline voice.
  if ('fallbackSystemVoice' in merged.voice) {
    if (merged.voice.fallbackSystemVoice === false) merged.voice.fallback = 'off';
    delete merged.voice.fallbackSystemVoice;
  }
  // Google Calendar and iCal links were replaced by the schedule in the vault (1.3).
  for (const k of ['clientId', 'clientSecret', 'allCalendars', 'allowWrite', 'icsUrls']) delete merged.calendar[k];
  for (const [section, key] of SECRET_FIELDS) merged[section][key] = decrypt(merged[section][key]);
  // Installs from before personas (1.4) get their current persona as the first saved one.
  merged.personas = personas.ensure(merged);
  settingsCache = merged;
  setSealing(merged.privacy?.encryptConversations !== false);
  return merged;
}

// Called after every save with (settings, patch): the one place that sees all changes, whoever made
// them (Settings, a tool, a persona switch). A listener that throws doesn't stop the save.
const changeListeners = new Set();
function onChange(fn) {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

// One save at a time, each on top of the one before: two saves started together (toggles flipped
// quickly, a tool and the Settings view at once) used to read the same old settings, and the second
// wrote over the first's change.
let saving = Promise.resolve();
function setSettings(patch) {
  const run = saving.then(() => applySettings(patch));
  saving = run.catch(() => {});
  return run;
}

async function applySettings(patch) {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  // Whatever changed in the live persona (name, prompt, theme, face, voice…) is saved with it.
  next.personas = personas.sync(next);
  settingsCache = next;
  const onDisk = JSON.parse(JSON.stringify(next));
  for (const [section, key] of SECRET_FIELDS) onDisk[section][key] = encrypt(onDisk[section][key]);
  await writeJsonAtomic(settingsFile(), onDisk);
  setSealing(next.privacy?.encryptConversations !== false);
  for (const fn of changeListeners) {
    try {
      fn(next, patch);
    } catch (err) {
      // The logger requires the store; a listener's problem is its own, not the save's.
      console.warn('settings listener failed', err);
    }
  }
  return next;
}

async function resetSettings() {
  settingsCache = null;
  settingsLoad = null;
  await fsp.rm(settingsFile(), { force: true });
  return getSettings();
}

// ---------- Encrypted blobs ----------
async function getSecretBlob(name) {
  const raw = await readJson(path.join(dataDir(), `${name}.json`), null);
  if (!raw?.data) return null;
  try {
    return JSON.parse(decrypt(raw.data));
  } catch {
    return null;
  }
}

async function setSecretBlob(name, value) {
  const file = path.join(dataDir(), `${name}.json`);
  if (value == null) return fsp.rm(file, { force: true });
  return writeJsonAtomic(file, { data: encrypt(JSON.stringify(value)) });
}

// ---------- Conversations ----------
function convDir() {
  return path.join(dataDir(), 'conversations');
}

// Sealed at rest (privacy.encryptConversations, on by default): every conversation file and the index are
// stored as { sealed: 'v1', data } encrypted with the OS keychain (safeStorage: DPAPI on Windows, the
// Keychain on macOS, the secret service on Linux), readable only by this user on this computer. Plain files
// (older versions, or no keychain) are still read, and rewritten in the chosen form in the background.
let sealing = true;
let resealTimer = null;
let resealedFor = null; // the mode the folder was last brought into

const canSeal = () => sealing && safeStorage.isEncryptionAvailable();

function setSealing(on) {
  sealing = on;
  if (resealedFor === canSeal()) return;
  clearTimeout(resealTimer);
  resealTimer = setTimeout(() => resealConversations().catch((err) => console.error(`[store] resealing conversations: ${err.message}`)), 5000);
  resealTimer.unref?.();
}

function sealText(data) {
  if (!canSeal()) return JSON.stringify(data, null, 2);
  return JSON.stringify({ sealed: 'v1', data: safeStorage.encryptString(JSON.stringify(data)).toString('base64') });
}

function unseal(raw, file) {
  if (raw?.sealed !== 'v1') return raw;
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(String(raw.data), 'base64')));
  } catch (err) {
    // Another Windows user, a reset keychain: unreadable here, reported, never overwritten.
    console.error(`[store] can't decrypt ${path.basename(file)}: ${err.message}`);
    return null;
  }
}

const readConvFile = async (file, fallback = null) => unseal(await readJson(file, fallback), file);
const writeConvFile = (file, data) => writeTextAtomic(file, sealText(data));

/** Brings every conversation file into the chosen form (sealed or plain), each inside its file's write queue. */
async function resealConversations() {
  const want = canSeal();
  const names = (await fsp.readdir(convDir()).catch(() => [])).filter((n) => n.endsWith('.json'));
  let changed = 0;
  for (const name of names) {
    const file = path.join(convDir(), name);
    const done = await updateInQueue(file, async () => {
      const raw = await readJson(file, null);
      if (!raw || (raw.sealed === 'v1') === want) return null;
      const data = unseal(raw, file);
      return data ? sealText(data) : null;
    });
    if (done) changed++;
  }
  resealedFor = want;
  if (changed) console.log(`[store] ${want ? 'sealed' : 'unsealed'} ${changed} conversation files`);
  return changed;
}

function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function safeConvId(id) {
  if (!/^[a-z0-9_-]+$/i.test(String(id))) throw new Error('Invalid conversation id');
  return id;
}

// The conversation index (conversations/index.json): one small summary per conversation, kept up to date
// on every save and delete, so listing conversations (the sidebar, the journal every minute) never has to
// open them all. Reconciled with the folder's file names when first loaded: files it doesn't know are read
// once, entries whose file is gone are dropped.
const INDEX = 'index.json';
let convIndex = null; // Map id → summary
let indexLoad = null;
let indexTimer = null;

const summarize = (c) => ({
  id: c.id,
  title: c.title,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
  count: c.messages?.length || 0,
  journaledUpTo: c.journaledUpTo || 0,
  ...(c.setup ? { setup: true } : {}),
});

function loadIndex() {
  indexLoad ||= (async () => {
    await fsp.mkdir(convDir(), { recursive: true });
    const saved = await readConvFile(path.join(convDir(), INDEX), null);
    const map = new Map((Array.isArray(saved?.items) ? saved.items : []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
    const ids = new Set((await fsp.readdir(convDir())).filter((n) => n.endsWith('.json') && n !== INDEX).map((n) => n.slice(0, -5)));
    let changed = false;
    for (const id of map.keys()) if (!ids.has(id)) (map.delete(id), (changed = true));
    for (const id of ids) {
      if (map.has(id)) continue;
      const c = await readConvFile(path.join(convDir(), `${id}.json`), null);
      if (c?.id) (map.set(c.id, summarize(c)), (changed = true));
    }
    convIndex = map;
    if (changed) saveIndexSoon();
    return map;
  })();
  return indexLoad;
}

function saveIndexSoon() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => {
    if (convIndex) writeConvFile(path.join(convDir(), INDEX), { version: 1, items: [...convIndex.values()] }).catch(() => {});
  }, 500);
  indexTimer.unref?.();
}

async function listConversations() {
  const map = await loadIndex();
  return [...map.values()].map((x) => ({ ...x })).sort((a, b) => b.updatedAt - a.updatedAt); // copies: callers may change them
}

async function getConversation(id) {
  return readConvFile(path.join(convDir(), `${safeConvId(id)}.json`), null);
}

// Full tool exchanges (`raw`: tool calls, results, thinking) are only replayed to the model for the
// last replies (llm.js: 6 on the Claude API, the history window on the OpenAI path). Older replies keep
// their text and tool list; dropping their raw part keeps long conversations from growing by megabytes.
const RAW_REPLIES_KEPT = 16;

function trimRaw(messages, keep = RAW_REPLIES_KEPT) {
  let replies = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (++replies > keep && m.raw) delete m.raw;
  }
  return messages;
}

async function saveConversation(conv, { touch = true } = {}) {
  if (touch) conv.updatedAt = Date.now();
  if (Array.isArray(conv.messages)) trimRaw(conv.messages);
  await writeConvFile(path.join(convDir(), `${safeConvId(conv.id)}.json`), conv);
  (await loadIndex()).set(conv.id, summarize(conv));
  saveIndexSoon();
  return conv;
}

async function createConversation(title = 'New conversation') {
  const now = Date.now();
  return saveConversation({ id: newId('c'), title, createdAt: now, updatedAt: now, messages: [] });
}

async function deleteConversation(id) {
  await fsp.rm(path.join(convDir(), `${safeConvId(id)}.json`), { force: true });
  (await loadIndex()).delete(id);
  saveIndexSoon();
}

async function renameConversation(id, title) {
  const conv = await getConversation(id);
  if (!conv) throw new Error('Conversation not found');
  conv.title = String(title).slice(0, 120);
  return saveConversation(conv);
}

async function clearConversations() {
  clearTimeout(indexTimer);
  await fsp.rm(convDir(), { recursive: true, force: true });
  convIndex = null;
  indexLoad = null;
}

async function exportConversations() {
  const list = await listConversations();
  return Promise.all(list.map((c) => getConversation(c.id)));
}

module.exports = {
  resealConversations,
  DEFAULTS,
  dataDir,
  getSettings,
  setSettings,
  onChange,
  resetSettings,
  getSecretBlob,
  setSecretBlob,
  listConversations,
  getConversation,
  saveConversation,
  createConversation,
  deleteConversation,
  renameConversation,
  clearConversations,
  exportConversations,
  newId,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
  trimRaw,
  settingsRecovery: () => settingsRecovered,
  SECRET_FIELDS,
  sweepStaleTemp,
};
