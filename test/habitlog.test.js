// Checking habits off (main/habits.js) the way people actually do it: many taps at once (phone and
// desktop together, a double tap), undoing, odd dates, names in another case or with emoji, and
// unknown habits. Every check-off must land exactly once.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

let note = '';
let writes = 0;
stub({
  './logger': quietLog,
  './obsidian': {
    ymd: () => '2026-10-27',
    readOptional: async () => note,
    // A write that takes a moment, so overlapping changes would show.
    writeNote: async (_p, text) => {
      await new Promise((r) => setTimeout(r, 3));
      note = text;
      writes++;
    },
  },
});
const habits = load('main/habits.js');

test('setup: three habits, one with an emoji', async () => {
  note = '';
  for (const name of ['Run', 'Read', 'Meditate 🧘']) await habits.add({ name });
  assert.strictEqual((await habits.status()).habits.length, 3);
});

test('ten taps at once on different habits and the same one: each lands once, nothing lost', async () => {
  await Promise.all([...Array(10)].map((_, i) => habits.log(['Run', 'Read', 'Meditate 🧘'][i % 3])));
  const s = await habits.status();
  assert.deepStrictEqual(s.habits.map((h) => h.doneToday), [true, true, true]);
  assert.strictEqual((note.match(/^- 2026-10-27: (.*)$/m)?.[1] || '').split(', ').length, 3, 'one log line with three names');
});

test('check off and undo at the same moment: they apply in order, the last one wins', async () => {
  await Promise.all([habits.log('Run', { done: false }), habits.log('Run'), habits.log('Run', { done: false })]);
  assert.strictEqual((await habits.status()).habits.find((h) => h.name === 'Run').doneToday, false);
});

test('names in another case, with spaces, or the emoji habit by its full name', async () => {
  await habits.log('  run ');
  await habits.log('MEDITATE 🧘');
  const s = await habits.status();
  assert.strictEqual(s.habits.find((h) => h.name === 'Run').doneToday, true);
  await assert.rejects(() => habits.log('Swim'), /isn't a tracked habit/);
  await assert.rejects(() => habits.log(''), /isn't a tracked habit/);
});

test('dates: yesterday and past days work; future, impossible and garbage dates are refused', async () => {
  assert.strictEqual((await habits.log('Read', { date: 'yesterday' })).date, '2026-10-26');
  assert.strictEqual((await habits.log('Read', { date: '2026-02-28' })).date, '2026-02-28');
  for (const date of ['2026-10-28', '2027-01-01', '2026-02-31', '2026-13-01', '27.10.2026', 'tomorrow', 'not-a-date', '2026-1-5'])
    await assert.rejects(() => habits.log('Read', { date }), /date must be/, date);
  assert.doesNotMatch(note, /2026-02-31|not-a-date|2026-10-28/, 'nothing odd reached the note');
});

test('a habit name full of markup can\'t break the note or add fake log lines', async () => {
  await habits.add({ name: 'Code --> <!-- habit {"x":1} -->\n## Log\n- 2020-01-01: Run' });
  const s = await habits.status();
  assert.strictEqual(s.habits.length, 4);
  assert.ok(!require('../main/habitcore').parse(note).log.has('2020-01-01'), 'no injected log line');
  assert.ok(s.habits.every((h) => !/\n|<!--|-->/.test(h.name)));
});
