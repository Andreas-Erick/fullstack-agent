// Learning support: the understanding tracker (main/learningcore.js), vocabulary decks with spaced
// repetition (main/srs.js), both through the vault (main/learning.js), and the bundled learning skills.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir } = require('./helpers');

const vault = tmpDir('nexus-learning-');
let today = '2026-10-25';
stub({
  './obsidian': {
    vaultPath: async () => vault,
    ymd: () => today,
    readOptional: async (rel) => {
      try {
        return fs.readFileSync(path.join(vault, rel), 'utf8');
      } catch {
        return '';
      }
    },
    writeNote: async (rel, text) => {
      fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
      fs.writeFileSync(path.join(vault, rel), text);
      return { path: rel };
    },
  },
});
const core = load('main/learningcore.js');
const srs = load('main/srs.js');
const learning = load('main/learning.js');
test.after(() => fs.rmSync(vault, { recursive: true, force: true }));

test('the tracker records, deduplicates and resolves', () => {
  let note = core.parse('', 'Real Analysis');
  note = core.merge(note, { shaky: ['Uniform continuity'], questions: ['Why does compactness give uniform continuity?'], misconceptions: ['Thought δ may depend on x in uniform continuity → it may not'], log: 'Continuity, part 1' }, '2026-10-24');
  note = core.merge(note, { shaky: ['Uniform continuity — still mixing up quantifier order'] }, '2026-10-25');
  assert.strictEqual(note.sections.shaky.length, 1, 'same concept, one entry (the newest)');
  assert.match(note.sections.shaky[0], /quantifier order \(2026-10-25\)$/);
  note = core.merge(note, { resolved: ['uniform continuity'], understood: ['Epsilon-delta limits — δ keeps f(x) within ε'] }, '2026-10-25');
  assert.strictEqual(note.sections.shaky.length, 0);
  assert.ok(note.sections.understood.some((x) => /^Uniform continuity/.test(x)));
  assert.strictEqual(note.sections.misconceptions.length, 1, 'misconceptions stay as history');
  const again = core.parse(core.serialize(note, '2026-10-25'));
  assert.deepStrictEqual(again.sections, note.sections, 'the note round-trips');
  assert.strictEqual(again.topic, 'Real Analysis');
});

test('hand-written parts of a tracker note survive', () => {
  const text = '---\ntype: learning\n---\n# Topology\n\nMy own intro.\n\n## Understood\n- Open sets\n\n## My diagrams\n- see sketch\n';
  const note = core.merge(core.parse(text), { shaky: ['Compactness'] }, '2026-10-25');
  const out = core.serialize(note, '2026-10-25');
  assert.ok(out.includes('My own intro.') && out.includes('## My diagrams') && out.includes('- Open sets') && out.includes('- Compactness (2026-10-25)'));
});

test('topic names become safe file names', () => {
  assert.strictEqual(core.fileName('C++ / Rust: ownership?'), 'C++ Rust ownership.md');
  assert.throws(() => core.fileName('  '), /name/);
});

test('SM-2 scheduling: again comes back today, good grows the interval', () => {
  let c = { front: 'hola', due: '', ivl: 0, ease: 2.5, reps: 0, lapses: 0 };
  c = srs.schedule(c, 'good', '2026-10-25');
  assert.deepStrictEqual([c.ivl, c.due, c.reps], [1, '2026-10-26', 1]);
  c = srs.schedule(c, 'good', '2026-10-26');
  assert.deepStrictEqual([c.ivl, c.due], [3, '2026-10-29']);
  c = srs.schedule(c, 'good', '2026-10-29');
  assert.strictEqual(c.ivl, 8); // round(3 × 2.5)
  c = srs.schedule(c, 'again', '2026-11-06');
  assert.deepStrictEqual([c.ivl, c.due, c.reps, c.lapses], [0, '2026-11-06', 0, 1]);
  assert.ok(c.ease < 2.5 && c.ease >= 1.3);
  assert.throws(() => srs.schedule(c, 'perfect', '2026-11-06'), /Grade/);
});

