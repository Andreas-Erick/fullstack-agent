// The user's notes (main/notebookcore.js, main/notebook.js): read, written, renamed with their links,
// pinned, deleted to the vault's bin; only inside Notes/ and Inbox/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
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

// Undo of a delete in the Notes view (notebook.restore): the file itself comes back from .trash, so its
// frontmatter (tags, aliases, pinned) is kept; a name taken meanwhile gets a number, never an overwrite.
test('Undo of a delete brings the note back byte for byte, never over a note that took its name', async () => {
  const dir = tmpDir('nexus-restore-');
  const vault = path.join(dir, 'vault');
  // The real obsidian.js this time (the stubs above stay in this file's process, so each is set again).
  stub({
    electron: { app: { getPath: () => dir } },
    './logger': quietLog,
    './vaultgit': { commitSoon() {}, ensure: async () => {} },
    './linkindex': { forNote: async () => ({ backlinks: [] }), touched() {} },
    './store': fileStore(dir, { getSettings: async () => ({ obsidian: { enabled: true, vaultPath: vault }, agent: { name: 'Nexus' } }) }),
  });
  const obsidian = load('main/obsidian.js');
  stub({ './obsidian': obsidian });
  const nb = load('main/notebook.js');
  const at = (rel) => path.join(vault, ...rel.split('/'));
  const files = (d = vault, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) files(full, out);
      else out.push(`${path.relative(vault, full)} ${fs.statSync(full).size}`);
    }
    return out.sort();
  };
  const GONE = /isn’t in the vault’s bin \(\.trash\) any more/;
  const rel = 'Notes/Lecture/Eigen.md';
  const two = 'Notes/Lecture/Eigen 2.md';
  const body = ['# Eigenvalues', 'מטריצה — λ is an eigenvalue 👨‍👩‍👧‍👦', 'x'.repeat(10000)].join('\r\n');
  const bytes = Buffer.from(`---\ntags: [lecture, linalg]\naliases: LA\npinned: true\n---\n${body}\r\n`, 'utf8');
  const put = (r, b) => (fs.mkdirSync(path.dirname(at(r)), { recursive: true }), fs.writeFileSync(at(r), b));
  put(rel, bytes);

  // Deleted, then back: the same bytes, still pinned, with its tags.
  const gone = await nb.remove(rel);
  assert.match(gone.trashed, /^\.trash\/\d+-Eigen\.md$/);
  assert.ok(!fs.existsSync(at(rel)));
  assert.deepStrictEqual(await nb.restore(gone.trashed, rel), { path: rel });
  assert.ok(fs.readFileSync(at(rel)).equals(bytes), 'byte for byte');
  const listed = (await nb.list()).notes.find((n) => n.path === rel);
  assert.ok(listed?.pinned, 'still pinned');
  assert.deepStrictEqual(listed.tags, ['lecture', 'linalg']);

  // A name no title cleaning would produce (RTL, a ZWJ emoji) round-trips as it was.
  const odd = 'Notes/מחברת 👨‍👩‍👧‍👦.md';
  put(odd, 'shalom');
  const oddGone = await nb.remove(odd);
  assert.deepStrictEqual(await nb.restore(oddGone.trashed, odd), { path: odd });
  assert.strictEqual(fs.readFileSync(at(odd), 'utf8'), 'shalom');

  // A new note took the name meanwhile: the old one comes back next to it.
  const t1 = (await nb.remove(rel)).trashed;
  put(rel, 'a new note');
  assert.deepStrictEqual(await nb.restore(t1, rel), { path: two });
  assert.ok(fs.readFileSync(at(two)).equals(bytes));
  assert.strictEqual(fs.readFileSync(at(rel), 'utf8'), 'a new note', 'the new note is untouched');
  fs.rmSync(at(two));

  // Undo pressed twice: one comes back, the second says the bin no longer has it, and no copy appears.
  put(rel, bytes);
  const t2 = (await nb.remove(rel)).trashed;
  const twice = await Promise.allSettled([nb.restore(t2, rel), nb.restore(t2, rel)]);
  assert.deepStrictEqual(twice.map((r) => r.status), ['fulfilled', 'rejected']);
  assert.match(twice[1].reason.message, GONE);
  assert.ok(!fs.existsSync(at(two)));

  // Two copies of the same note restored at once (two deletes in one millisecond share a trash name, so
  // the second is written straight into the bin): both come back, neither over the other.
  const t3 = (await nb.remove(rel)).trashed;
  fs.writeFileSync(path.join(vault, '.trash', '1-Eigen.md'), 'the older copy');
  const both = await Promise.all([nb.restore(t3, rel), nb.restore('.trash/1-Eigen.md', rel)]);
  assert.deepStrictEqual(both, [{ path: rel }, { path: two }]);
  assert.ok(fs.readFileSync(at(rel)).equals(bytes));
  assert.strictEqual(fs.readFileSync(at(two), 'utf8'), 'the older copy');

  // Refused: anything that isn't a note in the bin, or a place that isn't one of the user's notes.
  const t4 = (await nb.remove(two)).trashed;
  const before = files();
  for (const bad of ['../x.md', '.trash/../../x.md', 'Notes/a.md', '', '.trash/sub/x.md', '.trash/x.txt', `${t4}/..`]) await assert.rejects(nb.restore(bad, rel), GONE, bad);
  await assert.rejects(nb.restore('.trash/missing.md', 'Notes/x.md'), GONE);
  for (const bad of ['Secret/x.md', 'Notes/../x.md', '', 'Notes/Notes.md', 'Notes\\x.md', '../outside.md']) await assert.rejects(nb.restore(t4, bad), /not one of your notes/, bad);
  assert.deepStrictEqual(files(), before, 'the refused calls changed nothing');
  assert.deepStrictEqual(await nb.restore(t4, two), { path: two }, 'the bin still has it');

  // A note written at the name after the check and before the move (the assistant, another app): it stays,
  // and the old one takes the next free name (regression: a rename replaced it, on Windows too).
  const t5 = (await nb.remove(rel)).trashed;
  const mkdir = fs.promises.mkdir;
  fs.promises.mkdir = async (...a) => {
    const made = await mkdir(...a);
    if (path.resolve(String(a[0])) === path.dirname(at(rel))) {
      fs.promises.mkdir = mkdir;
      fs.writeFileSync(at(rel), 'written meanwhile');
    }
    return made;
  };
  try {
    assert.deepStrictEqual(await nb.restore(t5, rel), { path: 'Notes/Lecture/Eigen 3.md' });
  } finally {
    fs.promises.mkdir = mkdir;
  }
  assert.strictEqual(fs.readFileSync(at(rel), 'utf8'), 'written meanwhile', 'the note written meanwhile is untouched');
  assert.ok(fs.readFileSync(at('Notes/Lecture/Eigen 3.md')).equals(bytes), 'the old one came back beside it');
  assert.strictEqual(fs.readFileSync(at(two), 'utf8'), 'the older copy');
  assert.ok(!fs.existsSync(path.join(vault, t5)), 'and left the bin');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Efficiency pass: summary() (the Inner World, the phone's Today and Notes) ran the full list(): a stat and a
// read of every note, one after another. It now stats them in batches and reads only today's notes.
test('summary() gives what list() gave, reading only today’s notes', async () => {
  const vault = tmpDir('nexus-nbsummary-');
  const put = (rel, text, daysAgo = 0) => {
    const full = path.join(vault, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
    const t = new Date(Date.now() - daysAgo * 86400000);
    fs.utimesSync(full, t, t);
  };
  put('Notes/Plain.md', 'today, unpinned');
  put('Notes/Pinned today.md', '---\npinned: true\n---\ntoday and pinned');
  put('Notes/Robotics/Arm.md', 'old', 3);
  put('Notes/Robotics/Leg.md', 'older', 5);
  put('Notes/Robotics/Hand.md', 'new');
  put('Notes/Math/Eigen.md', 'old', 2);
  put('Inbox/Quick.md', 'dump', 1);
  put('Notes/Notes.md', '- the folder index, not a note');
  put('Notes/Big.md', 'x'.repeat(2000001));
  stub({ './logger': quietLog, './obsidian': { vaultPath: async () => vault }, './linkindex': { forNote: async () => ({ backlinks: [] }) } });
  const nb = load('main/notebook.js');
  const { notes, today } = await nb.list();
  const before = { count: notes.length, today: notes.filter((n) => n.day === today).map((n) => n.title), notebooks: core.notebooks(notes, today) };
  const reads = [];
  const realRead = fs.promises.readFile;
  fs.promises.readFile = (f, ...rest) => (reads.push(path.relative(vault, String(f)).split(path.sep).join('/')), realRead(f, ...rest));
  let after;
  try {
    after = await nb.summary();
  } finally {
    fs.promises.readFile = realRead;
  }
  assert.deepStrictEqual(after, before);
  assert.deepStrictEqual([...after.today].sort(), ['Hand', 'Pinned today', 'Plain']);
  assert.strictEqual(after.today[0], 'Pinned today', 'pinned first');
  assert.strictEqual(after.count, 7, 'the folder index and the too-big file are not counted');
  assert.deepStrictEqual(reads.sort(), ['Notes/Pinned today.md', 'Notes/Plain.md', 'Notes/Robotics/Hand.md']);
  // No notes at all: empty, not an error.
  const bare = tmpDir('nexus-nbsummary0-');
  stub({ './obsidian': { vaultPath: async () => bare } });
  assert.deepStrictEqual(await load('main/notebook.js').summary(), { count: 0, today: [], notebooks: [] });
  fs.rmSync(vault, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});
