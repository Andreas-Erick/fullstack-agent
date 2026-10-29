// Switching the brain from the chat (main/braincore.js): every choice can answer on its own, a switch
// writes only the provider and that brain's model, and a local model's address comes from the
// servers found on this computer, never from the caller.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const core = load('main/braincore.js');

test('every choice is a provider the app can run, plus multi-provider', () => {
  stub({ './logger': quietLog });
  const router = load('main/router.js');
  for (const id of core.IDS) assert.ok(id === 'auto' || Object.hasOwn(router.PROVIDERS, id), id);
  for (const id of Object.keys(router.PROVIDERS)) assert.ok(core.IDS.includes(id), `${id} can be chosen`);
});

test('a switch writes the provider and that brain’s model, nothing else', () => {
  assert.deepStrictEqual(core.patchFor('claude-code'), { llm: { provider: 'claude-code' } });
  assert.deepStrictEqual(core.patchFor('claude-code', { model: 'opus' }), { llm: { provider: 'claude-code' }, claudeCode: { model: 'opus' } });
  assert.deepStrictEqual(core.patchFor('anthropic', { model: 'claude-sonnet-5-5' }), { llm: { provider: 'anthropic' }, anthropic: { model: 'claude-sonnet-5-5' } });
  assert.deepStrictEqual(core.patchFor('gemini', { model: 'gemini-2.5-pro' }), { llm: { provider: 'gemini' }, gemini: { model: 'gemini-2.5-pro' } });
  assert.deepStrictEqual(core.patchFor('auto', { model: 'x' }), { llm: { provider: 'auto' } });
  assert.throws(() => core.patchFor('nope'), /Unknown brain/);
  assert.throws(() => core.patchFor('claude-code', { model: 'gpt-4' }), /Claude account/);
  assert.throws(() => core.patchFor('gemini', { model: 'a b' }), /not a model name/);
  assert.throws(() => core.patchFor('gemini', { model: '../x' }), /not a model name/);
});

test('a local model must be installed, and its server address comes from the found servers', () => {
  const servers = [
    { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', running: true, models: [{ id: 'qwen3:8b' }] },
    { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', running: false, models: [] },
  ];
  assert.deepStrictEqual(core.patchFor('local', { model: 'qwen3:8b', servers }), { llm: { provider: 'local' }, local: { model: 'qwen3:8b', baseUrl: 'http://localhost:11434/v1' } });
  assert.throws(() => core.patchFor('local', { model: 'llama3:70b', servers }), /Installed: qwen3:8b/);
  assert.throws(() => core.patchFor('local', { model: 'qwen3:8b', servers: [] }), /No local model server/);
});

test('the switch is described for the approval', () => {
  const s = { llm: { provider: 'claude-code' }, claudeCode: { model: 'default' }, local: { model: '' } };
  assert.strictEqual(core.describe(s, core.patchFor('local', { model: 'qwen3:8b', servers: [{ running: true, baseUrl: 'http://localhost:11434/v1', models: [{ id: 'qwen3:8b' }] }] })), 'Claude (your Claude account) (default) → A local model on this computer (Ollama / LM Studio) (qwen3:8b)');
  assert.match(core.missing('groq'), /Groq API key/);
});

test('a small local brain can switch back: the tools are in its compact set', () => {
  const local = load('main/localcore.js');
  assert.ok(local.COMPACT_TOOLS.includes('brain_switch'));
});
