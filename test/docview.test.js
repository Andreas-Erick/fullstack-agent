// The document viewer lets go (renderer/js/docview.js): one document per viewer element, disposed when the
// next one is shown; PDF pages far from view give their bitmaps back. The DOM half (listeners by AbortSignal,
// the page observer, render tasks, the pdf.js loading task) is pinned in test/renderloops.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

// Just enough DOM for docview's non-PDF path (util.js el(), the zoom buttons, the viewer's listeners).
class FakeNode {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attrs: {}, style: {}, dataset: {}, listeners: [], scrollTop: 0, scrollHeight: 0 });
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener(type, fn, opts) {
    this.listeners.push({ type, fn, opts });
  }
  append(...nodes) {
    this.children.push(...nodes);
  }
  prepend(...nodes) {
    this.children.unshift(...nodes);
  }
  set className(v) {
    this.attrs.class = v;
  }
  set innerHTML(v) {
    this.children = [];
    this.html = v;
  }
}

let d;
test.before(async () => {
  const dir = tmpDir('nexus-docview-');
  for (const f of ['docview.js', 'util.js', 'mathtext.js', 'livedoc.js', 'chartcore.mjs']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  globalThis.window = {}; // util.js reads window.nexus when it loads
  globalThis.Node = FakeNode;
  globalThis.document = { createElement: (t) => new FakeNode(t), createTextNode: (t) => Object.assign(new FakeNode('#text'), { text: t }) };
  d = await import(pathToFileURL(path.join(dir, 'docview.js')).href);
});

test.after(() => {
  delete globalThis.window;
  delete globalThis.Node;
  delete globalThis.document;
});

const live = (viewer, type) => viewer.listeners.filter((l) => l.type === type && !l.opts?.signal?.aborted);
const shownKinds = (viewer) => viewer.children.map((stage) => stage.children[0]?.tag);

// Regression (perf-3, cleanup-1): every document added a wheel listener to the shared viewer (a Ctrl+wheel
// zoomed every old one too) and a slow document was appended under the next one.
test('the next document replaces the last: one live wheel listener, nothing of the old one left', async () => {
  const viewer = new FakeNode('div');
  await d.renderDocument({ kind: 'text', data: 'A', name: 'a.txt' }, viewer, new FakeNode('div'));
  assert.strictEqual(live(viewer, 'wheel').length, 1);
  viewer.innerHTML = ''; // what docs.js and viewer.js do before the next one
  const ctl = await d.renderDocument({ kind: 'text', data: 'B', name: 'b.txt' }, viewer, new FakeNode('div'));
  assert.ok(ctl && typeof ctl.zoomBy === 'function');
  assert.strictEqual(viewer.listeners.filter((l) => l.type === 'wheel').length, 2, 'added once each');
  assert.strictEqual(live(viewer, 'wheel').length, 1, 'the first one was removed with its document');
  d.disposeDocument(viewer);
  assert.strictEqual(live(viewer, 'wheel').length, 0, 'disposed: nothing listens');
});

test('a document still loading when the next is shown appends nothing, not even an error', async () => {
  const viewer = new FakeNode('div');
  // An HTML page waits for livedoc.js to load: the next document is shown meanwhile.
  const slow = d.renderDocument({ kind: 'html', data: '<p>slow</p>', name: 'slow.html' }, viewer, new FakeNode('div'));
  viewer.innerHTML = '';
  const fast = d.renderDocument({ kind: 'text', data: 'fast', name: 'fast.txt' }, viewer, new FakeNode('div'));
  const [a, b] = await Promise.all([slow, fast]);
  assert.strictEqual(a, null, 'the replaced one returns no controller');
  assert.ok(b);
  assert.deepStrictEqual(shownKinds(viewer), ['pre'], 'only the text document is in the viewer');
  assert.strictEqual(live(viewer, 'wheel').length, 1);
  // Shown alone, the same page appears (the check isn't what kept it out).
  const alone = new FakeNode('div');
  await d.renderDocument({ kind: 'html', data: '<p>slow</p>', name: 'slow.html' }, alone, new FakeNode('div'));
  assert.deepStrictEqual(shownKinds(alone), ['iframe']);
});

test('pageAction: draw a page coming into view, give back one that left, else nothing', () => {
  assert.strictEqual(d.pageAction(true, false), 'draw');
  assert.strictEqual(d.pageAction(false, true), 'release');
  assert.strictEqual(d.pageAction(true, true), 'none', 'already drawn');
  assert.strictEqual(d.pageAction(false, false), 'none', 'never drawn: nothing to give back');
});

test('disposeDocument: a viewer that never showed anything, or was disposed already, is fine', () => {
  const viewer = {};
  assert.doesNotThrow(() => d.disposeDocument(viewer));
  assert.doesNotThrow(() => d.disposeDocument(viewer));
});

// Seeded: a page's life (scrolled in and out at random) never draws a drawn page twice or releases one not drawn.
test('pageAction over a random scroll (seeded): draws and releases alternate', () => {
  const seed = 0x6d2b79f5;
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = 0; i < 50; i++) {
    let drawn = false;
    let last = 'release';
    for (let k = 0; k < 40; k++) {
      const act = d.pageAction(rnd() < 0.5, drawn);
      if (act === 'none') continue;
      assert.notStrictEqual(act, last, `seed ${seed} case ${i} step ${k}: ${act} twice in a row`);
      last = act;
      drawn = act === 'draw';
    }
  }
});
