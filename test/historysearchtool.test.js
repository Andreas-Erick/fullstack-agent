// The agent's history_search (main/tools/vault.js) read and unsealed every conversation on each call.
// With a date it now opens only conversations whose [createdAt, updatedAt] can hold that day, and it
// yields to the event loop between files.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const DAY = 86400000;
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const convs = [];
const opened = [];
stub({
  '../logger': quietLog,
  '../memory': {},
  '../obsidian': { PROFILE_AGENT_SECTIONS: [] },
  '../vaultgit': {},
  '../approvals': {},
  '../store': {
    listConversations: async () => convs.map(({ id, title, createdAt, updatedAt, messages }) => ({ id, title, createdAt, updatedAt, count: messages.length })),
    getConversation: async (id) => (opened.push(id), convs.find((c) => c.id === id) || null),
  },
});
const tool = load('main/tools/vault.js').find((t) => t.name === 'history_search');

const conv = (id, created, updated, texts) => ({
  id,
  title: id,
  createdAt: created,
  updatedAt: updated,
  messages: texts.map(([t, content]) => ({ role: 'user', content, createdAt: t })),
});

test('a date opens only the conversations that can hold that day', async () => {
  convs.length = 0;
  convs.push(
    conv('march', at(2026, 3, 1), at(2026, 3, 2), [[at(2026, 3, 1), 'tea in march']]),
    conv('span', at(2026, 4, 1), at(2026, 6, 1), [[at(2026, 5, 10), 'tea in may'], [at(2026, 6, 1), 'later']]),
    conv('may10', at(2026, 5, 10, 9), at(2026, 5, 10, 18), [[at(2026, 5, 10, 9), 'tea again']]),
    conv('may11', at(2026, 5, 11, 1), at(2026, 5, 11, 2), [[at(2026, 5, 11, 1), 'next day']]),
    conv('july', at(2026, 7, 1), at(2026, 7, 2), [[at(2026, 7, 1), 'tea in july']]),
    conv('notimes', undefined, undefined, [[at(2026, 5, 10, 10), 'no index times']]),
  );
  opened.length = 0;
  const r = await tool.run({ date: '2026-05-10' });
  assert.deepStrictEqual(r.map((x) => x.text).sort(), ['no index times', 'tea again', 'tea in may']);
  assert.deepStrictEqual(opened.sort(), ['may10', 'may11', 'notimes', 'span'], 'march and july are never opened; the next day is within the margin');
  // Without a date, everything is still searched, and the result is the same as before.
  opened.length = 0;
  const all = await tool.run({ query: 'tea' });
  assert.strictEqual(opened.length, convs.length);
  assert.deepStrictEqual(all.map((x) => x.text).sort(), ['tea again', 'tea in july', 'tea in march', 'tea in may']);
  // A date that isn't one prunes nothing (and matches nothing).
  opened.length = 0;
  assert.strictEqual(await tool.run({ date: 'yesterday' }), 'No matching messages.');
  assert.strictEqual(opened.length, convs.length);
});

test('a date before or after every conversation opens none', async () => {
  opened.length = 0;
  assert.strictEqual(await tool.run({ date: '2020-01-01' }), 'No matching messages.');
  assert.strictEqual(await tool.run({ date: '2030-01-01' }), 'No matching messages.');
  assert.deepStrictEqual(opened.filter((id) => id !== 'notimes'), []);
});

test('many conversations: the search yields to the event loop between files', async () => {
  convs.length = 0;
  for (let i = 0; i < 40; i++) convs.push(conv(`c${i}`, at(2026, 1, 1) + i * DAY, at(2026, 1, 1) + i * DAY, [[at(2026, 1, 1) + i * DAY, `msg ${i}`]]));
  // The reads here resolve in microtasks only: without a yield no setImmediate callback could run meanwhile.
  let ticks = 0;
  let on = true;
  const tick = () => on && (ticks++, setImmediate(tick));
  setImmediate(tick);
  opened.length = 0;
  const r = await tool.run({ query: 'msg' });
  on = false;
  assert.strictEqual(r.length, 40);
  assert.deepStrictEqual(opened, convs.map((c) => c.id));
  assert.ok(ticks >= 4, `the event loop ran ${ticks} times during the search`);
});
