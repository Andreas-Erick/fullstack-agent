// Finds controls a screen reader can't name: a button with only an icon and no label, an input whose
// label isn't tied to it, a tab without text; and inputs hidden from the keyboard inside a shown label
// (a switch whose checkbox is display: none). Pure DOM reading, run by the launch check (main/smoke.js)
// on every view and Settings tab, like cliptest.js; nothing in the app imports it.

const CONTROLS = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=switch], [role=checkbox], [role=slider], [tabindex]:not([tabindex="-1"])';

function shown(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

const words = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** The name assistive technology gives the element (the parts of the accessible-name rules we use). */
export function nameOf(el) {
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = words(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '));
    if (t) return t;
  }
  const aria = words(el.getAttribute('aria-label'));
  if (aria) return aria;
  if (el.labels?.length) {
    const t = words([...el.labels].map((l) => l.textContent).join(' '));
    if (t) return t;
  }
  if (!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) {
    const t = words(el.textContent);
    if (t) return t;
    const img = el.querySelector('img[alt], svg[aria-label]');
    if (img) return words(img.getAttribute('alt') || img.getAttribute('aria-label'));
  }
  return words(el.getAttribute('title') || el.getAttribute('placeholder'));
}

const describe = (el) => {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  const type = el.type && el.tagName === 'INPUT' ? `[type=${el.type}]` : '';
  return `${el.tagName.toLowerCase()}${id}${cls}${type}`;
};

/** Every shown control in `root` without a name: [{ where, html }]. */
export function findUnnamed(root = document.body) {
  const out = [];
  for (const el of root.querySelectorAll(CONTROLS)) {
    if (el.closest('[aria-hidden="true"], [inert]') || el.disabled || !shown(el)) continue;
    if (nameOf(el)) continue;
    out.push({ where: describe(el), html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 140) });
  }
  return out;
}

/** Inputs inside a shown label that are themselves display: none / visibility: hidden (no keyboard, no screen reader): [{ where, html }]. */
export function findHiddenInLabels(root = document.body) {
  const out = [];
  for (const el of root.querySelectorAll('label input:not([type=hidden]), label select, label textarea')) {
    if (el.closest('[aria-hidden="true"], [inert]') || el.disabled || !shown(el.closest('label'))) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') out.push({ where: describe(el), html: el.outerHTML.replace(/\s+/g, ' ').slice(0, 140) });
  }
  return out;
}
