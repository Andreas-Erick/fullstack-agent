// Memories in the prompt (audit #4): the list is cached and cleared by writes; with many memories the
// stable prompt lists recent titles only and the relevant ones come with each message.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

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

// Regression: one file that couldn't be read rejected the whole list: the Memory view said "The vault is
// empty" and the prompt lost every memory.
test('one unreadable memory file is skipped, counted in the log, and the list isn’t cached then', async () => {
  await memory.save({ title: 'Tea', content: 'Likes green tea' });
  await memory.save({ title: 'Cat', content: 'Has a cat named Miso' });
  const odd = path.join(vault, 'x.md');
  fs.mkdirSync(odd); // a folder named like a memory: reading it fails
  const warned = [];
  const warn = quietLog.warn;
  quietLog.warn = (event, data) => warned.push({ event, data });
  try {
    assert.deepStrictEqual((await memory.list()).map((e) => e.title).sort(), ['Cat', 'Tea']);
    assert.deepStrictEqual(warned, [{ event: 'memory unreadable', data: { count: 1 } }]);
    fs.writeFileSync(path.join(vault, 'y.md'), 'Written by hand in another editor');
    assert.strictEqual((await memory.list()).length, 3, 'read again, not from a cache');
  } finally {
    quietLog.warn = warn;
    fs.rmSync(odd, { recursive: true, force: true });
  }
  await memory.clear();
});

test('import takes only a list of memories with text, and says what it skipped', async () => {
  for (const bad of [{}, null, 'x', 42, { entries: [] }]) await assert.rejects(memory.importEntries(bad), /isn't a memory export/, JSON.stringify(bad));
  assert.deepStrictEqual(await memory.importEntries([{ content: {} }, { content: 'a' }, null, { content: '  ' }, { content: 'b', title: 5 }, ['c']]), { imported: 1, skipped: 5 });
  await memory.clear();
  const five = [1, 2, 3, 4, 5].map((n) => ({ title: `M${n}`, content: `Memory ${n}` }));
  assert.deepStrictEqual(await memory.importEntries(five, { max: 3 }), { imported: 3, skipped: 2 });
  assert.strictEqual(fs.readdirSync(vault).filter((f) => f.endsWith('.md')).length, 3);
  assert.deepStrictEqual(await memory.importEntries([]), { imported: 0, skipped: 0 });
  await memory.clear();
});

test('an export imports back as it was: emoji, right-to-left text, 10,000 characters, markup', async () => {
  const wanted = [
    { title: '👨‍👩‍👧‍👦 שלום', content: 'Family greeting', category: 'people' },
    { title: 'Long one', content: 'y'.repeat(10000), category: 'fact' },
    { title: '<script>alert(1)</script>', content: '<script>alert(1)</script>', category: 'general' },
  ];
  for (const e of wanted) await memory.save(e);
  const exported = JSON.parse(JSON.stringify(await memory.list())); // memory:export's JSON
  await memory.clear();
  assert.deepStrictEqual(await memory.importEntries(exported), { imported: 3, skipped: 0 });
  const back = (await memory.list()).map(({ title, content, category }) => ({ title, content, category }));
  const byTitle = (a, b) => a.title.localeCompare(b.title);
  assert.deepStrictEqual(back.sort(byTitle), [...wanted].sort(byTitle));
  await memory.clear();
});

// memory_delete asks first ('delete', so Ask mode keeps its promise about deletions), and an unknown id
// is an error, not { deleted }.
test('forgetting a memory through the tool asks first, and refuses ids that aren’t memories', async () => {
  const asked = [];
  let answer = true;
  const recorder = async (_ctx, kind, title) => {
    asked.push({ kind, title, existed: fs.existsSync(path.join(vault, `${current.id}.md`)) });
    if (!answer) throw new Error('Not approved by the user: declined');
  };
  stub({ './common': { ...require(path.join(ROOT, 'main/tools/common.js')), requireApproval: recorder } });
  const tool = load('main/tools/memory.js').find((t) => t.name === 'memory_delete');
  const events = [];
  const ctx = { emit: (e) => events.push(e.type), turn: {} };
  let current = await memory.save({ title: 'Old address', content: 'Lived on Elm Street' });

  const r = await tool.run({ id: current.id }, ctx);
  assert.deepStrictEqual(r, { deleted: current.id });
  assert.deepStrictEqual(asked, [{ kind: 'delete', title: 'Forget “Old address”', existed: true }]);
  assert.ok(!fs.existsSync(path.join(vault, `${current.id}.md`)), 'gone');
  assert.deepStrictEqual(events, ['memory_changed']);

  answer = false;
  current = await memory.save({ title: 'Keep me', content: 'Still true' });
  await assert.rejects(tool.run({ id: current.id }, ctx), /Not approved/);
  assert.ok(fs.existsSync(path.join(vault, `${current.id}.md`)), 'declined: the memory stays');

  asked.length = 0;
  await assert.rejects(tool.run({ id: 'nope-123' }, ctx), /No memory with id "nope-123"/);
  await assert.rejects(tool.run({ id: '../x' }, ctx), /Invalid memory id/);
  assert.deepStrictEqual(asked, [], 'nothing to ask about');
  await memory.clear();
});
