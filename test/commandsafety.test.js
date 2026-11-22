// Which shell commands a Claude Code session runs without asking (main/commandsafety.js, security audit
// SEC-01): the app's own checks and read-only git views, word for word; anything that runs another
// program, writes a file or reads outside the repository asks.
const test = require('node:test');
const assert = require('node:assert');
const { safeCommand } = require('../main/commandsafety');

test('the app’s own checks and plain git views run without asking', () => {
  for (const c of ['npm run check', 'npm test', 'node scripts/check.js', 'node scripts/test.js', 'node scripts/verify.js', 'node scripts/test.js test/claudeguard.test.js', 'git status', 'git status --short', 'git diff', 'git diff --stat', 'git diff --cached', 'git log', 'git log --oneline -20', 'git log --oneline -n 5', 'git log --stat --max-count=3', '  git   status  ']) {
    assert.strictEqual(safeCommand(c), true, c);
  }
});

test('anything that runs a program, writes a file or reads outside asks', () => {
  for (const c of [
    'npm test --prefix C:/Users/x/SirenRepos/evil/repo',
    'npm test --script-shell=calc.exe',
    'npm test -- --prefix x',
    'npm run build',
    'npm install',
    'git log --output=C:/Users/x/Startup/x.cmd',
    'git log -1 --format=x --output=y',
    'git diff --no-index NUL C:/Users/x/.ssh/id_ed25519',
    'git diff --output=x',
    'git diff --ext-diff',
    'git diff HEAD~1 -- secrets.txt',
    'git -c core.pager=calc log',
    'git log HEAD..evil',
    'git log -n',
    'git log -n x',
    'git status && calc',
    'git status; calc',
    'git status | more',
    'git status > out.txt',
    'git log `calc`',
    'git log $(calc)',
    'git log %COMSPEC%',
    'node scripts/test.js ../../repos/evil/x.test.js',
    'node scripts/test.js test/../../x.test.js',
    'node scripts/test.js C:/x.test.js',
    'node scripts/test.js test/x.js',
    'node -e "x"',
    'git push',
    'git commit -m x',
    '',
    null,
  ]) {
    assert.strictEqual(safeCommand(c), false, String(c));
  }
});
