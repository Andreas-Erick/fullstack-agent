// Saving settings (main/store.js) under fast or odd use: several toggles flipped at once, a damaged
// settings file, a patch with odd values. Every change must land, and nothing may be lost or crash.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('siren-settings-');
const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`x${s}`), decryptString: (b) => b.toString().slice(1) };
stub({ electron: { app: { getPath: () => dir }, safeStorage }, './logger': quietLog });
let store = load('main/store.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const onDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

test('toggles flipped quickly one after another all land (regression: the second save lost the first)', async () => {
  await store.getSettings();
  await Promise.all([
    store.setSettings({ ui: { showClaudeUsage: false } }),
    store.setSettings({ llm: { autoPace: false } }),
    store.setSettings({ voice: { autoSpeak: false } }),
    store.setSettings({ ui: { sleepAfterMin: 7 } }),
  ]);
  const s = await store.getSettings();
  assert.strictEqual(s.ui.showClaudeUsage, false);
  assert.strictEqual(s.llm.autoPace, false);
  assert.strictEqual(s.voice.autoSpeak, false);
  assert.strictEqual(s.ui.sleepAfterMin, 7);
  const disk = onDisk();
  assert.strictEqual(disk.ui.showClaudeUsage, false, 'and on disk too');
  assert.strictEqual(disk.llm.autoPace, false);
  assert.strictEqual(disk.voice.autoSpeak, false);
});

test('a burst of 50 saves to the same field ends on the last one, in memory and on disk', async () => {
  await Promise.all([...Array(50)].map((_, i) => store.setSettings({ ui: { sleepAfterMin: i } })));
  assert.strictEqual((await store.getSettings()).ui.sleepAfterMin, 49);
  assert.strictEqual(onDisk().ui.sleepAfterMin, 49);
});

test('every listener hears every change, and one that throws doesn\'t stop the save', async () => {
  const heard = [];
  const off1 = store.onChange(() => {
    throw new Error('listener bug');
  });
  const off2 = store.onChange((_s, patch) => heard.push(Object.keys(patch)[0]));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await Promise.all([store.setSettings({ ui: { zoom: 1.1 } }), store.setSettings({ web: { enabled: true } })]);
  } finally {
    console.warn = warn;
  }
  off1();
  off2();
  assert.deepStrictEqual(heard.sort(), ['ui', 'web']);
  assert.strictEqual((await store.getSettings()).ui.zoom, 1.1);
});

test('secrets are never written in plain text', async () => {
  await store.setSettings({ anthropic: { apiKey: 'sk-ant-secret-123' } });
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), /sk-ant-secret-123"/);
  assert.strictEqual((await store.getSettings()).anthropic.apiKey, 'sk-ant-secret-123');
});

test('a damaged settings file: the last good copy comes back, the damaged one is kept', async () => {
  await store.setSettings({ agent: { name: 'Nova' } });
  store = load('main/store.js'); // the next start keeps this good file as settings.backup.json
  await store.getSettings();
  // A crash halfway through writing, a disk error, a hand edit gone wrong.
  fs.writeFileSync(path.join(dir, 'settings.json'), '{"agent": {"name": "Nov');
  store = load('main/store.js'); // a fresh start of the app
  const s = await store.getSettings();
  assert.strictEqual(s.agent.name, 'Nova', 'restored from settings.backup.json');
  assert.ok(fs.readdirSync(dir).some((f) => /^settings\.corrupt-/.test(f)), 'the damaged file is kept for a look');
});

test('an empty or missing settings file: defaults, no crash', async () => {
  fs.writeFileSync(path.join(dir, 'settings.json'), '');
  fs.rmSync(path.join(dir, 'settings.backup.json'), { force: true });
  store = load('main/store.js');
  const s = await store.getSettings();
  assert.ok(s.llm && s.ui && s.agent, 'every section there');
  fs.rmSync(path.join(dir, 'settings.json'), { force: true });
  store = load('main/store.js');
  assert.ok((await store.getSettings()).ui);
});

