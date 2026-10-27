// The architecture map's pure drawing module (renderer/js/archdraw.js), shared by the desktop view and
// the phone client: it draws the real codebase's map at every zoom level against a stand-in canvas
// without throwing, finds boxes under a point, and gives the hosts what their panels show.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir, load } = require('./helpers');
const core = require('../main/archcore');

// A 2D context where every method works and returns something usable (as test/facedraw.test.js).
function fakeContext() {
  const gradient = { addColorStop() {} };
  return new Proxy(
    {},
    {
      get: (t, k) => {
        if (k in t) return t[k];
        if (/^create\w*Gradient$|^createPattern$/.test(k)) return () => gradient;
        if (k === 'measureText') return (s) => ({ width: String(s).length * 7 });
        return () => {};
      },
      set: (t, k, v) => ((t[k] = v), true),
    },
  );
}

let A;
let map;
test.before(async () => {
  const copy = path.join(tmpDir('nexus-archdraw-'), 'archdraw.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/archdraw.js'), copy);
  globalThis.Path2D = class {};
  globalThis.performance ||= { now: () => Date.now() };
  A = await import(pathToFileURL(copy).href);
  const archmap = load('main/archmap.js');
  const { files, handlers } = archmap.scan(ROOT);
  map = core.build(files, { handlers });
  map.builtAt = Date.now();
});

test('hex colors become the r, g, b triplets the drawing uses', () => {
  assert.strictEqual(A.hexToTriplet('#00e5ff'), '0, 229, 255');
  assert.strictEqual(A.hexToTriplet(' #FFFFFF '), '255, 255, 255');
  assert.strictEqual(A.hexToTriplet('nope', '1, 2, 3'), '1, 2, 3');
});

test('the real map draws at every level without throwing, and boxes can be picked', () => {
  const scene = A.createArchScene();
  scene.setSize(1200, 800);
  scene.setAnimated(true);
  scene.load(map);
  const ctx = fakeContext();
  scene.fitAll(false);
  let r = scene.render(ctx, 1000);
  assert.strictEqual(typeof r.moving, 'boolean');
  // The whole map fits: no part sticks out of the view.
  for (const n of map.nodes.filter((x) => x.level === 'container')) {
    const b = scene.rect(n);
    assert.ok(b.x >= -1 && b.y >= -1 && b.x + b.w <= 1201 && b.y + b.h <= 801, `${n.id} on screen`);
  }
  // Dive into the main process, then one of its components, then a file: each opens up when fitted.
  const main = map.nodes.find((n) => n.id === 'c:main');
  scene.flyTo(main, false);
  scene.render(ctx, 2000);
  assert.ok(scene.isOpen(main), 'a container fitted to the screen shows its components');
  const mid = scene.pick(scene.availW() / 2, 64 + (800 - 64) / 2);
  assert.ok(mid && scene.within(mid, main), 'the middle of the screen is inside the main process');
  const comp = map.nodes.find((n) => n.id === 'k:main/brain');
  scene.flyTo(comp, false);
  scene.render(ctx, 3000);
  assert.ok(scene.isOpen(comp));
  const file = map.nodes.find((n) => n.path === 'main/llm.js');
  scene.flyTo(file, false, 60);
  scene.selected = file;
  scene.hovered = comp;
  scene.render(ctx, 4000);
  assert.deepStrictEqual(scene.focusPath().map((n) => n.id).slice(0, 2), ['c:main', 'k:main/brain']);
  // The panels' data: what a part talks to, its ancestors, its counts.
  const conn = scene.connections(file);
  assert.ok(conn.some((c) => c.peer.id === 'c:ext-llm' && c.kind === 'http'), 'llm.js reaches the model APIs');
  assert.deepStrictEqual(scene.ancestors(file).map((n) => n.id), ['c:main', 'k:main/brain']);
  assert.ok(scene.counts(main).files > 20);
  assert.ok(scene.metaOf(main).includes('component'));
  // The minimap and a motion frame.
  scene.drawMini(fakeContext(), 200, 140, 2);
  scene.flyTo(map.bounds, true, 30);
  assert.ok(scene.moving);
  scene.render(ctx, 4100);
  scene.zoomAt(600, 400, 1.4);
  scene.setGlide({ vx: 8, vy: 0 });
  for (let t = 4200; t < 6000; t += 100) scene.render(ctx, t);
  scene.hold();
  assert.ok(!scene.moving, 'motion settles');
});

test('a rebuild keeps the selection if its part survives; hidden kinds are left out of the lines', () => {
  const scene = A.createArchScene();
  scene.setSize(800, 600);
  scene.setAnimated(false);
  scene.load(map);
  scene.selected = map.nodes.find((n) => n.id === 'c:desktop');
  scene.load({ ...map, nodes: map.nodes.filter((n) => n.id !== 'c:windows' && n.parent !== 'c:windows' && !(n.parent || '').startsWith('k:windows/')) });
  assert.strictEqual(scene.selected.id, 'c:desktop');
  scene.selected = { id: 'gone' };
  scene.load(map);
  assert.strictEqual(scene.selected, null);
  assert.ok(scene.hidden.has('test'), 'test links are hidden by default');
  scene.fitAll(false);
  scene.render(fakeContext(), 1);
  const probe = fakeContext();
  let strokes = 0;
  const counting = new Proxy(probe, { get: (t, k) => (k === 'stroke' ? () => strokes++ : t[k]) });
  scene.render(counting, 2);
  const withTests = strokes;
  scene.hidden.add('call');
  scene.hidden.add('ipc');
  scene.hidden.add('event');
  strokes = 0;
  scene.render(counting, 3);
  assert.ok(strokes < withTests, 'hiding kinds draws fewer lines');
});
