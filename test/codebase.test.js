// The agent's code tools (main/codebase.js, selfchange.diff) on this codebase itself (read-only).
const test = require('node:test');
const assert = require('node:assert');
const { ROOT, stub, load, quietLog } = require('./helpers');

stub({
  electron: { app: { getAppPath: () => ROOT, getPath: () => ROOT } },
  './store': { getSettings: async () => ({ code: { rootPath: ROOT, allowSelfModify: true } }) },
  './logger': quietLog,
});
const codebase = load('main/codebase.js');
const selfchange = load('main/selfchange.js');

test('code_grep: exact matches with line numbers, limited by a glob', async () => {
  const r = await codebase.grep('^async function grep\\(', { glob: 'main/*.js' });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.matches[0].path, 'main/codebase.js');
  assert.match(r.matches[0].text, />\s*async function grep\(/);
  const css = await codebase.grep('closing-screen', { glob: 'renderer/**/*.css' });
  assert.ok(css.matches.every((m) => m.path.endsWith('.css')) && css.total > 0);
  const sub = await codebase.grep('handoffSlot', { glob: 'chat' });
  assert.ok(sub.matches.every((m) => m.path.includes('chat')) && sub.total > 0);
  await assert.rejects(codebase.grep('(', {}), /Invalid regular expression/);
});

test('code_outline and code_map describe the code', async () => {
  const o = await codebase.outline('main/handoff.js');
  assert.match(o.symbols, /function write/);
  assert.match(o.symbols, /function promptBlock/);
  const map = await codebase.map();
  const handoff = map.modules.find((m) => m.file === 'main/handoff.js');
  assert.ok(handoff && handoff.exports.includes('write') && handoff.about.length > 10);
  assert.ok(map.tools.engineering.includes('code_map'));
  assert.ok(map.docs.includes('docs/ENGINEERING.md'));
});

test('code_diff reports the working tree', async () => {
  const d = await selfchange.diff();
  assert.ok(Array.isArray(d.files) && Array.isArray(d.newFiles) && typeof d.patch === 'string');
});
