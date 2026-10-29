// Who is where in the village (renderer/js/world/whereabouts.js): the active persona walks to its work
// (research → the Library, code → the Workshop), thinks in the Garden, strolls the village when free;
// the other personas relax in the Hearth; townsfolk follow their plan; everyone sleeps at night.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir, load } = require('./helpers');

const ESM = tmpDir('nexus-where-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, 'renderer/js/world/whereabouts.js'), path.join(ESM, 'whereabouts.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const mod = () => import(pathToFileURL(path.join(ESM, 'whereabouts.js')).href);
const world = load('main/worldcore.js');

const SITES = { hearth: { gx: 20, gy: 4 }, library: { gx: 8, gy: 8 }, cafe: { gx: 32, gy: 12 }, workshop: { gx: 11, gy: 20 }, garden: { gx: 22, gy: 20 }, archive: { gx: 15, gy: 36 }, stage: { gx: 27, gy: 36 } };

test('the active persona goes where its work is, by tool', () => {
  assert.strictEqual(world.workFor('web_search').place, 'library', 'research happens in the Library');
  assert.strictEqual(world.workFor('WebSearch').place, 'library');
  assert.strictEqual(world.workFor('WebFetch').label, 'in the Library, researching');
  assert.strictEqual(world.workFor('web_search').counts, 'lookout', 'but still counts as a trip out (the Lookout grows)');
  assert.strictEqual(world.workFor('Edit').place, 'workshop');
  assert.strictEqual(world.workFor('browser_open').place, 'lookout');
});

test('it walks to new work along the road, and arrives', async () => {
  const { createWalker, activeTarget, TRAVEL_MS } = await mod();
  const w = createWalker('hearth');
  const target = activeTarget({ live: { place: 'library', label: 'in the Library, researching' } });
  const go = w.update({ target, now: 1000 });
  assert.deepStrictEqual([go.from, go.place, go.k, go.working], ['hearth', 'library', 0, true]);
  assert.ok(w.update({ target, now: 1000 + TRAVEL_MS / 2 }).k === 0.5);
  const there = w.update({ target, now: 1000 + TRAVEL_MS });
  assert.deepStrictEqual([there.place, there.from, there.activity], ['library', undefined, 'in the Library, researching']);
  // Off to code next: from the Library to the Workshop.
  const code = w.update({ target: activeTarget({ live: { place: 'workshop', label: 'at the forge' } }), now: 20000 });
  assert.deepStrictEqual([code.from, code.place], ['library', 'workshop']);
});

test('it thinks in the Garden and strolls the village when there is nothing to do', async () => {
  const { createWalker, activeTarget, strollOrder, STROLL_WALK_MS, STROLL_PAUSE_MS, TRAVEL_MS } = await mod();
  assert.deepStrictEqual(activeTarget({ agentState: 'thinking' }), { place: 'garden', activity: 'thinking it over', thinking: true });
  assert.strictEqual(activeTarget({ agentState: 'idle' }), null);
  const order = strollOrder(SITES, Object.keys(SITES));
  assert.deepStrictEqual([...order].sort(), Object.keys(SITES).sort(), 'every built place is on the walk once');
  const w = createWalker('hearth');
  w.update({ target: { place: 'garden', activity: 'thinking it over', thinking: true }, now: 0 });
  w.update({ target: null, order, now: TRAVEL_MS }); // arrived
  const seen = new Set();
  let walking = 0;
  for (let t = TRAVEL_MS; t < TRAVEL_MS + 8 * (STROLL_WALK_MS + STROLL_PAUSE_MS); t += 5000) {
    const s = w.update({ target: null, order, now: t });
    seen.add(s.place);
    if (s.from) (walking++, assert.ok(s.k >= 0 && s.k < 1), assert.notStrictEqual(s.from, s.place));
  }
  assert.ok(seen.size >= 6, `walks from place to place (${[...seen]})`);
  assert.ok(walking > 0);
  const first = w.update({ target: null, order, now: TRAVEL_MS + 1 });
  assert.ok(first.place, 'always somewhere');
});

test('a walk that starts off the ring heads for its first place', async () => {
  const { createWalker, strollOrder } = await mod();
  const order = strollOrder(SITES, ['library', 'cafe', 'stage']);
  const w = createWalker('lookout');
  const s = w.update({ target: null, order, now: 0 });
  assert.deepStrictEqual([s.from, s.place], ['lookout', order[0]]);
});

test('the other personas relax in the Hearth; townsfolk follow their plan; night is for sleeping', async () => {
  const { offDuty, byPlan } = await mod();
  assert.deepStrictEqual(offDuty(10 * 60, 0), { place: 'hearth', activity: 'relaxing by the fire' });
  assert.strictEqual(offDuty(10 * 60, 1).place, 'hearth');
  assert.strictEqual(offDuty(2 * 60).asleep, true);
  const toMin = (t) => (/^\d\d:\d\d$/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
  const plan = [{ start: '08:00', place: 'garden', activity: 'Tea' }, { start: '12:00', place: 'library', activity: 'Reading' }];
  assert.deepStrictEqual(byPlan(plan, 13 * 60, toMin, 20), { place: 'library', activity: 'Reading' });
  assert.deepStrictEqual(byPlan(plan, 12 * 60 + 10, toMin, 20), { place: 'library', activity: 'Reading', from: 'garden', k: 0.5 });
  assert.strictEqual(byPlan(plan, 7 * 60, toMin, 20).asleep, true, 'before the first entry');
  assert.strictEqual(byPlan(plan, 23 * 60 + 30, toMin, 20).asleep, true);
});
