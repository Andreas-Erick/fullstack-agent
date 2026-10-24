// Runs the automated tests (test/*.test.js) with Node's built-in test runner; no dependencies.
// Usage: npm test [-- <filter>]   (only test files whose name contains <filter>)
// The agent runs this too (run_tests, and before recording every self-change).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dir = path.join(root, 'test');
const filter = process.argv[2] || '';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.test.js') && f.includes(filter)).map((f) => path.join('test', f)) : [];
if (!files.length) {
  console.log(filter ? `No test files match "${filter}".` : 'No tests found.');
  process.exit(filter ? 1 : 0);
}
// TAP output: stable to read for people and for the agent (# tests / # pass / # fail at the end).
const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...files], { cwd: root, stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
