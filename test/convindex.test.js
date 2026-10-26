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
