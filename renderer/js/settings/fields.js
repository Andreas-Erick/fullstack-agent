// The Settings field builders: each binds a control to a `section.key` setting and saves on change
// (text boxes through the waiting saves, settingsave.js), plus the card frame and the test-result box.
import { api, el, plainError } from '../util.js';
import { testFailure } from '../chatcore.js';
import { state } from '../state.js';
import { parseNumber, cleanPath } from '../settingsave.js';
import { get, save, queueSave } from './core.js';

// ---------------------------------------------------------- field builders
// type 'number': a text box with a numeric keyboard (so "1,000" can be read, settingsave.parseNumber); an
// empty or half-typed value saves nothing and the box gets the last good value back when it loses focus.
// decimal: a fraction is allowed (temperature). path: Explorer's "Copy as path" quotes are dropped.
export function text(p, label, { type = 'text', placeholder = '', hint = '', onChange, decimal = false, path = false } = {}) {
  const number = type === 'number';
  const input = el('input', { class: 'input', type: number ? 'text' : type, inputmode: number ? (decimal ? 'decimal' : 'numeric') : null, value: get(p) ?? '', placeholder, spellcheck: 'false', 'data-setting': p });
  let good = get(p) ?? '';
  input.addEventListener('input', () => {
    let v = input.value;
    if (number) {
      v = parseNumber(v, { decimal });
      if (v === null && input.value.trim() !== '') input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      if (v === null) return;
      good = v;
    } else if (path) v = cleanPath(v);
    queueSave(p, v);
    onChange?.(v);
  });
  input.addEventListener('blur', () => {
    if (number && parseNumber(input.value, { decimal }) === null) (input.value = good), input.removeAttribute('aria-invalid');
    else if (path && input.value !== cleanPath(input.value)) input.value = cleanPath(input.value);
  });
  return field(label, input, hint);
}

export function area(p, label, { rows = 6, hint = '' } = {}) {
  const t = el('textarea', { class: 'input', rows, 'data-setting': p });
  t.value = get(p) ?? '';
  t.addEventListener('input', () => queueSave(p, t.value));
  return field(label, t, hint);
}

export function toggle(p, label, onChange) {
  const input = el('input', { type: 'checkbox', 'data-setting': p });
  input.checked = Boolean(get(p));
  input.addEventListener('change', async () => {
    if (!(await save(p, input.checked))) return void (input.checked = Boolean(get(p)));
    onChange?.(input.checked);
  });
  return el('label', { class: 'toggle' }, input, el('span', { class: 'sw' }), el('span', {}, label));
}

export function select(p, label, options, { hint = '', onChange } = {}) {
  const s = el('select', { class: 'input', 'data-setting': p });
  fillSelect(s, options, get(p));
  s.addEventListener('change', async () => {
    if (!(await save(p, s.value))) return void (s.value = get(p) ?? '');
    onChange?.(s.value);
  });
  return field(label, s, hint);
}

export function fillSelect(s, options, value) {
  s.innerHTML = '';
  const list = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  if (value && !list.some(([v]) => v === value)) list.unshift([value, value]);
  for (const [v, l] of list) s.append(el('option', { value: v, selected: v === value }, l));
}

// The label is tied to its control (for/id), so a screen reader names the field: it used to sit next to
// it unconnected ("combo box", no name). A control in a row (a dropdown and its button) ties the first
// input in it; the hint describes it.
let fieldSeq = 0;
export function field(label, control, hint) {
  const input = control?.matches?.('input, select, textarea') ? control : control?.querySelector?.('input, select, textarea');
  const id = input ? input.id || (input.id = `set-field-${++fieldSeq}`) : null;
  const hintEl = hint ? el('div', { class: 'hint', html: hint, id: id ? `${id}-hint` : null }) : '';
  if (input && hint) input.setAttribute('aria-describedby', `${id}-hint`);
  return el('div', { class: 'field' }, el('label', id ? { for: id } : {}, label), control, hintEl);
}

export function folder(p, label, { hint = '', placeholder = '', onChange } = {}) {
  const input = el('input', { class: 'input', value: get(p) || '', placeholder, spellcheck: 'false', 'data-setting': p });
  input.addEventListener('change', async () => {
    const dir = cleanPath(input.value); // a pasted "C:\…\Vault" (Copy as path) keeps no quotes
    if (input.value !== dir) input.value = dir;
    await save(p, dir);
    onChange?.();
  });
  const browse = el('button', {
    class: 'btn',
    onclick: async () => {
      const dir = await api.dialog.pickFolder(label);
      if (dir) {
        input.value = dir;
        await save(p, dir);
        onChange?.();
      }
    },
  }, 'Browse…');
  return field(label, el('div', { class: 'row' }, input, browse), hint);
}

export function card(id, title, desc, ...children) {
  return el('section', { class: 'card glass', id: `set-${id}` }, el('h3', {}, el('span', { class: 'dot' }), title), desc ? el('p', { class: 'desc', html: desc }) : '', ...children);
}

export function result() {
  return el('div', { class: 'test-result hidden' });
}
export function showResult(box, ok, msg, raw = '') {
  box.classList.remove('hidden', 'ok', 'err');
  box.classList.add(ok ? 'ok' : 'err');
  box.textContent = msg;
  if (raw) box.append(el('details', { class: 'reply-error-raw' }, el('summary', {}, 'Details'), el('pre', {}, raw)));
}

// A failed connection test in plain words (chatcore.testFailure), the provider's own text under Details.
export function showFailure(box, err) {
  const f = testFailure(plainError(err), { settings: state.settings });
  showResult(box, false, f.line, f.raw);
}

export const debounceAfter = (fn) => {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, 900);
  };
};
