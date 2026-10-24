// The check after a self-change goes live (main/selfchange.js verifyAfterLoad): waits until the change
// is live, then judges what the log recorded since.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-selfchange-');
let logText = '';
stub({
  electron: { app: { getPath: () => dir, getAppPath: () => dir } },
  './store': fileStore(dir, { getSettings: async () => ({ code: {} }) }),
  './logger': { ...quietLog, tail: () => logText },
});
const selfchange = load('main/selfchange.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const verifyFile = `${dir}/selfchange-verify.json`;
const pending = (extra) => fs.writeFileSync(verifyFile, JSON.stringify({ sha: 'abc1234def', short: 'abc1234', subject: 'Add a widget', files: ['renderer/js/widget.js', 'main/widget.js'], restart: true, reload: false, at: Date.now() - 60000, state: 'pending', ...extra }));
const line = (level, text) => `${new Date().toISOString()} ${level.padEnd(5)} ${text}`;

test('not live yet: waits', async () => {
  pending();
  assert.strictEqual(await selfchange.verifyAfterLoad({ processStartedAt: Date.now() - 120000, loadedAt: Date.now() }), null, 'the app was not restarted after the change');
  assert.strictEqual((await selfchange.lastVerification()).state, 'pending');
});

test('clean start: ok; unrelated warnings do not count', async () => {
  pending();
  logText = line('WARN', 'ipc failed {"channel":"tts:speak","error":{"message":"VoiceStudio offline","stack":"speak main/voice.js:32:1"}}');
  const v = await selfchange.verifyAfterLoad({ processStartedAt: Date.now() - 5000, loadedAt: Date.now() - 4000 });
  assert.strictEqual(v.state, 'ok');
});

test('errors, or warnings in the changed files, are problems', async () => {
  pending();
  logText = line('WARN', 'ui: render failed app://bundle/renderer/js/widget.js:12:3');
  let v = await selfchange.verifyAfterLoad({ processStartedAt: Date.now() - 5000, loadedAt: Date.now() - 4000 });
  assert.strictEqual(v.state, 'problems');
  assert.deepStrictEqual(v.problems[0].locations, ['renderer/js/widget.js:12']);

  pending();
  logText = line('ERROR', 'turn failed {"error":{"message":"boom","stack":"run main/llm.js:9:1"}}');
  v = await selfchange.verifyAfterLoad({ processStartedAt: Date.now() - 5000, loadedAt: Date.now() - 4000 });
  assert.strictEqual(v.state, 'problems');
  assert.strictEqual((await selfchange.lastVerification()).state, 'problems', 'saved');
});
