// Siren's shipped face and scene (main/brand.js, main/faces.js placeBundled, main/scenes): the defaults
// of a fresh install, the face copied into the user's faces folder and refreshed only when unedited,
// the scene files clean as shipped, and existing installs keeping what they have.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const scenecore = require('../main/scenecore');
const brand = require('../main/brand');

test('the defaults: the shipped Siren face and her scene, both drawings clean as shipped', () => {
  assert.strictEqual(brand.FACE, 'custom:siren');
  assert.ok(fs.existsSync(path.join(ROOT, 'renderer/faces/bundled/siren/index.html')));
  for (const [text, orientation] of [[brand.SCENE.svg, 'landscape'], [brand.SCENE.portrait, 'portrait']]) {
    const c = scenecore.cleanScene(text, { orientation });
    assert.strictEqual(c.svg, text, `${orientation}: shipped already clean`);
    assert.ok(c.layers, `${orientation}: the three layers`);
  }
  assert.ok(!/https?:\/\//.test(fs.readFileSync(path.join(ROOT, 'renderer/faces/bundled/siren/index.html'), 'utf8')), 'the face reaches nothing outside');
});

test('the shipped face is placed once, refreshed when unedited, kept when edited, not brought back when removed', async () => {
  const dir = tmpDir('nexus-bundled-');
  stub({ electron: { app: { getPath: () => dir } }, './logger': quietLog, './store': fileStore(dir, { getSettings: async () => ({}) }) });
  const faces = load('main/faces.js');
  const d = await faces.dir();
  const file = path.join(d, 'siren', 'index.html');
  assert.ok(fs.existsSync(file), 'copied on first use');
  assert.ok((await faces.list()).some((f) => f.id === 'custom:siren' && f.title === 'Siren'));
  const shipped = fs.readFileSync(file, 'utf8');
  // A new version changes the shipped face: an unedited copy follows.
  const marker = path.join(d, '.bundled.json');
  const seen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.writeFileSync(file, '<!-- older -->');
  seen.siren = require('crypto').createHash('sha1').update('<!-- older -->').digest('hex');
  fs.writeFileSync(marker, JSON.stringify(seen));
  await faces.placeBundled(d);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), shipped, 'refreshed');
  // Edited by the user: kept.
  fs.writeFileSync(file, `${shipped}\n<!-- mine -->`);
  const seen2 = JSON.parse(fs.readFileSync(marker, 'utf8'));
  seen2.siren = 'f'.repeat(40);
  fs.writeFileSync(marker, JSON.stringify(seen2));
  await faces.placeBundled(d);
  assert.match(fs.readFileSync(file, 'utf8'), /mine/);
  // Removed: stays removed.
  fs.rmSync(path.join(d, 'siren'), { recursive: true });
  await faces.placeBundled(d);
  assert.ok(!fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an existing install keeps its face and scene; only a fresh one starts with Siren’s', async () => {
  const dir = tmpDir('nexus-bundled-store-');
  stub({ electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } }, './logger': quietLog });
  const store = load('main/store.js');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true, ui: { face: 'rain' }, appearance: { theme: null } }));
  const s = await store.getSettings();
  assert.strictEqual(s.ui.face, 'rain');
  assert.strictEqual(s.appearance.scene, null, 'no scene appears behind an existing persona');
  fs.rmSync(dir, { recursive: true, force: true });
});
