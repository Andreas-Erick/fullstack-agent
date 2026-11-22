// The brain catalogue (main/brains.js over renderer/js/braintable.mjs): one row per brain with its name
// and path, whether it is ready and what fixes it, for the router, the brain tools, Health and the window.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, quietLog, settingsSource } = require('./helpers');

stub({ './logger': quietLog });
const brains = load('main/brains.js');
const ROOT = path.join(__dirname, '..');

const base = (over = {}) => ({
  llm: { provider: 'claude-code', baseUrl: '' },
  claudeCode: { model: 'default' },
  anthropic: { apiKey: '', model: 'claude-opus-5-5' },
  local: { baseUrl: 'http://localhost:11434/v1', model: '' },
  gemini: { apiKey: '' },
  deepseek: { apiKey: '' },
  groq: { apiKey: '' },
  perplexity: { apiKey: '' },
  routing: { disabled: [] },
  ...over,
});
const READY = { installed: true, checked: true, loggedIn: true, version: '2.1.0', email: 'a@b.c' };

test('every router provider and every brain choice is one row with a name and a path', () => {
  const router = load('main/router.js');
  const core = load('main/braincore.js');
  const ids = brains.IDS;
  assert.strictEqual(new Set(ids).size, ids.length, 'one row per brain');
  for (const id of [...Object.keys(router.PROVIDERS), ...core.IDS]) assert.ok(ids.includes(id), `${id} is in the catalogue`);
  for (const b of brains.BRAINS) {
    assert.ok(b.name && b.offer, `${b.id} has names`);
    assert.ok(['claude-code', 'anthropic', 'openai', 'router'].includes(b.path), `${b.id} has a path`);
  }
  // The router's view keeps its shape: own-section brains on the OpenAI path, in the default order.
  assert.deepStrictEqual(Object.keys(router.PROVIDERS), ['claude-code', 'anthropic', 'gemini', 'deepseek', 'groq', 'perplexity', 'openai', 'local']);
  assert.strictEqual(router.PROVIDERS.gemini.openai, true);
  assert.strictEqual(router.PROVIDERS.local.openai, true);
  assert.ok(!router.PROVIDERS.openai.openai, 'FreeLLMAPI keeps its address in llm');
  assert.ok(!router.PROVIDERS['claude-code'].openai);
  assert.strictEqual(router.PROVIDERS.perplexity.tools, false);
  assert.strictEqual(router.label('gemini'), 'Gemini');
  // braincore offers them by their long names and in the offer order.
  assert.deepStrictEqual(core.IDS, ['claude-code', 'anthropic', 'local', 'gemini', 'deepseek', 'groq', 'perplexity', 'openai', 'auto']);
  assert.strictEqual(core.choice('local').name, 'A local model on this computer (Ollama / LM Studio)');
  assert.strictEqual(core.missing('perplexity'), 'no Perplexity (web answers, no tools) API key (Settings → AI brain → Multi-provider)');
});

test('names and paths: own-endpoint brains, unknown ids', () => {
  assert.strictEqual(brains.name('claude-code'), 'Claude (account)');
  assert.strictEqual(brains.name('nope'), 'nope');
  assert.strictEqual(brains.brain('__proto__'), null);
  assert.deepStrictEqual(brains.BRAINS.filter((b) => brains.ownEndpoint(b.id)).map((b) => b.id), ['local', 'gemini', 'deepseek', 'groq', 'perplexity']);
  const unknown = brains.current(base({ llm: { provider: 'nope' } }));
  assert.strictEqual(unknown.ready, false);
  assert.strictEqual(unknown.name, 'nope');
});

test('readiness, what is missing and what fixes it, per brain', () => {
  const s = base({ anthropic: { apiKey: 'sk-ant-x', model: 'm' }, gemini: { apiKey: 'g', model: 'gemini-2.5-pro' } });
  const by = Object.fromEntries(brains.list(s).map((e) => [e.id, e]));
  assert.strictEqual(by.anthropic.ready, true);
  assert.strictEqual(by.anthropic.missing, '');
  assert.strictEqual(by.gemini.ready, true);
  assert.strictEqual(by.gemini.model, 'gemini-2.5-pro');
  assert.strictEqual(by.groq.ready, false);
  assert.match(by.groq.missing, /no Groq API key/);
  assert.match(by.groq.fix, /Multi-provider/);
  assert.strictEqual(by.openai.ready, false);
  assert.match(by.openai.missing, /FreeLLMAPI address/);
  assert.strictEqual(by.auto.ready, true, 'a ready brain in the list makes multi-provider ready');
  const none = Object.fromEntries(brains.list(base()).map((e) => [e.id, e]));
  assert.strictEqual(none.anthropic.ready, false);
  assert.strictEqual(none.anthropic.fix, 'Add it in Settings → AI brain.');
  assert.strictEqual(none.auto.ready, false);
  assert.match(none.auto.missing, /multi-provider list/);
});

