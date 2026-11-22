// Notes view: the user's own notes, written here like in Obsidian (plain Markdown in the vault's Notes/
// and Inbox/, main/notebook.js). Made to feel good to write in: it saves itself as you type (a quiet
// "Saved ✓"), a new note lands in the list with a little pop, [[ suggests your other notes, Ctrl+E shows
// the rendered note, and Dump is a blank page for getting everything out of your head (Ctrl+Enter: saved,
// a fresh page; Esc: saved and closed). The assistant reads them like any vault note.
import { $, api, el, renderMarkdown, timeAgo, toast, toastError, pushToast, on, emit, plainError } from './util.js';
import { switchView, currentView } from './nav.js';
import * as fmt from './notesedit.js';

const SAVE_MS = 700; // after typing stops
const RENAME_MS = 1400; // a title change renames the file once typing stops
const DRAFT_KEY = 'notes.dumpDraft';

let notes = [];
let today = '';
let filter = { q: '', folder: null, tag: null };
let current = null; // { path, title, body, pinned, mtime }
let mode = 'read'; // read: the rendered note (click to edit there) · write: the Markdown, with the formatting bar
let saving = Promise.resolve();
let bodyTimer = 0;
let titleTimer = 0;
let dirty = false;
let landed = null; // path of a note that just arrived (the pop animation)
// ✨ Polish: the polished version waiting for the user's yes ({ path, original, polished, added, show }), and the note being polished.
let review = null;
let polishing = '';

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v == null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private window: not kept */
    }
  },
};

export function initNotes() {
  $('#notesNew').onclick = () => newNote();
  $('#notesDump').onclick = () => openDump();
  $('#notesSearch').addEventListener('input', (e) => {
    filter.q = e.target.value;
    renderList();
  });
  $('#notesSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) (e.preventDefault(), (e.target.value = ''), (filter.q = ''), renderList());
    if (e.key === 'ArrowDown') (e.preventDefault(), $('#notesList .note-item')?.focus());
  });
  $('#notesList').addEventListener('keydown', (e) => {
    const items = [...document.querySelectorAll('#notesList .note-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' && i >= 0) (e.preventDefault(), items[Math.min(items.length - 1, i + 1)].focus());
    if (e.key === 'ArrowUp' && i >= 0) (e.preventDefault(), i === 0 ? $('#notesSearch').focus() : items[i - 1].focus());
  });
  // Ctrl+N here is a new note (elsewhere it starts a new chat), Ctrl+E switches Write / Preview.
  $('#view-notes').addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      e.stopPropagation();
      newNote();
    } else if (mod && e.key.toLowerCase() === 'e' && current) {
      e.preventDefault();
      setMode(mode === 'write' ? 'read' : 'write');
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      flush();
    }
  });
  // Changes from elsewhere (the assistant wrote a note, Obsidian edited one): the list, and the open note
  // when nothing typed here is waiting to be saved.
  // Our own autosave is skipped (saveBody already updated its list item; re-listing read every note),
  // and so is any change while the view is hidden: refresh() lists again when it shows.
  let reload = 0;
  on('vault-changed', (rel) => {
    if (!/^(Notes|Inbox)\//.test(String(rel || ''))) return;
    if (isOwnSave(rel)) return;
    if (currentView !== 'notes') return;
    clearTimeout(reload);
    reload = setTimeout(async () => {
      await loadList();
      if (current && rel === current.path && !dirty && currentView === 'notes') reloadOpen();
    }, 400);
  });
  window.addEventListener('beforeunload', () => flush());
}

// A note to open once the view shows (showNote): refresh opens it instead of the newest one.
let pendingOpen = null;

/** Opens one of the user's notes (Notes/ or Inbox/ path) in this view, e.g. from a [[link]] in the chat. */
export function showNote(path) {
  if (currentView === 'notes') return openNote(path);
  pendingOpen = path;
  switchView('notes');
}

/** Shown: the list again, and the note that was open (or the newest). */
export async function refresh() {
  await loadList();
  if (pendingOpen) {
    const p = pendingOpen;
    pendingOpen = null;
    return openNote(p);
  }
  if (current && notes.some((n) => n.path === current.path)) return;
  if (notes.length) openNote(notes[0].path, { keepFocus: true });
  else showEmpty();
}

