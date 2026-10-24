// Persistent settings + conversation history, stored as JSON in the app's userData folder.
// Secrets (API keys, OAuth secrets) are encrypted at rest with the OS keychain via safeStorage when available.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');

const DEFAULT_PERSONALITY = `You are warm, sharp and concise. You speak like a capable co-pilot: direct, a little playful, never robotic.
You remember what matters to the user and proactively use what you know about them, their calendar and their notes.
When you are not sure, you say so instead of guessing.`;

const DEFAULTS = {
  onboarded: false, // first-run setup wizard completed
  agent: {
    name: 'Nexus',
    personality: DEFAULT_PERSONALITY, // the master prompt
    avatar: null,
    aesthetic: '', // the overall aesthetic / style / theme the persona should embody
  },
  appearance: {
    theme: null, // generated or edited theme object; null = default neon circuit theme
    personaNotes: '', // tone/style notes derived from the aesthetic, injected into the system prompt
    applyVoice: true, // let persona generation pick a matching VoiceStudio voice
  },
  llm: {
    provider: 'openai', // 'openai' = FreeLLMAPI / OpenAI-compatible, 'claude-code' = Claude account, 'anthropic' = Claude API key, 'auto' = multi-provider (see routing)
    baseUrl: 'http://localhost:3001/v1',
    apiKey: '',
    model: '',
    temperature: 0.7,
    maxTokens: 4096,
    useTools: true,
    maxToolRounds: 8,
    historyLimit: 30,
    compaction: true, // summarize older turns instead of dropping them
    modelMode: 'default', // default | fast | deep (switchable by voice)
    voiceUsesFast: true, // use the fast model for spoken turns (switched in place, no session restart)
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
    fallbackSystemVoice: true, // use the OS voice if VoiceStudio is unreachable
  },
  stt: {
    enabled: true,
    engine: 'local', // 'local' = Whisper in-app (transformers.js), 'remote' = OpenAI-compatible /audio/transcriptions
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
    workspace: '', // where repos are cloned; empty = ~/NexusRepos
  },
  calendar: {
    enabled: true,
    clientId: '',
    clientSecret: '',
    daysAhead: 7,
    allCalendars: true,
    allowWrite: true, // let the agent create, change and delete events (needs a sign-in that granted it)
    icsUrls: '', // read-only calendar feeds (iCal links), one per line; no Google sign-in needed
  },
  screen: {
    attachToMessages: true, // while the screen is shared, each message carries a fresh screenshot
  },
  obsidian: {
    enabled: true,
    vaultPath: '', // empty = the agent's own vault in Documents/Nexus Vault
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
  },
  logging: {
    debug: false, // also write DEBUG lines (e.g. Claude Code's raw error output) to the log
  },
  journal: {
    enabled: true, // write a session entry to the daily note after a conversation goes quiet
    idleMinutes: 15,
    handoffOnClose: true, // on closing the app, note where we left off (handoff.js) for the next session
  },
  memory: {
    vaultPath: '', // empty = <vault>/Memory
  },
  documents: {
    allowedRoots: [], // empty = Documents, Desktop, Downloads (+ Obsidian vault)
    workspace: '', // the agent's workspace folder: searched first for files the user names, always allowed
  },
  ui: {
    showVisualizerInChat: true,
    captions: true,
    face: 'circuit', // circuit | radial | rain | neural | companion | custom:<folder>
    zoom: 1, // whole-window zoom (Ctrl + / Ctrl − / Ctrl 0, Ctrl + wheel)
    chatLayout: 'split', // chat | split | face — what the chat view shows
    facePanelWidth: 300, // width of the face next to the chat in the split layout (drag the divider)
    sleepAfterMin: 10, // the face dozes off after this long without activity (0 = never)
  },
};

const SECRET_FIELDS = [
  ['llm', 'apiKey'],
  ['anthropic', 'apiKey'],
  ['voice', 'apiKey'],
  ['stt', 'remoteKey'],
  ['calendar', 'clientSecret'],
  ['calendar', 'icsUrls'], // a secret iCal address gives read access to the calendar
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
  const text = JSON.stringify(data, null, 2); // snapshot now; later changes to data don't leak in
  const next = (writeQueues.get(file) || Promise.resolve()).catch(() => {}).then(() => writeNow(file, text));
  writeQueues.set(file, next);
  next.then(
    () => writeQueues.get(file) === next && writeQueues.delete(file),
    () => writeQueues.get(file) === next && writeQueues.delete(file),
  );
  return next;
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
  const merged = deepMerge(DEFAULTS, raw);
  // The thinking sound used to be on/off; it is now a style.
  if (typeof merged.voice.thinkingSound === 'boolean') merged.voice.thinkingSound = merged.voice.thinkingSound ? 'grandfather' : 'off';
  if (merged.voice.thinkingSound === 'tick') merged.voice.thinkingSound = 'clock';
  for (const [section, key] of SECRET_FIELDS) merged[section][key] = decrypt(merged[section][key]);
  settingsCache = merged;
  return merged;
}

async function setSettings(patch) {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  settingsCache = next;
  const onDisk = JSON.parse(JSON.stringify(next));
  for (const [section, key] of SECRET_FIELDS) onDisk[section][key] = encrypt(onDisk[section][key]);
  await writeJsonAtomic(settingsFile(), onDisk);
  return next;
}

async function resetSettings() {
  settingsCache = null;
  settingsLoad = null;
  await fsp.rm(settingsFile(), { force: true });
  return getSettings();
}

// ---------- Encrypted blobs (OAuth tokens) ----------
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

function newId(prefix = '') {
  return prefix + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

function safeConvId(id) {
  if (!/^[a-z0-9_-]+$/i.test(String(id))) throw new Error('Invalid conversation id');
  return id;
}

async function listConversations() {
  await fsp.mkdir(convDir(), { recursive: true });
  const files = (await fsp.readdir(convDir())).filter((f) => f.endsWith('.json'));
  const items = await Promise.all(
    files.map(async (f) => {
      const c = await readJson(path.join(convDir(), f), null);
      if (!c) return null;
      return {
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        count: c.messages?.length || 0,
        ...(c.setup ? { setup: true } : {}),
      };
    }),
  );
  return items.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function getConversation(id) {
  return readJson(path.join(convDir(), `${safeConvId(id)}.json`), null);
}

async function saveConversation(conv, { touch = true } = {}) {
  if (touch) conv.updatedAt = Date.now();
  await writeJsonAtomic(path.join(convDir(), `${safeConvId(conv.id)}.json`), conv);
  return conv;
}

async function createConversation(title = 'New conversation') {
  const now = Date.now();
  return saveConversation({ id: newId('c'), title, createdAt: now, updatedAt: now, messages: [] });
}

async function deleteConversation(id) {
  await fsp.rm(path.join(convDir(), `${safeConvId(id)}.json`), { force: true });
}

async function renameConversation(id, title) {
  const conv = await getConversation(id);
  if (!conv) throw new Error('Conversation not found');
  conv.title = String(title).slice(0, 120);
  return saveConversation(conv);
}

async function clearConversations() {
  await fsp.rm(convDir(), { recursive: true, force: true });
}

async function exportConversations() {
  const list = await listConversations();
  return Promise.all(list.map((c) => getConversation(c.id)));
}

module.exports = {
  DEFAULTS,
  dataDir,
  getSettings,
  setSettings,
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
  settingsRecovery: () => settingsRecovered,
  SECRET_FIELDS,
  sweepStaleTemp,
};
