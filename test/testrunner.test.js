// The test runner's limits (scripts/test.js): a test that never settles fails as timed out and the run
// goes on; a file that leaks a timer is ended after its tests. Without them one leaked handle hung
// npm test, run_tests and every self-change record (io-5, tests-1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, tmpDir } = require('./helpers');

// Required only when it runs the suite as the main module alone: otherwise requiring it would run every test
// file from inside this one, and exit.
const RUNNER = path.join(ROOT, 'scripts', 'test.js');
const guarded = /^if \(require\.main === module\) main\(\);\r?$/m.test(fs.readFileSync(RUNNER, 'utf8'));
const { NODE_TEST_ARGS = [] } = guarded ? require(RUNNER) : {};

const dir = tmpDir('nexus-testrunner-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the runner ends hanging tests and leaked timers', () => {
  assert.ok(guarded, 'scripts/test.js runs the suite only as the main module');
  assert.ok(NODE_TEST_ARGS.includes('--test-force-exit'));
  assert.ok(NODE_TEST_ARGS.some((a) => /^--test-timeout=\d+$/.test(a)));
});

test('a test that never settles times out, the next one runs, and a leaked timer doesn’t hang the file', { timeout: 90000 }, () => {
  fs.writeFileSync(path.join(dir, 'leak.test.js'), "const test = require('node:test');\nsetInterval(() => {}, 1000);\ntest('leaks a timer', () => {});\n");
  // The hang holds a timer, as a real one does (a socket, a child process): a bare `new Promise(() => {})` is
  // cancelled by Node 22 as soon as the event loop is empty ("Promise resolution is still pending…"), while
  // Node 24 waits for the time limit, so the release run (Node 22) failed where the local run passed.
  fs.writeFileSync(path.join(dir, 'hang.test.js'), "const test = require('node:test');\ntest('never settles', () => new Promise(() => { setInterval(() => {}, 1000); }));\ntest('after', () => {});\n");
  const args = NODE_TEST_ARGS.map((a) => (a.startsWith('--test-timeout=') ? '--test-timeout=2000' : a));
  // The runner marks its child processes with NODE_TEST_CONTEXT; a nested runner that sees it reports to
  // the outer one and prints nothing.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [...args, 'leak.test.js', 'hang.test.js'], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.error, undefined, 'it ended on its own');
  assert.notStrictEqual(r.status, 0, r.stdout);
  assert.match(r.stdout, /test timed out after 2000ms/);
  // Node 24 times out the one test and runs the next in the same file; Node 22 (the release run) ends the
  // hanging file as a whole. Either way the run goes on to the next file, which is what the runner needs.
  if (Number(process.versions.node.split('.')[0]) >= 24) assert.match(r.stdout, /^ok \d+ - after$/m);
  assert.match(r.stdout, /^ok \d+ - leaks a timer$/m);
});

// Regression: with --test-force-exit alone, a file that made a few POST fetch calls (test/bridge.test.js)
// crashed Node on Windows at the forced exit, 16 runs in 25.
test('a file that used fetch exits cleanly when its process is ended after its tests', { timeout: 90000 }, () => {
  fs.writeFileSync(
    path.join(dir, 'fetch.test.js'),
    [
      "const test = require('node:test');",
      "const http = require('http');",
      "test('posts', async () => {",
      "  const server = http.createServer((req, res) => (req.resume(), req.on('end', () => res.end('[]'))));",
      "  await new Promise((r) => server.listen(0, '127.0.0.1', r));",
      "  for (let i = 0; i < 4; i++) await (await fetch(`http://127.0.0.1:${server.address().port}/`, { method: 'POST', body: JSON.stringify({ i }) })).json();",
      '  server.close();',
      '});',
      '',
    ].join('\n'),
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (let i = 0; i < 3; i++) {
    const r = spawnSync(process.execPath, [...NODE_TEST_ARGS, 'fetch.test.js'], { cwd: dir, env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `run ${i}: ${r.stdout.slice(-600)}`);
  }
});
