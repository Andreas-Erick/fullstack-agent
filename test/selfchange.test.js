// The check after a self-change goes live (main/selfchange.js verifyAfterLoad): waits until the change
// is live, then judges what the log recorded since.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { ROOT, stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-selfchange-');
let logText = '';
stub({
  electron: { app: { getPath: () => dir, getAppPath: () => dir } },
  './store': fileStore(dir, { getSettings: async () => ({ code: {} }) }),
  './logger': { ...quietLog, tail: () => logText },
});
const selfchange = load('main/selfchange.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('which source files a tool call writes: the agent’s code tools and Claude Code’s editors, a shell could be anything, the rest nothing', () => {
  const path = require('path');
  const root = path.join(dir, 'app'); // a real-looking absolute path on this platform
  assert.strictEqual(selfchange.touchedBy('code_edit_file', { path: 'main/x.js' }, root), 'main/x.js');
  assert.strictEqual(selfchange.touchedBy('mcp__nexus__code_write_file', { path: 'renderer/js/new.js' }, root), 'renderer/js/new.js');
  assert.strictEqual(selfchange.touchedBy('Edit', { file_path: path.join(root, 'renderer', 'a.js') }, root), 'renderer/a.js');
  assert.strictEqual(selfchange.touchedBy('Write', { file_path: path.join(dir, 'elsewhere', 'a.js') }, root), null, 'outside the code root: not a self-change');
  assert.strictEqual(selfchange.touchedBy('Bash', { command: 'npm test' }, root), '*');
  assert.strictEqual(selfchange.touchedBy('memory_write', { title: 'x' }, root), null);
  assert.strictEqual(selfchange.touchedBy('Edit', { file_path: path.join(root, 'a.js') }, null), null, 'no root known: nothing');
});

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

// Regression: a test run that never ended (a leaked handle) hung run_tests and the end-of-turn record
// forever. A check or test run now has a limit and is stopped with the processes it started.
test('a run past its limit is stopped and returns as timed out', { timeout: 30000 }, async () => {
  const pidFile = require('path').join(dir, 'child.pid');
  const started = Date.now();
  const r = await selfchange.run(process.execPath, ['-e', "require('fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)", pidFile], dir, {}, { limitMs: 3000 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'ETIMEDOUT');
  assert.match(r.stderr, /Timed out after 3 s/);
  assert.ok(Date.now() - started < 20000, `returned after ${Date.now() - started} ms`);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the process is gone');
});

// Regression: the 10 s fallback started at the limit stayed pending after the process had gone.
test('a run that was stopped leaves no timer behind', { timeout: 30000 }, async () => {
  const pending = new Set();
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  global.setTimeout = (fn, ms, ...rest) => {
    const t = real.setTimeout(() => (pending.delete(t), fn(...rest)), ms);
    pending.add(t);
    return t;
  };
  global.clearTimeout = (t) => (pending.delete(t), real.clearTimeout(t));
  let r;
  try {
    r = await selfchange.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], dir, {}, { limitMs: 1000 });
  } finally {
    Object.assign(global, real);
  }
  assert.strictEqual(r.code, 'ETIMEDOUT');
  assert.strictEqual(pending.size, 0, `${pending.size} timer(s) still pending`);
});

// Regression: a mistyped voice shortcut ("Foo+Bar", a half-typed "Ctrl+Alt+", saved as it is typed) makes
// globalShortcut.register throw at every launch. Logged with the Error, its stack pointed into main/main.js,
// so every later change to main.js was reported as having problems.
test('a voice shortcut the user mistyped is their value, not a problem for a change to main.js', async () => {
  const main = fs.readFileSync(require('path').join(ROOT, 'main', 'main.js'), 'utf8');
  const from = main.indexOf('async function registerShortcut()');
  const rest = main.slice(from);
  const body = rest.slice(0, rest.search(/\r?\n\}\r?\n/)); // to the function's closing brace, any line ending
  assert.ok(from !== -1 && body.includes('catch (err)'), 'registerShortcut and its catch');
  assert.match(body.slice(body.indexOf('catch (err)')), /log\.warn\('voice shortcut not registered', \{ accel, reason: String\(err\?\.message \|\| err\) \}\)/);
  assert.doesNotMatch(body, /error: err\b/, 'no Error object, so no stack and no code location');

  const at = { files: ['main/main.js'] };
  const thrown = 'Error processing argument at index 0, conversion failure from Foo+Bar';
  pending(at);
  logText = line('WARN', `voice shortcut not registered ${JSON.stringify({ accel: 'Foo+Bar', reason: thrown })}`);
  assert.strictEqual((await selfchange.verifyAfterLoad({ processStartedAt: Date.now() - 5000, loadedAt: Date.now() - 4000 })).state, 'ok');
  // The old line, for comparison: its stack named main.js.
  pending(at);
  logText = line('WARN', `voice shortcut not registered ${JSON.stringify({ accel: 'Foo+Bar', error: { message: thrown, stack: 'registerShortcut main/main.js:319:30' } })}`);
  assert.strictEqual((await selfchange.verifyAfterLoad({ processStartedAt: Date.now() - 5000, loadedAt: Date.now() - 4000 })).state, 'problems');
});

test('a run that ends on its own within its limit returns at once', async () => {
  const started = Date.now();
  const r = await selfchange.run(process.execPath, ['-e', 'process.exit(0)'], dir, {}, { limitMs: 60000 });
  assert.strictEqual(r.ok, true);
  assert.ok(Date.now() - started < 15000, `returned after ${Date.now() - started} ms`);
});
