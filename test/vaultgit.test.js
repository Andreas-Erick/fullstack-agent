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
