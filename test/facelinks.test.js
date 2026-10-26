// Short-lived links to a custom face for paired devices (main/facelinks.js).
const test = require('node:test');
const assert = require('node:assert');
const facelinks = require('../main/facelinks');

test('a link opens one face folder for ten minutes, per device', () => {
  const now = 1_000_000;
  const a = facelinks.issue('Aurora', 'd1', now);
  assert.match(a.key, /^[A-Za-z0-9_-]{32}$/);
  assert.strictEqual(facelinks.resolve(a.key, now + 1000), 'Aurora');
  assert.strictEqual(facelinks.resolve(a.key, now + facelinks.TTL_MS + 1), null, 'expires');
  const b = facelinks.issue('Aurora', 'd1', now);
  const c = facelinks.issue('Aurora', 'd1', now);
  assert.strictEqual(facelinks.resolve(b.key, now), null, 'a new link replaces the device\'s older one');
  const d = facelinks.issue('Aurora', 'd2', now);
  facelinks.revoke('d1');
  assert.strictEqual(facelinks.resolve(c.key, now), null);
  assert.strictEqual(facelinks.resolve(d.key, now), 'Aurora', 'other devices keep theirs');
  facelinks.revoke();
  assert.strictEqual(facelinks.resolve(d.key, now), null);
  assert.strictEqual(facelinks.resolve('../etc', now), null);
});

test('only plain file paths inside the folder', () => {
  assert.strictEqual(facelinks.safeRel(''), 'index.html');
  assert.strictEqual(facelinks.safeRel('img/a.png'), 'img/a.png');
  for (const bad of ['../x', 'a/../../x', '.env', 'img/.hidden', 'a\b', 'a b', 'x'.repeat(201), 'a/./b']) assert.strictEqual(facelinks.safeRel(bad), null, bad);
});
