// The phone link's health signal: companion.js presenceTracker (connected at once, disconnected only
// after a while without any stream) and the Remote pill's device lines (renderer/js/remotecore.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-presence-');
stub({ electron: { app: { getPath: () => dir } }, './logger': quietLog, './store': fileStore(dir) });
const { presenceTracker } = load('main/companion.js');

let core;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-remotecore-'), 'remotecore.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/remotecore.js'), copy);
  core = await import(pathToFileURL(copy).href);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a device is announced when it connects, and only after a long drop when it goes', async () => {
  const events = [];
  const p = presenceTracker({ dropMs: 40, onChange: (ev) => events.push(ev.type) });
  p.opened('d1', 'Phone');
  p.opened('d1', 'Phone'); // a second stream (the background service): no news
  assert.deepStrictEqual(events, ['connected']);
  p.closed('d1', 'Phone');
  p.closed('d1', 'Phone');
  await wait(10);
  p.opened('d1', 'Phone'); // back within the grace time: still silent
  p.closed('d1', 'Phone');
  assert.deepStrictEqual(events, ['connected']);
  await wait(70);
  assert.deepStrictEqual(events, ['connected', 'disconnected']);
  assert.strictEqual(p.online('d1'), false);
  p.opened('d1', 'Phone');
  assert.deepStrictEqual(events, ['connected', 'disconnected', 'connected']);
  p.forget('d1');
  p.reset();
});

test('a removed device is forgotten without a "disconnected" toast', async () => {
  const events = [];
  const p = presenceTracker({ dropMs: 20, onChange: (ev) => events.push(ev.type) });
  p.opened('d2', 'Tablet');
  p.closed('d2', 'Tablet');
  p.forget('d2');
  await wait(40);
  assert.deepStrictEqual(events, ['connected']);
});

test('the pill lists connected devices first, with last-seen times and the watch face', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const s = core.deviceSummary([
    { name: 'Laptop', connected: false, lastSeen: now - 3 * 3600e3 },
    { name: 'Phone', connected: true, lastSeen: now, watch: true, faceAt: now - 5 * 60e3 },
    { name: 'Old tablet', connected: false },
  ], now);
  assert.strictEqual(s.connected, 1);
  assert.strictEqual(s.headline, '1 of 3 devices connected');
  assert.deepStrictEqual(s.lines, ['● Phone: connected now · watch face from 5 min ago', '○ Laptop: last seen 3 h ago', '○ Old tablet: never used']);
  assert.deepStrictEqual(core.deviceSummary([], now).lines, ['No paired devices.']);
  assert.strictEqual(core.ago(now - 30e3, now), 'just now');
  assert.strictEqual(core.ago(now - 3 * 86400e3, now), '3 days ago');
});

