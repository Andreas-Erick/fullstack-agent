// The turn prompt (main/turnprompt.js): one module picks the prompt builder for every brain and assembles
// the turn's facts (the user's own words, the persona that wrote the last reply, spoken, the note of a
// message answered again). The golden test runs real turns through llm.js on every brain over prompt
// builders that echo what they were asked, and compares what reached each brain with what the code sent
// before the module existed (captured from that code), byte for byte.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const attachcore = require('../main/attachcore');

// ---- stand-ins: prompt builders that echo their inputs, brains that record what they were given
const seen = [];
const echo = (tag, s, names, opts) => `${tag}|${s.agent.name}|${JSON.stringify(names)}|${JSON.stringify(opts)}`;
const promptStub = {
  build: async (s, names, opts) => ({ system: echo('build', s, names, opts), stable: echo('build.stable', s, names, opts), context: echo('build.context', s, names, opts) }),
  buildSetup: (s) => ({ system: `setup|${s.agent.name}`, stable: `setup.stable|${s.agent.name}`, context: `setup.context|${s.agent.name}` }),
  buildCompact: async (s, names, opts) => ({ system: echo('compact', s, names, opts), stable: echo('compact.stable', s, names, opts), context: echo('compact.context', s, names, opts), reminder: 'reminder' }),
  turnContext: async (s, names, memIds, opts) => `turnContext|${s.agent.name}|${JSON.stringify([names, memIds, opts])}`,
};
const memorySave = { name: 'memory_save', group: 'memory', description: 'save', parameters: { type: 'object', properties: {} }, run: async () => ({}) };
const memorySearch = { name: 'memory_search', group: 'memory', description: 'search', parameters: { type: 'object', properties: {} }, run: async () => ({}) };
const toolsMore = { name: 'tools_more', group: 'toolbox', description: 'more', parameters: { type: 'object', properties: {} }, run: async () => ({}) };

