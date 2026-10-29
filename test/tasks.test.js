// Tasks from Todoist / TickTick in the calendar (main/taskscore.js, main/tasks.js): what the assistant
// hands over is cleaned (odd dates, missing titles, unsafe links, duplicates), each service's list is
// replaced on its own, and "Sync tasks" runs one assistant turn at a time, only when it can work.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
const core = require('../main/taskscore');

const dir = tmpDir('siren-tasks-');
let settings = { llm: { provider: 'claude-code' }, claudeCode: { connectors: true }, routing: {} };
let connectorList = [{ name: 'claude.ai Todoist', status: 'connected' }, { name: 'claude.ai TickTick', status: 'needs-auth' }];
stub({
  './logger': quietLog,
  './store': fileStore(dir, { getSettings: async () => settings }),
  './claudecode': { cachedConnectors: async () => ({ at: 1, list: connectorList }) },
});
const tasks = load('main/tasks.js');

test('which task apps are connected', () => {
  assert.deepStrictEqual(core.connectedSources(connectorList), ['todoist']);
  assert.deepStrictEqual(core.connectedSources([{ name: 'claude.ai TickTick', status: 'connected' }, { name: 'plugin:x:todoist', status: 'connected' }]), ['ticktick', 'todoist']);
  assert.deepStrictEqual(core.connectedSources(null), []);
});

test('odd tasks from the assistant are cleaned or dropped, never stored as they came', () => {
  const { tasks: out, skipped } = core.clean([
    { id: '1', title: '  Read  chapter 3 ', due: '2026-10-28' },
    { id: '2', content: 'Call Mom', due: '2026-10-28T18:30:00Z', priority: 4, url: 'https://todoist.com/showTask?id=2' },
    { id: '3', title: 'No date' },
    { id: '4', title: 'Impossible date', due: '2026-02-31' },
    { id: '5', title: 'Bad time', due: '2026-10-29T25:99' },
    { id: '6', title: 'Unsafe link', due: '2026-10-29', url: 'javascript:alert(1)' },
    { id: '1', title: 'Duplicate id', due: '2026-10-30' },
    { id: '7', title: '' },
    null,
    'text',
    { id: '8', title: 'x'.repeat(500), due: 'next friday', priority: 9, done: true },
  ]);
  assert.strictEqual(skipped, 4, 'duplicate, empty title, null, a string');
  const byId = Object.fromEntries(out.map((t) => [t.id, t]));
  assert.deepStrictEqual(byId['1'], { id: '1', title: 'Read chapter 3', date: '2026-10-28', time: '', done: false, project: '', priority: 0, url: '' });
  assert.strictEqual(byId['2'].title, 'Call Mom');
  assert.strictEqual(byId['2'].time, '18:30');
  assert.strictEqual(byId['2'].priority, 4);
  assert.strictEqual(byId['3'].date, '', 'kept, but on no day');
  assert.strictEqual(byId['4'].date, '', 'February 31st is no day');
  assert.strictEqual(byId['5'].time, '', 'a time that does not exist is dropped, the date kept');
  assert.strictEqual(byId['5'].date, '2026-10-29');
  assert.strictEqual(byId['6'].url, '', 'only https links');
  assert.strictEqual(byId['8'].title.length, 200);
  assert.strictEqual(byId['8'].priority, 0);
  assert.strictEqual(byId['8'].done, true);
  assert.deepStrictEqual(core.clean('nope'), { tasks: [], skipped: 0 });
  assert.strictEqual(core.clean([...Array(2000)].map((_, i) => ({ id: String(i), title: 't' }))).tasks.length, core.MAX_TASKS);
});

test('each service is replaced on its own; unknown services are refused', () => {
  let s = core.replace(null, 'todoist', [{ id: 'a', title: 'A' }], 1);
  s = core.replace(s, 'ticktick', [{ id: 'b', title: 'B' }], 2);
  s = core.replace(s, 'todoist', [{ id: 'c', title: 'C' }], 3);
  assert.deepStrictEqual(s.tasks.map((t) => `${t.source}:${t.id}`).sort(), ['ticktick:b', 'todoist:c']);
  assert.deepStrictEqual(s.sources, { todoist: { at: 3, count: 1 }, ticktick: { at: 2, count: 1 } });
  assert.throws(() => core.replace(s, 'notion', []), /source must be/);
  assert.throws(() => core.replace(s, '__proto__', []), /source must be/);
});

test('a day: open tasks, timed ones first; overdue: open and before today', () => {
  const list = [
    { id: '1', title: 'b', date: '2026-10-28', time: '', done: false, priority: 1 },
    { id: '2', title: 'a', date: '2026-10-28', time: '09:00', done: false },
    { id: '3', title: 'done', date: '2026-10-28', time: '', done: true },
    { id: '4', title: 'old', date: '2026-10-20', time: '', done: false },
    { id: '5', title: 'older', date: '2026-10-01', time: '', done: false },
    { id: '6', title: 'no date', date: '', time: '', done: false },
  ];
  assert.deepStrictEqual(core.onDay(list, '2026-10-28').map((t) => t.id), ['2', '1']);
  assert.deepStrictEqual(core.overdue(list, '2026-10-27').map((t) => t.id), ['5', '4']);
});