// ---------- the wrong shape: valid JSON that isn't settings (boundary-1, security-tests-9) ----------
const file = (name) => path.join(dir, name);
const bytesOf = (name) => (fs.existsSync(file(name)) ? fs.readFileSync(file(name)) : null);
const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const SECTIONS = Object.keys(store.DEFAULTS).filter((k) => isPlain(store.DEFAULTS[k]));
const allSectionsPlain = (s, why) => {
  for (const k of SECTIONS) assert.ok(isPlain(s[k]), `${why}: section ${k} is ${JSON.stringify(s[k])?.slice(0, 60)}`);
};
const startWith = (settingsText, backup) => {
  if (settingsText == null) fs.rmSync(file('settings.json'), { force: true });
  else fs.writeFileSync(file('settings.json'), settingsText);
  if (backup == null) fs.rmSync(file('settings.backup.json'), { force: true });
  else fs.writeFileSync(file('settings.backup.json'), backup);
  store = load('main/store.js'); // a fresh start of the app
};

// Regression: `null` in settings.json crashed every launch (merged.calendar of null), and the backup was
// rewritten from the broken file before anything was checked.
test('settings.json that is valid JSON but not an object (null, a list, a number, a string) starts with defaults', async () => {
  for (const text of ['null', '[]', '42', '"x"']) {
    startWith(text, null);
    const s = await store.getSettings();
    allSectionsPlain(s, text);
    assert.strictEqual(store.settingsRecovery().restored, false, text);
  }
});

test('…and with a last good copy, that copy comes back and the backup stays as it was', async () => {
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('settings.corrupt-'))) fs.rmSync(file(f));
  const backup = '{"agent":{"name":"Nova"}}';
  startWith('null', backup);
  const s = await store.getSettings();
  assert.strictEqual(s.agent.name, 'Nova');
  assert.strictEqual(store.settingsRecovery().restored, true);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('settings.corrupt-')), 'the damaged file is kept');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file('settings.json'), 'utf8')), JSON.parse(backup), 'settings.json is the good copy again');
  assert.strictEqual(String(bytesOf('settings.backup.json')), backup, 'the backup is not rewritten');
});

test('a section of the wrong shape goes back to its defaults; the rest of the file is kept', async () => {
  const backup = '{"agent":{"name":"Old"},"calendar":{"daysAhead":3}}';
  startWith('{"calendar":null,"anthropic":null,"ui":"x","agent":{"name":"Nova"}}', backup);
  const s = await store.getSettings();
  assert.deepStrictEqual(s.calendar, store.DEFAULTS.calendar);
  assert.deepStrictEqual(s.anthropic, store.DEFAULTS.anthropic);
  assert.strictEqual(s.ui.face, store.DEFAULTS.ui.face, 'its defaults, not an old install’s look');
  assert.ok(!('0' in s.ui), 'a string section is not spread into the settings');
  assert.strictEqual(s.agent.name, 'Nova');
  assert.deepStrictEqual(store.settingsRecovery().dropped.sort(), ['anthropic', 'calendar', 'ui']);
  assert.strictEqual(String(bytesOf('settings.backup.json')), backup, 'a file with a damaged section is never the last good copy');
  // Saved once, the next start loads cleanly and that becomes the last good copy.
  await store.setSettings({ ui: { zoom: 1.1 } });
  store = load('main/store.js');
  await store.getSettings();
  assert.strictEqual(store.settingsRecovery(), null);
  assert.strictEqual(JSON.parse(fs.readFileSync(file('settings.backup.json'), 'utf8')).ui.zoom, 1.1);
});

// Regression: a persona section (agent, appearance, ui, voice) of the wrong shape went back to its defaults,
// and the first save after that copied those defaults over the active persona's saved entry (personacore.sync):
// its name, master prompt and face were gone, and after the next start from the backup too. No copy of the
// damaged file was kept either.
test('a persona section of the wrong shape comes back from the saved persona; the damaged file is kept', async () => {
  startWith(null, null);
  await store.setSettings({ agent: { name: 'Nova', personality: 'MY OWN MASTER PROMPT' }, ui: { face: 'radial', zoom: 1.2 } });
  const damaged = onDisk();
  damaged.agent = null;
  damaged.ui = 'x';
  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('settings.corrupt-'))) fs.rmSync(file(f));
  startWith(JSON.stringify(damaged), null);
  const keeps = (s, why) => {
    assert.deepStrictEqual([s.agent.name, s.agent.personality, s.ui.face], ['Nova', 'MY OWN MASTER PROMPT', 'radial'], `${why}: the live persona`);
    const entry = s.personas.list.find((p) => p.id === s.personas.active);
    assert.deepStrictEqual([entry.name, entry.personality, entry.face], ['Nova', 'MY OWN MASTER PROMPT', 'radial'], `${why}: its saved entry`);
  };
  const s = await store.getSettings();
  keeps(s, 'after the start');
  assert.strictEqual(s.ui.zoom, store.DEFAULTS.ui.zoom, 'the rest of the section is its defaults');
  const r = store.settingsRecovery();
  assert.deepStrictEqual([...r.dropped].sort(), ['agent', 'ui']);
  assert.deepStrictEqual([...r.fromPersona].sort(), ['agent', 'ui']);
  assert.match(path.basename(r.kept), /^settings\.corrupt-\d+\.json$/);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(r.kept, 'utf8')), damaged, 'the damaged file is kept as it was');
  await store.setSettings({ web: { enabled: false } }); // an unrelated save: personacore.sync runs
  keeps(onDisk(), 'on disk after a save');
  store = load('main/store.js'); // a clean start: its copy becomes the last good one
  keeps(await store.getSettings(), 'the next start');
  assert.strictEqual(store.settingsRecovery(), null);
  keeps(JSON.parse(fs.readFileSync(file('settings.backup.json'), 'utf8')), 'the backup');
});

