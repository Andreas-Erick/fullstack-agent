// The History drawer: the chat's conversation panel (#convPanel, its list drawn by chat.js renderConvList)
// slides over the chat where it has no room of its own (the Face layout, windows ≤ 980 px), opened by
// 🕘 History or Ctrl+H. Open it is a dialog: the rest of the chat is inert, Tab stays inside, Esc closes it
// back to the message box. Docked, the same button and key go to its search. Also the search's state:
// titles are matched in chat.js at once, the words inside chats by main (conv:search) a moment later.
// A leaf: chat.js passes its list functions in (initHistory), so this never imports chat.js.
import { $, api, on, dialogOpen } from './util.js';
import * as core from './historycore.mjs';

const narrow = matchMedia('(max-width: 980px)');
const DEBOUNCE_MS = 250;
const INERT = ':scope > :is(.chat-main, .splitter, #facePanel)'; // not the scrim, not #chatLive
const FOCUSABLE = ':is(button, input, [tabindex]):not([tabindex="-1"]):not(:disabled)';

let hits = core.HITS;
let timer = null;
let renderList = () => ({});
let refreshList = () => Promise.resolve();

export function initHistory({ render, refresh }) {
  renderList = render;
  refreshList = refresh;
  $('#historyBtn').addEventListener('click', toggleHistory);
  $('#historyClose').addEventListener('click', () => closeHistory());
  $('#historyScrim').addEventListener('click', () => closeHistory());
  $('#convPanel').addEventListener('keydown', onPanelKey);
  // A layout change or a wider window docks it: closed without moving focus (it is the same element).
  // From a microtask, after app.js's applyLayout, which hears the same event later.
  const settle = () => queueMicrotask(() => historyOpen() && historyDocked() && closeHistory({ focus: false }));
  narrow.addEventListener('change', settle);
  on('settings', settle);
  on('layout', settle);
  on('view', ({ name }) => name !== 'chat' && closeHistory({ focus: false }));
  on('files-added', () => closeHistory({ focus: false })); // a file dropped into the chat (attach.js)
}

// A dialog, the setup wizard or the brain-dump page is in front: the drawer's keys stand aside.
const blocked = () => dialogOpen() || !$('#onboarding').classList.contains('hidden') || Boolean($('#notesDumpLayer'));

export const historyDocked = () => !$('#view-chat').classList.contains('layout-face') && !narrow.matches;
export const historyOpen = () => $('#view-chat').classList.contains('history-open');

function focusSearch() {
  const s = $('#convSearch');
  s.focus({ preventScroll: true });
  s.select();
}

/** 🕘 History / Ctrl+H: the drawer opens or closes; docked, the search (and back to the message box). */
export function toggleHistory() {
  if (blocked()) return;
  if (historyOpen()) return closeHistory();
  if (historyDocked()) {
    if ($('#convPanel').contains(document.activeElement)) return $('#input').focus();
    refreshList(); // chats started on the phone or the watch since
    return focusSearch();
  }
  openHistory();
}

function openHistory() {
  const view = $('#view-chat');
  const panel = $('#convPanel');
  refreshList();
  view.classList.add('history-open');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  $('#historyBtn').setAttribute('aria-expanded', 'true');
  for (const n of view.querySelectorAll(INERT)) n.inert = true;
  $('#chatMenu')?.classList.remove('open');
  window.addEventListener('keydown', onDrawerKey, true);
  focusSearch();
  const q = $('#convSearch').value;
  if (core.searchable(q)) queryChanged(q, { now: true }); // what was said may have changed meanwhile
  $('#convList .conv-item.active')?.scrollIntoView({ block: 'nearest' });
}

/** Closes the drawer (nothing when it is docked); `focus`: back to the message box. */
export function closeHistory({ focus = true } = {}) {
  if (!historyOpen()) return;
  window.removeEventListener('keydown', onDrawerKey, true);
  const view = $('#view-chat');
  const panel = $('#convPanel');
  view.classList.remove('history-open');
  panel.removeAttribute('aria-modal');
  panel.setAttribute('role', 'region');
  $('#historyBtn').setAttribute('aria-expanded', 'false');
  for (const n of view.querySelectorAll(INERT)) n.inert = false; // before focusing: an inert box can't take it
  if (focus) $('#input').focus({ preventScroll: true });
}

// ------------------------------------------------------------------ keys
const rows = () => [...$('#convList').querySelectorAll('.conv-open')];
const shown = (n) => n.getClientRects().length > 0;

// While the drawer is open (capture, so it comes before the window's own Esc: stop speaking, cancel).
function onDrawerKey(e) {
  if (!historyOpen() || blocked()) return;
  if (e.key === 'Escape' && !e.isComposing) {
    e.preventDefault();
    e.stopPropagation(); // the window's Esc chain waits for the next press
    closeHistory();
  } else if (e.key === 'Tab') trapTab(e);
}

