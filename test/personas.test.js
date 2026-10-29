// Personas (main/personacore.js, main/persona.js, the sync in main/store.js): the live settings stay
// the active persona, a switch swaps everything that belongs to one, and the agent's theme changes
// are validated.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir } = require('./helpers');

const dir = tmpDir('nexus-personas-');
const fakeLlm = { complete: async () => '{}' };
stub({
  electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } },
  './llm': fakeLlm,
});
const core = load('main/personacore.js');
const store = load('main/store.js');
const persona = load('main/persona.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('an install from before personas gets its persona as the first one', async () => {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, agent: { name: 'Aria', personality: 'You are Aria.' }, ui: { face: 'rain' } }));
  const s = await store.getSettings();
  assert.strictEqual(s.personas.list.length, 1);
  assert.strictEqual(s.personas.active, core.FIRST_ID);
  assert.strictEqual(s.personas.list[0].name, 'Aria');
  assert.strictEqual(s.personas.list[0].face, 'rain');
});

test('edits to the live settings are saved with the active persona', async () => {
  await store.setSettings({ appearance: { theme: { name: 'Ember', colors: { accent: '#ff5500' } } } });
  const s = await store.getSettings();
  assert.strictEqual(s.personas.list[0].theme.name, 'Ember');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.strictEqual(onDisk.personas.list[0].theme.name, 'Ember');
});

test('create, switch back and forth, and every persona keeps its own look', async () => {
  let s = await persona.create({ name: 'Coach' });
  const coach = s.personas.active;
  assert.notStrictEqual(coach, core.FIRST_ID);
  assert.strictEqual(s.agent.name, 'Coach');
  assert.strictEqual(s.agent.personality, store.DEFAULTS.agent.personality, 'a fresh persona starts from the default prompt');
  assert.deepStrictEqual(s.appearance.theme, store.DEFAULTS.appearance.theme, 'and the default look (Siren)');
  assert.strictEqual(s.ui.face, 'custom:siren');

  await store.setSettings({ agent: { personality: 'You are a strict study coach.' }, ui: { face: 'companion' }, voice: { voice: 'coach-voice' } });
  s = await persona.activate('aria'); // by name, any case
  assert.strictEqual(s.agent.name, 'Aria');
  assert.strictEqual(s.agent.personality, 'You are Aria.');
  assert.strictEqual(s.appearance.theme.name, 'Ember');
  assert.strictEqual(s.ui.face, 'rain');
  assert.notStrictEqual(s.voice.voice, 'coach-voice');

  s = await persona.activate(coach);
  assert.strictEqual(s.agent.personality, 'You are a strict study coach.');
  assert.strictEqual(s.ui.face, 'companion');
  assert.strictEqual(s.voice.voice, 'coach-voice');
  assert.strictEqual(s.appearance.theme.name, 'Siren');
});

test('a switch never keeps the previous persona’s tall scene drawing or face colours', async () => {
  const s0 = await store.getSettings();
  const coach = s0.personas.list.find((p) => p.name === 'Coach').id;
  await persona.activate('Aria');
  await store.setSettings({ appearance: { scene: { svg: '<svg>aria wide</svg>', portrait: '<svg>aria tall</svg>', caption: 'Aria’s place' }, theme: { name: 'Ember', face: { states: { idle: ['#111111', '#222222'] } } } } });
  // Coach's scene was drawn before tall drawings existed: a wide one only; its theme names no face colours.
  await persona.activate(coach);
  await store.setSettings({ appearance: { scene: null, theme: null } });
  await store.setSettings({ appearance: { scene: { svg: '<svg>coach wide</svg>', caption: 'Coach’s place' }, theme: { name: 'Plain', colors: { bg: '#010203' } } } });
  await persona.activate('Aria');
  let s = await persona.activate(coach);
  assert.strictEqual(s.appearance.scene.svg, '<svg>coach wide</svg>');
  assert.strictEqual(s.appearance.scene.portrait, '', 'no tall drawing of Aria’s behind Coach');
  assert.strictEqual(s.appearance.theme.face?.states ?? null, null, 'no face colours of Aria’s on Coach');
  s = await persona.activate('Aria');
  assert.strictEqual(s.appearance.scene.portrait, '<svg>aria tall</svg>');
  assert.deepStrictEqual(s.appearance.theme.face.states.idle, ['#111111', '#222222']);
});