global.fetch = async (url, init) => {
  const payload = JSON.parse(init.body);
  seen.push({ brain: 'openai', messages: payload.messages.filter((m) => m.role === 'system').map((m) => m.content) });
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
class FakeAnthropic {
  constructor() {
    this.beta = { messages: { stream: (params) => {
      seen.push({ brain: 'anthropic', system: params.system.map((b) => b.text) });
      throw new Error('captured');
    } } };
  }
}
stub({
  './logger': quietLog,
  './prompt': promptStub,
  '@anthropic-ai/sdk': FakeAnthropic,
  './store': { getSettings: async () => ({ agent: { name: 'Stored' } }) },
  './tools': {
    TOOLS: [memorySave, memorySearch, toolsMore],
    activeTools: async () => [memorySave, memorySearch],
    execute: async () => ({ ok: true, result: {} }),
    stringifyResult: (r) => JSON.stringify(r),
  },
  './claudecode': {
    runTurn: async (opts) => {
      const p = await opts.buildPrompt();
      seen.push({ brain: 'claude-code', configKey: opts.configKey === 'first-run-setup' ? 'setup' : 'persona', stable: p.stable, context: await opts.buildContext(['m1']), contextNoIds: await opts.buildContext(undefined) });
      return { text: 'ok', toolCalls: [] };
    },
    needsRollover: () => false,
    epochOf: () => 0,
    cachedConnectors: async () => null,
  },
  './codebase': { root: async () => '/app' },
  './obsidian': { vaultPath: async () => null },
  './github': {},
  './documents': { userFolders: () => [] },
  './approvals': { newTurn: () => ({ approved: new Set(), taintSources: [] }), markTainted() {} },
});
const llm = load('main/llm.js');

const settings = (provider, extra = {}) => ({
  agent: { name: 'Siren', personality: 'p', aesthetic: '' },
  appearance: { personaNotes: '' },
  voice: { ttsEnabled: false, autoSpeak: false },
  safety: { permissionMode: 'auto' },
  code: { enabled: false, allowSelfModify: false },
  web: { enabled: true },
  github: { enabled: false },
  llm: { provider, baseUrl: 'https://api.example.com/v1', model: 'm', useTools: true, autoPace: true, modelMode: 'default', compactPrompt: 'auto', maxToolRounds: 8, historyLimit: 30, ...extra },
  claudeCode: { model: 'default', effort: 'default' },
  anthropic: { apiKey: 'k', model: 'claude-x', effort: 'default' },
});
const typed = 'what does the file say about exams?';
const withFile = attachcore.compose({ prompt: typed, typed, items: [{ kind: 'text', name: 'notes.txt', size: 20, text: 'Exam on Friday.', chars: 15, path: 'C:/att/notes.txt' }], notice: 'NOTICE' }).content;
const history = [
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi', persona: 'Vega' },
  { role: 'user', content: withFile, attachments: [{ kind: 'text', name: 'notes.txt' }] },
];

const CASES = {
  full: { s: settings('openai') },
  compactLocal: { s: settings('openai', { baseUrl: 'http://localhost:11434/v1' }) },
  compactOnCloud: { s: settings('openai', { compactPrompt: 'on' }) },
  setupOpenai: { s: settings('openai'), setup: true },
  anthropic: { s: settings('anthropic') },
  anthropicSetup: { s: settings('anthropic'), setup: true },
  claudeCode: { s: settings('claude-code') },
  claudeCodeSetup: { s: settings('claude-code'), setup: true },
};
async function capture(name, { voice = true, again = { note: 'Answer it again.' } } = {}) {
  const { s, setup = false } = CASES[name];
  seen.length = 0;
  const conv = { id: 'c1', setup, messages: history };
  await llm.runTurn({ settings: s, conv, history, emit: () => {}, signal: new AbortController().signal, images: [], voice, again }).catch((err) => {
    if (err.message !== 'captured') throw err;
  });
  assert.strictEqual(seen.length, 1, `${name}: one brain was asked`);
  const { brain, ...got } = seen[0];
  return { brain, got };
}

// Captured from llm.js runOn and claudesession.js before turnprompt.js (2.7.29 + the turn guard).
const GOLDEN = require('./fixtures/turnprompt-golden.json');

test('every brain gets the same prompt as before the module, byte for byte', async () => {
  const out = {};
  for (const name of Object.keys(CASES)) {
    out[name] = await capture(name);
    out[`${name}Typed`] = await capture(name, { voice: false, again: null });
  }
  if (process.env.TURNPROMPT_GOLDEN_WRITE) require('fs').writeFileSync(require('path').join(__dirname, 'fixtures', 'turnprompt-golden.json'), `${JSON.stringify(out, null, 1)}\n`);
  assert.deepStrictEqual(out, GOLDEN);
});

// ---- the module itself
const turnprompt = load('main/turnprompt.js');

test('the turn facts: the user’s own words without the attached text, who wrote the last reply, spoken, again', () => {
  const f = turnprompt.facts({ conv: { id: 'c1', messages: history }, history, voice: true, again: { note: 'N', taint: true }, routine: false });
  assert.strictEqual(f.query, typed, 'withoutBlocks: the attachment’s text is not the query');
  assert.ok(f.attached > 0, 'the attached characters are counted');
  assert.strictEqual(f.attachments, 1);
  assert.strictEqual(f.previousPersona, 'Vega');
  assert.strictEqual(f.spoken, true);
  assert.strictEqual(f.again, 'N');
  assert.strictEqual(f.setup, false);
  assert.strictEqual(f.routine, false);
  const plain = turnprompt.facts({ conv: { setup: true }, history: [{ role: 'user', content: 'hi' }] });
  assert.deepStrictEqual([plain.query, plain.previousPersona, plain.spoken, plain.again, plain.setup, plain.attachments], ['hi', '', false, '', true, 0]);
  assert.strictEqual(turnprompt.facts({ conv: {}, history: [] }).query, '', 'an empty history');
});

test('which prompt each brain gets', () => {
  const f = (setup = false) => turnprompt.facts({ conv: { setup }, history: [{ role: 'user', content: 'hi' }] });
  assert.strictEqual(turnprompt.kind(settings('claude-code'), f()), 'claude-session');
  assert.strictEqual(turnprompt.kind(settings('claude-code'), f(true)), 'claude-session', 'setup keeps the session runner (its own prompt inside)');
  assert.strictEqual(turnprompt.kind(settings('openai', { baseUrl: 'http://localhost:11434/v1' }), f()), 'compact');
  assert.strictEqual(turnprompt.kind(settings('openai', { baseUrl: 'http://localhost:11434/v1' }), f(true)), 'setup', 'setup never gets the compact prompt');
  assert.strictEqual(turnprompt.kind(settings('openai'), f()), 'full');
  assert.strictEqual(turnprompt.kind(settings('anthropic'), f()), 'full');
  assert.strictEqual(turnprompt.kind(settings('anthropic'), f(true)), 'setup');
});

test('spoken, again and the previous persona reach the builders (full, compact, session context)', async () => {
  const facts = turnprompt.facts({ conv: {}, history, voice: true, again: { note: 'N' } });
  const want = { query: typed, previousPersona: 'Vega', spoken: true, again: 'N' };
  const full = await turnprompt.forBrain(settings('openai'), facts, 'full', { tools: ['a'] });
  assert.strictEqual(full.system, echo('build', settings('openai'), ['a'], want));
  const compact = await turnprompt.forBrain(settings('openai'), facts, 'compact', { tools: ['b'] });
  assert.strictEqual(compact.system, echo('compact', settings('openai'), ['b'], want));
  const session = await turnprompt.forBrain(settings('claude-code'), facts, 'claude-session', { tools: ['c'] });
  assert.strictEqual(await session.buildContext(['m']), `turnContext|Siren|${JSON.stringify([['c'], ['m'], want])}`);
  assert.strictEqual((await session.buildPrompt()).stable, echo('build.stable', settings('claude-code'), ['c'], { forSession: true }));
});

test('a session started without a turn (warming, identity) gets the persona’s prompt, not setup’s', async () => {
  const session = await turnprompt.forBrain(settings('claude-code'), null, 'claude-session', { tools: [] });
  assert.match((await session.buildPrompt()).stable, /^build\.stable\|Siren\|/);
  const setup = await turnprompt.forBrain(settings('claude-code'), turnprompt.facts({ conv: { setup: true }, history: [] }), 'claude-session', { tools: [] });
  assert.strictEqual((await setup.buildPrompt()).stable, 'setup.stable|Siren');
  assert.strictEqual(await setup.buildContext([]), 'setup.context|Stored', 'setup’s context reads the settings the interview just changed');
});
