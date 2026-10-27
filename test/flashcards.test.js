// Studying flashcards (main/flashcards.js) against a real vault folder: hand-typed cards keep their ids
// between reads, and mixed learning (mixcore.js): interleaving, the scheduled mode counts answers, the
// practice mode changes nothing, undo, odd input (unknown sessions, bad grades, fast double answers).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
const mix = require('../main/mixcore');
const core = require('../main/flashcore');

const dir = tmpDir('siren-fc-');
const vault = path.join(dir, 'vault');
const notes = (rel) => path.join(vault, rel);
stub({
  './logger': quietLog,
  './store': fileStore(dir, { getSettings: async () => ({ documents: { workspace: dir } }) }),
  './obsidian': {
    vaultPath: async () => vault,
    readOptional: async (rel) => (fs.existsSync(notes(rel)) ? fs.readFileSync(notes(rel), 'utf8') : ''),
    writeNote: async (rel, text) => {
      fs.mkdirSync(path.dirname(notes(rel)), { recursive: true });
      fs.writeFileSync(notes(rel), text);
      return { path: rel };
    },
    deleteNote: async (rel) => fs.rmSync(notes(rel)),
    ymd: () => '2026-10-27',
  },
});
const fc = load('main/flashcards.js');

// Decks typed by hand (as in Obsidian): no ids or schedules yet.
function writeDecks() {
  fs.rmSync(vault, { recursive: true, force: true });
  fs.mkdirSync(path.join(vault, 'Flashcards'), { recursive: true });
  fs.writeFileSync(notes('Flashcards/Biology.md'), '# Biology\n\nATP? :: Energy currency\nOsmosis? :: Water diffusion\nRibosome? :: Makes proteins\n');
  fs.writeFileSync(notes('Flashcards/Physics.md'), '# Physics\n\nF = ? :: m·a\nUnit of force? :: Newton\n');
  fs.writeFileSync(notes('Flashcards/History.md'), '# History\n\n1066? :: Battle of Hastings\n');
  fs.rmSync(path.join(dir, 'flashcards-days.json'), { force: true });
}

// A seeded random source, so the shuffles are the same on every run.
function seeded(seed = 7) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

test('hand-typed cards keep the same id on every read (regression: random ids lost the answer)', async () => {
  const text = 'Q1 :: A1\nQ2 :: A2\n\n<!-- card -->\nThe {{c1::heart}} pumps {{c2::blood}}.\n';
  const a = core.parseDeck(text, 'x').cards.map((c) => c.id);
  const b = core.parseDeck(text, 'x').cards.map((c) => c.id);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(new Set(a).size, a.length, 'unique, cloze cards included');
  const twice = core.parseDeck('Same :: card\nSame :: card\n', 'x').cards.map((c) => c.id);
  assert.notStrictEqual(twice[0], twice[1], 'an identical line copied twice still gets two ids');
  assert.deepStrictEqual(twice, core.parseDeck('Same :: card\nSame :: card\n', 'x').cards.map((c) => c.id));
  writeDecks();
  const first = await fc.next('f:Biology');
  const r = await fc.answer('f:Biology', first.card.id, 'good');
  assert.strictEqual(r.studiedToday, 1, 'the answer to a hand-typed card was saved');
});

test('mixcore: never the same deck twice in a row while another has cards', () => {
  const rand = seeded();
  let last = '';
  for (let i = 0; i < 200; i++) {
    const id = mix.pickDeck([{ id: 'a', weight: 50 }, { id: 'b', weight: 1 }], last, rand);
    assert.notStrictEqual(id, last);
    last = id;
  }
  assert.strictEqual(mix.pickDeck([{ id: 'a', weight: 3 }], 'a'), 'a', 'one deck left: it continues');
  assert.strictEqual(mix.pickDeck([{ id: 'a', weight: 0 }]), null);
  assert.strictEqual(mix.pickDeck([]), null);
  assert.strictEqual(mix.pickDeck(null), null);
});

