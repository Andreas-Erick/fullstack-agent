// The watch's face loops (main/facecapture.js): the recipe that keys the cache, and the pack format.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');

const dataDir = tmpDir('nexus-facecap-');
stub({ './store': fileStore(dataDir), './logger': quietLog });
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

// Efficiency pass: the warm-up (every 2 min) and the 304 read the whole multi-MB pack to learn it existed.
test('cached(): the pack’s key and time from a stat, null until recorded', async () => {
  const fs = require('fs');
  const path = require('path');
  const s = { ui: { face: 'siren' }, agent: { name: 'Mira' } };
  assert.strictEqual(await fc.cached(s), null);
  const key = fc.keyOf(fc.recipe(s));
  const dir = path.join(dataDir, 'face-frames');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.bin`), 'SRF1');
  const hit = await fc.cached(s);
  assert.strictEqual(hit.key, key);
  assert.ok(hit.at > 0);
  assert.strictEqual(await fc.cached({ ...s, agent: { name: 'Other' } }), null, 'another recipe: not recorded');
  fs.mkdirSync(path.join(dir, `${fc.keyOf(fc.recipe({ ui: { face: 'rain' } }))}.bin`));
  assert.strictEqual(await fc.cached({ ui: { face: 'rain' } }), null, 'a folder by that name is no pack');
});

test('pack and unpack keep every frame, state by state', () => {
  const frames = { idle: [Buffer.from('a'), Buffer.from('bb')], speaking: [Buffer.from('ccc')] };
  const buf = fc.pack({ fps: 12, size: 240, name: 'Siren', colors: { bg: '#000000' } }, frames);
  const { header, frames: out } = fc.unpack(buf);
  assert.deepStrictEqual(header, { v: 1, fps: 12, size: 240, name: 'Siren', colors: { bg: '#000000' }, states: { idle: 2, speaking: 1 } });
  assert.deepStrictEqual(Object.fromEntries(Object.entries(out).map(([s, l]) => [s, l.map(String)])), { idle: ['a', 'bb'], speaking: ['ccc'] });
  assert.throws(() => fc.unpack(Buffer.from('nope')));
});

test('smooth loops: frames picked at even steps from uneven paints, the seam faded away', () => {
  // Paints at uneven times (a busy moment around 100 ms): each even 1/24 s step takes the nearest.
  const times = [0, 40, 85, 160, 170, 210, 250, 290];
  assert.deepStrictEqual(fc.evenly(times, 24, 7), [0, 1, 2, 3, 4, 5, 6], '125 ms takes 160, the nearer one');
  assert.deepStrictEqual(fc.evenly([0, 30, 200, 240], 24, 5), [0, 1, 1, 2, 2], 'a gap: each step takes whichever side is nearer');
  assert.deepStrictEqual(fc.evenly([0], 24, 3), [0, 0, 0], 'a still state holds its one frame');
  // 6 + 2 frames, one byte each: the first two fade from the frames after the end into their own.
  const f = [0, 10, 20, 30, 40, 50, 60, 70].map((v) => Buffer.from([v]));
  const loop = fc.seamless(f, 2).map((b) => b[0]);
  assert.deepStrictEqual(loop, [60, 40, 20, 30, 40, 50], 'starts as the frame after the last, ends as the loop’s own');
  assert.strictEqual(fc.seamless(f.slice(0, 3), 2).length, 1, 'too short to blend: just the loop');
  assert.ok(fc.FPS >= 24, 'fluid on the watch');
  assert.strictEqual(60 % fc.FPS, 0, 'an even cadence on a 60 Hz watch screen: every frame shown for the same number of refreshes');
  assert.notStrictEqual(fc.keyOf({ face: 'siren' }), require('crypto').createHash('sha256').update(JSON.stringify({ face: 'siren' })).digest('hex').slice(0, 24), 'packs recorded the old way are recorded again');
});
