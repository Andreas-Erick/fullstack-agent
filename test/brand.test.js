// The rename to Siren Assistant (main/brand.js, main/datadir.js, store.js LEGACY): new installs get
// Siren; installs from before keep their name, look, face, voice and data folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const brand = require('../main/brand');

function freshStore(settings) {
  const dir = tmpDir('nexus-brand-');
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  stub({ electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } }, './logger': quietLog });
  return { store: load('main/store.js'), dir };
}

test('a new install is Siren: name, master prompt, theme, face and the offline voice', async () => {
  const { store, dir } = freshStore();
  const s = await store.getSettings();
  assert.strictEqual(s.agent.name, 'Siren');
  assert.strictEqual(s.agent.personality, brand.MASTER_PROMPT);
  assert.strictEqual(s.appearance.theme.name, 'Siren');
  assert.strictEqual(s.ui.face, 'custom:siren', 'her shipped face');
  assert.strictEqual(s.appearance.scene?.caption, brand.SCENE.caption, 'her place behind the face');
  assert.ok(brand.SCENE.svg.length > 1000 && brand.SCENE.portrait.length > 1000, 'wide and tall drawings');
  assert.strictEqual(s.voice.engine, 'local');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an install from before the rename keeps what it had, even where it never saved a value', async () => {
  const { store, dir } = freshStore({ onboarded: true, agent: { avatar: null }, voice: { speed: 1.1 }, ui: { zoom: 1 } });
  const s = await store.getSettings();
  assert.strictEqual(s.agent.name, 'Nexus');
  assert.match(s.agent.personality, /capable co-pilot/);
  assert.strictEqual(s.appearance.theme, null);
  assert.strictEqual(s.ui.face, 'circuit');
  assert.strictEqual(s.voice.engine, 'voicestudio');
  assert.strictEqual(s.voice.speed, 1.1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saved choices always win over the legacy values', async () => {
  const { store, dir } = freshStore({ onboarded: true, agent: { name: 'Aria' }, ui: { face: 'siren' }, voice: { engine: 'local' } });
  const s = await store.getSettings();
  assert.strictEqual(s.agent.name, 'Aria');
  assert.strictEqual(s.ui.face, 'siren');
  assert.strictEqual(s.voice.engine, 'local');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the data folder: moved from the old name once, never over an existing one, override wins', () => {
  stub({ electron: { app: { getPath: () => '' } } });
  const { plan } = load('main/datadir.js');
  const has = (...dirs) => (d) => dirs.includes(d);
  const base = { current: '/data/Siren Assistant', legacy: '/data/Nexus Agent' };
  assert.deepStrictEqual(plan({ ...base, exists: has('/data/Nexus Agent') }), { move: ['/data/Nexus Agent', '/data/Siren Assistant'] });
  assert.deepStrictEqual(plan({ ...base, exists: has('/data/Nexus Agent', '/data/Siren Assistant') }), {});
  assert.deepStrictEqual(plan({ ...base, exists: has() }), {});
  assert.deepStrictEqual(plan({ ...base, override: '/tmp/x', exists: has('/data/Nexus Agent') }), { use: path.resolve('/tmp/x') });
});
