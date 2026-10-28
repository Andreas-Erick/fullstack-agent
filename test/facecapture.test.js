// The watch's face loops (main/facecapture.js): the recipe that keys the cache, and the pack format.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

stub({ './store': fileStore(tmpDir('nexus-facecap-')), './logger': quietLog });
const fc = load('main/facecapture.js');

test('the recipe: face, theme and name; anything odd falls back to Siren', () => {
  const r = fc.recipe({ ui: { face: 'custom:Aurora' }, appearance: { theme: { colors: { bg: '#000000' } } }, agent: { name: 'Mira' } });
  assert.deepStrictEqual(r, { face: 'custom:Aurora', theme: { colors: { bg: '#000000' } }, name: 'Mira', scene: '' });
  assert.strictEqual(fc.recipe({ ui: { face: 'custom:../x' } }).face, 'siren');
  assert.strictEqual(fc.recipe({}).name, 'Siren');
  assert.notStrictEqual(fc.keyOf(r), fc.keyOf({ ...r, name: 'Other' }), 'a new name records again');
  const withScene = fc.recipe({ ui: { face: 'siren' }, appearance: { scene: { svg: '<svg/>', caption: 'x' } } });
  assert.strictEqual(withScene.scene, '<svg/>');
  assert.notStrictEqual(fc.keyOf(withScene), fc.keyOf({ ...withScene, scene: '' }), 'a new scene behind the face records again');
});

test('pack and unpack keep every frame, state by state', () => {
  const frames = { idle: [Buffer.from('a'), Buffer.from('bb')], speaking: [Buffer.from('ccc')] };
  const buf = fc.pack({ fps: 12, size: 240, name: 'Siren', colors: { bg: '#000000' } }, frames);
  const { header, frames: out } = fc.unpack(buf);
  assert.deepStrictEqual(header, { v: 1, fps: 12, size: 240, name: 'Siren', colors: { bg: '#000000' }, states: { idle: 2, speaking: 1 } });
  assert.deepStrictEqual(Object.fromEntries(Object.entries(out).map(([s, l]) => [s, l.map(String)])), { idle: ['a', 'bb'], speaking: ['ccc'] });
  assert.throws(() => fc.unpack(Buffer.from('nope')));
});
