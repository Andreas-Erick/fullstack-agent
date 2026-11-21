// A local brain's turn (main/localturn.js): where a brain is local, the hand-over plan, the compact
// toolset, the nudges, the question refusal and the request quirks with their retries. First through the
// module's interface, then a whole turn through llm.runTurn against a fake OpenAI-compatible server
// (scripted replies: gave up then looked, claimed then admitted, wrote then hand-over refused, a 400 for
// the local extras retried without them).
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const core = load('main/localcore.js');
const PROVIDERS = { 'claude-code': { name: 'Claude (account)' }, anthropic: { name: 'Claude (API key)' }, local: { openai: true }, groq: { openai: true } };
const router = {
  PROVIDERS,
  ready: [{ id: 'claude-code', configured: true, resting: null }],
  statusCalls: 0,
  status: async () => (router.statusCalls++, router.ready),
  // As the real one: a provider on the OpenAI path runs as 'openai', the rest as themselves.
  concrete: (s, id) => ({ ...s, llm: { ...s.llm, provider: PROVIDERS[id]?.openai ? 'openai' : id, via: id, ...(id === 'local' ? { baseUrl: 'http://localhost:11434/v1', model: s.local?.model } : {}), ...(id === 'groq' ? { baseUrl: 'https://api.groq.com/openai/v1' } : {}) } }),
  label: (id) => ({ 'claude-code': 'Claude (account)' })[id] || id,
};
stub({ './logger': quietLog, './router': router });
const localturn = load('main/localturn.js');

