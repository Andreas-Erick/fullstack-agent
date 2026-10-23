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
    provider: 'openai', // 'openai' = FreeLLMAPI / OpenAI-compatible, 'claude-code' = Claude account, 'anthropic' = Claude API key
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
    voiceUsesFast: false, // use the fast model for spoken turns
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
    thinkingSound: true,
    filler: true, // short spoken lines while tools run
    fallbackSystemVoice: true, // use the OS voice if VoiceStudio is unreachable
  },
  stt: {
    enabled: true,
    engine: 'local', // 'local' = Whisper in-app (transformers.js), 'remote' = OpenAI-compatible /audio/transcriptions
    localModel: 'Xenova/whisper-base.en',
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
  },
  calendar: {
    enabled: true,
    clientId: '',
    clientSecret: '',
    daysAhead: 7,
    allCalendars: true,
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
  journal: {
    enabled: true, // write a session entry to the daily note after a conversation goes quiet
    idleMinutes: 15,
  },
  memory: {
    vaultPath: '', // empty = <vault>/Memory
  },
  documents: {
    allowedRoots: [], // empty = Documents, Desktop, Downloads (+ Obsidian vault)
  },
  ui: {
    showVisualizerInChat: true,
    captions: true,
    face: 'circuit', // circuit | radial | rain | neural | custom:<folder>
  },
};

const SECRET_FIELDS = [
  ['llm', 'apiKey'],
  ['anthropic', 'apiKey'],
  ['voice', 'apiKey'],
  ['stt', 'remoteKey'],
  ['calendar', 'clientSecret'],
  ['web', 'braveKey'],
  ['web', 'tavilyKey'],
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

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

// ---------- Settings ----------
let settingsCache = null;

function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

async function getSettings() {
  if (settingsCache) return settingsCache;
  const raw = await readJson(settingsFile(), {});
  // Installs from before the setup wizard existed are already configured.
  if (Object.keys(raw).length && raw.onboarded === undefined) raw.onboarded = true;
  const merged = deepMerge(DEFAULTS, raw);
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
};
