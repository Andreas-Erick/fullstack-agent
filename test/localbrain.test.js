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

// Regression: a 27B local model got the full prompt with every tool (~25k tokens of tool descriptions),
// 32 s to the first word, and its 32k window cut off the start of the prompt (it said "past midnight"
// at 14:38). Every local model now gets the compact prompt unless the user chose the full one.
test('the compact prompt: every local model, unless the user chose', () => {
  const s = (llm) => ({ llm: { compactPrompt: 'auto', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:4b', ...llm } });
  assert.strictEqual(core.compactWanted(s({})), true);
  assert.strictEqual(core.compactWanted(s({ model: 'qwen3.8:27b' })), true, 'a big local model too');
  assert.strictEqual(core.compactWanted(s({ model: 'glm4:latest' })), true, 'a model whose size the name does not say');
  assert.strictEqual(core.compactWanted(s({ baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant' })), false, 'not local');
  assert.strictEqual(core.compactWanted(s({ baseUrl: 'https://x', via: 'local' })), true, 'the multi-provider local brain');
  assert.strictEqual(core.compactWanted(s({ compactPrompt: 'off' })), false);
  assert.strictEqual(core.compactWanted(s({ compactPrompt: 'on', model: 'llama3.3:70b', baseUrl: 'https://x' })), true);
});

// Measured on Ollama with a 27B thinking model: 8.5 s with its hidden thinking, 0.5 s without; and the
// model unloaded after 5 idle minutes.
test('local servers: no hidden thinking unless the message needs it, and the model stays loaded', () => {
  const local = { llm: { baseUrl: 'http://localhost:11434/v1' } };
  assert.deepStrictEqual(core.requestExtras(local, 'quick'), { keep_alive: '30m', reasoning_effort: 'none' });
  assert.deepStrictEqual(core.requestExtras(local, 'normal'), { keep_alive: '30m', reasoning_effort: 'none' });
  assert.deepStrictEqual(core.requestExtras(local, 'deep'), { keep_alive: '30m' }, 'a deep question may think');
  assert.deepStrictEqual(core.requestExtras({ llm: { baseUrl: 'https://api.groq.com/openai/v1' } }, 'quick'), {}, 'cloud providers get nothing extra');
  assert.deepStrictEqual(core.requestExtras({ llm: { baseUrl: 'https://x', via: 'local' } }, 'quick').reasoning_effort, 'none');
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
  assert.ok(system.trim().endsWith('Remember: you are Siren; every reply in your persona’s voice. Short and true; act through tools, never just claim it; ask when unsure.'), 'the key rule (and the voice) again at the end');
  assert.match(system, /in your persona’s voice/, 'rule 1 asks for the persona’s voice, not plain words');
  assert.ok(system.length < 3800, `${system.length} chars`);
  const full = await prompt.buildCompact({ ...settings, agent: { name: 'Siren', personality: 'x'.repeat(5000) } }, []);
  assert.ok(full.system.length < 5500, 'a long persona is shortened to its digest');
  const none = await prompt.buildCompact({ ...settings, agent: { name: 'Siren', personality: '' } }, []);
  assert.match(none.system, /Plain words, no filler/, 'without a persona: plain words');
  assert.match(full.system, /You have no tools/);
});

// Tools on request: a local model starts with the everyday tools and adds a group with tools_more.
test('tools on request: everyday tools first, loaded groups after them in load order', () => {
  const t = (name, group) => ({ name, group });
  const active = [t('flashcards_next', 'learning'), t('memory_save', 'memory'), t('routine_list', 'routines'), t('habit_log', 'habits'), t('habit_add', 'habits'), t('web_search', 'web'), t('vocab_add', 'learning')];
  const names = (list) => list.map((x) => x.name);
  assert.deepStrictEqual(names(core.compactTools(active)), ['memory_save', 'habit_log', 'web_search'], 'only the everyday ones, in their fixed order');
  assert.deepStrictEqual(names(core.compactTools(active, ['learning'])), ['memory_save', 'habit_log', 'web_search', 'flashcards_next', 'vocab_add']);
  assert.deepStrictEqual(names(core.compactTools(active, ['learning', 'habits', 'routines'])), ['memory_save', 'habit_log', 'web_search', 'flashcards_next', 'vocab_add', 'habit_add', 'routine_list'], 'a later group never moves an earlier one');
  assert.deepStrictEqual(names(core.compactTools(active, ['nope'])), ['memory_save', 'habit_log', 'web_search']);
});

test('tools on request: obvious needs are loaded from the first round, never code or connectors', () => {
  assert.deepStrictEqual(core.hintGroups('quiz me on my Spanish flashcards'), ['learning']);
  assert.deepStrictEqual(core.hintGroups('make a PDF of my habits'), ['documents', 'habits']);
  assert.deepStrictEqual(core.hintGroups('Every Monday at 8 give me a summary of my week, automatically.'), ['routines']);
  assert.deepStrictEqual(core.hintGroups('how are you?'), []);
  const groups = new Set(Object.values(core.TOOLBOX).flat());
  for (const g of ['code', 'selfmod', 'engineering', 'engineering_run', 'connectors', 'setup', 'toolbox']) assert.ok(!groups.has(g), `${g} is not offered to a local model`);
  // Every group named exists in main/tools/*.js.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'main', 'tools');
  const declared = new Set(fs.readdirSync(dir).flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/group: '([a-z_]+)'/g)].map((m) => m[1])));
  for (const g of groups) assert.ok(declared.has(g), `tool group ${g} exists`);
});

test('tools_more is never in the full prompt, which already has every tool', async () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'tools.js'), 'utf8');
  assert.match(src, /t\.group === 'setup' \|\| t\.group === 'toolbox'\) return false/);
});

