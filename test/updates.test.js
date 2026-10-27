// New versions (main/updatecore.js, main/updates.js): comparing versions, the downloads picked from a
// GitHub release, the cached state, what paired phones get, and that only the user controls it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
const core = require('../main/updatecore');

const DL = 'https://github.com/Andreas-Erick/fullstack-agent/releases/download/v2.1.0/';
const release = {
  tag_name: 'v2.1.0',
  html_url: 'https://github.com/Andreas-Erick/fullstack-agent/releases/tag/v2.1.0',
  body: '## What is new\n- Timelapse',
  published_at: '2026-10-27T12:00:00Z',
  assets: ['Siren-Assistant-Setup-2.1.0.exe', 'Siren-Assistant-Setup-2.1.0.exe.blockmap', 'Siren-Assistant-2.1.0-mac-arm64.dmg', 'Siren-Assistant-2.1.0-mac-x64.dmg', 'Siren-Android-2.1.0.apk', 'Siren-Wear-2.1.0.apk', 'Siren-Assistant-2.1.0.msi'].map((name) => ({ name, browser_download_url: DL + name })),
};

test('versions: only a higher release counts, never a pre-release', () => {
  assert.ok(core.newer('2.1.0', '2.0.3'));
  assert.ok(core.newer('v2.0.10', '2.0.9'));
  assert.ok(!core.newer('2.0.3', '2.0.3'));
  assert.ok(!core.newer('1.9.9', '2.0.0'));
  assert.ok(!core.newer('2.1.0-beta', '2.0.0'));
  assert.ok(!core.newer('', '2.0.0'));
});

test('the right download for each computer, the APKs for phone and watch, GitHub links only', () => {
  assert.strictEqual(core.fromRelease(release, { platform: 'win32' }).desktop, `${DL}Siren-Assistant-Setup-2.1.0.exe`);
  assert.strictEqual(core.fromRelease(release, { platform: 'darwin', arch: 'arm64' }).desktop, `${DL}Siren-Assistant-2.1.0-mac-arm64.dmg`);
  assert.strictEqual(core.fromRelease(release, { platform: 'darwin', arch: 'x64' }).desktop, `${DL}Siren-Assistant-2.1.0-mac-x64.dmg`);
  const linux = core.fromRelease(release, { platform: 'linux' });
  assert.strictEqual(linux.desktop, release.html_url, 'no installer: the release page');
  assert.strictEqual(linux.android, `${DL}Siren-Android-2.1.0.apk`);
  assert.strictEqual(linux.wear, `${DL}Siren-Wear-2.1.0.apk`);
  const evil = core.fromRelease({ ...release, html_url: 'https://evil.example/x', assets: [{ name: 'Siren-Android-2.1.0.apk', browser_download_url: 'https://evil.example/a.apk' }] }, { platform: 'win32' });
  assert.strictEqual(evil.android, null);
  assert.strictEqual(evil.page, null);
  assert.strictEqual(core.fromRelease({ ...release, prerelease: true }), null);
  assert.strictEqual(core.fromRelease({ ...release, tag_name: 'nightly' }), null);
});

test('the state: available unless current; a skipped version is marked', () => {
  const latest = core.fromRelease(release, { platform: 'win32' });
  assert.strictEqual(core.state(latest, '2.1.0').available, false);
  assert.strictEqual(core.state(null, '2.0.3').available, false);
  const st = core.state(latest, '2.0.3', { skipped: '2.1.0' });
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.skipped, true);
  assert.strictEqual(core.state(latest, '2.0.3', { skipped: '2.0.9' }).skipped, false);
});

test('a check asks GitHub once, keeps the answer, and tells phones only about the APKs', async () => {
  const dir = tmpDir('nexus-updates-');
  let settings = { updates: { check: true, skipped: '' } };
  const asked = [];
  stub({
    electron: { app: { getVersion: () => '2.0.3' }, net: { fetch: async (url) => (asked.push(url), { ok: true, status: 200, json: async () => release }) } },
    './store': fileStore(dir, { getSettings: async () => settings }),
    './logger': quietLog,
  });
  const updates = load('main/updates.js');
  const st = await updates.check();
  assert.deepStrictEqual(asked, ['https://api.github.com/repos/Andreas-Erick/fullstack-agent/releases/latest']);
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.version, '2.1.0');
  assert.ok(fs.existsSync(path.join(dir, 'updates.json')));
  assert.deepStrictEqual(Object.keys(await updates.forDevices()).sort(), ['android', 'page', 'version', 'wear']);
  settings = { updates: { check: false } };
  await updates.check();
  assert.strictEqual(asked.length, 1, 'off: the daily check asks nothing');
  await updates.check({ manual: true });
  assert.strictEqual(asked.length, 2, '"Check now" still works');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only the user turns update checks on or off', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'main/tools.js'), 'utf8');
  const settable = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(tools)[1];
  assert.ok(!/updates/.test(settable));
  assert.match(fs.readFileSync(path.join(ROOT, 'main/store.js'), 'utf8'), /updates: \{\s*\n\s*check: true,/);
});
