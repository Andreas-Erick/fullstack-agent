// Runs the automated tests (test/*.test.js) with Node's built-in test runner; no dependencies.
// Usage: npm test [-- <filter>]   (only test files whose name contains <filter>)
//        npm run test:browser      (also the slow ones that drive a real browser: *.browser.test.js,
//                                   which load the phone client in Electron; skipped otherwise)
// The agent runs this too (run_tests, and before recording every self-change).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// TAP output: stable to read for people and for the agent (# tests / # pass / # fail at the end).
// --test-timeout ends a test that never settles (it fails as "test timed out after …ms" and the file goes
// on); --test-force-exit ends a file's process after its tests even if it leaked a timer. A test stuck in a
// synchronous loop never lets the timeout run: the run's own limit ends it (and, on Windows, the test
// processes with it: they are in node's job object).
// --liftoff-only (passed on to every file's process): Node 24 on Windows crashed at that forced exit
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)") while V8 was still optimizing WebAssembly in the
// background, as it does after a few fetch calls (undici's HTTP parser); baseline WebAssembly leaves nothing
// running then.
const NODE_TEST_ARGS = ['--liftoff-only', '--test', '--test-reporter=tap', '--test-concurrency=1', '--test-timeout=120000', '--test-force-exit'];
const LIMIT_MS = 9 * 60000;

function main() {
  const root = path.join(__dirname, '..');
  const dir = path.join(root, 'test');
  const args = process.argv.slice(2);
  const browser = args.includes('--browser');
  const filter = args.find((a) => !a.startsWith('--')) || '';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && f.includes(filter)).map((f) => path.join('test', f)) : [];
  if (!files.length) {
    console.log(filter ? `No test files match "${filter}".` : 'No tests found.');
    process.exit(filter ? 1 : 0);
  }
  const env = { ...process.env, ...(browser ? { NEXUS_BROWSER_TESTS: '1' } : {}) };
  const r = spawnSync(process.execPath, [...NODE_TEST_ARGS, ...files], { cwd: root, stdio: 'inherit', env, timeout: LIMIT_MS, killSignal: 'SIGKILL' });
  if (r.error?.code === 'ETIMEDOUT') console.log('# fail tests timed out after 9 minutes');
  process.exit(r.status ?? 1);
}

if (require.main === module) main();

module.exports = { NODE_TEST_ARGS };