test('a tall scene drawing copied into another persona by 2.6.0–2.6.3 is dropped there, kept with its owner', () => {
  const siren = { id: 'a', name: 'Siren', scene: { svg: '<svg>cove</svg>', portrait: '<svg>cove tall</svg>', caption: 'cove' } };
  const ring = { id: 'b', name: 'Ringmaster', scene: { svg: '<svg>carnival</svg>', portrait: '<svg>cove tall</svg>', caption: 'carnival' } };
  const copy = { id: 'c', name: 'Siren (copy)', scene: { ...siren.scene } };
  const ada = { id: 'd', name: 'Ada', scene: null };
  const out = core.repairScenes([ring, siren, copy, ada], { svg: '<svg>cove</svg>', portrait: '<svg>cove tall</svg>' });
  assert.strictEqual(out[0].scene.portrait, '', 'the Ringmaster loses the cove’s tall drawing');
  assert.strictEqual(out[0].scene.svg, '<svg>carnival</svg>', 'and keeps his wide one');
  assert.strictEqual(out[1].scene.portrait, '<svg>cove tall</svg>', 'the owner keeps it (the default pair, wherever it is in the list)');
  assert.strictEqual(out[2].scene.portrait, '<svg>cove tall</svg>', 'a true copy of the whole scene keeps it too');
  assert.strictEqual(out[3].scene, null);
  // Without a default to tell the owner, the first in the list keeps it.
  const two = core.repairScenes([ring, siren], null);
  assert.strictEqual(two[0].scene.portrait, '<svg>cove tall</svg>');
  assert.strictEqual(two[1].scene.portrait, '');
});

test('duplicate copies the active persona under a free name', async () => {
  await persona.activate('Aria');
  const s = await persona.create({ copy: true });
  assert.strictEqual(s.agent.name, 'Aria (copy)');
  assert.strictEqual(s.appearance.theme.name, 'Ember');
  const again = core.create(s, { name: 'Aria (copy)' }, { newId: store.newId, defaults: store.DEFAULTS });
  assert.strictEqual(again.persona.name, 'Aria (copy) 2');
});

test('deleting the active persona switches to another; the last one stays', async () => {
  let s = await store.getSettings();
  const n = s.personas.list.length;
  s = await persona.remove(s.personas.active);
  assert.strictEqual(s.personas.list.length, n - 1);
  assert.ok(s.personas.list.some((x) => x.id === s.personas.active));
  assert.strictEqual(s.agent.name, s.personas.list.find((x) => x.id === s.personas.active).name);
  assert.throws(() => core.remove({ active: 'a', list: [{ id: 'a' }] }, 'a'), /only persona/);
  await assert.rejects(persona.activate('Nobody'), /No persona called/);
});

test('the list for the agent has no images or full prompts', async () => {
  await store.setSettings({ agent: { avatar: 'data:image/png;base64,AAAA', personality: 'x'.repeat(1000) } });
  const list = await persona.list();
  const active = list.find((x) => x.active);
  assert.strictEqual(active.hasImage, true);
  assert.ok(!JSON.stringify(list).includes('base64'));
  assert.ok(active.persona.length <= 160);
});

test('theme changes by the agent are validated and re-derive the face colors', () => {
  const current = { name: 'Old', colors: { accent: '#00e5ff' }, face: { core: 'octagon', states: { idle: ['#000000', '#111111'] } } };
  const t = persona.themeChange(current, { name: 'Synthwave', colors: { accent: '#FF2BD6', bg: '#120024' }, fonts: { display: 'Audiowide' }, background: { pattern: 'grid' }, face: { core: 'triangle' }, radius: 99 });
  assert.strictEqual(t.colors.accent, '#ff2bd6');
  assert.strictEqual(t.colors.bg, '#120024');
  assert.strictEqual(t.fonts.display, 'Audiowide');
  assert.strictEqual(t.background.pattern, 'grid');
  assert.strictEqual(t.face.core, 'triangle');
  assert.strictEqual(t.face.states, undefined);
  assert.strictEqual(t.radius, 28);
  assert.strictEqual(current.colors.accent, '#00e5ff', 'the current theme is not changed in place');
  assert.throws(() => persona.themeChange(null, { colors: { accent: 'pink' } }), /hex color/);
  assert.throws(() => persona.themeChange(null, { colors: { glow: '#ffffff' } }), /Unknown color/);
  assert.throws(() => persona.themeChange(null, { fonts: { body: 'Comic Sans' } }), /Unknown font/);
  assert.throws(() => persona.themeChange(null, { background: { pattern: 'plaid' } }), /Unknown background/);
});

test('a template persona can be added without switching to it (setup)', async () => {
  const before = await store.getSettings();
  const s = await persona.create({ template: 'life-coach', activate: false });
  assert.strictEqual(s.personas.active, before.personas.active, 'still the same persona');
  assert.strictEqual(s.agent.name, before.agent.name);
  assert.ok(s.personas.list.some((x) => x.name === 'Sol' && x.theme?.name === 'Sunrise'));
});

test('a long master prompt keeps its identity, how it speaks and lines it would say', () => {
  const filler = (n) => Array.from({ length: n }, (_, i) => `Line ${i} about something else entirely.`).join('\n');
  const text = [
    '# THE KING', '### 1. CORE IDENTITY', 'You are an ancient sovereign of Carcosa.', filler(80),
    '### 2. HISTORY', filler(120),
    '### 5. COMMUNICATION STYLE', '**Your language is elegant, precise and occasionally poetic.**', 'Avoid exaggerated archaic language.', filler(30),
    '### 9. LORE', filler(200),
    '### 15. EXAMPLE INTERACTIONS', '**Greeting**', '"Ah. You have returned. How pleasant."', '**Problem**', '"I believe I see the difficulty. Let us correct it."',
  ].join('\n');
  const d = core.digest(text);
  assert.ok(d.length <= 2400, `${d.length} chars`);
  assert.match(d, /ancient sovereign of Carcosa/, 'who it is');
  assert.ok(d.includes('How you speak:\nYour language is elegant'), 'the style section, without Markdown bold');
  assert.ok(d.includes('never reply with one of them, always answer the actual message):\n- "Ah. You have returned'), 'example lines, marked as tone only');
  assert.match(d, /Let us correct it/);
  assert.doesNotMatch(d, /LORE|Line 199/, 'the rest is left out');
  assert.strictEqual(core.digest('Warm and witty.'), 'Warm and witty.', 'a short prompt stays as it is');
  assert.ok(core.digest('word '.repeat(2000)).length <= 2400, 'no headings: the start, cut to size');
});

