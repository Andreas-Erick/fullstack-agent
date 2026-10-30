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
      if (s.persona) assert.ok(PERSONAS.some((p) => p.name === s.persona), `${c.id}: unknown persona ${s.persona}`);
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
