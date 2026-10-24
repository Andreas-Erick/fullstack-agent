// The integrity checks (scripts/verify.js, main/codemap.js): the real codebase passes, and each kind
// of cross-file mistake is caught when planted in a copy.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, tmpDir } = require('./helpers');
const codemap = require('../main/codemap');
const { verify } = require('../scripts/verify');

test('the codebase passes its integrity checks', () => {
  const { errors } = verify(ROOT);
  assert.deepStrictEqual(errors, []);
});

test('the analyzer sees the whole app', () => {
  const ipc = codemap.ipc(ROOT);
  assert.ok(ipc.handlers.length > 50, `only ${ipc.handlers.length} IPC handlers found`);
  assert.ok(codemap.toolsInfo(ROOT).tools.length > 50);
  const defaults = codemap.settingsDefaults(ROOT);
  assert.ok(defaults && defaults.llm && defaults.remote, 'DEFAULTS not readable');
  assert.ok(codemap.hasPath(defaults, 'journal.handoffOnClose'));
});

// A copy of the parts verify() reads, to break on purpose.
function copyApp() {
  const dir = tmpDir('nexus-verify-');
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  };
  copy('preload.js');
  for (const f of codemap.jsFiles(ROOT)) if (/^(main|renderer)\//.test(f)) copy(f);
  return dir;
}

function plant(dir, rel, from, to) {
  const f = path.join(dir, rel);
  const text = fs.readFileSync(f, 'utf8');
  assert.ok(text.includes(from), `test setup: "${from}" not in ${rel}`);
  fs.writeFileSync(f, text.replace(from, to));
}

test('catches the cross-file mistakes a syntax check misses', () => {
  const dir = copyApp();
  try {
    assert.deepStrictEqual(verify(dir).errors, [], 'the untouched copy should pass');
    plant(dir, 'preload.js', "'cancelPair', ", ''); // handler without channel; renderer call breaks
    plant(dir, 'renderer/js/handoff.js', "import { api, el } from './util.js';", "import { api, el, nope } from './util.js';");
    plant(dir, 'main/handoff.js', "const log = require('./logger');", "const log = require('./logger');\nconst gone = require('./does-not-exist');");
    plant(dir, 'renderer/js/settings.js', "toggle('journal.handoffOnClose'", "toggle('journal.handoffOnClos'");
    const errors = verify(dir).errors.join('\n');
    assert.match(errors, /calls api\.remote\.cancelPair\(\) but preload\.js doesn't expose/);
    assert.match(errors, /imports "nope" from renderer\/js\/util\.js/);
    assert.match(errors, /imports "\.\/does-not-exist", which doesn't exist/);
    assert.match(errors, /binds "journal\.handoffOnClos", which has no default/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outline lists functions, exports, IPC handlers and tools', () => {
  const text = "export function a(x, y) {}\nexport const B = 1;\nconst helper = async (z) => z;\nhandle('ns:go', () => 1);\nmodule.exports = { a, helper };\n";
  const names = codemap.outline(text, 'renderer/js/x.js').map((s) => `${s.kind} ${s.name}`);
  assert.ok(names.includes('export function a'));
  assert.ok(names.includes('export const B'));
  assert.ok(names.includes('function helper'));
  assert.ok(names.includes('ipc ns:go'));
});

test('exportsOf reads CommonJS and ES module exports', () => {
  assert.deepStrictEqual([...codemap.exportsOf("module.exports = { a, b: 1, async c() {} };", 'main/x.js')].sort(), ['a', 'b', 'c']);
  assert.strictEqual(codemap.exportsOf('module.exports = { ...other };', 'main/x.js'), null);
  assert.deepStrictEqual([...codemap.exportsOf('export const $ = 1;\nexport function f() {}\nexport { g as h };', 'renderer/js/x.js')].sort(), ['$', 'f', 'h']);
});
