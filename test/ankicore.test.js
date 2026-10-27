// Anki's scheduler (main/ankicore.js): SM-2 as Anki's v3 scheduler runs it, and FSRS-5.
const test = require('node:test');
const assert = require('node:assert');
const a = require('../main/ankicore');

const T0 = Date.parse('2026-10-27T10:00:00');
const MIN = 60000;
const at = (s) => Date.parse(s);
const run = (card, steps, cfg = {}) => steps.reduce((c, [g, when]) => a.answer(c, g, at(when), cfg, 'seed').card, card);

test('a new card: the learning steps 1m and 10m, then it graduates to 1 day; Easy skips to 4 days', () => {
  assert.deepStrictEqual(a.preview(a.fresh(), T0, {}, 'x'), { again: '1m', hard: '6m', good: '10m', easy: '4d' });
  let c = a.answer(a.fresh(), 'good', T0, {}, 'x').card;
  assert.deepStrictEqual([c.type, c.step, c.dueAt - T0], ['learn', 1, 10 * MIN]);
  assert.strictEqual(a.preview(c, T0 + 10 * MIN, {}, 'x').hard, '10m', 'Hard repeats the current step');
  c = a.answer(c, 'good', T0 + 10 * MIN, {}, 'x').card;
  assert.deepStrictEqual([c.type, c.ivl, c.due, c.ease], ['review', 1, '2026-10-28', 2.5]);
  const easy = a.answer(a.fresh(), 'easy', T0, {}, 'x').card;
  assert.deepStrictEqual([easy.type, easy.ivl, easy.due], ['review', 4, '2026-10-31']);
  const again = a.answer(c.type === 'review' ? a.answer(a.fresh(), 'good', T0, {}, 'x').card : c, 'again', T0 + MIN, {}, 'x').card;
  assert.deepStrictEqual([again.type, again.step, again.dueAt - (T0 + MIN)], ['learn', 0, MIN], 'Again goes back to the first step');
});

test('reviews: Hard × 1.2, Good × ease, Easy × ease × 1.3, ease moves by 0.15, the order always holds', () => {
  const card = { type: 'review', ivl: 10, ease: 2.5, due: '2026-10-27', reps: 5, lapses: 0, last: '2026-10-17' };
  const noFuzz = { fuzz: false };
  const pick = (g) => a.answer(card, g, T0, noFuzz, 'x').card;
  assert.deepStrictEqual([pick('hard').ivl, pick('good').ivl, pick('easy').ivl], [12, 25, 33]);
  assert.deepStrictEqual([pick('hard').ease, pick('good').ease, pick('easy').ease], [2.35, 2.5, 2.65]);
  // Late by 4 days: Good gets half the delay, Easy all of it (Anki v3).
  const late = { ...card, due: '2026-10-23' };
  assert.strictEqual(a.answer(late, 'good', T0, noFuzz, 'x').card.ivl, 30);
  assert.strictEqual(a.answer(late, 'easy', T0, noFuzz, 'x').card.ivl, Math.round(14 * 2.5 * 1.3));
  for (const ivl of [1, 2, 3, 7, 30, 400]) {
    const c = { ...card, ivl };
    const [h, g, e] = ['hard', 'good', 'easy'].map((x) => a.answer(c, x, T0, {}, `s${ivl}`).card.ivl);
    assert.ok(h > ivl - (ivl > 1 ? 0 : 1) && g > h && e > g, `ivl ${ivl}: ${h} ${g} ${e}`);
  }
});

test('fuzz stays in Anki’s ranges and is the same for the same card and review', () => {
  assert.deepStrictEqual(a.fuzzRange(2, 1, 100), [2, 2], 'no fuzz under 2.5 days');
  const [lo, hi] = a.fuzzRange(100, 1, 36500);
  assert.deepStrictEqual([lo, hi], [93, 107], '1 + 0.15·4.5 + 0.1·13 + 0.05·80 ≈ 7 days either way');
  const card = { type: 'review', ivl: 40, ease: 2.5, due: '2026-10-27', reps: 5 };
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(a.answer(card, 'good', T0, {}, `card${i}`).card.ivl);
  assert.ok(seen.size > 3, 'different cards spread out');
  assert.ok([...seen].every((x) => x >= 93 && x <= 107));
  assert.strictEqual(a.answer(card, 'good', T0, {}, 'same').card.ivl, a.answer(card, 'good', T0, {}, 'same').card.ivl);
});

