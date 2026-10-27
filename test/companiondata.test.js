// What paired devices see beyond chat (main/companiondata.js): trimmed copies, notes only inside the
// vault, habits only checked off for today or yesterday.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

const reads = [];
const logs = [];
stub({
  './logger': quietLog,
  './store': { getSettings: async () => ({ calendar: { enabled: false } }) },
  './obsidian': {
    ymd: () => '2026-10-26',
    readNote: async (p) => (reads.push(p), { path: p, fullPath: `C:/vault/${p}`, title: 'T', modified: 1, tags: ['x'], content: 'x'.repeat(10) }),
    readPriorities: async () => '---\nupdated: x\n---\n# Priorities\n- Ship 2.0',
  },
  './habits': {
    status: async () => ({ habits: [{ name: 'Run', frequency: 'daily', target: 7, paused: false, doneToday: true, streak: 4, streakUnit: 'days', thisWeek: 3, last7: [true], rate28: 0.5, note: 'private' }] }),
    log: async (names, opt) => (logs.push([names, opt]), { habits: [] }),
  },
  './learning': { deckSummaries: async () => [], topics: async () => [] },
  './handoff': { read: async () => null },
  './memory': {
    list: async () => [{ id: 'm1', title: 'A', content: 'y'.repeat(5000), category: 'fact', updated: 1, file: 'C:/secret/path.md' }],
    search: async () => [],
  },
  './archmap': {
    get: async () => ({
      version: 1,
      nodes: [
        { id: 'c:main', level: 'container', kind: 'system', name: 'Main', tech: 'Node', about: 'a'.repeat(900), tone: 'c1', row: 1, anchor: true, parent: null, x: 0, y: 0, w: 10, h: 10, head: 90, isNew: true, order: 0 },
        { id: 'f:main/x.js', level: 'file', kind: 'file', name: 'x.js', path: 'main/x.js', parent: 'c:main', x: 1, y: 1, w: 3, h: 3, lines: 5, tone: 'c1', symbols: Array.from({ length: 150 }, (_, i) => ({ kind: 'function', name: `f${i}`, line: i, detail: 'd'.repeat(200), extra: 'no' })) },
      ],
      edges: [{ from: 'f:main/x.js', to: 'c:main', kind: 'call', count: 1, labels: [] }],
      bounds: { x: 0, y: 0, w: 10, h: 10 },
      stats: { containers: 1, components: 0, files: 1, lines: 5, connections: 1, undescribed: [] },
      principles: [{ id: 'p', title: 'T', idea: 'i', why: 'w', apply: 'a', where: ['c:main'] }],
      sizes: { fileHead: 84, symRow: 19, maxRows: 16 },
      builtAt: 123,
      fingerprint: 'secret-ish',
      changes: { added: ['f:main/x.js'], removed: [] },
      stale: true,
    }),
  },
});
const data = load('main/companiondata.js');

test('the architecture map: the drawn fields only, symbol lists and texts cut short', async () => {
  const m = await data.arch();
  assert.deepStrictEqual(Object.keys(m).sort(), ['bounds', 'builtAt', 'edges', 'nodes', 'principles', 'sizes', 'stale', 'stats']);
  const file = m.nodes.find((n) => n.id === 'f:main/x.js');
  assert.strictEqual(file.symbols.length, 60);
  assert.deepStrictEqual(Object.keys(file.symbols[0]).sort(), ['detail', 'exported', 'kind', 'line', 'name']);
  assert.ok(file.symbols[0].detail.length <= 61);
  const main = m.nodes.find((n) => n.id === 'c:main');
  assert.ok(main.about.length <= 401 && main.head === 90 && main.isNew === undefined && main.order === undefined);
  assert.strictEqual(m.stale, true);
  assert.strictEqual(m.fingerprint, undefined);
});

test('notes: vault paths only; the full path on disk never leaves', async () => {
  for (const bad of ['../outside.md', '/etc/passwd', 'a/../../b.md', '.obsidian/app.json', 'C:\\x.md', '']) {
    await assert.rejects(data.note(bad), { status: 400 }, bad);
  }
  const n = await data.note('Notes/Ideas.md');
  assert.deepStrictEqual(Object.keys(n).sort(), ['content', 'modified', 'path', 'title']);
  assert.deepStrictEqual(reads, ['Notes/Ideas.md']);
});

test('habits: a name is required; only today or yesterday', async () => {
  await assert.rejects(data.logHabit('  ', true), { status: 400 });
  await data.logHabit('Run', true, '2020-01-01');
  assert.deepStrictEqual(logs.pop(), [['Run'], { done: true, date: 'today' }]);
  await data.logHabit('Run', false, 'yesterday');
  assert.deepStrictEqual(logs.pop(), [['Run'], { done: false, date: 'yesterday' }]);
});

test('trimmed copies: no private fields, long texts clipped', async () => {
  const { habits } = await data.habits();
  assert.strictEqual(habits[0].note, undefined, 'a habit’s private note stays on the computer');
  const { memories } = await data.memories();
  assert.strictEqual(memories[0].file, undefined);
  assert.ok(memories[0].content.length <= 2001);
  const t = await data.today();
  assert.strictEqual(t.priorities, '# Priorities\n- Ship 2.0', 'frontmatter removed');
});
