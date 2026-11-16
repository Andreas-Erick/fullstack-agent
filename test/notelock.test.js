// Concurrent changes to one vault note (main/notelock.js): without the lock, two changes at the same
// moment (a vocabulary deck, a learning topic) both read the old note and the second write loses the first.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load } = require('./helpers');

stub({ './obsidian': { vaultPath: async () => null } });
const { withLock } = load('main/notelock.js');
const later = (v) => new Promise((r) => setTimeout(() => r(v), 5 + Math.random() * 10));

test('simultaneous read-modify-write changes to one note all land', async () => {
  let note = '# Deck';
  const add = (line) =>
    withLock('Languages/Icelandic.md', async () => {
      const text = await later(note); // read
      await later();
      note = `${text}\n- ${line}`; // write what was read, plus the change
    });
  await Promise.all(['hús', 'bók', 'vatn'].map(add));
  assert.deepStrictEqual(note.split('\n').slice(1).sort(), ['- bók', '- hús', '- vatn']);
});

test('a failed change does not block the next one', async () => {
  await assert.rejects(withLock('x', async () => {
    throw new Error('boom');
  }));
  assert.strictEqual(await withLock('x', async () => 'next'), 'next');
});
