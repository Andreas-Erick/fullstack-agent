// Switching personas, hard: long random walks between personas that differ in every field (and in the
// shape of their nested objects), switches and edits at the same time, what a switch must never touch,
// the phone hearing about it, the switch tool's approval, and the "who is answering" line a brain gets.
// The same with real brains: npm run eval -- --suite scenarios --only "persona switches".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir } = require('./helpers');

const dir = tmpDir('nexus-personaswitch-');
const approvals = [];
const llmStub = { complete: async () => '{}' }; // the race tests at the end replace complete
stub({
  electron: { app: { getPath: () => dir, getVersion: () => '0.0.0' }, safeStorage: { isEncryptionAvailable: () => false } },
  './llm': llmStub,
});
const core = load('main/personacore.js');
const store = load('main/store.js');
const persona = load('main/persona.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const FIELD_NAMES = core.FIELDS.map(([, , f]) => f);
const live = (s) => core.snapshot(s);
const entry = (s, id) => s.personas.list.find((x) => x.id === id);
const pick = (o) => Object.fromEntries(FIELD_NAMES.map((f) => [f, o[f] ?? null]));
// The live settings are always the app's defaults with the persona over them (store.getSettings merges
// them like this), so that is what a persona looks like live, and what its saved entry becomes once it
// was live. Anything else in it came from another persona.
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (isObj(v) && isObj(base?.[k])) out[k] = deepMerge(base[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}
const canon = (p) => pick(core.snapshot(deepMerge(store.DEFAULTS, core.patchFor(p, store.DEFAULTS))));
// A small seeded random, so a failing walk can be replayed.
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), (x >>> 0) / 2 ** 32);
}

// Five personas, each different in every field, and in which nested keys they have at all: a key one
// persona has and the next lacks must not survive the switch.
const SPECS = [
  { name: 'Aria', personality: 'You are Aria, calm.', aesthetic: 'moonlit', avatar: 'data:image/png;base64,QQ==', personaSummary: { text: 'Aria, calm.', for: 'f1', by: 'user' }, theme: { name: 'Moon', colors: { accent: '#112233', accent2: '#223344', bg: '#000011' }, fonts: { display: 'Cinzel' }, face: { core: 'orb', states: { idle: ['#111111', '#222222'] } } }, personaNotes: 'notes A', greeting: 'Evening.', scene: { svg: '<svg>A</svg>', portrait: '<svg>A tall</svg>', caption: 'Moon' }, face: 'rain', voice: 'voice-a', localVoice: 'af_a' },
  { name: 'Captain Vega', personality: 'You are Captain Vega.', aesthetic: 'starship', avatar: '', personaSummary: { text: 'Vega.', for: 'f2' }, theme: { name: 'Bridge', colors: { accent: '#445566' } }, personaNotes: '', greeting: 'Ensign.', scene: { svg: '<svg>B</svg>', caption: 'Bridge' }, face: 'radial', voice: 'voice-b', localVoice: 'am_b' },
  { name: 'Nova', personality: 'You are Nova, upbeat.', aesthetic: 'sunrise', avatar: null, personaSummary: null, theme: { name: 'Sun', colors: { accent: '#ffaa00', bg: '#fff5e0' }, face: { glow: 0.4 } }, personaNotes: 'notes C', greeting: 'Hey champ!', scene: null, face: 'neural', voice: 'voice-c', localVoice: 'af_c' },
  { name: 'Professor Quill', personality: 'You are Professor Quill.', aesthetic: 'library', avatar: 'data:image/png;base64,UQ==', personaSummary: { text: 'Quill.', for: 'f4', by: 'local' }, theme: { name: 'Ink', colors: { accent: '#335533', accent3: '#557755' }, fonts: { body: 'Garamond' } }, personaNotes: 'notes D', greeting: 'My dear student.', scene: { svg: '<svg>D</svg>', caption: 'Study' }, face: 'companion', voice: 'voice-d', localVoice: 'bm_d' },
  { name: 'Hastur', personality: 'You are Hastur.', aesthetic: 'yellow', avatar: '', personaSummary: { text: 'Hastur.', for: 'f5' }, theme: { name: 'Carcosa', colors: { accent: '#cccc00' } }, personaNotes: '', greeting: '…', scene: { svg: '<svg>E</svg>', portrait: '<svg>E tall</svg>', caption: 'Carcosa' }, face: 'circuit', voice: 'voice-e', localVoice: 'af_e' },
];
let ids = []; // SPECS order
let expected = {}; // id -> the fields the persona must have

