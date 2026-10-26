// What paired devices see beyond chat (main/companiondata.js): trimmed copies, notes only inside the
// vault, habits only checked off for today or yesterday.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const reads = [];
const logs = [];
stub({
  './logger': quietLog,
  './store': { getSettings: async () => ({ calendar: { enabled: false } }) },
  './obsidian': {
    ymd: () => '2026-10-26',
    readNote: async (p) => (reads.push(p), { path: p, fullPath: `C:/vault/${p}`, title: 'T', modified: 1, tags: ['x'], content: 'x'.repeat(10) }),
    readPriorities: async () => '---\nupdated: x\n---\n# Priorities\n- Ship 2.0',
  },
  './habits': {
    status: async () => ({ habits: [{ name: 'Run', frequency: 'daily', target: 7, paused: false, doneToday: true, streak: 4, streakUnit: 'days', thisWeek: 3, last7: [true], rate28: 0.5, note: 'private' }] }),
    log: async (names, opt) => (logs.push([names, opt]), { habits: [] }),
  },
  './learning': { deckSummaries: async () => [], topics: async () => [] },
  './handoff': { read: async () => null },
  './memory': {
    list: async () => [{ id: 'm1', title: 'A', content: 'y'.repeat(5000), category: 'fact', updated: 1, file: 'C:/secret/path.md' }],
    search: async () => [],
  },
});
const data = load('main/companiondata.js');

test('notes: vault paths only; the full path on disk never leaves', async () => {
  for (const bad of ['../outside.md', '/etc/passwd', 'a/../../b.md', '.obsidian/app.json', 'C:\\x.md', '']) {
    await assert.rejects(data.note(bad), { status: 400 }, bad);
  }
  const n = await data.note('Notes/Ideas.md');
  assert.deepStrictEqual(Object.keys(n).sort(), ['content', 'modified', 'path', 'title']);
  assert.deepStrictEqual(reads, ['Notes/Ideas.md']);
});

test('habits: a name is required; only today or yesterday', async () => {
  await assert.rejects(data.logHabit('  ', true), { status: 400 });
  await data.logHabit('Run', true, '2020-01-01');
  assert.deepStrictEqual(logs.pop(), [['Run'], { done: true, date: 'today' }]);
  await data.logHabit('Run', false, 'yesterday');
  assert.deepStrictEqual(logs.pop(), [['Run'], { done: false, date: 'yesterday' }]);
});

test('trimmed copies: no private fields, long texts clipped', async () => {
  const { habits } = await data.habits();
  assert.strictEqual(habits[0].note, undefined, 'a habit’s private note stays on the computer');
  const { memories } = await data.memories();
  assert.strictEqual(memories[0].file, undefined);
  assert.ok(memories[0].content.length <= 2001);
  const t = await data.today();
  assert.strictEqual(t.priorities, '# Priorities\n- Ship 2.0', 'frontmatter removed');
});
