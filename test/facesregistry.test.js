// The built-in faces are listed once, in renderer/js/faces/registry.mjs. Every place that names them
// derives from it; this test checks the list itself and that nobody keeps a copy again.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');
const registry = require('../main/facesregistry');
const { BUILT_IN_FACES, FACE_IDS, FACE_FILES, FACE_SUPPORT, DEFAULT_FACE } = registry;

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('every registry entry is complete and its module exports its class', () => {
  assert.ok(BUILT_IN_FACES.length >= 1);
  assert.strictEqual(new Set(FACE_IDS).size, FACE_IDS.length, 'face ids are unique');
  assert.ok(FACE_IDS.includes(DEFAULT_FACE), 'the default face is built in');
  for (const f of BUILT_IN_FACES) {
    assert.match(f.id, /^\w{1,20}$/, `${f.id}: an id main/facecapture.js accepts`);
    assert.ok(f.title && f.tagline, `${f.id} has a title and a tagline`);
    assert.match(f.module, /^[\w/.-]+\.js$/, `${f.id}: a module path relative to renderer/js`);
    const file = path.join(ROOT, 'renderer/js', f.module);
    assert.ok(fs.existsSync(file), `${f.id}: ${f.module} exists`);
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`export class ${f.export}\\b`), `${f.module} exports ${f.export}`);
  }
  for (const f of FACE_SUPPORT) assert.ok(fs.existsSync(path.join(ROOT, 'renderer/js', f)), `${f} exists`);
  assert.deepStrictEqual(FACE_FILES, [...FACE_SUPPORT, ...BUILT_IN_FACES.map((f) => f.module)]);
  assert.ok(FACE_FILES.includes('faces/registry.mjs'), 'the phone is served the list itself');
});

test('main reads the same list: the tools and the companion server', () => {
  assert.deepStrictEqual(require('../main/tools/common').FACES, FACE_IDS);
  const companion = read('main/companion.js');
  assert.match(companion, /const FACES = facesRegistry\.FACE_IDS;/);
  assert.match(companion, /\.\.\.Object\.fromEntries\(facesRegistry\.FACE_FILES\.map\(\(f\) => \[`\/js\/\$\{f\}`, `renderer\/js\/\$\{f\}`\]\)\)/, 'STATIC serves every face file');
});

test("the phone's service worker caches exactly the registry's files", () => {
  const sw = read('renderer/remote/sw.js');
  const list = /const FACES = \[([^\]]*)\]/.exec(sw);
  assert.ok(list, 'sw.js keeps its FACES list');
  const cached = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...cached].sort(), FACE_FILES.map((f) => `/js/${f}`).sort(), 'renderer/remote/sw.js FACES differs from renderer/js/faces/registry.mjs FACE_FILES: update it and bump CACHE');
});

test('the desktop, the phone and the watch page derive their face lists from the registry', () => {
  const sources = {
    'renderer/js/faces/host.js': /from '\.\/registry\.mjs'/,
    'renderer/js/facecapture.js': /from '\.\/faces\/registry\.mjs'/,
    'renderer/remote/app.js': /from '\.\/js\/faces\/registry\.mjs'/,
  };
  for (const [rel, imp] of Object.entries(sources)) {
    const src = read(rel);
    assert.match(src, imp, `${rel} imports the registry`);
    // No copy of the list: no face module or face class named in the source.
    for (const f of BUILT_IN_FACES) {
      assert.ok(!src.includes(`'./${f.module}'`) && !src.includes(`'../${f.module}'`) && !src.includes(`'./js/${f.module}'`), `${rel} names ${f.module} itself`);
      assert.ok(!new RegExp(`\\b${f.export}\\b`).test(src), `${rel} names ${f.export} itself`);
    }
  }
  for (const rel of ['main/companion.js', 'main/tools/common.js']) {
    assert.ok(!/\[\s*'siren',\s*'circuit'/.test(read(rel)), `${rel} keeps its own list of face ids`);
  }
});
