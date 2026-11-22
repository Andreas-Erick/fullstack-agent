// The faces are shared by the desktop and the phone client. The phone gets them from the companion
// server's STATIC list, so their imports must stay inside what it serves (no state.js, util.js, …:
// app state reaches the faces only through faces/env.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');
const codemap = require('../main/codemap');

const { BUILT_IN_FACES, FACE_FILES } = require('../main/facesregistry');

// The files main/companion.js serves under /js/ (read from its STATIC table, whose face entries come from
// the face registry; test/facesregistry.test.js checks that wiring).
function servedFaceFiles() {
  const text = fs.readFileSync(path.join(ROOT, 'main/companion.js'), 'utf8');
  assert.match(text, /FACE_FILES\.map\(\(f\) => \[`\/js\/\$\{f\}`, `renderer\/js\/\$\{f\}`\]\)/, 'companion.js no longer serves the face registry\'s files');
  return [...[...text.matchAll(/'\/js\/[\w/.-]+':\s*'(renderer\/js\/[\w/.-]+)'/g)].map((m) => m[1]), ...FACE_FILES.map((f) => `renderer/js/${f}`)];
}

test('the phone is served every built-in face and its helpers', () => {
  const served = servedFaceFiles();
  for (const f of ['renderer/js/faces/env.js', 'renderer/js/faces/common.js', 'renderer/js/faces/registry.mjs', 'renderer/js/themecore.js']) {
    assert.ok(served.includes(f), `${f} is not served to the phone`);
  }
  // Every built-in face's module is served (the desktop's gallery and the phone both read the registry).
  for (const f of BUILT_IN_FACES) assert.ok(served.includes(`renderer/js/${f.module}`), `the "${f.id}" face's module is not served`);
});

test('shared face modules import only what the phone is served', () => {
  const served = new Set(servedFaceFiles());
  for (const rel of served) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const imp of codemap.importsOf(ROOT, rel, text)) {
      assert.ok(imp.target, `${rel}:${imp.line} imports a missing file ${imp.spec}`);
      assert.ok(served.has(imp.target), `${rel}:${imp.line} imports ${imp.target}, which the phone is not served (reach app state through faces/env.js instead)`);
    }
  }
});
