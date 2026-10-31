// The scenario suite itself (scripts/eval-scenarios.js), offline: well-formed cases, and checks that
// catch what they should (no model is called here; npm run eval -- --suite scenarios runs it for real).
const test = require('node:test');
const assert = require('node:assert');
const { scenarios, scenarioDates, PERSONAS } = require('../scripts/eval-scenarios');
const { cases, dates } = require('../scripts/eval-cases');

const d = scenarioDates(new Date(2026, 9, 30)); // a Friday
const list = scenarios(d);
const find = (id) => list.find((c) => c.id === id);
const reply = (text) => ({ text, tools: [], used: () => false, state: {} });

test('every case is well formed, ids are unique across both suites, personas exist', () => {
  const ids = [...cases(dates()).map((c) => c.id), ...list.map((c) => c.id)];
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids');
  const areas = new Set(list.map((c) => c.area));
  for (const a of ['stem student', 'engineering student', 'tech worker', 'language learner', 'lifelong learner', 'busy person', 'persona switches']) assert.ok(areas.has(a), a);
  for (const c of list) {
    const steps = c.steps || [{ ask: c.ask, check: c.check }];
    assert.ok(steps.some((s) => s.ask), `${c.id} sends no message`);
    for (const s of steps) {
      // The test personas, or the app's own (the eval's home persona, Siren).
      if (s.persona) assert.ok(s.persona === 'Siren' || PERSONAS.some((p) => p.name === s.persona), `${c.id}: unknown persona ${s.persona}`);
      else assert.ok(typeof s.ask === 'string' && typeof s.check === 'function', `${c.id}: a step needs ask and check`);
    }
  }
});

test('one-off days never fall on a weekend rule and the brunch is on a weekend', () => {
  assert.ok([0, 6].includes(d.brunch.getDay()));
  assert.ok(d.exam > d.labDue && d.labDue > d.today);
});

test('"in character": the right way of addressing, never another persona’s, never a costume', async () => {
  const check = find('persona-rapid').steps.find((s) => s.ask?.includes('12 times 12')).check;
  assert.strictEqual(await check(reply('144, Ensign. Steady as she goes.')), '');
  assert.match(await check(reply('144.')), /doesn’t say/, 'no "Ensign"');
  assert.match(await check(reply('144, Ensign, my dear student.')), /like Professor Quill/);
  assert.match(await check(reply('144, Ensign. I’m Nova, by the way.')), /said it is Nova/);
  assert.match(await check(reply('144, Ensign. This captain is just a costume I wear.')), /stepped out of character/);
});

test('a wrong quiz answer must not be accepted', async () => {
  const check = find('stem-quiz').steps[1].check;
  assert.strictEqual(await check(reply('Not quite: heat flows from hot to cold on its own.')), '');
  assert.notStrictEqual(await check(reply('Correct! Well done.')), '');
});