async function loadList() {
  try {
    ({ notes, today } = await api.notebook.list());
  } catch (err) {
    notes = [];
    const hadFocus = $('#notesList').contains(document.activeElement);
    const again = el('button', { class: 'btn small', type: 'button', onclick: (ev) => ((ev.currentTarget.disabled = true), refresh()) }, 'Try again');
    $('#notesList').replaceChildren(el('div', { class: 'test-result err notes-msg', role: 'alert' }, `Couldn’t read your notes: ${plainError(err)} `, again));
    if (hadFocus) again.focus();
    return;
  }
  renderChips();
  renderList();
  renderFoot();
}

// ------------------------------------------------------------------ the list
const DAY = 86400000;
function groupOf(n) {
  if (n.pinned) return 'Pinned';
  if (n.day === today) return 'Today';
  const days = Math.floor((new Date(`${today}T12:00:00`) - new Date(`${n.day}T12:00:00`)) / DAY);
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return 'Earlier';
}

function visible() {
  const words = filter.q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(Boolean);
  return notes.filter((n) => {
    if (filter.folder !== null && (n.folder || 'Notes') !== filter.folder) return false;
    if (filter.tag && !n.tags.includes(filter.tag)) return false;
    if (!words.length) return true;
    const hay = `${n.title} ${n.text || n.snippet} ${n.tags.map((t) => `#${t}`).join(' ')} ${n.folder}`.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    return words.every((w) => hay.includes(w));
  });
}

