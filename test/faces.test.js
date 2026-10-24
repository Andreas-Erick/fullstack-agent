// The faces are shared by the desktop and the phone client. The phone gets them from the companion
// server's STATIC list, so their imports must stay inside what it serves (no state.js, util.js, …:
// app state reaches the faces only through faces/env.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');
const codemap = require('../main/codemap');

// The files main/companion.js serves under /js/ (read from its STATIC table).
function servedFaceFiles() {
  const text = fs.readFileSync(path.join(ROOT, 'main/companion.js'), 'utf8');
  return [...text.matchAll(/'\/js\/[\w/.-]+':\s*'(renderer\/js\/[\w/.-]+)'/g)].map((m) => m[1]);
}

test('the phone is served every built-in face and its helpers', () => {
  const served = servedFaceFiles();
  for (const f of ['renderer/js/visualizer.js', 'renderer/js/faces/radial.js', 'renderer/js/faces/rain.js', 'renderer/js/faces/neural.js', 'renderer/js/faces/companion.js', 'renderer/js/faces/env.js', 'renderer/js/faces/common.js', 'renderer/js/themecore.js']) {
    assert.ok(served.includes(f), `${f} is not served to the phone`);
  }
  // Every face in the desktop gallery has a module on the phone.
  const host = fs.readFileSync(path.join(ROOT, 'renderer/js/faces/host.js'), 'utf8');
  const ids = [...host.matchAll(/\{ id: '(\w+)', title:/g)].map((m) => m[1]);
  const phone = fs.readFileSync(path.join(ROOT, 'renderer/remote/app.js'), 'utf8');
  for (const id of ids) assert.match(phone, new RegExp(`\\b${id}: \\['\\./js/`), `the phone has no module for the "${id}" face`);
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