test('mixcore: a practice round has every card once, spread across decks', () => {
  const cards = [...Array(6)].map((_, i) => ({ deck: 'a', id: `a${i}` })).concat([...Array(5)].map((_, i) => ({ deck: 'b', id: `b${i}` })));
  const order = mix.interleave(cards, seeded(3));
  assert.deepStrictEqual(order.map((c) => c.id).sort(), cards.map((c) => c.id).sort());
  let same = 0;
  for (let i = 1; i < order.length; i++) if (order[i].deck === order[i - 1].deck) same++;
  assert.ok(same <= 1, `${same} neighbours from the same deck`);
  assert.deepStrictEqual(mix.interleave([]), []);
  const one = mix.interleave([{ deck: 'a', id: 'x' }, { deck: 'a', id: 'y' }]);
  assert.strictEqual(one.length, 2, 'a single deck still works');
  // "again": back a few cards later, never lost, never at once.
  const re = mix.requeue(['p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x'], 0, 'p', () => 0);
  assert.strictEqual(re.indexOf('p', 1), 4);
  assert.strictEqual(mix.requeue(['p'], 0, 'p').length, 2, 'at the end of a short round');
});

test('mixed review: today\'s due cards from every deck, interleaved, and the answers count', async () => {
  writeDecks();
  let v = await fc.mixStart({ mode: 'due' });
  assert.strictEqual(v.mode, 'due');
  assert.strictEqual(v.decks, 3);
  assert.strictEqual(v.counts.new, 6);
  const seen = [];
  for (let i = 0; i < 12 && v.card; i++) {
    seen.push(v.deck.id);
    v = await fc.mixAnswer(v.session, 'easy');
  }
  assert.strictEqual(v.card, null, 'all done');
  assert.strictEqual(seen.length, 6);
  for (let i = 1; i < seen.length - 1; i++) assert.ok(seen[i] !== seen[i - 1] || seen.slice(i).every((d) => d === seen[i]), `deck ${seen[i]} twice in a row at ${i} while others had cards`);
  const decks = (await fc.decks()).decks;
  assert.strictEqual(decks.reduce((n, d) => n + d.studiedToday, 0), 6, 'every answer reached its deck');
  assert.strictEqual(decks.reduce((n, d) => n + d.dueNow, 0), 0);
});

test('mixed review over chosen decks only; unknown decks are ignored, none at all is an error', async () => {
  writeDecks();
  const v = await fc.mixStart({ mode: 'due', decks: ['f:Physics', 'f:Nope'] });
  assert.strictEqual(v.decks, 1);
  assert.strictEqual(v.deck.id, 'f:Physics');
  await assert.rejects(() => fc.mixStart({ mode: 'due', decks: ['f:Nope'] }).then((x) => (x.decks ? x : Promise.reject(new Error('none')))), /none|No decks/);
});

test('shuffle everything: every card once, "again" comes back, no schedule changes', async () => {
  writeDecks();
  const before = fs.readFileSync(notes('Flashcards/Biology.md'), 'utf8');
  let v = await fc.mixStart({ mode: 'all' });
  assert.strictEqual(v.mode, 'all');
  assert.strictEqual(v.counts.total, 6);
  assert.strictEqual(v.card.preview.again, 'again soon');
  const missed = v.card.id;
  v = await fc.mixAnswer(v.session, 'again');
  const ids = [];
  for (let i = 0; i < 20 && v.card; i++) {
    ids.push(v.card.id);
    v = await fc.mixAnswer(v.session, 'good');
  }
  assert.strictEqual(v.card, null);
  assert.ok(ids.includes(missed), 'the missed card came back');
  assert.strictEqual(ids.length, 6, 'five others plus the one missed');
  assert.deepStrictEqual(v.stats, { answered: 7, right: 6 });
  assert.strictEqual(fs.readFileSync(notes('Flashcards/Biology.md'), 'utf8'), before, 'the deck note is untouched');
  assert.strictEqual((await fc.decks()).decks.reduce((n, d) => n + d.studiedToday, 0), 0, 'nothing counted for the schedule');
});