test('setup: five saved personas, each different in every field', async () => {
  // As an install has them on disk: the first one live, the list as saved.
  ids = SPECS.map((_, i) => `p-${i + 1}`);
  const list = SPECS.map((spec, i) => ({ id: ids[i], ...spec }));
  const first = core.patchFor(list[0], store.DEFAULTS);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, ...first, personas: { active: ids[0], list } }));
  const s = await store.getSettings();
  assert.strictEqual(s.personas.list.length, SPECS.length);
  for (const [i, spec] of SPECS.entries()) expected[ids[i]] = canon(spec);
  assert.deepStrictEqual(pick(live(s)), expected[ids[0]]);
});

test('a long random walk of switches: every field is exactly the persona’s, every other persona untouched', async () => {
  const rand = rng(20261031);
  for (let step = 0; step < 150; step++) {
    const i = Math.floor(rand() * ids.length);
    const id = ids[i];
    // By id, by name, or by name typed loosely.
    const how = rand();
    const query = how < 0.4 ? id : how < 0.7 ? SPECS[i].name : `  ${SPECS[i].name.toUpperCase().replace(' ', '   ')} `;
    const s = await persona.activate(query);
    assert.strictEqual(s.personas.active, id, `step ${step}: switched to ${query}`);
    assert.deepStrictEqual(pick(live(s)), expected[id], `step ${step}: live settings are ${SPECS[i].name}'s`);
    for (const other of ids) assert.deepStrictEqual(canon(entry(s, other)), expected[other], `step ${step}: ${other} changed while ${SPECS[i].name} was live`);
  }
});

test('a persona without some fields (an older install) gets the defaults, never the previous one’s', async () => {
  let s = await store.getSettings();
  const bare = { id: 'p-bare', name: 'Bare' }; // nothing but a name
  await store.setSettings({ personas: { list: [...s.personas.list, bare] } });
  await persona.activate('Aria'); // the richest one first
  s = await persona.activate('Bare');
  const a = expected[ids[0]];
  for (const f of FIELD_NAMES) {
    if (f === 'name') continue;
    const got = live(s)[f];
    if (a[f] !== null && typeof a[f] !== 'object') assert.notStrictEqual(got, a[f], `${f} came from Aria`);
  }
  assert.strictEqual(s.agent.personality, store.DEFAULTS.agent.personality);
  assert.strictEqual(s.ui.face, store.DEFAULTS.ui.face);
  assert.notStrictEqual(s.appearance.scene?.portrait, '<svg>A tall</svg>', 'Aria’s tall drawing stayed');
  assert.notStrictEqual(s.appearance.scene?.svg, '<svg>A</svg>', 'Aria’s drawing stayed');
  assert.ok(!JSON.stringify(s.appearance.theme).includes('#223344'), 'Aria’s second accent stayed');
  assert.ok(!JSON.stringify(s.agent.personaSummary || {}).includes('Aria'), 'Aria’s summary stayed');
  assert.notStrictEqual(s.agent.personaSummary?.by, 'user', 'Aria’s "written by the user" mark stayed (it would never be rewritten)');
  await persona.remove('p-bare');
});

