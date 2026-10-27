// Runs the automated tests (test/*.test.js) with Node's built-in test runner; no dependencies.
// Usage: npm test [-- <filter>]   (only test files whose name contains <filter>)
//        npm run test:browser      (also the slow ones that drive a real browser: *.browser.test.js,
//                                   which load the phone client in Electron; skipped otherwise)
// The agent runs this too (run_tests, and before recording every self-change).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
// TAP output: stable to read for people and for the agent (# tests / # pass / # fail at the end).
const env = { ...process.env, ...(browser ? { NEXUS_BROWSER_TESTS: '1' } : {}) };
const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit', env });
process.exit(r.status ?? 1);