function renderChips() {
  const box = $('#notesChips');
  const folders = [...new Set(notes.map((n) => n.folder || 'Notes'))];
  const tagCounts = new Map();
  for (const n of notes) for (const t of n.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const tags = [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
  const chip = (label, on, onclick, title) => el('button', { class: `chip${on ? ' on' : ''}`, type: 'button', 'aria-pressed': String(on), title, onclick }, label);
  box.replaceChildren(
    ...(folders.length > 1 ? folders.map((f) => chip(f === 'Inbox' ? '📥 Inbox' : f === 'Notes' ? '📓 Notes' : `📁 ${f}`, filter.folder === f, () => ((filter.folder = filter.folder === f ? null : f), renderChips(), renderList()), `Only ${f}`)) : []),
    ...tags.map((t) => chip(`#${t}`, filter.tag === t, () => ((filter.tag = filter.tag === t ? null : t), renderChips(), renderList()), `Notes tagged #${t}`)),
  );
}

function renderList() {
  const box = $('#notesList');
  const list = visible();
  if (!list.length) {
    box.replaceChildren(el('p', { class: 'muted notes-msg' }, notes.length ? 'Nothing matches. ' : 'No notes yet.', notes.length ? '' : el('button', { class: 'btn small', onclick: () => newNote() }, 'Write the first one')));
    return;
  }
  const out = [];
  let group = '';
  for (const n of list) {
    const g = groupOf(n);
    if (g !== group) out.push(el('div', { class: 'notes-group', role: 'presentation' }, (group = g)));
    const meta = metaOf(n);
    const item = el(
      'button',
      { class: `note-item${current?.path === n.path ? ' active' : ''}${landed === n.path ? ' landed' : ''}`, type: 'button', role: 'option', 'aria-selected': String(current?.path === n.path), 'data-path': n.path, onclick: () => openNote(n.path) },
      el('span', { class: 'note-title' }, n.pinned ? '📌 ' : '', n.title),
      n.snippet ? el('span', { class: 'note-snippet' }, n.snippet) : el('span', { class: 'note-snippet muted' }, 'Empty'),
      el('span', { class: 'note-meta' }, meta),
    );
    out.push(item);
  }
  box.replaceChildren(...out);
  landed = null;
}

// A row's line under the snippet: when, the notebook, up to three tags.
const metaOf = (n) => [timeAgo(n.mtime), n.folder && n.folder !== 'Notes' ? n.folder : '', ...n.tags.slice(0, 3).map((t) => `#${t}`)].filter(Boolean).join(' · ');

// As notebookcore.words counts them (the footer's words in today's notes).
const countWords = (body) => (String(body || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

// One row after our own autosave: its snippet and time, without listing every note again. The row keeps
// its place until the next full list (it doesn't jump to the top while the user types).
function redrawItem(n) {
  const row = [...$('#notesList').querySelectorAll('.note-item')].find((r) => r.dataset.path === n.path);
  if (row) {
    const snip = row.querySelector('.note-snippet');
    if (snip) {
      snip.textContent = n.snippet || 'Empty';
      snip.classList.toggle('muted', !n.snippet);
    }
    const meta = row.querySelector('.note-meta');
    if (meta) meta.textContent = metaOf(n);
  }
  renderFoot();
}

function renderFoot() {
  const words = notes.filter((n) => n.day === today).reduce((s, n) => s + n.words, 0);
  $('#notesFoot').textContent = `${notes.length} note${notes.length === 1 ? '' : 's'}${words ? ` · ${words} word${words === 1 ? '' : 's'} in today's notes` : ''}`;
}

// ------------------------------------------------------------------ the editor
function showEmpty() {
  current = null;
  $('#notesEditor').replaceChildren(
    el(
      'div',
      { class: 'notes-empty' },
      el('div', { class: 'notes-empty-mark', 'aria-hidden': 'true' }, '✎'),
      el('h3', {}, 'Your notes'),
      el('p', {}, 'Ideas, lecture thoughts, plans, things you don’t want to forget. Write them here; they are plain Markdown in your vault, and the assistant finds them again when you ask (“what did I write about PID tuning?”).'),
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => newNote() }, '＋ New note'), el('button', { class: 'btn', onclick: () => openDump() }, '⚡ Brain dump')),
      el('p', { class: 'hint' }, 'Ctrl+N new note · Ctrl+Shift+N brain dump from anywhere · Ctrl+E read / write · [[ links another note'),
    ),
  );
}

async function openNote(path, { keepFocus = false, focus = '' } = {}) {
  await flush();
  let note;
  try {
    note = await api.notebook.read(path);
  } catch (err) {
    toastError(err);
    return;
  }
  current = note;
  dirty = false;
  if (review?.path !== path) review = null;
  mode = focus || !note.body.trim() ? 'write' : 'read';
  renderEditor({ focus });
  for (const b of document.querySelectorAll('#notesList .note-item')) {
    const on = b.dataset.path === path;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  if (!keepFocus && !focus) ($('#notesEditor .note-body') || $('#notesEditor .note-preview'))?.focus({ preventScroll: true });
}

// The open note changed on disk. Our own autosave lands here too: the same text, so nothing is redrawn
// (redrawing put the note back in reading mode, and the writer had to click into it again after every
// "Saved ✓"). A real outside change is shown in the same mode, keeping the caret if the user was writing.
async function reloadOpen() {
  const note = current;
  let fresh;
  try {
    fresh = await api.notebook.read(note.path);
  } catch {
    return;
  }
  if (current !== note || dirty || review) return; // switched notes, or typed meanwhile
  const same = fresh.body === note.body && fresh.title === note.title;
  Object.assign(note, { mtime: fresh.mtime, pinned: fresh.pinned });
  if (same) return;
  const body = $('#notesEditor .note-body');
  const writing = mode === 'write' && body && document.activeElement === body;
  const at = writing ? [body.selectionStart, body.selectionEnd] : null;
  current = fresh;
  renderEditor({ focus: writing ? 'body' : '' });
  if (at) $('#notesEditor .note-body')?.setSelectionRange(Math.min(at[0], fresh.body.length), Math.min(at[1], fresh.body.length));
}

function setMode(m, { caret } = {}) {
  mode = m;
  if (!current) return;
  renderEditor({ focus: m === 'write' ? 'body' : '' });
  const body = $('#notesEditor .note-body');
  if (body && caret !== undefined) {
    body.setSelectionRange(caret, caret);
    // Bring the caret's line into view: measure how far down it is with a hidden copy of the text.
    const lines = body.value.slice(0, caret).split('\n').length;
    body.scrollIntoView({ block: 'nearest' });
    const lh = parseFloat(getComputedStyle(body).lineHeight) || 26;
    $('#notesEditor').scrollTop = Math.max(0, body.offsetTop + lines * lh - $('#notesEditor').clientHeight / 2);
  }
  if (m === 'read') $('#notesEditor .note-preview')?.focus({ preventScroll: true });
}

// The formatting bar (notesedit.js does the text): each button as typing, so Ctrl+Z undoes it.
const FORMATS = [
  ['H1', 'Title (H1)', (x) => fmt.heading(x, 1), (f) => f.heading === 1],
  ['H2', 'Subtitle (H2)', (x) => fmt.heading(x, 2), (f) => f.heading === 2],
  ['H3', 'Heading (H3)', (x) => fmt.heading(x, 3), (f) => f.heading === 3],
  ['B', 'Bold (Ctrl+B)', (x) => fmt.wrap(x, '**')],
  ['I', 'Italic (Ctrl+I)', (x) => fmt.wrap(x, '*')],
  ['•', 'Bullet list', (x) => fmt.list(x, 'bullet'), (f) => f.list === 'bullet'],
  ['1.', 'Numbered list', (x) => fmt.list(x, 'number'), (f) => f.list === 'number'],
  ['☐', 'Checklist', (x) => fmt.list(x, 'task'), (f) => f.list === 'task'],
  ['❝', 'Quote', (x) => fmt.quote(x), (f) => f.quote],
  ['🔗', 'Link to another note ([[)', (x) => fmt.link(x)],
];

function applyEdit(body, ed) {
  if (!ed) return false;
  body.focus();
  body.setSelectionRange(ed.from, ed.to);
  // As typing: the browser keeps it in the undo history, and the input event saves it.
  if (ed.insert) document.execCommand('insertText', false, ed.insert);
  else if (ed.to > ed.from) document.execCommand('delete');
  body.setSelectionRange(ed.start, ed.end);
  return true;
}

function renderEditor({ focus = '' } = {}) {
  const n = current;
  const title = el('input', { class: 'note-title-input', value: n.title === 'Untitled' ? '' : n.title, placeholder: 'Untitled', 'aria-label': 'Title', spellcheck: 'true' });
  const body = el('textarea', { class: 'note-body', placeholder: 'Start writing… The bar above makes titles, lists and links; Markdown works too (# title, - list, 1. list, [[another note]], #tag).', 'aria-label': 'Note', spellcheck: 'true' });
  body.value = n.body;
  const status = el('span', { class: 'note-status', role: 'status', 'aria-live': 'polite' }, 'Saved');
  const count = el('span', { class: 'note-count' });
  const setCount = () => {
    const w = (body.value.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    count.textContent = `${w} word${w === 1 ? '' : 's'}`;
  };
  setCount();
  const preview = el('div', { class: 'note-preview doc-html', tabindex: '0', title: 'Click to edit here', 'aria-label': `${n.title}, rendered. Press Enter to edit.` });
  const pin = el('button', { class: `btn small${n.pinned ? ' on' : ''}`, type: 'button', title: n.pinned ? 'Unpin' : 'Pin to the top', 'aria-pressed': String(Boolean(n.pinned)), onclick: () => togglePin() }, n.pinned ? '📌 Pinned' : '📌 Pin');
  const modeBtn = el('button', { class: 'btn small', type: 'button', title: mode === 'write' ? 'Show it rendered (Ctrl+E)' : 'Edit (Ctrl+E, or click the text)', onclick: () => setMode(mode === 'write' ? 'read' : 'write') }, mode === 'write' ? '👁 Done' : '✎ Edit');
  const tools = el(
    'div',
    { class: 'note-tools' },
    status,
    el('span', { class: 'spacer' }),
    modeBtn,
    pin,
    el('button', { class: 'btn small polish-btn', type: 'button', title: 'Let the assistant tidy this note up and link related notes (you see it before anything changes)', disabled: polishing === n.path || Boolean(review), onclick: () => polishNote() }, polishing === n.path ? '✨ Polishing…' : '✨ Polish'),
    el('button', { class: 'btn small', type: 'button', title: 'Ask the assistant about this note', onclick: () => askAbout() }, '💬 Ask'),
    el('button', { class: 'btn small', type: 'button', title: 'Open in Obsidian', 'aria-label': 'Open in Obsidian', onclick: () => api.obsidian.openInObsidian(n.path).catch(toastError) }, '◆'),
    el('button', { class: 'btn small danger', type: 'button', title: 'Move to Trash (you can undo)', 'aria-label': 'Delete note', onclick: () => removeNote() }, '🗑'),
  );
  const markSaving = () => {
    status.textContent = 'Saving…';
    status.classList.remove('saved');
  };
  const markSaved = () => {
    status.textContent = 'Saved ✓';
    status.classList.remove('saved');
    void status.offsetWidth; // restart the pulse
    status.classList.add('saved');
  };
  // The formatting bar, lit up for the caret's line.
  const fmtButtons = FORMATS.map(([label, name, run, isOn]) => {
    const b = el('button', { class: `fmt-btn fmt-${label === 'B' ? 'b' : label === 'I' ? 'i' : 'x'}`, type: 'button', title: name, 'aria-label': name, onmousedown: (e) => e.preventDefault(), onclick: () => applyEdit(body, run({ text: body.value, start: body.selectionStart, end: body.selectionEnd })) && label === '🔗' && suggest(body) }, label);
    b.isOn = isOn;
    return b;
  });
  const fmtBar = el('div', { class: 'note-format', role: 'toolbar', 'aria-label': 'Formatting' }, ...fmtButtons);
  const lightUp = () => {
    const f = fmt.formatsAt(body.value, body.selectionStart);
    for (const b of fmtButtons) if (b.isOn) b.classList.toggle('on', b.isOn(f));
  };
  title.addEventListener('input', () => {
    dirty = true;
    markSaving();
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => rename(title.value, markSaved), RENAME_MS);
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && title.selectionStart === title.value.length)) {
      e.preventDefault();
      if (mode === 'write') body.focus();
      else setMode('write', { caret: 0 });
    }
  });
  title.addEventListener('blur', () => {
    if (titleTimer) (clearTimeout(titleTimer), rename(title.value, markSaved));
  });
  body.addEventListener('input', () => {
    dirty = true;
    current.body = body.value;
    markSaving();
    setCount();
    lightUp();
    clearTimeout(bodyTimer);
    bodyTimer = setTimeout(() => saveBody(markSaved), SAVE_MS);
    suggest(body);
  });
  body.addEventListener('keydown', (e) => {
    onSuggestKey(e, body);
    if (e.defaultPrevented) return;
    const sel = { text: body.value, start: body.selectionStart, end: body.selectionEnd };
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      if (applyEdit(body, fmt.enter(sel))) e.preventDefault();
    } else if (e.key === 'Tab' && !mod && !e.altKey) {
      if (applyEdit(body, fmt.indent(sel, e.shiftKey))) e.preventDefault();
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      applyEdit(body, fmt.wrap(sel, '**'));
    } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      applyEdit(body, fmt.wrap(sel, '*'));
    }
  });
  for (const ev of ['keyup', 'click', 'focus']) body.addEventListener(ev, lightUp);
  body.addEventListener('blur', () => setTimeout(closeSuggest, 150));
  // Reading: a click on a link opens that note; a click anywhere else edits right there.
  preview.addEventListener('click', (e) => {
    const link = e.target.closest('a.wikilink');
    if (link) return (e.preventDefault(), followLink(link.dataset.note));
    if (e.target.closest('a[href]') || window.getSelection()?.toString()) return; // a web link, or selecting text to copy
    // A checklist box: ticked right here, in the text too, and saved.
    const box = e.target.closest('input[type=checkbox]');
    if (box) {
      e.preventDefault();
      const i = [...preview.querySelectorAll('input[type=checkbox]')].indexOf(box);
      const next = fmt.toggleTask(body.value, i);
      if (next === body.value) return;
      body.value = next;
      current.body = next;
      dirty = true;
      markSaving();
      saveBody(markSaved);
      renderEditor();
      return;
    }
    const block = e.target.closest('p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, pre');
    let caret = body.value.length;
    if (block) {
      let offset = 0;
      const hit = document.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (hit && block.contains(hit.startContainer)) {
        const r = document.createRange();
        r.setStart(block, 0);
        r.setEnd(hit.startContainer, hit.startOffset);
        offset = r.toString().length;
      }
      const at = fmt.sourceOffset(body.value, block.innerText, offset);
      if (at >= 0) caret = at;
    }
    setMode('write', { caret });
  });
  preview.addEventListener('keydown', (e) => {
    const link = e.key === 'Enter' && e.target.closest('a.wikilink');
    if (link) return (e.preventDefault(), followLink(link.dataset.note));
    if (e.key === 'Enter' && !e.target.closest('a')) (e.preventDefault(), setMode('write', { caret: body.value.length }));
  });
  const edited = el('span', {}, `edited ${timeAgo(n.mtime)}`);
  // The polished version, shown before anything changes: accept it, keep yours, or compare.
  if (review && review.path === n.path) {
    const showing = review.show === 'original' ? review.original : review.polished;
    const view = el('div', { class: 'note-preview doc-html' });
    view.innerHTML = renderMarkdown(showing, { wikilinks: true });
    const banner = el(
      'div',
      { class: 'polish-banner', role: 'region', 'aria-label': 'Polished version' },
      el('div', { class: 'polish-what' }, el('b', {}, review.show === 'original' ? 'Your version' : '✨ Polished version'), el('span', { class: 'hint' }, review.added.length ? `Links added: ${review.added.join(', ')}` : 'No related notes to link.')),
      el('div', { class: 'row' },
        el('button', { class: 'btn small', type: 'button', onclick: () => ((review.show = review.show === 'original' ? 'polished' : 'original'), renderEditor()) }, review.show === 'original' ? 'Show polished' : 'Compare with mine'),
        el('button', { class: 'btn small', type: 'button', onclick: () => ((review = null), renderEditor()) }, 'Keep mine'),
        el('button', { class: 'btn small primary', type: 'button', onclick: () => acceptPolish() }, '✓ Use it'),
      ),
    );
    $('#notesEditor').replaceChildren(tools, el('div', { class: 'note-page reading reviewing' }, title, banner, view, el('div', { class: 'note-foot' }, count, edited)));
    banner.querySelector('.primary').focus({ preventScroll: true });
    return;
  }
  const page = el('div', { class: `note-page ${mode === 'write' ? 'writing' : 'reading'}${polishing === n.path ? ' polishing' : ''}` }, title, mode === 'write' ? fmtBar : '', mode === 'write' ? body : preview, el('div', { class: 'note-foot' }, count, edited, n.folder ? el('span', {}, n.folder) : ''));
  if (mode === 'read') {
    preview.innerHTML = renderMarkdown(body.value || '*Nothing written yet. Click to start.*', { wikilinks: 'open' });
    // Links to notes that don't exist yet look different (a click creates them).
    for (const a of preview.querySelectorAll('a.wikilink')) {
      const name = String(a.dataset.note || '').split('/').pop().toLowerCase();
      if (!notes.some((x) => x.title.toLowerCase() === name)) a.classList.add('missing');
    }
    // A note that starts with its own title as "# Title" (the Obsidian habit) doesn't show it twice.
    const first = preview.firstElementChild;
    if (first?.tagName === 'H1' && first.textContent.trim().toLowerCase() === n.title.trim().toLowerCase()) first.classList.add('same-as-title');
    // Web links open in the browser, never in the app window.
    for (const a of preview.querySelectorAll('a[href]')) a.setAttribute('target', '_blank');
    // Checklist boxes come disabled from the renderer, which swallows their clicks: they tick here.
    for (const c of preview.querySelectorAll('input[type=checkbox]')) {
      c.removeAttribute('disabled');
      c.setAttribute('aria-label', c.checked ? 'Done: untick' : 'Tick off');
    }
  }
  $('#notesEditor').replaceChildren(tools, page);
  watchTools(tools);
  if (focus === 'title') (title.focus(), title.select());
  else if (focus === 'body') body.focus();
  lightUp();
}