test('decks round-trip as readable Markdown and keep notes around the cards', () => {
  const text = '# Spanish\n\nMy notes.\n\n- **el desarrollo** — development · _El desarrollo es lento._ <!-- srs due=2026-10-26 ivl=1 ease=2.50 reps=1 lapses=0 -->\n- **echar de menos** — to miss (someone)\n\n## Later\nmore';
  const deck = srs.parseDeck(text);
  assert.strictEqual(deck.cards.length, 2);
  assert.deepStrictEqual(deck.cards[0], { front: 'el desarrollo', back: 'development', example: 'El desarrollo es lento.', due: '2026-10-26', ivl: 1, ease: 2.5, reps: 1, lapses: 0 });
  assert.strictEqual(deck.cards[1].due, '', 'a hand-added card is new');
  const out = srs.serializeDeck(deck);
  assert.ok(out.startsWith('# Spanish\n\nMy notes.') && out.includes('## Later\nmore'));
  assert.deepStrictEqual(srs.parseDeck(out).cards, deck.cards);
  const { deck: more, added } = srs.addCards(deck, [{ front: 'El Desarrollo', back: 'x' }, { front: 'la vivienda', back: 'housing' }]);
  assert.deepStrictEqual(added, ['la vivienda'], 'no duplicate, case-insensitive');
  assert.strictEqual(more.cards.length, 3);
});

test('reviews: due cards first, then a few new ones', () => {
  const deck = srs.parseDeck(['- **a** — 1 <!-- srs due=2026-10-20 ivl=3 ease=2.5 reps=2 lapses=0 -->', '- **b** — 2 <!-- srs due=2026-11-20 ivl=9 ease=2.5 reps=3 lapses=0 -->', '- **c** — 3', '- **d** — 4'].join('\n'));
  const r = srs.dueCards(deck, '2026-10-25', { limit: 10, newLimit: 1 });
  assert.deepStrictEqual(r.cards.map((c) => c.front), ['a', 'c']);
  assert.deepStrictEqual([r.dueCount, r.newCount, r.total, r.nextDue], [1, 2, 4, '2026-11-20']);
});

test('through the vault: tracker, deck, review and the agent\'s summary', async () => {
  today = '2026-10-25';
  const u = await learning.update('Linear Algebra', { understood: ['Eigenvectors — directions a matrix only stretches'], shaky: ['Diagonalization'], questions: ['When is a matrix not diagonalizable?'] });
  assert.strictEqual(u.created, true);
  assert.ok(fs.existsSync(path.join(vault, 'Learning', 'Linear Algebra.md')));
  fs.writeFileSync(path.join(vault, 'Learning', 'Learning.md'), '# Learning\n(folder index)');
  const topics = await learning.topics();
  assert.deepStrictEqual(topics.map((t) => t.topic), ['Linear Algebra'], 'the folder index is not a topic');

  const add = await learning.addCards('Spanish', [{ front: 'echar de menos', back: 'to miss (someone)', example: 'Te echo de menos.' }]);
  assert.deepStrictEqual(add.added, ['echar de menos']);
  const due = await learning.due('Spanish', { limit: 5 });
  assert.strictEqual(due.cards.length, 1);
  const g = await learning.gradeCard('Spanish', 'echar de menos', 'good');
  assert.strictEqual(g.nextReview, '2026-10-26');
  assert.strictEqual((await learning.due('Spanish')).cards.length, 0, 'graded: not due again today');

  const block = await learning.promptBlock();
  assert.match(block, /Linear Algebra: 1 understood; shaky: diagonalization; open: when is a matrix not diagonalizable/);
  assert.match(block, /Spanish deck: 1 cards, 0 due today/);
});

test('the bundled learning skills are well-formed', () => {
  const dir = path.join(__dirname, '..', 'main', 'skills');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(text, /^---\nname: .+\ndescription: .+\ntriggers: .*\ninput: .*\ncreated: \d{4}-\d{2}-\d{2}\nupdated: \d{4}-\d{2}-\d{2}\n---\n1\. /, f);
  }
});
