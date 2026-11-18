// Folder access: by default the agent may use only the workspace folder (plus its vault); the user adds
// and removes folders in Settings → Documents. Covers documents.js and Claude Code's Read/Glob/Grep.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const base = tmpDir('nexus-folders-');
const ws = path.join(base, 'Workspace');
const extra = path.join(base, 'Extra');
const vault = path.join(base, 'Vault');
const desktop = path.join(base, 'Desktop');
for (const d of [ws, extra, vault, desktop]) fs.mkdirSync(d);
fs.writeFileSync(path.join(ws, 'report.txt'), 'hello');
fs.writeFileSync(path.join(desktop, 'secret.txt'), 'nope');

let settings = { documents: { workspace: ws, allowedRoots: [] } };
stub({
  electron: { app: { getPath: (k) => (k === 'documents' ? path.join(base, 'Documents') : k === 'home' ? base : desktop) } },
  './store': { getSettings: async () => settings },
  './obsidian': { vaultPath: async () => vault },
  './bridge': {},
  './github': {},
  './logger': quietLog,
  './approvals': { gate: async () => ({ allow: true }), markTainted: () => {} },
});
const documents = load('main/documents.js');
const claudecode = load('main/claudecode.js');
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('only the workspace folder by default, not Desktop/Documents/Downloads', async () => {
  const roots = await documents.allowedRoots();
  assert.ok(roots.includes(ws) && roots.includes(vault));
  assert.ok(!roots.includes(desktop));
  assert.strictEqual(await documents.resolveAllowed(path.join(ws, 'report.txt')), path.join(ws, 'report.txt'));
  assert.strictEqual(await documents.resolveAllowed('report.txt'), path.join(ws, 'report.txt'), 'relative paths: the workspace first');
  await assert.rejects(documents.resolveAllowed(path.join(desktop, 'secret.txt')), /not allowed/);
});

test('folders the user adds are allowed, and removing one takes access away', async () => {
  settings = { documents: { workspace: ws, allowedRoots: [extra, 'relative/ignored', ''] } };
  assert.deepStrictEqual(documents.userFolders(settings), [ws, extra]);
  assert.ok(await documents.resolveAllowed(path.join(extra, 'a.txt')));
  settings = { documents: { workspace: ws, allowedRoots: [] } };
  await assert.rejects(documents.resolveAllowed(path.join(extra, 'a.txt')), /not allowed/);
});

test('a file the user opens in the app is always allowed', async () => {
  const f = path.join(desktop, 'secret.txt');
  assert.strictEqual(await documents.resolveAllowed(f, { fromUser: true }), f);
});

const spec = (folders) =>
  claudecode.sessionSpec({ settings: { claudeCode: { effort: 'default' }, web: { enabled: false }, code: { allowSelfModify: false } }, configKey: 'k', activeTools: [], cwd: path.join(base, 'app'), vault, repos: '', folders, model: 'default' });

test('Claude Code: reads are not pre-allowed everywhere; the user folders are session folders', () => {
  const s = spec([ws]);
  assert.ok(!s.allowed.includes('Read') && !s.allowed.includes('Glob') && !s.allowed.includes('Grep'));
  assert.ok(s.addDirs.includes(ws) && s.addDirs.includes(vault));
  assert.notStrictEqual(spec([ws]).key, spec([ws, extra]).key, 'adding a folder restarts the session');
});

test('Claude Code: Read/Glob/Grep outside the allowed folders are denied', async () => {
  const sess = new claudecode.Session('c1');
  sess.spec = spec([ws]);
  sess.turn = { ctx: { turn: { tainted: false, taintSources: [], approved: new Set() } } };
  const ask = (tool_name, input) => sess.approve({ tool_name, input }).then((r) => r.behavior);
  assert.strictEqual(await ask('Read', { file_path: path.join(ws, 'report.txt') }), 'allow');
  assert.strictEqual(await ask('Read', { file_path: path.join(vault, 'Profile.md') }), 'allow');
  assert.strictEqual(await ask('Read', { file_path: path.join(desktop, 'secret.txt') }), 'deny');
  assert.strictEqual(await ask('Grep', { pattern: 'x', path: desktop }), 'deny');
  assert.strictEqual(await ask('Glob', { pattern: `${desktop.split(path.sep).join('/')}/**/*.txt` }), 'deny', 'an absolute glob pattern');
  assert.strictEqual(await ask('Glob', { pattern: '**/*.md' }), 'allow', 'relative: the session folder');
  assert.strictEqual(await ask('Read', { file_path: path.join(ws, '..', 'Desktop', 'secret.txt') }), 'deny', 'no escaping with ..');
});

// Copies of files attached in the chat (main/attachments.js): the app's own folder, <userData>/attachments
// (here userData is the stand-in's Desktop folder). Allowed, but never searched, and opened outside the app
// only as documents and data.
const attached = require('../main/datadir').attachmentsFolder();
test('attachments: allowed and readable, never searched by name, opened outside the app only as documents', async () => {
  fs.mkdirSync(path.join(attached, 'c1'), { recursive: true });
  for (const f of ['a.pdf', 'run.bat.txt', 'page.html', 'logo.svg', 'report.txt']) fs.writeFileSync(path.join(attached, 'c1', f), 'x');
  fs.mkdirSync(path.join(desktop, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(desktop, 'conversations', 'c1.json'), '{}');
  assert.ok((await documents.allowedRoots()).includes(attached));
  assert.strictEqual(await documents.resolveAllowed(path.join(attached, 'c1', 'a.pdf')), path.join(attached, 'c1', 'a.pdf'));
  await assert.rejects(documents.resolveAllowed(path.join(desktop, 'conversations', 'c1.json')), /not allowed/, 'only the attachments, not the rest of the app’s data');
  await assert.rejects(documents.resolveAllowed(path.join(desktop, 'diary.txt')), /not allowed/, 'nor the folder around it');
  assert.ok(await documents.externalPath(path.join(attached, 'c1', 'a.pdf')));
  assert.ok(await documents.externalPath(path.join(attached, 'c1', 'run.bat.txt')));
  for (const f of ['page.html', 'logo.svg']) await assert.rejects(documents.externalPath(path.join(attached, 'c1', f)), /only inside the app/, f);
  const found = await documents.findDocuments('report');
  assert.deepStrictEqual(found.matches.map((m) => m.path), [path.join(ws, 'report.txt')], 'a copy is reached through its conversation, not by name');
  // Not added to the recent list (this store stand-in has no files: adding would throw).
  const doc = await documents.load(path.join(attached, 'c1', 'report.txt'));
  assert.strictEqual(doc.kind, 'text');
});
