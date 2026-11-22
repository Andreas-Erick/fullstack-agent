// The per-brain lists that follow from renderer/js/braintable.mjs (one row per brain): the settings
// sections and their defaults (store.js DEFAULTS), the encrypted keys (SECRET_FIELDS), the model keys the
// agent may change (tools.js SETTABLE), the default multi-provider order and the per-task preferences
// (router.js PREFER), which brains see pictures (attachcore SEES_IMAGES) and the Settings blurbs. The
// literals below are the values these had when each module kept its own list: deriving them from the rows
// must not change one of them. A new brain changes them on purpose, and this file with it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, stub, load } = require('./helpers');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-brainrows-'));
const anything = new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => tmp : p === 'getPath' ? () => tmp : p === 'isPackaged' ? false : p === 'platform' ? process.platform : anything),
  apply: () => anything,
  construct: () => anything,
});
stub({ electron: anything });
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const table = require('../renderer/js/braintable.mjs');
const store = load('main/store.js');
const tools = load('main/tools.js');
const router = load('main/router.js');
const attachcore = load('main/attachcore.js');

const OWN = ['gemini', 'deepseek', 'groq', 'perplexity', 'local'];

const SNAPSHOT = {
  sections: {
    gemini: { apiKey: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', fastModel: '', deepModel: 'gemini-2.5-pro' },
    deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', fastModel: '', deepModel: 'deepseek-reasoner' },
    groq: { apiKey: '', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', fastModel: '', deepModel: '' },
    perplexity: { apiKey: '', baseUrl: 'https://api.perplexity.ai', model: 'sonar', fastModel: '', deepModel: 'sonar-pro' },
    local: { apiKey: '', baseUrl: 'http://localhost:11434/v1', model: '', fastModel: '', deepModel: '' },
  },
  order: ['claude-code', 'anthropic', 'gemini', 'deepseek', 'groq', 'perplexity', 'openai'],
  secrets: [
    ['llm', 'apiKey'],
    ['anthropic', 'apiKey'],
    ['voice', 'apiKey'],
    ['stt', 'remoteKey'],
    ['gemini', 'apiKey'],
    ['deepseek', 'apiKey'],
    ['groq', 'apiKey'],
    ['perplexity', 'apiKey'],
    ['local', 'apiKey'],
    ['cloudVoice', 'apiKey'],
    ['web', 'braveKey'],
    ['web', 'tavilyKey'],
    ['remote', 'tunnelToken'],
  ],
  settable: {
    llm: ['baseUrl', 'model', 'temperature', 'maxTokens', 'historyLimit', 'modelMode', 'autoPace', 'fastModel', 'deepModel', 'maxToolRounds', 'engineeringToolRounds'],
    claudeCode: ['model', 'effort', 'fastModel', 'normalModel', 'deepModel', 'idleMinutes'],
    anthropic: ['model', 'effort', 'fastModel', 'normalModel', 'deepModel'],
    voice: ['ttsEnabled', 'autoSpeak', 'baseUrl', 'model', 'voice', 'speed', 'format', 'greetOnLaunch', 'speakLimit', 'thinkingSound', 'thinkingVolume', 'filler', 'fallback', 'localVoice'],
    stt: ['enabled', 'engine', 'localModel', 'language', 'pttKey', 'autoSend', 'micMode', 'micDevice', 'headphones', 'vadSensitivity'],
    calendar: ['daysAhead'],
    routing: ['smart', 'cooldownMin'],
    gemini: ['model', 'fastModel', 'deepModel'],
    deepseek: ['model', 'fastModel', 'deepModel'],
    groq: ['model', 'fastModel', 'deepModel'],
    perplexity: ['model', 'fastModel', 'deepModel'],
    obsidian: ['injectIndex', 'maxIndexEntries'],
    journal: ['enabled', 'idleMinutes', 'handoffOnClose'],
    ui: ['showVisualizerInChat', 'captions', 'face', 'zoom', 'chatLayout', 'sleepAfterMin', 'sleepOnLaunch', 'fx'],
  },
  prefer: {
    code: ['claude-code', 'anthropic', 'deepseek', 'gemini'],
    search: ['perplexity', 'gemini'],
    quick: ['local', 'groq', 'gemini', 'claude-code', 'anthropic'],
    long: ['gemini', 'anthropic', 'claude-code'],
    deep: ['anthropic', 'claude-code', 'gemini', 'deepseek'],
  },
  seesImages: { 'claude-code': true, anthropic: true, gemini: true, deepseek: false, groq: false, perplexity: false, local: false, openai: null, auto: null },
  blurbs: {
    'claude-code': 'Your Claude subscription through Claude Code. Best for tools, code and long tasks.',
    anthropic: 'Pay-per-use Claude API key.',
    gemini: 'Google Gemini. Free tier available; very long context.',
    deepseek: 'DeepSeek. Low-cost, strong at code.',
    groq: 'Groq. Very fast replies (good for voice); free tier available.',
    perplexity: 'Perplexity Sonar. Searches the web itself; no tools (calendar, notes…).',
    openai: 'FreeLLMAPI or any OpenAI-compatible server.',
    local: 'A model running on this computer with Ollama or LM Studio: private, free, and quick for short replies with a small model. Smart routing sends quick spoken replies here first.',
  },
};

const sortPairs = (list) => list.map((p) => p.join('.')).sort();

test('the own-section brains keep their settings sections and defaults', () => {
  for (const id of OWN) assert.deepStrictEqual(store.DEFAULTS[id], SNAPSHOT.sections[id], id);
  assert.deepStrictEqual(store.DEFAULTS.routing.order, SNAPSHOT.order);
});

test('the encrypted keys are exactly the ones they were (never fewer)', () => {
  assert.deepStrictEqual(sortPairs(store.SECRET_FIELDS), sortPairs(SNAPSHOT.secrets));
  // Every brain with its own section keeps its key encrypted.
  for (const b of table.BRAINS.filter((x) => table.ownEndpoint(x.id))) assert.ok(store.SECRET_FIELDS.some(([s, k]) => s === b.section && k === 'apiKey'), b.id);
});

test('what the agent may change is exactly what it was (never wider)', () => {
  const sorted = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, [...o[k]].sort()]));
  assert.deepStrictEqual(sorted(tools.SETTABLE), sorted(SNAPSHOT.settable));
  // A brain's own section only ever lends the agent its model keys, never its address or key.
  for (const b of table.BRAINS.filter((x) => table.ownEndpoint(x.id))) {
    for (const k of tools.SETTABLE[b.section] || []) assert.match(k, /^(model|fastModel|deepModel)$/, `${b.section}.${k}`);
  }
  // Every settable key has a default.
  for (const [section, keys] of Object.entries(tools.SETTABLE)) for (const k of keys) assert.ok(k in (store.DEFAULTS[section] || {}), `${section}.${k}`);
});

test('the router prefers the same brains per task, in the same order', () => {
  assert.deepStrictEqual(router.PREFER, SNAPSHOT.prefer);
});

test('the same brains see pictures', () => {
  assert.deepStrictEqual(attachcore.SEES_IMAGES, SNAPSHOT.seesImages);
});

test('Settings shows the same blurb for each routed brain', () => {
  for (const [id, text] of Object.entries(SNAPSHOT.blurbs)) assert.strictEqual(table.brain(id)?.blurb, text, id);
  assert.match(fs.readFileSync(path.join(ROOT, 'renderer/js/settings.js'), 'utf8'), /brain\(p\.id\)\?\.blurb/, 'settings.js reads the row');
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'renderer/js/settings.js'), 'utf8'), /const PROVIDER_HINT/, 'no second copy');
});
