// Atomic text writes for vault notes (main/store.js writeTextAtomic, audit #5): the last write wins,
// concurrent writes land in call order, and no temp files are left behind.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('nexus-atomic-');
stub({ electron: { app: { getPath: () => dir }, safeStorage: { isEncryptionAvailable: () => false } }, './logger': quietLog });
const store = load('main/store.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('writes land in call order and leave no temp files', async () => {
  const file = path.join(dir, 'vault', 'Habits.md');
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.writeTextAtomic(file, `version ${i}`)));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'version 19');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['Habits.md']);
});

test('the JSON writer still works through it', async () => {
  const file = path.join(dir, 'x.json');
  await store.writeJsonAtomic(file, { a: 1 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
});
