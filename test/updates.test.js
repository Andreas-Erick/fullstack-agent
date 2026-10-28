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

test('when a check is due: daily, or the app is already newer than the last answer (a fresh install)', () => {
  const dir = tmpDir('nexus-updates-due-');
  stub({ electron: { app: { getVersion: () => '2.5.1' }, net: {} }, './store': fileStore(dir, { getSettings: async () => ({}) }), './logger': quietLog });
  const updates = load('main/updates.js');
  const now = Date.now();
  assert.ok(updates.needsCheck({}, '2.5.1', now), 'never checked');
  assert.ok(updates.needsCheck({ checkedAt: now - 25 * 3600 * 1000, latest: { version: '2.5.1' } }, '2.5.1', now), 'a day passed');
  assert.ok(!updates.needsCheck({ checkedAt: now - 3600 * 1000, latest: { version: '2.5.1' } }, '2.5.1', now), 'fresh and current');
  assert.ok(!updates.needsCheck({ checkedAt: now - 3600 * 1000, latest: { version: '2.6.0' } }, '2.5.1', now), 'fresh and a newer release known');
  assert.ok(updates.needsCheck({ checkedAt: now - 3600 * 1000, latest: { version: '2.4.0' } }, '2.5.1', now), 'the app is newer than the answer: it is stale');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a phone asking refreshes a stale answer in the background; two askers share one request', async () => {
  const dir = tmpDir('nexus-updates-dev-');
  const asked = [];
  let release1 = null;
  stub({
    electron: { app: { getVersion: () => '2.0.3' }, net: { fetch: async (url) => (asked.push(url), new Promise((r) => setTimeout(() => r({ ok: true, status: 200, json: async () => release1 || release }), 30))) } },
    './store': fileStore(dir, { getSettings: async () => ({ updates: { check: true } }) }),
    './logger': quietLog,
  });
  const updates = load('main/updates.js');
  const stale = { checkedAt: Date.now() - updates.DEVICE_FRESH_MS - 1000, latest: { version: '2.0.3', android: 'https://github.com/Andreas-Erick/fullstack-agent/releases/download/v2.0.3/Siren-Android-2.0.3.apk', page: release.html_url } };
  fs.writeFileSync(path.join(dir, 'updates.json'), JSON.stringify(stale));
  const first = await updates.forDevices();
  assert.strictEqual(first.version, '2.0.3', 'the stale answer at once, no waiting for GitHub');
  await updates.forDevices();
  assert.strictEqual(asked.length, 1, 'one background check for both asks');
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual((await updates.forDevices()).version, '2.1.0', 'the next ask has the new release');
  assert.strictEqual(asked.length, 1, 'fresh now: no further check');
  const [a, b] = await Promise.all([updates.check(), updates.check()]);
  assert.strictEqual(a.version, b.version);
  assert.strictEqual(asked.length, 2, 'two simultaneous checks share one request');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only the user turns update checks on or off', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'main/tools.js'), 'utf8');
  const settable = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(tools)[1];
  assert.ok(!/updates/.test(settable));
  assert.match(fs.readFileSync(path.join(ROOT, 'main/store.js'), 'utf8'), /updates: \{\s*\n\s*check: true,/);
});
