// The Documents view shows the document asked for last (renderer/js/docs.js): docs:load reads the whole file
// (and runs a Word file through mammoth) before it answers, so an earlier, slower load can finish after a
// later one. docs.js runs here with stand-ins for util.js, nav.js and docview.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const seen = { rendered: [], views: [], errors: [], on: {} };
const loads = new Map(); // path -> { promise, resolve, reject }
let picked = null;
globalThis.__docs = {
  seen,
  api: {
    docs: {
      load: (p) => loads.get(p).promise,
      pick: () => picked.promise,
      recent: async () => [],
      clearRecent: async () => {},
    },
  },
};

let docs;
let util;
test.before(async () => {
  const dir = tmpDir('nexus-docs-');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/docs.js'), path.join(dir, 'docs.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(
    path.join(dir, 'util.js'),
    `const node = () => ({ disabled: false, innerHTML: '', children: [], isConnected: true, offsetHeight: 0, style: { setProperty() {} }, remove() {}, append(...n) { this.children.push(...n); } });
const nodes = new Map();
export const $ = (sel) => (nodes.has(sel) || nodes.set(sel, node()), nodes.get(sel));
export const api = globalThis.__docs.api;
export const el = () => node();
export const toast = () => {};
export const toastError = (e) => globalThis.__docs.seen.errors.push(String(e?.message || e));
export const timeAgo = () => '';
export const on = (ev, fn) => (globalThis.__docs.seen.on[ev] = fn);
export const confirmDialog = async () => true;
export const plainError = (e) => String(e?.message || e);
`,
  );
  fs.writeFileSync(path.join(dir, 'nav.js'), 'export const switchView = (v) => globalThis.__docs.seen.views.push(v);\n');
  fs.writeFileSync(path.join(dir, 'docview.js'), 'export async function renderDocument(doc) { globalThis.__docs.seen.rendered.push(doc.name); return null; }\n');
  docs = await import(pathToFileURL(path.join(dir, 'docs.js')).href);
  util = await import(pathToFileURL(path.join(dir, 'util.js')).href); // the same module docs.js imported
  docs.initDocs();
});
test.after(() => delete globalThis.__docs);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}
const asked = (...names) => {
  for (const n of names) loads.set(n, deferred());
};
const doc = (name) => ({ name, path: `C:/docs/${name}`, kind: 'text', data: name });
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
function reset() {
  seen.rendered.length = 0;
  seen.views.length = 0;
  seen.errors.length = 0;
  loads.clear();
}

test('a slow load that finishes after a later one never replaces it', async () => {
  reset();
  asked('slow.pdf', 'fast.md');
  const a = docs.openDocument('slow.pdf');
  const b = docs.openDocument('fast.md');
  loads.get('fast.md').resolve(doc('fast.md'));
  await b;
  loads.get('slow.pdf').resolve(doc('slow.pdf'));
  await a;
  await settle();
  assert.deepStrictEqual(seen.rendered, ['fast.md']);
  assert.deepStrictEqual(seen.views, ['docs'], 'the stale one doesn’t switch the view either');
});

test('answered in the order asked: the last one shows', async () => {
  reset();
  asked('one.md', 'two.md');
  const a = docs.openDocument('one.md');
  const b = docs.openDocument('two.md');
  loads.get('one.md').resolve(doc('one.md'));
  loads.get('two.md').resolve(doc('two.md'));
  await Promise.all([a, b]);
  await settle();
  assert.deepStrictEqual(seen.rendered, ['two.md'], 'the first had been asked over before it answered');
});

test('a stale load that fails says nothing; the latest one’s failure is shown', async () => {
  reset();
  asked('gone.docx', 'here.md');
  const a = docs.openDocument('gone.docx');
  const b = docs.openDocument('here.md');
  loads.get('here.md').resolve(doc('here.md'));
  loads.get('gone.docx').reject(new Error('ENOENT gone.docx'));
  await Promise.all([a, b]);
  assert.deepStrictEqual(seen.errors, []);
  assert.deepStrictEqual(seen.rendered, ['here.md']);
  asked('broken.pdf');
  const c = docs.openDocument('broken.pdf');
  loads.get('broken.pdf').reject(new Error('not a PDF'));
  await c;
  assert.deepStrictEqual(seen.errors, ['not a PDF']);
});

test('a file picked while a load runs wins over that load; the agent’s open_document after it shows', async () => {
  reset();
  asked('agent.pdf');
  const a = docs.openDocument('agent.pdf');
  picked = deferred();
  const click = util.$('#docOpen').onclick();
  picked.resolve(doc('picked.txt'));
  await click;
  loads.get('agent.pdf').resolve(doc('agent.pdf'));
  await a;
  await settle();
  assert.deepStrictEqual(seen.rendered, ['picked.txt']);
  asked('later.md');
  seen.on['open-document']('later.md');
  loads.get('later.md').resolve(doc('later.md'));
  await settle();
  assert.deepStrictEqual(seen.rendered, ['picked.txt', 'later.md']);
});