// Regression: notes put inside the user's message made models answer "Based on the context you
// provided…" (glm4, 2.7.2). They are now a system message just before it; inside it only as a
// fallback for templates that refuse a later system message.
test('the per-message notes go just before the newest message, as the app’s, not the user’s', () => {
  const history = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'anything tomorrow?' }];
  const asSystem = core.placeNote(history, 'Now: 15:10.');
  assert.deepStrictEqual(asSystem.slice(0, 3), history.slice(0, 3), 'everything before stays the same, so the server reuses it');
  assert.strictEqual(asSystem[3].role, 'system');
  assert.match(asSystem[3].content, /from the app \(not written by the user/);
  assert.match(asSystem[3].content, /Now: 15:10\./);
  assert.deepStrictEqual(asSystem[4], history[3], 'the user’s message is unchanged');
  const inside = core.placeNote(history, 'Now: 15:10.', { asSystem: false });
  assert.strictEqual(inside.length, 4);
  assert.match(inside[3].content, /not written by the user[\s\S]*End of notes\. The user's message:\)\n\nanything tomorrow\?$/);
  assert.strictEqual(core.placeNote(history, ''), history, 'no notes: nothing changes');
});

test('local models get the memories that match the message first, and hear when none does', async () => {
  const mems = [
    { id: 'm1', title: 'My sister', content: 'My sister’s name is Lena. She lives in Hamburg.', category: 'people', updated: new Date().toISOString() },
    { id: 'm2', title: 'Coffee', content: 'Erick drinks his coffee black.', category: 'preferences', updated: new Date().toISOString() },
  ];
  // memory.relevant ranks relatively: here it returns both for anything, like streamcore with few records.
  stub({ './logger': quietLog, './store': fileStore(tmpDir('nexus-compact-mem-')), './memory': { list: async () => mems, search: async () => [], relevant: async () => mems }, './calendar': { promptBlock: async () => '## Schedule\n' + 'x'.repeat(5000) }, './obsidian': { ymd: () => '2026-10-29', startupContext: async () => '' } });
  const prompt = load('main/prompt.js');
  const settings = { agent: { name: 'Siren', personality: '' }, llm: {}, code: {} };
  const sister = (await prompt.buildCompact(settings, ['memory_search', 'calendar_get_events'], { query: 'What’s my sister’s name?' })).context;
  assert.ok(sister.startsWith('## Relevant memories'), 'first, before a long schedule that gets cut');
  assert.match(sister, /Lena/);
  assert.doesNotMatch(sister, /coffee/i, 'only memories that share a real word with the message');
  const dog = (await prompt.buildCompact(settings, ['memory_search'], { query: 'What’s my dog’s name?' })).context;
  assert.match(dog, /None of your saved memories match/, '"name" alone is no match');
  assert.doesNotMatch(dog, /Lena/);
  assert.strictEqual(prompt.sharesWord('Wie heißt meine Schwester?', 'Meine Schwester heißt Lena'), true);
  assert.strictEqual(prompt.sharesWord('How are you this evening?', 'My sister lives in Hamburg'), false);
});