test('…the persona is found as personacore.ensure finds it (odd entries skipped, the first when none is active)', async () => {
  const personas = { active: 'gone', list: [null, 5, ['p0'], { name: 'No id' }, { id: 'p1', name: 'First', personality: 'Hers' }, { id: 'p2', name: 'Second' }] };
  startWith(JSON.stringify({ agent: 'x', personas }), null);
  const s = await store.getSettings();
  assert.deepStrictEqual([s.agent.name, s.agent.personality], ['First', 'Hers']);
  assert.deepStrictEqual(store.settingsRecovery().fromPersona, ['agent']);
  // No saved persona to take them from: the section's defaults, as before.
  startWith(JSON.stringify({ agent: null, personas: null }), null);
  const d = await store.getSettings();
  assert.strictEqual(d.agent.name, store.DEFAULTS.agent.name);
  assert.deepStrictEqual(store.settingsRecovery().fromPersona, []);
  assert.deepStrictEqual([...store.settingsRecovery().dropped].sort(), ['agent', 'personas']);
});

test('a change whose section isn’t an object is refused before anything is written', async () => {
  startWith(null, null);
  await store.setSettings({ ui: { zoom: 1.05 } });
  const before = bytesOf('settings.json');
  const settings = JSON.stringify(await store.getSettings());
  for (const patch of [{ calendar: null }, { anthropic: null }, [], 'x', () => 5, { ui: 'x', web: { enabled: false } }]) {
    await assert.rejects(store.setSettings(patch), /must be an object/, String(JSON.stringify(patch) ?? patch));
    assert.deepStrictEqual(bytesOf('settings.json'), before, 'settings.json untouched');
    assert.strictEqual(JSON.stringify(await store.getSettings()), settings, 'the settings in memory untouched');
  }
  await store.setSettings({ ui: { zoom: 1.2 } });
  assert.strictEqual((await store.getSettings()).ui.zoom, 1.2, 'the next good change saves');
  // Key-level nulls are values, not sections: still saved.
  assert.strictEqual((await store.setSettings({ appearance: { scene: null } })).appearance.scene, null);
});

// Regression: the value was cached before it was serialized, and every later save threw on the cache.
test('a value that can’t be stored refuses the save and changes nothing', async () => {
  const zoom = (await store.getSettings()).ui.zoom;
  const before = bytesOf('settings.json');
  await assert.rejects(store.setSettings({ ui: { zoom: 10n } }));
  assert.strictEqual((await store.getSettings()).ui.zoom, zoom);
  assert.deepStrictEqual(bytesOf('settings.json'), before);
  await store.setSettings({ ui: { zoom: 1.3 } });
  assert.strictEqual((await store.getSettings()).ui.zoom, 1.3, 'the next save works');
});

test('__proto__ and constructor in a change or in the file never reach the settings’ prototype', async () => {
  const evil = '{"__proto__":{"polluted":1},"safety":{"__proto__":{"autoApprove":true}},"constructor":{"prototype":{"x":1}}}';
  const check = (s, why) => {
    assert.strictEqual(Object.getPrototypeOf(s), Object.prototype, why);
    assert.strictEqual(Object.getPrototypeOf(s.safety), Object.prototype, why);
    assert.strictEqual(s.safety.autoApprove, undefined, why);
    assert.strictEqual(s.polluted, undefined, why);
    assert.strictEqual({}.polluted, undefined, why);
    assert.strictEqual(typeof s.constructor, 'function', why);
  };
  check(await store.setSettings(JSON.parse(evil)), 'through a change');
  check(await store.getSettings(), 'through a change, read back');
  startWith(evil, null);
  check(await store.getSettings(), 'through the file');
});

