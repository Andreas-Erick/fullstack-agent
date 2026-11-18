// Dialogs and approvals (renderer/js/util.js holdFocus/modal, renderer/js/approval.js): an approval has its
// own layer above every dialog, so it never wipes a form; the top layer holds the focus and the window behind
// it is inert; closing gives the focus back; no dialog leaves an Escape listener behind; an edited form asks
// before it is discarded. Also the notices (removeLater pauses while hovered or focused), plainError, and the
// contracts in the markup and styles (the approval layer, the live region, the z-index scale).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ------------------------------------------------------------------ a small DOM stand-in
let doc = null;
class FakeNode {
  constructor() {
    this.parent = null;
  }
  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n === doc?.root;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
}
class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.text = text;
  }
}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    this.target = new EventTarget();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.classes = new Set();
    this.attrs = new Map();
    this.style = { cssText: '' };
    this.inert = false;
    this.disabled = false;
    this.classList = {
      contains: (c) => this.classes.has(c),
      add: (...c) => c.forEach((x) => this.classes.add(x)),
      remove: (...c) => c.forEach((x) => this.classes.delete(x)),
      toggle: (c, on = !this.classes.has(c)) => (on ? this.classes.add(c) : this.classes.delete(c), on),
    };
  }
  addEventListener(...a) {
    this.target.addEventListener(...a);
  }
  dispatchEvent(e) {
    const r = this.target.dispatchEvent(e);
    this[`on${e.type}`]?.(e); // a handler set as a property (saveBtn.onclick = …) runs too, as in a browser
    return r;
  }
  get dataset() {
    const out = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) out[k.slice(5).replace(/-(\w)/g, (_m, c) => c.toUpperCase())] = v;
    return out;
  }
  get firstElementChild() {
    return this.children.find((c) => c instanceof FakeEl) || null;
  }
  replaceChildren(...nodes) {
    this.innerHTML = '';
    this.append(...nodes);
  }
  matches(sel) {
    return sel === ':hover' ? false : matcher(sel)(this);
  }
  get className() {
    return [...this.classes].join(' ');
  }
  set className(v) {
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get id() {
    return this.attrs.get('id') || '';
  }
  set id(v) {
    this.attrs.set('id', String(v));
  }
  get value() {
    return this._value ?? this.attrs.get('value') ?? '';
  }
  set value(v) {
    // A textarea keeps its line breaks as \n, as a browser's does.
    this._value = this.tagName === 'TEXTAREA' ? String(v).replace(/\r\n?/g, '\n') : String(v);
  }
  set innerHTML(v) {
    for (const c of [...this.children]) c.remove();
    this.html = String(v ?? ''); // kept as the string it was (markup is never parsed here)
  }
  get textContent() {
    return this.children.map((c) => (c instanceof FakeText ? c.text : c.textContent)).join('');
  }
  set textContent(v) {
    this.innerHTML = '';
    this.append(String(v));
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
    if (k === 'disabled') this.disabled = true; // as a boolean attribute reflects
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  append(...nodes) {
    for (const n of nodes) {
      const node = n instanceof FakeNode ? n : new FakeText(String(n));
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  contains(n) {
    for (let x = n; x; x = x.parent) if (x === this) return true;
    return false;
  }
  closest(sel) {
    assert.strictEqual(sel, '[inert], .hidden', `the stand-in's closest() knows one selector, not ${sel}`);
    for (let x = this; x instanceof FakeEl; x = x.parent) if (x.inert || x.classes.has('hidden')) return x;
    return null;
  }
  *descendants() {
    for (const c of this.children) {
      if (!(c instanceof FakeEl)) continue;
      yield c;
      yield* c.descendants();
    }
  }
  querySelector(sel) {
    const match = matcher(sel);
    for (const n of this.descendants()) if (match(n)) return n;
    return null;
  }
  focus() {
    if (this.isConnected && !this.closest('[inert], .hidden')) doc.activeElement = this;
  }
  select() {} // promptDialog selects its text a moment after it opens
}

// The selectors util.js asks for, as predicates (an unknown one fails the test loudly).
const firstChild = (n) => n.parent?.children.find((c) => c instanceof FakeEl) === n;
function matcher(sel) {
  const known = {
    'h2, h3': (n) => n.tagName === 'H2' || n.tagName === 'H3',
    'input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)': (n) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName) && !n.disabled && n.getAttribute('type') !== 'hidden',
    '.modal-actions > .btn:first-child:not(.danger):not(.primary):not(:disabled)': (n) => n.classes.has('btn') && n.parent?.classes?.has('modal-actions') && firstChild(n) && !n.classes.has('danger') && !n.classes.has('primary') && !n.disabled,
  };
  if (known[sel]) return known[sel];
  if (/^[.#][\w-]+$/.test(sel)) return sel[0] === '.' ? (n) => n.classes.has(sel.slice(1)) : (n) => n.id === sel.slice(1);
  if (/^[a-z0-9]+$/.test(sel)) return (n) => n.tagName === sel.toUpperCase();
  throw new Error(`the stand-in doesn't know the selector ${sel}`);
}

const node = (tag, { id, cls, parent } = {}) => {
  const n = new FakeEl(tag);
  if (id) n.id = id;
  if (cls) n.className = cls;
  parent?.append(n);
  return n;
};

/** The window as index.html lays it out: title bar, shell, panels, wizard, notices, the two layers. */
function makeDocument() {
  const root = new FakeEl('html');
  const body = node('body', { parent: root });
  const target = new EventTarget();
  const keydown = new Set();
  doc = {
    root,
    body,
    activeElement: body,
    focused: true,
    hasFocus: () => doc.focused,
    keydownListeners: () => keydown.size,
    createElement: (tag) => new FakeEl(tag),
    createTextNode: (text) => new FakeText(text),
    getElementById: (id) => [...root.descendants()].find((n) => n.id === id) || null,
    querySelector: (sel) => root.querySelector(sel),
    querySelectorAll: (sel) => [...root.descendants()].filter(matcher(sel)),
    addEventListener: (type, fn, opts) => (type === 'keydown' && keydown.add(fn), target.addEventListener(type, fn, opts)),
    removeEventListener: (type, fn, opts) => (keydown.delete(fn), target.removeEventListener(type, fn, opts)),
    dispatchEvent: (e) => target.dispatchEvent(e),
  };
  const n = {
    titlebar: node('header', { cls: 'titlebar', parent: body }),
    sysPanel: node('div', { id: 'sysPanel', cls: 'sys-panel hidden', parent: body }),
    shell: node('div', { cls: 'shell', parent: body }),
    onboarding: node('div', { id: 'onboarding', cls: 'onboarding hidden', parent: body }),
    toasts: node('div', { id: 'toasts', cls: 'toasts', parent: body }),
    modal: node('div', { id: 'modal', cls: 'modal hidden', parent: body }),
    approvalModal: node('div', { id: 'approvalModal', cls: 'modal approval-layer hidden', parent: body }),
  };
  n.modalCard = node('div', { id: 'modalCard', cls: 'modal-card glass', parent: n.modal });
  n.approvalCard = node('div', { id: 'approvalCard', cls: 'modal-card glass', parent: n.approvalModal });
  n.approvalCard.setAttribute('tabindex', '-1');
  n.shellBtn = node('button', { id: 'memAdd', cls: 'btn', parent: n.shell });
  n.composer = node('textarea', { id: 'input', parent: n.shell });
  n.toastBtn = node('button', { cls: 'btn small', parent: node('div', { cls: 'toast', parent: n.toasts }) });
  n.background = [n.titlebar, n.shell, n.sysPanel, n.onboarding, n.modal, n.approvalModal];
  globalThis.document = doc;
  return n;
}

const key = (k, extra = {}) => Object.assign(new Event('keydown', { cancelable: true }), { key: k }, extra);
const tick = () => new Promise((r) => setImmediate(r)); // microtasks (holdFocus) and promise settlements

// util.js and the modules it imports, as ES modules in a folder of their own (as speakable.test.js does),
// with the views whose editors are driven below (the Vault, Skills and Memory views). What those import
// beyond util.js is a stand-in: navigation, the chat, the document viewer, and state.js (which starts a
// timer when it loads).
const STUBS = {
  'nav.js': "export let currentView = 'knowledge';\nexport function switchView(name) {\n  currentView = name;\n}\n",
  'chat.js': 'export function send() {}\n',
  'docs.js': 'export function openDocument() {}\n',
  'state.js': "export const state = { settings: { agent: { name: 'Siren' } } };\n",
};
const API = {}; // window.nexus: each test puts the namespaces its view calls
let u;
let dir;
const view = (file) => import(pathToFileURL(path.join(dir, file)).href);
test.before(async () => {
  dir = tmpDir('nexus-dialogs-');
  const seen = new Set(Object.keys(STUBS));
  for (const [file, src] of Object.entries(STUBS)) fs.writeFileSync(path.join(dir, file), src);
  const copy = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(`renderer/js/${file}`);
    fs.writeFileSync(path.join(dir, file), src);
    for (const m of src.matchAll(/from\s+'\.\/([\w.-]+)'/g)) copy(m[1]);
  };
  for (const file of ['util.js', 'knowledge.js', 'skills.js', 'memory.js']) copy(file);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  globalThis.window = new EventTarget(); // util.js reads window.nexus when it loads; removeLater listens on it
  window.nexus = API;
  globalThis.Node = FakeNode; // el() appends nodes as they are, other values as text
  makeDocument();
  u = await import(pathToFileURL(path.join(dir, 'util.js')).href);
});

test.after(() => {
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.Node;
});

// ------------------------------------------------------------------ the layer stack
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One seeded walk of 200 steps: open a dialog (settling the one before, as modal() does), open an approval,
// close either, call a stale release again; the invariants after every step.
async function walk(seed) {
  const n = makeDocument();
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const open = { dialog: null, approval: null }; // { release, opener, card, wrap }
  const stale = [];
  const where = (step, what) => `seed ${seed}, step ${step}: ${what}`;
  // Where the user is when something opens: a button in the window, a notice's button, or wherever the
  // focus already is (a button behind a dialog is inert and doesn't take it).
  const focusSomewhere = () => pick([() => n.shellBtn.focus(), () => n.toastBtn.focus(), () => {}])();
  const show = async (kind) => {
    const [wrap, card] = kind === 'dialog' ? [n.modal, n.modalCard] : [n.approvalModal, n.approvalCard];
    // A dialog under an approval goes back to where the user was before the approval.
    const opener = kind === 'dialog' && open.approval ? open.approval.opener : doc.activeElement;
    wrap.classList.remove('hidden');
    const release = kind === 'dialog' ? u.holdFocus(wrap, card) : u.holdFocus(wrap, card, { role: 'alertdialog', initial: card });
    open[kind] = { release, opener, card, wrap };
    await tick();
  };
  const hide = (kind) => {
    const o = open[kind];
    open[kind] = null;
    o.wrap.classList.add('hidden');
    o.release();
    stale.push(o.release);
    return o;
  };
  const act = async (step) => {
    const action = pick(['dialog', 'dialog', 'approval', 'closeDialog', 'closeApproval', 'stale']);
    if (action === 'dialog') {
      if (open.dialog) hide('dialog'); // modal() settles the one before
      focusSomewhere();
      const before = doc.activeElement;
      const underApproval = Boolean(open.approval);
      await show('dialog');
      if (underApproval) assert.strictEqual(doc.activeElement, before, where(step, 'a dialog opened under an approval took its focus'));
      else assert.ok(n.modalCard.contains(doc.activeElement), where(step, 'the focus did not move into the new dialog'));
      assert.strictEqual(n.modalCard.getAttribute('role'), 'dialog', where(step, 'role'));
      assert.strictEqual(n.modalCard.getAttribute('aria-modal'), 'true', where(step, 'aria-modal'));
    } else if (action === 'approval' && !open.approval) {
      focusSomewhere();
      await show('approval');
      assert.ok(n.approvalCard.contains(doc.activeElement), where(step, 'the approval did not take the focus'));
      assert.strictEqual(n.approvalCard.getAttribute('role'), 'alertdialog', where(step, 'role'));
    } else if ((action === 'closeDialog' && open.dialog) || (action === 'closeApproval' && open.approval)) {
      const kind = action === 'closeDialog' ? 'dialog' : 'approval';
      const wasTop = u.topLayer() === open[kind].wrap;
      const before = doc.activeElement;
      const { opener } = hide(kind);
      await tick();
      const top = open.approval || open.dialog;
      if (!wasTop) assert.strictEqual(doc.activeElement, before, where(step, 'closing a layer under the top moved the focus'));
      else if (top) assert.ok(top.card.contains(doc.activeElement), where(step, `the ${top === open.approval ? 'approval' : 'dialog'} left on top doesn't hold the focus`));
      else if (opener === n.shellBtn || opener === n.toastBtn) assert.strictEqual(doc.activeElement, opener, where(step, 'the focus did not go back to the opener'));
    } else if (action === 'stale' && stale.length) {
      const snap = () => JSON.stringify([u.dialogOpen(), u.topLayer()?.id, n.background.map((b) => b.inert), doc.activeElement.id || doc.activeElement.tagName]);
      const before = snap();
      pick(stale)();
      await tick();
      assert.strictEqual(snap(), before, where(step, 'a second release changed something'));
    }
  };
  const check = (step) => {
    const any = Boolean(open.dialog || open.approval);
    assert.strictEqual(u.dialogOpen(), any, where(step, 'dialogOpen()'));
    if (open.approval) {
      assert.strictEqual(u.topLayer(), n.approvalModal, where(step, 'an approval is not the top layer'));
      assert.strictEqual(n.approvalModal.inert, false, where(step, 'the approval is inert'));
      if (open.dialog) assert.strictEqual(n.modal.inert, true, where(step, 'a dialog under an approval is not inert'));
    } else if (open.dialog) {
      assert.strictEqual(u.topLayer(), n.modal, where(step, 'the dialog is not the top layer'));
      assert.strictEqual(n.modal.inert, false, where(step, 'the open dialog is inert'));
    } else assert.strictEqual(u.topLayer(), null, where(step, 'topLayer() with nothing open'));
    if (any) for (const b of [n.titlebar, n.shell, n.sysPanel, n.onboarding]) assert.strictEqual(b.inert, true, where(step, `${b.className} is not inert behind a dialog`));
    else for (const b of n.background) assert.strictEqual(b.inert, false, where(step, `${b.className} stayed inert with nothing open`));
    assert.strictEqual(n.toasts.inert, false, where(step, 'the notices became inert'));
  };
  try {
    for (let step = 0; step < 200; step++) {
      await act(step);
      check(step);
    }
  } finally {
    // Closed even after a failure: the stack lives in util.js, shared with the tests after this one.
    if (open.dialog) hide('dialog');
    if (open.approval) hide('approval');
    await tick();
  }
  assert.strictEqual(u.dialogOpen(), false, `seed ${seed}: everything closed`);
}

test('layers: an approval stays on top, the window behind is inert, the focus goes in and comes back (seeded walk)', async () => {
  for (let seed = 1; seed <= 20; seed++) await walk(seed);
});

test('a dialog is named by its heading; a card without one is not labelled by an old id', async () => {
  const n = makeDocument();
  const h = node('h3', { parent: n.modalCard });
  h.append('Delete note');
  n.modal.classList.remove('hidden');
  const release = u.holdFocus(n.modal, n.modalCard);
  await tick();
  assert.ok(h.id, 'the heading got an id');
  assert.strictEqual(n.modalCard.getAttribute('aria-labelledby'), h.id);
  assert.strictEqual(n.modalCard.tabIndex, -1, 'the card can take the focus');
  n.modal.classList.add('hidden');
  release();
  h.remove();
  n.modal.classList.remove('hidden');
  const again = u.holdFocus(n.modal, n.modalCard);
  await tick();
  assert.strictEqual(n.modalCard.getAttribute('aria-labelledby'), null);
  n.modal.classList.add('hidden');
  again();
});

// ------------------------------------------------------------------ modal()
const buttons = (card) => [...card.descendants()].filter((x) => x.tagName === 'BUTTON');
const button = (card, label) => buttons(card).find((b) => b.textContent === label);
const click = (b) => b.dispatchEvent(new Event('click'));

test('a new modal settles the open one, and no Escape listener stays behind (regression: an approval was hidden unanswered later)', async () => {
  const n = makeDocument();
  n.shellBtn.focus();
  const first = u.modal((card) => card.append(u.el('h3', {}, 'First')));
  const second = u.modal((card) => card.append(u.el('h3', {}, 'Second')));
  assert.strictEqual(await first, null, 'the first one resolved');
  assert.strictEqual(doc.keydownListeners(), 1, 'only the open modal listens');
  await tick();
  doc.dispatchEvent(key('Escape'));
  assert.strictEqual(await second, null);
  assert.strictEqual(doc.keydownListeners(), 0, 'no listener left');
  assert.ok(n.modal.classList.contains('hidden'));
  assert.strictEqual(doc.activeElement, n.shellBtn, 'the focus is back on the button that opened it');
  assert.strictEqual(u.dialogOpen(), false);
});

test('a confirm puts the focus on Cancel, never on the button that acts, and Esc gives null', async () => {
  makeDocument();
  for (const danger of [true, false]) {
    const p = u.confirmDialog('Delete note', 'Gone for good?', 'Delete', danger);
    await tick();
    assert.strictEqual(doc.activeElement.textContent, 'Cancel', `danger ${danger}`);
    doc.dispatchEvent(key('Escape'));
    assert.strictEqual(await p, null);
  }
  const prompt = u.promptDialog('Name', 'x');
  await tick();
  assert.strictEqual(doc.activeElement.tagName, 'INPUT', 'a prompt focuses its field');
  doc.dispatchEvent(key('Escape'));
  assert.strictEqual(await prompt, null);
});

test('the first focus never lands on an action: a dialog whose actions start with Delete focuses its card', async () => {
  const n = makeDocument();
  // The calendar's details: Delete, Skip this day, Edit, Close (primary). "Skip this day" acts at once.
  const p = u.modal((card, close) => {
    const btn = (cls, label) => u.el('button', { class: cls, onclick: () => close(label) }, label);
    card.append(u.el('h3', {}, 'Standup'), u.el('div', { class: 'modal-actions' }, btn('btn danger', 'Delete'), btn('btn', 'Skip this day'), btn('btn', 'Edit'), btn('btn primary', 'Close')));
  });
  await tick();
  assert.strictEqual(doc.activeElement, n.modalCard, 'the card, not Skip this day');
  doc.dispatchEvent(key('Escape'));
  assert.strictEqual(await p, null);
  // Disabled Cancel: the card too.
  const q = u.modal((card, close) => card.append(u.el('h3', {}, 'Busy'), u.el('div', { class: 'modal-actions' }, u.el('button', { class: 'btn', disabled: true }, 'Cancel'), u.el('button', { class: 'btn primary', onclick: () => close(true) }, 'Save'))));
  await tick();
  assert.strictEqual(doc.activeElement, n.modalCard);
  doc.dispatchEvent(key('Escape'));
  assert.strictEqual(await q, null);
});

test('a dialog opened under an approval (a timer, a notice) takes the focus after it, then gives it back to where the user was', async () => {
  const n = makeDocument();
  n.composer.focus();
  n.approvalModal.classList.remove('hidden');
  const release = u.holdFocus(n.approvalModal, n.approvalCard, { role: 'alertdialog', initial: n.approvalCard });
  await tick();
  assert.strictEqual(doc.activeElement, n.approvalCard);
  const p = u.confirmDialog('Report a problem?', 'Something went wrong earlier.', 'Review', false);
  await tick();
  assert.strictEqual(doc.activeElement, n.approvalCard, 'the approval keeps the focus');
  assert.strictEqual(u.topLayer(), n.approvalModal);
  assert.ok(n.modal.inert && !n.approvalModal.inert, 'the dialog is under the approval');
  doc.dispatchEvent(key('Escape')); // the approval's own Esc is approval.js's: the dialog under it doesn't answer
  assert.strictEqual(n.modal.classList.contains('hidden'), false);
  n.approvalModal.classList.add('hidden');
  release();
  assert.strictEqual(doc.activeElement.textContent, 'Cancel', 'into the dialog, on Cancel');
  doc.dispatchEvent(key('Escape'));
  assert.strictEqual(await p, null);
  assert.strictEqual(doc.activeElement, n.composer, 'back in the message box');
  assert.ok(!n.shell.inert);
});

test('an edited form asks before Esc or the backdrop discards it; Keep editing keeps it', async () => {
  const n = makeDocument();
  let field;
  let closeIt;
  const p = u.modal((card, close) => {
    closeIt = close;
    field = u.el('textarea', {});
    card.append(u.el('h3', {}, 'New memory'), field, u.el('div', { class: 'modal-actions' }, u.el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel')));
  }, { dirty: () => field.value !== '' });
  let settled = false;
  p.then(() => (settled = true));
  await tick();
  assert.strictEqual(doc.activeElement, field);
  // Unchanged: nothing to ask. Changed: Esc asks, and the question takes the focus.
  field.value = 'Lab notes';
  doc.dispatchEvent(key('Escape'));
  await tick();
  const row = n.modalCard.querySelector('.modal-discard');
  assert.ok(row, 'the question shows');
  assert.strictEqual(doc.activeElement.textContent, 'Keep editing');
  assert.strictEqual(row.getAttribute('role'), 'alert');
  assert.strictEqual(settled, false);
  // Esc again = keep editing: the question goes, the focus goes back to the field.
  doc.dispatchEvent(key('Escape'));
  await tick();
  assert.strictEqual(n.modalCard.querySelector('.modal-discard'), null);
  assert.strictEqual(doc.activeElement, field);
  assert.strictEqual(field.value, 'Lab notes');
  // Composing text (an IME) never counts as Esc.
  doc.dispatchEvent(key('Escape', { isComposing: true }));
  assert.strictEqual(n.modalCard.querySelector('.modal-discard'), null);
  // A drag that starts in the card and ends on the backdrop is no click on it.
  n.modal.onmousedown({ target: n.modalCard });
  n.modal.onclick({ target: n.modal });
  assert.strictEqual(n.modalCard.querySelector('.modal-discard'), null, 'a drag-select out of the card did nothing');
  // A real click on the backdrop asks; Discard closes.
  n.modal.onmousedown({ target: n.modal });
  n.modal.onclick({ target: n.modal });
  const discard = button(n.modalCard, 'Discard');
  assert.ok(discard, 'a click beside the card asks too');
  click(discard);
  assert.strictEqual(await p, null);
  closeIt('late'); // a Save landing after Discard changes nothing
  assert.strictEqual(await p, null);
  assert.strictEqual(doc.keydownListeners(), 0);
});

test('Esc while an approval is over a form belongs to the approval: the form stays as it was', async () => {
  const n = makeDocument();
  let field;
  const p = u.modal((card) => {
    field = u.el('input', {});
    card.append(u.el('h3', {}, 'New memory'), field);
  }, { dirty: () => true });
  await tick();
  n.approvalModal.classList.remove('hidden');
  const release = u.holdFocus(n.approvalModal, n.approvalCard, { role: 'alertdialog', initial: n.approvalCard });
  await tick();
  assert.strictEqual(doc.activeElement, n.approvalCard);
  doc.dispatchEvent(key('Escape'));
  assert.strictEqual(n.modalCard.querySelector('.modal-discard'), null, 'the form under the approval did not answer');
  n.approvalModal.classList.add('hidden');
  release();
  await tick();
  assert.strictEqual(doc.activeElement, field, 'the focus is back in the form');
  n.modal.onmousedown({ target: n.modal });
  n.modal.onclick({ target: n.modal });
  click(button(n.modalCard, 'Discard'));
  assert.strictEqual(await p, null);
});

test('modal() resets the card a previous dialog widened or styled', async () => {
  const n = makeDocument();
  const a = u.modal((card) => (card.classList.add('wide', 'cal-modal'), (card.style.cssText = '--ev: 1, 2, 3')));
  await tick();
  const b = u.modal(() => {});
  assert.strictEqual(n.modalCard.className, 'modal-card glass');
  assert.strictEqual(n.modalCard.style.cssText, '');
  assert.strictEqual(await a, null);
  doc.dispatchEvent(key('Escape'));
  assert.strictEqual(await b, null);
});

// ------------------------------------------------------------------ notices
function notice() {
  const n = new EventTarget();
  n.removed = 0;
  n.hover = false;
  n.inside = new Set();
  n.remove = () => n.removed++;
  n.contains = (x) => x === n || n.inside.has(x);
  n.matches = (s) => s === ':hover' && n.hover;
  return n;
}
const fire = (n, type, extra = {}) => n.dispatchEvent(Object.assign(new Event(type), extra));

test('a notice goes after its time, but not while the pointer or the focus is on it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  makeDocument();
  const a = notice();
  u.removeLater(a, 1000);
  t.mock.timers.tick(999);
  assert.strictEqual(a.removed, 0);
  t.mock.timers.tick(1);
  assert.strictEqual(a.removed, 1, 'removed after its time');

  const b = notice();
  u.removeLater(b, 1000);
  t.mock.timers.tick(500);
  b.hover = true;
  fire(b, 'mouseenter');
  t.mock.timers.tick(10000);
  assert.strictEqual(b.removed, 0, 'kept while hovered');
  b.hover = false;
  fire(b, 'mouseleave');
  t.mock.timers.tick(999);
  assert.strictEqual(b.removed, 0, 'the full time again after the pointer left');
  t.mock.timers.tick(1);
  assert.strictEqual(b.removed, 1);

  const c = notice();
  const btn = {};
  c.inside.add(btn);
  u.removeLater(c, 1000);
  fire(c, 'focusin');
  doc.activeElement = btn;
  t.mock.timers.tick(5000);
  assert.strictEqual(c.removed, 0, 'kept while a button in it has the focus');
  fire(c, 'mouseleave'); // the pointer passing over it doesn't restart it while the focus is inside
  fire(c, 'focusout', { relatedTarget: btn }); // nor does the focus moving inside it
  t.mock.timers.tick(5000);
  assert.strictEqual(c.removed, 0);
  doc.activeElement = doc.body;
  fire(c, 'focusout', { relatedTarget: null });
  t.mock.timers.tick(1000);
  assert.strictEqual(c.removed, 1, 'removed once the focus left it');
});

test('a notice that came while the window was in the background waits for the window', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  makeDocument();
  doc.focused = false;
  const a = notice();
  u.removeLater(a, 1000);
  t.mock.timers.tick(10000);
  assert.strictEqual(a.removed, 0);
  doc.focused = true;
  window.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(1000);
  assert.strictEqual(a.removed, 1);

  // Under the pointer when the window comes back: it waits for the pointer to leave.
  doc.focused = false;
  const b = notice();
  u.removeLater(b, 1000);
  b.hover = true;
  window.dispatchEvent(new Event('focus'));
  t.mock.timers.tick(10000);
  assert.strictEqual(b.removed, 0);
  b.hover = false;
  fire(b, 'mouseleave');
  t.mock.timers.tick(1000);
  assert.strictEqual(b.removed, 1);

  doc.focused = true;
  const zero = notice();
  u.removeLater(zero, 0);
  t.mock.timers.tick(0);
  t.mock.timers.tick(1000);
  assert.strictEqual(zero.removed, 1, 'ms = 0 still removes it, once');
});

// ------------------------------------------------------------------ plainError
test('plainError: the main process prefix goes, any message comes back unchanged', () => {
  const ipc = (m) => new Error(`Error invoking remote method 'skills:save': Error: ${m}`);
  assert.strictEqual(u.plainError(ipc('There is already a skill called /review.')), 'There is already a skill called /review.');
  assert.strictEqual(u.plainError(new Error("Error invoking remote method 'memory:save': Memory content is required")), 'Memory content is required');
  for (const m of ['Plain words.', 'x'.repeat(10000), 'שלום עולם, זה עובד', 'Done 👨‍👩‍👧‍👦 together', '<script>alert(1)</script>', "Error invoking remote method 'x' is fine mid-sentence"]) {
    assert.strictEqual(u.plainError(new Error(m)), m, m.slice(0, 40));
    assert.strictEqual(u.plainError(m), m, `a string: ${m.slice(0, 40)}`);
  }
  for (const e of [undefined, null, '', {}, new Error(''), 5, ipc('')]) assert.strictEqual(u.plainError(e), 'Something went wrong.', String(e));
});

// ------------------------------------------------------------------ contracts in the source
const fnBody = (src, name) => {
  const at = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(at >= 0, `function ${name}`);
  const next = src.slice(at + 1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? src.slice(at) : src.slice(at, at + 1 + next);
};

test('approvals, secrets and recordings use their own layer and hold the focus', () => {
  const src = read('renderer/js/approval.js');
  assert.doesNotMatch(src, /getElementById\(['"]modal['"]\)|modalCard/);
  for (const name of ['show', 'showSecret', 'showRecording']) {
    const body = fnBody(src, name);
    assert.match(body, /getElementById\('approvalModal'\)/, name);
    assert.match(body, /current\.release = holdFocus\(wrap, card/, name);
  }
  assert.match(fnBody(src, 'show'), /holdFocus\(wrap, card, \{ role: 'alertdialog', initial: card \}\)/, 'an approval focuses its card, never Approve');
  const close = fnBody(src, 'close');
  assert.ok(close.indexOf('current.release?.()') < close.indexOf('current = null') && close.indexOf('current = null') < close.indexOf('waiting.shift()'), 'released before the next request in line is shown');
  assert.match(fnBody(src, 'initApprovals'), /key !== 'Escape'[\s\S]*state\.playing[\s\S]*stopImmediatePropagation/, 'Esc answers no, after the voice is silenced');
});

test('the #modal checks go through dialogOpen(); only util.js and growth.js read #modal', () => {
  const dir = path.join(ROOT, 'renderer/js');
  for (const f of fs.readdirSync(dir).filter((x) => /\.m?js$/.test(x))) {
    if (f === 'util.js' || f === 'growth.js') continue;
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /['"]#modal['"]|getElementById\(['"]modal['"]\)/, f);
  }
  for (const f of ['app.js', 'history.js', 'attach.js', 'calendar.js']) {
    const src = read(`renderer/js/${f}`);
    assert.match(src, /import \{[^}]*\bdialogOpen\b[^}]*\} from '\.\/util\.js'/, `${f} imports dialogOpen`);
    assert.match(src, /dialogOpen\(\)/, `${f} calls dialogOpen()`);
  }
});

test('the skill and memory editors pass dirty, check their fields and save before they close', () => {
  const skills = read('renderer/js/skills.js');
  for (const name of ['edit', 'run']) assert.match(fnBody(skills, name), /\{ dirty/, `skills.js ${name}`);
  const edit = fnBody(skills, 'edit');
  assert.match(edit, /api\.skills\.save\([\s\S]*close\(s\)/, 'the skill is saved inside the editor');
  assert.match(edit, /fail\(plainError\(err\)/, 'a refusal shows in the card');
  const memory = fnBody(read('renderer/js/memory.js'), 'edit');
  assert.match(memory, /\{ dirty/);
  assert.match(memory, /api\.memory\.(save|update)\([\s\S]*close\(true\)/);
  assert.match(memory, /fail\(plainError\(err\)/, 'a refusal shows in the card');
  assert.doesNotMatch(memory, /Content is required/);
  // How they behave (refusals, repeated clicks) is driven at the end of this file.
});

test('the markup: the approval layer after #modal, notices as a polite live region', () => {
  const html = read('renderer/index.html');
  const modal = html.indexOf('id="modal"');
  const approval = /<div class="modal approval-layer hidden" id="approvalModal"><div class="modal-card glass" id="approvalCard" tabindex="-1"><\/div><\/div>/.exec(html);
  assert.ok(modal > 0 && approval && approval.index > modal, 'the approval layer comes after #modal');
  for (const page of ['renderer/index.html', 'renderer/viewer.html']) {
    const toasts = /<div[^>]*id="toasts"[^>]*>/.exec(read(page))[0];
    for (const attr of ['role="status"', 'aria-live="polite"', 'aria-atomic="false"']) assert.ok(toasts.includes(attr), `${page}: ${attr}`);
  }
});

test('the top-level z-index scale: tokens in order, the layers use them', () => {
  const css = read('renderer/styles.css');
  const root = /:root \{([\s\S]*?)\n\}/.exec(css)[1];
  const z = Object.fromEntries([...root.matchAll(/--z-([a-z]+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
  const order = ['drop', 'popover', 'wizard', 'dialog', 'approval', 'toast', 'boot'];
  assert.deepStrictEqual(Object.keys(z).sort(), [...order].sort());
  for (let i = 1; i < order.length; i++) assert.ok(z[order[i - 1]] < z[order[i]], `${order[i - 1]} < ${order[i]}`);
  assert.match(css, /\.modal\.approval-layer \{ z-index: var\(--z-approval\); \}/);
  const uses = { '.drop-overlay': 'drop', '.sys-panel': 'popover', '.onboarding': 'wizard', '.modal': 'dialog', '.toasts': 'toast' };
  for (const [sel, token] of Object.entries(uses)) {
    const rule = new RegExp(`^${sel.replace('.', '\\.')} \\{([^}]*)\\}`, 'm').exec(css)?.[1];
    assert.ok(rule, sel);
    assert.match(rule, new RegExp(`z-index: var\\(--z-${token}\\)`), sel);
    assert.doesNotMatch(rule, /z-index:\s*\d/, `${sel} has no numeric z-index`);
  }
  assert.match(/^\.modal \{([^}]*)\}/m.exec(css)[1], /overflow-y: auto;[\s\S]*place-items: safe center|place-items: safe center;[\s\S]*overflow-y: auto/, 'a tall dialog scrolls');
  const hud = read('renderer/hud.css');
  assert.match(/\.hud-boot \{([^}]*)\}/.exec(hud)[1], /z-index: var\(--z-boot\)/);
});

// ------------------------------------------------------------------ the editors, as the user drives them
// The real views (knowledge.js, skills.js, memory.js) over the real util.js on the stand-in DOM, with
// window.nexus answering as the main process does. Notices wait for the window (doc.focused false), so no
// timer outlives a test; these come last, so no later test's window focus event reaches their notices.
// A zero-delay timer first: the editors focus their first field with setTimeout(…, 0), and a timer set
// later with the same delay always runs after it, while setImmediate alone may finish before it is due
// (the skill editor's focus then landed after a refusal had focused Save: a flaky failure).
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 6; i++) await tick();
};
const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject }));
  return d;
};
const ipcError = (channel, message) => new Error(`Error invoking remote method '${channel}': Error: ${message}`);
const heading = () => (u.dialogOpen() ? doc.getElementById('modalCard').querySelector('h3')?.textContent : null);
const notices = () => doc.getElementById('toasts').textContent;
const inView = (n, specs) => specs.forEach(([tag, id]) => node(tag, { id, parent: n.shell }));
const inputs = (card) => [...card.descendants()].filter((x) => x.tagName === 'INPUT');
const shownError = (card) => {
  const box = card.querySelector('.test-result');
  return box.classList.contains('hidden') ? null : box.textContent;
};

test('the Vault editor: after Discard, a cancelled New note or an unreadable note leaves it working and guarded (regression); a change elsewhere keeps the text; Save asks before overwriting a newer version', async () => {
  const n = makeDocument();
  doc.focused = false;
  inView(n, [['h2', 'kbTitle'], ['input', 'kbSearch'], ['button', 'kbNew'], ['button', 'kbObsidian'], ['button', 'kbGrowth'], ['button', 'kbFolder'], ['div', 'kbList'], ['div', 'kbNote']]);
  window.marked = { parse: (s) => s };
  window.DOMPurify = { sanitize: (h) => h, addHook() {}, removeHook() {} }; // renderMarkdown registers hooks around sanitize
  const vault = { 'Notes/Eigen.md': '# Eigen\r\nλ — שלום 👨‍👩‍👧‍👦', 'Notes/Other.md': 'other' };
  const unreadable = new Set();
  const writes = [];
  API.obsidian = {
    status: async () => ({ ok: true, path: 'vault' }),
    list: async () => Object.keys(vault).map((p) => ({ path: p, title: p.slice(6, -3), snippet: '' })),
    search: async () => [],
    links: async () => null,
    read: async (p) => {
      if (unreadable.has(p) || !(p in vault)) throw ipcError('obsidian:read', `Note "${p}" not found in the vault`);
      return { path: p, fullPath: p, title: p.slice(6, -3), tags: [], content: vault[p] };
    },
    write: async (p, text, mode) => {
      writes.push([p, text, mode]);
      vault[p] = text;
      return { path: p };
    },
  };
  const kb = await view('knowledge.js');
  kb.initKnowledge();
  await kb.refresh();
  const pane = doc.getElementById('kbNote');
  const row = (p) => [...doc.getElementById('kbList').descendants()].find((x) => x.getAttribute('data-path') === p);
  const reading = () => Boolean(button(pane, '✎ Edit'));
  const edit = async (p) => {
    click(row(p));
    await settle();
    click(button(pane, '✎ Edit'));
    return pane.querySelector('textarea');
  };

  // A CRLF note opened and left as it was isn't "edited": another note opens without asking.
  let ta = await edit('Notes/Eigen.md');
  assert.strictEqual(ta.value, '# Eigen\nλ — שלום 👨‍👩‍👧‍👦');
  click(row('Notes/Other.md'));
  await settle();
  assert.strictEqual(u.dialogOpen(), false, 'nothing to ask');
  assert.ok(!ta.isConnected && reading(), 'the other note shows');

  // Typed, then New note: asked; Discard, then the path prompt cancelled. The editor stays, still guarded
  // (another note asks again) and its Save writes, once for ten clicks (regression: Save did nothing).
  ta = await edit('Notes/Eigen.md');
  ta.value = 'my words';
  click(doc.getElementById('kbNew'));
  await settle();
  assert.strictEqual(heading(), 'Discard your changes?');
  click(button(n.modalCard, 'Discard'));
  await settle();
  assert.strictEqual(heading(), 'New note (path inside the vault)');
  doc.dispatchEvent(key('Escape'));
  await settle();
  assert.strictEqual(u.dialogOpen(), false);
  assert.ok(ta.isConnected, 'the editor stays');
  assert.strictEqual(ta.value, 'my words');
  click(row('Notes/Other.md'));
  await settle();
  assert.strictEqual(heading(), 'Discard your changes?', 'still guarded');
  doc.dispatchEvent(key('Escape')); // Cancel: the text stays
  await settle();
  assert.ok(ta.isConnected && ta.value === 'my words');
  for (let i = 0; i < 10; i++) click(button(pane, 'Save'));
  await settle();
  assert.deepStrictEqual(writes, [['Notes/Eigen.md', 'my words', 'overwrite']], 'ten clicks, one save');
  assert.ok(!ta.isConnected && reading(), 'saved: the note shows');

  // Typed again while the assistant writes the same note: the text stays and a notice says so.
  ta = await edit('Notes/Eigen.md');
  ta.value = 'my second words';
  vault['Notes/Eigen.md'] = 'the assistant wrote this';
  u.emit('vault-changed', 'Notes/Eigen.md');
  await settle();
  assert.ok(ta.isConnected && ta.value === 'my second words', 'never replaced under the user');
  assert.match(notices(), /This note changed elsewhere/);
  // Save asks before overwriting that newer version (Ctrl+S ten times: one question); Cancel writes nothing.
  for (let i = 0; i < 10; i++) ta.dispatchEvent(key('s', { ctrlKey: true }));
  await settle();
  assert.strictEqual(heading(), 'Overwrite the newer version?');
  click(button(n.modalCard, 'Cancel'));
  await settle();
  assert.strictEqual(writes.length, 1, 'nothing written over it');
  assert.strictEqual(vault['Notes/Eigen.md'], 'the assistant wrote this');
  assert.ok(ta.isConnected && ta.value === 'my second words');
  click(button(pane, 'Save'));
  await settle();
  click(button(n.modalCard, 'Overwrite'));
  await settle();
  assert.deepStrictEqual(writes, [['Notes/Eigen.md', 'my words', 'overwrite'], ['Notes/Eigen.md', 'my second words', 'overwrite']]);

  // Discard, then the other note can't be read (deleted meanwhile): the editor stays, guarded (regression).
  ta = await edit('Notes/Eigen.md');
  ta.value = 'third';
  unreadable.add('Notes/Other.md');
  click(row('Notes/Other.md'));
  await settle();
  click(button(n.modalCard, 'Discard'));
  await settle();
  assert.match(notices(), /not found in the vault/);
  assert.ok(ta.isConnected && ta.value === 'third', 'the editor stays');
  click(button(pane, 'Cancel'));
  await settle();
  assert.strictEqual(heading(), 'Discard your changes?', 'still guarded');
  click(button(n.modalCard, 'Discard'));
  await settle();
  assert.ok(!ta.isConnected && reading(), 'the note shows again');
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(u.dialogOpen(), false);
});

test('the skill editor: what is missing and a refusal show in the card with every field kept; ten clicks make one save; it closes once saved', async () => {
  const n = makeDocument();
  doc.focused = false;
  inView(n, [['button', 'skillNew'], ['button', 'skillFolder'], ['button', 'skillImport'], ['input', 'skillSearch'], ['div', 'skillGrid']]);
  const saves = [];
  let lists = 0;
  let answer = null;
  API.skills = { list: async () => (lists++, []), save: (skill, slug) => (saves.push([skill, slug]), answer.promise) };
  const sk = await view('skills.js');
  sk.initSkills();
  click(doc.getElementById('skillNew'));
  await settle();
  const card = n.modalCard;
  const [name, , triggers] = inputs(card);
  const steps = card.querySelector('textarea');
  const save = button(card, 'Save skill');

  // Nothing (or only spaces) where it is needed: said in the card, the focus on the field, nothing sent.
  name.value = '   ';
  click(save);
  assert.strictEqual(shownError(card), 'Give the skill a name.');
  assert.strictEqual(doc.activeElement, name);
  name.value = 'Review';
  click(save);
  assert.strictEqual(shownError(card), 'Write its steps.');
  assert.strictEqual(doc.activeElement, steps);
  assert.strictEqual(saves.length, 0);

  // Refused by the main process (a taken name): the card stays with every field, the reason in plain words.
  const text = '1. Read the diff.\n2. Say what could break — בדיקה 👨‍👩‍👧‍👦 <b>now</b>';
  steps.value = text;
  triggers.value = 'review this, , check it';
  answer = deferred();
  for (let i = 0; i < 10; i++) click(save);
  assert.strictEqual(saves.length, 1, 'ten clicks, one save');
  assert.ok(save.disabled);
  assert.strictEqual(save.textContent, 'Saving…');
  answer.reject(ipcError('skills:save', 'There is already a skill called /review.'));
  await settle();
  assert.strictEqual(u.dialogOpen(), true, 'still open');
  assert.strictEqual(shownError(card), 'There is already a skill called /review.');
  assert.deepStrictEqual([name.value, triggers.value, steps.value], ['Review', 'review this, , check it', text], 'every field kept');
  assert.ok(!save.disabled);
  assert.strictEqual(save.textContent, 'Save skill');
  assert.strictEqual(doc.activeElement, save);
  // The form has edits: Esc asks first, and Esc again keeps editing.
  doc.dispatchEvent(key('Escape'));
  assert.ok(card.querySelector('.modal-discard'));
  doc.dispatchEvent(key('Escape'));
  assert.strictEqual(card.querySelector('.modal-discard'), null);

  // Another name: saved, the list refreshed, then closed with the notice.
  name.value = 'Review twice';
  answer = deferred();
  click(save);
  const before = lists;
  answer.resolve({ slug: 'review-twice' });
  await settle();
  assert.strictEqual(u.dialogOpen(), false);
  assert.deepStrictEqual(saves[1], [{ name: 'Review twice', description: '', triggers: ['review this', 'check it'], input: '', steps: text }, undefined]);
  assert.ok(lists > before, 'the list was refreshed');
  assert.match(notices(), /Saved — run it with \/review-twice/);
});

test('the memory editor: empty content is said in the card with title and category kept; a refusal shows in plain words; it closes once saved', async () => {
  const n = makeDocument();
  doc.focused = false;
  inView(n, [['input', 'memSearch'], ['select', 'memCategory'], ['button', 'memAdd'], ['button', 'memMore'], ['div', 'memMenu'], ['button', 'streamReflect'], ['button', 'streamOpen'], ['div', 'streamPanel'], ['div', 'streamSummary'], ['ul', 'streamList'], ['div', 'memSummary'], ['div', 'memGrid']]);
  const saves = [];
  let answer = null;
  API.memory = { list: async () => [], save: (m) => (saves.push(m), answer.promise) };
  API.stream = { recent: async () => null };
  const mem = await view('memory.js');
  mem.initMemory();
  await settle();
  const add = doc.getElementById('memAdd');
  add.focus();
  click(add);
  await settle();
  const card = n.modalCard;
  const [title, category] = inputs(card);
  const content = card.querySelector('textarea');
  const save = button(card, 'Save');

  title.value = 'Lab notes';
  category.value = 'school';
  for (const empty of ['', '  \n\t ']) {
    content.value = empty;
    click(save);
    assert.strictEqual(shownError(card), 'Write what the agent should remember.', JSON.stringify(empty));
    assert.strictEqual(doc.activeElement, content);
  }
  assert.strictEqual(saves.length, 0);
  assert.deepStrictEqual([title.value, category.value], ['Lab notes', 'school'], 'title and category kept');

  const text = 'The lab is on Tuesdays at 10 — מעבדה 👨‍👩‍👧‍👦 <script>alert(1)</script>';
  content.value = text;
  answer = deferred();
  for (let i = 0; i < 10; i++) click(save);
  assert.strictEqual(saves.length, 1, 'ten clicks, one save');
  answer.reject(ipcError('memory:save', 'The vault folder is not available.'));
  await settle();
  assert.strictEqual(u.dialogOpen(), true, 'still open');
  assert.strictEqual(shownError(card), 'The vault folder is not available.');
  assert.deepStrictEqual([title.value, category.value, content.value], ['Lab notes', 'school', text], 'every field kept');

  answer = deferred();
  click(save);
  answer.resolve({ id: 'm1' });
  await settle();
  assert.strictEqual(u.dialogOpen(), false);
  assert.deepStrictEqual(saves[1], { title: 'Lab notes', category: 'school', content: text });
  assert.strictEqual(doc.activeElement, add, 'the focus is back on the button that opened it');
});