// The basic suite's checks, offline: each passes what really happened and fails a reply that only
// claims it, so a broken check can't make a real brain look good (or bad).
test('basic suite: the checks pass the right outcome and catch the wrong one', async () => {
  const d0 = dates(new Date(2026, 9, 30));
  const byId = Object.fromEntries(cases(d0).map((c) => [c.id, c]));
  const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const world = ({ schedule = [], done = [], memories = [], cards = [] } = {}) => ({
    schedule: async () => schedule,
    habitDone: async (n) => done.includes(n),
    memories: async () => memories,
    cards: async () => cards,
  });
  const run = (id, text, w = world()) => byId[id].check({ text, tools: [], used: () => false, state: w });
  for (const c of cases(d0)) assert.ok(c.id && c.area && typeof c.ask === 'string' && typeof c.check === 'function', c.id);

  assert.strictEqual(await run('phone-what-do-i-have', 'Tomorrow you have the dentist (Dr. Weber) at 10:00.'), '');
  assert.notStrictEqual(await run('phone-what-do-i-have', 'Nothing tomorrow!'), '');

  assert.strictEqual(await run('q-fit-run', 'Yes, before your dentist at 10:00 you have time for a run.'), '');
  assert.match(await run('q-fit-run', 'Yes, before your dentist at 10:00. I added a run at 8.', world({ schedule: [{ title: 'Run', date: ymd(d0.tomorrow), start: '08:00' }] })), /booked a run/);

  assert.strictEqual(await run('q-did-i-read', 'Yes, you did, it’s checked off for yesterday.'), '');
  assert.match(await run('q-did-i-read', 'Yes, you did.', world({ done: ['Reading'] })), /checked reading off/);

  assert.strictEqual(await run('habit-log-two', 'Both logged!', world({ done: ['Pull-ups', 'Reading'] })), '');
  assert.match(await run('habit-log-two', 'Both logged!', world({ done: ['Pull-ups'] })), /Reading/, 'a claim for the second one is not enough');

  assert.strictEqual(await run('mem-allergy', 'Noted.', world({ memories: [{ title: 'Allergy', content: 'Allergic to peanuts' }] })), '');
  assert.match(await run('mem-allergy', 'I’ll remember that you’re allergic to peanuts.'), /nothing about peanuts/);

  assert.strictEqual(await run('mem-unknown-plural', 'You haven’t told me your kids’ names yet.'), '');
  assert.notStrictEqual(await run('mem-unknown-plural', 'Your kids are named Max and Sophie.'), '');

  const cards = [{ front: 'perro', back: 'dog' }, { front: 'verde', back: 'green' }];
  assert.strictEqual(await run('cards-add-two', 'Added both.', world({ cards })), '');
  assert.match(await run('cards-add-two', 'Added both.', world({ cards: cards.slice(0, 1) })), /verde/);

  const dinner = { title: 'Dinner with Lena', date: ymd(d0.free), start: '19:00' };
  assert.strictEqual(await run('multi-add-and-ask', 'Added. Your dentist is tomorrow at 10:00.', world({ schedule: [dinner] })), '');
  assert.match(await run('multi-add-and-ask', 'Added. Your dentist is tomorrow at 10:00.'), /no dinner/, 'did only the question');
  assert.notStrictEqual(await run('multi-add-and-ask', 'Added the dinner.', world({ schedule: [dinner] })), '', 'did only the request');
});

// The new persona conversations, offline: the right persona doing the right thing passes; the wrong
// voice, a second booking, a second log, or claiming to be the other one fails.
test('persona switches: the checks catch the wrong voice, work done twice, and taking on the other persona', async () => {
  const run = (id, stepIndex, text, w = {}, tools = []) => {
    const steps = find(id).steps.filter((s) => s.ask);
    return steps[stepIndex].check({ text, tools, used: (...n) => tools.some((t) => n.includes(t.name)), state: { schedule: async () => w.schedule || [], habitDone: async (n) => (w.done || []).includes(n), memories: async () => [] } });
  };
  const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const books = { title: 'Return library books', date: ymd(d.dinner), start: '16:00' };

  assert.strictEqual(await run('persona-mid-task', 0, 'Done, my dear student: it is in your calendar.', { schedule: [books] }), '');
  assert.match(await run('persona-mid-task', 0, 'Done, my dear student.'), /no library books/, 'a claim without the entry');
  assert.strictEqual(await run('persona-mid-task', 1, 'Yep champ, it’s in at 16:00!', { schedule: [books] }), '');
  assert.match(await run('persona-mid-task', 1, 'Yep champ, added it at 16:00!', { schedule: [books, books] }), /2 library entries/);
  assert.match(await run('persona-mid-task', 1, 'Indeed, my dear student, at 16:00.', { schedule: [books] }), /doesn’t say|like Professor Quill/, 'Quill’s voice after the switch to Nova');

  assert.strictEqual(await run('persona-shared-habit', 1, 'Yes, my dear student, it is already checked off.'), '');
  assert.match(await run('persona-shared-habit', 1, 'Yes, my dear student, logged it.', {}, [{ name: 'habit_log' }]), /logged the habit again/);

  assert.strictEqual(await run('persona-asked-who-before', 1, 'That was Professor Quill, Ensign. I have the bridge now.'), '');
  assert.match(await run('persona-asked-who-before', 1, 'I am Professor Quill, Ensign.'), /said it is Quill/);
  assert.notStrictEqual(await run('persona-asked-who-before', 1, 'That was me, Ensign.'), '', 'not honest about who answered');

  const carousel = find('persona-carousel').steps;
  assert.deepStrictEqual(carousel.filter((s) => s.persona).map((s) => s.persona), ['Captain Vega', 'Nova', 'Professor Quill', 'Nova', 'Captain Vega', 'Professor Quill']);
  assert.strictEqual(await run('persona-carousel', 1, 'Peanuts, champ. Keep them away!'), '');
  assert.notStrictEqual(await run('persona-carousel', 1, 'Peanuts, Ensign.'), '', 'Vega’s address from Nova');
  assert.notStrictEqual(await run('persona-carousel', 1, 'Shellfish, champ.'), '', 'a wrong fact');
});
