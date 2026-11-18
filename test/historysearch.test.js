// History's search through what was said (main/historysearch.js): order, the result's shape, limits and
// cursors, the time budget, the cache, superseded searches, unreadable and deleted chats.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

// A conversation store stand-in: summaries like the index (id, title, updatedAt, count) and files that
// can be read, counted, held back or broken.
const fake = {
  convs: new Map(),
  reads: [],
  gate: null, // a promise every read waits for
  broken: new Set(),
  onRead: null,
  async listConversations() {
    return [...this.convs.values()].map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length })).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async getConversation(id) {
    this.reads.push(id);
    this.onRead?.(id);
    if (this.gate) await this.gate;
    if (this.broken.has(id)) throw new Error('sealed for another user');
    const c = this.convs.get(id);
    return c ? JSON.parse(JSON.stringify(c)) : null;
  },
};
stub({ './store': fake, './logger': quietLog });
const hs = load('main/historysearch.js');

function reset() {
  fake.convs.clear();
  fake.reads = [];
  fake.gate = null;
  fake.broken.clear();
  fake.onRead = null;
  hs.clear();
  hs._setBudget(8_000_000);
}

function add(id, updatedAt, texts, title = `Chat ${id}`) {
  const messages = texts.map((t, i) => ({ id: `${id}m${i}`, role: i % 2 ? 'assistant' : 'user', content: t, createdAt: updatedAt - texts.length + i, ...(i % 2 ? { persona: 'Ada' } : {}) }));
  fake.convs.set(id, { id, title, updatedAt, messages });
}

test('newest first; items carry only ids, titles, dates and a snippet', async () => {
  reset();
  add('c1', 1000, ['tell me about the capacitor', 'A capacitor stores charge.']);
  add('c2', 3000, ['nothing here', 'still nothing']);
  add('c3', 2000, ['what is a flux capacitor?', `The flux capacitor ${'is a long story '.repeat(20)}`]);
  const r = await hs.search('capacitor');
  assert.deepStrictEqual(r.items.map((x) => x.id), ['c3', 'c1']);
  assert.strictEqual(r.done, true);
  assert.strictEqual(r.capped, false);
  assert.strictEqual(r.cursor, null);
  assert.strictEqual(r.scanned, 3);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.unreadable, 0);
  assert.deepStrictEqual(Object.keys(r).sort(), ['capped', 'cursor', 'done', 'items', 'scanned', 'total', 'unreadable']);
  for (const it of r.items) {
    assert.deepStrictEqual(Object.keys(it).sort(), ['at', 'hits', 'id', 'messageId', 'persona', 'role', 'snippet', 'title', 'updatedAt']);
    assert.ok(it.snippet.text.length <= 102, `${it.snippet.text.length}`);
    assert.ok(Array.isArray(it.snippet.marks));
    assert.ok(!('messages' in it) && !('content' in it) && !('raw' in it));
  }
  const c3 = r.items[0];
  assert.strictEqual(c3.title, 'Chat c3');
  assert.strictEqual(c3.messageId, 'c3m0'); // the earliest of two equally good messages
  assert.strictEqual(c3.role, 'user');
  assert.strictEqual(c3.persona, '');
  assert.strictEqual(c3.hits, 2);
  assert.strictEqual(c3.at, 2000 - 2);
});

test('an empty or one-letter query reads nothing; a long one works', async () => {
  reset();
  add('c1', 1000, ['capacitor']);
  for (const q of ['', ' ', 'a', null]) {
    const r = await hs.search(q);
    assert.deepStrictEqual(r.items, []);
    assert.strictEqual(r.done, true);
  }
  assert.strictEqual(fake.reads.length, 0);
  const r = await hs.search(`capacitor ${'x'.repeat(500)}`);
  assert.deepStrictEqual(r.items, []); // the second word isn't there
  assert.strictEqual(fake.reads.length, 1);
  assert.strictEqual((await hs.search(`capacitor ${'a '.repeat(250)}`)).items.length, 1);
});

