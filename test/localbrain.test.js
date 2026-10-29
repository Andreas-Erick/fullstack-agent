// Local brains (main/localcore.js): model sizes from Ollama and LM Studio, suggestions that fit the
// computer, when the compact prompt applies, that its tools exist, and the compact prompt itself.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog, tmpDir, fileStore } = require('./helpers');

const core = load('main/localcore.js');

test('model sizes, from the server or the name', () => {
  assert.strictEqual(core.paramsOf('llama3.1:latest', { parameter_size: '8.0B' }), 8);
  assert.strictEqual(core.paramsOf('tiny', { parameter_size: '567M' }), 0.567);
  assert.strictEqual(core.paramsOf('qwen3:4b'), 4);
  assert.strictEqual(core.paramsOf('mistral-7b-instruct-v0.3'), 7);
  assert.strictEqual(core.paramsOf('qwen2.5-coder-32b-instruct'), 32);
  assert.strictEqual(core.paramsOf('phi-3-mini-4k-instruct'), 4, 'a "mini" without a size counts as small');
  assert.strictEqual(core.paramsOf('my-model'), null);
  assert.ok(core.isSmall('gemma3:12b') && !core.isSmall('llama3.3:70b') && !core.isSmall('unknown'));
});

test('what the servers list, without embedding models', () => {
  const ollama = core.parseOllama({ models: [{ name: 'qwen3:8b', size: 5e9, details: { parameter_size: '8.2B' } }, { name: 'nomic-embed-text:latest', details: {} }, { nope: 1 }] });
  assert.deepStrictEqual(ollama, [{ id: 'qwen3:8b', name: 'qwen3:8b', params: 8.2, bytes: 5e9 }]);
  const lm = core.parseOpenAIModels({ data: [{ id: 'llama-3.2-3b-instruct' }, { id: 'text-embedding-nomic' }] });
  assert.deepStrictEqual(lm.map((m) => [m.id, m.params]), [['llama-3.2-3b-instruct', 3]]);
  assert.deepStrictEqual(core.parseOllama(null), []);
});

test('suggestions fit the graphics memory, or a third of the RAM', () => {
  assert.deepStrictEqual(core.suggest({ vramGb: 8 }).map((s) => s.model), ['qwen3:8b', 'qwen3:4b', 'llama3.2:3b']);
  assert.ok(core.suggest({ vramGb: 0, ramGb: 12 }).every((s) => s.needGb <= 4));
  assert.ok(core.suggest({}).length > 0, 'something even on a small computer');
});

test('the compact prompt: small local models only, unless the user chose', () => {
  const s = (llm) => ({ llm: { compactPrompt: 'auto', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:4b', ...llm } });
  assert.strictEqual(core.compactWanted(s({})), true);
  assert.strictEqual(core.compactWanted(s({ model: 'llama3.3:70b' })), false, 'a big model gets the full prompt');
  assert.strictEqual(core.compactWanted(s({ baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' })), false, 'not local');
  assert.strictEqual(core.compactWanted(s({ baseUrl: 'https://x', via: 'local' })), true, 'the multi-provider local brain');
  assert.strictEqual(core.compactWanted(s({ compactPrompt: 'off' })), false);
  assert.strictEqual(core.compactWanted(s({ compactPrompt: 'on', model: 'llama3.3:70b', baseUrl: 'https://x' })), true);
  assert.strictEqual(core.compactWanted(s({}), 'llama3.3:70b'), false, 'the model this turn runs on decides (fast/deep)');
});

test('every compact tool exists, and they are few', () => {
  stub({ electron: { app: { getPath: () => tmpDir('nexus-local-') } } });
  const names = new Set(require('fs').readdirSync(require('path').join(__dirname, '..', 'main', 'tools')).flatMap((f) => [...require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'tools', f), 'utf8').matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1])));
  for (const t of core.COMPACT_TOOLS) assert.ok(names.has(t), t);
  assert.ok(core.COMPACT_TOOLS.length <= 16);
});

test('the compact prompt is short, starts with the role and ends with the key rule', async () => {
  stub({ './logger': quietLog, './store': fileStore(tmpDir('nexus-compact-')), './memory': { list: async () => [], search: async () => [] }, './calendar': { promptBlock: async () => '' }, './obsidian': { ymd: () => '2026-10-29', startupContext: async () => '' } });
  const prompt = load('main/prompt.js');
  const settings = { agent: { name: 'Siren', personality: 'Warm and witty.' }, llm: {}, code: {} };
  const { system } = await prompt.buildCompact(settings, ['memory_save', 'web_search']);
  assert.ok(system.startsWith('You are Siren'), 'the role first');
  assert.match(system, /Warm and witty/);
  assert.match(system, /memory_save, web_search/);
  assert.match(system, /ask one short question/);
  assert.ok(system.trim().endsWith('Remember: short and true; act through tools, never just claim it; ask when unsure.'), 'the key rule again at the end');
  assert.ok(system.length < 3500, `${system.length} chars`);
  const full = await prompt.buildCompact({ ...settings, agent: { name: 'Siren', personality: 'x'.repeat(5000) } }, []);
  assert.ok(full.system.length < 4000, 'a long persona is shortened');
  assert.match(full.system, /You have no tools/);
});