// The Remote pill says when the server isn't running or the secure address doesn't answer; it used to say
// "online · Reachable from the internet" whatever the check found, and nothing when the port was taken.
test('the Remote pill: not running, unreachable, online (tailnet or internet), network, local', () => {
  const local = { label: 'Remote', cls: '', reach: 'Reachable from this computer only' };
  assert.deepStrictEqual(core.pillState(), local);
  assert.deepStrictEqual(core.pillState({}), local);
  assert.deepStrictEqual(core.pillState({ tunnel: null }), local);
  assert.deepStrictEqual(core.pillState({ lan: true }), { label: 'Remote: network', cls: '', reach: 'Reachable from your local network' });

  const taken = 'Port 7823 is already in use. Choose another port.';
  const ts = { mode: 'tailscale', connected: true, url: 'https://pc.tail1234.ts.net', check: 'ok', warning: '' };
  assert.deepStrictEqual(core.pillState({ error: taken }), { label: 'Remote: not running', cls: 'err', reach: taken });
  assert.deepStrictEqual(core.pillState({ error: taken, lan: true, tunnel: ts }), { label: 'Remote: not running', cls: 'err', reach: taken }, 'not running wins over a connected tunnel');
  assert.strictEqual(core.pillState({ error: '', tunnel: ts }).cls, 'online', 'an empty error is no error');

  const warning = 'Couldn’t open https://pc.tail1234.ts.net from this computer (fetch failed). Is Tailscale on?';
  assert.deepStrictEqual(core.pillState({ tunnel: { ...ts, check: 'fail', warning } }), { label: 'Remote: unreachable', cls: 'warn', reach: warning });
  assert.match(core.pillState({ tunnel: { ...ts, check: 'fail', warning: '' } }).reach, /https:\/\/pc\.tail1234\.ts\.net didn’t answer/);

  assert.strictEqual(core.pillState({ tunnel: ts }).reach, 'Reachable from your tailnet at https://pc.tail1234.ts.net');
  assert.strictEqual(core.pillState({ tunnel: { ...ts, check: 'checking' } }).label, 'Remote: online', 'a check under way keeps the last state');
  for (const mode of ['cloudflare', 'quick']) assert.strictEqual(core.pillState({ tunnel: { mode, connected: true, url: 'https://x.example.com', check: '' } }).reach, 'Reachable from the internet at https://x.example.com', mode);

  // A tunnel that isn't connected yet, or connected without an address: what the server alone reaches.
  assert.deepStrictEqual(core.pillState({ lan: true, tunnel: { mode: 'cloudflare', connected: true, url: '' } }).label, 'Remote: network');
  assert.deepStrictEqual(core.pillState({ tunnel: { mode: 'quick', connected: false, url: '', running: true } }), local);
  assert.deepStrictEqual(core.pillState({ tunnel: { mode: 'tailscale', connected: false, check: 'fail', url: '' } }), local);
  // Long and odd texts pass through unchanged (the pill's tooltip shows them).
  const long = 'x'.repeat(10000);
  assert.strictEqual(core.pillState({ error: long }).reach, long);
  assert.strictEqual(core.pillState({ error: '<script>alert(1)</script>' }).reach, '<script>alert(1)</script>');
});

// The tooltip's first line ends with one full stop: the server's and the tunnel's texts already end with
// one (or a question), which gave "…port.." and "…7823"?.".
test('the Remote tooltip’s first sentence gets a full stop only when it has none', () => {
  assert.strictEqual(core.sentence('Reachable from your local network'), 'Reachable from your local network.');
  assert.strictEqual(core.sentence('Port 7823 is already in use. Choose another port.'), 'Port 7823 is already in use. Choose another port.');
  assert.strictEqual(core.sentence('Is Tailscale on, and did you run "tailscale serve --bg 7823"?'), 'Is Tailscale on, and did you run "tailscale serve --bg 7823"?');
  for (const done of ['Stopped!', 'Wait…', 'It said “no.”', "(see the log.)", 'Done.  ']) assert.ok(!/[.?!…]["'”’)]*\.$/.test(core.sentence(done)), `${done} → ${core.sentence(done)}`);
  assert.strictEqual(core.sentence('Done.  '), 'Done.', 'trailing spaces go');
  for (const empty of ['', '   ', null, undefined]) assert.strictEqual(core.sentence(empty), '', String(empty));
  assert.strictEqual(core.sentence('x'.repeat(10000)), `${'x'.repeat(10000)}.`);
  assert.strictEqual(core.sentence('مرحبا'), 'مرحبا.');
  assert.strictEqual(core.sentence('👨‍👩‍👧‍👦'), '👨‍👩‍👧‍👦.');
  // Every pill state reads as one sentence.
  for (const s of [{}, { lan: true }, { error: 'Port 7823 is already in use. Choose another port.' }, { tunnel: { mode: 'tailscale', connected: true, url: 'https://pc.tail1234.ts.net', check: 'fail', warning: 'Couldn’t open it. Is Tailscale on, and did you run "tailscale serve --bg 7823"?' } }]) {
    assert.doesNotMatch(core.sentence(core.pillState(s).reach), /[.?!]["”]?\.$|\.\.$/, JSON.stringify(s));
  }
});
