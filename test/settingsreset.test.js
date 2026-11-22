// Reset settings: heard by store.onChange like every other save (so paired devices learn the persona went
// back), returning { settings, kept } for Settings' notice, keeping the backup as the old copy until a clean
// load, re-applying every settings effect, and opening the setup wizard at the next launch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./appfixture')('settingsreset', { server: true });
const { dir, store, read, load, esm, pairDevice } = fx;
const { quietLog } = require('./helpers');

// main.js wires store.onChange to the companion (a persona or look change → info.changed, the phone and the
// watch fetch /api/info again) and to the window's connector levels. resetSettings runs "inside the save
// queue, like every other save", and a reset that puts the persona back to Siren is such a change too.
test('a reset is heard like every other save (store.onChange), so paired devices learn the persona changed', async () => {
  const auth = await pairDevice('Reset phone');
  const heard = [];
  const off = store.onChange((s, patch) => heard.push({ s, patch }));
  try {
    await store.setSettings({ agent: { name: 'Juniper' } });
    assert.strictEqual(heard.length, 1, 'a save is heard');
    assert.strictEqual((await (await fetch(`${fx.base}/api/info`, { headers: auth })).json()).name, 'Juniper');
    const r = await store.resetSettings();
    assert.strictEqual((await (await fetch(`${fx.base}/api/info`, { headers: auth })).json()).name, store.DEFAULTS.agent.name, 'the computer now says Siren');
    assert.strictEqual(heard.length, 2, 'the reset was never heard: no store.onChange listener runs (main.js: companion.settingsChanged, the window’s connector levels), so the phone and the watch keep showing Juniper (her name, face and colours) until something else changes');
    assert.deepStrictEqual(heard[1].s, r.settings, 'listeners get the settings the reset left');
    assert.ok(Object.keys(heard[1].patch || {}).includes('agent'), 'the persona’s section is in what changed (companion INFO_SECTIONS)');
  } finally {
    off();
  }
});

test('Reset settings: the store’s { settings, kept } is what Settings’ notice reads; the backup stays the old copy until a clean load; the next launch opens the wizard', async () => {
  const fresh = () => load('main/store.js'); // a new launch reads the files again
  await fresh().setSettings({ onboarded: true, privacy: { acceptedAt: 1234 }, agent: { name: 'Juniper' }, ui: { zoom: 1.1 } });
  const s2 = fresh();
  await s2.getSettings(); // a clean load: the last good copy is written
  const backup = path.join(dir, 'settings.backup.json');
  const backupName = () => JSON.parse(fs.readFileSync(backup, 'utf8')).agent?.name;
  assert.strictEqual(backupName(), 'Juniper');

  const r = await s2.resetSettings();
  assert.deepStrictEqual(Object.keys(r).sort(), ['kept', 'settings']);
  assert.match(path.basename(r.kept), /^settings\.before-reset-\d+\.json$/);
  assert.strictEqual(path.dirname(r.kept), dir, 'in the data folder');
  assert.strictEqual(JSON.parse(fs.readFileSync(r.kept, 'utf8')).agent.name, 'Juniper', 'the copy is what was replaced');
  assert.strictEqual(r.settings.agent.name, s2.DEFAULTS.agent.name);
  assert.strictEqual(r.settings.onboarded, false);
  assert.strictEqual(backupName(), 'Juniper', 'the reset (an empty load) writes no backup');

  // Settings' Reset action, evaluated on that result (and on a reset with no file to keep).
  const src = read('renderer/js/settings.js');
  const m = /const r = await api\.settings\.reset\(\);\s*await loadSettings\(\);\s*return (r\?\.kept \? `[^`]*` : '[^']*');/.exec(src);
  assert.ok(m, 'settings.js reads the reset’s { settings, kept } result');
  const notice = new Function('r', `return ${m[1]};`);
  assert.strictEqual(notice(r), `Settings reset. Your old settings are in ${path.basename(r.kept)} in the data folder.`);
  assert.strictEqual(notice({ settings: {}, kept: '' }), 'Settings reset.');
  assert.strictEqual(notice(undefined), 'Settings reset.');
  // The IPC handler returns the store's result once the settings effects (settingseffects.js, behind
  // store.onChange, with every section as what changed) have settled: remote access stops with
  // remote.enabled false, not at the next launch.
  const main = read('main/main.js');
  assert.match(main, /handle\('settings:reset', async \(\) => \{\n\s*const r = await store\.resetSettings\(\);\n\s*await settingsEffects\.settled\(\);\n\s*return r;\n\s*\}\);/, 'the IPC handler returns the store’s result');
  for (const section of ['remote', 'logging', 'stt', 'voice', 'routing']) assert.ok(section in r.settings, `${section}: a reset's patch names it`);
  const did = [];
  const effects = load('main/settingseffects.js');
  effects.init(
    {
      store: s2,
      log: { ...quietLog, setDebug: () => did.push('logging') },
      companion: { apply: async (s) => did.push(`remote:${s.remote.enabled}`), settingsChanged: () => did.push('devices') },
      helperApps: { ensureAll: () => did.push('helper apps') },
      router: { reset: () => did.push('router') },
      registerShortcut: async () => did.push('shortcut'),
      toWindow: () => {},
      persona: { ensureSummary: async () => ({}) },
    },
    { summaryAfterStartMs: null },
  );
  await s2.resetSettings();
  await effects.settled();
  effects.stop();
  for (const e of ['remote:false', 'logging', 'shortcut', 'helper apps', 'router', 'devices']) assert.ok(did.includes(e), `a reset re-applies ${e}`);

  // The window saves something before the next launch; that launch still opens the wizard (onboarded is
  // written as false, so the install isn't taken for one from before the wizard, LEGACY).
  await s2.setSettings({ ui: { zoom: 1.25 } });
  assert.strictEqual(backupName(), 'Juniper', 'a save writes no backup either');
  const s = await fresh().getSettings();
  const onboard = await esm('renderer/js/onboardcore.js');
  assert.strictEqual(onboard.launchMode(s), 'full');
  assert.strictEqual(s.agent.name, s2.DEFAULTS.agent.name);
  assert.strictEqual(s.llm.provider, s2.DEFAULTS.llm.provider, 'no legacy brain');
  assert.strictEqual(s.ui.zoom, 1.25);
  assert.strictEqual(backupName(), s2.DEFAULTS.agent.name, 'the next clean load makes the reset settings the last good copy');
});