const llmOf = (llm) => ({ llm: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', ...llm } });

// ------------------------------------------------------------------ where a brain is local

test('one answer to "is this brain local": the OpenAI path at a local address, or the router’s local', () => {
  assert.strictEqual(localturn.isLocalBrain(llmOf({})), true);
  assert.strictEqual(localturn.isLocalBrain(llmOf({ baseUrl: 'https://x', via: 'local' })), true, 'the multi-provider local brain');
  assert.strictEqual(localturn.isLocalBrain(llmOf({ baseUrl: 'https://api.groq.com/openai/v1' })), false);
  assert.strictEqual(localturn.isLocalBrain(llmOf({ provider: 'claude-code' })), false, 'a Claude brain with an old local address is not local');
  assert.strictEqual(localturn.isLocalBrain(llmOf({ provider: 'anthropic' })), false);
});

test('the local brain of the settings (the summary writer’s): the router’s local, the chosen local brain, else none', () => {
  assert.strictEqual(localturn.localBrainOf({ ...llmOf({ provider: 'auto' }), local: { model: 'qwen3:4b' } }).llm.via, 'local');
  assert.strictEqual(localturn.localBrainOf({ ...llmOf({ provider: 'auto' }), local: {} }), null, 'multi-provider without a local model');
  assert.strictEqual(localturn.localBrainOf({ ...llmOf({ provider: 'local' }), local: { model: 'qwen3:4b' } }).llm.provider, 'openai');
  assert.strictEqual(localturn.localBrainOf(llmOf({})).llm.model, 'qwen3:8b');
  assert.strictEqual(localturn.localBrainOf(llmOf({ provider: 'claude-code' })), null);
  assert.strictEqual(localturn.localBrainOf(llmOf({ provider: 'groq' })), null, 'a cloud provider on the OpenAI path');
});

test('the compact prompt: only on the OpenAI path, by llm.compactPrompt', () => {
  assert.strictEqual(localturn.wantsCompact(llmOf({})), true);
  assert.strictEqual(localturn.wantsCompact(llmOf({ compactPrompt: 'off' })), false);
  assert.strictEqual(localturn.wantsCompact(llmOf({ provider: 'claude-code', compactPrompt: 'on' })), false);
  assert.strictEqual(localturn.wantsCompact(llmOf({ baseUrl: 'https://x', compactPrompt: 'on' })), true, 'asked for on a cloud server');
});

// ------------------------------------------------------------------ the hand-over plan

test('hand-over plan: straight away for the obvious, offered otherwise; a routine only for a named service', async () => {
  const s = (handOver) => ({ llm: { ...llmOf({}).llm, handOver } });
  const services = async () => ['TickTick'];
  assert.deepStrictEqual(await localturn.handOverPlan(s(true), s(true), { text: 'what is on my ticktick?', services }), { to: 'claude-code', now: 'it needs TickTick', offer: true });
  assert.deepStrictEqual(await localturn.handOverPlan(s(true), s(true), { text: 'plan my week', services }), { to: 'claude-code', now: '', offer: true });
  assert.strictEqual((await localturn.handOverPlan(s(true), s(true), { text: 'fix the bug in main.js', services })).now, 'code work');
  assert.strictEqual((await localturn.handOverPlan(s(true), s(true), { text: 'fix the bug in main.js', routine: true, services })).now, '', 'a routine’s words are not code work');
  assert.strictEqual((await localturn.handOverPlan(s(true), s(true), { text: 'what is this?', images: 1, services })).now, 'an image');
  assert.deepStrictEqual(await localturn.handOverPlan(s(false), s(false), { text: 'what is on my ticktick?', services }), { to: null, now: '', offer: false }, 'off');
  assert.deepStrictEqual(await localturn.handOverPlan(s(false), s(false), { text: 'Sync TickTick', routine: true, services }), { to: 'claude-code', now: 'the routine needs TickTick', offer: false });
  assert.deepStrictEqual(await localturn.handOverPlan(s(false), s(false), { text: 'Evening review', routine: true, services }), { to: 'claude-code', now: '', offer: false }, 'a routine is never offered the tool');
  assert.strictEqual((await localturn.handOverPlan(s(true), s(true), { setup: true, text: 'what is on my ticktick?', services })).to, null, 'never in setup');
  router.ready = [{ id: 'claude-code', configured: false, resting: null }, { id: 'anthropic', configured: true, resting: 'rate limit' }];
  assert.strictEqual((await localturn.handOverPlan(s(true), s(true), { text: 'plan my week', services })).to, null, 'no Claude brain ready');
  router.ready = [{ id: 'claude-code', configured: true, resting: null }];
  // A Claude brain never asks the router (the sign-in check starts the CLI).
  router.statusCalls = 0;
  const claude = { llm: { ...s(true).llm, provider: 'claude-code' } };
  assert.strictEqual(await localturn.handOverTarget(claude, claude, { routine: true }), null);
  assert.strictEqual(router.statusCalls, 0);
});

// ------------------------------------------------------------------ the compact turn

const tool = (name, group) => ({ name, group, description: name, parameters: { type: 'object', properties: {} } });
const ACTIVE = [tool('memory_save', 'memory'), tool('memory_search', 'memory'), tool('calendar_get_events', 'calendar'), tool('vocab_add', 'learning'), tool('vocab_review', 'learning'), tool('routine_save', 'routines')];
const CATALOG = [tool('tools_more', 'toolbox'), tool('hand_over', 'toolbox')];
const names = (list) => list.map((t) => t.name);
const turnOf = (opts = {}) => localturn.begin({ settings: llmOf({}), conv: {}, active: ACTIVE, catalog: CATALOG, ...opts });

test('the compact toolset: everyday tools, groups from before and from the message, more on request', () => {
  const t = turnOf({ lastText: 'hello' });
  assert.deepStrictEqual(names(t.tools), ['memory_save', 'memory_search', 'calendar_get_events', 'tools_more'], 'no hand_over without a Claude brain');
  assert.deepStrictEqual(t.loadGroup('learning'), { added: ['vocab_add', 'vocab_review'] });
  assert.deepStrictEqual(t.loadGroup('learning'), { note: 'No new tools: the learning tools are already loaded, or turned off in Settings.' });
  assert.deepStrictEqual(t.loadGroup('nope').note.startsWith('No new tools'), true);
  assert.deepStrictEqual(t.promptTools, ['memory_save', 'memory_search', 'calendar_get_events', 'tools_more'], 'the prompt names only the everyday tools, so it stays the same');
  assert.deepStrictEqual(t.finish({ text: 'x' }).convPatch, { toolGroups: ['learning'] }, 'kept for the conversation');
  // Loaded before, and obvious from the message ("every morning" → routines), with hand_over offered.
  const u = turnOf({ conv: { toolGroups: ['learning'] }, lastText: 'remind me every morning', handOverTo: 'claude-code' });
  assert.deepStrictEqual(u.groups, ['learning', 'routines']);
  assert.ok(names(u.tools).includes('routine_save') && names(u.tools).includes('hand_over'));
  assert.deepStrictEqual(turnOf({ conv: { toolGroups: ['learning'] }, lastText: 'hi' }).finish({}).convPatch, undefined, 'nothing new: nothing to keep');
});

test('the prompt: a local server gets the notes before the newest message; a cloud server the whole prompt', () => {
  const built = { system: 'all', stable: 'rules', context: 'now', reminder: 'remember' };
  assert.deepStrictEqual(turnOf().prompt(built), { system: 'rules\n\nremember', turnNote: 'now' });
  assert.deepStrictEqual(turnOf({ settings: llmOf({ baseUrl: 'https://x', compactPrompt: 'on' }) }).prompt(built), { system: 'all', turnNote: '' });
});

test('hand_over: refused once the turn changed something; a read or the hand-over itself is not a change', () => {
  assert.deepStrictEqual(turnOf().requestHandOver('hard'), { note: 'No stronger brain is set up: answer yourself.' });
  const t = turnOf({ handOverTo: 'claude-code' });
  t.afterTool({ name: 'memory_search', ok: true });
  t.afterTool({ name: 'memory_save', ok: false });
  assert.strictEqual(t.requestHandOver('x'.repeat(200)).handedOver, true, 'a read and a failed write change nothing');
  assert.strictEqual(t.handedOver, 'x'.repeat(120));
  assert.strictEqual(t.finish({}).handOver, 'x'.repeat(120));
  const w = turnOf({ handOverTo: 'claude-code' });
  w.afterTool({ name: 'memory_save', ok: true });
  assert.deepStrictEqual(w.requestHandOver('hard'), { note: 'You already changed something in this turn, so finish it yourself.' });
  assert.strictEqual(w.handedOver, '');
});

test('the nudges: gave up unlooked (first round only), claimed an action no tool did; each once', () => {
  const opts = { round: 0, rounds: 8, useTools: true };
  const reply = (text) => ({ text, calls: [] });
  const t = turnOf();
  const look = t.afterReply(reply('I don’t have that information.'), opts);
  assert.deepStrictEqual(look, [{ role: 'assistant', content: 'I don’t have that information.' }, { role: 'system', content: core.LOOK_FIRST }]);
  assert.strictEqual(t.afterReply(reply('I don’t have that information.'), opts), null, 'once');
  const claim = t.afterReply(reply('I’ve added it to your calendar.'), { ...opts, round: 1, noteRole: 'user' });
  assert.deepStrictEqual(claim, [{ role: 'assistant', content: 'I’ve added it to your calendar.' }, { role: 'user', content: core.CLAIM_CHECK }], 'the role the notes have');
  assert.strictEqual(t.afterReply(reply('I’ve added it to your calendar.'), { ...opts, round: 2 }), null, 'once');
  // Not on a later round (look), the last round (claim), without tools, with tool calls, or after a change.
  assert.strictEqual(turnOf().afterReply(reply('I don’t know.'), { ...opts, round: 1 }), null);
  assert.strictEqual(turnOf().afterReply(reply('Done, logged.'), { ...opts, round: 8 }), null);
  assert.strictEqual(turnOf().afterReply(reply('I don’t know.'), { ...opts, useTools: false }), null);
  assert.strictEqual(turnOf().afterReply({ text: 'I don’t know.', calls: [{ name: 'memory_search' }] }, opts), null);
  assert.strictEqual(turnOf({ active: ACTIVE.filter((x) => x.name !== 'memory_search') }).afterReply(reply('I don’t know.'), opts), null, 'nothing to look with');
  const saved = turnOf();
  saved.afterTool({ name: 'memory_save', ok: true });
  assert.strictEqual(saved.afterReply(reply('I’ve saved it.'), { ...opts, round: 1 }), null, 'a real save: the claim stands');
  // The hand-over's own call counts as a change for the claim check (it was never a read).
  const handed = turnOf({ handOverTo: 'claude-code' });
  handed.afterTool({ name: 'hand_over', ok: true });
  assert.strictEqual(handed.afterReply(reply('I’ve saved it.'), { ...opts, round: 1 }), null);
});

test('a question changes nothing: its write tools are refused, reads and the hand-over run', () => {
  const q = turnOf({ lastText: 'Can I fit a gym session in on Sunday?' });
  assert.strictEqual(q.beforeTool('calendar_add_event'), core.NOT_FOR_A_QUESTION);
  assert.strictEqual(q.beforeTool('calendar_get_events'), null);
  assert.strictEqual(q.beforeTool('hand_over'), null);
  assert.strictEqual(turnOf({ lastText: 'Can you add a gym session on Sunday?' }).beforeTool('calendar_add_event'), null, 'a request');
});

// ------------------------------------------------------------------ request quirks

let server = 0;
const quirksOf = (opts = {}) => localturn.requestQuirks({ settings: llmOf({}), base: `http://localhost:${++server}/v1`, model: 'm', tools: true, ...opts });
const status = (n) => Object.assign(new Error(`LLM error ${n}`), { status: n });

test('request quirks: which retry a refusal gets, in order, each remembered for the server', () => {
  const extras = { keep_alive: '30m', reasoning_effort: 'none' };
  // Images first (round 0 only), then the notes as a system message, the extras, the tools.
  let q = quirksOf({ note: 'now' });
  assert.strictEqual(q.retry(status(400), { round: 0, payload: { ...extras, tools: [] }, imaged: true }), 'images');
  assert.strictEqual(q.retry(status(400), { round: 0, payload: { ...extras, tools: [] } }), 'note');
  assert.strictEqual(q.noteAsSystem, false);
  assert.strictEqual(q.noteRole, 'user');
  assert.strictEqual(q.retry(status(400), { round: 0, payload: { ...extras, tools: [] } }), 'extras');
  assert.deepStrictEqual(q.extras('quick'), {});
  assert.strictEqual(q.retry(status(400), { round: 0, payload: { tools: [] } }), 'tools');
  assert.strictEqual(q.useTools, false);
  assert.strictEqual(q.retry(status(400), { round: 0, payload: {} }), null, 'nothing left to drop: the error stands');
  // Extras on any round; the others only on the first.
  q = quirksOf({ note: 'now' });
  assert.strictEqual(q.retry(status(400), { round: 2, payload: { ...extras, tools: [] }, imaged: true }), 'extras');
  assert.strictEqual(q.retry(status(500), { round: 2, payload: { tools: [] } }), null);
  // Statuses: 401 is never a quirk; 500 drops the notes or the tools, never the extras.
  q = quirksOf();
  assert.strictEqual(q.retry(status(401), { round: 0, payload: { ...extras, tools: [] } }), null);
  assert.strictEqual(q.retry(status(500), { round: 0, payload: { ...extras } }), null);
  assert.strictEqual(q.retry(status(500), { round: 0, payload: { ...extras, tools: [] } }), 'tools');
  // Remembered: the next request to that server starts without what it refused.
  const base = `http://localhost:${++server}/v1`;
  const first = localturn.requestQuirks({ settings: llmOf({}), base, model: 'm', tools: true, note: 'now' });
  assert.deepStrictEqual(first.extras('quick'), extras);
  first.retry(status(400), { round: 0, payload: {} }); // the notes
  first.retry(status(400), { round: 0, payload: extras });
  first.retry(status(400), { round: 0, payload: { tools: [] } });
  const next = localturn.requestQuirks({ settings: llmOf({}), base, model: 'm', tools: true, note: 'now' });
  assert.deepStrictEqual([next.noteAsSystem, next.extras('quick'), next.useTools], [false, {}, false]);
  assert.strictEqual(localturn.requestQuirks({ settings: llmOf({}), base, model: 'other', tools: true }).useTools, true, 'per model');
  assert.deepStrictEqual(quirksOf({ settings: llmOf({ baseUrl: 'https://api.groq.com/openai/v1' }) }).extras('quick'), {}, 'a cloud server gets no extras');
  assert.strictEqual(quirksOf({ tools: false }).useTools, false);
});

// ------------------------------------------------------------------ a whole turn, fake server

const sent = [];
let script = [];
const sse = (chunks) => new Response(chunks.map((c) => `data: ${JSON.stringify({ model: 'qwen3:8b', choices: [{ delta: c, finish_reason: null }] })}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
global.fetch = async (url, init) => {
  sent.push(JSON.parse(init.body));
  const next = script.shift() || [{ content: 'ok' }];
  return next.status ? new Response(next.body || 'bad request', { status: next.status }) : sse(next);
};
const ran = [];
const run = (name, result) => ({ ...tool(name, name.split('_')[0]), run: async () => (ran.push(name), result) });
const LIVE = [run('memory_save', { saved: true }), run('memory_search', { results: ['Project Atlas is due on 20 November'] }), run('calendar_get_events', { events: [] })];
const toolbox = require('../main/tools/toolbox');
let claude = 0;
stub({
  './tools': {
    TOOLS: [...toolbox, ...LIVE],
    activeTools: async () => LIVE,
    execute: async (name, args, ctx) => ({ ok: true, result: await [...toolbox, ...LIVE].find((t) => t.name === name).run(args, ctx) }),
    stringifyResult: (r) => JSON.stringify(r),
  },
  './prompt': { buildCompact: async () => ({ system: 'rules', stable: 'rules', context: 'Now: 10:00.', reminder: 'r' }), build: async () => ({ system: 's', stable: 's', context: 'c' }) },
  './claudecode': { runTurn: async () => (claude++, { text: 'From Claude', toolCalls: [] }), needsRollover: () => false, cachedConnectors: async () => ({ list: [] }) },
  './codebase': { root: async () => '/app' },
  './obsidian': { vaultPath: async () => null },
  './github': {},
  './documents': { userFolders: () => [] },
  './approvals': { newTurn: () => ({ approved: new Set(), taintSources: [] }), markTainted() {} },
});
const llm = load('main/llm.js');

let port = 20000;
const brain = (llmPatch = {}) => ({
  agent: { name: 'Siren', personality: 'p' }, appearance: {}, voice: {}, safety: {}, code: {}, web: {}, personas: {}, claudeCode: {}, anthropic: {},
  llm: { provider: 'openai', baseUrl: `http://localhost:${++port}/v1`, model: 'qwen3:8b', useTools: true, autoPace: true, modelMode: 'default', compactPrompt: 'auto', historyLimit: 30, handOver: false, ...llmPatch },
});
async function turn(text, settings = brain(), replies = []) {
  sent.length = 0;
  ran.length = 0;
  claude = 0;
  script = replies;
  const events = [];
  const conv = { id: 'c1', messages: [{ role: 'user', content: text }] };
  const r = await llm.runTurn({ settings, conv, history: conv.messages, emit: (e) => events.push(e), signal: new AbortController().signal, images: [] });
  return { r, events, stored: JSON.stringify(r.raw.messages) };
}
const call = (name, args = {}) => [{ tool_calls: [{ index: 0, id: `t_${name}`, function: { name, arguments: JSON.stringify(args) } }] }];
const toolAnswer = (payload, id) => payload.messages.find((m) => m.role === 'tool' && m.tool_call_id === id)?.content || '';

test('fake server: gave up, then looked', async () => {
  const gaveUp = 'I don’t have that information.';
  const { r, events, stored } = await turn('When is the Project Atlas deadline?', brain(), [[{ content: gaveUp }], call('memory_search', { query: 'Atlas' }), [{ content: 'It’s due on 20 November.' }]]);
  assert.deepStrictEqual(events.find((e) => e.type === 'retract'), { type: 'retract', chars: gaveUp.length });
  assert.deepStrictEqual(sent[1].messages.slice(-2), [{ role: 'assistant', content: gaveUp }, { role: 'system', content: core.LOOK_FIRST }], 'the reply taken back, then the ask');
  assert.deepStrictEqual(ran, ['memory_search']);
  assert.strictEqual(r.text, 'It’s due on 20 November.');
  assert.ok(!stored.includes('look it up now') && !stored.includes(gaveUp), 'neither is stored');
});

test('fake server: claimed, then admitted', async () => {
  const claim = 'I’ve added the dentist to your calendar.';
  const { r, events, stored } = await turn('Dentist on Friday at 10, please.', brain(), [[{ content: claim }], [{ content: 'I haven’t added it yet: I have no tool for that here.' }]]);
  assert.deepStrictEqual(events.find((e) => e.type === 'retract'), { type: 'retract', chars: claim.length });
  assert.strictEqual(sent[1].messages.at(-1).content, core.CLAIM_CHECK);
  assert.match(r.text, /haven’t added it yet/);
  assert.ok(!stored.includes(claim) && !stored.includes('no tool changed anything'), 'the claim and the check are not stored');
  assert.strictEqual(sent.length, 2, 'asked once');
});

test('fake server: wrote, then the hand-over is refused and the local model finishes', async () => {
  const { r } = await turn('Remember my coffee order and plan my week.', brain({ handOver: true }), [call('memory_save'), call('hand_over', { reason: 'planning' }), [{ content: 'Saved it; here is a plan.' }]]);
  assert.ok(sent[0].tools.some((t) => t.function.name === 'hand_over'), 'offered');
  assert.match(toolAnswer(sent[2], 't_hand_over'), /already changed something/);
  assert.strictEqual(claude, 0, 'the save would run twice');
  assert.strictEqual(r.provider, 'openai');
  assert.match(r.text, /Saved it/);
});

// The full prompt on a local server (compactPrompt off): no per-message notes, so a 400 is the extras'
// (with notes, the notes move first: see the order above).
test('fake server: a 400 for the local extras is retried without them, and they stay off for that server', async () => {
  const settings = brain({ compactPrompt: 'off' });
  const { r } = await turn('hi', settings, [{ status: 400, body: 'unknown field keep_alive' }, [{ content: 'Hello!' }]]);
  assert.strictEqual(sent[0].keep_alive, '30m');
  assert.strictEqual(sent[0].reasoning_effort, 'none');
  assert.ok(!('keep_alive' in sent[1]) && !('reasoning_effort' in sent[1]), 'retried without');
  assert.ok(sent[1].tools?.length, 'the tools stay');
  assert.strictEqual(r.text, 'Hello!');
  await turn('hi again', settings, [[{ content: 'Hi.' }]]);
  assert.strictEqual(sent.length, 1);
  assert.ok(!('keep_alive' in sent[0]), 'remembered for the server');
});

test('fake server: a template that refuses a later system message gets the notes in the user’s message', async () => {
  const settings = brain();
  await turn('anything tomorrow?', settings, [{ status: 500, body: 'System message must be at the beginning' }, [{ content: 'Nothing.' }]]);
  assert.strictEqual(sent[0].messages.at(-2).role, 'system');
  assert.match(sent[0].messages.at(-2).content, /Now: 10:00\./);
  assert.strictEqual(sent[1].messages.at(-1).role, 'user');
  assert.match(sent[1].messages.at(-1).content, /Now: 10:00\.[\s\S]*anything tomorrow\?$/);
  assert.ok(sent[1].keep_alive, 'the extras were not to blame');
  // A nudge then speaks as the app inside the user's turn too (no system message).
  await turn('When is Project Atlas due?', settings, [[{ content: 'I don’t know that.' }], [{ content: 'Still no idea.' }]]);
  assert.deepStrictEqual(sent[1].messages.at(-1), { role: 'user', content: core.LOOK_FIRST });
});
