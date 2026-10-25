// Talking over the agent (renderer/js/bargein.js): a spoken approval answer or an empty utterance must
// not leave the rest of the reply silent (regression: replies after "Yes" to a command approval were text-only).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let b;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-bargein-'), 'bargein.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/bargein.js'), copy);
  b = await import(pathToFileURL(copy).href);
});

test('talking over the agent silences the rest of the reply', () => {
  const reply = { muted: false };
  b.bargeIn(reply);
  assert.strictEqual(reply.muted, true);
});

test('answering a pending approval by voice keeps the reply speaking', () => {
  const reply = { muted: false };
  b.bargeIn(reply, { approvalPending: true });
  assert.strictEqual(reply.muted, false);
});

test('a barge-in that turns out to be nothing (or only an approval answer) speaks again', () => {
  const reply = { muted: false };
  b.bargeIn(reply);
  b.bargeInOver(reply);
  assert.strictEqual(reply.muted, false);
});

test('no reply streaming: nothing to do', () => {
  assert.doesNotThrow(() => (b.bargeIn(null), b.bargeInOver(null)));
});
