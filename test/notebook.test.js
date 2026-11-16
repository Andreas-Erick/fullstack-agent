// The user's notes (main/notebookcore.js, main/notebook.js): read, written, renamed with their links,
// pinned, deleted to the vault's bin; only inside Notes/ and Inbox/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');
const core = require('../main/notebookcore');

test('a note is read: frontmatter, snippet, #tags, words', () => {
  const text = '---\ntype: note\ntags: [robotics, ideas]\npinned: true\n---\n# Arm idea\nUse **IK** with [[Inverse Kinematics - Master Summary|the summary]] and #control-theory.\n```js\n#notatag\n```\n';
  const { front, body } = core.parse(text);
  assert.strictEqual(front.type, 'note');
  assert.ok(core.pinnedIn(front));
  assert.match(body, /^# Arm idea/);
  assert.strictEqual(core.snippet(body), 'Arm idea Use IK with the summary and #control-theory.');
  assert.deepStrictEqual(core.tags(text), ['robotics', 'ideas', 'control-theory']);
  assert.strictEqual(core.words('one two, three-four'), 3);
  assert.strictEqual(core.snippet('word '.repeat(100), 30).endsWith('…'), true);
});

test('only notes in Notes/ and Inbox/ count; titles become safe file names', () => {
  for (const ok of ['Notes/a.md', 'Notes/Robotics/arm.md', 'Inbox/x.md']) assert.ok(core.isNotePath(ok), ok);
  for (const bad of ['Notes/Notes.md', 'Inbox/Inbox.md', 'Memory/a.md', 'Notes/../Profile.md', 'Notes/.hidden.md', 'Notes/a.txt', 'Notes', '/Notes/a.md', 'Notes\\a.md', 'Notes//a.md']) assert.ok(!core.isNotePath(bad), bad);
  assert.strictEqual(core.safeTitle('a/b: c?*'), 'a b c');
  assert.strictEqual(core.safeTitle('  ...  '), 'Untitled');
  assert.strictEqual(core.uniquePath('Notes', 'Idea', new Set(['notes/idea.md', 'notes/idea 2.md'])), 'Notes/Idea 3.md');
  assert.deepStrictEqual(core.fromDump('\n\n## Shopping list\n- eggs\n- milk'), { title: 'Shopping list', body: '- eggs\n- milk' });
  const long = core.fromDump(`${'word '.repeat(30)}end`);
  assert.ok(long.title.length <= 80 && long.body.startsWith('word word'), 'a long first line stays in the body');
});

test('pinning, order, search, relinking', () => {
  const a = core.setPinned('---\ntype: note\n---\nhi', true);
  assert.match(a, /^---\npinned: true\ntype: note\n---\nhi$/);
  assert.strictEqual(core.setPinned(a, false), '---\ntype: note\n---\nhi');
  assert.strictEqual(core.setPinned('plain', true), '---\npinned: true\n---\nplain');
  assert.strictEqual(core.setPinned('---\npinned: true\n---\nplain', false), 'plain');
  const order = core.sortNotes([{ title: 'old', mtime: 1 }, { title: 'new', mtime: 3 }, { title: 'pin', mtime: 0, pinned: true }]).map((n) => n.title);
  assert.deepStrictEqual(order, ['pin', 'new', 'old']);
  const note = { title: 'PID tuning', snippet: 'Ziegler–Nichols first', tags: ['control'], folder: 'Robotics' };
  assert.ok(core.matches(note, 'pid ziegler'));
  assert.ok(core.matches(note, '#control'));
  assert.ok(core.matches(note, 'robotics'));
  assert.ok(!core.matches(note, 'pid kalman'));
  const text = 'See [[Old Idea]], [[old idea|this]], [[Notes/Old Idea#Part]], ![[Old Idea]] but not [[Old Ideas]].';
  assert.strictEqual(core.relink(text, 'Notes/Old Idea.md', 'Notes/New Idea.md'), 'See [[New Idea]], [[New Idea|this]], [[Notes/New Idea#Part]], ![[New Idea]] but not [[Old Ideas]].');
  assert.deepStrictEqual(core.notebooks([{ folder: 'Robotics', day: 'd1' }, { folder: 'Robotics', day: 'd0' }, { folder: '', day: 'd0' }], 'd1'), [{ name: 'Robotics', count: 2, done: true }, { name: 'Notes', count: 1, done: false }]);
});

test('the notebook writes in the vault: create, save, rename with links, pin, delete', async () => {
  const vault = tmpDir('nexus-notebook-');
  const written = [];
  const writeNote = async (rel, content, mode) => {
    const full = path.join(vault, rel);
    if (mode === 'create' && fs.existsSync(full)) throw new Error('exists');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    written.push(rel);
  };
  let backlinks = [];
  stub({
    './logger': quietLog,
    './obsidian': { vaultPath: async () => vault, writeNote, deleteNote: async (rel) => (fs.rmSync(path.join(vault, rel)), { deleted: rel }), afterChange: async () => {} },
    './linkindex': { forNote: async () => ({ backlinks }) },
  });
  const nb = load('main/notebook.js');
  const a = await nb.create({ title: 'Brain dump', body: 'first #idea' });
  assert.strictEqual(a.path, 'Notes/Brain dump.md');
  assert.strictEqual((await nb.create({ title: 'Brain dump' })).path, 'Notes/Brain dump 2.md');
  assert.strictEqual((await nb.create({ title: 'Arm', folder: 'Robotics' })).path, 'Notes/Robotics/Arm.md');
  assert.strictEqual((await nb.create({ title: 'Quick', folder: 'Inbox' })).path, 'Inbox/Quick.md');
  fs.writeFileSync(path.join(vault, 'Notes/Notes.md'), '- index');

  let { notes } = await nb.list();
  assert.deepStrictEqual(notes.map((n) => n.path).sort(), ['Inbox/Quick.md', 'Notes/Brain dump 2.md', 'Notes/Brain dump.md', 'Notes/Robotics/Arm.md']);
  assert.strictEqual(notes.find((n) => n.title === 'Arm').folder, 'Robotics');
  assert.deepStrictEqual(notes.find((n) => n.title === 'Brain dump').tags, ['idea']);

  // Saving keeps the frontmatter; a new title renames the note and the links to it follow.
  fs.writeFileSync(path.join(vault, 'Notes/Brain dump.md'), '---\ncreated: 2026-11-16\n---\nfirst');
  fs.writeFileSync(path.join(vault, 'Notes/Robotics/Arm.md'), 'see [[Brain dump]]');
  backlinks = ['Notes/Robotics/Arm.md'];
  const r = await nb.save('Notes/Brain dump.md', { title: 'Ideas: robots', body: 'second' });
  assert.strictEqual(r.path, 'Notes/Ideas robots.md');
  assert.strictEqual(r.relinked, 1);
  assert.strictEqual(fs.readFileSync(path.join(vault, 'Notes/Ideas robots.md'), 'utf8'), '---\ncreated: 2026-11-16\n---\nsecond');
  assert.strictEqual(fs.readFileSync(path.join(vault, 'Notes/Robotics/Arm.md'), 'utf8'), 'see [[Ideas robots]]');
  assert.ok(!fs.existsSync(path.join(vault, 'Notes/Brain dump.md')));

  await nb.pin('Notes/Ideas robots.md', true);
  ({ notes } = await nb.list());
  assert.strictEqual(notes[0].path, 'Notes/Ideas robots.md', 'pinned first');
  assert.strictEqual((await nb.read('Notes/Ideas robots.md')).body, 'second');

  await nb.remove('Inbox/Quick.md');
  assert.ok(!fs.existsSync(path.join(vault, 'Inbox/Quick.md')));
  const s = await nb.summary();
  assert.strictEqual(s.count, 3);
  assert.ok(s.today.length === 3, 'all changed today');
  // Never outside the user's notes.
  for (const bad of ['Memory/x.md', 'Profile.md', 'Notes/../Profile.md']) await assert.rejects(nb.read(bad), /not one of your notes/);
  await assert.rejects(nb.remove('Notes/Notes.md'), /not one of your notes/);
});