// The formatting bar sticks just below the tool row, however many lines that row wraps to (styles.css --tools-h).
let toolsObserver = null;
function watchTools(tools) {
  toolsObserver?.disconnect();
  toolsObserver = new ResizeObserver(() => {
    if (tools.isConnected) $('#notesEditor').style.setProperty('--tools-h', `${tools.offsetHeight}px`);
  });
  toolsObserver.observe(tools);
}

// Saves run one after the other; a rename waits for the text before it.
function queue(fn) {
  saving = saving.then(fn, fn);
  return saving;
}

// The note this view's last autosave wrote: its own vault:changed is answered once, within OWN_SAVE_MS.
const OWN_SAVE_MS = 3000;
let ownSave = { path: '', at: 0 };
function isOwnSave(rel) {
  if (rel !== ownSave.path || Date.now() - ownSave.at > OWN_SAVE_MS) return false;
  ownSave = { path: '', at: 0 };
  return true;
}

function saveBody(done) {
  clearTimeout(bodyTimer);
  bodyTimer = 0;
  const note = current;
  if (!note) return Promise.resolve();
  const text = note.body;
  return queue(async () => {
    try {
      ownSave = { path: note.path, at: Date.now() };
      await api.notebook.save(note.path, { body: text });
      if (text.trim()) emit('note-saved'); // the getting-started card's step (gettingstarted.js)
      if (current === note && note.body === text) dirty = Boolean(titleTimer);
      const item = notes.find((x) => x.path === note.path);
      if (item) {
        Object.assign(item, { mtime: Date.now(), day: today, snippet: text.replace(/\s+/g, ' ').slice(0, 180), text: text.slice(0, 4000), words: countWords(text) });
        redrawItem(item);
      }
      done?.();
    } catch (err) {
      toastError(err);
    }
  });
}

