// The Inner World's island layout (renderer/js/world/map.js, pure): every place gets ground on the
// island, places don't overlap, roads reach everyone, the river falls off the edge, trees stay off the
// roads and out of the buildings, and the same places always give the same island.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');
const core = require('../main/worldcore');

let M;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-worldmap-'), 'map.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/world/map.js'), copy);
  M = await import(pathToFileURL(copy).href);
});

const places = () => core.PLACES.map((p) => ({ id: p.id, x: p.x, y: p.y }));

test('every place stands on the island, apart from the others', () => {
  const map = M.buildMap(places());
  const sites = Object.values(map.sites);
  assert.strictEqual(sites.length, core.PLACES.length);
  for (const s of sites) {
    for (const [x, y] of [[s.gx - s.a, s.gy - s.b], [s.gx + s.a, s.gy + s.b], [s.gx + s.a, s.gy - s.b], [s.gx - s.a, s.gy + s.b]]) {
      assert.ok(map.tile(Math.round(x), Math.round(y)) > 0, `${s.id} corner on land`);
    }
  }
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const a = sites[i];
      const b = sites[j];
      const apart = Math.abs(a.gx - b.gx) >= a.a + b.a || Math.abs(a.gy - b.gy) >= a.b + b.b;
      assert.ok(apart, `${a.id} and ${b.id} overlap`);
    }
  }
  assert.strictEqual(map.sites.observatory.h, 2, 'the Observatory is on its hill');
  assert.strictEqual(map.sites.lookout.h, 3, 'the Lookout is on its rock');
});

test('roads reach every place and walks follow them', () => {
  const map = M.buildMap(places());
  assert.strictEqual(map.edges.length, core.PLACES.length - 1, 'a spanning tree');
  for (const p of core.PLACES) {
    if (p.id === 'garden') continue;
    const walk = M.route(map, 'garden', p.id);
    assert.ok(walk.length > 1, `a road to ${p.id}`);
    const end = walk[walk.length - 1];
    assert.ok(Math.hypot(end.x - map.sites[p.id].gx, end.y - map.sites[p.id].gy) < 0.01, `the walk ends at ${p.id}`);
  }
  assert.deepStrictEqual(M.route(map, 'garden', 'garden'), []);
  const half = M.along([{ x: 0, y: 0 }, { x: 10, y: 0 }], 0.5);
  assert.deepStrictEqual(half, { x: 5, y: 0 });
});

test('a river with a waterfall, trees off roads and buildings', () => {
  const map = M.buildMap(places());
  let water = 0;
  for (let y = 0; y < M.N; y++) for (let x = 0; x < M.N; x++) if (map.tile(x, y) === M.T.WATER) water++;
  assert.ok(water > 20, 'there is a river');
  assert.ok(map.fall, 'it falls off the edge');
  const edge = !map.tile(map.fall.x, map.fall.y + 1) || !map.tile(map.fall.x + 1, map.fall.y);
  assert.ok(edge, 'the waterfall is at the island edge');
  assert.ok(map.trees.length > 40, 'a forest');
  for (const t of map.trees) {
    assert.strictEqual(map.tile(Math.floor(t.gx), Math.floor(t.gy)), M.T.GRASS, 'trees grow on grass');
    for (const s of Object.values(map.sites)) assert.ok(!(Math.abs(t.gx - s.gx) < s.a && Math.abs(t.gy - s.gy) < s.b), `no tree inside ${s.id}`);
  }
});

test('the same places give the same island', () => {
  const a = M.buildMap(places());
  const b = M.buildMap(places());
  assert.deepStrictEqual([...a.tiles], [...b.tiles]);
  assert.deepStrictEqual(a.trees, b.trees);
});
