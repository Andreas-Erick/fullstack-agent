// Recording a self-change (main/selfchange.js commit, the self_change_commit tool in main/tools/code.js):
// only the files the agent's own tools wrote go into its commit, and a change that can't be marked for the
// check after it goes live says so instead of passing silently. Runs against a throwaway git repository
// with no check or test scripts (both are then skipped).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-selfcommit-');
const repo = path.join(dir, 'repo');
fs.mkdirSync(repo);
const sh = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
sh('init', '-q');
fs.writeFileSync(path.join(repo, 'a.js'), '1\n');
fs.writeFileSync(path.join(repo, 'b.js'), '1\n');
sh('add', '-A');
sh('commit', '-q', '-m', 'start');

let failMarker = false;
const warnings = [];
let turn = 'turn01';
const testLog = { ...quietLog, warn: (event, data) => warnings.push({ event, data }), context: () => ({ turn }) };
stub({
  electron: { app: { getPath: () => dir, getAppPath: () => repo } },
  './store': fileStore(dir, {
    getSettings: async () => ({ code: { rootPath: repo } }),
    writeJsonAtomic: async (f, v) => {
      if (failMarker && f.endsWith('selfchange-verify.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      fs.writeFileSync(f, JSON.stringify(v));
    },
  }),
  './logger': testLog,
  '../logger': testLog,
  './obsidian': { writeNote: async () => {}, readOptional: async () => '' },
});
const selfchange = load('main/selfchange.js');
const codeTools = load('main/tools/code.js');
const commitTool = codeTools.find((t) => t.name === 'self_change_commit');
const ctx = { emit() {} };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const committedFiles = () => sh('show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean).sort();

test('the files a turn wrote are kept per turn and forgotten when it ends', () => {
  selfchange.noteTouched('t1', 'a.js');
  selfchange.noteTouched('t1', 'a.js');
  selfchange.noteTouched('t2', 'b.js');
  selfchange.noteTouched(undefined, 'c.js');
  assert.deepStrictEqual(selfchange.touchedIn('t1'), ['a.js']);
  assert.deepStrictEqual(selfchange.touchedIn('t2'), ['b.js']);
  assert.deepStrictEqual(selfchange.touchedIn(undefined), []);
  selfchange.forgetTurn('t1');
  selfchange.forgetTurn('t2');
  assert.deepStrictEqual(selfchange.touchedIn('t1'), []);
});

// Regression (ENG-06): self_change_commit ran `git add -A`, so an edit someone else had open in the repo
// went into the agent's commit (and `npm run recover` would undo it with the agent's change).
test('self_change_commit records only what this turn wrote, never someone else’s edit', async () => {
  fs.writeFileSync(path.join(repo, 'a.js'), '2\n'); // the agent's edit
  fs.writeFileSync(path.join(repo, 'b.js'), '2\n'); // the developer's edit, made meanwhile
  turn = 'turnA';
  selfchange.noteTouched('turnA', 'a.js');
  const r = await commitTool.run({ summary: 'Change a' }, ctx);
  assert.strictEqual(r.committed, true);
  assert.deepStrictEqual(committedFiles(), ['a.js']);
  assert.match(sh('status', '--porcelain'), /b\.js/, 'the other edit is still uncommitted');
  selfchange.forgetTurn('turnA');
});

test('a turn whose tools wrote nothing records nothing, even with a dirty repo', async () => {
  turn = 'turnB';
  const head = sh('rev-parse', 'HEAD');
  const r = await commitTool.run({ summary: 'Nothing of mine' }, ctx);
  assert.strictEqual(r.committed, false);
  assert.strictEqual(sh('rev-parse', 'HEAD'), head);
});

test('after a shell command in the turn, everything dirty counts (as the end-of-turn record)', async () => {
  turn = 'turnC';
  selfchange.noteTouched('turnC', '*');
  const r = await commitTool.run({ summary: 'Ran a script' }, ctx);
  assert.strictEqual(r.committed, true);
  assert.deepStrictEqual(committedFiles(), ['b.js']);
  selfchange.forgetTurn('turnC');
});

// Regression (ENG-05): a failed marker write was swallowed, so the change was never checked after it went
// live and nothing said so.
test('a change that cannot be marked for the after-load check is logged and reported', async () => {
  fs.writeFileSync(path.join(repo, 'a.js'), '3\n');
  failMarker = true;
  warnings.length = 0;
  turn = 'turnD';
  selfchange.noteTouched('turnD', 'a.js');
  const change = await selfchange.commit('Change a again', { only: ['a.js'] });
  assert.strictEqual(change.ok, true);
  assert.strictEqual(change.verifyPending, false);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].event, 'self-change not marked for checking');
  assert.strictEqual(warnings[0].data.error.code, 'ENOSPC');

  fs.writeFileSync(path.join(repo, 'a.js'), '4\n');
  const r = await commitTool.run({ summary: 'Once more' }, ctx);
  assert.strictEqual(r.committed, true);
  assert.match(r.warning, /could not be marked/);
  failMarker = false;
  selfchange.forgetTurn('turnD');
});

test('a marked change says so', async () => {
  fs.writeFileSync(path.join(repo, 'a.js'), '5\n');
  const change = await selfchange.commit('Change a, marked', { only: ['a.js'] });
  assert.strictEqual(change.verifyPending, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'selfchange-verify.json'), 'utf8')).state, 'pending');
});

// Regression: the revert's cleanup logged through `log`, which in selfchange.js is the git-history function, so a
// failed revert threw a TypeError instead of saying why it couldn't revert.
test('a revert that fails says why, and a failed cleanup is logged', async () => {
  warnings.length = 0;
  assert.strictEqual(sh('status', '--porcelain').trim(), '', 'the repository is clean');
  // A merge commit can't be reverted without -m, and no revert is left in progress, so the abort fails too.
  const main = sh('rev-parse', '--abbrev-ref', 'HEAD').trim();
  sh('checkout', '-q', '-b', 'side');
  fs.writeFileSync(path.join(repo, 'c.js'), '1\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'side');
  sh('checkout', '-q', main);
  fs.writeFileSync(path.join(repo, 'd.js'), '1\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'main');
  sh('merge', '-q', '--no-ff', '--no-edit', 'side');
  const merge = sh('rev-parse', 'HEAD').trim();
  await assert.rejects(selfchange.revert(merge), /Could not revert automatically/);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].event, 'revert not aborted');
});
