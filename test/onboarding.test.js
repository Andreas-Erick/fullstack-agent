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

// Regression: "Skip setup" on the first page set `onboarded` without the privacy and safety notice ever
// being accepted, and nothing asked for it again.
test('every way through the wizard passes the privacy step before it can finish', async () => {
  const { STEPS, stepsFor, finishPatch } = await loadCore();
  for (const mode of ['full', 'quick', 'missed', undefined]) {
    const steps = stepsFor(mode);
    assert.ok(steps.includes('privacy'), `${mode}: has the privacy step`);
    assert.ok(steps.every((s) => STEPS.includes(s)), `${mode}: only real steps`);
  }
  assert.deepStrictEqual(stepsFor('quick'), ['welcome', 'privacy'], 'Quick start ends with the privacy step');
  assert.deepStrictEqual(stepsFor('missed'), ['privacy']);
  assert.strictEqual(finishPatch({ privacy: { acceptedAt: 0 } }), null, 'not accepted: not onboarded');
  assert.strictEqual(finishPatch({}), null);
  assert.deepStrictEqual(finishPatch({ privacy: { acceptedAt: 1763000000000 } }), { onboarded: true });
});

test('an install set up without accepting the notice sees that step once at launch', async () => {
  const { launchMode } = await loadCore();
  assert.strictEqual(launchMode({ onboarded: false, privacy: { acceptedAt: 0 } }), 'full', 'first run: the whole wizard');
  assert.strictEqual(launchMode({ onboarded: true, privacy: { acceptedAt: 0 } }), 'missed');
  assert.strictEqual(launchMode({ onboarded: true }), 'missed', 'an install from before the notice');
  assert.strictEqual(launchMode({ onboarded: true, privacy: { acceptedAt: 1763000000000 } }), '', 'accepted: nothing');
  // The memory-profile smoke run (NEXUS_SMOKE_MEM) starts set up and accepted, so it measures the app,
  // not this screen; a plain smoke run starts with no settings and meets the whole wizard ('full').
  assert.match(read('main/smoke.js'), /onboarded: true, privacy: \{ acceptedAt: Date\.now\(\) \}/);
});

test('the wizard saves `onboarded` only through the helper, and boots through the launch check', () => {
  const src = read('renderer/js/onboarding.js');
  assert.ok(!/onboarded: true/.test(src), 'no path sets onboarded by itself');
  assert.match(src, /const patch = finishPatch\(state\.settings\);\s*if \(!patch\)/);
  assert.match(src, /await saveSettings\(patch\);/);
  assert.ok(!src.includes('Skip setup'), 'nothing offers to skip the privacy step');
  // Close on the first page only once the notice is accepted; a double click moves one step, never past the last.
  assert.match(src, /accepted\(s\) \? el\('button', \{[^}]*onclick: \(\) => finish\(\) \}, 'Close'\)/);
  assert.match(src, /step = Math\.max\(0, Math\.min\(stepsFor\(mode\)\.length - 1, step \+ delta\)\);/);
  // The first acceptance's time stays when the step is passed again.
  assert.match(src, /if \(!accepted\(state\.settings\)\) await saveSettings\(\{ privacy: \{ acceptedAt: Date\.now\(\) \} \}\);/);
  // Boot: the launch greeting waits until the missed privacy step is accepted (not spoken over it).
  const app = read('renderer/js/app.js');
  assert.match(app, /const setupOpen = maybeStartOnboarding\(\{ then: greetOnLaunch \}\);/);
  assert.match(app, /if \(!setupOpen\) greetOnLaunch\(\);/);
  assert.match(src, /if \(how\) startOnboarding\(how, how === 'missed' \? then : null\);\s*return how;/);
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
  const buttons = [...html.matchAll(/data-view="(\w+)" title="[^"]*\(Ctrl\+(\d)\)"/g)].map(([, view, key]) => [view, Number(key)]);
  // The numbers follow the rail, top to bottom: Chat, Notes, Calendar, Memories, Documents (spec #17).
  assert.deepStrictEqual(buttons, [['chat', 1], ['notes', 2], ['calendar', 3], ['memory', 4], ['docs', 5]]);
  for (const [view, key] of buttons) {
    assert.strictEqual(views[key - 1], view, `Ctrl+${key}`);
    assert.ok(key <= top, `Ctrl+${key} is handled (keys up to ${top})`);
  }
  assert.strictEqual(views.length, 5, 'the More items have no number');
  assert.match(html, /data-view="settings" title="Settings \(Ctrl\+,\)"/);
  assert.match(app, /e\.key === ','\)[\s\S]{0,80}switchView\('settings'\)/);
  // Ctrl+9 stays Notes for old habits, Ctrl+Shift+N the Dump.
  assert.match(app, /e\.code === 'Digit9'\)[\s\S]{0,200}switchView\('notes'\)/);
  assert.match(app, /e\.shiftKey && e\.key\.toLowerCase\(\) === 'n'\)[\s\S]{0,160}openDump\(\)/);
});
