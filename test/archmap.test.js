// The architecture map (main/archcore.js, main/archmap.js): classification into containers and
// components, connections found in the code, the layout, rebuild diffs, and the real codebase.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, fileStore } = require('./helpers');
const core = require('../main/archcore');

const file = (p, extra = {}) => ({ path: p, lines: 10, about: '', symbols: [], imports: [], apiCalls: [], subscribes: [], pushes: false, externals: [], ...extra });
const ids = (m) => new Set(m.nodes.map((n) => n.id));
const edge = (m, from, to, kind) => m.edges.find((e) => e.from === from && e.to === to && (!kind || e.kind === kind));

test('files land in the most specific container and in their curated component', () => {
  const m = core.model([file('main/llm.js'), file('main/mcp-server.js'), file('renderer/js/chat.js'), file('renderer/js/viewer.js'), file('preload.js')]);
  const parent = (p) => m.nodes.find((n) => n.path === p).parent;
  assert.strictEqual(parent('main/llm.js'), 'k:main/brain');
  assert.strictEqual(parent('main/mcp-server.js'), 'k:mcp/mcp-server');
  assert.strictEqual(parent('renderer/js/chat.js'), 'k:desktop/ui-chat');
  assert.strictEqual(parent('renderer/js/viewer.js'), 'k:windows/viewer');
  assert.strictEqual(parent('preload.js'), 'k:preload/bridge');
});

test('a file no rule describes becomes its own component, grouped with its pure core', () => {
  const m = core.model([file('main/garden.js', { about: 'Plants in the vault.' }), file('main/gardencore.js'), file('main/llm.js')]);
  const comp = m.nodes.find((n) => n.id === 'k:main/auto-garden');
  assert.ok(comp?.auto);
  assert.strictEqual(comp.name, 'Garden');
  assert.strictEqual(comp.about, 'Plants in the vault.');
  assert.deepStrictEqual(m.nodes.filter((n) => n.parent === comp.id).map((n) => n.path).sort(), ['main/garden.js', 'main/gardencore.js']);
});

test('containers without files are dropped; people and outside systems stay', () => {
  const m = core.model([file('main/llm.js')]);
  const has = ids(m);
  assert.ok(has.has('c:main') && has.has('c:user') && has.has('c:ext-llm'));
  assert.ok(!has.has('c:android') && !has.has('c:phone') && !has.has('c:desktop'));
});

test('connections come from imports, IPC, events, detected outside systems and the curated links', () => {
  const m = core.model(
    [
      file('renderer/index.html'),
      file('renderer/js/chat.js', { imports: ['renderer/js/util.js'], apiCalls: ['chat:send', 'conv:list'], subscribes: ['chat:event'] }),
      file('renderer/js/util.js'),
      file('preload.js'),
      file('main/main.js', { pushes: true, externals: ['ext-os'] }),
      file('main/llm.js', { externals: ['ext-llm'] }),
      file('test/llm.test.js', { imports: ['main/llm.js'] }),
    ],
    { handlers: { 'chat:send': 'main/main.js', 'conv:list': 'main/main.js' } },
  );
  assert.ok(edge(m, 'f:renderer/js/chat.js', 'f:renderer/js/util.js', 'call'));
  const ipc = edge(m, 'f:renderer/js/chat.js', 'f:preload.js', 'ipc');
  assert.strictEqual(ipc.count, 2);
  assert.deepStrictEqual(ipc.labels.sort(), ['chat', 'conv']);
  assert.strictEqual(edge(m, 'f:preload.js', 'f:main/main.js', 'ipc').count, 2);
  assert.ok(edge(m, 'f:preload.js', 'f:renderer/js/chat.js', 'event'));
  assert.ok(edge(m, 'f:main/main.js', 'f:preload.js', 'event'));
  assert.ok(edge(m, 'f:main/llm.js', 'c:ext-llm', 'http'));
  assert.ok(edge(m, 'f:main/main.js', 'c:ext-os', 'process'));
  assert.ok(edge(m, 'f:test/llm.test.js', 'f:main/llm.js', 'test'));
  assert.ok(edge(m, 'c:user', 'f:renderer/index.html', 'user'));
  assert.ok(edge(m, 'f:main/main.js', 'f:renderer/index.html', 'process'));
  // A curated link whose files aren't there is left out.
  assert.ok(!m.edges.some((e) => e.to === 'f:main/bridge.js'));
});

test('facts read code, not comments; files that only name a service are not connected to it', () => {
  const f = core.facts('renderer/js/x.js', "// api.secret.call() in a comment\nconst u = 'https://example.com/a';\napi.chat.send(1); api.on('chat:event', fn);\n/* api.no.way() */");
  assert.deepStrictEqual(f.apiCalls, ['chat:send']);
  assert.deepStrictEqual(f.subscribes, ['chat:event']);
  assert.deepStrictEqual(core.facts('main/x.js', "const sdk = require('@anthropic-ai/sdk');\nwin.webContents.send('a', 1);").externals, ['ext-llm']);
  assert.ok(core.facts('main/x.js', "win.webContents.send('a', 1);").pushes);
  assert.deepStrictEqual(core.facts('main/store.js', "search: { engine: 'duckduckgo' }").externals, []);
  assert.deepStrictEqual(core.facts('main/x.js', "// we used to fetch('https://duckduckgo.com')\n").externals, []);
  assert.deepStrictEqual(core.facts('main/archcore.js', 'stream-json @anthropic-ai/sdk').externals, []);
});