test('limit: 30 at a time with a cursor, the rest after it', async () => {
  reset();
  for (let i = 0; i < 40; i++) add(`c${String(i).padStart(2, '0')}`, 10000 - i, [`capacitor number ${i}`]);
  add('none', 20000, ['nothing']);
  const first = await hs.search('capacitor');
  assert.strictEqual(first.items.length, hs.LIMIT);
  assert.strictEqual(first.done, false);
  assert.strictEqual(first.capped, true);
  assert.deepStrictEqual(first.cursor, { updatedAt: 10000 - 29, id: 'c29' });
  const rest = await hs.search('capacitor', { cursor: first.cursor });
  assert.strictEqual(rest.items.length, 10);
  assert.strictEqual(rest.done, true);
  const ids = [...first.items, ...rest.items].map((x) => x.id);
  assert.strictEqual(new Set(ids).size, 40);
  assert.deepStrictEqual(ids, [...ids].sort());
  // a cursor that isn't one is ignored: from the start
  const odd = await hs.search('capacitor', { cursor: { updatedAt: 5, id: '../x' } });
  assert.strictEqual(odd.items[0].id, 'c00');
  assert.strictEqual((await hs.search('capacitor', { cursor: 'nope' })).items[0].id, 'c00');
  // the limit is clamped to 1..50 (0 = the default)
  assert.strictEqual((await hs.search('capacitor', { limit: 0 })).items.length, hs.LIMIT);
  assert.strictEqual((await hs.search('capacitor', { limit: -5 })).items.length, 1);
  assert.strictEqual((await hs.search('capacitor', { limit: 500 })).items.length, 40);
  assert.strictEqual((await hs.search('capacitor', { limit: 'x' })).items.length, hs.LIMIT);
});

test('equal times: ordered by id, and the cursor still has no gaps', async () => {
  reset();
  for (const id of ['ca', 'cb', 'cc', 'cd']) add(id, 500, ['capacitor']);
  const a = await hs.search('capacitor', { limit: 2 });
  assert.deepStrictEqual(a.items.map((x) => x.id), ['cd', 'cc']);
  const b = await hs.search('capacitor', { limit: 2, cursor: a.cursor });
  assert.deepStrictEqual(b.items.map((x) => x.id), ['cb', 'ca']);
});

test('index entries without a time: the cursor still goes on past them', async () => {
  reset();
  for (let i = 0; i < 4; i++) add(`c${i}`, 1000 - i, ['capacitor']);
  // hand-made or broken index entries: no updatedAt (sorted as 0, last)
  for (const id of ['c4', 'c5']) fake.convs.set(id, { id, title: id, messages: [{ id: `${id}m`, role: 'user', content: 'capacitor' }] });
  const first = await hs.search('capacitor', { limit: 5 });
  assert.deepStrictEqual(first.items.map((x) => x.id), ['c0', 'c1', 'c2', 'c3', 'c5']);
  assert.deepStrictEqual(first.cursor, { updatedAt: 0, id: 'c5' });
  const rest = await hs.search('capacitor', { limit: 5, cursor: first.cursor });
  assert.deepStrictEqual(rest.items.map((x) => x.id), ['c4']);
  assert.strictEqual(rest.done, true);
});

test('budget: stops after the time is up, with a cursor to go on from', async () => {
  reset();
  for (let i = 0; i < 10; i++) add(`c${i}`, 1000 - i, ['nothing to see']);
  add('c99', 1, ['the capacitor at last']);
  let clock = 0;
  fake.onRead = () => (clock += 150);
  const r = await hs.search('capacitor', { budgetMs: 400, now: () => clock });
  assert.ok(r.scanned >= 3 && r.scanned <= 4, `${r.scanned}`);
  assert.strictEqual(r.done, false);
  assert.strictEqual(r.capped, false);
  assert.ok(r.cursor);
  let cursor = r.cursor;
  let found = [];
  for (let n = 0; n < 10 && cursor; n++) {
    const next = await hs.search('capacitor', { cursor, budgetMs: 400, now: () => clock });
    found = found.concat(next.items.map((x) => x.id));
    cursor = next.cursor;
  }
  assert.deepStrictEqual(found, ['c99']);
});

test('cache: a repeat search reads nothing; a change re-reads only that chat', async () => {
  reset();
  add('c1', 1000, ['capacitor one']);
  add('c2', 2000, ['capacitor two']);
  add('c3', 3000, ['capacitor three']);
  await hs.search('capacitor');
  assert.strictEqual(fake.reads.length, 3);
  fake.reads = [];
  assert.strictEqual((await hs.search('capacitor')).items.length, 3);
  assert.deepStrictEqual(fake.reads, []);
  // a new message (count) or a newer updatedAt: only that one is read again
  fake.convs.get('c2').messages.push({ id: 'new', role: 'assistant', content: 'more capacitor talk' });
  fake.convs.get('c3').updatedAt = 3500;
  await hs.search('capacitor');
  assert.deepStrictEqual(fake.reads.sort(), ['c2', 'c3']);
  // forget: read again
  fake.reads = [];
  hs.forget('c1');
  await hs.search('capacitor');
  assert.deepStrictEqual(fake.reads, ['c1']);
  // a chat gone from the list leaves the cache
  fake.convs.delete('c1');
  await hs.search('capacitor');
  assert.ok(!hs._cached().includes('c1'));
  // clear empties it
  hs.clear();
  assert.deepStrictEqual(hs._cached(), []);
  fake.reads = [];
  await hs.search('capacitor');
  assert.strictEqual(fake.reads.length, 2);
});

