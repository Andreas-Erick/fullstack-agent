// llm.runTurn and llm.complete in multi-provider mode hand the turn to router.runTurn / router.complete with
// runOn / completeOn as the per-provider runner: a Claude account that hit its limit before any text gives
// way to Gemini (on the OpenAI path, a fake server here), and the reply names the provider that answered.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const sent = [];
const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify({ model: 'gemini-x', choices: [{ delta: c, finish_reason: null }] })}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  sent.push({ url: String(url), body });
  if (body.stream) return sse([{ content: 'From Gemini' }]);
  return new Response(JSON.stringify({ model: 'gemini-x', choices: [{ message: { content: 'Completed by Gemini' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const limit = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });
stub({
  './logger': quietLog,
  './helperapps': { onUnreachable() {} },
  './tools': { TOOLS: [], activeTools: async () => [], execute: async () => ({ ok: true }), stringifyResult: (r) => JSON.stringify(r) },
  './prompt': { build: async () => ({ system: 's', stable: 's', context: 'c' }) },
  './claudecode': {
    status: async () => ({ installed: true, loggedIn: true }),
    runTurn: async () => { throw limit(); },
    complete: async () => { throw limit(); },
    needsRollover: () => false,
    cachedConnectors: async () => ({ list: [] }),
  },
  './codebase': { root: async () => '/app' },
  './obsidian': { vaultPath: async () => null },
  './github': {},
  './documents': { userFolders: () => [] },
  './approvals': { newTurn: () => ({ approved: new Set(), taintSources: [] }), markTainted() {} },
});
const llm = load('main/llm.js');
const router = require('../main/router');

const settings = () => ({
  agent: { name: 'Siren', personality: 'p' }, appearance: {}, voice: {}, safety: {}, code: {}, web: {}, personas: {}, claudeCode: {}, anthropic: { apiKey: '' },
  llm: { provider: 'auto', baseUrl: '', useTools: false, autoPace: true, modelMode: 'default', historyLimit: 30 },
  gemini: { apiKey: 'k', baseUrl: 'https://gemini.example/v1', model: 'gemini-x' },
  routing: { order: ['claude-code', 'gemini'], disabled: [], smart: false, cooldownMin: 15 },
});

test('runTurn: Claude hit its limit, Gemini answers, the reply names it', async () => {
  router.reset();
  sent.length = 0;
  const events = [];
  const conv = { id: 'c1', messages: [{ role: 'user', content: 'Hello there' }] };
  const r = await llm.runTurn({ settings: settings(), conv, history: conv.messages, emit: (e) => events.push(e), signal: new AbortController().signal, images: [] });
  assert.strictEqual(r.provider, 'gemini');
  assert.strictEqual(r.text, 'From Gemini');
  assert.ok(sent[0].url.startsWith('https://gemini.example/v1'), 'Gemini ran with its own settings');
  assert.deepStrictEqual(events.filter((e) => e.type === 'notice').map((e) => e.message), ['Claude (account) hit its rate limit (skipped for 15 min) — switching to Gemini.']);
});

test('complete: the same fallback, the provider\'s output as it is', async () => {
  router.reset();
  sent.length = 0;
  const out = await llm.complete(settings(), 'Name a colour');
  assert.match(String(out?.text ?? out), /Completed by Gemini/);
  assert.strictEqual((await router.plan(settings()))[0].id, 'gemini', 'Claude rests after its limit');
});
