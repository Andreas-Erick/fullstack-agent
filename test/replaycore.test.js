// History replays (main/replaycore.js): git log parsing (numstat and name-status, renames, binaries),
// commit kinds, and the vault laid out as a map the Architecture renderer can draw.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../main/replaycore');

const head = (sha, ts, author, subject) => `${sha}\x1f${ts}\x1f${author}\x1f${subject}`;

test('numstat logs become commits with added and removed lines, renames and binaries handled', () => {
  const text = [
    head('a1', 1700000000, 'Andreas', 'Baseline: initial version'),
    '10\t0\tmain/llm.js',
    '-\t-\tassets/icon.png',
    '',
    head('b2', 1700000600, 'Siren Assistant', '[self-change] Faster replies'),
    '3\t1\tmain/llm.js',
    '5\t5\t{src => lib}/x.js',
    '1\t0\told.js => new.js',
    '',
  ].join('\n');
  const c = core.parseLog(text);
  assert.strictEqual(c.length, 2);
  assert.deepStrictEqual(c[0].files, [{ path: 'main/llm.js', status: 'M', added: 10, removed: 0 }, { path: 'assets/icon.png', status: 'M', added: 0, removed: 0 }]);
  assert.strictEqual(c[0].kind, 'baseline');
  assert.strictEqual(c[0].at, 1700000000000);
  assert.strictEqual(c[1].kind, 'self');
  assert.deepStrictEqual(c[1].files.map((f) => [f.path, f.status]), [['main/llm.js', 'M'], ['src/x.js', 'D'], ['lib/x.js', 'R'], ['old.js', 'D'], ['new.js', 'R']]);
});

test('name-status logs: adds, deletes and renames; a subject containing the separator survives', () => {
  const text = [head('c3', 1, 'Siren Assistant', 'Updated Notes/a.md'), 'A\tNotes/a.md', 'M\tNotes/b.md', 'D\tNotes/c.md', 'R090\tNotes/d.md\tNotes/e.md', 'T\tNotes/f.md'].join('\n');
  const [c] = core.parseLog(text, { kinds: core.classifyVault });
  assert.strictEqual(c.kind, 'self');
  assert.deepStrictEqual(c.files.map((f) => `${f.status}:${f.path}`), ['A:Notes/a.md', 'M:Notes/b.md', 'D:Notes/c.md', 'D:Notes/d.md', 'R:Notes/e.md', 'M:Notes/f.md']);
  assert.strictEqual(core.parseLog('').length, 0);
});

test('commit kinds: self-changes, reverts, releases, people', () => {
  assert.strictEqual(core.classifyApp('[self-change] x'), 'self');
  assert.strictEqual(core.classifyApp('Revert "x"'), 'revert');
  assert.strictEqual(core.classifyApp('Restore to abc: x'), 'revert');
  assert.strictEqual(core.classifyApp('Siren Assistant 2.0.3'), 'release');
  assert.strictEqual(core.classifyApp('Fix a thing'), 'manual');
  assert.strictEqual(core.classifyVault('Vault history started', 'Siren Assistant'), 'baseline');
  assert.strictEqual(core.classifyVault('Edited', 'Nexus Agent'), 'self');
  assert.strictEqual(core.classifyVault('Edited', 'Andreas'), 'manual');
  assert.strictEqual(core.cleanSubject('[self-change]   Tidy  '), 'Tidy');
});

test('the vault map: one container, a component per folder, a file per note, laid out without overlaps', () => {
  const commits = core.parseLog([head('a', 1, 'S', 'Vault history started'), '3\t0\tNotes/A.md', '2\t0\tNotes/Deep/B.md', '1\t0\tRoot.md', '5\t0\t.obsidian/app.json', '2\t0\tImage.png', '', head('b', 2, 'S', 'x'), '0\t3\tNotes/A.md', '4\t0\tNotes/A.md'].join('\n'));
  const { paths, lines } = core.pathsOf(commits);
  assert.strictEqual(lines['Notes/A.md'], 4);
  const m = core.vaultMap(paths, { lines });
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  assert.strictEqual(m.stats.files, 3, 'only notes');
  assert.strictEqual(m.stats.components, 3, 'Notes, Notes / Deep, the root');
  assert.strictEqual(byId.get('f:Notes/Deep/B.md').name, 'B');
  assert.strictEqual(byId.get(byId.get('f:Notes/Deep/B.md').parent).name, 'Notes / Deep');
  assert.strictEqual(byId.get('f:Root.md').kindLabel, 'Note');
  assert.deepStrictEqual(m.nouns, { container: 'folder', component: 'folder', file: 'note' });
  for (const n of m.nodes) {
    assert.ok(n.w > 0 && n.h > 0 && Number.isFinite(n.x) && Number.isFinite(n.y), `${n.id} is placed`);
    const p = n.parent && byId.get(n.parent);
    if (p) assert.ok(n.x >= p.x && n.y >= p.y && n.x + n.w <= p.x + p.w && n.y + n.h <= p.y + p.h, `${n.id} inside ${p.id}`);
  }
  const files = m.nodes.filter((n) => n.level === 'file');
  for (let i = 0; i < files.length; i++)
    for (let j = i + 1; j < files.length; j++) {
      const [a, b] = [files[i], files[j]];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id} overlap`);
    }
  assert.ok(core.vaultMap([]).bounds.w > 0, 'an empty vault still has bounds');
});