// ---- the short version for local models
const longPrompt = (tag) => ['# ' + tag, '### 1. CORE IDENTITY', `You are ${tag}, an ancient sovereign.`, ...Array.from({ length: 200 }, (_, i) => `Detail ${i} of the lore.`), '### 5. COMMUNICATION STYLE', 'Your language is elegant.'].join('\n');
const localBrain = { llm: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', deepModel: 'qwen3.8:27b' } };

test('which short version a local model reads: whole, written, the user’s own, or the digest', () => {
  assert.strictEqual(core.forSmallModels({ personality: 'Warm and witty.' }), 'Warm and witty.', 'a short master prompt goes in whole');
  const personality = longPrompt('Hastur');
  assert.ok(core.needsSummary({ personality }));
  assert.match(core.forSmallModels({ personality }), /How you speak:/, 'nothing written yet: the digest');
  const written = { text: 'You are Hastur, short.', for: core.fingerprint(personality), by: 'model' };
  assert.strictEqual(core.forSmallModels({ personality, personaSummary: written }), 'You are Hastur, short.');
  assert.match(core.forSmallModels({ personality: `${personality}\nOne more line.`, personaSummary: written }), /How you speak:/, 'written for an older master prompt: not used');
  const own = { text: 'My own words.', for: 'old', by: 'user' };
  assert.strictEqual(core.forSmallModels({ personality: `${personality}\nOne more line.`, personaSummary: own }), 'My own words.', 'the user’s own version always stands');
});

test('the request and the reply of the summary', () => {
  const p = core.summaryPrompt('Hastur', 'MASTER TEXT');
  assert.match(p, /second person/);
  assert.match(p, /"""\nMASTER TEXT\n"""/);
  const body = 'You are Hastur. '.repeat(30);
  assert.strictEqual(core.cleanSummary(`<think>plan</think>\nHere is the short version:\n${body}`), body.trim());
  assert.strictEqual(core.cleanSummary('Too short.'), '', 'unusable');
  assert.ok(core.cleanSummary('x. '.repeat(2000)).length <= core.SUMMARY_MAX);
});

test('the local model writes it once, on this computer, for the active persona', async () => {
  const calls = [];
  fakeLlm.complete = async (s, text) => (calls.push({ model: s.llm.model, base: s.llm.baseUrl, text }), 'You are Hastur, a calm ancient sovereign. '.repeat(10));
  await store.setSettings({ ...localBrain, agent: { name: 'Hastur', personality: longPrompt('Hastur'), personaSummary: null } });
  const st = await persona.ensureSummary();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].model, 'qwen3.8:27b', 'the strongest local model');
  assert.match(calls[0].base, /localhost/);
  assert.ok(st.fresh && st.by === 'model' && st.model === 'qwen3.8:27b');
  await persona.ensureSummary();
  assert.strictEqual(calls.length, 1, 'not again while the master prompt is the same');
  const s = await store.getSettings();
  assert.strictEqual(s.personas.list.find((p) => p.id === s.personas.active).personaSummary.by, 'model', 'kept with the persona');
});

test('the user’s version is kept; a changed persona drops a late summary; no local brain, nothing', async () => {
  let release;
  fakeLlm.complete = () => new Promise((r) => (release = r));
  await persona.setSummary('My own short King.');
  await store.setSettings({ agent: { personality: `${longPrompt('Hastur')}\nEdited.` } });
  assert.strictEqual((await persona.summaryStatus()).text, 'My own short King.', 'an edit keeps the user’s version');
  assert.strictEqual((await persona.summaryStatus()).stale, true);
  await persona.setSummary(''); // back to written ones: starts writing in the background
  await new Promise((r) => setTimeout(r, 20));
  await store.setSettings({ agent: { personality: longPrompt('Someone else') } });
  release('You are Hastur, late. '.repeat(20));
  await new Promise((r) => setTimeout(r, 50));
  assert.notStrictEqual((await store.getSettings()).agent.personaSummary?.text?.includes('late'), true, 'written for the old prompt: dropped');

  fakeLlm.complete = async () => assert.fail('no local brain: nothing is sent anywhere');
  await store.setSettings({ llm: { provider: 'claude-code' } });
  await persona.ensureSummary();
  await assert.rejects(persona.ensureSummary({ force: true }), /needs a local model/);
  await store.setSettings(localBrain);
});