test('multi-provider: the router\'s list decides, switched-off and resting brains don\'t count', () => {
  const s = base({ llm: { provider: 'auto' }, anthropic: { apiKey: 'k' }, routing: { disabled: ['anthropic'] } });
  assert.strictEqual(brains.current(s).ready, false, 'the only ready brain is switched off');
  const routing = [{ id: 'groq', enabled: true, configured: true, resting: { minutes: 5 } }, { id: 'gemini', enabled: false, configured: true }];
  assert.strictEqual(brains.current(s, { routing }).ready, false);
  routing.push({ id: 'deepseek', enabled: true, configured: true, resting: null });
  assert.strictEqual(brains.current(s, { routing }).ready, true);
});

test('the Claude account ladder: not installed, couldn\'t check, signed out, ready', () => {
  const s = base();
  const missing = brains.current(s, { claude: { installed: false }, installHint: 'irm x | iex' });
  assert.deepStrictEqual([missing.state, missing.ready], ['missing', false]);
  assert.strictEqual(missing.fix, 'Install: irm x | iex, or set its path in Settings → AI brain.');
  assert.match(missing.missing, /not installed or not signed in/);

  const unchecked = brains.current(s, { claude: { installed: true, checked: false, error: 'timed out' } });
  assert.deepStrictEqual([unchecked.state, unchecked.ready], ['unchecked', false]);
  assert.strictEqual(unchecked.fix, 'Try again in a moment (Settings → AI brain → Refresh).');
  assert.strictEqual(unchecked.claude.error, 'timed out', 'the window words the error itself');

  const out = brains.current(s, { claude: { installed: true, checked: true, loggedIn: false, version: '2.1.0' } });
  assert.deepStrictEqual([out.state, out.ready], ['signedOut', false]);
  assert.strictEqual(out.fix, 'Settings → AI brain → Connect Claude account.');

  const ready = brains.current(s, { claude: READY });
  assert.deepStrictEqual([ready.state, ready.ready, ready.missing, ready.fix], ['ready', true, '', '']);

  // Not probed: not ready, and it says so instead of guessing.
  assert.deepStrictEqual([brains.current(s).state, brains.current(s).ready], ['unknown', false]);
});

test('a local brain is ready with a model picked, not without', () => {
  const without = brains.current(base({ llm: { provider: 'local' } }));
  assert.strictEqual(without.ready, false);
  assert.strictEqual(without.local, true);
  assert.strictEqual(without.path, 'openai');
  assert.match(without.missing, /no local model picked/);
  const withModel = brains.current(base({ llm: { provider: 'local' }, local: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' } }));
  assert.deepStrictEqual([withModel.ready, withModel.model], [true, 'qwen3:8b']);
  const noServer = brains.current(base({ llm: { provider: 'local' }, local: { baseUrl: '', model: 'qwen3:8b' } }));
  assert.strictEqual(noServer.ready, false);
});

test('live(): probes the Claude account only when it answers (or all), through the cached status', async () => {
  let calls = 0;
  stub({
    './claudecode': { status: async ({ fresh } = {}) => (calls++, { ...READY, fresh }), installHint: () => 'hint' },
    './router': { status: async () => [{ id: 'claude-code', enabled: true, configured: true, resting: null }] },
  });
  const b = load('main/brains.js');
  const a = await b.live(base({ llm: { provider: 'anthropic' }, anthropic: { apiKey: 'k' } }));
  assert.strictEqual(calls, 0, 'no Claude probe for another brain');
  assert.strictEqual(a.current.ready, true);
  assert.strictEqual(a.routing, null);
  const c = await b.live(base(), { fresh: true });
  assert.strictEqual(calls, 1);
  assert.strictEqual(c.current.claude.fresh, true, 'Settings\' fresh check is passed on');
  const auto = await b.live(base({ llm: { provider: 'auto' } }));
  assert.strictEqual(calls, 1, 'multi-provider reads the router\'s list');
  assert.strictEqual(auto.current.ready, true);
  assert.strictEqual(auto.brains.find((e) => e.id === 'claude-code').ready, true);
});

test('live(): a failed status check is "couldn\'t check", never "not installed"', async () => {
  stub({ './claudecode': { status: async () => { throw new Error('probe crashed'); }, installHint: () => 'hint' } });
  const b = load('main/brains.js');
  const r = await b.live(base());
  assert.strictEqual(r.current.state, 'unchecked');
  assert.strictEqual(r.current.claude.error, 'probe crashed');
});

test('the window and the phone read names and paths from the table, not their own lists', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  assert.doesNotMatch(read('renderer/js/app.js'), /const SINGLE\b/);
  assert.doesNotMatch(settingsSource(), /SINGLE_BRAINS/);
  assert.doesNotMatch(read('renderer/js/hud.js'), /const PROVIDERS/);
  assert.doesNotMatch(read('renderer/js/chatcore.js'), /OPENAI_PATH/);
  for (const f of ['renderer/js/app.js', 'renderer/js/hud.js', 'renderer/js/chatcore.js']) assert.match(read(f), /from '\.\/braintable\.mjs'/, f);
  assert.match(read('renderer/js/settings/brain.js'), /from '\.\.\/braintable\.mjs'/, 'renderer/js/settings/brain.js');
  assert.match(read('main/companion.js'), /'\/js\/braintable\.mjs': 'renderer\/js\/braintable\.mjs'/);
  assert.match(read('renderer/remote/sw.js'), /'\/js\/braintable\.mjs'/);
  assert.match(read('preload.js'), /'brains'/);
  assert.match(read('main/main.js'), /handle\('llm:brains'/);
});