test('reset keeps a copy of the old settings (personas and encrypted keys) and leaves the backup alone', async () => {
  startWith(null, null);
  await store.setSettings({ agent: { name: 'Kept' }, anthropic: { apiKey: 'sk-ant-kept-1234' } });
  store = load('main/store.js');
  await store.getSettings(); // a clean start: settings.backup.json is this copy
  const backup = bytesOf('settings.backup.json');
  assert.ok(backup);
  const { settings, kept } = await store.resetSettings();
  assert.match(path.basename(kept), /^settings\.before-reset-\d+\.json$/);
  const old = JSON.parse(fs.readFileSync(kept, 'utf8'));
  assert.strictEqual(old.agent.name, 'Kept');
  assert.ok(old.personas.list.some((p) => p.name === 'Kept'), 'its persona entry');
  assert.ok(old.anthropic.apiKey && !old.anthropic.apiKey.includes('sk-ant-kept-1234'), 'the key, still encrypted');
  assert.strictEqual(settings.agent.name, store.DEFAULTS.agent.name);
  assert.strictEqual(settings.personas.list.length, 1);
  assert.deepStrictEqual(bytesOf('settings.backup.json'), backup);
  assert.strictEqual((await store.resetSettings()).kept, '', 'nothing to keep the second time');
});

test('a reset between two saves runs in their order', async () => {
  const [, b] = await Promise.all([store.setSettings({ agent: { name: 'Before' } }), store.resetSettings(), store.setSettings({ agent: { name: 'After' } })]);
  assert.strictEqual(JSON.parse(fs.readFileSync(b.kept, 'utf8')).agent.name, 'Before');
  assert.strictEqual((await store.getSettings()).agent.name, 'After');
  assert.strictEqual(JSON.parse(fs.readFileSync(file('settings.json'), 'utf8')).agent.name, 'After');
});

// mulberry32: a small seeded PRNG, so a failing case can be replayed from its seed and index.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('200 random changes of odd shapes: refused ones change nothing, saved ones keep every section an object', async () => {
  const SEED = 20261118;
  const rand = mulberry32(SEED);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const VALUES = [null, '', '   ', 0, -1, NaN, Infinity, [], ['a'], { deep: { er: [1, { x: null }] } }, '<script>alert(1)</script>', '👨‍👩‍👧‍👦 שלום', 'x'.repeat(10000)];
  const sectionValue = (section) => {
    const roll = rand();
    if (roll < 0.5) {
      const keys = Object.keys(store.DEFAULTS[section]);
      const out = {};
      for (let i = 0, n = 1 + Math.floor(rand() * 3); i < n && keys.length; i++) out[pick(keys)] = pick(VALUES);
      return out;
    }
    return pick([null, 'x', 42, [], { nested: { a: 1 } }]);
  };
  startWith(null, null);
  await store.getSettings();
  for (let i = 0; i < 200; i++) {
    const why = `seed ${SEED} case ${i}`;
    const patch = {};
    for (let j = 0, n = 1 + Math.floor(rand() * 2); j < n; j++) {
      const section = pick(SECTIONS);
      patch[section] = sectionValue(section);
    }
    const before = bytesOf('settings.json');
    const settings = JSON.stringify(await store.getSettings());
    let saved = null;
    try {
      saved = await store.setSettings(patch);
    } catch (err) {
      assert.deepStrictEqual(bytesOf('settings.json'), before, `${why}: refused (${err.message}), the file must be untouched`);
      assert.strictEqual(JSON.stringify(await store.getSettings()), settings, `${why}: refused, the settings must be untouched`);
      continue;
    }
    allSectionsPlain(saved, `${why}: saved`);
    // What a save wrote, the next start reads without any repair.
    const next = load('main/store.js');
    allSectionsPlain(await next.getSettings(), `${why}: the next start`);
    assert.strictEqual(next.settingsRecovery(), null, `${why}: the next start needed no repair`);
  }
  store = load('main/store.js');
  allSectionsPlain(await store.getSettings(), `seed ${SEED}: the next start`);
});
