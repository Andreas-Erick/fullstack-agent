// Persistent settings + conversation history, stored as JSON in the app's userData folder.
// Secrets (API keys, tokens) are encrypted at rest with the OS keychain via safeStorage when available.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const personas = require('./personacore');
const brand = require('./brand');
const braintable = require('../renderer/js/braintable.mjs'); // the brains' own sections, keys and default order (pure data)
const log = require('./logger');

// The master prompt of installs from before 2.0 that never edited theirs (see brand.LEGACY).
const NEXUS_PERSONALITY = `You are warm, sharp and concise. You speak like a capable co-pilot: direct, a little playful, never robotic.
You remember what matters to the user and proactively use what you know about them, their calendar and their notes.
When you are not sure, you say so instead of guessing.`;
const LEGACY = [...brand.LEGACY, ['agent', 'personality', NEXUS_PERSONALITY]];

const DEFAULTS = {
  onboarded: false, // first-run setup wizard completed
  // acceptedAt: when the user accepted the privacy policy and disclaimers in the setup wizard; encryptConversations:
  // conversations sealed with the OS keychain on disk (both user-only, never SETTABLE)
  privacy: { acceptedAt: 0, encryptConversations: true, reportIssues: false }, // reportIssues: offer anonymized GitHub issues for errors (issues.js), opt-in, user-only
  agent: {
    name: brand.AGENT_NAME,
    personality: brand.MASTER_PROMPT, // the master prompt
    avatar: null,
    aesthetic: '', // the overall aesthetic / style / theme the persona should embody
    personaSummary: null, // { text, for, by }: a long master prompt, short, for local models (personacore.js; written by persona.ensureSummary or the user)
  },
  appearance: {
    theme: brand.THEME, // generated or edited theme object; null = the "Neon Circuit" theme
    personaNotes: '', // tone/style notes derived from the aesthetic, injected into the system prompt
    greeting: '', // welcome line on the empty chat and spoken on launch; empty = a default greeting
    scene: brand.SCENE, // { svg, portrait, caption }: the place the persona lives in, drawn behind the face (main/scenecore.js); null = none
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
    compactPrompt: 'auto', // auto | on | off: a short prompt and the everyday tools for small local models (localcore.js)
    // A local brain hands messages it can't do well to the Claude brain (llm.js runSingle). Off: a local
    // brain keeps everything on this computer, and this sends those messages to Claude. User-only.
    handOver: false,
    autoPace: true, // per message: lookups get the fast model at low effort, explanations more (pace.js; model mode Default only)
    fastModel: '',
    deepModel: '',
  },
  claudeCode: {
    toolsOnRequest: true, // the app's everyday tools loaded, the rest found when needed (claudecode.js CORE_TOOLS): ~25k fewer tokens per message
    cliPath: '', // empty = auto-detect the `claude` CLI
    model: 'default', // default | opus | sonnet | haiku | fable | full model id
    effort: 'default',
    fastModel: 'haiku',
    normalModel: 'sonnet', // messages that are neither quick nor deep (pace.js); '' = the model above
    deepModel: 'opus',
    idleMinutes: 20, // keep the warm session alive this long between turns
    warmOnLaunch: true,
    warmCache: true, // one tiny message after launch, a chat opening or a persona switch fills the prompt cache (claudecode.warmCache)
    keepModelWarm: true, // stay on the model whose prompt cache is warm instead of a smaller one reading cold (pace.warmModel)
    // The user's claude.ai connectors and plugin MCP servers (main/connectors.js). Only the user turns
    // this on and picks what runs without asking: never in tools.js SETTABLE.
    connectors: false,
    plugins: false, // the user's Claude Code plugins too (their skills, ~4k tokens per message), with connectors on; user-only
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
    normalModel: 'claude-sonnet-5-5', // messages that are neither quick nor deep (pace.js); '' = the model above
    deepModel: 'claude-opus-5-5',
  },
  // Multi-provider mode (llm.provider = 'auto'): the user's ranked list of brains. A turn goes to the
  // first available one (or the best one for the task, with smart routing); when a provider hits a
  // rate limit, a usage cap or runs out of credits, the next one takes over and the limited one is
  // skipped for a while.
  routing: {
    order: [...braintable.DEFAULT_ORDER], // the routed brains by their rows' `route`; a local model joins at the end (router.order)
    disabled: [], // providers in the list that are switched off
    smart: true, // pick the best provider for each task (code, web questions, quick spoken replies…)
    cooldownMin: 15, // how long a provider that hit a limit is skipped
  },
  // The brains with their own section on the OpenAI path (gemini, deepseek, groq, perplexity and the local
  // model on this computer: address, key, models), from their rows' `defaults` in renderer/js/braintable.mjs.
  ...braintable.sectionDefaults(),
  // The cloud voice (voice.engine 'cloud'): Groq's Orpheus (with groq.apiKey) or OpenAI (its own key).
  cloudVoice: { provider: 'groq', apiKey: '', model: '', voice: '' },
  voice: {
    ttsEnabled: true,
    autoSpeak: true,
    engine: 'local', // local = the offline Kokoro voice in the app | voicestudio = VoiceStudio at baseUrl | cloud = cloudVoice (falls back as below)
    baseUrl: 'http://localhost:3900',
    apiKey: '',
    model: 'tts-1',
    voice: '',
    speed: 1.0,
    format: 'mp3',
    greetOnLaunch: true,
    speakLimit: 1500, // read aloud at most this many characters of a reply (about a minute and a half), then "the rest is on screen"; 0 = everything
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
    localModel: '', // '' = chosen for this computer (renderer/js/perfcore.js speechPlan); or a Whisper model id
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
    permissionMode: 'ask', // ask = every gated action asks (self-changes, settings, deletions, commands…); auto = only approvals.js ALWAYS_ASK and, after outside content, the taint guard's
    taintGuard: true, // after outside content was read: a warning on every approval, and asking before self-changes, changing where the brain or voice connects, deleting or inviting through a connector, a new web address, or saving routines and skills (approvals.js TAINT_ASKS, taintAsks)
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
    shareData: true, // paired devices also see notes, memories, learning and the Inner World (companiondata.js; user-only)
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
    face: brand.FACE, // siren | circuit | radial | rain | neural | companion | custom:<folder> (the default: Siren's shipped custom face)
    zoom: 1, // whole-window zoom (Ctrl + / Ctrl − / Ctrl 0, Ctrl + wheel)
    chatLayout: 'split', // chat | split | face — what the chat view shows
    facePanelWidth: 300, // width of the face next to the chat in the split layout (drag the divider)
    sleepAfterMin: 10, // the face dozes off after this long without activity (0 = never)
    sleepOnLaunch: true, // the face starts asleep and wakes with the greeting or the first thing you do
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
  ...braintable.SECRET_KEYS, // the apiKey of every brain with its own section (gemini, deepseek, groq, perplexity, local)
  ['cloudVoice', 'apiKey'],
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
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// A top-level settings section (agent, ui, calendar…): DEFAULTS holds an object for it. Own keys only, so
// '__proto__' or 'constructor' in a file or a patch is never taken for one.
const isSection = (k) => Object.hasOwn(DEFAULTS, k) && isPlainObject(DEFAULTS[k]);

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    // JSON.parse makes '__proto__' an own key; assigned, it would run the prototype setter.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

// A JSON parse error's message can quote the file's first characters (a conversation's words): the log
// gets its kind and position, never that quote.
const parseFailure = (err) => ({ name: err?.name, message: String(err?.message || err).replace(/".*"/s, '"…"') });
// A file system failure without the folders its message quotes: the log names files by basename only.
const fsFailure = (err) => ({ code: err?.code, message: String(err?.message || err).replace(/'[^']*'/g, "'…'") });

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
    // Damaged data, not a fault in the code: a warning, by the file's name (userData holds the user's name).
    log.warn('unreadable JSON', { file: path.basename(file), error: parseFailure(err) });
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
  const next = (writeQueues.get(file) || Promise.resolve()).catch(() => {}).then(() => writeNow(file, String(text))); // the queue only orders the work; each caller gets its own error
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
  const next = (writeQueues.get(file) || Promise.resolve()).catch(() => {}).then(async () => { // the queue only orders the work; each caller gets its own error
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
        await fsp.rm(tmp, { force: true }).catch(() => {}); // the write's own error goes to the caller; a stray temp file is swept at start
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
      const st = await fsp.stat(file).catch(() => null); // gone meanwhile
      if (st && Date.now() - st.mtimeMs > 3600000) await fsp.rm(file, { force: true }).catch(() => {}); // swept again at the next start
    }
  }
}

// ---------- Settings ----------
let settingsCache = null;

function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

let settingsLoad = null;
let settingsRecovered = null; // set when the settings file was damaged (restored from backup) or a section of it reset

// A damaged settings file must not silently reset everything (and lose the encrypted keys): it is
// kept as settings.corrupt-<time>.json and the last good copy (settings.backup.json) is used.
async function restoreFromBackup(err) {
  const file = settingsFile();
  const kept = path.join(dataDir(), `settings.corrupt-${Date.now()}.json`);
  await fsp.copyFile(file, kept).catch((e) => log.warn('damaged settings not kept', { kept: path.basename(kept), error: fsFailure(e) }));
  const saved = await readJson(path.join(dataDir(), 'settings.backup.json'), null, { onCorrupt: () => null });
  const good = isPlainObject(saved) ? saved : null; // a backup of the wrong shape is no good copy either
  settingsRecovered = { error: err.message, kept, restored: Boolean(good) };
  log.warn('settings file damaged', { restored: Boolean(good), kept: path.basename(kept), error: parseFailure(err) });
  if (good) await writeJsonAtomic(file, good).catch((e) => log.warn('settings not restored from backup', { error: fsFailure(e) }));
  return good || {};
}

// The active persona's saved entry, found as personacore.ensure finds it (the first valid one when the
// active id names none): the one the next save's personacore.sync writes over.
function savedPersona(raw) {
  const list = isPlainObject(raw.personas) && Array.isArray(raw.personas.list) ? raw.personas.list.filter((x) => isPlainObject(x) && typeof x.id === 'string') : [];
  return list.find((x) => x.id === raw.personas.active) || list[0] || null;
}

// A section of the wrong shape (null, a string, a list) goes back to its defaults, the rest of the file is
// kept, and the user is told (the same notice as a damaged file). What a persona keeps in it (personacore.FIELDS:
// name, master prompt, look, face, voice) comes back from the persona's saved entry instead: with the defaults,
// the next save would copy them over that entry. The file is kept as settings.corrupt-<time>.json.
async function repairSections(raw) {
  const dropped = Object.keys(raw).filter((k) => isSection(k) && !isPlainObject(raw[k]));
  if (!dropped.length) return dropped;
  for (const k of dropped) delete raw[k];
  const persona = savedPersona(raw);
  const fromPersona = persona ? dropped.filter((k) => personas.FIELDS.some(([section]) => section === k)) : [];
  if (fromPersona.length) {
    const patch = personas.patchFor(persona, DEFAULTS);
    for (const k of fromPersona) raw[k] = patch[k];
  }
  // After a restore from the backup, the damaged file was kept already.
  const copy = path.join(dataDir(), `settings.corrupt-${Date.now()}.json`);
  const kept = settingsRecovered ? '' : await fsp.copyFile(settingsFile(), copy).then(() => copy, () => '');
  settingsRecovered ||= { error: 'wrong shape', kept, restored: false, dropped, fromPersona };
  log.warn('settings sections reset', { dropped, fromPersona, kept: path.basename(kept) });
  return dropped;
}

// Inside the one shared load: concurrent first callers wait for its repairs (and the kept copy) together.
async function loadSettingsFile() {
  let raw = await readJson(settingsFile(), {}, { onCorrupt: restoreFromBackup });
  // Valid JSON that isn't an object (null, a list, a number) is as damaged as broken JSON.
  if (!isPlainObject(raw)) raw = await restoreFromBackup(new Error('settings.json is not an object'));
  return { raw, dropped: await repairSections(raw) };
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  // Concurrent first calls share one load (and one recovery).
  settingsLoad ||= loadSettingsFile().finally(() => (settingsLoad = null));
  const { raw, dropped } = await settingsLoad;
  if (settingsCache) return settingsCache;
  // Installs from before the setup wizard existed are already configured.
  if (Object.keys(raw).length && raw.onboarded === undefined) raw.onboarded = true;
  // Installs from before the rename (Nexus Agent) keep their name, look, face and voice (brand.LEGACY);
  // a section that was just reset gets the defaults (and its persona's fields), as the notice says.
  if (Object.keys(raw).length) {
    for (const [section, key, value] of LEGACY) if (!dropped.includes(section) && raw[section]?.[key] === undefined) raw[section] = { ...raw[section], [key]: value };
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
  for (const [section, key] of SECRET_FIELDS) {
    const stored = merged[section][key];
    merged[section][key] = decrypt(stored);
    // Another user's keychain, a reset keychain: the key is gone here; the log says which, never the value.
    if (stored && !merged[section][key]) log.warn('secret unreadable', { field: `${section}.${key}` });
  }
  // Installs from before personas (1.4) get their current persona as the first saved one. A tall scene
  // drawing that 2.6.0–2.6.3 copied into another persona goes (personacore.repairScenes), from the live
  // scene too when it is the active persona's.
  merged.personas = personas.ensure(merged, { defaultScene: DEFAULTS.appearance.scene });
  const act = merged.personas.list.find((x) => x.id === merged.personas.active);
  const live = merged.appearance?.scene;
  if (act && !act.scene && live?.svg === DEFAULTS.appearance.scene?.svg) merged.appearance.scene = null;
  else if (live?.portrait && act?.scene && act.scene.svg === live.svg && !act.scene.portrait) merged.appearance.scene = { ...live, portrait: '' };
  settingsCache = merged;
  setSealing(merged.privacy?.encryptConversations !== false);
  // Only a copy that loaded without any repair becomes the last good one: after a restore the backup already
  // is that copy, and a file with a damaged section is never one.
  if (Object.keys(raw).length && !settingsRecovered) await writeJsonAtomic(path.join(dataDir(), 'settings.backup.json'), raw).catch((e) => log.warn('settings backup not written', { error: fsFailure(e) }));
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
// `patch` may be a function of the settings as they are when this save's turn comes (inside the queue),
// for a change computed from them (a persona switch): computed before, two switches at once ended in
// any order, and a switch could put back an edit saved in between. It returns the patch, or null for
// nothing to save (the settings are returned unchanged).
//
// The persona rule lives here, so callers need no persona logic beyond naming the persona:
// - opts.persona: the persona id the change was computed for (captured before any await: an approval, a
//   model call). A change that sets a persona field (personacore.FIELDS) is saved only while that persona
//   is still active, decided inside the queue; otherwise nothing is saved, INFO `settings change dropped`
//   is logged and the save rejects with code PERSONA_CHANGED (`err.settings`: the settings as they are).
//   A change to no persona field is saved whoever is active.
// - A switch (a patch that makes another persona active) sets each persona field it carries whole: the
//   value over the defaults, nothing kept of what was there (merged, a key the new persona lacks kept the
//   last one's: its background colour, face shape, or a summary marked as the user's own).
// - Whatever changed in the live persona is copied into its saved entry (personacore.sync).
const PERSONA_CHANGED = 'PERSONA_CHANGED';

function setSettings(patch, opts) {
  const run = saving.then(() => applySettings(patch, opts));
  saving = run.catch(() => {}); // the queue only orders the work; each caller gets its own error
  return run;
}

function personaChanged(current, patch) {
  const fields = personas.FIELDS.filter(([section, key]) => isPlainObject(patch[section]) && Object.hasOwn(patch[section], key)).map(([section, key]) => `${section}.${key}`);
  log.info('settings change dropped', { reason: 'the persona changed meanwhile', fields });
  const now = current.agent?.name ? ` (${String(current.agent.name).slice(0, 40)} is active now)` : '';
  const err = new Error(`Not saved: the persona changed meanwhile${now}, so nothing was changed.`);
  err.code = PERSONA_CHANGED;
  err.settings = current;
  return err;
}

async function applySettings(patchOrFn, { persona } = {}) {
  const current = await getSettings();
  const patch = typeof patchOrFn === 'function' ? patchOrFn(current) : patchOrFn;
  if (patch == null) return current;
  if (!isPlainObject(patch)) throw new Error('A settings change must be an object.');
  const bad = Object.keys(patch).filter((k) => isSection(k) && patch[k] !== undefined && !isPlainObject(patch[k]));
  if (bad.length) throw new Error(`Settings section${bad.length > 1 ? 's' : ''} ${bad.join(', ')} must be an object.`);
  if (persona && current.personas?.active !== persona && personas.touches(patch)) throw personaChanged(current, patch);
  const next = deepMerge(current, patch);
  const replace = personas.isSwitch(current, patch) ? personas.REPLACE : [];
  for (const [section, key] of replace) {
    if (!isPlainObject(patch?.[section]) || !Object.hasOwn(patch[section], key)) continue;
    const v = patch[section][key];
    const d = DEFAULTS[section]?.[key];
    const whole = isPlainObject(v) && isPlainObject(d) ? deepMerge(d, v) : (key === 'scene' && v === null ? null : (v ?? d ?? null));
    next[section] = { ...next[section], [key]: whole == null ? whole : JSON.parse(JSON.stringify(whole)) };
  }
  // Whatever changed in the live persona (name, prompt, theme, face, voice…) is saved with it.
  next.personas = personas.sync(next);
  // Built before the cache changes: a value that can't be stored (a BigInt; a number as an API key with the
  // real keychain) refuses the save and changes nothing.
  const onDisk = JSON.parse(JSON.stringify(next));
  for (const [section, key] of SECRET_FIELDS) onDisk[section][key] = encrypt(onDisk[section][key]);
  settingsCache = next;
  await writeJsonAtomic(settingsFile(), onDisk);
  setSealing(next.privacy?.encryptConversations !== false);
  tellListeners(next, patch);
  return next;
}

function tellListeners(settings, patch) {
  for (const fn of changeListeners) {
    try {
      fn(settings, patch);
    } catch (err) {
      // A listener's problem is its own, not the save's.
      log.warn('settings listener failed', { error: err });
    }
  }
}

// Reset: settings.json is moved aside (settings.before-reset-<time>.json), never deleted: it holds every
// persona, the encrypted keys and the permissions. Inside the save queue, like every other save, and heard
// like one (onChange), with every section as what changed: paired devices learn the persona went back.
function resetSettings() {
  const run = saving.then(async () => {
    const kept = path.join(dataDir(), `settings.before-reset-${Date.now()}.json`);
    const moved = await fsp.rename(settingsFile(), kept).then(() => kept, (err) => (err.code === 'ENOENT' ? '' : Promise.reject(err)));
    settingsCache = null;
    settingsLoad = null;
    const settings = await getSettings();
    log.info('settings reset', { kept: moved ? path.basename(moved) : '' });
    tellListeners(settings, { ...settings });
    return { settings, kept: moved };
  });
  saving = run.catch(() => {}); // the queue only orders the work; each caller gets its own error
  return run;
}

// ---------- Encrypted blobs ----------
async function getSecretBlob(name) {
  const raw = await readJson(path.join(dataDir(), `${name}.json`), null);
  if (!raw?.data) return null;
  try {
    return JSON.parse(decrypt(raw.data));
  } catch {
    log.warn('secret blob unreadable', { name });
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
  resealTimer = setTimeout(() => resealConversations().catch((err) => log.error('conversations not resealed', { error: err })), 5000);
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
    log.warn('conversation unreadable', { file: path.basename(file), error: parseFailure(err) });
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
  if (changed) log.info('conversations resealed', { changed, sealed: want });
  return changed;
}

function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// 'index' (in any letter case: Windows' file names ignore it) is the conversation index's file; newId gives
// every conversation a prefix and a time, so none is called that.
function safeConvId(id) {
  if (!/^[a-z0-9_-]+$/i.test(String(id)) || String(id).toLowerCase() === 'index') throw new Error('Invalid conversation id');
  return id;
}

// The conversation index (conversations/index.json): one small summary per conversation, kept up to date
// on every save and delete, so listing conversations (the sidebar, the journal every minute) never has to
// open them all. Reconciled with the folder's file names when first loaded: files it doesn't know are read
// once, entries whose file is gone are dropped. An index from an older version (INDEX_VERSION) is
// re-summarized once from the files; an entry whose file can't be read then keeps its saved summary.
const INDEX = 'index.json';
const INDEX_VERSION = 2; // 2: lastOwnAt and routine
let convIndex = null; // Map id → summary
let indexLoad = null;
let indexTimer = null;

// What the tasks sync's message shows (main.js startTasks). Its messages from before the auto marker have
// only this; a typed message has no display, and a slash command's is what was typed.
const TASKS_SYNC_DISPLAY = '🔄 Sync my tasks for the calendar';
// The user's own words: not a hidden prompt, a routine's run or a turn the app started (auto: 'tasks').
const ownMessage = (m) => m.role === 'user' && !m.hidden && !m.routine && !m.auto && m.display !== TASKS_SYNC_DISPLAY;

// A conversation file as the app uses it: an object with an id and a list of message objects (a hand edit,
// an older version or a bug can leave `messages: {}` or nulls in it). Not for index.json, which has no id.
function asConversation(v) {
  if (!isPlainObject(v) || typeof v.id !== 'string') return null;
  return { ...v, messages: Array.isArray(v.messages) ? v.messages.filter(isPlainObject) : [] };
}

function summarize(c) {
  const all = Array.isArray(c.messages) ? c.messages : [];
  const shown = all.filter((m) => m && m.role === 'user' && !m.hidden);
  const own = shown.filter(ownMessage);
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    count: all.length,
    journaledUpTo: c.journaledUpTo || 0,
    // When the user last wrote here (the launch chat, the handoff note), 0 = never.
    lastOwnAt: own.length ? Number(own[own.length - 1].createdAt) || Number(c.updatedAt) || 0 : 0,
    ...(shown.length && !own.length ? { routine: true } : {}), // only runs a routine (or the app) started
    ...(c.setup ? { setup: true } : {}),
  };
}

function loadIndex() {
  if (indexLoad) return indexLoad;
  const run = (async () => {
    await fsp.mkdir(convDir(), { recursive: true });
    const saved = await readConvFile(path.join(convDir(), INDEX), null);
    const stale = (saved?.version || 0) < INDEX_VERSION;
    const map = new Map((Array.isArray(saved?.items) ? saved.items : []).filter((x) => x && typeof x.id === 'string').map((x) => [x.id, x]));
    const ids = new Set((await fsp.readdir(convDir())).filter((n) => n.endsWith('.json') && n !== INDEX).map((n) => n.slice(0, -5)));
    let changed = stale;
    for (const id of map.keys()) if (!ids.has(id)) (map.delete(id), (changed = true));
    for (const id of ids) {
      if (map.has(id) && !stale) continue;
      // null: sealed for another user, broken JSON, not a conversation. A saved entry stays; it is never dropped for that.
      const c = asConversation(await readConvFile(path.join(convDir(), `${id}.json`), null));
      if (c) (map.set(c.id, summarize(c)), (changed = true));
    }
    convIndex = map;
    if (changed) saveIndexSoon();
    return map;
  })();
  indexLoad = run;
  // A failed load is tried again by the next caller (one failed mkdir/readdir broke History until a restart),
  // unless a newer one already took its place (Clear all starts over while a load runs). The caller still
  // gets the rejection.
  run.catch(() => {
    if (indexLoad === run) indexLoad = null;
  });
  return run;
}

function saveIndexSoon() {
  clearTimeout(indexTimer);
  indexTimer = setTimeout(() => {
    if (convIndex) writeConvFile(path.join(convDir(), INDEX), { version: INDEX_VERSION, items: [...convIndex.values()] }).catch((e) => log.warn('conversation index not saved', { error: fsFailure(e) }));
  }, 500);
  indexTimer.unref?.();
}

async function listConversations() {
  const map = await loadIndex();
  return [...map.values()].map((x) => ({ ...x })).sort((a, b) => b.updatedAt - a.updatedAt); // copies: callers may change them
}

async function getConversation(id) {
  return asConversation(await readConvFile(path.join(convDir(), `${safeConvId(id)}.json`), null));
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

/** Changes a stored conversation inside its file's write queue: fn(conv) returns it changed, or null to leave it. */
async function updateConversation(id, fn, { touch = false } = {}) {
  const file = path.join(convDir(), `${safeConvId(id)}.json`);
  let saved = null;
  await updateInQueue(file, async () => {
    const conv = asConversation(await readConvFile(file, null));
    const next = conv && (await fn(conv));
    if (!next) return null;
    if (touch) next.updatedAt = Date.now();
    saved = next;
    return sealText(next);
  });
  if (saved) ((await loadIndex()).set(saved.id, summarize(saved)), saveIndexSoon());
  return saved;
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
  SECRET_FIELDS,
  dataDir,
  getSettings,
  setSettings,
  PERSONA_CHANGED,
  onChange,
  resetSettings,
  getSecretBlob,
  setSecretBlob,
  listConversations,
  getConversation,
  saveConversation,
  updateConversation,
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
  TASKS_SYNC_DISPLAY,
  sweepStaleTemp,
};
