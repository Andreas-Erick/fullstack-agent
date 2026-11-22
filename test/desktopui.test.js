// Desktop UI round 4: actions you can find, plain errors, Undo. memory.restore (Undo of a memory delete)
// runs against a temporary folder; the window's wiring is checked in its source, as settingsview.test.js does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, quietLog, fileStore, settingsSource } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const dir = tmpDir('nexus-memrestore-');
stub({
  './store': fileStore(dir, { getSettings: async () => ({ memory: { vaultPath: path.join(dir, 'Memory') } }) }),
  './logger': quietLog,
  './obsidian': { notifyExternalChange: async () => {}, vaultPath: async () => null },
});
const memory = load('main/memory.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Undo of a memory delete brings it back as it was: id, title, category, dates, words', async () => {
  const saved = await memory.save({ title: 'Coffee', content: 'Takes it black, no sugar.', category: 'preferences' });
  const [listed] = (await memory.list()).filter((e) => e.id === saved.id);
  await memory.remove(saved.id);
  assert.strictEqual(await memory.get(saved.id), null);
  const back = await memory.restore(listed);
  assert.strictEqual(back.id, saved.id);
  const again = await memory.get(saved.id);
  assert.deepStrictEqual({ ...again, created: Math.round(again.created / 1000), updated: Math.round(again.updated / 1000) }, { ...listed, created: Math.round(listed.created / 1000), updated: Math.round(listed.updated / 1000) });
});

test('a restore never overwrites a memory that took the file meanwhile, and refuses what isn’t one', async () => {
  const a = await memory.save({ title: 'Plants', content: 'Waters the ferns on Sundays.' });
  await memory.remove(a.id);
  const other = { ...a, content: 'Something written there since.' };
  await memory.restore(other); // takes the id
  const back = await memory.restore(a);
  assert.notStrictEqual(back.id, a.id, 'a new id, as a save gives');
  assert.strictEqual((await memory.get(a.id)).content, 'Something written there since.', 'the newer one is untouched');
  assert.strictEqual((await memory.get(back.id)).content, 'Waters the ferns on Sundays.');
  await assert.rejects(memory.restore(null), /Nothing to restore/);
  await assert.rejects(memory.restore({ id: 'x', content: '   ' }), /content is required/);
  await assert.rejects(memory.restore({ id: '../escape', content: 'hi' }), /Invalid memory id/);
  await assert.rejects(memory.restore({ id: 'ok-id', content: 42 }), /content is required/);
});

test('memory:restore is wired main ↔ preload ↔ the Memory view’s Undo', () => {
  assert.match(read('main/main.js'), /handle\('memory:restore', \(e\) => memory\.restore\(e\)\);/);
  assert.match(read('preload.js'), /memory: \[[^\]]*'restore'/);
  const view = read('renderer/js/memory.js');
  assert.match(view, /toastActions\(`Forgot “\$\{e\.title\}”`, \[\['Undo', \(\) => api\.memory\.restore\(e\)/);
});

test('chat: a live stop shows the visible Try again card; a send that never left puts the words back', () => {
  const chat = read('renderer/js/chat.js');
  const sync = chat.slice(chat.indexOf('function syncActions('), chat.indexOf('\n}\n', chat.indexOf('function syncActions(')));
  assert.match(sync, /reply\.querySelector\('\.msg-body'\)\?\.append\(el\('div', \{ class: 'msg-failed' \}, stopNode\('Stopped\.', a\.again\)\)\)/);
  assert.doesNotMatch(sync, /redoButton\('↻ Try again'/, 'no Try again hidden in the meta row');
  const send = chat.slice(chat.indexOf('async function deliver('), chat.indexOf('\n}\n', chat.indexOf('async function deliver(')));
  assert.doesNotMatch(send, /bubble\.textContent = err\.message/);
  assert.match(send, /chatcore\.errorHelp\(plainError\(err\)/);
  // The words and files come back through the outbox (test/outbox.test.js); the reply's place stays.
  assert.match(send, /refusedSend\(null, requestId, wrap, \{ keepWrap: true \}\)/);
  assert.match(chat, /textContent = name; \/\/ no status claim/);
  assert.doesNotMatch(read('renderer/index.html'), /NEXUS/, 'the old brand never shows, even before the chat starts');
});

test('styles: hover-only actions show on touch screens and to the keyboard; danger buttons stand apart', () => {
  const css = read('renderer/styles.css');
  const touch = /@media \(hover: none\), \(pointer: coarse\) \{\s*([^}]*)\{ opacity: 1; \}/.exec(css);
  assert.ok(touch, 'a touch rule');
  for (const sel of ['.msg-meta', '.code-copy', '.conv-item .x', '.mem-card .foot .acts']) assert.ok(touch[1].includes(sel), sel);
  assert.match(css, /\.mem-card:is\(:hover, :focus-within\) \.foot \.acts \{ opacity: 1; \}/);
  assert.match(css, /\.msg-meta:has\(\.redo-btn\) \{ opacity: 0\.55; \}/);
  assert.match(css, /\.msg-meta button \{[^}]*padding: 4px 5px; margin: -4px -3px;/); // hit areas that never touch (gap 10px)
  assert.match(css, /\.skill-card \.acts \.danger \{ margin-left: auto; \}/);
  assert.match(css, /\.dropdown-menu :not\(\.danger\) \+ \.danger::before/);
  assert.match(read('renderer/js/calendar.js'), /class: 'btn danger', style: \{ marginRight: 'auto' \}, onclick: \(\) => \(close\(\), removeEntry\(entry \|\|/);
  assert.match(settingsSource(), /class: 'btn small danger',\s*onclick: async \(\) => \{\s*if \(!\(await confirmDialog\('Remove device'/);
});

test('keys: Ctrl+N in the Notes view is a new note wherever the focus is; W A S D with Shift or Caps Lock', () => {
  const app = read('renderer/js/app.js');
  assert.match(app, /if \(currentView === 'notes'\) \{\s*if \(!dialogOpen\(\) && !\$\('#notesDumpLayer'\)\) newNote\(\);\s*return;\s*\}\s*switchView\('chat'\);\s*newChat\(\);/);
  assert.match(read('renderer/js/notes.js'), /export async function newNote\(/);
  assert.match(read('renderer/js/innerworld.js'), /keys\[e\.key\.length === 1 \? e\.key\.toLowerCase\(\) : e\.key\]/);
});

test('Vault: a failed delete keeps the note open', () => {
  const kb = read('renderer/js/knowledge.js');
  assert.match(kb, /const ok = await api\.obsidian\.delete\(n\.path\)\.then\(\(\) => true, [^\n]*false\)\);\s*if \(!ok\) return;\s*selected = null;/);
});
