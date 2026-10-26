// Helper apps (main/helperapps.js): Nexus starts VoiceStudio / FreeLLMAPI when its settings use them,
// only from a known or user-set program path, only for addresses on this computer. A small Node server
// stands in for the app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, stub, load, quietLog, tmpDir } = require('./helpers');

stub({ './logger': quietLog });
const helperApps = load('main/helperapps.js');

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// The stand-in "app": opens the port after `delay` ms. Every launch is counted.
let launches = 0;
const children = [];
function fakeApp(port, delay = 300) {
  return () => {
    launches++;
    const child = spawn(process.execPath, ['-e', `setTimeout(() => require('net').createServer().listen(${port}, '127.0.0.1'), ${delay}); setTimeout(() => process.exit(0), 20000);`], { stdio: 'ignore' });
    children.push(child);
    return child;
  };
}
test.after(() => children.forEach((c) => c.kill()));

// A stand-in for the installed program, of the kind the platform launches: an .exe on Windows (this
// Node binary), an .app bundle on macOS (an empty folder is enough for the path check), any file elsewhere.
const PROGRAM = process.platform === 'darwin' ? path.join(tmpDir('nexus-helperapp-'), 'VoiceStudio.app') : process.execPath;
if (process.platform === 'darwin') fs.mkdirSync(PROGRAM, { recursive: true });
const voiceSettings = (port, extra = {}) => ({ voice: { ttsEnabled: true, baseUrl: `http://127.0.0.1:${port}` }, helperApps: { autoStart: true, minimize: false, voicestudioPath: PROGRAM, ...extra } });

test('which apps are needed and local', () => {
  assert.ok(helperApps.isLocal('http://localhost:3900'));
  assert.ok(helperApps.isLocal('http://127.0.0.1:31415/v1'));
  assert.ok(!helperApps.isLocal('http://gpu-box:3900'));
  assert.ok(!helperApps.isLocal('not a url'));
  const fl = helperApps.APPS.freellmapi.needed;
  assert.ok(fl({ llm: { provider: 'openai' } }));
  assert.ok(fl({ llm: { provider: 'auto' }, routing: { order: ['claude-code', 'openai'], disabled: [] } }));
  assert.ok(!fl({ llm: { provider: 'auto' }, routing: { order: ['claude-code', 'openai'], disabled: ['openai'] } }));
  assert.ok(!fl({ llm: { provider: 'claude-code' } }));
  assert.ok(helperApps.APPS.voicestudio.needed({ voice: { ttsEnabled: true } }));
  assert.ok(!helperApps.APPS.voicestudio.needed({ voice: { ttsEnabled: true, engine: 'local' } }), 'the offline voice needs no VoiceStudio');
  assert.ok(!helperApps.APPS.voicestudio.needed({ voice: { ttsEnabled: false } }));
});

test('a user-set location must be an existing program; a wrong one never falls back', () => {
  assert.strictEqual(helperApps.installedPath('voicestudio', { helperApps: { voicestudioPath: PROGRAM } }), PROGRAM);
  assert.strictEqual(helperApps.installedPath('voicestudio', { helperApps: { voicestudioPath: path.join(ROOT, 'does-not-exist.exe') } }), null);
  if (process.platform === 'win32') assert.strictEqual(helperApps.installedPath('voicestudio', { helperApps: { voicestudioPath: path.join(ROOT, 'package.json') } }), null, 'not a program');
});

test('starts the app, waits until it answers, and does not start it twice', async () => {
  const port = await freePort();
  helperApps.init({ spawnApp: fakeApp(port), notify: () => {} });
  launches = 0;
  const r = await helperApps.start('voicestudio', voiceSettings(port), { readyMs: 10000 });
  assert.deepStrictEqual(r, { status: 'running', startedByNexus: true, error: '' });
  assert.strictEqual(launches, 1);
  const again = await helperApps.start('voicestudio', voiceSettings(port));
  assert.strictEqual(again.status, 'running');
  assert.strictEqual(launches, 1, 'already running: not started again');
});

test('never starts an app on another computer, or one that is not installed', async () => {
  helperApps.init({ spawnApp: fakeApp(1) });
  launches = 0;
  const remote = await helperApps.start('voicestudio', { voice: { ttsEnabled: true, baseUrl: 'http://gpu-box.example:3900' }, helperApps: { voicestudioPath: PROGRAM } });
  assert.strictEqual(remote.status, 'remote');
  const port = await freePort();
  const missing = await helperApps.start('voicestudio', voiceSettings(port, { voicestudioPath: path.join(ROOT, 'nope.exe') }));
  assert.strictEqual(missing.status, 'not_installed');
  assert.strictEqual(launches, 0);
});

test('an app that never answers is reported as failed', async () => {
  const port = await freePort();
  helperApps.init({ spawnApp: fakeApp(port, 60000) });
  const r = await helperApps.start('voicestudio', voiceSettings(port), { readyMs: 1500 });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.error, /did not answer/);
});

test('restarted when needed: only for connection errors, only if allowed, not too often', async () => {
  const port = await freePort();
  helperApps.init({ spawnApp: fakeApp(port) });
  helperApps._state.voicestudio.lastStart = 0;
  const refused = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.strictEqual(helperApps.onUnreachable('voicestudio', refused, voiceSettings(port, { autoStart: false })), false, 'turned off');
  assert.strictEqual(helperApps.onUnreachable('voicestudio', new Error('VoiceStudio error 500'), voiceSettings(port)), false, 'not a connection problem');
  launches = 0;
  assert.strictEqual(helperApps.onUnreachable('voicestudio', refused, voiceSettings(port)), true);
  assert.strictEqual(helperApps.onUnreachable('voicestudio', refused, voiceSettings(port)), false, 'already starting / just started');
  await new Promise((r) => setTimeout(r, 1500));
  assert.strictEqual(launches, 1);
});

test('the agent can never change helper-app settings (they name programs Nexus runs)', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'main/tools.js'), 'utf8');
  const settable = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(tools)[1];
  assert.ok(!/helperApps/.test(settable), 'helperApps must not be in SETTABLE');
});
