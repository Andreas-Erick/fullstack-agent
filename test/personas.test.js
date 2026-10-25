// Personas (main/personacore.js, main/persona.js, the sync in main/store.js): the live settings stay
// the active persona, a switch swaps everything that belongs to one, and the agent's theme changes
// are validated.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir } = require('./helpers');

const dir = tmpDir('nexus-personas-');
stub({
  electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } },
  './llm': { complete: async () => '{}' },
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
  assert.strictEqual(s.appearance.theme, null);
  assert.strictEqual(s.ui.face, 'circuit');

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
  assert.strictEqual(s.appearance.theme, null);
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
