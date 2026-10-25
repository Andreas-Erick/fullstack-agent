// The Claude plan meter (main/claudeusage.js): reading the CLI's rate_limit_event and what is shown.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { stub, load, tmpDir, fileStore } = require('./helpers');

const dir = tmpDir('nexus-usage-');
stub({ './store': fileStore(dir) });
const usage = load('main/claudeusage.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const INFO = {
  status: 'allowed',
  resetsAt: 1792957800,
  rateLimitType: 'five_hour',
  isUsingOverage: false,
  unifiedWindows: { seven_day: { utilization: 0.35, resetsAt: 1793433600, status: 'allowed' }, five_hour: { utilization: 0.03, resetsAt: 1792957800, status: 'allowed' } },
};

test('reads every window of the event, 5-hour first', () => {
  const snap = usage.parse(INFO, 1);
  assert.deepStrictEqual(snap.windows.map((w) => [w.id, w.label, w.used]), [['five_hour', '5-hour', 0.03], ['seven_day', 'weekly', 0.35]]);
  assert.strictEqual(snap.at, 1);
});

test('falls back to the single window older CLIs report, ignores junk', () => {
  assert.strictEqual(usage.parse(null), null);
  assert.strictEqual(usage.parse({ unifiedWindows: { x: { utilization: 'lots' } } }), null);
  const snap = usage.parse({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 1.7, resetsAt: 5 });
  assert.strictEqual(snap.windows[0].used, 1, 'clamped');
});

test('summary: share left, the tightest window, and a window that has reset is full again', () => {
  const snap = usage.parse(INFO);
  const before = usage.summary(snap, 1792957800 * 1000 - 1);
  assert.deepStrictEqual(before.windows.map((w) => w.left), [97, 65]);
  assert.strictEqual(before.lowest, 65);
  const after = usage.summary({ ...snap, windows: [{ ...snap.windows[0], used: 0.9 }, snap.windows[1]] }, 1792957800 * 1000 + 1);
  assert.strictEqual(after.windows[0].left, 100);
  assert.strictEqual(after.windows[0].resetsAt, null);
});

test('update notifies listeners and is kept for the next start', async () => {
  let got = null;
  usage.onChange((s) => (got = s));
  usage.update(INFO);
  assert.strictEqual(got.windows.length, 2);
  await new Promise((r) => setTimeout(r, 20));
  const fresh = load('main/claudeusage.js');
  assert.strictEqual((await fresh.get()).windows.length, 2);
});