function rename(value, done) {
  clearTimeout(titleTimer);
  titleTimer = 0;
  const note = current;
  if (!note) return Promise.resolve();
  const wanted = value.trim() || 'Untitled';
  return queue(async () => {
    try {
      const r = await api.notebook.save(note.path, { title: wanted });
      if (r.path !== note.path) {
        note.path = r.path;
        note.title = r.path.split('/').pop().replace(/\.md$/, '');
        if (r.relinked) toast(`Renamed; ${r.relinked} link${r.relinked === 1 ? '' : 's'} updated`);
      }
      if (current === note) dirty = Boolean(bodyTimer);
      await loadList();
      done?.();
    } catch (err) {
      toastError(err);
    }
  });
}

/** Writes whatever is waiting (switching notes, leaving, Ctrl+S). */
async function flush() {
  if (bodyTimer) saveBody();
  if (titleTimer) {
    const input = $('#notesEditor .note-title-input');
    rename(input ? input.value : current?.title || '');
  }
  await saving;
}

// ✨ Polish: the assistant rewrites the note clearly and links related notes (main/notebook.js polish);
// nothing changes until the user says "Use it", and the note's history keeps the old text.
async function polishNote() {
  if (!current || polishing) return;
  await flush();
  const path = current.path;
  polishing = path;
  renderEditor();
  try {
    const r = await api.notebook.polish(path);
    if (current?.path !== path) return toast('The polished version is ready: open the note again and press ✨ Polish.');
    review = { path, original: current.body, polished: r.body, added: r.added || [], show: 'polished' };
  } catch (err) {
    toastError(new Error(String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  } finally {
    polishing = '';
    if (current?.path === path) renderEditor();
  }
}

async function acceptPolish() {
  if (!review || current?.path !== review.path) return;
  if (current.body !== review.original) {
    // Changed meanwhile (the assistant or Obsidian wrote it): don't overwrite that.
    review = null;
    renderEditor();
    return toast('The note changed meanwhile, so the polished version was not used. Polish it again.');
  }
  current.body = review.polished;
  review = null;
  mode = 'read';
  dirty = true;
  await saveBody(() => toast('Polished ✓  The old version stays in the note’s history.'));
  renderEditor();
}

export async function newNote({ title = '', body = '' } = {}) {
  await flush();
  if (currentView !== 'notes') switchView('notes');
  try {
    const folder = filter.folder && filter.folder !== 'Notes' ? filter.folder : '';
    const { path } = await api.notebook.create({ title: title || 'Untitled', body, folder });
    landed = path;
    await loadList();
    await openNote(path, { focus: title ? 'body' : 'title' });
    return path;
  } catch (err) {
    toastError(err);
    return null;
  }
}

async function togglePin() {
  if (!current) return;
  await flush();
  try {
    await api.notebook.pin(current.path, !current.pinned);
    current.pinned = !current.pinned;
    await loadList();
    renderEditor();
  } catch (err) {
    toastError(err);
  }
}

async function removeNote() {
  if (!current) return;
  await flush();
  const gone = { ...current };
  try {
    gone.trashed = (await api.notebook.remove(gone.path))?.trashed;
  } catch (err) {
    toastError(err);
    return;
  }
  current = null;
  await loadList();
  if (notes.length) openNote(notes[0].path, { keepFocus: true });
  else showEmpty();
  // Undo: the file itself comes back from the vault's .trash, frontmatter (tags, aliases, pinned) and all.
  const t = el('div', { class: 'toast' }, el('b', {}, `“${gone.title}” moved to the bin`), el('div', { class: 'toast-actions' }, el('button', {
    class: 'btn small',
    onclick: async () => {
      t.remove();
      try {
        const { path } = await api.notebook.restore(gone.trashed, gone.path);
        landed = path;
        await loadList();
        openNote(path);
      } catch (err) {
        toastError(err);
      }
    },
  }, 'Undo')));
  pushToast(t, 10000);
}

function askAbout() {
  if (!current) return;
  flush();
  switchView('chat');
  const input = $('#input');
  if (!input) return;
  input.value = `About my note [[${current.title}]]: `;
  input.dispatchEvent(new Event('input'));
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

async function followLink(target) {
  const name = String(target || '').split('/').pop().toLowerCase();
  const hit = notes.find((n) => n.title.toLowerCase() === name);
  if (hit) return openNote(hit.path);
  // Like Obsidian: a link to a note that doesn't exist yet creates it.
  toast(`New note: ${target}`);
  return newNote({ title: target });
}

// ------------------------------------------------------------------ [[ suggestions
let suggestBox = null;
let suggestions = [];
let picked = 0;

function suggest(body) {
  const before = body.value.slice(0, body.selectionStart);
  const m = before.match(/\[\[([^\]\n[]{0,60})$/);
  if (!m) return closeSuggest();
  const q = m[1].toLowerCase();
  suggestions = notes.filter((n) => n.path !== current?.path && n.title.toLowerCase().includes(q)).slice(0, 6);
  if (!suggestions.length) return closeSuggest();
  picked = 0;
  suggestBox ||= el('div', { class: 'note-suggest', role: 'listbox', 'aria-label': 'Link to a note' });
  suggestBox.replaceChildren(...suggestions.map((n, i) => el('div', { class: `note-suggest-item${i === picked ? ' on' : ''}`, role: 'option', 'aria-selected': String(i === picked), onmousedown: (e) => (e.preventDefault(), insertLink(body, n.title)) }, n.title, n.folder ? el('span', { class: 'muted' }, ` · ${n.folder}`) : '')));
  if (!suggestBox.isConnected) body.parentElement.append(suggestBox);
}

function onSuggestKey(e, body) {
  if (!suggestBox?.isConnected) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    picked = (picked + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length;
    [...suggestBox.children].forEach((c, i) => (c.classList.toggle('on', i === picked), c.setAttribute('aria-selected', String(i === picked))));
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    insertLink(body, suggestions[picked].title);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSuggest();
  }
}

function insertLink(body, title) {
  const at = body.selectionStart;
  const before = body.value.slice(0, at).replace(/\[\[([^\]\n[]{0,60})$/, `[[${title}]]`);
  const after = body.value.slice(at).replace(/^\]\]/, '');
  body.value = before + after;
  body.setSelectionRange(before.length, before.length);
  closeSuggest();
  body.dispatchEvent(new Event('input'));
}

function closeSuggest() {
  suggestBox?.remove();
}

// ------------------------------------------------------------------ brain dump
/** A blank page over everything: just write. From anywhere with Ctrl+Shift+N. */
export function openDump(prefill = '') {
  if (currentView !== 'notes') switchView('notes');
  if ($('#notesDumpLayer')) return $('#notesDumpLayer textarea').focus();
  const area = el('textarea', { class: 'dump-area', placeholder: 'Just write.\n\nThe first line becomes the title. Ctrl+Enter saves and gives you a fresh page; Esc saves and closes.', 'aria-label': 'Brain dump' });
  area.value = prefill || store.get(DRAFT_KEY) || '';
  const counter = el('span', { class: 'dump-count', 'aria-live': 'off' });
  const saved = el('span', { class: 'dump-saved', role: 'status', 'aria-live': 'polite' });
  let total = 0;
  const update = () => {
    const w = (area.value.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
    counter.textContent = `${w} word${w === 1 ? '' : 's'}${total ? ` · ${total} note${total === 1 ? '' : 's'} saved` : ''}`;
    store.set(DRAFT_KEY, area.value || null);
  };
  const keep = async () => {
    const text = area.value.trim();
    if (!text) return false;
    const lines = text.split('\n');
    const first = lines.find((l) => l.trim()) || '';
    const title = first.replace(/^\s{0,3}#{1,6}\s+/, '').trim();
    const short = title.length <= 80;
    const body = short ? lines.slice(lines.indexOf(first) + 1).join('\n').replace(/^\n+/, '') : text;
    const { path } = await api.notebook.create({ title: short ? title : title.slice(0, 60).replace(/\s+\S*$/, ''), body, folder: 'Inbox' });
    landed = path;
    total++;
    store.set(DRAFT_KEY, null);
    emit('note-saved');
    saved.textContent = `✓ “${path.split('/').pop().replace(/\.md$/, '')}” saved to your Inbox`;
    saved.classList.remove('show');
    void saved.offsetWidth;
    saved.classList.add('show');
    return path;
  };
  const close = async () => {
    try {
      const path = await keep();
      layer.classList.add('leaving');
      setUnder(false);
      setTimeout(() => layer.remove(), 180);
      await loadList();
      if (path) openNote(path, { keepFocus: true });
    } catch (err) {
      toastError(err);
    }
  };
  area.addEventListener('input', update);
  area.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') (e.preventDefault(), close());
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      try {
        if (await keep()) {
          area.value = '';
          update();
          area.classList.remove('fresh');
          void area.offsetWidth;
          area.classList.add('fresh');
        }
      } catch (err) {
        toastError(err);
      }
    }
  });
  const layer = el(
    'div',
    { class: 'dump-layer', id: 'notesDumpLayer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Brain dump' },
    el('div', { class: 'dump-top' }, el('span', { class: 'dump-label' }, '⚡ Brain dump'), saved, el('span', { class: 'spacer' }), counter, el('button', { class: 'btn small', type: 'button', onclick: () => close() }, 'Done (Esc)')),
    area,
  );
  // The notes under the page are out of reach (keyboard and screen reader) until it closes.
  const setUnder = (off) => {
    for (const child of $('#view-notes').children) if (child !== layer) child.inert = off;
  };
  $('#view-notes').append(layer);
  setUnder(true);
  update();
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
}
