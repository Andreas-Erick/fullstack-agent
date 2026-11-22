// Which shell commands a Claude Code session may run without asking (pure). Only the app's own checks
// and read-only git views, word for word: no paths, no refs, no chaining, no redirection, and none of the
// flags that run a program or write a file (npm --prefix / --script-shell, git --output / --no-index /
// -c / --ext-diff). Everything else asks (approvals kind 'command'). When in doubt, it asks.
// Security audit 2026-11-22 SEC-01: the CLI's wildcard rules (Bash(git diff*), Bash(npm test*)) let
// "git log --output=<file>", "git diff --no-index <any file>" and "npm test --prefix <clone>" through.

// A command is plain words of these characters only: no quotes, $, %, ^, !, ;, &, |, <, >, (, ), `, * or ?.
const PLAIN = /^[A-Za-z0-9 ./=_-]+$/;

const EXACT = new Set(['npm run check', 'npm test', 'node scripts/check.js', 'node scripts/test.js', 'node scripts/verify.js']);

// One test file of the app's own (run with the app's test runner): test/<name>.test.js.
const TEST_FILE = /^test\/[A-Za-z0-9_.-]+\.test\.js$/;

// Read-only views of the app's repository; each flag as typed, nothing else after the subcommand.
const GIT_FLAGS = {
  status: new Set(['-s', '--short', '-b', '--branch', '-sb', '--porcelain']),
  diff: new Set(['--stat', '--cached', '--staged', '--name-only', '--name-status', '--shortstat', '--numstat', '--no-ext-diff']),
  log: new Set(['--oneline', '--stat', '--name-only', '--name-status', '--shortstat', '--graph', '--decorate', '--no-ext-diff', '-p']),
};
const COUNT = /^(-\d{1,4}|-n|--max-count=\d{1,4})$/;

function safeCommand(cmd) {
  const s = String(cmd ?? '').trim();
  if (!s || s.length > 200 || !PLAIN.test(s)) return false;
  const words = s.split(/ +/);
  const line = words.join(' ');
  if (EXACT.has(line)) return true;
  if (words[0] === 'node' && words[1] === 'scripts/test.js') return words.length > 2 && words.slice(2).every((w) => TEST_FILE.test(w) && !w.includes('..'));
  if (words[0] !== 'git' || !GIT_FLAGS[words[1]]) return false;
  const flags = GIT_FLAGS[words[1]];
  for (let i = 2; i < words.length; i++) {
    const w = words[i];
    if (flags.has(w)) continue;
    if (words[1] === 'log' && COUNT.test(w)) {
      if (w === '-n') {
        if (!/^\d{1,4}$/.test(words[i + 1] || '')) return false;
        i++;
      }
      continue;
    }
    return false;
  }
  return true;
}

module.exports = { safeCommand };
