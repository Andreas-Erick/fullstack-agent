// The phone and tablet client (renderer/remote/) in a real browser: test/browser/remoteclient.js runs in
// Electron (its Chromium is the browser, nothing to install), pairs with the real companion server and
// opens every screen at phone and tablet sizes; any console error, crash or blank canvas fails.
// Slow (about a minute), so only with `npm run test:browser` (NEXUS_BROWSER_TESTS=1).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT } = require('./helpers');

const enabled = process.env.NEXUS_BROWSER_TESTS === '1';

test('the phone client opens every screen at phone and tablet sizes without errors', { skip: !enabled && 'browser tests: npm run test:browser', timeout: 300000 }, () => {
  const electron = require('electron'); // in Node: the path to the Electron binary
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [path.join(ROOT, 'test/browser/remoteclient.js')], { cwd: ROOT, env, encoding: 'utf8', timeout: 280000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no result from the browser run (exit ${r.status}): ${(r.stderr || '').slice(-1500)}`);
  const res = JSON.parse(line.slice(7));
  assert.deepStrictEqual(res.problems, []);
  for (const size of ['phone', 'tablet']) {
    for (const screen of ['Inner World', 'Architecture']) {
      const s = res.screens[`${size}/more/${screen}`];
      assert.ok(s?.canvas?.length, `${size}: ${screen} drew no canvas`);
    }
  }
  assert.strictEqual(res.screens['tablet/today'].wide, true, 'the tablet gets the wide layout');
});
