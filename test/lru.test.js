// The vault note cache's size budget (main/lru.js, audit #8).
const test = require('node:test');
const assert = require('node:assert');
const { SizedLru } = require('../main/lru');

const note = (n) => ({ mtime: 1, text: 'x'.repeat(n) });

test('the least recently used entries go first once over budget', () => {
  const c = new SizedLru(100);
  c.set('a', note(20)).set('b', note(20)).set('c', note(20));
  c.get('a'); // a is now the most recent
  c.set('d', note(20)).set('e', note(20)).set('f', note(20));
  assert.ok(c.size <= 100);
  assert.strictEqual(c.get('b'), undefined);
  assert.ok(c.get('a'));
  assert.ok(c.get('f'));
});

test('replacing and deleting keep the size right', () => {
  const c = new SizedLru(100);
  c.set('a', note(10)).set('a', note(15));
  assert.strictEqual(c.size, 15);
  c.delete('a');
  assert.strictEqual(c.size, 0);
  assert.strictEqual(c.delete('missing'), false);
});

test('one huge entry is not cached at all', () => {
  const c = new SizedLru(100);
  c.set('small', note(10)).set('huge', note(80));
  assert.strictEqual(c.get('huge'), undefined);
  assert.ok(c.get('small'));
});
