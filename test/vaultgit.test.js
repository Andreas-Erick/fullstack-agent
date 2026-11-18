// Vault history upkeep (main/vaultgit.js maintain, audit #16): git gc runs at most once a week.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('nexus-vgit-');
stub({ './logger': quietLog, './store': { getSettings: async () => ({ obsidian: { gitHistory: true } }) } });
const vaultgit = load('main/vaultgit.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

let hasGit = true;
try {
  execFileSync('git', ['init', '-q', dir], { windowsHide: true });
} catch {
  hasGit = false;
}

test('gc runs once, then waits a week', { skip: !hasGit && 'git not installed' }, async () => {
  const now = Date.now();
  assert.strictEqual(await vaultgit.maintain(dir, now), true);
  assert.ok(fs.existsSync(path.join(dir, '.git', 'nexus-last-gc')));
  assert.strictEqual(await vaultgit.maintain(dir, now + 3600000), false);
  assert.strictEqual(await vaultgit.maintain(dir, now + 8 * 24 * 3600000), true);
});

// A hook or a file-system monitor someone planted in the vault's .git (a session could write there before
// 2.7.25) ran code whenever the vault's history committed. Siren's git runs with both turned off.
test('git runs with hooks pointing nowhere and the file-system monitor off', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'vaultgit.js'), 'utf8');
  assert.match(src, /'core\.fsmonitor=false'/);
  assert.match(src, /`core\.hooksPath=\$\{os\.devNull\}`/);
});

test('a planted pre-commit hook and core.fsmonitor never run when the history commits', { skip: !hasGit && 'git not installed' }, async () => {
  const repo = tmpDir('nexus-vgit-planted-');
  const markers = tmpDir('nexus-vgit-markers-');
  test.after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(markers, { recursive: true, force: true });
  });
  const own = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: repo, windowsHide: true, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repo, 'a.md'), 'v1');
  assert.strictEqual(await vaultgit.ensure(repo), true);
  const first = own('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a.md'), 'v2');
  own('commit', '-q', '-am', 'v2');
  // Planted: a hook and a monitor command, each leaving a marker file if it ever runs.
  const m1 = path.join(markers, 'hook-ran').replace(/\\/g, '/');
  const m2 = path.join(markers, 'fsmonitor-ran').replace(/\\/g, '/');
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\necho x > "${m1}"\n`);
  fs.chmodSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
  own('config', 'core.fsmonitor', `echo x > "${m2}"`);
  fs.writeFileSync(path.join(repo, '.git', 'nexus-last-gc'), new Date().toISOString()); // no gc in the background
  await vaultgit.restore(repo, 'a.md', first);
  assert.strictEqual(fs.readFileSync(path.join(repo, 'a.md'), 'utf8'), 'v1');
  assert.strictEqual(own('rev-list', '--count', 'HEAD'), '3', 'the restore was committed');
  assert.strictEqual(fs.existsSync(m1), false, 'the planted hook did not run');
  assert.strictEqual(fs.existsSync(m2), false, 'the planted monitor did not run');
});
