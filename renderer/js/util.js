// Small DOM + formatting helpers shared by all views.
import { extractMath, restoreMath, speakableMath } from './mathtext.js';

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
export function renderMarkdown(text, { wikilinks = false } = {}) {
  let src = String(text ?? '');
  if (wikilinks) {
    src = src.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => `<a class="wikilink" data-note="${escapeHtml(target.trim())}">${escapeHtml(alias || target)}</a>`);
  }
  // Formulas are taken out before Markdown (which would eat their _ and *) and rendered by KaTeX.
  const math = window.katex ? extractMath(src) : { text: src, items: [] };
  let html = window.marked.parse(math.text, markedOpts);
  if (math.items.length) html = restoreMath(html, math.items, renderTex);
  return window.DOMPurify.sanitize(html, { ADD_ATTR: ['data-note', 'target'] });
}

function renderTex(tex, display) {
  try {
    return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml', strict: 'ignore', trust: false, maxExpand: 1000 });
  } catch {
    return `<code>${escapeHtml(tex)}</code>`;
  }
}

export function sanitizeHtml(html) {
  return window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'] });
}

// Plain text for speech: formulas in words, strip markdown, code, URLs.
export function speakable(md) {
  return speakableMath(String(md || ''))
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

export function toast(message, kind = 'info', ms = 4000) {
  const t = el('div', { class: `toast ${kind === 'error' ? 'err' : ''}` }, message);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// Toast with buttons, e.g. [['Reload now', fn]]. Stays until dismissed or a button is clicked.
export function toastActions(message, actions, ms = 30000) {
  const t = el('div', { class: 'toast' }, el('div', {}, message));
  const row = el('div', { class: 'toast-actions' });
  for (const [label, fn] of actions) row.append(el('button', { class: 'btn small', onclick: () => (t.remove(), fn()) }, label));
  row.append(el('button', { class: 'btn small', onclick: () => t.remove() }, 'Later'));
  t.append(row);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
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
