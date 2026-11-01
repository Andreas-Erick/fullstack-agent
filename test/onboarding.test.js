// The first-run setup stays true to the app: the wizard's face list keeps the default face, the tour
// names the voice in use, the setup conversation's script matches how voices and approvals work now,
// and every view's advertised shortcut really works.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, stub, load, tmpDir, quietLog } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const dir = tmpDir('nexus-onboard-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function loadCore() {
  const copy = path.join(dir, 'onboardcore.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/onboardcore.js'), copy);
  return import(pathToFileURL(copy).href);
}

const BUILT = [{ id: 'siren', title: 'Siren', tagline: 'older' }, { id: 'radial', title: 'Radial', tagline: 'bars' }];
const OWN = [{ id: 'custom:siren', title: 'Siren', tagline: 'on her rock' }];

test('the wizard lists the default custom face first, selectable, and tells the two Sirens apart', async () => {
  const { faceChoices } = await loadCore();
  const list = faceChoices('custom:siren', OWN, BUILT);
  assert.deepStrictEqual(list.map((f) => f.value), ['custom:siren', 'siren', 'radial']);
  assert.strictEqual(list[0].title, 'Siren');
  assert.strictEqual(list[1].title, 'Siren (built-in)');
  assert.strictEqual(list[2].title, 'Radial');
});

test('the face in use is always offered, even if its folder could not be listed', async () => {
  const { faceChoices } = await loadCore();
  const list = faceChoices('custom:siren', [], BUILT);
  assert.strictEqual(list[0].value, 'custom:siren');
  assert.strictEqual(faceChoices('radial', [], BUILT).length, 2);
});

test('the face in use comes first, ahead of example faces', async () => {
  const { faceChoices } = await loadCore();
  const list = faceChoices('custom:siren', [{ id: 'custom:rings', title: 'Pulse Rings' }, ...OWN], BUILT);
  assert.deepStrictEqual(list.map((f) => f.value), ['custom:siren', 'custom:rings', 'siren', 'radial']);
  assert.strictEqual(faceChoices('radial', OWN, BUILT)[0].value, 'radial');
});

test('the wizard speaks of Settings only, and its face list comes from the helper', () => {
  const src = read('renderer/js/onboarding.js');
  assert.ok(!src.includes('Config →'));
  assert.match(src, /choices\(faceChoices\(/);
  assert.match(src, /documents: \{ workspace: d \}/, 'the wizard offers the workspace folder');
  assert.match(src, /stt: \{ engine: v \}/, 'the wizard offers cloud speech recognition');
});

test('the tour names the voice engine in use', () => {
  stub({ './store': { getSettings: async () => ({}) }, './logger': quietLog });
  const { FEATURES } = load('main/guide.js');
  const talk = FEATURES.find((f) => f.id === 'talk');
  const status = (engine) => talk.status({ voice: { ttsEnabled: true, engine }, stt: { enabled: true, micMode: 'ptt', pttKey: 'F8' } });
  assert.match(status('local'), /offline voice/);
  assert.match(status('cloud'), /cloud voice/);
  assert.match(status('voicestudio'), /VoiceStudio/);
  assert.match(talk.what, /cloud voice/);
  assert.match(FEATURES.find((f) => f.id === 'safety').what, /problem report/);
});

test('the setup conversation describes today\'s voices, faces and approvals', () => {
  const src = read('main/prompt.js');
  const script = src.slice(src.indexOf('function buildSetup'));
  assert.ok(!/built-in voice/.test(script), 'the offline voice is the fallback, not the system voice');
  assert.match(script, /offline voice/);
  assert.match(script, /voice\.engine to "voicestudio"/);
  assert.match(script, /custom:siren/);
  assert.match(script, /always ask before changing your own code/);
});

test('the setup conversation can pick a voice engine, but never the cloud voice', () => {
  const tools = read('main/tools.js');
  assert.match(/const SETUP_SETTABLE = \[([\s\S]*?)\];/.exec(tools)[1], /'voice\.engine'/);
  assert.match(tools, /a\.setting === 'voice\.engine' && !\['local', 'voicestudio'\]\.includes\(value\)/);
});

test('the setup conversation offers local models and the form for several providers', () => {
  const src = read('renderer/js/setup.js');
  assert.match(src, /value: 'local'/);
  assert.match(src, /value: 'form'/);
  assert.match(src, /api\.llm\.localModels\(\)/);
});

test('every shortcut a rail button advertises opens that view', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/js/app.js');
  const views = JSON.parse(/const views = (\[[^\]]*\]);/.exec(app)[1].replace(/'/g, '"'));
  const top = Math.max(...[...app.matchAll(/Digit\[1-(\d)\]/g)].map((m) => Number(m[1])));
  const buttons = [...html.matchAll(/data-view="(\w+)" title="[^"]*\(Ctrl\+(\d)\)"/g)];
  assert.ok(buttons.length >= 9);
  for (const [, view, key] of buttons) {
    assert.strictEqual(views[Number(key) - 1], view, `Ctrl+${key}`);
    assert.ok(Number(key) <= top, `Ctrl+${key} is handled (keys up to ${top})`);
  }
});
