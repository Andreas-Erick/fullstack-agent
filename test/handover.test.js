// Handing a message from a local brain to Claude (main/llm.js runSingle, localcore.handOverHint and
// isReadTool, the tool hand_over in main/tools/toolbox.js): only when the user turned it on and a
// Claude brain is ready; obvious cases go straight there; the local model's own text is taken back;
// never after the local turn changed something.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const core = load('main/localcore.js');

test('which tools only look things up', () => {
  for (const n of ['calendar_get_events', 'memory_search', 'vault_read_note', 'habit_status', 'flashcards_decks', 'flashcards_next', 'tools_more', 'web_search', 'app_guide', 'learning_overview', 'history_search']) assert.ok(core.isReadTool(n), n);
  for (const n of ['calendar_add_event', 'memory_save', 'habit_log', 'vault_write_note', 'flashcards_add', 'flashcards_answer', 'priorities_update', 'daily_note_log', 'routine_save', 'brain_switch']) assert.ok(!core.isReadTool(n), n);
});

test('what goes straight to Claude: code, a connected service by name, a long text', () => {
  const services = ['TickTick', 'Google Calendar', 'Plaud'];
  assert.strictEqual(core.handOverHint('what is on my ticktick today?', { services }), 'it needs TickTick');
  assert.strictEqual(core.handOverHint('add it to my google calendar', { services }), 'it needs Google Calendar');
  assert.strictEqual(core.handOverHint('fix this', { engineering: true }), 'code work');
  assert.strictEqual(core.handOverHint('x'.repeat(4001)), 'a long text');
  assert.strictEqual(core.handOverHint('what is on my calendar tomorrow?', { services }), '', 'its own calendar is the local brain’s');
  assert.strictEqual(core.handOverHint('I like plaudits', { services }), '', 'whole words only');
});

