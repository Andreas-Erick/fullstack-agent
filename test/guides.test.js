// The bundled guides in the vault (main/obsidian.js placeGuides): placed once, refreshed when a new
// version changes a guide the user never edited, left alone when edited, not brought back when removed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-guides-');
const vault = path.join(dir, 'vault');
stub({
  electron: { app: { getPath: () => dir } },
  './logger': quietLog,
  './vaultgit': { commitSoon() {}, ensure: async () => {} },
  './store': fileStore(dir, { getSettings: async () => ({ obsidian: { enabled: true, vaultPath: vault }, agent: { name: 'Nexus' } }) }),
});
const obsidian = load('main/obsidian.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const GUIDE = 'Make Your Own Face.md';
const note = path.join(vault, 'Notes', GUIDE);
const seenFile = path.join(vault, '.obsidian', 'siren-guides.json');
const bundled = () => fs.readFileSync(path.join(__dirname, '..', 'main', 'guides', GUIDE), 'utf8').replace(/\{\{name\}\}/g, 'Nexus');

test('guides are placed with the agent name and remembered with a hash', async () => {
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  await obsidian.placeGuides(vault, 'Nexus');
  assert.strictEqual(fs.readFileSync(note, 'utf8'), bundled());
  const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  assert.match(seen[GUIDE], /^[0-9a-f]{40}$/);
});

test('an install that only remembered names gets a changed guide refreshed once', async () => {
  fs.writeFileSync(note, '# Old prompt\n');
  fs.writeFileSync(seenFile, JSON.stringify([GUIDE]));
  await obsidian.placeGuides(vault, 'Nexus');
  assert.strictEqual(fs.readFileSync(note, 'utf8'), bundled());
  assert.ok(!Array.isArray(JSON.parse(fs.readFileSync(seenFile, 'utf8'))));
});

test('a guide the user edited is kept; a removed one is not brought back', async () => {
  const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
  seen[GUIDE] = 'f'.repeat(40); // "placed" something else: the bundled text differs from what was placed
  fs.writeFileSync(seenFile, JSON.stringify(seen));
  fs.writeFileSync(note, `${bundled()}\n\nMy own notes.\n`);
  await obsidian.placeGuides(vault, 'Nexus');
  assert.match(fs.readFileSync(note, 'utf8'), /My own notes/);
  assert.strictEqual(JSON.parse(fs.readFileSync(seenFile, 'utf8'))[GUIDE], 'f'.repeat(40));
  fs.rmSync(note);
  await obsidian.placeGuides(vault, 'Nexus');
  assert.ok(!fs.existsSync(note));
});
