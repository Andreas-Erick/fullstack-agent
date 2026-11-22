// History: the chat's conversation panel (#convPanel). It keeps the conversation index (conv:list), draws
// the list a page at a time in date groups, searches titles at once and, a moment later, the words inside
// chats (conv:search in main), deletes a chat and puts the focus on its neighbour. Where the panel has no
// room of its own (the Face layout, windows ≤ 980 px) it slides over the chat as a drawer, opened by
// 🕘 History or Ctrl+H: a dialog, the rest of the chat inert, Tab inside, Esc back to the message box.
// Docked, the same button and key go to its search. What the list shows is historycore.listModel (pure).
// A leaf: chat.js hands in what it owns (initHistory: which chat is open, open one, start a new one), so
// this never imports chat.js; chat.js tells it when the list may have changed (refreshList, drawList).
import { $, api, el, on, timeAgo, confirmDialog, toastError, dialogOpen } from './util.js';
import { state } from './state.js';
import * as chatcore from './chatcore.js';
import * as core from './historycore.mjs';

const narrow = matchMedia('(max-width: 980px)');
const DEBOUNCE_MS = 250;
const INERT = ':scope > :is(.chat-main, .splitter, #facePanel)'; // not the scrim, not #chatLive
const FOCUSABLE = ':is(button, input, [tabindex]):not([tabindex="-1"]):not(:disabled)';

let conversations = []; // the index, newest first
let listLimit = core.LIST_PAGE;
let hits = core.HITS;
let timer = null;
let loadFailed = false; // the last conv:list failed: the list shown is the one before
let chat = { current: () => null, open: () => {}, newChat: () => {} };

/** chat: { current() → the open conversation's id, open(id, at) → a row was chosen (at: the message
 *  the search found), newChat() → the open conversation was deleted }. */
export function initHistory(handlers) {
  chat = { ...chat, ...handlers };
  $('#historyBtn').addEventListener('click', toggleHistory);
  $('#historyClose').addEventListener('click', () => closeHistory());
  $('#historyScrim').addEventListener('click', () => closeHistory());
  $('#convPanel').addEventListener('keydown', onPanelKey);
  $('#convSearch').addEventListener('input', () => queryChanged($('#convSearch').value));
  api.on('routine:event', (ev) => ev.type === 'finished' && refreshList()); // its run shows in History
  // A layout change or a wider window docks it: closed without moving focus (it is the same element).
  // From a microtask, after app.js's applyLayout, which hears the same event later.
  const settle = () => queueMicrotask(() => historyOpen() && historyDocked() && closeHistory({ focus: false }));
  narrow.addEventListener('change', settle);
  on('settings', settle);
  on('layout', settle);
  on('view', ({ name }) => name !== 'chat' && closeHistory({ focus: false }));
  on('files-added', () => closeHistory({ focus: false })); // a file dropped into the chat (attach.js)
}

// ------------------------------------------------------------------ the list
/** The index read again (a reply started or ended, a rename, a chat from the phone) and the list redrawn;
 *  resolves to the index. */
export async function refreshList() {
  // A failed read keeps the last list (never "No conversations yet.") and says so, with Try again.
  const list = await api.conv.list().catch(() => null); // handled below: the last list stays, with Try again
  loadFailed = !Array.isArray(list);
  if (!loadFailed) conversations = list;
  drawList();
  return conversations;
}

const agentName = () => state.settings?.agent?.name || 'Siren';

// Titles that hold every word of the search come first, in date groups; then, once main has looked
// (conv:search), the chats whose messages hold them, each with the sentence around the words. The focused
// row and the scroll position survive. Returns the counts for the live region.
export function drawList() {
  const q = $('#convSearch').value;
  const list = $('#convList');
  const kept = keepFocus(list);
  const m = core.listModel(conversations, { query: q, limit: listLimit, startToday: new Date().setHours(0, 0, 0, 0), hits });
  list.innerHTML = '';
  if (loadFailed) list.append(el('li', { class: 'conv-status failed' }, el('span', {}, '⚠ Couldn’t load History.'), el('button', { class: 'btn ghost small', type: 'button', onclick: () => refreshList() }, 'Try again')));
  for (const g of m.groups) {
    list.append(el('li', { class: 'conv-group' }, g.label));
    for (const c of g.items) list.append(convRow(c, { words: m.words }));
  }
  if (m.more > 0) {
    list.append(el('li', {}, el('button', { class: 'btn ghost conv-more', type: 'button', onclick: () => ((listLimit += core.LIST_PAGE), drawList()) }, `Show more (${m.more} older)`)));
  }
  if (m.searched) {
    if (m.found.length) list.append(el('li', { class: 'conv-group' }, 'In messages'));
    for (const { conv, hit } of m.found) list.append(convRow(conv, { words: m.words, hit }));
    if (m.status || m.older) list.append(el('li', { class: 'conv-status' }, m.status ? el('span', {}, m.status) : null, m.older ? el('button', { class: 'btn ghost small', type: 'button', onclick: searchOlder }, 'Search older chats') : null));
  }
  list.classList.toggle('stale', m.stale);
  if (m.empty && !(loadFailed && !conversations.length)) list.append(el('li', { class: 'muted', style: { padding: '10px', fontSize: '13px' } }, m.empty));
  restoreFocus(list, kept);
  return m.counts;
}

