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
// waits until it has focus again.
export function removeLater(node, ms) {
  const remove = () => node.remove();
  if (document.hasFocus()) setTimeout(remove, ms);
  else window.addEventListener('focus', () => setTimeout(remove, ms), { once: true });
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

export function toastError(err) {
  toast(err?.message || String(err), 'error', 6000);
}

// Generic modal: build(card, close) fills the card; resolves with whatever close() is called with.
export function modal(build) {
  const wrap = document.getElementById('modal');
  const card = document.getElementById('modalCard');
  card.innerHTML = '';
  card.className = 'modal-card glass'; // a previous modal may have widened it
  wrap.classList.remove('hidden');
  return new Promise((resolve) => {
    const close = (value) => {
      wrap.classList.add('hidden');
      wrap.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      }
    };
    document.addEventListener('keydown', onKey, true);
    wrap.onclick = (e) => e.target === wrap && close(null);
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

export function promptDialog(title, value = '') {
  return modal((card, close) => {
    const input = el('input', { class: 'input', value });
    input.addEventListener('keydown', (e) => e.key === 'Enter' && close(input.value));
    card.append(el('h3', {}, title), input, el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close(input.value) }, 'Save')));
    setTimeout(() => input.select(), 0);
  });
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
  api.log.write(level, event, data).catch(() => {});
}
