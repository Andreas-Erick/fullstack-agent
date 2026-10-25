// Concurrent changes to one vault note (main/notelock.js): without the lock, two check-offs at the same
// moment both read the old Habits.md and the second write loses the first change.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load } = require('./helpers');

const notes = new Map();
const later = (v) => new Promise((r) => setTimeout(() => r(v), 5 + Math.random() * 10));
stub({
  './obsidian': {
    ymd: () => '2026-10-25',
    readOptional: (rel) => later(notes.get(rel) || ''),
    writeNote: async (rel, text) => {
      await later();
      notes.set(rel, text);
      return { path: rel };
    },
    vaultPath: async () => null,
  },
});
const habits = load('main/habits.js');
const { withLock } = load('main/notelock.js');

test('simultaneous check-offs all land', async () => {
  await habits.add({ name: 'Meditate' });
  await habits.add({ name: 'Run' });
  await habits.add({ name: 'Read' });
  await Promise.all([habits.log(['Meditate']), habits.log(['Run']), habits.log(['Read'])]);
  const today = (await habits.status()).habits.filter((h) => h.doneToday).map((h) => h.name).sort();
  assert.deepStrictEqual(today, ['Meditate', 'Read', 'Run']);
});

test('a failed change does not block the next one', async () => {
  await assert.rejects(withLock('x', async () => {
    throw new Error('boom');
  }));
  assert.strictEqual(await withLock('x', async () => 'next'), 'next');
});
