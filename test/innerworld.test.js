// The Inner World: buildings from real progress, residents, the narrator's day (worldcore.js), and a
// whole day through innerworld.js with an in-memory vault.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
const core = require('../main/worldcore');

const level = (list, id) => list.find((p) => p.id === id).level;

test('buildings grow with the evidence', () => {
  const none = core.places({});
  assert.strictEqual(level(none, 'library'), 0);
  assert.strictEqual(level(none, 'garden'), 1, 'the commons always exists');
  assert.match(none.find((p) => p.id === 'library').hint, /learning topic/);
  const some = core.places({ topics: 2, understood: 12, decks: 1, mature: 250, habits: 1, streak: 6, skills: 3, mastered: 1, memories: 0 });
  assert.strictEqual(level(some, 'library'), 2);
  assert.strictEqual(level(some, 'cafe'), 3);
  assert.strictEqual(level(some, 'grounds'), 1);
  assert.strictEqual(level(some, 'observatory'), 2);
  assert.strictEqual(level(some, 'archive'), 0);
  assert.match(some.find((p) => p.id === 'library').hint, /12 concepts understood · 30 for the next level/);
  assert.match(some.find((p) => p.id === 'cafe').hint, /Flourishing/);
});

test('news lists only what was built or grew', () => {
  const before = core.places({ topics: 1, understood: 3 });
  const after = core.places({ topics: 1, understood: 11, habits: 1 });
  const lines = core.news(before, after);
  assert.deepStrictEqual(lines.length, 2);
  assert.ok(lines.some((l) => /Library grew/.test(l)));
  assert.ok(lines.some((l) => /Training Grounds was built/.test(l)));
  assert.deepStrictEqual(core.news(null, after), [], 'no news on the first day');
});

test('residents: active persona first, unique names, townsfolk optional, colors validated', () => {
  const personas = {
    active: 'p2',
    list: [
      { id: 'p1', name: 'Nexus', personality: 'Helpful', theme: { colors: { accent: '#00e5ff' } } },
      { id: 'p2', name: 'Ada', personality: 'Tutor', theme: { colors: { accent: 'red; background:url(x)' } } },
      { id: 'p3', name: 'ada', personality: 'Duplicate' },
      { id: 'p4', name: 'Wren', personality: 'A persona called Wren' },
    ],
  };
  const r = core.residents(personas);
  assert.deepStrictEqual(r.map((x) => x.name), ['Ada', 'Nexus', 'Wren', 'Bram']);
  assert.strictEqual(r[0].color, null, 'an invalid color is dropped');
  assert.strictEqual(r[1].color, '#00e5ff');
  assert.strictEqual(r[2].npc, false, 'the persona keeps the name; the villager stays home');
  assert.deepStrictEqual(core.residents(personas, { townsfolk: false }).map((x) => x.name), ['Ada', 'Nexus', 'Wren']);
  const many = { active: 'x0', list: Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, name: `P${i}` })) };
  assert.strictEqual(core.residents(many).length, core.MAX_RESIDENTS);
});

const RES = core.residents({ active: 'p1', list: [{ id: 'p1', name: 'Ada', personality: 'Tutor' }] });

test('the day prompt carries places, news, memories and the Keeper rule', () => {
  const prompt = core.dayPrompt({ date: '2026-10-26', weekday: 'Monday', residents: RES.map((r) => ({ ...r, memories: ['I lost my favorite pen'], reflections: ['I teach best by drawing'] })), places: core.places({}), news: ['The Library was built.'], yesterday: '' });
  assert.match(prompt, /Monday, 2026-10-26/);
  assert.match(prompt, /library: The Library — foundation/);
  assert.match(prompt, /- The Library was built\./);
  assert.match(prompt, /insight: I teach best by drawing/);
  assert.match(prompt, /the Keeper/);
  assert.match(prompt, /first day anyone remembers/);
});

test('the narrator\'s day is validated against residents and places', () => {
  const day = core.parseDay(
    {
      weather: 'Drizzle',
      summary: 'A quiet day.',
      residents: [
        { name: 'ada', mood: 'curious', plan: [{ start: '13:00', place: 'library', activity: 'Shelving' }, { start: '07:30', place: 'garden', activity: 'Tea' }, { start: '25:00', place: 'garden', activity: 'bad' }, { start: '09:00', place: 'moon', activity: 'bad' }] },
        { name: 'Stranger', plan: [{ start: '08:00', place: 'garden', activity: 'x' }] },
      ],
      scenes: [
        { time: '10:15', place: 'cafe', who: ['Ada', 'Ghost'], title: 'Coffee', lines: [{ who: 'Ada', text: 'Hello.' }, { who: 'Ghost', text: 'Boo' }], outcome: 'Fine.' },
        { time: '11:00', place: 'cafe', lines: [] },
      ],
      memories: [{ who: 'Ada', text: 'I had tea.', importance: 99 }, { who: 'Nobody', text: 'x' }],
    },
    RES,
  );
  assert.deepStrictEqual(day.residents.Ada.plan.map((b) => b.start), ['07:30', '13:00']);
  assert.strictEqual(day.residents.Ada.mood, 'curious');
  assert.ok(day.residents.Wren.plan.length, 'a forgotten resident still gets a day');
  assert.strictEqual(day.scenes.length, 1);
  assert.deepStrictEqual(day.scenes[0].who, ['Ada']);
  assert.deepStrictEqual(day.memories, [{ who: 'Ada', text: 'I had tea.', importance: 10 }]);
  assert.throws(() => core.parseDay({ summary: '', scenes: [] }, RES), /empty/);
  assert.throws(() => core.parseDay(null, RES), /did not answer/);
});

