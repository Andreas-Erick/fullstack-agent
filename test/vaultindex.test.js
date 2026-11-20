// Vault folder indexes and search at scale (main/obsidian.js, audit #14 + #15): a folder's index is
// rebuilt when a note is added or removed, not on every edit; search reads notes in parallel and ranks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-vidx-');
const vault = path.join(dir, 'vault');
stub({
  electron: { app: { getPath: () => dir } },
  './logger': quietLog,
  './vaultgit': { commitSoon() {}, ensure: async () => {} },
  './store': fileStore(dir, { getSettings: async () => ({ obsidian: { enabled: true, vaultPath: vault }, agent: { name: 'Nexus' } }) }),
});
const obsidian = load('main/obsidian.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const index = () => fs.readFileSync(path.join(vault, 'Notes', 'Notes.md'), 'utf8');

test('new and deleted notes update the folder index; edits leave it alone', async () => {
  await obsidian.writeNote('Notes/Alpha', '# Alpha\n\nfirst', 'overwrite');
  await obsidian.writeNote('Notes/Beta', '# Beta\n\nsecond', 'overwrite');
  assert.match(index(), /\[\[Alpha\]\][\s\S]*\[\[Beta\]\]/);
  // Mark the index: an edit of a listed note must not rewrite it.
  fs.appendFileSync(path.join(vault, 'Notes', 'Notes.md'), '\nmarker\n');
  await obsidian.writeNote('Notes/Alpha', '# Alpha\n\nedited', 'overwrite');
  assert.match(index(), /marker/);
  await obsidian.deleteNote('Notes/Beta');
  assert.doesNotMatch(index(), /\[\[Beta\]\]/);
});

test('search ranks matching notes across many files', async () => {
  for (let i = 0; i < 60; i++) await obsidian.writeNote(`Research/Filler ${i}`, `# Filler ${i}\n\nnothing to see here`, 'overwrite');
  await obsidian.writeNote('Research/Eigenvalues', '# Eigenvalues\n\nEigenvalues and eigenvectors of a matrix; eigenvalues again.', 'overwrite');
  const hits = await obsidian.search('eigenvalues');
  assert.strictEqual(hits[0].title, 'Eigenvalues');
  assert.ok(hits.every((h) => !h.title.startsWith('Filler')));
});

// The status lights ask every few minutes: the note count is kept for 5 minutes or until a note changes here.
test('the vault status reuses its note count until a note changes', async (t) => {
  process.env.NEXUS_OBSIDIAN_REGISTRY = path.join(dir, 'obsidian.json'); // not the real Obsidian's list
  t.after(() => delete process.env.NEXUS_OBSIDIAN_REGISTRY);
  const first = await obsidian.status();
  assert.strictEqual(first.ok, true);
  fs.writeFileSync(path.join(vault, 'Notes', 'Written in Obsidian.md'), '# Elsewhere\n');
  assert.strictEqual((await obsidian.status()).count, first.count, 'not walked again within 5 minutes');
  await obsidian.writeNote('Notes/Gamma', '# Gamma\n\nthird', 'overwrite');
  assert.strictEqual((await obsidian.status()).count, first.count + 2, 'a note written here: counted again');

  fs.writeFileSync(path.join(vault, 'Notes', 'Also elsewhere.md'), '# Elsewhere\n');
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60000 + 1000;
  t.after(() => (Date.now = realNow));
  assert.strictEqual((await obsidian.status()).count, first.count + 3, 'after 5 minutes the vault is walked again');
});

// Efficiency pass: a local model's turn searched the whole vault only to match note titles (prompt.js
// matchesFor). The list of note paths is kept for a minute or until a note is added or removed here.
test('notePaths is kept until a note comes or goes here, or a minute passes', async (t) => {
  const first = await obsidian.notePaths();
  assert.ok(first.includes('Research/Eigenvalues.md'));
  fs.writeFileSync(path.join(vault, 'Notes', 'Outside.md'), '# Outside\n');
  assert.strictEqual(await obsidian.notePaths(), first, 'an edit in Obsidian shows after the minute');
  await obsidian.writeNote('Research/Eigenvalues', '# Eigenvalues\n\nedited', 'overwrite');
  assert.strictEqual(await obsidian.notePaths(), first, 'an edit of a listed note keeps the list');
  await obsidian.writeNote('Research/Delta', '# Delta', 'overwrite');
  const second = await obsidian.notePaths();
  assert.ok(second.includes('Research/Delta.md') && second.includes('Notes/Outside.md'), 'a new note: walked again');
  await obsidian.deleteNote('Research/Delta');
  assert.ok(!(await obsidian.notePaths()).includes('Research/Delta.md'), 'a deleted note drops out');
  fs.rmSync(path.join(vault, 'Notes', 'Outside.md'));
  const realNow = Date.now;
  Date.now = () => realNow() + 61000;
  t.after(() => (Date.now = realNow));
  assert.ok(!(await obsidian.notePaths()).includes('Notes/Outside.md'), 'after a minute the vault is walked again');
});

test('guide notes are placed once; one the user deleted stays deleted', async () => {
  const note = path.join(vault, 'Notes', 'Make Your Own Face.md');
  assert.ok(fs.existsSync(note), 'the face guide is in Notes/');
  assert.match(fs.readFileSync(note, 'utf8'), /Make your own face[\s\S]*Nexus can wear any face/);
  fs.rmSync(note);
  // A new start scaffolds again (another vault path would; here call through a fresh module).
  const again = load('main/obsidian.js');
  await again.vaultPath();
  assert.ok(!fs.existsSync(note));
});
