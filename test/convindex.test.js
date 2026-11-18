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