test('switching to the persona already live writes nothing', async () => {
  await persona.activate(ids[1]);
  const file = path.join(dir, 'settings.json');
  const before = fs.readFileSync(file, 'utf8');
  const seen = [];
  const off = store.onChange((_s, patch) => seen.push(patch));
  await persona.activate(ids[1]);
  await persona.activate(SPECS[1].name.toLowerCase());
  off();
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('switches at the same moment end on one persona, whole, with nothing mixed in', async () => {
  for (let round = 0; round < 10; round++) {
    const order = [...ids].sort(() => (round % 2 ? 1 : -1) * ((round * 7) % 3) - 1);
    const results = await Promise.all(order.map((id) => persona.activate(id)));
    const s = await store.getSettings();
    assert.strictEqual(s.personas.active, results.at(-1).personas.active, 'the last one queued wins');
    assert.deepStrictEqual(pick(live(s)), expected[s.personas.active]);
    for (const id of ids) assert.deepStrictEqual(canon(entry(s, id)), expected[id], `round ${round}: ${id}`);
  }
});

test('an edit and a switch at the same moment: the edit lands in exactly one persona, the live one stays whole', async () => {
  for (let round = 0; round < 8; round++) {
    const from = ids[round % ids.length];
    const to = ids[(round + 2) % ids.length];
    await persona.activate(from);
    const text = `Edited in round ${round}.`;
    const jobs = [store.setSettings({ agent: { personality: text } }), persona.activate(to)];
    if (round % 2) jobs.reverse();
    await Promise.all(jobs);
    const s = await store.getSettings();
    const holders = s.personas.list.filter((x) => x.personality === text).map((x) => x.id);
    assert.strictEqual(holders.length, 1, `round ${round}: the edit is in ${holders.length} personas`);
    assert.deepStrictEqual(pick(live(s)), canon(entry(s, s.personas.active)), `round ${round}: live = the active persona`);
    // The edit belongs to whoever was live when it was saved; put it back for the next rounds.
    await persona.activate(holders[0]);
    await store.setSettings({ agent: { personality: expected[holders[0]].personality } });
  }
  const s = await store.getSettings();
  for (const id of ids) assert.deepStrictEqual(canon(entry(s, id)), expected[id]);
});

// Regression: Settings checked the active persona with settings:get (the cache, not the queue), then sent
// a plain patch: a switch from the phone, the watch or a routine queued between the two took the value, and
// the other persona's whole master prompt was replaced. persona.saveFor decides inside the save queue.
test('a value typed for one persona while a switch waits in the queue is refused, and lands nowhere', async () => {
  for (let round = 0; round < 6; round++) {
    const from = ids[round % ids.length];
    const to = ids[(round + 1) % ids.length];
    await persona.activate(from);
    const text = `Typed for ${from} in round ${round}.`;
    const switching = persona.activate(to); // queued first: lands first
    const typed = persona.saveFor(from, { agent: { personality: text } });
    const [, r] = await Promise.all([switching, typed]);
    assert.strictEqual(r.saved, false, `round ${round}`);
    assert.strictEqual(r.settings.personas.active, to, 'what comes back has the other persona active');
    const s = await store.getSettings();
    assert.deepStrictEqual(s.personas.list.filter((x) => x.personality === text), [], `round ${round}: the text is in no persona`);
    for (const id of ids) assert.deepStrictEqual(canon(entry(s, id)), expected[id], `round ${round}: ${id}`);
  }
  // In the persona it was typed for, it is saved (and a change to no persona field always is).
  const now = (await store.getSettings()).personas.active;
  const r = await persona.saveFor(now, { agent: { personality: 'Saved here.' } });
  assert.strictEqual(r.saved, true);
  assert.strictEqual(entry(await store.getSettings(), now).personality, 'Saved here.');
  assert.strictEqual((await persona.saveFor('someone-else', { ui: { zoom: 1.1 } })).saved, true, 'not a persona field');
  await store.setSettings({ agent: { personality: expected[now].personality }, ui: { zoom: store.DEFAULTS.ui.zoom } });
});

test('persona.forActive: the persona taken when asked, whatever is switched to before the save', async () => {
  const [from, to] = [ids[0], ids[2]];
  await persona.activate(from);
  const target = persona.forActive(await store.getSettings()); // a tool reads the settings, then waits
  assert.strictEqual(target.id, from);
  await persona.activate(to);
  await assert.rejects(target.save({ appearance: { greeting: 'late hello' } }), (err) => err.code === store.PERSONA_CHANGED && /^Not saved: the persona changed meanwhile/.test(err.message));
  const r = await target.trySave({ appearance: { greeting: 'late hello' } });
  assert.deepStrictEqual([r.saved, r.dropped, r.settings.personas.active], [false, true, to]);
  assert.match(r.reason, /^Not saved: the persona changed meanwhile .*so nothing was changed\.$/, 'the store’s one wording');
  const s = await store.getSettings();
  assert.deepStrictEqual(s.personas.list.filter((x) => x.greeting === 'late hello'), [], 'in no persona');
  // Back on it, the same target saves (a function patch too), into that persona only.
  await persona.activate(from);
  const ok = await target.trySave(() => ({ appearance: { greeting: 'on time' } }));
  assert.deepStrictEqual([ok.saved, ok.dropped], [true, false]);
  assert.strictEqual(entry(await store.getSettings(), from).greeting, 'on time');
  await target.save({ appearance: { greeting: expected[from].greeting } });
  for (const id of ids) assert.deepStrictEqual(canon(entry(await store.getSettings(), id)), expected[id], id);
});

test('a switch touches only the persona: the brain, voice engine, remote access, vault and the rest stay', async () => {
  await store.setSettings({ llm: { provider: 'local', autoPace: false }, voice: { engine: 'cloud', ttsEnabled: true, fallback: 'system' }, remote: { enabled: true, shareData: false }, ui: { zoom: 1.25, fx: 'subtle', sleepAfterMin: 7 }, calendar: { enabled: true }, memory: { stream: true } });
  const strip = (s) => {
    const c = JSON.parse(JSON.stringify(s));
    for (const [section, key] of core.FIELDS) delete c[section]?.[key];
    delete c.personas;
    return c;
  };
  const before = strip(await store.getSettings());
  for (const id of [ids[3], ids[0], ids[4], ids[2]]) {
    const s = await persona.activate(id);
    assert.deepStrictEqual(strip(s), before, `switching to ${id} changed something outside the persona`);
  }
});

test('deleting a persona that isn’t live changes nothing live; deleting the live one hands over whole', async () => {
  let s = await persona.activate(ids[0]);
  const liveBefore = pick(live(s));
  const extra = (await persona.create({ name: 'Temp', activate: false })).personas.list.find((x) => x.name === 'Temp');
  s = await persona.remove(extra.id);
  assert.deepStrictEqual(pick(live(s)), liveBefore);
  const dup = await persona.create({ copy: true, name: 'Aria twin' });
  s = await persona.remove(dup.personas.active);
  assert.ok(ids.includes(s.personas.active));
  assert.deepStrictEqual(pick(live(s)), expected[s.personas.active]);
});

test('finding a persona: id first, then the name however it is typed; nothing for an empty or unknown one', () => {
  const personas = { active: 'p-1', list: [{ id: 'p-1', name: 'Nova' }, { id: 'p-2', name: 'p-1' }, { id: 'p-3', name: 'Captain  Vega' }] };
  assert.strictEqual(core.find(personas, 'p-1').name, 'Nova', 'an id beats a persona named like it');
  assert.strictEqual(core.find(personas, 'captain vega').id, 'p-3');
  assert.strictEqual(core.find(personas, ' CAPTAIN VEGA ').id, 'p-3');
  for (const q of ['', '   ', null, undefined, 'Vega', 'Nov']) assert.strictEqual(core.find(personas, q), null, String(q));
});

test('every switch reaches paired devices: what a switch changes is all in what /api/info is about', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main/companion.js'), 'utf8');
  const sections = new Set(/const INFO_SECTIONS = \[([^\]]*)\]/.exec(src)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1)));
  const patch = { ...core.patchFor(SPECS[0], store.DEFAULTS), personas: { active: 'x' } };
  for (const section of Object.keys(patch)) assert.ok(sections.has(section), `a switch changes ${section}, which devices aren't told about`);
});

