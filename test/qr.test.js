// QR encoder (renderer/js/qr.js). It was verified against a real decoder (jsQR: every length up to
// version 20); these tests pin that output and the parts a scanner relies on, without a dependency.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

let qrMatrix;
test.before(async () => {
  // A renderer ES module in a CommonJS package: import a .mjs copy.
  const dir = tmpDir('nexus-qr-');
  const copy = path.join(dir, 'qr.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/qr.js'), copy);
  ({ qrMatrix } = await import(pathToFileURL(copy).href));
});

const hash = (m) => crypto.createHash('sha256').update(m.map((r) => r.map(Number).join('')).join('\n')).digest('hex');

test('matches the output verified with a real decoder', () => {
  const link = 'https://nexus.example.com/#pair=Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_Ab3_xyz';
  assert.strictEqual(hash(qrMatrix(link)), 'c3b71d05088d1b81fa5c7c5210a1cc4eae039490f43abf542e9f077142e71d57');
  assert.strictEqual(hash(qrMatrix('HELLO')), 'c346c75add5698735afe3f7eb4f3e6c57ccefd9563f45f65c6d76aa518fb6f91');
});

test('finder patterns, timing pattern and dark module are in place', () => {
  const m = qrMatrix('https://192.168.1.20:7823/#pair=' + 'a'.repeat(43));
  const n = m.length;
  const ring = (x0, y0) => {
    for (let i = 0; i < 7; i++) for (const [x, y] of [[x0 + i, y0], [x0 + i, y0 + 6], [x0, y0 + i], [x0 + 6, y0 + i]]) assert.ok(m[y][x], `finder at ${x0},${y0}`);
    assert.ok(m[y0 + 3][x0 + 3], 'finder center');
  };
  ring(0, 0);
  ring(n - 7, 0);
  ring(0, n - 7);
  for (let i = 8; i < n - 8; i++) assert.strictEqual(m[6][i], i % 2 === 0, 'timing');
  assert.ok(m[n - 8][8], 'dark module');
});

test('format information is valid (level M) in both copies', () => {
  const m = qrMatrix('format check');
  const n = m.length;
  let bits = 0;
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  first.forEach(([x, y], i) => (bits |= (m[y][x] ? 1 : 0) << i));
  let second = 0;
  for (let i = 0; i < 8; i++) second |= (m[8][n - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i++) second |= (m[n - 15 + i][8] ? 1 : 0) << i;
  assert.strictEqual(bits, second, 'both copies agree');
  const data = (bits ^ 0x5412) >>> 10;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  assert.strictEqual(((data << 10) | rem) ^ 0x5412, bits, 'BCH code');
  assert.strictEqual(data >>> 3, 0, 'error correction level M');
});

test('sizes and capacity', () => {
  assert.strictEqual(qrMatrix('x').length, 21);
  assert.strictEqual(qrMatrix('x'.repeat(666)).length, 97, 'version 20 holds 666 bytes at level M');
  assert.throws(() => qrMatrix('x'.repeat(667)), /Too long/);
});
