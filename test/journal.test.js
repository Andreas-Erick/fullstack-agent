// The journal's sweep (main/journal.js) runs every minute. A summary that fails backs off per conversation
// (5 min doubling to 1 h, then not until the conversation changes), and a conversation with nothing of
// the user's to journal is marked read, so neither is opened (and unsealed) every minute forever.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const MIN = 60000;
const convs = new Map();
const reads = [];
const calls = [];
let fail = null;
const saved = [];
stub({
  './logger': quietLog,
  './store': {
    getSettings: async () => ({ journal: { enabled: true, idleMinutes: 15 }, obsidian: { enabled: true }, llm: {} }),
    listConversations: async () =>
      [...convs.values()].map((c) => ({ id: c.id, updatedAt: c.updatedAt, count: c.messages.length, journaledUpTo: c.journaledUpTo || 0 })),
    getConversation: async (id) => (reads.push(id), convs.has(id) ? structuredClone(convs.get(id)) : null),
    saveConversation: async (c) => (saved.push(c.id), convs.set(c.id, structuredClone(c))),
  },
  './llm': {
    complete: async () => {
      calls.push(1);
      if (fail) throw fail;
      return '{}';
    },
  },
  './obsidian': { logSession: async () => {} },
  './persona': { jsonWithRetry: async () => ({ topic: 'T' }) },
});
const journal = load('main/journal.js');
const { backoffDelay, mayTry, afterFailure, BACKOFF_FIRST_MS: FIRST, BACKOFF_MAX_MS: MAX } = journal;

test('backoffDelay: 0 for none, 5 min doubling, the hour once, then stop', () => {
  assert.deepStrictEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(backoffDelay),
    [0, FIRST, 2 * FIRST, 4 * FIRST, 8 * FIRST, MAX, Infinity, Infinity, Infinity, Infinity, Infinity],
  );
  assert.strictEqual(FIRST, 5 * MIN);
  assert.strictEqual(MAX, 60 * MIN);
  for (const odd of [NaN, -1, undefined, null, 'x']) assert.strictEqual(backoffDelay(odd), 0);
});

test('mayTry / afterFailure: waits, counts, and a changed conversation starts over', () => {
  let e;
  let now = 1000;
  assert.strictEqual(mayTry(undefined, 's1', now), true);
  for (let i = 1; i <= 10; i++) {
    e = afterFailure(e, 's1', now);
    assert.strictEqual(e.failures, i);
    assert.strictEqual(e.nextAt, now + backoffDelay(i));
    assert.strictEqual(mayTry(e, 's1', now), false);
    if (Number.isFinite(e.nextAt)) {
      assert.strictEqual(mayTry(e, 's1', e.nextAt - 1), false);
      assert.strictEqual(mayTry(e, 's1', e.nextAt), true);
      now = e.nextAt;
    }
  }
  assert.strictEqual(mayTry(e, 's1', now + 1e12), false, 'stopped for good while unchanged');
  assert.strictEqual(mayTry(e, 's2', now), true, 'a new message or save tries again');
  assert.strictEqual(afterFailure(e, 's2', now).failures, 1);
  assert.strictEqual(mayTry(e, 's1', NaN), false);
});

test('sweep: a failing summary is asked again only after its backoff, and a change resets it', async (t) => {
  const realNow = Date.now;
  let clock = 10 * 86400000;
  Date.now = () => clock;
  t.after(() => (Date.now = realNow));
  convs.clear();
  convs.set('a', { id: 'a', updatedAt: clock - 60 * MIN, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });
  fail = new Error('rate limited');
  calls.length = 0;
  await journal.sweep();
  assert.strictEqual(calls.length, 1);
  for (let m = 1; m < 5; m++) {
    clock += MIN;
    await journal.sweep();
  }
  assert.strictEqual(calls.length, 1, 'not asked again within 5 minutes');
  clock += MIN;
  await journal.sweep();
  assert.strictEqual(calls.length, 2, 'asked again after 5 minutes');
  // Run the clock for a day: 5 + 10 + 20 + 40 + 60 minutes, then never again.
  for (let m = 0; m < 24 * 60; m += 5) {
    clock += 5 * MIN;
    await journal.sweep();
  }
  assert.strictEqual(calls.length, 6);
  // A new message changes the conversation: tried again, and on success marked journaled.
  const c = convs.get('a');
  c.messages.push({ role: 'user', content: 'more' });
  fail = null;
  await journal.sweep();
  assert.strictEqual(calls.length, 7);
  assert.strictEqual(convs.get('a').journaledUpTo, 3);
  await journal.sweep();
  assert.strictEqual(calls.length, 7);
});

test('sweep: offline stops the sweep after the first failure; the others wait', async (t) => {
  const realNow = Date.now;
  const clock = 20 * 86400000;
  Date.now = () => clock;
  t.after(() => (Date.now = realNow));
  convs.clear();
  for (const id of ['x', 'y', 'z']) {
    convs.set(id, { id, updatedAt: clock - 60 * MIN, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });
  }
  fail = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' });
  calls.length = 0;
  await journal.sweep();
  assert.strictEqual(calls.length, 1);
  fail = null;
});

test('sweep: a conversation without a user message is marked read once, not reopened every minute', async (t) => {
  const realNow = Date.now;
  let clock = 30 * 86400000;
  Date.now = () => clock;
  t.after(() => (Date.now = realNow));
  convs.clear();
  convs.set('g', { id: 'g', updatedAt: clock - 60 * MIN, messages: [{ role: 'assistant', content: 'hello' }, { role: 'assistant', content: 'still here' }] });
  reads.length = 0;
  calls.length = 0;
  saved.length = 0;
  await journal.sweep();
  assert.strictEqual(convs.get('g').journaledUpTo, 2);
  assert.deepStrictEqual(calls, []);
  const after = reads.length;
  clock += MIN;
  await journal.sweep();
  assert.strictEqual(reads.length, after, 'not read again');
  assert.deepStrictEqual(saved, ['g']);
});