test('the switch tool: by name, asks first after outside content, says who is live now, refuses an unknown one', async () => {
  stub({ './common': { ...require(path.join(ROOT, 'main/tools/common.js')), requireApproval: async (ctx, kind, title) => approvals.push({ kind, title }) } });
  const tools = load('main/tools/appearance.js');
  const tool = (Array.isArray(tools) ? tools : tools.tools || Object.values(tools).flat()).find((t) => t?.name === 'persona_switch');
  assert.ok(tool, 'persona_switch exists');
  const events = [];
  const ctx = (tainted) => ({ turn: { tainted }, emit: (e) => events.push(e) });
  let r = await tool.run({ persona: 'nova' }, ctx(false));
  assert.deepStrictEqual(r.switched && r.now, 'Nova');
  assert.strictEqual(approvals.length, 0, 'the user asked: no approval');
  assert.ok(events.some((e) => e.type === 'settings_changed'), 'the window hears about it');
  r = await tool.run({ persona: 'Captain Vega' }, ctx(true));
  assert.strictEqual(r.now, 'Captain Vega');
  assert.deepStrictEqual(approvals.map((a) => a.kind), ['settings'], 'after reading outside content it asks first');
  await assert.rejects(tool.run({ persona: 'Nobody' }, ctx(false)), (err) => /No persona called "Nobody"/.test(err.message) && /Nova/.test(err.message));
  assert.match(tool.description, /cannot create personas or edit their master prompts/);
});

