// Links that lead out (security audit SEC-02, SEC-10): a junction or symlink committed in a cloned repo
// never lets github_read_file / github_change_file reach a file outside the clone, a dangling link inside a
// root fails closed in files.resolveInside, and github_clone asks after outside content (S-4).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir } = require('./helpers');

const tmp = tmpDir('nexus-ghguard-');
const ws = path.join(tmp, 'repos');
const clone = path.join(ws, 'owner', 'name');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(clone, 'src'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
const links = [];
const link = (target, at) => {
  fs.symlinkSync(target, at, 'junction');
  links.push(at);
};
link(outside, path.join(clone, 'cfg'));
link(path.join(tmp, 'not-yet'), path.join(clone, 'dangling'));
test.after(() => {
  for (const l of links) fs.rmSync(l, { force: true, recursive: false });
  fs.rmSync(tmp, { recursive: true, force: true });
});

let calls = [];
const realCp = require('child_process');
stub({
  './store': { getSettings: async () => ({ github: { workspace: ws } }) },
  child_process: { ...realCp, execFile: (cmd, args, opts, cb) => (calls.push([cmd, args]), cb(null, '', '')) },
});
const files = load('main/files.js');
const github = load('main/github.js');

test('files.resolveInside: a dangling link inside the root fails closed', () => {
  assert.throws(() => files.resolveInside(clone, 'dangling/a.md'), /outside/);
  assert.throws(() => files.resolveInside(clone, 'cfg/secret.txt'), /outside/);
  assert.ok(files.resolveInside(clone, 'src/new/a.md').endsWith(path.join('src', 'new', 'a.md')), 'a file not written yet in a real folder');
  assert.ok(files.resolveInside(clone, 'brand-new/dir/x.md'), 'missing folders inside the root are fine');
  assert.strictEqual(files.isInside(clone, path.join(clone, 'dangling', 'x')), false);
});

test('github: reading or writing through a link in the clone is refused', async () => {
  await github.refreshWorkspace();
  await assert.rejects(github.readFile('owner/name', 'cfg/secret.txt'), /outside/);
  await assert.rejects(github.writeFile('owner/name', 'cfg/secret.txt', 'pwned'), /outside/);
  await assert.rejects(github.writeFile('owner/name', 'dangling/x.txt', 'pwned'), /outside/);
  await assert.rejects(github.editFile('owner/name', 'cfg/secret.txt', 'SECRET', 'x'), /outside/);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'SECRET');
  assert.ok(!fs.existsSync(path.join(tmp, 'not-yet')));
  assert.strictEqual(await github.writeFile('owner/name', 'src/a.js', 'ok'), 'src/a.js');
  assert.strictEqual(await github.readFile('owner/name', 'src/a.js'), 'ok');
});

test('github: git runs with hooks and file monitors off', async () => {
  calls = [];
  await github.listFiles('owner/name');
  const [cmd, args] = calls.find((c) => c[0] === 'git');
  assert.strictEqual(cmd, 'git');
  assert.ok(args.includes(`core.hooksPath=${require('os').devNull}`), 'a hook the repo set up never runs');
  assert.ok(args.includes('core.fsmonitor=false'));
  assert.ok(args.indexOf('ls-files') > args.indexOf('core.fsmonitor=false'), 'the options come before the command');
});

test('github_clone asks after outside content, not in a clean turn', async () => {
  const asked = [];
  stub({
    '../github': { clone: async (repo) => ({ path: repo }), localPath: () => clone },
    '../approvals': { gate: async (turn, kind, title, detail, extra) => (asked.push({ kind, extra, tainted: turn?.tainted }), { allow: !turn?.no, reason: 'no' }) },
  });
  load('main/tools/common.js');
  const tools = load('main/tools/github.js');
  const cloneTool = tools.find((t) => t.name === 'github_clone');
  assert.deepStrictEqual(await cloneTool.run({ repo: 'a/b' }, { turn: { tainted: false } }), { path: 'a/b' });
  assert.strictEqual(asked.length, 0, 'clean: no question');
  await cloneTool.run({ repo: 'a/b' }, { turn: { tainted: true } });
  assert.strictEqual(asked.length, 1);
  assert.strictEqual(asked[0].extra.taintAsks, true);
  await assert.rejects(cloneTool.run({ repo: 'a/b' }, { turn: { tainted: true, no: true } }), /Not approved/);
});
