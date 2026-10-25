// The pure part of the agent window (agentwindow.js): which addresses it may show, what the address
// bar turns typed text into, and the scripts it runs in a page to read it and find what to click.
// No Electron here (tested in test/agentwindow.test.js).

const GLOBE_PORT = 4173; // God's Eye View's local server (extensions.js)

/** Hosts on this computer or the local network: never shown, except the globe's own server. */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h);
  if (h.includes(':')) return h === '::' || h === '::1' || /^(fc|fd|fe80)/.test(h) || /^::ffff:/.test(h);
  // A bare number or hex is an IP address in disguise (http://2130706433 = 127.0.0.1).
  return /^(0x[0-9a-f]+|\d+)$/.test(h);
}

function isGlobeUrl(u) {
  return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && Number(u.port) === GLOBE_PORT;
}

/** { ok, url, globe } or { ok: false, reason } for an address the window is asked to show. */
function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    return { ok: false, reason: 'That is not a web address.' };
  }
  if (isGlobeUrl(u)) return { ok: true, url: u.href, globe: true };
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: `${u.protocol.replace(':', '')}: addresses can't be opened in the agent window (only websites).` };
  if (u.username || u.password) return { ok: false, reason: 'Addresses with a user name or password in them are not opened.' };
  if (isPrivateHost(u.hostname)) return { ok: false, reason: 'Addresses on this computer or the local network are not opened in the agent window.' };
  return { ok: true, url: u.href, globe: false };
}

/** What the address bar makes of typed text: an address as is, a domain with https://, anything else a search. */
function fromAddressBar(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  if (/^localhost:\d+/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(:\d+)?(\/.*)?$/u.test(t)) return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}

/** Two addresses that differ only after the # (the globe reads it only when the page loads). */
function onlyHashDiffers(a, b) {
  const strip = (x) => String(x || '').split('#')[0];
  return Boolean(a && b) && a !== b && strip(a) === strip(b);
}

// Runs in the page: its visible text, and the things one can click or type into, each numbered
// (data-nexus-id) so act() can find it again. Returns plain data only.
const READ_SCRIPT = `(() => {
  const MAX_TEXT = __MAX__;
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll('a[href], button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"], summary')) {
    if (items.length >= 160) break;
    if (!visible(el) || el.disabled) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden') continue;
    const id = String(++n);
    el.setAttribute('data-nexus-id', id);
    const tag = el.tagName.toLowerCase();
    const kind = tag === 'a' || el.getAttribute('role') === 'link' ? 'link' : tag === 'input' || tag === 'textarea' || el.isContentEditable ? 'field' : tag === 'select' ? 'select' : 'button';
    const item = { id, kind, label: label(el) };
    if (kind === 'link' && el.href) item.href = String(el.href).slice(0, 200);
    if (kind === 'field') { item.type = type || tag; if (el.value) item.value = type === 'password' ? '••••' : String(el.value).slice(0, 60); }
    if (kind === 'select') item.options = [...el.options].slice(0, 12).map((o) => o.text.trim().slice(0, 40));
    items.push(item);
  }
  const main = document.querySelector('main, article, [role="main"]') || document.body;
  const text = (main ? main.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, url: location.href, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, elements: items, scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, view: innerHeight } };
})()`;

const readScript = (maxText = 12000) => READ_SCRIPT.replace('__MAX__', String(Math.max(1000, Math.min(40000, Number(maxText) || 12000))));

// Runs in the page: scrolls an element (by its data-nexus-id) into view and says where it is and what it
// is, so the click lands on it and sensitive fields are recognized.
const locateScript = (id) => `(() => {
  const el = document.querySelector('[data-nexus-id="${String(id).replace(/[^0-9]/g, '')}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase(), type, sensitive: type === 'password' || /^cc-|current-password|new-password|one-time-code/.test(ac), label: (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.name || '').trim().slice(0, 80) };
})()`;

// Focuses a field and selects what is in it, so typed text replaces it.
const focusScript = (id) => `(() => {
  const el = document.querySelector('[data-nexus-id="${String(id).replace(/[^0-9]/g, '')}"]');
  if (!el) return false;
  el.focus();
  if (typeof el.select === 'function') el.select();
  else if (el.isContentEditable) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  return true;
})()`;

const scrollScript = (direction) =>
  ({ top: 'scrollTo(0, 0)', bottom: 'scrollTo(0, document.documentElement.scrollHeight)', up: 'scrollBy(0, -innerHeight * 0.8)' })[direction] || 'scrollBy(0, innerHeight * 0.8)';

module.exports = { GLOBE_PORT, isPrivateHost, checkUrl, fromAddressBar, onlyHashDiffers, readScript, locateScript, focusScript, scrollScript };
