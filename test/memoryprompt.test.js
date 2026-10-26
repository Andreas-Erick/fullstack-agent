// Memories in the prompt (audit #4): the list is cached and cleared by writes; with many memories the
// stable prompt lists recent titles only and the relevant ones come with each message.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dir = tmpDir('nexus-mem-');
const vault = path.join(dir, 'Memory');
stub({
  './logger': quietLog,
  './store': fileStore(dir, { getSettings: async () => ({ memory: { vaultPath: vault } }) }),
  './obsidian': { vaultPath: async () => null, notifyExternalChange: async () => {} },
});
const memory = load('main/memory.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('writes show up at once through the cache', async () => {
  await memory.save({ title: 'Coffee', content: 'Takes it black', category: 'preference' });
  assert.strictEqual((await memory.list()).length, 1);
  const [e] = await memory.list();
  await memory.update(e.id, { content: 'Takes it with oat milk' });
  assert.match((await memory.list())[0].content, /oat milk/);
  await memory.remove(e.id);
  assert.strictEqual((await memory.list()).length, 0);
});

test('the cached list is a copy (callers can change it safely)', async () => {
  await memory.save({ title: 'Dog', content: 'Has a dog named Pixel', category: 'fact' });
  (await memory.list())[0].title = 'changed';
  assert.strictEqual((await memory.list())[0].title, 'Dog');
  await memory.clear();
});

test('relevant() ranks the memories that match the message first', async () => {
  for (let i = 0; i < 30; i++) await memory.save({ title: `Note ${i}`, content: `Unrelated filler about topic number ${i}`, category: 'fact' });
  await memory.save({ title: 'Violin', content: 'Practices violin scales every evening', category: 'habit' });
  const top = await memory.relevant('how is my violin practice going', 3);
  assert.strictEqual(top[0].title, 'Violin');
  assert.ok(top.length <= 3);
  await memory.clear();
});
