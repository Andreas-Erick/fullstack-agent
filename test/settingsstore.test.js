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
