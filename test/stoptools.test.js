// Stop on the API and local brains (main/llm.js runOpenAI, runAnthropic): no tool of the round starts
// after Stop (the rest wait on it no longer, approvals included), and every call still gets an answer, so
// the stored conversation stays one a provider accepts. Fake model servers; no network.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

let controller = new AbortController();
const executed = [];
const anthropicCalls = [];
let openaiCalls = 0;

const tool = (name) => ({ name, group: 'memory', description: name, parameters: { type: 'object', properties: {}, required: [] }, run: async () => ({}) });
const TWO = [tool('first_tool'), tool('second_tool')];

// The model asks for both tools in one message; the first one's run is where the user presses Stop.
global.fetch = async () => {
  openaiCalls++;
  const calls = { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'first_tool', arguments: '{}' } }, { index: 1, id: 'call_b', function: { name: 'second_tool', arguments: '{}' } }] };
  const chunks = openaiCalls === 1 ? [{ content: 'Working on it. ' }, calls] : [{ content: 'Done.' }];
  const body = chunks.map((c) => `data: ${JSON.stringify({ model: 'test-model', choices: [{ delta: c, finish_reason: null }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
class FakeAnthropic {
  constructor() {
    this.beta = {
      messages: {
        stream: (params) => {
          anthropicCalls.push(params);
          const content = anthropicCalls.length === 1 ? [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: 'tu_a', name: 'first_tool', input: {} }, { type: 'tool_use', id: 'tu_b', name: 'second_tool', input: {} }] : [{ type: 'text', text: 'Done.' }];
          return { on() {}, finalMessage: async () => ({ content, stop_reason: anthropicCalls.length === 1 ? 'tool_use' : 'end_turn', model: 'claude-test' }) };
        },
      },
    };
  }
}
FakeAnthropic.APIError = class extends Error {};

stub({
  './logger': quietLog,
  '@anthropic-ai/sdk': FakeAnthropic,
  './tools': {
    TOOLS: TWO,
    activeTools: async () => TWO,
    execute: async (name) => {
      executed.push(name);
      if (name === 'first_tool') controller.abort(); // Stop while the first tool runs
      return { ok: true, result: { did: name } };
    },
    stringifyResult: (r) => JSON.stringify(r),
  },
  './prompt': { build: async () => ({ system: 's', stable: 's', context: 'c' }), buildCompact: async () => ({ system: 's', stable: 's', context: 'c', reminder: 'r' }) },
  './claudecode': { runTurn: async () => ({ text: '', toolCalls: [] }), needsRollover: () => false, prewarm: async () => {}, epochOf: () => 0, warmCache: async () => {}, cachedConnectors: async () => null },
  './codebase': { root: async () => '/app' },
  './obsidian': { vaultPath: async () => null },
  './github': {},
  './documents': { userFolders: () => [] },
  './approvals': { newTurn: () => ({ approved: new Set(), taintSources: [] }), markTainted() {} },
  './router': { PROVIDERS: {}, status: async () => [], concrete: (s) => s, label: (id) => id },
});
const llm = load('main/llm.js');

const settings = (provider) => ({
  agent: { name: 'Siren', personality: 'p', aesthetic: '' },
  appearance: { personaNotes: '' },
  voice: { ttsEnabled: false, autoSpeak: false },
  safety: { permissionMode: 'auto' },
  code: { enabled: false, allowSelfModify: false },
  web: { enabled: false },
  github: { enabled: false },
  llm: { provider, baseUrl: 'https://api.example.test/v1', apiKey: 'k', model: 'test-model', useTools: true, autoPace: true, modelMode: 'default', compactPrompt: 'off', maxToolRounds: 8, historyLimit: 30 },
  claudeCode: { model: 'default', effort: 'default' },
  anthropic: { apiKey: 'k', model: 'claude-test', effort: 'default' },
});

async function turn(provider) {
  controller = new AbortController();
  executed.length = 0;
  const events = [];
  const conv = { id: `stop-${provider}`, messages: [{ role: 'user', content: 'do both things' }] };
  const r = await llm.runTurn({ settings: settings(provider), conv, history: conv.messages, emit: (e) => events.push(e), signal: controller.signal, images: [] });
  return { r, events };
}

test('OpenAI path: after Stop the rest of the round never runs, and every call is answered', async () => {
  const { r, events } = await turn('openai');
  assert.deepStrictEqual(executed, ['first_tool'], 'the second tool never ran');
  assert.deepStrictEqual(events.filter((e) => e.type === 'tool_start').map((e) => e.name), ['first_tool']);
  assert.strictEqual(openaiCalls, 1, 'no further round after Stop');
  const msgs = r.raw.messages;
  const asked = msgs.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((c) => c.id));
  const answered = msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepStrictEqual(asked, ['call_a', 'call_b']);
  assert.deepStrictEqual(answered, asked, 'every tool call has its answer');
  const skipped = msgs.find((m) => m.tool_call_id === 'call_b');
  assert.deepStrictEqual(JSON.parse(skipped.content), { error: 'Stopped by the user before this ran.' });
  assert.deepStrictEqual(r.toolCalls.map((c) => c.name), ['first_tool'], 'a skipped call is not recorded as run');
});

test('Claude API path: after Stop the rest of the round never runs, and the stored reply ends on a complete turn', async () => {
  const { r } = await turn('anthropic');
  assert.deepStrictEqual(executed, ['first_tool']);
  assert.strictEqual(anthropicCalls.length, 1, 'no further round after Stop');
  assert.deepStrictEqual(r.toolCalls.map((c) => c.name), ['first_tool']);
  // The only round was the stopped one: its tool calls and results are dropped whole (llm.js `dangling`),
  // so nothing stored ends on a tool call without its result.
  assert.strictEqual(r.raw, null);
});

test('a turn that is not stopped runs both tools', async () => {
  openaiCalls = 0;
  executed.length = 0;
  controller = new AbortController(); // what the first tool "stops": not this turn's
  const conv = { id: 'stop-none', messages: [{ role: 'user', content: 'do both things' }] };
  await llm.runTurn({ settings: settings('openai'), conv, history: conv.messages, emit() {}, signal: new AbortController().signal, images: [] });
  assert.deepStrictEqual(executed, ['first_tool', 'second_tool']);
  assert.strictEqual(openaiCalls, 2, 'the model answers after the tools');
});
