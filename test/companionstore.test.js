// The companion server over the real store (sealed conversations on disk): the conversation index is never
// a conversation, for the store or for a paired device, and a conversation file of the wrong shape reaches a
// device as an empty conversation or a 404, never a 500.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const fx = require('./appfixture')('companionstore', { server: true });
const { dir, store, turns, untilTrue, pairDevice, post } = fx;

test('the conversation index is not a conversation: the real store refuses it and a paired device gets 404s', async () => {
  const conv = await store.createConversation('Lab notes');
  conv.messages.push({ id: 'm1', role: 'user', content: 'the titration results', createdAt: Date.now() });
  await store.saveConversation(conv);
  const indexFile = path.join(dir, 'conversations', 'index.json');
  await untilTrue(() => fs.existsSync(indexFile)); // the index is written a moment after the save
  const indexBefore = fs.readFileSync(indexFile, 'utf8');

  for (const id of ['index', 'INDEX', 'Index']) {
    await assert.rejects(store.getConversation(id), /Invalid conversation id/, `getConversation(${id})`);
    await assert.rejects(store.saveConversation({ id, title: 'x', messages: [] }), /Invalid conversation id/, `saveConversation(${id})`);
  }
  assert.strictEqual(fs.readFileSync(indexFile, 'utf8'), indexBefore, 'nothing wrote over the index');

  const auth = await pairDevice('Index phone');
  for (const id of ['index', 'INDEX', 'Index']) {
    const r = await fetch(`${fx.base}/api/conversations/${id}`, { headers: auth });
    assert.strictEqual(r.status, 404, `GET /api/conversations/${id}`);
    assert.doesNotMatch(await r.text(), /Lab notes|items|version/, 'nothing of the index comes back');
  }
  const before = turns.length;
  for (const id of ['index', 'INDEX', 'Index']) assert.strictEqual((await post('/api/chat', { text: 'hi', conversationId: id }, auth)).status, 404, `POST /api/chat in ${id}`);
  assert.strictEqual(turns.length, before, 'no turn started');

  // The same routes with a real conversation: the store and the server work together.
  const list = await (await fetch(`${fx.base}/api/conversations`, { headers: auth })).json();
  assert.ok(list.some((c) => c.id === conv.id && c.title === 'Lab notes'));
  assert.ok(!list.some((c) => /^index$/i.test(c.id)));
  const got = await (await fetch(`${fx.base}/api/conversations/${conv.id}`, { headers: auth })).json();
  assert.strictEqual(got.messages[0].content, 'the titration results', 'a sealed conversation reaches the device readable');
  assert.ok(!fs.readFileSync(path.join(dir, 'conversations', `${conv.id}.json`), 'utf8').includes('titration'), 'and is sealed on disk');
  assert.strictEqual((await post('/api/chat', { text: 'and the next step?', conversationId: conv.id }, auth)).status, 200);
  assert.strictEqual(turns.at(-1).conversationId, conv.id);
});

test('a conversation file of the wrong shape reaches a device as an empty conversation, never a 500', async () => {
  const auth = await pairDevice('Shape phone');
  const convDir = path.join(dir, 'conversations');
  const files = {
    cshape1: { id: 'cshape1', title: 'Hand-edited', updatedAt: 1, messages: { 0: 'not a list' } },
    cshape2: { id: 'cshape2', title: 'Holes', updatedAt: 1, messages: [null, 'text', 7, { id: 'm', role: 'user', content: 'kept' }] },
    cshape3: ['not', 'an', 'object'],
  };
  for (const [id, v] of Object.entries(files)) fs.writeFileSync(path.join(convDir, `${id}.json`), JSON.stringify(v));
  let r = await fetch(`${fx.base}/api/conversations/cshape1`, { headers: auth });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await r.json()).messages, []);
  r = await fetch(`${fx.base}/api/conversations/cshape2`, { headers: auth });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await r.json()).messages.map((m) => m.content), ['kept']);
  assert.strictEqual((await fetch(`${fx.base}/api/conversations/cshape3`, { headers: auth })).status, 404, 'not a conversation at all');
  assert.strictEqual((await post('/api/chat', { text: 'hi', conversationId: 'cshape3' }, auth)).status, 404);
});