// One row: the title (search words marked), for a message hit the sentence around them and who said it
// when; ✕ deletes (Delete on the row does the same). `c` is the index entry, also for a hit (its title is
// current after a rename, and it knows a routine's chat).
function convRow(c, { words, hit = null }) {
  const name = chatcore.historyTitle(c); // a routine's conversation is marked ⏰
  const open_ = c.id === chat.current();
  const meta = hit ? `${hit.role === 'user' ? 'You' : hit.persona || agentName()} · ${timeAgo(hit.at)}${hit.hits > 1 ? ` · ${hit.hits} messages` : ''}` : `${c.count} messages · ${timeAgo(c.updatedAt)}`;
  const open = el(
    'button',
    { class: 'conv-open', type: 'button', title: name.tip, 'aria-current': open_ ? 'true' : null, onclick: () => chat.open(c.id, hit?.messageId || null) },
    el('span', { class: 't' }, marked(name.text, core.marks(name.text, words))),
    hit ? el('span', { class: 's' }, marked(hit.snippet?.text || '', hit.snippet?.marks)) : null,
    el('span', { class: 'd' }, meta),
  );
  const x = el('button', { class: 'x', type: 'button', tabindex: '-1', title: 'Delete (Del)', 'aria-label': `Delete “${name.text}”`, onclick: () => deleteConversation(c) }, '✕');
  return el('li', { class: `conv-item${hit ? ' conv-hit' : ''}${open_ ? ' active' : ''}`, 'data-id': c.id, 'data-kind': hit ? 'hit' : 'title' }, open, x);
}

// Text with the given [start, end) ranges in <mark>s (text nodes, never HTML).
function marked(text, ranges) {
  const out = [];
  let at = 0;
  for (const [s, e] of Array.isArray(ranges) ? ranges : []) {
    if (!(s >= at && e > s && e <= text.length)) continue;
    if (s > at) out.push(text.slice(at, s));
    out.push(el('mark', {}, text.slice(s, e)));
    at = e;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// Deleting from History keeps it open: focus goes to the next row (else the one before, else the search).
async function deleteConversation(c) {
  const list = $('#convList');
  const inPanel = $('#convPanel').contains(document.activeElement);
  const rows = [...list.querySelectorAll('.conv-item')].map((n) => ({ id: n.dataset.id, kind: n.dataset.kind }));
  const { next, self } = core.afterDelete(rows, c.id);
  const back = (row) => (inPanel || historyOpen()) && restoreFocus(list, { scroll: list.scrollTop, row, button: '' });
  if (!(await confirmDialog('Delete conversation', `Delete “${c.title || 'Untitled'}”? This cannot be undone.`, 'Delete'))) return back(self);
  try {
    await api.conv.delete(c.id);
  } catch (err) {
    return toastError(err);
  }
  forgetHit(c.id);
  if (c.id === chat.current()) chat.newChat();
  await refreshList();
  if (inPanel || historyOpen()) {
    if (next) back(next);
    else $('#convSearch').focus({ preventScroll: true });
  }
}

// ------------------------------------------------------------------ the drawer
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
  const to = core.rowTarget(e.key, list.indexOf(row), list.length);
  if (to !== undefined) {
    e.preventDefault();
    if (to < 0) search.focus();
    else list[to].focus();
  } else if (e.key === 'Delete') {
    e.preventDefault();
    row.closest('.conv-item')?.querySelector('.x')?.click();
  }
}

// ------------------------------------------------------------------ the message search
// The search box changed: titles at once (drawList), the messages after a pause (or `now`).
function queryChanged(query, { now = false } = {}) {
  clearTimeout(timer);
  const searchable = core.searchable(query);
  const had = hits.state !== 'idle';
  hits = core.hitsReducer(hits, { type: 'query', query, searchable });
  $('#convList').scrollTop = 0; // new words: the best matches, from the top
  if (!searchable) {
    if (had) api.conv.search('').catch(() => {}); // stops a search still running
    drawList();
    return;
  }
  drawList();
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
  const counts = drawList();
  // With the list's status line: a search that stopped early isn't "No matches."
  $('#convSearchStatus').textContent = core.resultSummary({ ...hits, ...counts });
}

// "Search older chats": the same words, from where the last search stopped.
function searchOlder() {
  if (!hits.cursor || hits.state !== 'done') return;
  const cursor = hits.cursor;
  hits = core.hitsReducer(hits, { type: 'more' });
  drawList();
  return run(hits.query, cursor);
}

const forgetHit = (id) => (hits = core.hitsReducer(hits, { type: 'forget', id }));

// ------------------------------------------------------------------ focus across a redraw
// The list is rebuilt after every reply's start and end (refreshList) and on each keystroke: the focused
// row (or button) and the scroll position come back.
function keepFocus(list) {
  const a = document.activeElement;
  const kept = { scroll: list.scrollTop, row: null, button: '' };
  if (!a || !list.contains(a)) return kept;
  const item = a.closest('.conv-item');
  if (item) kept.row = { id: item.dataset.id, kind: item.dataset.kind, part: a.classList.contains('x') ? 'x' : 'open' };
  else kept.button = a.classList.contains('conv-more') ? '.conv-more' : '.conv-status button';
  return kept;
}

function restoreFocus(list, kept) {
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