test('cache: a deep scan past the budget keeps the newest chats', async () => {
  reset();
  const text = 'capacitor '.repeat(50); // 499 chars of plain + 499 folded per chat
  for (let i = 0; i < 30; i++) add(`c${String(i).padStart(2, '0')}`, 10000 - i, [text]);
  hs._setBudget(5000); // room for five
  await hs.search('capacitor', { limit: 50 });
  assert.deepStrictEqual(hs._cached().sort(), ['c00', 'c01', 'c02', 'c03', 'c04']);
  // a repeat search reads only the older ones again, never pushing out the newest
  fake.reads = [];
  await hs.search('capacitor', { limit: 50 });
  assert.ok(!fake.reads.some((id) => ['c00', 'c01', 'c02', 'c03', 'c04'].includes(id)));
  assert.deepStrictEqual(hs._cached().sort(), ['c00', 'c01', 'c02', 'c03', 'c04']);
  // a newer chat pushes out the oldest cached one
  add('fresh', 20000, [text]);
  await hs.search('capacitor', { limit: 1 });
  assert.deepStrictEqual(hs._cached().sort(), ['c00', 'c01', 'c02', 'c03', 'fresh']);
  // an entry bigger than a quarter of the budget isn't kept
  add('huge', 30000, ['capacitor '.repeat(400)]);
  await hs.search('capacitor', { limit: 1 });
  assert.ok(!hs._cached().includes('huge'));
});

test('a newer search (or an empty one) stops an older one', async () => {
  reset();
  for (let i = 0; i < 5; i++) add(`c${i}`, 1000 - i, ['capacitor']);
  let open;
  fake.gate = new Promise((r) => (open = r));
  const a = hs.search('capacitor');
  await new Promise((r) => setImmediate(r));
  fake.gate = null;
  const b = hs.search('');
  open();
  assert.deepStrictEqual(await a, { superseded: true });
  assert.deepStrictEqual((await b).items, []);
  // and a newer real search
  fake.gate = new Promise((r) => (open = r));
  const c = hs.search('capacitor');
  await new Promise((r) => setImmediate(r));
  fake.gate = null;
  const d = hs.search('capacitor');
  open();
  assert.deepStrictEqual(await c, { superseded: true });
  assert.strictEqual((await d).items.length, 5);
});

test('unreadable chats are skipped and counted; one deleted meanwhile is not', async () => {
  reset();
  add('c1', 3000, ['capacitor ok']);
  add('c2', 2000, ['capacitor sealed']);
  add('c3', 1000, ['capacitor gone']);
  fake.broken.add('c2');
  // c3 is deleted while it is being read: its file is gone, and so is its index entry
  fake.onRead = (id) => id === 'c3' && fake.convs.delete('c3');
  const r = await hs.search('capacitor');
  assert.deepStrictEqual(r.items.map((x) => x.id), ['c1']);
  assert.strictEqual(r.unreadable, 1);
  assert.strictEqual(r.scanned, 3);
  // a listed chat whose file reads as null counts too
  reset();
  add('c1', 1000, ['capacitor']);
  const real = fake.getConversation;
  fake.getConversation = async () => null;
  const n = await hs.search('capacitor');
  fake.getConversation = real;
  assert.strictEqual(n.unreadable, 1);
  assert.deepStrictEqual(n.items, []);
});

test('hidden messages, tool output and a stopped reply are never found', async () => {
  reset();
  fake.convs.set('c1', {
    id: 'c1',
    title: 'Chat',
    updatedAt: 1000,
    messages: [
      { id: 'a', role: 'user', content: 'capacitor secret prompt', hidden: true },
      { id: 'b', role: 'tool', content: 'capacitor from a tool' },
      { id: 'c', role: 'assistant', content: '*(stopped)*' },
      { id: 'd', role: 'user', display: '/plan week', content: 'capacitor in the steps' },
    ],
  });
  assert.deepStrictEqual((await hs.search('capacitor')).items, []);
  assert.strictEqual((await hs.search('week')).items[0].messageId, 'd');
});
