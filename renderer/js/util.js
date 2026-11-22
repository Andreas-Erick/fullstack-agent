// Small DOM + formatting helpers shared by all views.
import { extractMath, restoreMath, speakableMath, mathSource, memoTex } from './mathtext.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const api = window.nexus;

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const markedOpts = { gfm: true, breaks: true };
const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;
// Code keeps its brackets (pandas' df[['a', 'b']], bash's [[ -f x ]]), also a fence still being streamed.
const CODE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/;

/**
 * [[note]] / [[note|text]] → a link (its data-note); code is left alone. open: the view opens it (click or
 * Enter), so it is reachable by keyboard; else it is only shown as a link (no tab stop that does nothing).
 */
export function linkWikilinks(md, { open = false } = {}) {
  const keys = open ? ' role="link" tabindex="0"' : '';
  return String(md ?? '')
    .split(CODE)
    .map((part, i) => (i % 2 ? part : part.replace(WIKILINK, (_m, target, alias) => `<a class="wikilink" data-note="${escapeHtml(target.trim())}"${keys}>${escapeHtml(alias || target)}</a>`)))
    .join('');
}

// Rendered Markdown (replies, notes, documents, release notes) is content, not part of the page: no styles,
// forms, frames, ids or page classes that could restyle, cover or take over the app's own elements (an
// approval dialog among them; a <label for> would click the app's own buttons). Formulas are typeset after
// this, by KaTeX, whose inline styles are kept.
const MD_PURIFY = {
  ADD_ATTR: ['data-note', 'target'],
  FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option', 'optgroup', 'dialog', 'template', 'iframe', 'frame', 'object', 'embed', 'link', 'meta', 'base'],
  FORBID_ATTR: ['style', 'action', 'formaction', 'form', 'for'],
  SANITIZE_NAMED_PROPS: true, // id/name get DOMPurify's "user-content-" prefix: no clobbering
};
// The only classes rendered Markdown keeps: note links and marked's code languages (the page's own, such
// as .modal or .toast, would style it as part of the app).
const MD_CLASS = /^(wikilink|language-[\w+#.-]+)$/;
// Word documents (mammoth's HTML): its bookmarks become ids, prefixed like Markdown's.
const DOC_PURIFY = { FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'dialog'], FORBID_ATTR: ['style', 'for'], SANITIZE_NAMED_PROPS: true };
const HTML_NS = 'http://www.w3.org/1999/xhtml';

// A reference inside the content follows its target's prefixed id (SANITIZE_NAMED_PROPS): a #link, and an
// inline SVG's url(#…) paint, clip, mask or marker.
const URL_REFS = new Set(['fill', 'stroke', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end']);
const fragmentHref = (name, value) => {
  if ((name === 'href' || name === 'xlink:href') && /^#(?!user-content-)/.test(value)) return `#user-content-${value.slice(1)}`;
  return URL_REFS.has(name) ? value.replace(/url\((\s*['"]?)#(?!user-content-)/g, 'url($1#user-content-') : value;
};

/** Runs fn with these DOMPurify hooks, and only then: scene.js and facecapture.js use DOMPurify too. */
function withHooks(hooks, fn) {
  const P = window.DOMPurify;
  for (const [name, hook] of Object.entries(hooks)) P.addHook(name, hook);
  try {
    return fn(P);
  } finally {
    for (const [name, hook] of Object.entries(hooks)) P.removeHook(name, hook); // DOMPurify 3.4 removes this function only
  }
}

function sanitizeMarkdown(html, items) {
  return withHooks(
    {
      // Task lists (- [ ] …) are marked's <input type=checkbox>; any other input goes. A formula in an inline
      // SVG's or MathML's text stays its source: KaTeX's HTML there would be re-parsed out of the element it
      // was sanitized in.
      uponSanitizeElement: (node, data) => {
        if (data.tagName === 'input' && String(node.getAttribute('type') || '').toLowerCase() !== 'checkbox') node.remove();
        else if (data.tagName === '#text' && node.parentNode && node.parentNode.namespaceURI !== HTML_NS) node.data = mathSource(node.data, items);
      },
      // Before DOMPurify checks the value: a formula's placeholder in an attribute becomes its source text (so
      // href="$javascript:…$" is still refused as a javascript: URL), and only text ever gets typeset formulas.
      uponSanitizeAttribute: (_node, data) => {
        if (mathSource(data.attrName, items) !== data.attrName) data.keepAttr = false;
        else if (data.attrName === 'class') {
          data.attrValue = data.attrValue.split(/\s+/).filter((c) => MD_CLASS.test(c)).join(' ');
          if (!data.attrValue) data.keepAttr = false;
        } else data.attrValue = fragmentHref(data.attrName, mathSource(data.attrValue, items));
      },
    },
    (P) => P.sanitize(html, MD_PURIFY),
  );
}

// wikilinks: true shows [[note]] links; 'open' where the view opens them (chat, Notes, the Vault).
export function renderMarkdown(text, { wikilinks = false } = {}) {
  let src = String(text ?? '');
  if (wikilinks) src = linkWikilinks(src, { open: wikilinks === 'open' });
  // Formulas are taken out before Markdown (which would eat their _ and *) and rendered by KaTeX.
  const math = window.katex ? extractMath(src) : { text: src, items: [] };
  const html = sanitizeMarkdown(window.marked.parse(math.text, markedOpts), math.items);
  return math.items.length ? restoreMath(html, math.items, renderTexMemo) : html;
}

function renderTex(tex, display) {
  try {
    return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore', trust: false, maxExpand: 1000 });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}
const renderTexMemo = memoTex(renderTex);

export function sanitizeHtml(html) {
  return withHooks({ uponSanitizeAttribute: (_node, data) => (data.attrValue = fragmentHref(data.attrName, data.attrValue)) }, (P) => P.sanitize(html, DOC_PURIFY));
}

// Plain text for speech: formulas in words, note links by their name, strip markdown, code, URLs.
export function speakable(md) {
  return speakableMath(String(md || ''))
    .replace(WIKILINK, (_m, target, alias) => (alias || target.split('/').pop().replace(/\.md$/i, '')).trim())
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/[*_~>|#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function timeAgo(ts) {
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Removes a notice `ms` after the user can see it: one that came while the window was in the background
// waits until it has focus again, and none goes while the pointer or the keyboard focus is on it.
// The last LEAVE_MS of its time it fades out (.toast.leaving in styles.css); the pointer or the focus
// arriving then brings it back.
const LEAVE_MS = 160;
export function removeLater(node, ms) {
  let timer = null;
  let fade = null;
  const hold = () => (clearTimeout(timer), clearTimeout(fade), node.classList?.remove('leaving'));
  const start = () => {
    hold();
    fade = setTimeout(() => node.classList?.add('leaving'), Math.max(0, ms - LEAVE_MS));
    timer = setTimeout(() => node.remove(), ms);
  };
  node.addEventListener('mouseenter', hold);
  node.addEventListener('focusin', hold);
  node.addEventListener('mouseleave', () => !node.contains(document.activeElement) && start());
  node.addEventListener('focusout', (e) => !node.contains(e.relatedTarget) && !node.matches(':hover') && start());
  if (document.hasFocus()) start();
  else window.addEventListener('focus', () => !node.matches(':hover') && !node.contains(document.activeElement) && start(), { once: true });
}

// Shows a notice and removes it later; at most MAX_TOASTS at once (the oldest make room), so notices
// that pile up while the user is away don't fill the window.
const MAX_TOASTS = 6;
export function pushToast(node, ms) {
  const box = document.getElementById('toasts');
  while (box.children.length >= MAX_TOASTS) box.firstElementChild.remove();
  box.append(node);
  removeLater(node, ms);
}

export function toast(message, kind = 'info', ms = 4000) {
  pushToast(el('div', { class: `toast ${kind === 'error' ? 'err' : ''}` }, message), ms);
}

// Toast with buttons, e.g. [['Reload now', fn]]. Stays until dismissed or a button is clicked.
export function toastActions(message, actions, ms = 30000) {
  const t = el('div', { class: 'toast' }, el('div', {}, message));
  const row = el('div', { class: 'toast-actions' });
  for (const [label, fn] of actions) row.append(el('button', { class: 'btn small', onclick: () => (t.remove(), fn()) }, label));
  row.append(el('button', { class: 'btn small', onclick: () => t.remove() }, 'Later'));
  t.append(row);
  pushToast(t, ms);
}

/** A notice with an Undo button for `ms`. Exactly one of `undo` (the button) and `expire` (the notice went
 *  any other way: its time, made room for, or the returned `settle()`) runs, once. */
export function undoToast(message, { undo, expire, ms = 6000 }) {
  let done = false;
  const t = el('div', { class: 'toast' }, el('div', {}, message));
  const detach = t.remove.bind(t);
  const finish = (fn) => {
    if (done) return;
    done = true;
    detach();
    fn?.();
  };
  t.append(el('div', { class: 'toast-actions' }, el('button', { class: 'btn small', type: 'button', onclick: () => finish(undo) }, 'Undo')));
  pushToast(t, ms);
  t.remove = () => finish(expire); // once shown, every way out (removeLater, MAX_TOASTS) goes through remove()
  return () => finish(expire);
}

export function toastError(err) {
  toast(err?.message || String(err), 'error', 6000);
}

// Generic modal: build(card, close) fills the card; resolves with whatever close() is called with.
// dirty(): true while the form has unsaved edits; then Esc or a click beside the card asks first.
let activeModal = null; // the open modal(): a new one settles it (null), so its Escape listener never stays behind
export function modal(build, { dirty = null } = {}) {
  activeModal?.close(null);
  const wrap = document.getElementById('modal');
  const card = document.getElementById('modalCard');
  card.innerHTML = '';
  card.className = 'modal-card glass'; // a previous modal may have widened it
  card.style.cssText = ''; // the calendar's details set inline custom properties
  wrap.classList.remove('hidden');
  return new Promise((resolve) => {
    const me = {};
    let downOnWrap = false; // a drag that starts in the card and ends on the backdrop is no click on it
    let asking = null; // { row, back }: the "Discard your changes?" question and where the focus was
    const release = holdFocus(wrap, card);
    const close = (value) => {
      if (activeModal !== me) return; // settled already (a newer modal, or Discard and Save racing)
      activeModal = null;
      wrap.classList.add('hidden');
      wrap.onclick = wrap.onmousedown = null;
      document.removeEventListener('keydown', onKey, true);
      release();
      resolve(value);
    };
    const keep = () => {
      const { row, back } = asking;
      asking = null;
      row.remove();
      (card.contains(back) ? back : card).focus({ preventScroll: true });
    };
    const ask = () => {
      const stay = el('button', { class: 'btn', onclick: keep }, 'Keep editing');
      const row = el('div', { class: 'modal-discard', role: 'alert' }, el('span', {}, 'Discard your changes?'), stay, el('button', { class: 'btn danger', onclick: () => close(null) }, 'Discard'));
      asking = { row, back: document.activeElement };
      card.append(row);
      stay.focus(); // scrolls it into view in a tall card
    };
    const dismiss = () => (dirty?.() ? (asking ? keep() : ask()) : close(null));
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.isComposing || topLayer() !== wrap) return;
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    };
    me.close = close;
    activeModal = me;
    document.addEventListener('keydown', onKey, true);
    wrap.onmousedown = (e) => (downOnWrap = e.target === wrap);
    wrap.onclick = (e) => e.target === wrap && downOnWrap && dismiss();
    build(card, close);
  });
}

export function confirmDialog(title, message, okLabel = 'Confirm', danger = true) {
  return modal((card, close) => {
    card.append(
      el('h3', {}, title),
      el('p', { class: 'muted' }, message),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel)),
    );
  });
}

/** A confirm for deleting everything of a kind, with "Export first": `exportFn()` resolves to where the copy
 *  went (null: its save dialog was cancelled). The copy is named in the card, which stays open for the
 *  decision; true only from the acting button. */
export function confirmExportFirst(title, message, okLabel, exportFn) {
  return modal((card, close) => {
    const said = el('div', { class: 'test-result hidden', role: 'status' });
    const say = (text, kind) => {
      said.className = `test-result ${kind}`;
      said.textContent = text;
    };
    const exp = el('button', {
      class: 'btn',
      type: 'button',
      onclick: async () => {
        if (exp.disabled) return;
        exp.disabled = true;
        try {
          const where = await exportFn();
          if (where) say(`A copy is in ${where}`, 'ok');
        } catch (err) {
          say(plainError(err), 'err');
        } finally {
          exp.disabled = false;
        }
      },
    }, 'Export first');
    card.append(
      el('h3', {}, title),
      el('p', { class: 'muted' }, message),
      said,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', type: 'button', onclick: () => close(false) }, 'Cancel'), exp, el('button', { class: 'btn danger', type: 'button', onclick: () => close(true) }, okLabel)),
    );
  });
}

export function promptDialog(title, value = '') {
  return modal((card, close) => {
    const input = el('input', { class: 'input', value });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && !e.isComposing && close(input.value)); // not while an IME composes
    card.append(el('h3', {}, title), input, el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close(input.value) }, 'Save')));
    setTimeout(() => input.select(), 0);
  });
}

// Layers that hold the focus (a dialog, an approval), lowest first. The top one gets the keys; the window
// behind it and any layer under it are inert. An approval (.approval-layer) stays above a dialog opened
// after it (from a notice or a timer). Releasing the top one gives the focus back to where it was.
const layers = []; // [{ layer, card, initial, rank, opener }]
const BACKGROUND = ['.titlebar', '.shell', '#sysPanel', '#onboarding', '#modal', '#approvalModal'];
const FIELD = 'input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)';
// The actions row's first button when it is neither danger nor primary: Cancel or Close. Never Approve,
// Delete, Save or another action (the calendar's details start with Delete: the card takes the focus).
const SAFE_BUTTON = '.modal-actions > .btn:first-child:not(.danger):not(.primary):not(:disabled)';
let dialogSeq = 0;
function applyInert() {
  const top = layers.at(-1)?.layer;
  for (const q of BACKGROUND) for (const n of document.querySelectorAll(q)) n.inert = Boolean(top) && n !== top && !n.contains(top);
}
function focusInto({ card, initial }) {
  (initial?.isConnected ? initial : card.querySelector(FIELD) || card.querySelector(SAFE_BUTTON) || card).focus({ preventScroll: true });
}
const usable = (n) => Boolean(n?.isConnected) && n !== document.body && !n.closest('[inert], .hidden');
export function holdFocus(layer, card, { role = 'dialog', initial = null } = {}) {
  const rank = layer.classList.contains('approval-layer') ? 1 : 0;
  const at = layers.findIndex((l) => l.rank > rank);
  // A dialog that opens under an approval (a timer, a notice) gives the focus back to where the user was
  // before the approval, not to the approval's card.
  const entry = { layer, card, initial, rank, opener: at < 0 ? document.activeElement : layers[at].opener };
  layers.splice(at < 0 ? layers.length : at, 0, entry);
  if (!card.hasAttribute('tabindex')) card.tabIndex = -1;
  card.setAttribute('role', role);
  card.setAttribute('aria-modal', 'true');
  applyInert();
  let released = false;
  queueMicrotask(() => {
    // After build() has filled the card: its heading names it, and the focus moves in, unless the builder
    // already put it there or a layer above (an approval) holds it.
    const head = card.querySelector('h2, h3');
    if (head) card.setAttribute('aria-labelledby', (head.id ||= `dlg-${++dialogSeq}`));
    else card.removeAttribute('aria-labelledby');
    if (!released && layers.at(-1) === entry && !card.contains(document.activeElement)) focusInto(entry);
  });
  return () => {
    if (released) return;
    released = true;
    const i = layers.indexOf(entry);
    const wasTop = i === layers.length - 1;
    layers.splice(i, 1);
    applyInert();
    if (!wasTop) return; // a layer under the top closed: nothing moves
    // Back to the opener, unless a layer is still open and the opener isn't in it (a notice's button):
    // then into that layer, e.g. an approval closing over a dialog opened after it.
    const next = layers.at(-1);
    if (usable(entry.opener) && (!next || next.layer.contains(entry.opener))) entry.opener.focus({ preventScroll: true });
    else if (next) focusInto(next);
  };
}
export const dialogOpen = () => layers.length > 0;
export const topLayer = () => layers.at(-1)?.layer || null;
// A refusal from the main process in plain words (inline errors in the editors).
export function plainError(e) {
  const text = typeof e === 'string' ? e : e?.message;
  return String(text || '').replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'Something went wrong.';
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Global event bus for cross-module communication.
export const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));
export const on = (type, fn) => {
  const listener = (e) => fn(e.detail);
  bus.addEventListener(type, listener);
  return () => bus.removeEventListener(type, listener);
};

// Diagnostic log line in <userData>/logs/nexus.log (read by the agent when it diagnoses itself).
export function logEvent(level, event, data) {
  api.log.write(level, event, data).catch(() => {}); // the log itself is unreachable: nowhere left to report it
}

// A failure that is safe to drop, said out loud: `p.catch(ignore('why'))` writes a DEBUG line (only with
// Detailed logging on) and yields `value` (main/ignore.js is the same for the main process).
export function ignore(reason, value) {
  return (err) => {
    logEvent('debug', 'ignored', { reason, error: String(err?.message || err).slice(0, 300) });
    return value;
  };
}

// Safety net: an unexpected error in a page is logged (the same one at most once a minute) instead of
// disappearing; the page keeps running. Logged as `{ error: { message, stack } }`, so the log reader
// (errorinsight.js) and a problem report see the message and where in the code it came from.
const seenErrors = new Map();
export function reportUiError(kind, err) {
  const message = String(err?.message || err || 'unknown error').slice(0, 300);
  const key = `${kind}:${message}`;
  if (Date.now() - (seenErrors.get(key) || 0) < 60000) return;
  if (seenErrors.size > 200) seenErrors.clear(); // a long session's distinct errors don't pile up
  seenErrors.set(key, Date.now());
  const stack = String(err?.stack || '').split('\n').slice(0, 6).join(' | ');
  logEvent('error', `ui ${kind}`, { error: stack ? { message, stack } : { message } });
}

/** Every page with the preload calls this once: uncaught errors and rejections go to the log. */
export function installErrorTrap() {
  window.addEventListener('error', (e) => reportUiError('error', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportUiError('unhandled rejection', e.reason));
}