test('a file describes itself with its leading comment, cut at a sentence', () => {
  assert.strictEqual(core.aboutOf('// One line.\n// Two.\nconst x = 1;'), 'One line. Two.');
  assert.strictEqual(core.aboutOf("'use strict';\n// late"), '');
  assert.strictEqual(core.aboutOf('/* Block\n   comment. */\n:root {}'), 'Block comment.');
  assert.strictEqual(core.aboutOf('<!doctype html>\n<html><head><title>Viewer</title>'), 'The page “Viewer”.');
  assert.ok(core.aboutOf(`// ${'word '.repeat(100)}`).length <= 262);
});

test('the layout keeps every box inside its parent and siblings apart', () => {
  const files = ['main/llm.js', 'main/router.js', 'main/prompt.js', 'main/tools.js', 'main/approvals.js', 'main/x1.js', 'renderer/js/chat.js', 'preload.js'].map((p, i) => file(p, { symbols: Array.from({ length: i * 3 }, (_, j) => ({ kind: 'function', name: `f${j}`, line: j })) }));
  const m = core.build(files);
  const byId = new Map(m.nodes.map((n) => [n.id, n]));
  for (const n of m.nodes) {
    assert.ok(n.w > 0 && n.h > 0, `${n.id} has a size`);
    const p = n.parent && byId.get(n.parent);
    if (p) assert.ok(n.x >= p.x && n.y >= p.y && n.x + n.w <= p.x + p.w && n.y + n.h <= p.y + p.h, `${n.id} inside ${p.id}`);
  }
  const groups = new Map();
  for (const n of m.nodes) (groups.get(n.parent) || groups.set(n.parent, []).get(n.parent)).push(n);
  for (const sib of groups.values())
    for (let i = 0; i < sib.length; i++)
      for (let j = i + 1; j < sib.length; j++) {
        const [a, b] = [sib[i], sib[j]];
        assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} and ${b.id} overlap`);
      }
  for (const n of m.nodes.filter((x) => x.level === 'container')) assert.ok(n.x >= m.bounds.x && n.x + n.w <= m.bounds.x + m.bounds.w + 1);
});

test('a rebuild reports what was added and removed', () => {
  const a = core.build([file('main/llm.js'), file('main/router.js')]);
  const b = core.build([file('main/llm.js'), file('main/garden.js')]);
  const d = core.diff(a, b);
  assert.ok(d.added.includes('f:main/garden.js') && d.added.includes('k:main/auto-garden'));
  assert.deepStrictEqual(d.removed, ['main/router.js']);
  assert.ok(core.diff(null, b).first);
});

test('the real codebase maps completely, with its key connections', () => {
  const archmap = load('main/archmap.js');
  const { files, handlers } = archmap.scan(ROOT);
  const m = core.build(files, { handlers });
  const has = ids(m);
  for (const f of fs.readdirSync(path.join(ROOT, 'main')).filter((n) => n.endsWith('.js'))) assert.ok(has.has(`f:main/${f}`), `main/${f} is on the map`);
  for (const id of ['c:desktop', 'c:preload', 'c:main', 'c:mcp', 'c:quality', 'k:windows/webpage']) assert.ok(has.has(id), id);
  assert.ok(edge(m, 'f:main/llm.js', 'c:ext-llm', 'http'));
  assert.ok(edge(m, 'f:main/claudecode.js', 'c:ext-claude', 'process'));
  assert.ok(edge(m, 'f:preload.js', 'f:main/main.js', 'ipc').count > 50);
  assert.ok(edge(m, 'f:main/mcp-server.js', 'f:main/bridge.js', 'http'));
  for (const p of m.principles) assert.ok(p.where.length, `principle "${p.id}" points at parts that exist`);
  // Curated rules must not name files that no longer exist (they'd silently stop matching).
  const onMap = new Set(files.map((f) => f.path));
  for (const k of core.COMPONENTS) for (const p of k.files) if (!p.endsWith('/') && !p.startsWith('virtual/')) assert.ok(onMap.has(p), `${k.id} lists ${p}, which doesn't exist`);
});

test('the map is cached; a changed file makes it stale until the next build', async () => {
  const dir = tmpDir('nexus-arch-');
  const root = tmpDir('nexus-arch-code-');
  try {
    fs.mkdirSync(path.join(root, 'main'));
    fs.writeFileSync(path.join(root, 'main', 'llm.js'), '// The brain.\nmodule.exports = { a };\nfunction a() {}\n');
    fs.writeFileSync(path.join(root, 'preload.js'), '// Bridge.\n');
    const store = fileStore(dir);
    stub({ './store': store });
    const archmap = load('main/archmap.js');
    const first = await archmap.get(root);
    assert.strictEqual(first.stale, false);
    assert.ok(first.nodes.some((n) => n.path === 'main/llm.js'));
    assert.ok(fs.existsSync(path.join(dir, 'archmap.json')));
    assert.strictEqual((await archmap.get(root)).stale, false);
    fs.writeFileSync(path.join(root, 'main', 'garden.js'), '// Plants.\n');
    assert.strictEqual((await archmap.get(root)).stale, true);
    const next = await archmap.build(root);
    assert.ok(next.changes.added.includes('f:main/garden.js'));
    assert.strictEqual((await archmap.get(root)).stale, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
