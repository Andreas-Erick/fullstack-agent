// A locked change to a vault note (notelock + obsidian.readOptional/writeNote, audit #13) never
// overwrites an edit made outside the app between its read and its write: it runs again on the new text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-cas-');
const vault = path.join(dir, 'vault');
stub({
  electron: { app: { getPath: () => dir } },
  './logger': quietLog,
  './vaultgit': { commitSoon() {}, ensure: async () => {} },
  './store': fileStore(dir, { getSettings: async () => ({ obsidian: { enabled: true, vaultPath: vault }, agent: { name: 'Nexus' } }) }),
});
const obsidian = load('main/obsidian.js');
const { withLock } = load('main/notelock.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const NOTE = 'Tally.md';
const lines = (t) => t.split('\n').filter((l) => l.startsWith('- '));

test('an outside edit between read and write is kept; the change is re-applied on top', async () => {
  await obsidian.writeNote(NOTE, '- one\n', 'overwrite');
  let runs = 0;
  await withLock(NOTE, async () => {
    runs++;
    const text = await obsidian.readOptional(NOTE);
    if (runs === 1) {
      // Someone edits the note in Obsidian while the app is working on it.
      await new Promise((r) => setTimeout(r, 20));
      const full = path.join(vault, NOTE);
      fs.writeFileSync(full, `${fs.readFileSync(full, 'utf8')}- typed in Obsidian\n`);
    }
    await obsidian.writeNote(NOTE, `${text.replace(/\s*$/, '')}\n- added by the app\n`, 'overwrite');
  });
  assert.strictEqual(runs, 2);
  const text = await obsidian.readOptional(NOTE);
  assert.deepStrictEqual(lines(text), ['- one', '- typed in Obsidian', '- added by the app']);
});

test('without outside edits the change runs once, also for a new note and two writes', async () => {
  let runs = 0;
  await withLock('New.md', async () => {
    runs++;
    const text = await obsidian.readOptional('New.md');
    await obsidian.writeNote('New.md', `${text}- a\n`, 'overwrite');
    await obsidian.writeNote('New.md', `${await obsidian.readOptional('New.md')}- b\n`, 'overwrite');
  });
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(lines(await obsidian.readOptional('New.md')), ['- a', '- b']);
});

test('a note that keeps changing gives up with a clear error', async () => {
  await assert.rejects(
    withLock(NOTE, async () => {
      await obsidian.readOptional(NOTE);
      const full = path.join(vault, NOTE);
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(full, `${fs.readFileSync(full, 'utf8')}- again\n`);
      await obsidian.writeNote(NOTE, 'lost', 'overwrite');
    }),
    { code: 'NOTE_CHANGED' },
  );
});