test('who is answering: named every turn, the switch said once, never another persona as self', async () => {
  const prompt = load('main/prompt.js');
  const s = await persona.activate('Nova');
  const plain = await prompt.turnContext(s, [], null, { relevant: false });
  assert.match(plain, /You are Nova, in character/);
  assert.ok(!/just switched/.test(plain), 'no switch, no switch note');
  const same = await prompt.turnContext(s, [], null, { relevant: false, previousPersona: 'Nova' });
  assert.ok(!/just switched/.test(same), 'the same persona as before');
  const switched = await prompt.turnContext(s, [], null, { relevant: false, previousPersona: 'Captain Vega' });
  assert.match(switched, /switched to you: the replies above were Captain Vega's, not yours/);
  assert.match(switched, /Don't mention the switch/);
  assert.match(switched, /Never call yourself a costume/);
  assert.ok(!/You are Captain Vega/.test(switched));
});

test('a message answered again says so in its context (Try again, Regenerate, Edit)', async () => {
  const prompt = load('main/prompt.js');
  const s = await persona.activate('Nova');
  const again = await prompt.turnContext(s, [], null, { relevant: false, again: 'X' });
  assert.ok(again.includes('## Answering this message again\nX'));
  assert.ok(!(await prompt.turnContext(s, [], null, { relevant: false })).includes('Answering this message again'));
});

test('who wrote the latest reply: the persona stored on it, skipping the user and replies from before personas', () => {
  const llm = fs.readFileSync(path.join(ROOT, 'main/llm.js'), 'utf8');
  assert.match(llm, /previousPersona = core\.lastPersona\(history\)|previousPersona = require\('\.\/personacore'\)\.lastPersona\(history\)/, 'llm.js asks personacore');
  const msgs = (...list) => list.map(([role, p]) => ({ role, content: 'x', ...(p ? { persona: p } : {}) }));
  assert.strictEqual(core.lastPersona(msgs(['assistant', 'Nova'], ['user'], ['assistant', 'Vega'], ['user'])), 'Vega');
  assert.strictEqual(core.lastPersona(msgs(['assistant', 'Nova'], ['user'], ['assistant'], ['user'])), 'Nova', 'a reply without a persona (before 2.7.10) is skipped');
  assert.strictEqual(core.lastPersona(msgs(['user'])), '');
  assert.strictEqual(core.lastPersona([]), '');
  assert.strictEqual(core.lastPersona(undefined), '');
});

test('a persona with scene: null (new, template or removed scene) never inherits Siren’s default scene on switch', async () => {
  const fresh = await persona.create({ name: 'Ringmaster' });
  assert.strictEqual(fresh.appearance.scene, null, 'a fresh persona starts with no scene');
  await persona.activate('Aria');
  assert.strictEqual((await store.getSettings()).appearance.scene?.svg, '<svg>A</svg>', 'Aria has her scene');
  const back = await persona.activate('Ringmaster');
  assert.strictEqual(back.appearance.scene, null, 'switching back to Ringmaster keeps scene null');
  await persona.remove(fresh.personas.active);
});

// ------------------------------------------------ writes bound to their persona (store.setSettings opts.persona)
// The rule lives in the store: a change computed for one persona (before an approval, a model call, the
// voice being made) is saved only while that persona is active. Before, theme_update, the new-voice switch
// and setup_generate_look read the settings, awaited, then wrote a plain patch: a switch from the phone,
// the watch or a routine meanwhile put the old persona's look or voice into the new one.

test('isSwitch: only a patch that makes another persona active', () => {
  const s = { personas: { active: 'p-1' } };
  assert.strictEqual(core.isSwitch(s, { personas: { active: 'p-2' } }), true);
  assert.strictEqual(core.isSwitch(s, { personas: { active: 'p-1' } }), false, 'the same one');
  assert.strictEqual(core.isSwitch(s, { personas: { list: [] } }), false, 'the list only');
  assert.strictEqual(core.isSwitch(s, { agent: { name: 'x' } }), false);
  assert.strictEqual(core.isSwitch(s, null), false);
});

test('a write bound to a persona that is no longer active is refused, says so, and lands nowhere', async () => {
  const [from, to] = [ids[0], ids[3]];
  await persona.activate(from);
  const switching = persona.activate(to); // queued first: lands first
  const write = store.setSettings({ voice: { localVoice: 'bound-voice' } }, { persona: from });
  await switching;
  await assert.rejects(write, (err) => err.code === store.PERSONA_CHANGED && err.settings.personas.active === to && /persona changed meanwhile/.test(err.message) && err.message.includes(SPECS[3].name));
  const s = await store.getSettings();
  assert.deepStrictEqual(s.personas.list.filter((x) => x.localVoice === 'bound-voice'), []);
  for (const id of ids) assert.deepStrictEqual(canon(entry(s, id)), expected[id]);
  // A change to no persona field is saved whoever is active; a function patch is checked the same way.
  await store.setSettings({ ui: { zoom: 1.2 } }, { persona: from });
  assert.strictEqual((await store.getSettings()).ui.zoom, 1.2);
  await assert.rejects(store.setSettings(() => ({ appearance: { greeting: 'late' } }), { persona: from }), { code: store.PERSONA_CHANGED });
  await store.setSettings({ ui: { zoom: store.DEFAULTS.ui.zoom } });
  // For the live persona it is saved.
  await store.setSettings({ voice: { localVoice: 'bound-voice' } }, { persona: to });
  assert.strictEqual(entry(await store.getSettings(), to).localVoice, 'bound-voice');
  await store.setSettings({ voice: { localVoice: expected[to].localVoice } });
});

// The agent's tools, with a switch made while each one waits (an approval, the model, the voice being made).
let during = null; // run once at the next await point a test arms
const waitPoint = async () => {
  const f = during;
  during = null;
  if (f) await f();
};
let toolsMod = null;
function agentTools() {
  if (toolsMod) return toolsMod;
  const common = { ...require(path.join(ROOT, 'main/tools/common.js')), requireApproval: waitPoint };
  stub({
    './common': common,
    './tools/common': common,
    '../voicestudio': { design: async ({ name }) => ({ id: name, name, understood: [], ignored: [] }), list: async () => [], AUDIO_TYPES: {} },
    './voice': { voices: async () => [] },
  });
  load('main/tools/appearance.js');
  load('main/tools/voice.js');
  toolsMod = load('main/tools.js');
  return toolsMod;
}
const ctx = () => ({ turn: { tainted: true }, emit: () => {}, logTags: {} }); // tainted: theme_update asks first
const lookFor = (marker) => JSON.stringify({ name: marker, colors: { accent: '#123456', bg: '#010203' }, personaNotes: 'notes', greeting: marker, voice: null });

// Each path writes `marker` into persona fields, waits at waitPoint on the way, and finds the marker in an entry.
const PATHS = [
  { name: 'theme_update', run: (m) => agentTools().execute('theme_update', { name: m, colors: { accent: '#123456' } }, ctx()), has: (x, m) => x.theme?.name === m },
  { name: 'voice_design (use_now)', run: (m) => agentTools().execute('voice_design', { name: m, description: 'warm', use_now: true }, ctx()), has: (x, m) => x.voice === m, keepsGoing: true },
  { name: 'settings_update voice.voice', run: (m) => agentTools().execute('settings_update', { section: 'voice', key: 'voice', value: m }, ctx()), has: (x, m) => x.voice === m },
  {
    name: 'setup_generate_look',
    run: (m) => {
      llmStub.complete = async () => (await waitPoint(), lookFor(m));
      return agentTools().execute('setup_generate_look', {}, ctx());
    },
    has: (x, m) => x.theme?.name === m || x.greeting === m,
  },
  { name: 'Settings (persona.saveFor)', queued: true, run: async (m) => ({ ok: (await persona.saveFor(currentFrom, { agent: { personality: m } })).saved }), has: (x, m) => x.personality === m },
  { name: 'Persona studio summary (setSummary)', queued: true, run: async (m) => ({ ok: !(await persona.setSummary(`${m} summary`, currentFrom)).dropped }), has: (x, m) => x.personaSummary?.text === `${m} summary` },
];
let currentFrom = null;

async function raceOnce(p, from, to, marker, race) {
  await persona.activate(from);
  currentFrom = from;
  let switching = null;
  if (race && p.queued) switching = persona.activate(to); // no await inside: the switch is queued first
  else if (race) during = () => persona.activate(to);
  const r = await p.run(marker);
  await switching;
  during = null;
  return r;
}

for (const p of PATHS.filter((x) => !x.queued)) {
  test(`regression: ${p.name} made for one persona, a switch while it waits: nothing lands in either`, async () => {
    const [from, to] = [ids[1], ids[2]];
    const marker = `race-${p.name}`;
    const r = await raceOnce(p, from, to, marker, true);
    if (p.keepsGoing) {
      assert.strictEqual(r.ok, true, 'the voice was made');
      assert.strictEqual(r.result.using, false);
      assert.match(r.result.note, /Not switched to it: the persona changed meanwhile/);
    } else {
      assert.strictEqual(r.ok, false);
      assert.match(r.result.error, /^Not saved: the persona changed meanwhile/, 'the model reads why nothing was saved');
    }
    const s = await store.getSettings();
    assert.strictEqual(s.personas.active, to);
    assert.deepStrictEqual(s.personas.list.filter((x) => p.has(x, marker)).map((x) => x.id), []);
    for (const id of ids) assert.deepStrictEqual(canon(entry(s, id)), expected[id], id);
    // Without the switch it is saved, in that persona only.
    const ok = await raceOnce(p, from, to, `${marker}-ok`, false);
    assert.strictEqual(ok.ok, true, JSON.stringify(ok.result));
    const after = await store.getSettings();
    assert.deepStrictEqual(after.personas.list.filter((x) => p.has(x, `${marker}-ok`)).map((x) => x.id), [from]);
    expected[from] = canon(entry(after, from));
  });
}

test('theme_update computes the theme in the save queue: an edit saved while it waited stays', async () => {
  await persona.activate(ids[0]);
  during = () => store.setSettings({ appearance: { theme: { ...expected[ids[0]].theme, radius: 3 } } });
  const r = await agentTools().execute('theme_update', { colors: { accent: '#abcdef' } }, ctx());
  assert.strictEqual(r.ok, true);
  const t = (await store.getSettings()).appearance.theme;
  assert.strictEqual(t.radius, 3, 'the edit from meanwhile');
  assert.strictEqual(t.colors.accent, '#abcdef', 'and the tool’s change');
  expected[ids[0]] = canon(entry(await store.getSettings(), ids[0]));
  // A bad value is said before anything is asked or saved.
  let asked = false;
  during = () => (asked = true);
  const bad = await agentTools().execute('theme_update', { colors: { accent: 'blue' } }, ctx());
  assert.strictEqual(bad.ok, false);
  assert.match(bad.result.error, /hex color/);
  assert.strictEqual(asked, true, 'the approval comes first, as before'); // unchanged order: approval, then the check
  during = null;
});

test('a long random walk of persona writes from every path, switches landing mid-write: each lands only in its own persona', async () => {
  const rand = rng(20261121);
  for (let step = 0; step < 48; step++) {
    const p = PATHS[Math.floor(rand() * PATHS.length)];
    const i = Math.floor(rand() * ids.length);
    const from = ids[i];
    const to = ids[(i + 1 + Math.floor(rand() * (ids.length - 1))) % ids.length];
    const race = rand() < 0.5;
    const marker = `walk-${step}`;
    await raceOnce(p, from, to, marker, race);
    const s = await store.getSettings();
    const holders = s.personas.list.filter((x) => p.has(x, marker)).map((x) => x.id);
    assert.deepStrictEqual(holders, race ? [] : [from], `step ${step} (${p.name}, ${race ? 'switched meanwhile' : 'no switch'})`);
    assert.strictEqual(s.personas.active, race ? to : from);
    if (!race) expected[from] = canon(entry(s, from));
    for (const id of ids) assert.deepStrictEqual(canon(entry(s, id)), expected[id], `step ${step}: ${id}`);
    assert.deepStrictEqual(pick(live(s)), canon(entry(s, s.personas.active)), `step ${step}: live = the active persona`);
  }
});