test('save and status: what the calendar gets', async () => {
  const r = await tasks.save('todoist', [{ id: '1', title: 'Exam prep', due: '2026-10-29' }, { title: '' }]);
  assert.deepStrictEqual(r, { source: 'todoist', saved: 1, skipped: 1 });
  const st = await tasks.status();
  assert.strictEqual(st.ready, true);
  assert.deepStrictEqual(st.available, ['todoist']);
  assert.strictEqual(st.tasks[0].source, 'todoist');
  await assert.rejects(() => tasks.save('notion', []), /source must be/);
});

test('saves at the same moment from two services both land', async () => {
  await Promise.all([tasks.save('todoist', [{ id: 't', title: 'T', due: '2026-11-01' }]), tasks.save('ticktick', [{ id: 'k', title: 'K', due: '2026-11-02' }])]);
  assert.deepStrictEqual((await tasks.status()).tasks.map((t) => t.source).sort(), ['ticktick', 'todoist']);
});

test('sync: one at a time, and only when it can work', async () => {
  let runs = 0;
  let release;
  tasks.init({ run: (text) => (runs++, assert.match(text, /Todoist/), new Promise((r) => (release = () => r({ ok: true, conversationId: 'c1' })))), changed() {} });
  const a = tasks.sync();
  const b = tasks.sync();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(runs, 1, 'a second click joins the running sync');
  release();
  await Promise.all([a, b]);
  assert.strictEqual((await tasks.read()).conversationId, 'c1', 'the next sync reuses its conversation');
  settings = { ...settings, claudeCode: { connectors: false } };
  await assert.rejects(() => tasks.sync(), /Use my Claude connectors/);
  settings = { llm: { provider: 'anthropic' }, claudeCode: { connectors: true }, routing: {} };
  await assert.rejects(() => tasks.sync(), /Claude account brain/);
  settings = { llm: { provider: 'claude-code' }, claudeCode: { connectors: true }, routing: {} };
  connectorList = [];
  await assert.rejects(() => tasks.sync(), /Connect Todoist or TickTick/);
  connectorList = [{ name: 'claude.ai Todoist', status: 'connected' }];
  tasks.init({ run: async () => ({ ok: false, error: 'Stopped' }), changed() {} });
  await assert.rejects(() => tasks.sync(), /Stopped/);
});

test('the sync request asks only to read and to save', () => {
  const p = core.syncPrompt(['todoist', 'ticktick'], '2026-10-27');
  assert.match(p, /Todoist and TickTick/);
  assert.match(p, /tasks_save/);
  assert.match(p, /Do not change anything/);
});

// The saved copy in the per-message notes: "what's on my list today?" without a connector call.
test('the saved tasks in the per-message notes: today, tomorrow, overdue, and how old the copy is', () => {
  const core = require('./helpers').load('main/taskscore.js');
  const now = Date.parse('2026-10-29T14:00:00');
  const state = core.replace({ sources: {}, tasks: [] }, 'ticktick', core.clean([
    { id: '1', title: 'Submit report', due: '2026-10-29T09:30', project: 'Uni' },
    { id: '2', title: 'Buy milk', due: '2026-10-29' },
    { id: '3', title: 'Call Anna', due: '2026-10-30' },
    { id: '4', title: 'Old thing', due: '2026-10-20' },
    { id: '5', title: 'Done already', due: '2026-10-29', done: true },
  ]).tasks, now - 2 * 3600000);
  const block = core.promptBlock(state, { today: '2026-10-29', tomorrow: '2026-10-30', now });
  assert.match(block, /TickTick, fetched 2 h ago: today 09:30 Submit report \(Uni\); Buy milk\. Tomorrow Call Anna\. Overdue: 1 \(oldest due 2026-10-20\)\./);
  assert.doesNotMatch(block, /Done already/);
  assert.doesNotMatch(block, /fetch it again/, 'a recent copy is answered from');
  assert.match(block, /without the connector/);

  const old = core.promptBlock(state, { today: '2026-10-29', tomorrow: '2026-10-30', now: now + 8 * 3600000 });
  assert.match(old, /fetched 10 h ago \(old: fetch it again with the connector before answering about these\)/);
  assert.match(core.promptBlock(state, { today: '2026-10-29', tomorrow: '2026-10-30', now: now + 8 * 3600000, canFetch: false }), /old: say so.*needs the Claude brain/s, 'a brain without the connector does not promise to fetch');

  assert.strictEqual(core.promptBlock({ sources: {}, tasks: [] }, { today: '2026-10-29', tomorrow: '2026-10-30', now }), '', 'nothing synced: nothing in the prompt');
  const empty = core.replace({ sources: {}, tasks: [] }, 'todoist', [], now);
  assert.match(core.promptBlock(empty, { today: '2026-10-29', tomorrow: '2026-10-30', now }), /Todoist, fetched 1 min ago: today nothing\. Tomorrow nothing\./);

  const many = core.replace({ sources: {}, tasks: [] }, 'todoist', core.clean(Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, title: `Task ${i}`, due: '2026-10-29' }))).tasks, now);
  assert.match(core.promptBlock(many, { today: '2026-10-29', tomorrow: '2026-10-30', now }), /; and 4 more\./, 'at most 8 per day');
});

test('connectors: load a service in one search, not one tool per search', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main', 'prompt.js'), 'utf8');
  assert.match(src, /load every tool of it you may need for the task in that one search/);
});