// ---- the real path, with a fake local server (fetch) and a fake Claude
const calls = { claude: 0, local: 0 };
let localReplies = [];
const sse = (chunks) => {
  const body = chunks.map((c) => `data: ${JSON.stringify({ model: 'qwen3:8b', choices: [{ delta: c, finish_reason: null }] })}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
global.fetch = async (url, init) => {
  calls.local++;
  const payload = JSON.parse(init.body);
  calls.lastTools = (payload.tools || []).map((t) => t.function.name);
  calls.lastMessages = payload.messages;
  return sse(localReplies.shift() || [{ content: 'ok' }]);
};
const toolbox = require('../main/tools/toolbox');
const memorySave = { name: 'memory_save', group: 'memory', description: 'save', parameters: { type: 'object', properties: {} }, run: async () => ({ saved: true }) };
const memorySearch = { name: 'memory_search', group: 'memory', description: 'search', parameters: { type: 'object', properties: {} }, run: async () => ({ results: [{ text: 'Project Atlas is due on 20 November' }] }) };
let claudeReady = true;
stub({
  './logger': quietLog,
  './tools': {
    TOOLS: [...toolbox, memorySave, memorySearch],
    activeTools: async () => [memorySave, memorySearch],
    execute: async (name, args, ctx) => ({ ok: true, result: await [...toolbox, memorySave, memorySearch].find((t) => t.name === name).run(args, ctx) }),
    stringifyResult: (r) => JSON.stringify(r),
  },
  './prompt': { buildCompact: async () => ({ system: 'rules', stable: 'rules', context: 'now', reminder: 'r' }), build: async () => ({ system: 's', stable: 's', context: 'c' }) },
  './claudecode': { runTurn: async () => (calls.claude++, { text: 'From Claude', toolCalls: [] }), cachedConnectors: async () => ({ list: [{ name: 'claude.ai TickTick', source: 'connector' }] }) },
  './codebase': { root: async () => '/app' },
  './obsidian': { vaultPath: async () => null },
  './github': {},
  './documents': { userFolders: () => [] },
  './approvals': { newTurn: () => ({ approved: new Set(), taintSources: [] }), markTainted() {} },
  './router': {
    PROVIDERS: { 'claude-code': { name: 'Claude (account)' }, anthropic: { name: 'Claude (API key)' }, local: { openai: true } },
    status: async () => [{ id: 'claude-code', configured: claudeReady, resting: null }],
    concrete: (s, id) => ({ ...s, llm: { ...s.llm, provider: id, via: id } }),
    label: (id) => ({ 'claude-code': 'Claude (account)' })[id] || id,
  },
});
const llm = load('main/llm.js');

const settings = (handOver = true) => ({
  agent: { name: 'Siren', personality: 'p', aesthetic: '' },
  appearance: { personaNotes: '' },
  voice: { ttsEnabled: false, autoSpeak: false },
  safety: { permissionMode: 'auto' },
  code: { enabled: false, allowSelfModify: false },
  web: { enabled: true },
  github: { enabled: false },
  llm: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', useTools: true, autoPace: true, modelMode: 'default', compactPrompt: 'auto', maxToolRounds: 8, historyLimit: 30, handOver },
  claudeCode: { model: 'default', effort: 'default', connectors: true },
  anthropic: {},
});
async function turn(text, s = settings(), { routine = false } = {}) {
  const events = [];
  const conv = { id: 'c1', messages: [{ role: 'user', content: text }] };
  const r = await llm.runTurn({ settings: s, conv, history: conv.messages, emit: (e) => events.push(e), signal: new AbortController().signal, images: [], routine });
  return { r, events };
}
const reset = () => Object.assign(calls, { claude: 0, local: 0, lastTools: [] });
const callTool = (name, args) => [{ content: 'Let me see… ' }, { tool_calls: [{ index: 0, id: 't1', function: { name, arguments: JSON.stringify(args) } }] }];

test('the local model hands a hard message over: its text is taken back, Claude answers', async () => {
  reset();
  localReplies = [callTool('hand_over', { reason: 'several steps' })];
  const { r, events } = await turn('plan my whole week around my exams');
  assert.ok(calls.lastTools.includes('hand_over'), 'offered to the local model');
  assert.strictEqual(calls.claude, 1);
  assert.strictEqual(r.text, 'From Claude');
  assert.strictEqual(r.provider, 'claude-code');
  assert.deepStrictEqual(events.find((e) => e.type === 'retract'), { type: 'retract', chars: 'Let me see… '.length });
  assert.match(events.find((e) => e.type === 'notice').message, /Handed to Claude \(account\): several steps/);
  assert.strictEqual(calls.local, 1, 'nothing more from the local model after the hand-over');
});

test('a connected service by name goes straight to Claude, without asking the local model', async () => {
  reset();
  const { r } = await turn('what is on my ticktick today?');
  assert.strictEqual(calls.local, 0);
  assert.strictEqual(r.text, 'From Claude');
});

test('never after the local turn changed something', async () => {
  reset();
  localReplies = [callTool('memory_save', {}), callTool('hand_over', { reason: 'hard' }), [{ content: 'Saved it.' }]];
  const { r } = await turn('remember this and then plan my week');
  assert.strictEqual(calls.claude, 0, 'the save would run twice');
  assert.strictEqual(r.provider, 'openai');
  assert.match(r.text, /Saved it\./);
});

test('off unless the user turned it on, and only with a Claude brain ready', async () => {
  reset();
  localReplies = [[{ content: 'Local answer' }]];
  let t = await turn('what is on my ticktick today?', settings(false));
  assert.strictEqual(calls.claude, 0);
  assert.ok(!calls.lastTools.includes('hand_over'), 'not offered when off');
  assert.strictEqual(t.r.text, 'Local answer');

  reset();
  claudeReady = false;
  localReplies = [[{ content: 'Local answer' }]];
  t = await turn('what is on my ticktick today?');
  claudeReady = true;
  assert.strictEqual(calls.claude, 0, 'no Claude brain ready');
  assert.ok(!calls.lastTools.includes('hand_over'));
});

test('a reply that gives up without looking is taken back once, and the model looks first', async () => {
  reset();
  const gaveUp = 'I don’t have that information. Would you like me to check your notes?';
  localReplies = [[{ content: gaveUp }], callTool('memory_search', { query: 'Project Atlas' }), [{ content: 'It’s due on 20 November.' }]];
  const { r, events } = await turn('When is the Project Atlas deadline?', settings(false));
  assert.deepStrictEqual(events.find((e) => e.type === 'retract'), { type: 'retract', chars: gaveUp.length });
  assert.strictEqual(r.text.includes('don’t have'), false, 'the given-up reply is not kept');
  assert.match(r.text, /20 November/);
  assert.ok(r.toolCalls.some((c) => c.name === 'memory_search'));
  assert.ok(!JSON.stringify(r.raw.messages).includes('look it up now'), 'the ask to look is not stored');
  // Only once: a second "I don't know" after looking stands.
  reset();
  localReplies = [[{ content: gaveUp }], [{ content: 'I don’t know, sorry.' }]];
  const t = await turn('Who is my dentist?', settings(false));
  assert.strictEqual(calls.local, 2);
  assert.match(t.r.text, /I don’t know, sorry\./);
});

test('what counts as giving up', () => {
  for (const s of ['I don’t have that information.', "I don't know when that is.", 'I have no information about Project Atlas.', 'I’m not sure when your deadline is.']) assert.ok(core.gaveUpUnlooked(s), s);
  for (const s of ['The deadline is 20 November.', 'Canberra.', `I don't know ${'x'.repeat(400)}`]) assert.ok(!core.gaveUpUnlooked(s), s.slice(0, 30));
});

test('a routine for a connected service runs on Claude even with the hand-over off; nothing else does', async () => {
  reset();
  let t = await turn('⏰ Routine "Sync TickTick": fetch my tasks and save them', settings(false), { routine: true });
  assert.strictEqual(calls.local, 0, 'the local brain has no connectors');
  assert.strictEqual(calls.claude, 1);
  assert.strictEqual(t.r.provider, 'claude-code');
  assert.match(t.events.find((e) => e.type === 'notice').message, /the routine needs TickTick/);

  reset();
  localReplies = [[{ content: 'Done locally.' }]];
  t = await turn('⏰ Routine "Evening review": fix the errors in today’s note', settings(false), { routine: true });
  assert.strictEqual(calls.claude, 0, 'no service named: stays on this computer');
  assert.ok(!calls.lastTools.includes('hand_over'), 'and the local model is not offered the hand-over');
  assert.strictEqual(t.r.text, 'Done locally.');

  reset();
  localReplies = [[{ content: 'Done locally.' }]];
  t = await turn('⏰ Routine "Evening review": fix the errors in today’s note', settings(true), { routine: true });
  assert.strictEqual(calls.claude, 0, 'a routine’s own words are not code work');
});
