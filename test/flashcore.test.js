// Flashcard decks as Markdown (main/flashcore.js): the format, hand-typed cards, cloze, the study
// queue with Anki's daily limits.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../main/flashcore');

const T0 = Date.parse('2026-10-27T10:00:00');

test('a deck round-trips: options, notes, cards with schedules; hand-typed cards are completed', () => {
  const text = [
    '---',
    'type: flashcards',
    'scheduler: fsrs',
    'new_per_day: 5',
    '---',
    '# Biology',
    '',
    'My notes about the deck.',
    'ATP :: the cell’s energy currency',
    'Hund ::: dog',
    '',
    '<!-- card {"id":"abc123","type":"review","due":"2026-11-02","ivl":6,"ease":2.5,"reps":3} -->',
    'What do mitochondria make?',
    '?',
    'ATP',
    'in two lines',
    '',
    '<!-- card -->',
    'The {{c1::nucleus}} holds the {{c2::DNA::molecule}}.',
  ].join('\n');
  const d = core.parseDeck(text, 'file');
  assert.strictEqual(d.name, 'Biology');
  assert.deepStrictEqual(d.options, { scheduler: 'fsrs', newPerDay: 5 });
  assert.strictEqual(d.changed, true);
  assert.deepStrictEqual(d.cards.map((c) => [c.front, c.cloze]), [['ATP', 0], ['Hund', 0], ['dog', 0], ['What do mitochondria make?', 0], ['The {{c1::nucleus}} holds the {{c2::DNA::molecule}}.', 1], ['The {{c1::nucleus}} holds the {{c2::DNA::molecule}}.', 2]]);
  assert.strictEqual(d.cards[3].back, 'ATP\nin two lines');
  assert.deepStrictEqual([d.cards[3].id, d.cards[3].sched.ivl, d.cards[3].sched.due], ['abc123', 6, '2026-11-02']);
  assert.ok(d.cards.every((c) => /^[\w-]{3,}$/.test(c.id)) && new Set(d.cards.map((c) => c.id)).size === 6);
  const out = core.serializeDeck(d);
  assert.match(out, /^---\ntype: flashcards\nscheduler: fsrs\nnew_per_day: 5\n---\n# Biology/);
  assert.ok(!out.includes(' :: '), 'one-line cards became blocks');
  const again = core.parseDeck(out);
  assert.strictEqual(again.changed, false, 'a written deck is stable');
  assert.deepStrictEqual(again.cards.map((c) => [c.id, c.front, c.back, c.cloze]), d.cards.map((c) => [c.id, c.front, c.back, c.cloze]));
});

test('cloze cards hide only their own part; a "?" line inside a side is kept as text', () => {
  const card = { front: 'The {{c1::nucleus}} holds the {{c2::DNA::molecule}}.', back: 'Extra', cloze: 2 };
  assert.deepStrictEqual(core.render(card), { front: 'The nucleus holds the **[molecule]**.', back: 'The nucleus holds the **[DNA]**.\n\nExtra' });
  assert.strictEqual(core.render({ ...card, cloze: 1 }).front, 'The **[…]** holds the DNA.');
  const deck = { name: 'X', fm: {}, before: '# X', cards: [{ id: 'q1q1q1', front: 'Odd\n?\nline', back: 'b', cloze: 0, tags: [], sched: { type: 'new' } }] };
  const back = core.parseDeck(core.serializeDeck(deck));
  assert.strictEqual(back.cards.length, 1);
  assert.strictEqual(back.cards[0].back, 'b');
});

test('the queue: learning first, then due reviews, then new cards within the daily limits', () => {
  const mk = (id, sched) => ({ id, front: id, back: '', cloze: 0, tags: [], sched });
  const deck = {
    options: { newPerDay: 2, reviewsPerDay: 1 },
    cards: [
      mk('n1', { type: 'new' }),
      mk('n2', { type: 'new' }),
      mk('n3', { type: 'new' }),
      mk('r1', { type: 'review', due: '2026-10-26', ivl: 3 }),
      mk('r2', { type: 'review', due: '2026-10-25', ivl: 5 }),
      mk('r3', { type: 'review', due: '2026-11-20', ivl: 9 }),
      mk('l1', { type: 'learn', step: 1, dueAt: T0 + 5 * 60000 }),
      mk('s1', { type: 'review', due: '2026-10-20', suspended: true }),
    ],
  };
  const q = core.queue(deck, T0, {});
  assert.deepStrictEqual(q.counts, { new: 2, learn: 1, review: 1, total: 8, suspended: 1 });
  assert.strictEqual(q.next.id, 'r2', 'the oldest due review (the learning card is 5 minutes away)');
  const later = core.queue(deck, T0 + 6 * 60000, {});
  assert.strictEqual(later.next.id, 'l1', 'a learning card due now comes first');
  const done = core.queue(deck, T0, { new: 2, review: 1 });
  assert.strictEqual(done.next.id, 'l1', 'limits reached: the learning card is shown up to 20 minutes early');
  const empty = core.queue({ options: {}, cards: [mk('l2', { type: 'learn', dueAt: T0 + 3600000 })] }, T0, {});
  assert.strictEqual(empty.next, null);
  assert.strictEqual(empty.laterAt, T0 + 3600000);
});

test('grading a card, adding cards without duplicates, the deck summary', () => {
  const deck = { options: {}, cards: [] };
  const { deck: d1, added } = core.addCards(deck, [{ front: 'One', back: '1' }, { front: 'one ', back: 'dup' }, { front: 'A {{c1::cloze}} and {{c2::two}}' }, { front: '' }]);
  assert.strictEqual(added.length, 3, 'one basic (the duplicate skipped) and two cloze cards');
  const g = core.grade(d1, added[0].id, 'easy', T0);
  assert.deepStrictEqual([g.card.sched.type, g.card.sched.ivl, g.wasNew], ['review', 4, true]);
  assert.strictEqual(g.before.sched.type, 'new');
  const s = core.summary(g.deck, T0, { new: 1 });
  assert.deepStrictEqual([s.total, s.new, s.unseen, s.young, s.mature], [3, 2, 2, 1, 0]);
  assert.throws(() => core.grade(d1, 'nope', 'good', T0), /not in this deck/);
});
