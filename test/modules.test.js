// Every main-process module loads. A mistake that only shows when a file is first required (a name used
// before it is defined, a typo in a top-level statement, a broken import) breaks the app at startup;
// here it breaks the tests instead. Electron is replaced by a stand-in that accepts anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, stub, load } = require('./helpers');

// A value that can be called, constructed, read from and turned into a string: enough for top-level code.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-modules-'));
const anything = new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => tmp : p === 'getPath' ? () => tmp : p === 'isPackaged' ? false : p === 'platform' ? process.platform : anything),
  apply: () => anything,
  construct: () => anything,
});
stub({ electron: anything });

// main.js starts the app and mcp-server.js speaks MCP on stdin as soon as it loads: not loadable here.
const SKIP = new Set(['main.js', 'mcp-server.js']);
const modules = [
  ...fs.readdirSync(path.join(ROOT, 'main')).filter((f) => f.endsWith('.js') && !SKIP.has(f)),
  ...fs.readdirSync(path.join(ROOT, 'main/tools')).map((f) => `tools/${f}`),
];

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

for (const f of modules) {
  test(`main/${f} loads`, () => {
    assert.doesNotThrow(() => load(`main/${f}`));
  });
}

test('every agent tool is well-formed', () => {
  const { TOOLS } = load('main/tools.js');
  const names = new Set();
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]{2,63}$/, t.name);
    assert.ok(!names.has(t.name), `duplicate tool ${t.name}`);
    names.add(t.name);
    assert.ok(t.description && t.description.length > 20, `${t.name} needs a description`);
    assert.strictEqual(t.parameters?.type, 'object', `${t.name} parameters`);
    assert.strictEqual(typeof t.run, 'function', `${t.name} run`);
    for (const r of t.parameters.required || []) assert.ok(t.parameters.properties?.[r], `${t.name}: required "${r}" is not a property`);
  }
});

// The everyday tools Claude Code keeps loaded (claudecode.CORE_TOOLS) all exist, and each comes with the
// tool that finds what it acts on: persona_switch without persona_list made the model call
// mcp__nexus_more__persona_switch, which doesn't exist (a wasted round).
test('core tools exist and bring the tools that find what they act on', () => {
  const names = new Set(load('main/tools.js').TOOLS.map((t) => t.name));
  const { CORE_TOOLS, COMPANIONS } = load('main/claudecode.js');
  for (const n of CORE_TOOLS) assert.ok(names.has(n), `core tool ${n} does not exist`);
  for (const [tool, finders] of Object.entries(COMPANIONS)) {
    assert.ok(CORE_TOOLS.has(tool), `${tool} is not core`);
    for (const f of finders) assert.ok(CORE_TOOLS.has(f), `${f} (for ${tool}) is not core`);
  }
  // Every core tool that switches to or runs something by name has its finder listed.
  for (const n of CORE_TOOLS) if (/_(switch|run)$/.test(n)) assert.ok(COMPANIONS[n], `${n} needs its finder in COMPANIONS`);
});