function trapTab(e) {
  const panel = $('#convPanel');
  const a = document.activeElement;
  if (!(panel.contains(a) || !a || a === document.body || a.closest('[inert]'))) return;
  const list = [...panel.querySelectorAll(FOCUSABLE)].filter(shown);
  if (!list.length) return;
  e.preventDefault();
  const i = list.indexOf(a);
  const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : i < 0 || i === list.length - 1 ? 0 : i + 1;
  list[next].focus();
}

// Docked and open: ↓ from the search into the list, Enter opens the first, ↑ ↓ Home End move, Delete
// deletes; Esc in the side panel clears the search.
function onPanelKey(e) {
  if (blocked() || e.defaultPrevented) return;
  const search = $('#convSearch');
  if (e.key === 'Escape') {
    if (e.isComposing || historyOpen() || !search.value) return;
    e.preventDefault();
    e.stopPropagation();
    search.value = '';
    queryChanged('');
    return;
  }
  if (e.target === search) {
    const first = rows()[0];
    if (!first) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      first.focus();
    } else if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      first.click();
    }
    return;
  }
  const row = e.target.closest?.('.conv-open');
  if (!row) return;
  const list = rows();
  const i = list.indexOf(row);
  const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
  if (to !== undefined) {
    e.preventDefault();
    if (to < 0) search.focus();
    else list[Math.min(to, list.length - 1)].focus();
  } else if (e.key === 'Delete') {
    e.preventDefault();
    row.closest('.conv-item')?.querySelector('.x')?.click();
  }
}

// ------------------------------------------------------------------ the message search
/** The search box changed: titles at once (render), the messages after a pause (or `now`). */
export function queryChanged(query, { now = false } = {}) {
  clearTimeout(timer);
  const searchable = core.searchable(query);
  const had = hits.state !== 'idle';
  hits = core.hitsReducer(hits, { type: 'query', query, searchable });
  $('#convList').scrollTop = 0; // new words: the best matches, from the top
  if (!searchable) {
    if (had) api.conv.search('').catch(() => {}); // stops a search still running
    renderList();
    return;
  }
  renderList();
  if (now) run(query);
  else timer = setTimeout(() => run(query), DEBOUNCE_MS);
}

async function run(query, cursor = null) {
  clearTimeout(timer);
  const token = hits.token;
  try {
    const result = await api.conv.search(query, cursor ? { cursor } : {});
    hits = core.hitsReducer(hits, { type: 'result', token, result, append: Boolean(cursor) });
  } catch (err) {
    hits = core.hitsReducer(hits, { type: 'error', token, message: err?.message || String(err) });
  }
  if (token !== hits.token || hits.state === 'searching') return; // a newer query renders its own
  const counts = renderList() || {};
  // With the list's status line: a search that stopped early isn't "No matches."
  $('#convSearchStatus').textContent = core.resultSummary({ ...hits, titles: counts.titles || 0, shown: counts.shown || 0, found: counts.found || 0 });
}

/** "Search older chats": the same words, from where the last search stopped. */
export function searchOlder() {
  if (!hits.cursor || hits.state !== 'done') return;
  const cursor = hits.cursor;
  hits = core.hitsReducer(hits, { type: 'more' });
  renderList();
  return run(hits.query, cursor);
}

export const messageHits = (query, listed) => core.messageHits(hits, query, listed);
export const forgetHit = (id) => (hits = core.hitsReducer(hits, { type: 'forget', id }));

// ------------------------------------------------------------------ focus across a redraw
// The list is rebuilt after every reply's start and end (refreshList) and on each keystroke: the focused
// row (or button) and the scroll position come back.
export function keepFocus(list) {
  const a = document.activeElement;
  const kept = { scroll: list.scrollTop, row: null, button: '' };
  if (!a || !list.contains(a)) return kept;
  const item = a.closest('.conv-item');
  if (item) kept.row = { id: item.dataset.id, kind: item.dataset.kind, part: a.classList.contains('x') ? 'x' : 'open' };
  else kept.button = a.classList.contains('conv-more') ? '.conv-more' : '.conv-status button';
  return kept;
}

export function restoreFocus(list, kept) {
  list.scrollTop = kept.scroll;
  if (!kept.row && !kept.button) return;
  let target = null;
  if (kept.row) {
    const id = CSS.escape(kept.row.id || '');
    const item = list.querySelector(`.conv-item[data-id="${id}"][data-kind="${kept.row.kind}"]`) || list.querySelector(`.conv-item[data-id="${id}"]`);
    target = item?.querySelector(kept.row.part === 'x' ? '.x' : '.conv-open');
  } else target = list.querySelector(kept.button);
  if (target) target.focus({ preventScroll: true });
  else if (!document.activeElement || document.activeElement === document.body) $('#convSearch').focus({ preventScroll: true });
}