test('a lapse: ease −0.2, the relearning step, then back with the new interval; leeches are marked', () => {
  const card = { type: 'review', ivl: 30, ease: 2.5, due: '2026-10-27', reps: 8, lapses: 0 };
  let c = a.answer(card, 'again', T0, {}, 'x').card;
  assert.deepStrictEqual([c.type, c.lapses, c.ease, c.ivl, c.dueAt - T0], ['relearn', 1, 2.3, 1, 10 * MIN]);
  c = a.answer(c, 'good', T0 + 10 * MIN, {}, 'x').card;
  assert.deepStrictEqual([c.type, c.ivl, c.due], ['review', 1, '2026-10-28']);
  const half = a.answer(card, 'again', T0, { lapseMult: 0.5 }, 'x').card;
  assert.strictEqual(half.ivl, 15, '"New interval" 50 %');
  let leech = { ...card, lapses: 7 };
  leech = a.answer(leech, 'again', T0, {}, 'x').card;
  assert.strictEqual(leech.leech, true, 'the 8th lapse');
  assert.strictEqual(a.answer({ ...card, ease: 1.35 }, 'again', T0, {}, 'x').card.ease, 1.3, 'never below 130 %');
});

test('days roll over at 4 am; learning cards ending after midnight still count for today', () => {
  assert.strictEqual(a.dayOf(at('2026-10-28T03:30:00')), '2026-10-27');
  assert.strictEqual(a.dayOf(at('2026-10-28T04:30:00')), '2026-10-28');
  const learn = { type: 'learn', step: 1, dueAt: at('2026-10-28T01:00:00') };
  assert.strictEqual(a.status(learn, at('2026-10-27T23:00:00')), 'learn');
  assert.strictEqual(a.status({ ...learn, dueAt: at('2026-10-28T09:00:00') }, at('2026-10-27T23:00:00')), 'later');
  assert.strictEqual(a.status({ type: 'review', due: '2026-10-27', ivl: 3 }, T0), 'due');
  assert.strictEqual(a.status({ type: 'review', due: '2026-10-30', ivl: 3 }, T0), 'later');
  assert.strictEqual(a.status({ type: 'review', due: '2026-10-27', suspended: true }, T0), 'suspended');
});

test('FSRS-5: Anki’s default parameters, retrievability and intervals at the desired retention', () => {
  assert.ok(Math.abs(a.fsrs.retrievability(10, 10) - 0.9) < 1e-9, 'R = 90 % after S days');
  assert.ok(Math.abs(a.fsrs.interval(10, 0.9) - 10) < 1e-9);
  assert.ok(a.fsrs.interval(10, 0.8) > 10, 'lower retention, longer intervals');
  assert.deepStrictEqual([1, 2, 3, 4].map((g) => a.fsrs.initS(g)), a.FSRS_W.slice(0, 4));
  assert.ok(a.fsrs.initD(1) > a.fsrs.initD(4), 'Again starts harder than Easy');
  const cfg = { scheduler: 'fsrs' };
  let c = run(a.fresh(), [['good', '2026-10-27T10:00:00'], ['good', '2026-10-27T10:10:00']], cfg);
  assert.strictEqual(c.type, 'review');
  assert.ok(c.s > 2 && c.d > 1 && c.d < 10, `s ${c.s} d ${c.d}`);
  const before = c.s;
  c = a.answer(c, 'good', at(`${c.due}T10:00:00`), cfg, 'x').card;
  assert.ok(c.s > before * 1.5, 'a successful review grows stability');
  const lapse = a.answer(c, 'again', at(`${c.due}T10:00:00`), cfg, 'x').card;
  assert.ok(lapse.s < c.s && lapse.type === 'relearn');
  const p = a.preview(c, at(`${c.due}T10:00:00`), cfg, 'x');
  const days = (t) => (t.endsWith('d') ? Number(t.slice(0, -1)) : t.endsWith('mo') ? Number(t.slice(0, -2)) * 30 : t.endsWith('y') ? Number(t.slice(0, -1)) * 365 : 0);
  assert.ok(days(p.hard) < days(p.good) && days(p.good) < days(p.easy), JSON.stringify(p));
});

test('options: Anki’s defaults, steps as text, bad values ignored', () => {
  const c = a.config({ learnSteps: '2 15 60', newPerDay: '30', scheduler: 'weird', retention: 2 });
  assert.deepStrictEqual(c.learnSteps, [2, 15, 60]);
  assert.strictEqual(c.newPerDay, 30);
  assert.strictEqual(c.scheduler, 'sm2');
  assert.strictEqual(c.retention, 0.99);
  assert.strictEqual(a.config().reviewsPerDay, 200);
  assert.throws(() => a.answer(a.fresh(), 'perfect', T0), /Grade/);
  assert.strictEqual(a.spanText(90), '2h');
  assert.strictEqual(a.spanText(1440 * 60), '2mo');
});