test('undo: practice steps back through several answers; scheduled mode takes back the last one', async () => {
  writeDecks();
  let v = await fc.mixStart({ mode: 'all' });
  const first = v.card.id;
  v = await fc.mixAnswer(v.session, 'good');
  v = await fc.mixAnswer(v.session, 'good');
  v = await fc.mixUndo(v.session);
  v = await fc.mixUndo(v.session);
  assert.strictEqual(v.card.id, first);
  assert.deepStrictEqual(v.stats, { answered: 0, right: 0 });
  await assert.rejects(() => fc.mixUndo(v.session), /Nothing to undo/);

  let d = await fc.mixStart({ mode: 'due' });
  const card = d.card.id;
  d = await fc.mixAnswer(d.session, 'good');
  assert.strictEqual(d.canUndo, true);
  d = await fc.mixUndo(d.session);
  assert.strictEqual(d.card.id, card, 'the same card again');
  assert.strictEqual((await fc.decks()).decks.reduce((n, x) => n + x.studiedToday, 0), 0, 'the count went back too');
});

test('odd input: unknown or stale sessions, bad grades, a double tap on one card', async () => {
  writeDecks();
  await assert.rejects(() => fc.mixNext('nope'), /ended/);
  await assert.rejects(() => fc.mixAnswer('', 'good'), /ended/);
  const v = await fc.mixStart({ mode: 'due' });
  await assert.rejects(() => fc.mixAnswer(v.session, 'great'), /Grade must be/);
  // The same answer sent twice at once for one card (a double tap, a slow phone resending): graded once.
  const shown = v.card.id;
  const [a, b] = await Promise.all([fc.mixAnswer(v.session, 'easy', shown), fc.mixAnswer(v.session, 'easy', shown)]);
  assert.strictEqual(b.stats.answered, 1, 'the second tap was ignored');
  assert.strictEqual(a.card.id, b.card.id, 'both see the same next card');
  assert.notStrictEqual(b.card.id, shown);
  assert.strictEqual((await fc.decks()).decks.reduce((n, d) => n + d.studiedToday, 0), 1);
  // Ten quick answers without card ids (the assistant in a chat): each grades the next card, in order.
  const burst = await Promise.all([...Array(10)].map(() => fc.mixAnswer(v.session, 'easy')));
  assert.strictEqual(burst.at(-1).stats.answered, 6, 'six cards in all, then nothing left to answer');
  assert.strictEqual(burst.at(-1).card, null);
  assert.strictEqual((await fc.decks()).decks.reduce((n, d) => n + d.studiedToday, 0), 6);
  // A deck deleted mid-session: the session carries on with the others.
  fs.rmSync(notes('Flashcards/History.md'));
  const after = await fc.mixNext(v.session);
  assert.ok(!after.card || after.deck.id !== 'f:History');
});

test('mixed review: reopening the screen keeps the card that is shown (regression: it re-rolled)', async () => {
  writeDecks();
  const v = await fc.mixStart({ mode: 'due' });
  for (let i = 0; i < 8; i++) assert.strictEqual((await fc.mixNext(v.session)).card.id, v.card.id);
});

test('a deck: the same card answered twice in a row (double tap) is graded once', async () => {
  writeDecks();
  const first = await fc.next('f:Physics');
  await Promise.all([fc.answer('f:Physics', first.card.id, 'good'), fc.answer('f:Physics', first.card.id, 'good')]);
  const r = await fc.next('f:Physics');
  assert.strictEqual(r.studiedToday, 1);
  await assert.rejects(() => fc.answer('f:Physics', 'no-such-card', 'good'), /./, 'an unknown card is an error, not a crash');
});

test('a deck emptied or edited mid-practice: missing cards are skipped, not shown blank', async () => {
  writeDecks();
  let v = await fc.mixStart({ mode: 'all', decks: ['f:Biology', 'f:History'] });
  fs.writeFileSync(notes('Flashcards/Biology.md'), '# Biology\n');
  let n = 0;
  while (v.card && n < 10) {
    assert.ok(v.card.front, 'a card with a front');
    v = await fc.mixAnswer(v.session, 'good');
    n++;
  }
  assert.ok(n <= 2, `only what is still there (${n})`);
});
