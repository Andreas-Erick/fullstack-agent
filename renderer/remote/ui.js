// Small helpers of the phone client: building nodes, Markdown, notices, the script-error trap and the
// errors the network calls throw.
import { toastMs, PHONE_PURIFY } from './sync.js';
import { $, state } from './state.js';

let mathtext = null;
import('./js/mathtext.js').then((m) => (mathtext = m)).catch(() => {}); // formulas then show as their source text
// ------------------------------------------------------------------ helpers
export function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}

export const icon = (id) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${id}`);
  svg.append(use);
  return svg;
};

// Links in replies open outside the app (a new tab; in the Android app, the browser), never in place
// of it, and only web and mail links stay clickable. A [[link]] between notes (screens.js openNote
// writes it as #note:<name>) stays in the page: a fragment can't run anything.
window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  if ((node.getAttribute('href') || '').startsWith('#note:')) return;
  if (!/^(https?:|mailto:)/i.test(node.getAttribute('href') || '')) return node.removeAttribute('href');
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener noreferrer');
});

// Formulas as on the desktop (renderer/js/util.js): taken out before Markdown, rendered by KaTeX. Here
// as MathML only, which the browser draws itself: no inline styles (the page's CSP) and no math fonts.
export function markdown(text) {
  const math = window.katex && mathtext ? mathtext.extractMath(String(text ?? '')) : { text: String(text ?? ''), items: [] };
  let html = window.marked.parse(math.text, { breaks: true, gfm: true });
  if (math.items.length) html = mathtext.restoreMath(html, math.items, renderTex);
  return window.DOMPurify.sanitize(html, { ...PHONE_PURIFY });
}

function renderTex(tex, display) {
  try {
    // Without the TeX source KaTeX keeps in <annotation>: the sanitizer would leave it as visible text.
    return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'mathml', strict: 'ignore', trust: false, maxExpand: 1000 }).replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');
  } catch {
    return `<code>${tex.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])}</code>`;
  }
}

export const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return new Date(t).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(t).toLocaleDateString();
};

// A notice above the composer. Without a button it lets taps through (it often sits on the message box);
// `action` ({ label, run }) adds one, and then it takes taps.
let toastTimer;
export function toast(msg, action = null) {
  const t = $('#toast');
  t.replaceChildren(el('span', {}, msg));
  if (action) t.append(el('button', { class: 'toast-btn', type: 'button', onclick: () => (t.classList.add('hidden'), action.run()) }, action.label));
  t.classList.toggle('actionable', Boolean(action));
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), toastMs(msg, Boolean(action)));
}

// A phone has no developer console: a script error (a screen that failed to draw, a browser missing a
// feature) shows as a notice instead of a silent blank, so it can be reported; its own words under Details.
let lastError = '';
function scriptError(text) {
  if (text === lastError) return;
  lastError = text;
  toast('Something went wrong on this device.', { label: 'Details', run: () => toast(text.slice(0, 300)) });
}
window.addEventListener('error', (e) => scriptError(String(e.message || e.error?.message || 'Script error')));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r instanceof AuthError || r?.name === 'AbortError') return;
  scriptError(String(r?.message || r || 'Error'));
});

export class AuthError extends Error {}
// The computer didn't answer at all (off, asleep, Siren closed, another network): the screens show a
// "can't reach your computer" card instead of the browser's "Failed to fetch".
export class NetError extends Error {}
export function setConvTitle(t) {
  state.convTitle = t;
  if (state.view === 'chat') $('#convTitle').textContent = t;
}
// Submits a form the way Enter would (older Safari has no requestSubmit).
export function submitForm(form) {
  if (form.requestSubmit) form.requestSubmit();
  else form.querySelector('button[type="submit"]')?.click();
}
// A list that didn't load, in words: the computer's own or "out of reach" as they are, a script error as `fallback`.
export const plainLoadError = (err, fallback) => (err instanceof NetError || err?.fromServer ? err.message : fallback);

