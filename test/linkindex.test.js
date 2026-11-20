// The vault's [[wikilinks]]: parsing and resolving (main/linkcore.js), the index that follows edits
// (main/linkindex.js), and the edges on the vault map (main/replaycore.js vaultMap).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');
const core = require('../main/linkcore');

test('links: targets with aliases, headings and embeds; never inside code', () => {
  const text = 'See [[Plan]] and [[Notes/Ideas|my ideas]], [[Plan#Next]] again, ![[Diagram]].\n`[[not a link]]`\n```\n[[nor this]]\n```\n[[ Spaced ]]';
  assert.deepStrictEqual(core.linksOf(text), ['Plan', 'Notes/Ideas', 'Diagram', 'Spaced']);
  assert.deepStrictEqual(core.linksOf(''), []);
});

test('resolving like Obsidian: full path first, then the name, the shortest path among equals', () => {
  const resolve = core.resolver(['Plan.md', 'Projects/Plan.md', 'Notes/Ideas.md', 'Deep/A/Ideas.md', 'Daily/2026-10-27.md']);
  assert.strictEqual(resolve('Plan'), 'Plan.md');
  assert.strictEqual(resolve('Projects/Plan'), 'Projects/Plan.md');
  assert.strictEqual(resolve('ideas'), 'Notes/Ideas.md');
  assert.strictEqual(resolve('2026-10-27.md'), 'Daily/2026-10-27.md');
  assert.strictEqual(resolve('Missing'), null);
  assert.strictEqual(resolve('photo.png'), null, 'attachments are not notes');
});

test('the index: links, backlinks, unresolved; no self-links or duplicates', () => {
  const idx = core.build([
    { path: 'A.md', text: '[[B]] [[B]] [[A]] [[Nowhere]]' },
    { path: 'B.md', text: '[[A]]' },
    { path: 'C.md', text: '[[B]]' },
  ]);
  assert.deepStrictEqual(idx.links, { 'A.md': ['B.md'], 'B.md': ['A.md'], 'C.md': ['B.md'] });
  assert.deepStrictEqual(idx.backlinks['B.md'], ['A.md', 'C.md']);
  assert.strictEqual(idx.unresolved, 1);
  assert.deepStrictEqual(core.edges(idx.links, new Set(['A.md', 'B.md'])).map((e) => `${e.from}>${e.to}`), ['f:A.md>f:B.md', 'f:B.md>f:A.md']);
});

test('the vault map carries the links as edges', () => {
  stub({ './logger': quietLog });
  const replaycore = load('main/replaycore.js');
  const map = replaycore.vaultMap(['A.md', 'Notes/B.md'], { links: { 'A.md': ['Notes/B.md'], 'Gone.md': ['A.md'] } });
  assert.deepStrictEqual(map.edges.map((e) => [e.from, e.to, e.kind]), [['f:A.md', 'f:Notes/B.md', 'link']]);
  assert.strictEqual(map.stats.connections, 1);
});

test('the index follows the vault: new, changed and removed notes', async () => {
  stub({ './logger': quietLog });
  const idx = load('main/linkindex.js');
  const dir = tmpDir('nexus-links-');
  const write = (rel, text) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), text));
  write('Home.md', 'Start at [[Plan]].');
  write('Projects/Plan.md', 'Back to [[Home]].');
  write('.obsidian/x.md', '[[Home]]');
  let r = await idx.forNote(dir, 'Projects/Plan.md');
  assert.deepStrictEqual(r, { path: 'Projects/Plan.md', links: ['Home.md'], backlinks: ['Home.md'] });
  write('Daily.md', 'Worked on [[Plan]].');
  r = await idx.forNote(dir, 'Projects/Plan.md');
  assert.deepStrictEqual(r.backlinks, ['Daily.md', 'Home.md'], 'a new note is picked up');
  fs.rmSync(path.join(dir, 'Home.md'));
  idx.touched('Home.md');
  r = await idx.forNote(dir, 'Projects/Plan.md');
  assert.deepStrictEqual(r, { path: 'Projects/Plan.md', links: [], backlinks: ['Daily.md'] }, 'a removed note drops out');
  const [a, b] = await Promise.all([idx.get(dir), idx.get(dir)]);
  assert.strictEqual(a.notes, 2);
  assert.strictEqual(b.notes, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Efficiency pass: the index kept every linking note's full text and rebuilt everything after each write.
test('relinkNote: one note edited gives the same index as a full build, and leaves the old one alone', () => {
  const notes = [
    { path: 'A.md', text: '[[B]] [[C]] [[Nowhere]]' },
    { path: 'B.md', text: '[[A]]' },
    { path: 'C.md', text: '[[B]]' },
    { path: 'Deep/C.md', text: '' },
  ];
  const resolve = core.resolver(notes.map((n) => n.path));
  const before = core.build(notes, resolve);
  const frozen = JSON.stringify(before);
  for (const text of ['[[C]] [[Deep/C]] [[Gone]] [[Gone2]]', '', '[[B]] [[C]] [[Nowhere]]', '[[A]] [[B]]']) {
    const after = notes.map((n) => (n.path === 'A.md' ? { ...n, text } : n));
    const updated = core.relinkNote(before, 'A.md', core.linkNote('A.md', core.linksOf(notes[0].text), resolve), core.linkNote('A.md', core.linksOf(text), resolve));
    assert.deepStrictEqual(updated, core.build(after), text);
    assert.strictEqual(JSON.stringify(before), frozen, 'the old index is untouched');
  }
  assert.deepStrictEqual(core.linkNote('X.md', [], resolve), { to: [], unresolved: 0 });
  assert.deepStrictEqual(core.build([]), { links: {}, backlinks: {}, unresolved: 0, notes: 0 });
  assert.deepStrictEqual(core.build([{ path: 'A.md', targets: ['B'] }, { path: 'B.md', targets: [] }]).links, { 'A.md': ['B.md'] }, 'targets in place of text');
});

test('the index updates an edited note in place, keeps no note text, and matches a fresh build', async () => {
  stub({ './logger': quietLog });
  const idx = load('main/linkindex.js');
  const dir = tmpDir('nexus-links-inc-');
  const write = (rel, text) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), text));
  for (let i = 0; i < 70; i++) write(`N${i}.md`, `Note ${i} links [[N${(i + 1) % 70}]] ${'filler '.repeat(50)}`);
  write('Hub.md', '[[N1]] [[N2]]');
  const first = await idx.get(dir);
  assert.deepStrictEqual(first.backlinks['N2.md'], ['Hub.md', 'N1.md']);
  // An edit made by the app (touched) with the mtime unchanged is read again.
  const hub = path.join(dir, 'Hub.md');
  const st = fs.statSync(hub);
  fs.writeFileSync(hub, '[[N3]] [[Missing]]');
  fs.utimesSync(hub, st.atime, st.mtime);
  idx.touched('Hub.md');
  const second = await idx.get(dir);
  assert.notStrictEqual(second, first);
  assert.deepStrictEqual(first.backlinks['N2.md'], ['Hub.md', 'N1.md'], 'a list handed out before never changes');
  assert.deepStrictEqual(second.backlinks['N2.md'], ['N1.md']);
  assert.deepStrictEqual(second.links['Hub.md'], ['N3.md']);
  assert.strictEqual(second.unresolved, first.unresolved + 1);
  // The same as a fresh index over the same files.
  const fresh = load('main/linkindex.js');
  assert.deepStrictEqual(await fresh.get(dir), second);
  // Nothing changed: the same index object comes back.
  assert.strictEqual(await idx.get(dir), second);
  fs.rmSync(dir, { recursive: true, force: true });
});