test('where a resident is at a time of day', () => {
  const plan = [{ start: '08:00', place: 'garden', activity: 'Tea' }, { start: '12:00', place: 'library', activity: 'Reading' }];
  assert.strictEqual(core.whereAt(plan, 7 * 60).activity, 'asleep');
  assert.strictEqual(core.whereAt(plan, 9 * 60).place, 'garden');
  assert.strictEqual(core.whereAt(plan, 9 * 60).next.place, 'library');
  assert.strictEqual(core.whereAt(plan, 13 * 60).place, 'library');
  assert.strictEqual(core.whereAt(plan, 23 * 60 + 30).activity, 'asleep');
  assert.strictEqual(core.whereAt([], 600), null);
});

// ------------------------------------------------------------- a whole day through innerworld.js
const dir = tmpDir('nexus-world-');
const notes = new Map();
let settings = { agent: { name: 'Nexus' }, llm: { provider: 'anthropic' }, memory: { stream: true }, innerWorld: { enabled: true, townsfolk: true }, personas: { active: 'p1', list: [{ id: 'p1', name: 'Ada', personality: 'A patient tutor.' }] } };
let narratorCalls = 0;
const dayJson = {
  weather: 'Clear',
  summary: 'Ada found a new shelf in the Library.',
  residents: [{ name: 'Ada', mood: 'bright', plan: [{ start: '08:00', place: 'library', activity: 'Reading' }] }],
  scenes: [{ time: '10:00', place: 'library', who: ['Ada', 'Wren'], title: 'The new shelf', lines: [{ who: 'Wren', text: 'The Keeper has been busy.' }, { who: 'Ada', text: 'Linear algebra, finally!' }], outcome: 'They catalogued it together.' }],
  memories: [{ who: 'Ada', text: 'Wren and I catalogued the new shelf.', importance: 6 }, { who: 'Wren', text: 'Ada was delighted.', importance: 4 }],
};
stub({
  './store': fileStore(dir, { getSettings: async () => settings }),
  './logger': quietLog,
  './obsidian': {
    vaultPath: async () => dir,
    ymd: () => '2026-10-26',
    readOptional: async (rel) => notes.get(rel) || '',
    writeNote: async (rel, text) => notes.set(rel, text),
  },
  './llm': {
    complete: async (_s, prompt) => {
      if (/narrator of the Inner World/.test(prompt)) {
        narratorCalls++;
        return JSON.stringify(dayJson);
      }
      return '{"insights":[]}';
    },
  },
  './persona': { extractJson: (t) => JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) },
  './learning': { topics: async () => [{ topic: 'Linear algebra', understood: 12 }], deckSummaries: async () => [] },
  './habits': { status: async () => ({ habits: [] }) },
  './skilltree': { view: async () => ({ skills: [] }) },
  './memory': { list: async () => [{ id: 'm1' }] },
});
const world = load('main/innerworld.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a day is written once, remembered by the residents and kept in the chronicle', async () => {
  const day = await world.simulate();
  assert.strictEqual(day.date, '2026-10-26');
  assert.strictEqual(narratorCalls, 1);
  assert.match(notes.get(world.CHRONICLE), /# Chronicle of the Inner World/);
  assert.match(notes.get(world.CHRONICLE), /> \*\*Wren:\*\* The Keeper has been busy\./);
  assert.match(notes.get('Inner World/Residents/Ada.md'), /Wren and I catalogued the new shelf/);
  assert.match(notes.get('Inner World/Residents/Wren.md'), /Ada was delighted/);

  await world.simulate();
  assert.strictEqual(narratorCalls, 1, 'the same day is not written twice');

  dayJson.summary = 'A second telling.';
  await world.simulate({ force: true });
  const chron = notes.get(world.CHRONICLE);
  assert.strictEqual((chron.match(/^## /gm) || []).length, 1, 'rewriting today replaces its entry');
  assert.match(chron, /A second telling\./);

  const v = await world.view();
  assert.strictEqual(level(v.places, 'library'), 2);
  assert.strictEqual(v.residents.find((r) => r.name === 'Ada').mood, 'bright');
  const st = await world.status();
  assert.ok(st.residents.some((l) => /^Ada \(you, the active persona\)/.test(l)));
  const ada = await world.resident('ada');
  assert.ok(ada.records.length >= 1);
  await assert.rejects(world.resident('Nobody'), /Nobody called/);
});

test('asleep: nothing is written', async () => {
  settings = { ...settings, innerWorld: { enabled: false } };
  await assert.rejects(world.simulate(), /asleep/);
  assert.strictEqual((await world.status()).enabled, false);
});
