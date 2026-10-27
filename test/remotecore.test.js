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
