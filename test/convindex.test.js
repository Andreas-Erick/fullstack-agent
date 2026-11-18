// The conversation index (main/store.js): listing conversations doesn't open them all, stays right
// across saves, deletes and restarts, and repairs itself from the folder (audit #1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('nexus-convindex-');
stub({ electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } }, './logger': quietLog });
let store = load('main/store.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const convDir = path.join(dir, 'conversations');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('saves and deletes keep the list right without reading the files', async () => {
  const a = await store.createConversation('First');
  a.messages.push({ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' });
  await store.saveConversation(a);
  const b = await store.createConversation('Second');
  let list = await store.listConversations();
  assert.deepStrictEqual(list.map((c) => c.title).sort(), ['First', 'Second']);
  assert.strictEqual(list.find((c) => c.id === a.id).count, 2);
  // Corrupt a's file: listing must not depend on reading it.
  fs.writeFileSync(path.join(convDir, `${a.id}.json`), '{ broken');
  list = await store.listConversations();
  assert.strictEqual(list.find((c) => c.id === a.id).title, 'First');
  await store.deleteConversation(b.id);
  assert.deepStrictEqual((await store.listConversations()).map((c) => c.id), [a.id]);
});

test('the index is saved and survives a restart; journaledUpTo travels with it', async () => {
  const c = await store.createConversation('Journaled');
  c.messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  c.journaledUpTo = 2;
  await store.saveConversation(c);
  await wait(700);
  assert.ok(fs.existsSync(path.join(convDir, 'index.json')));
  store = load('main/store.js'); // a fresh process
  const entry = (await store.listConversations()).find((x) => x.id === c.id);
  assert.strictEqual(entry.journaledUpTo, 2);
  assert.strictEqual(entry.count, 2);
});

test('files added or removed behind its back are reconciled on load', async () => {
  fs.writeFileSync(path.join(convDir, 'cmanual1.json'), JSON.stringify({ id: 'cmanual1', title: 'Restored from backup', createdAt: 1, updatedAt: 2, messages: [] }));
  const gone = (await store.listConversations())[0].id;
  fs.rmSync(path.join(convDir, `${gone}.json`));
  store = load('main/store.js');
  const ids = (await store.listConversations()).map((x) => x.id);
  assert.ok(ids.includes('cmanual1'));
  assert.ok(!ids.includes(gone));
  assert.ok(!ids.includes('index'), 'the index file is not a conversation');
});

test('clearing resets the index', async () => {
  await store.clearConversations();
  assert.deepStrictEqual(await store.listConversations(), []);
  await store.createConversation('After clear');
  assert.strictEqual((await store.listConversations()).length, 1);
});

test('saving drops the raw tool exchanges of old replies, keeps the recent ones and all text (audit #7)', async () => {
  const c = await store.createConversation('Long');
  for (let i = 0; i < 30; i++) c.messages.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}`, toolCalls: [{ name: 'web_fetch' }], raw: { provider: 'anthropic', messages: [{ role: 'user', content: 'x'.repeat(1000) }] } });
  await store.saveConversation(c);
  const saved = await store.getConversation(c.id);
  const replies = saved.messages.filter((m) => m.role === 'assistant');
  assert.strictEqual(replies.filter((m) => m.raw).length, 16);
  assert.ok(replies.slice(-16).every((m) => m.raw), 'the most recent keep theirs');
  assert.ok(replies.every((m) => m.content && m.toolCalls), 'text and tool lists stay');
});

// 2026-11-16: the morning routine ran after the user's last chat, and the app opened (and warmed, and
// wrote the handoff note about) the routine's conversation. The index now says who wrote.
test('the index knows whether the user wrote: lastOwnAt, and routine for runs only', async () => {
  const briefing = await store.createConversation('⏰ Morning briefing');
  briefing.messages.push({ role: 'user', content: 'brief me', routine: 'rt1', createdAt: 100 }, { role: 'assistant', content: 'Here it is', createdAt: 110 });
  await store.saveConversation(briefing);
  const tasks = await store.createConversation('🔄 Sync my tasks for the calendar');
  tasks.messages.push(
    // A sync from before the auto marker: only its display (this exact text, as old conversations hold it).
    { role: 'user', content: 'sync', display: '🔄 Sync my tasks for the calendar', createdAt: 150 },
    { role: 'user', content: 'sync', display: '🔄 Sync my tasks for the calendar', auto: 'tasks', createdAt: 200 },
    { role: 'user', content: 'go on', hidden: true, createdAt: 300 },
  );
  await store.saveConversation(tasks);
  const mine = await store.createConversation('Mine');
  mine.messages.push(
    { role: 'user', content: 'hi', createdAt: 400 },
    { role: 'assistant', content: 'hello', createdAt: 410 },
    { role: 'user', content: 'brief me', routine: 'rt1', createdAt: 500 },
    { role: 'user', content: 'continue', hidden: true, createdAt: 600 },
  );
  await store.saveConversation(mine);
  const empty = await store.createConversation('Empty');
  const list = await store.listConversations();
  const get = (id) => list.find((x) => x.id === id);
  assert.strictEqual(get(briefing.id).routine, true);
  assert.strictEqual(get(briefing.id).lastOwnAt, 0);
  assert.strictEqual(get(tasks.id).routine, true, 'the app-started tasks sync is not the user’s chat');
  assert.strictEqual(get(tasks.id).lastOwnAt, 0);
  assert.strictEqual(get(mine.id).lastOwnAt, 400, 'the user’s own message, not the routine run or the hidden prompt after it');
  assert.strictEqual(get(mine.id).routine, undefined);
  assert.strictEqual(get(empty.id).lastOwnAt, 0);
  assert.strictEqual(get(empty.id).routine, undefined, 'nothing written yet is nobody’s run');
});

test('an index from before lastOwnAt is summarized again once, and saved as version 2', async () => {
  const c = await store.createConversation('From an old index');
  c.messages.push({ role: 'user', content: 'mine', createdAt: 1234 }, { role: 'assistant', content: 'ok', createdAt: 1300 });
  await store.saveConversation(c);
  await wait(700);
  // As version 1 wrote it (no lastOwnAt), plus the entry of a file this computer can't read.
  const old = { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: 2, journaledUpTo: 0 };
  const unreadable = { id: 'csealed1', title: 'Sealed for another user', createdAt: 1, updatedAt: 2, count: 4, journaledUpTo: 0 };
  fs.writeFileSync(path.join(convDir, 'csealed1.json'), '{ broken');
  fs.writeFileSync(path.join(convDir, 'index.json'), JSON.stringify({ version: 1, items: [old, unreadable] }));
  store = load('main/store.js');
  const list = await store.listConversations();
  assert.strictEqual(list.find((x) => x.id === c.id).lastOwnAt, 1234);
  assert.deepStrictEqual(list.find((x) => x.id === 'csealed1'), unreadable, 'a file that can’t be read keeps its saved entry');
  await wait(700);
  const saved = JSON.parse(fs.readFileSync(path.join(convDir, 'index.json'), 'utf8'));
  assert.strictEqual(saved.version, 2);
  assert.ok(saved.items.some((x) => x.id === 'csealed1'));
  assert.strictEqual(saved.items.find((x) => x.id === c.id).lastOwnAt, 1234);
});

// ---------- conversation files of the wrong shape (boundary-2, security-tests-8) ----------
const writeConv = (id, data) => fs.writeFileSync(path.join(convDir, `${id}.json`), typeof data === 'string' ? data : JSON.stringify(data));

// Regression: one file with `messages: {}` (or a null in its list) made summarize() throw, the index load
// failed, and History and New chat stayed broken for the rest of the session.
test('a conversation file of the wrong shape neither empties the list nor stops new chats', async () => {
  await store.clearConversations();
  fs.mkdirSync(convDir, { recursive: true });
  writeConv('cbad', { id: 'cbad', messages: {} });
  writeConv('cnull', { id: 'cnull', messages: [null, { role: 'user', content: 'x' }] });
  writeConv('cnone', { id: 'cnone' });
  writeConv('cgood1', { id: 'cgood1', title: 'Good one', createdAt: 1, updatedAt: 5, messages: [{ role: 'user', content: 'hi' }] });
  writeConv('cgood2', { id: 'cgood2', title: 'Good two', createdAt: 1, updatedAt: 6, messages: [] });
  store = load('main/store.js');
  const list = await store.listConversations();
  assert.deepStrictEqual(list.map((c) => c.id).sort(), ['cbad', 'cgood1', 'cgood2', 'cnone', 'cnull']);
  const count = (id) => list.find((c) => c.id === id).count;
  assert.deepStrictEqual([count('cbad'), count('cnull'), count('cnone')], [0, 1, 0]);
  const made = await store.createConversation('After the odd ones');
  assert.ok((await store.listConversations()).some((c) => c.id === made.id), 'New chat works');
  assert.deepStrictEqual((await store.getConversation('cbad')).messages, []);
  assert.deepStrictEqual((await store.getConversation('cnone')).messages, []);
  const updated = await store.updateConversation('cnull', (c) => c);
  assert.strictEqual(updated.messages.length, 1);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(convDir, 'cnull.json'), 'utf8')).messages.length, 1, 'saved with one message');
});

test('a saved index is read as it is, not rebuilt from the files', async () => {
  await store.clearConversations(); // also cancels the last test's pending index save
  fs.mkdirSync(convDir, { recursive: true });
  const item = { id: 'cgood1', title: 'From the index', createdAt: 1, updatedAt: 5, count: 1, journaledUpTo: 0, lastOwnAt: 0 };
  writeConv('cgood1', { id: 'cgood1', title: 'Good one', createdAt: 1, updatedAt: 5, messages: [{ role: 'user', content: 'hi' }] });
  writeConv('index', { version: 2, items: [item] });
  store = load('main/store.js');
  assert.strictEqual((await store.listConversations()).find((c) => c.id === 'cgood1').title, 'From the index');
});

test('a failed index load is tried again by the next caller', async () => {
  store = load('main/store.js');
  const real = fs.promises.readdir;
  fs.promises.readdir = async () => {
    fs.promises.readdir = real;
    throw Object.assign(new Error('EIO: i/o error, scandir'), { code: 'EIO' });
  };
  try {
    await assert.rejects(store.listConversations(), { code: 'EIO' });
  } finally {
    fs.promises.readdir = real;
  }
  assert.ok((await store.listConversations()).length > 0, 'History works again without a restart');
});

// Regression: a load that failed after Clear all (which starts the index over) cleared the place of the newer
// load that had started meanwhile, so the next caller began a third one beside it: two loads raced to set the
// list, and a chat saved in between could be missing from History until a restart.
test('a load that fails after Clear all leaves the newer load in place', async () => {
  store = load('main/store.js');
  const real = fs.promises.readdir;
  const held = []; // the first two folder reads wait here; any later one reads at once
  let calls = 0;
  let reached = null;
  const nextRead = () => new Promise((r) => (reached = r));
  fs.promises.readdir = (...args) => {
    calls++;
    if (held.length >= 2) return real(...args);
    return new Promise((resolve, reject) => {
      held.push({ go: () => real(...args).then(resolve, reject), fail: reject });
      reached();
    });
  };
  try {
    let read = nextRead();
    const first = store.listConversations().then(() => null, (err) => err);
    await read; // load A is reading the folder
    await store.clearConversations();
    read = nextRead();
    const second = store.listConversations();
    await read; // load B, started after the clear, is reading it too
    held[0].fail(Object.assign(new Error('ENOENT: no such file or directory, scandir'), { code: 'ENOENT' }));
    assert.strictEqual((await first)?.code, 'ENOENT');
    const third = store.listConversations();
    held[1].go();
    await Promise.all([second, third]);
    assert.strictEqual(calls, 2, 'the third caller shares load B instead of starting another');
  } finally {
    fs.promises.readdir = real;
  }
});

test('"index" is not a conversation id (it is the index file)', async () => {
  const index = path.join(convDir, 'index.json');
  if (!fs.existsSync(index)) writeConv('index', { version: 2, items: [] });
  for (const id of ['index', 'INDEX', 'Index']) await assert.rejects(store.getConversation(id), /Invalid conversation id/, id);
  await assert.rejects(store.deleteConversation('index'), /Invalid conversation id/);
  await assert.rejects(store.saveConversation({ id: 'index', messages: [] }), /Invalid conversation id/);
  assert.ok(fs.existsSync(index), 'the index is still there');
});
