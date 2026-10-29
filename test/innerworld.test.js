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

test('the assistant’s work has a place in the village', () => {
  assert.strictEqual(core.workFor('Edit').place, 'workshop');
  assert.strictEqual(core.workFor('mcp__nexus__code_grep').place, 'workshop', 'app tools through Claude Code');
  assert.strictEqual(core.workFor('WebSearch').place, 'library', 'research is read in the Library');
  assert.strictEqual(core.workFor('WebSearch').counts, 'lookout', 'and grows the Lookout');
  assert.strictEqual(core.workFor('mcp__claude_ai_Todoist__find-tasks').place, 'lookout', 'connectors send a raven');
  assert.strictEqual(core.workFor('memory_save').place, 'archive');
  assert.strictEqual(core.workFor('habit_log').place, 'grounds');
  assert.strictEqual(core.workFor('rehearsal_run').place, 'stage');
  assert.strictEqual(core.workFor('something_new').place, 'garden');
  for (const t of ['Edit', 'WebSearch', 'memory_save', 'habit_log']) assert.ok(core.PLACE_IDS.includes(core.workFor(t).place));
  assert.deepStrictEqual(core.workLines({}, 'Ada'), []);
  assert.match(core.workLines({ workshop: 12, archive: 3, nowhere: 9 }, 'Ada')[0], /Ada worked with the Keeper mostly in The Workshop \(12×\), The Archive \(3×\)\./);
});

test('the Workshop and the Lookout grow with the work', () => {
  const none = core.places({});
  assert.strictEqual(level(none, 'workshop'), 1);
  assert.strictEqual(level(core.places({ crafting: 60, scouting: 200 }), 'workshop'), 2);
  assert.strictEqual(level(core.places({ crafting: 60, scouting: 200 }), 'lookout'), 3);
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

test('level-ups: only places that rose since the last look, nothing the first time', () => {
  const before = core.places({ topics: 1, understood: 3 });
  const after = core.places({ topics: 1, understood: 11, habits: 1 });
  const seen = Object.fromEntries(before.map((p) => [p.id, p.level]));
  assert.deepStrictEqual(core.levelUps(null, after), []);
  const ups = core.levelUps(seen, after);
  assert.ok(ups.length && ups.every((u) => u.to > u.from && after.find((p) => p.id === u.id).level === u.to));
  assert.ok(ups.some((u) => u.id === 'library' && u.from === 1 && u.to === 2 && u.stage));
  assert.deepStrictEqual(core.levelUps(Object.fromEntries(after.map((p) => [p.id, p.level])), before), [], 'falling is not celebrated');
});

test('one snapshot a day, unchanged history kept as is, replayed as growth steps', () => {
  const a = core.places({ topics: 1, understood: 3 });
  const b = core.places({ topics: 1, understood: 11 });
  let h = core.snapshot([], '2026-10-01', a);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(core.snapshot(h, '2026-10-01', a), h, 'same day, same levels: no write');
  h = core.snapshot(h, '2026-10-01', b);
  assert.strictEqual(h.length, 1, 'a day keeps its last state');
  h = core.snapshot(core.snapshot(h, '2026-10-02', b), '2026-10-05', core.places({ topics: 3, understood: 40, habits: 2, streak: 8 }));
  assert.deepStrictEqual(h.map((x) => x.date), ['2026-10-01', '2026-10-02', '2026-10-05']);
  assert.strictEqual(core.snapshot(h, '2026-10-06', b, 2).length, 2, 'capped');
  const steps = core.timelapse(h, { library: 'The Library' });
  assert.strictEqual(steps[0].kind, 'baseline');
  assert.strictEqual(steps.length, 2, 'the quiet day without changes is skipped');
  assert.match(steps[1].subject, /^The Library.* grew$/);
  const lib = steps[1].files.find((f) => f.path === 'library');
  assert.strictEqual(lib.added, 1);
  assert.ok(steps.every((s) => Number.isFinite(s.at)));
});

// ------------------------------------------------------------- a whole day through innerworld.js
const dir = tmpDir('nexus-world-');
const notes = new Map();
let settings = { agent: { name: 'Nexus' }, llm: { provider: 'anthropic' }, memory: { stream: true }, innerWorld: { enabled: true, townsfolk: true }, personas: { active: 'p1', list: [{ id: 'p1', name: 'Ada', personality: 'A patient tutor.' }] } };
let narratorCalls = 0;
let understood = 12;
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
  './learning': { topics: async () => [{ topic: 'Linear algebra', understood }], deckSummaries: async () => [] },
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

test('tools are counted by place and reach the view', async () => {
  const before = (await world.view()).details.work.today.workshop || 0;
  world.noteTool('Edit');
  world.noteTool('mcp__nexus__code_grep');
  world.noteTool('WebFetch');
  await new Promise((r) => setTimeout(r, 20));
  const v = await world.view();
  assert.strictEqual(v.details.work.today.workshop, before + 2);
  assert.strictEqual(v.details.work.today.lookout, 1);
  assert.ok(Array.isArray(v.details.topics) && v.details.topics[0].name === 'Linear algebra');
});

test('the view keeps a daily snapshot and announces a place that rose, once', async () => {
  const events = [];
  world.start({ notify: (ev) => events.push(ev) });
  await world.view();
  understood = 40;
  const v = await world.view();
  assert.ok(v.levelups.some((l) => l.id === 'library' && l.to === 3), 'the Library rose');
  assert.ok(events.some((e) => e.type === 'levelup' && e.places.some((p) => p.id === 'library')));
  assert.strictEqual((await world.view()).levelups.length, 0, 'celebrated once');
  const st = JSON.parse(fs.readFileSync(require('path').join(dir, 'innerworld.json'), 'utf8'));
  assert.strictEqual(st.history.length, 1);
  assert.strictEqual(st.history[0].levels.library, 3);
  assert.ok(st.days.length >= 1, 'the days written before are kept');
  assert.ok(Array.isArray(v.timelapse) && v.timelapse[0].kind === 'baseline');
});

test('a read-only view (the phone) writes nothing and announces nothing', async () => {
  const file = require('path').join(dir, 'innerworld.json');
  const events = [];
  world.start({ notify: (ev) => events.push(ev) });
  const before = fs.readFileSync(file, 'utf8');
  understood = 80;
  const v = await world.view({ track: false });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'innerworld.json untouched');
  assert.strictEqual(v.levelups.length, 0);
  assert.strictEqual(events.length, 0);
  assert.ok(v.places.some((p) => p.id === 'library'), 'still shows the village');
});

test('asleep: nothing is written', async () => {
  settings = { ...settings, innerWorld: { enabled: false } };
  await assert.rejects(world.simulate(), /asleep/);
  assert.strictEqual((await world.status()).enabled, false);
});
