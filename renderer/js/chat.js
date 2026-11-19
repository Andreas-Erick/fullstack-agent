// Chat view: conversation history, streaming messages, tool-call chips, voice integration.
import { $, api, el, renderMarkdown, timeAgo, toast, toastActions, toastError, confirmDialog, promptDialog, on, emit } from './util.js';
import { bargeIn, bargeInOver } from './bargein.js';
import * as redo from './redocore.mjs';
import { switchView, currentView } from './nav.js';
import { currentUsage } from './usage.js';
import { practiceLanguage, quoteFilter } from './practice.js';
import { state, setFlag, setCaption, ttsActive, saveSettings, loadSettings, raiseAlert, celebrate } from './state.js';
import { logEvent } from './util.js';
import * as chatcore from './chatcore.js';
import { initAttach, takeAttachments, restoreAttachments, attachmentCount, attachmentsReading, attachmentsReady, attachmentsSummary, setSendBusy } from './attach.js';
import * as attachcore from './attachcore.mjs';
import { showNote } from './notes.js';
import { showVaultNote, searchVault } from './knowledge.js';
import { speaker } from './voice.js';
import { handoffSlot } from './handoff.js';
import * as historycore from './historycore.mjs';
import { initHistory, closeHistory, queryChanged, messageHits, searchOlder, forgetHit, historyOpen, keepFocus, restoreFocus } from './history.js';

let currentId = null;
let conversations = [];
let active = null;
let queued = null; // message waiting for the interrupted turn to finish // { requestId, bubble, text, tools: Map, wrap, renderQueued }
let shown = []; // the open conversation's messages as stored (hidden ones too), kept in step
let openSetup = false;
let editing = null; // { messageId, draft }: ✎ Edit put the latest message in the box (draft: what was there)
let openSeq = 0; // the latest openConversation (newer ones and New chat win)

const messagesEl = () => $('#messages');

export function initChat() {
  emptyTemplate = $('#emptyState').cloneNode(true);
  $('#emptyState').replaceWith(emptyStateNode());
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('input', suggestSkills);
  input.addEventListener('keydown', (e) => {
    if (slashPick(e)) return;
    // ↑ in an empty box: the latest message back in it, to change and send again (as in a terminal).
    if (e.key === 'ArrowUp' && !input.value && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !busy()) {
      const id = redo.actions(shown, { setup: openSetup }).edit;
      if (id) {
        e.preventDefault();
        startEdit(id);
        return;
      }
    }
    if (e.key === 'Escape' && editing) {
      e.preventDefault();
      e.stopPropagation(); // only the edit: the window's Esc (stop speaking, a reply) waits for the next press
      cancelEdit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFromInput();
    }
  });
  $('#sendBtn').onclick = sendFromInput;
  $('#stopBtn').onclick = stop;
  $('#newChatBtn').onclick = () => newChat();
  $('#newChatTop').onclick = () => newChat(); // ＋ in the header: History (and its ＋) slides over the chat where there is no room
  $('#convSearch').addEventListener('input', () => queryChanged($('#convSearch').value));
  $('#chatTitle').ondblclick = renameCurrent;
  initHistory({ render: renderConvList, refresh: refreshList });
  // [[Note]] links in replies open the note (click, or Enter on a focused one).
  for (const box of [messagesEl(), $('#replyCard')]) for (const type of ['click', 'keydown']) box.addEventListener(type, onNoteLink);
  initReplyCard();
  $('#editCancel').onclick = () => cancelEdit();
  document.querySelectorAll('.suggestion').forEach((b) => (b.onclick = () => send(b.textContent)));

  $('#speakToggle').onclick = async () => {
    await saveSettings({ voice: { autoSpeak: !state.settings.voice.autoSpeak } });
    if (!state.settings.voice.autoSpeak) speaker.stop();
  };
  on('settings', updateSpeakToggle);
  initAttach();

  api.on('chat:event', handleEvent);
  api.on('routine:event', (ev) => ev.type === 'finished' && refreshList()); // its run shows in History
  loadSkillList();
  on('skills-changed', loadSkillList);

  // "↓ Latest" appears when you scrolled up away from the newest message.
  const box = messagesEl();
  const latest = $('#scrollLatest');
  box.addEventListener('scroll', () => {
    latest.classList.toggle('hidden', box.scrollHeight - box.scrollTop - box.clientHeight < 300);
    if (box.scrollTop < 200) showEarlier();
  });
  latest.onclick = () => {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    latest.classList.add('hidden');
  };
  // Talking over the agent silences the rest of this reply, unless it answers an approval or turns out
  // to be nothing (bargein.js).
  on('barge-in', () => bargeIn(active, { approvalPending: Boolean(state.approvalPending) }));
  on('barge-in-over', () => bargeInOver(active));

  // Open (and so warm) the user's own latest chat, not a routine's run that came after it.
  refreshList().then(() => {
    const c = chatcore.launchConversation(conversations);
    if (c) openConversation(c.id, { quiet: true });
  });
}

function updateSpeakToggle() {
  const b = $('#speakToggle');
  const on_ = state.settings.voice.ttsEnabled && state.settings.voice.autoSpeak;
  b.textContent = on_ ? '🔊 Voice on' : '🔇 Voice off';
  b.classList.toggle('off', !on_);
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(220, t.scrollHeight)}px`;
}

let waitingFiles = null; // a send waiting for its attachments to be read (attachcore.sendPlan)
// A reply being written, or a message waiting for its files: either way the latest exchange isn't settled,
// so Try again, Regenerate and Edit wait (one started meanwhile was stopped by it, or sent in its place).
const busy = () => Boolean(active || waitingFiles);

function sendFromInput() {
  const input = $('#input');
  const text = input.value.trim();
  if (editing) {
    // ✎ Edit: the latest message again, in its new words (main/redo.js).
    const { messageId, draft } = editing;
    endEdit();
    input.value = '';
    autosize();
    runAgain('edit', messageId, text).then((started) => {
      // What was typed meanwhile stays. Refused: the edited text stays as a draft (an empty edit gives the old draft back).
      if (!input.value) input.value = started || !text ? draft : text;
      autosize();
    });
    return;
  }
  // A message already queued behind the reply being stopped counts as waiting: this one stays in the box,
  // so the two can't go out in reverse order (the later one interrupting the earlier one's reply).
  const plan = attachcore.sendPlan({ text, files: attachmentCount(), reading: attachmentsReading(), active: Boolean(active), waiting: Boolean(waitingFiles || queued) });
  if (plan === 'none' || plan === 'hold') return;
  if (plan === 'wait') return waitForFiles(sendFromInput); // the text stays in the box meanwhile
  input.value = '';
  autosize();
  send(text, { attach: true });
}

function waitForFiles(then) {
  setSendBusy(true, attachmentCount());
  waitingFiles = attachmentsReady().finally(() => {
    waitingFiles = null;
    setSendBusy(false);
    syncActions();
    then();
  });
  syncActions(); // ✎ / ↻ step aside meanwhile
}

// ------------------------------------------------------------- conversations
const LIST_PAGE = 100;
let listLimit = LIST_PAGE;

export async function refreshList() {
  conversations = await api.conv.list().catch(() => []);
  renderConvList();
}

// History's list (the side panel, or the drawer over the chat: history.js). Titles that hold every word
// of the search come first, in date groups; then, once main has looked (conv:search), the chats whose
// messages hold them, each with the sentence around the words. Returns the counts for the live region.
function renderConvList() {
  const q = $('#convSearch').value;
  const words = historycore.terms(q);
  const list = $('#convList');
  const kept = keepFocus(list);
  list.innerHTML = '';
  const startToday = new Date().setHours(0, 0, 0, 0);
  const groups = [
    ['Today', (c) => c.updatedAt >= startToday],
    ['Yesterday', (c) => c.updatedAt >= startToday - 86400000 && c.updatedAt < startToday],
    ['This week', (c) => c.updatedAt >= startToday - 7 * 86400000 && c.updatedAt < startToday - 86400000],
    ['Earlier', (c) => c.updatedAt < startToday - 7 * 86400000],
  ];
  const filtered = conversations.filter((c) => historycore.matchesAll(c.title || '', words));
  // A page at a time: years of conversations shouldn't all become list rows (search covers them all).
  const page = filtered.slice(0, listLimit);
  for (const [label, test] of groups) {
    const items = page.filter(test);
    if (!items.length) continue;
    list.append(el('li', { class: 'conv-group' }, label));
    for (const c of items) list.append(convRow(c, { words }));
  }
  if (filtered.length > page.length) {
    list.append(el('li', {}, el('button', { class: 'btn ghost conv-more', type: 'button', onclick: () => ((listLimit += LIST_PAGE), renderConvList()) }, `Show more (${filtered.length - page.length} older)`)));
  }
  // What was said: the chats already found by their title aren't repeated, and one deleted since (Settings →
  // Clear all conversations) isn't listed.
  const byId = new Map(conversations.map((c) => [c.id, c]));
  const h = messageHits(q, byId);
  let hitRows = 0;
  if (h) {
    const titled = new Set(filtered.map((c) => c.id));
    const found = h.items.filter((x) => !titled.has(x.id));
    hitRows = found.length;
    if (found.length) list.append(el('li', { class: 'conv-group' }, 'In messages'));
    for (const hit of found) list.append(convRow(byId.get(hit.id), { words, hit }));
    const status = historycore.hitStatus({ state: h.state, shown: h.items.length, done: h.done, capped: h.capped, scanned: h.scanned, total: h.total, unreadable: h.unreadable });
    const older = h.state === 'done' && !h.done && h.cursor;
    if (status || older) list.append(el('li', { class: 'conv-status' }, status ? el('span', {}, status) : null, older ? el('button', { class: 'btn ghost small', type: 'button', onclick: searchOlder }, 'Search older chats') : null));
  }
  list.classList.toggle('stale', Boolean(h?.stale || h?.state === 'searching'));
  const pending = h && (h.state !== 'done' || h.cursor);
  if (!filtered.length && !hitRows && !pending) list.append(el('li', { class: 'muted', style: { padding: '10px', fontSize: '13px' } }, q.trim() ? 'No matches.' : 'No conversations yet.'));
  restoreFocus(list, kept);
  return { titles: filtered.length, shown: hitRows, found: h?.items.length || 0 };
}

// One row: the title (search words marked), for a message hit the sentence around them and who said it
// when; ✕ deletes (Delete on the row does the same). `c` is the index entry, also for a hit (its title is
// current after a rename, and it knows a routine's chat).
function convRow(c, { words, hit = null }) {
  const name = chatcore.historyTitle(c); // a routine's conversation is marked ⏰
  const meta = hit ? `${hit.role === 'user' ? 'You' : hit.persona || agentName()} · ${timeAgo(hit.at)}${hit.hits > 1 ? ` · ${hit.hits} messages` : ''}` : `${c.count} messages · ${timeAgo(c.updatedAt)}`;
  const open = el(
    'button',
    { class: 'conv-open', type: 'button', title: name.tip, 'aria-current': c.id === currentId ? 'true' : null, onclick: () => openFromHistory(c.id, hit?.messageId || null) },
    el('span', { class: 't' }, marked(name.text, historycore.marks(name.text, words))),
    hit ? el('span', { class: 's' }, marked(hit.snippet?.text || '', hit.snippet?.marks)) : null,
    el('span', { class: 'd' }, meta),
  );
  const x = el('button', { class: 'x', type: 'button', tabindex: '-1', title: 'Delete (Del)', 'aria-label': `Delete “${name.text}”`, onclick: () => deleteConversation(c) }, '✕');
  return el('li', { class: `conv-item${hit ? ' conv-hit' : ''}${c.id === currentId ? ' active' : ''}`, 'data-id': c.id, 'data-kind': hit ? 'hit' : 'title' }, open, x);
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
  const items = [...list.querySelectorAll('.conv-item')];
  const i = items.findIndex((n) => n.dataset.id === c.id);
  const near = items[i + 1] || items[i - 1] || null;
  const next = near ? { id: near.dataset.id, kind: near.dataset.kind, part: 'open' } : null;
  const back = (row) => (inPanel || historyOpen()) && restoreFocus(list, { scroll: list.scrollTop, row, button: '' });
  if (!(await confirmDialog('Delete conversation', `Delete “${c.title || 'Untitled'}”? This cannot be undone.`, 'Delete'))) return back({ id: c.id, kind: items[i]?.dataset.kind, part: 'open' });
  try {
    await api.conv.delete(c.id);
  } catch (err) {
    return toastError(err);
  }
  forgetHit(c.id);
  if (c.id === currentId) newChat({ focus: false });
  await refreshList();
  if (inPanel || historyOpen()) {
    if (next) back(next);
    else $('#convSearch').focus({ preventScroll: true });
  }
}

async function renameCurrent() {
  if (!currentId) return;
  const title = await promptDialog('Rename conversation', $('#chatTitle').textContent);
  if (!title) return;
  await api.conv.rename(currentId, title);
  $('#chatTitle').textContent = title;
  refreshList();
}

export function newChat({ focus = true } = {}) {
  openSeq++; // an open still loading must not land after this
  if (active) stop();
  closeCard(); // closed, not just hidden: the stopped reply's last text and its 'aborted' must not bring it back
  if (focus) closeHistory({ focus: false });
  cancelEdit();
  currentId = null;
  earlier = [];
  shown = [];
  openSetup = false;
  $('#chatTitle').textContent = 'New conversation';
  messagesEl().innerHTML = '';
  messagesEl().append(emptyStateNode());
  renderConvList();
  if (focus) $('#input').focus();
}

let emptyTemplate = null;
function emptyStateNode() {
  const node = emptyTemplate.cloneNode(true);
  node.querySelectorAll('.suggestion').forEach((b) => (b.onclick = () => send(b.textContent)));
  const name = state.settings?.agent?.name || 'Siren';
  node.querySelector('#welcomeTitle').textContent = `${name} online`;
  node.querySelector('#welcomeGreeting').textContent = state.settings?.appearance?.greeting || '';
  node.querySelector('#pttHint').textContent = state.settings?.stt?.pttKey || 'F8';
  node.querySelector('.suggestions').before(handoffSlot(openConversation)); // "Where we left off"
  return node;
}

// at: a message to show (History's search found it there); card: in the Face layout, it (or the latest
// reply) on the card; quiet: the launch's open (a chat that is gone just starts a new one).
export async function openConversation(id, { at = null, card = false, quiet = false } = {}) {
  if (active) return toast('Wait for the current reply to finish (or press stop).');
  const seq = ++openSeq;
  const conv = await api.conv.get(id).catch(() => null);
  if (seq !== openSeq || active) return; // a newer open, New chat, or a message sent meanwhile wins
  if (!conv) {
    if (quiet) return newChat(); // launch: the latest chat is gone, start fresh as before
    refreshList();
    return toast('This conversation couldn’t be opened: it was deleted, or it can’t be read on this computer.', 'error');
  }
  hideCard();
  cancelEdit();
  currentId = conv.id;
  shown = conv.messages.slice();
  openSetup = Boolean(conv.setup);
  $('#chatTitle').textContent = conv.title;
  const box = messagesEl();
  box.innerHTML = '';
  if (!conv.messages.length) box.append(emptyStateNode());
  // The latest messages first; older ones are added when you scroll up (or press the button).
  earlier = conv.messages.filter((m) => !m.hidden);
  const recent = earlier.splice(-MESSAGE_PAGE);
  for (const m of recent) box.append(messageNode(m));
  updateEarlierButton();
  box.scrollTop = box.scrollHeight;
  renderConvList();
  api.llm.prewarm(conv.id).catch(() => {});
  syncActions();
  const revealed = at && revealMessage(at);
  // The Face layout's card shows one thing: the message asked for (History), else a recent failure,
  // else (opened from History) the latest reply.
  if (faceLayout()) {
    if (card && revealed) cardFor(conv, at);
    else if (!showFailedCard() && card) cardFor(conv, null);
  }
}

const MESSAGE_PAGE = 40;
let earlier = []; // messages of the open conversation not rendered yet (oldest first)

function updateEarlierButton() {
  const box = messagesEl();
  let btn = box.querySelector('.show-earlier');
  if (!earlier.length) return btn?.remove();
  if (!btn) {
    btn = el('button', { class: 'btn ghost show-earlier', onclick: () => showEarlier() });
    box.prepend(btn);
  }
  btn.textContent = `Show ${Math.min(MESSAGE_PAGE, earlier.length)} earlier messages (${earlier.length} in all)`;
}

// Adds the previous page above the first message, keeping what you are looking at in place.
function showEarlier() {
  const box = messagesEl();
  if (!earlier.length || !box.querySelector('.show-earlier')) return; // another view (setup) replaced the messages
  const page = earlier.splice(-MESSAGE_PAGE);
  const before = box.scrollHeight;
  const anchor = box.querySelector('.show-earlier')?.nextSibling || box.firstChild;
  const frag = document.createDocumentFragment();
  for (const m of page) frag.append(messageNode(m));
  box.insertBefore(frag, anchor);
  updateEarlierButton();
  box.scrollTo({ top: box.scrollTop + box.scrollHeight - before, behavior: 'instant' }); // .messages scrolls smoothly; this must not
}

// A message History's search found: earlier pages are added until it is there, then it is centred and
// lit for a moment (.msg.found). False when it isn't in the open conversation (hidden, or no id).
const FOUND_MS = 2600;
function revealMessage(id) {
  const box = messagesEl();
  const find = () => box.querySelector(`.msg[data-id="${CSS.escape(String(id))}"]`);
  let node = find();
  if (!node && !earlier.some((m) => m.id === id)) return false;
  while (!node && earlier.length && box.querySelector('.show-earlier')) {
    showEarlier();
    node = find();
  }
  if (!node) return false;
  node.scrollIntoView({ block: 'center', behavior: 'instant' });
  node.classList.add('found');
  setTimeout(() => node.classList.remove('found'), FOUND_MS);
  return true;
}

// The Face layout hides the list: the message found (or, without one, the latest reply) on the card,
// with who said it and when.
function cardFor(conv, at) {
  const list = conv.messages.filter((m) => !m.hidden);
  const m = at ? list.find((x) => x.id === at) : list.findLast((x) => x.role === 'assistant' && (x.content || '').trim());
  if (!m) return;
  const d = chatcore.describeMessage(m, TOOL_LABELS);
  if (!d.text.trim()) return;
  const who = m.role === 'user' ? 'You' : m.persona || agentName();
  const when = new Date(Number(m.createdAt) || NaN);
  const date = Number.isFinite(when.getTime()) ? when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const kicker = at ? `${who}${date ? ` · ${date}` : ''}` : `Latest reply${date ? ` · ${date}` : ''}`;
  // A reply gets the card's buttons (Copy; Regenerate and Edit when it is the latest), as after 'done'.
  showCard(d.text, { plain: !d.markdown, kicker, at: m.id || null, ...(m.role === 'assistant' ? { reply: m } : {}) });
}

// A row in History: the chat opens (at the message the search found), and the drawer makes way. While a
// reply is being written nothing opens, and the drawer stays.
async function openFromHistory(id, at) {
  if (active) return toast('Wait for the current reply to finish (or press stop).');
  closeHistory({ focus: false });
  await openConversation(id, { at, card: true });
  $('#input').focus({ preventScroll: true });
}

// ------------------------------------------------------------------ messages
function avatarNode(role) {
  const a = el('div', { class: 'avatar' });
  if (role === 'assistant') {
    if (state.settings.agent.avatar) a.style.backgroundImage = `url(${state.settings.agent.avatar})`;
    else a.textContent = (state.settings.agent.name || 'N')[0].toUpperCase();
  } else a.textContent = 'YOU'.slice(0, 1);
  return a;
}

function toolChip(t) {
  const c = chatcore.toolChip(t, TOOL_LABELS);
  return el(
    'details',
    { class: `tool-chip ${c.state === 'running' ? '' : c.state}` },
    el('summary', {}, el('span', { class: 'st' }), el('span', {}, c.label), el('span', { class: 'muted' }, c.brief)),
    el('pre', {}, c.detail),
  );
}

const TOOL_LABELS = {
  create_pdf: '📄 Created a PDF',
  vault_links: '🔗 Looked at a note’s links',
  quick_note: '📝 Jotted a note',
  skill_list: '⚡ Listed skills',
  skill_run: '⚡ Ran a skill',
  skill_file: '⚡ Read a skill file',
  diagram_save: '📐 Drew a diagram',
  chart_create: '📈 Drew a chart',
  globe_open: '🌍 Opened the globe',
  browser_open: '🌐 Opened a page in the agent window',
  browser_read: '🌐 Read the page',
  browser_look: '🌐 Looked at the agent window',
  browser_act: '🌐 Acted on the page',
  browser_close: '🌐 Closed the agent window',
  skill_import: '⚡ Imported skills',
  skill_save: '⚡ Saved a skill',
  skill_delete: '⚡ Deleted a skill',
  look_at_screen: '🖥 Looked at your screen',
  learning_update: '🎓 Updated your learning tracker',
  learning_overview: '🎓 Checked your learning',
  vocab_add: '🗂 Added to your deck',
  vocab_review: '🗂 Picked cards to review',
  vocab_grade: '🗂 Graded a card',
  language_practice: '🗣 Language practice',
  stream_observe: '🧠 Noted an observation',
  stream_recall: '🧠 Searched the memory stream',
  stream_reflect: '✨ Reflected on recent observations',
  world_status: '🏡 Looked in on the Inner World',
  world_resident: '🏡 Visited a resident',
  world_simulate: '🏡 Wrote today in the Inner World',
  rehearsal_run: '🎭 Ran a rehearsal',
  routine_list: '⏰ Listed routines',
  routine_save: '⏰ Saved a routine',
  routine_delete: '⏰ Deleted a routine',
  routine_run: '⏰ Ran a routine',
  app_guide: '🧭 Looked up what I can do',
  capabilities_for: '🧩 Checked which skills and connectors fit',
  setup_add_persona: '🎭 Added a persona',
  persona_list: '🎭 Listed personas',
  persona_switch: '🎭 Switched persona',
  theme_get: '🎨 Checked my look',
  theme_update: '🎨 Changed my look',
  setup_scan_hardware: '🖥 Checked the hardware',
  memory_save: '🧠 Saved memory',
  memory_update: '🧠 Updated memory',
  memory_delete: '🧠 Deleted memory',
  memory_search: '🧠 Searched memory',
  calendar_get_events: '📅 Checked schedule',
  calendar_list_entries: '📅 Looked up schedule',
  calendar_add_event: '📅 Added to schedule',
  calendar_update_event: '📅 Changed schedule',
  calendar_delete_event: '📅 Removed from schedule',
  voice_list: '🎙 Listed voices',
  voice_design: '🎙 Designed a voice',
  voice_clone: '🎙 Cloned a voice',
  voice_calibrate: '🎙 Calibrated your voice',
  github_list_repos: '🐙 Listed repositories',
  github_repo: '🐙 Looked at a repository',
  github_issues: '🐙 Read issues',
  github_pull_requests: '🐙 Read pull requests',
  github_read_file: '🐙 Read a file',
  github_search: '🐙 Searched code',
  github_clone: '🐙 Cloned a repository',
  github_start_branch: '🐙 Started a branch',
  github_status: '🐙 Checked repo status',
  github_change_file: '🐙 Changed a file',
  github_commit: '🐙 Committed',
  github_push: '🐙 Pushed to GitHub',
  github_create_pull_request: '🐙 Opened a pull request',
  voice_delete: '🎙 Deleted a voice',
  vault_search: '🔎 Searched vault',
  vault_read_note: '📓 Read note',
  vault_list_notes: '📓 Listed notes',
  vault_write_note: '✍ Wrote note',
  vault_delete_note: '🗑 Deleted note',
  web_search: '🌐 Searched the web',
  web_fetch: '🌐 Read web page',
  WebSearch: '🌐 Searched the web',
  WebFetch: '🌐 Read web page',
  ToolSearch: '🔌 Looked up a connector',
  connectors_list: '🔌 Checked your connectors',
  connector_permission: '🔌 Changed a connector’s permission',
  tasks_save: '🗓 Updated the calendar’s tasks',
  Skill: '⚡ Loaded a plugin skill',
  code_list_files: '💾 Listed source files',
  code_read_file: '💾 Read source',
  code_search: '💾 Searched source',
  code_grep: '💾 Searched source (exact)',
  code_outline: '💾 Outlined a file',
  code_map: '🗺 Mapped its architecture',
  code_diff: '🛠 Reviewed its changes',
  run_tests: '🧪 Ran its tests',
  code_edit_file: '🛠 Edited own code',
  code_write_file: '🛠 Wrote own code',
  code_check: '🛠 Checked code',
  self_change_commit: '✦ Recorded self-change',
  self_change_plan: '✦ Proposed a self-change',
  setup_get_state: '⚙ Checked its setup',
  setup_configure: '⚙ Configured itself',
  setup_profile: '👤 Noted about you',
  setup_generate_look: '✨ Redesigned its look',
  setup_pick_image: '🖼 Asked for an image',
  setup_register_vault: '◆ Added vault to Obsidian',
  setup_check_service: '🔌 Checked a connection',
  setup_request_secret: '🔒 Asked for a key (secure field)',
  setup_complete: '✓ Finished setup',
  memory_get: '🧠 Recalled memories',
  daily_note_log: '📔 Logged to daily note',
  priorities_update: '📌 Updated priorities',
  profile_update: '👤 Updated your profile',
  job_save: '🧭 Saved a job procedure',
  job_add_lesson: '🧭 Added a lesson',
  vault_note_history: '⟲ Checked note history',
  vault_restore_note: '⟲ Restored a note',
  history_search: '🔎 Searched past chats',
  diagnose: '🩺 Ran diagnostics',
  read_app_log: '🩺 Read its log',
  analyze_errors: '🩺 Analyzed its errors',
  helper_app_start: '🔌 Started a helper app',
  settings_read: '⚙ Read its settings',
  settings_update: '⚙ Changed a setting',
  brain_options: '🧠 Checked its brains',
  brain_switch: '🧠 Switched brain',
  tools_more: '🧰 Got more tools',
  hand_over: '🧠 Handed to Claude',
  Read: '💾 Read file',
  Edit: '🛠 Edited file',
  Write: '🛠 Wrote file',
  Glob: '💾 Listed files',
  Grep: '💾 Searched files',
  Bash: '⌨ Ran command',
  open_document: '📄 Opened document',
  close_document: '📄 Closed document',
  find_document: '🔎 Looked for a file',
  list_monitors: '🖥 Checked monitors',
  identify_monitors: '🖥 Showed monitor numbers',
  move_window: '🖥 Moved a window',
  set_window_state: '🖥 Changed a window',
  create_bug_report: '🐞 Wrote a bug report',
  read_document: '📄 Read document',
  list_recent_documents: '📄 Recent documents',
};
// What a message shows is worked out in chatcore.js (pure, tested); here it becomes nodes.
function messageNode(m) {
  const d = chatcore.describeMessage(m, TOOL_LABELS);
  const wrap = el('div', { class: `msg ${m.role}`, 'data-id': m.id, ...(m.pending ? { 'data-pending': m.pending } : {}) });
  const body = el('div', { class: 'msg-body' });
  if (m.toolCalls?.length) body.append(el('div', { class: 'tools' }, m.toolCalls.map(toolChip)));
  const bubble = el('div', { class: 'bubble' });
  if (d.markdown) {
    bubble.innerHTML = renderMarkdown(d.text, { wikilinks: 'open' });
    bubble.dataset.stamp = stamp(m);
    decorateCode(bubble);
  } else bubble.textContent = d.text;
  if (d.tags.length) body.append(el('div', { class: 'msg-tag' }, d.tags.map((t) => el('span', {}, t))));
  if (m.attachments?.length) body.append(filesNode(m.attachments));
  if (d.text || !m.attachments?.length) body.append(bubble); // files alone: no empty bubble
  body.append(metaNode(m));
  wrap.append(avatarNode(m.role), body);
  return wrap;
}

// The files and pictures a message carried (attachcore.chipFor): a sent file's chip opens its copy in Documents.
function filesNode(list) {
  return el(
    'div',
    { class: 'msg-files' },
    list.map((a) => {
      const c = attachcore.chipFor(a);
      const parts = [c.thumb ? el('img', { src: c.thumb, alt: '' }) : el('span', { class: 'i', 'aria-hidden': 'true' }, c.icon), el('span', { class: 'n' }, c.name)];
      if (!c.path) return el('span', { class: 'attach-chip', title: `${c.name}\n${c.detail}` }, parts);
      const open = () => import('./docs.js').then((m) => m.openDocument(c.path)).catch(toastError);
      return el('button', { class: 'attach-chip', type: 'button', title: `${c.name}\n${c.detail}\nOpen the copy kept with this conversation`, onclick: open }, parts);
    }),
  );
}

// The telemetry line the HUD shows on a reply (hud.css): "NEXUS · 14:32:05 · OPUS 5.5".
const agentName = () => state.settings?.agent?.name || 'Siren';
const stamp = (m) => chatcore.stampText(m, agentName(), new Date(m.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

function metaNode(m) {
  const meta = el('div', { class: 'msg-meta' }, el('span', {}, new Date(m.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  if (m.model) meta.append(el('span', {}, m.model));
  // Nothing to copy (files without a word, a reply that only used tools): no Copy that empties the clipboard.
  const copy = chatcore.copyText(m);
  if (copy) meta.append(el('button', { onclick: () => (navigator.clipboard.writeText(copy), toast('Copied')) }, 'Copy'));
  if (m.role === 'assistant') {
    meta.append(
      el('button', { onclick: () => speaker.say(m.content || '') }, 'Speak'),
      el('button', { title: 'Save this reply as a note in your vault Inbox', onclick: () => api.notes.quick(m.content || '').then((r) => toast(`Saved to ${r.path}`), toastError) }, 'Save as note'),
      el('button', {
        title: 'Save this reply as a PDF',
        onclick: () => {
          const title = `${$('#chatTitle').textContent || 'Reply'} – ${new Date(m.createdAt || Date.now()).toLocaleDateString()}`;
          api.pdf.fromMarkdown(title, m.content || '').then((r) => toast(`Saved ${r.path}`), toastError);
        },
      }, 'PDF'),
    );
  }
  return meta;
}

function scrollToBottom(force = false) {
  const box = messagesEl();
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------- reply card
// The Face layout hides the conversation, so the latest reply shows on a card over the face: as it is
// written when it isn't spoken (voice off or muted, or past voice.speakLimit: "the rest is on the screen"),
// else when it is done. It goes away with the next message, ✕, Esc, "Open in chat" or another layout.
const faceLayout = () => $('#view-chat').classList.contains('layout-face');
const replyCard = () => $('#replyCard');

function initReplyCard() {
  $('#replyCardClose').onclick = closeCard;
  $('#replyCardOpen').onclick = openCardInChat;
  replyCard().addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation(); // only the card: the window's Esc (stop speaking, leave full screen) waits for the next press
    closeCard();
  });
  // Leaving the Face layout puts it away; it comes back with the next reply, not with the layout.
  on('settings', (s) => {
    if (s?.ui?.chatLayout === 'face') return;
    hideCard();
    // The bubble the Face layout left behind while the reply streams, filled at once and followed to its end as
    // the hidden list was before. Scrolled in the next frame: app.js applies the new layout after this listener,
    // and the narrower list makes the text taller (Open in chat scrolls there too, after saveSettings).
    if (active?.behind) {
      active.behind = false;
      active.bubble.innerHTML = renderMarkdown(active.text, { wikilinks: 'open' });
      requestAnimationFrame(() => active && scrollToBottom(true));
    }
  });
  // The card sits between the header (two rows in a narrow window) and the composer, however tall a draft
  // makes it (the box grows to 220px): the room they take, as --header-clear and --composer-clear
  // (styles.css). Layout offsets, not screen boxes, so a view's entrance transform doesn't skew them. Set
  // on the view, so the face panel beside .chat-main (same top) reads them too: its state label sits below
  // the header.
  const main = replyCard().parentElement;
  const view = main.parentElement;
  const header = main.querySelector('.chat-header');
  const composer = main.querySelector('.composer');
  const clear = () => {
    if (!main.clientHeight) return; // the view is hidden
    view.style.setProperty('--header-clear', `${Math.ceil(header.offsetTop + header.offsetHeight)}px`);
    view.style.setProperty('--composer-clear', `${Math.ceil(main.clientHeight - composer.offsetTop)}px`);
  };
  const watch = new ResizeObserver(clear);
  for (const node of [header, composer, $('#voiceStatus')]) watch.observe(node);
}

// follow: a live card keeps the newest text in view (as the caption it replaces did), unless the user
// scrolled up to read; a card that just appeared starts at the top. error: in the error colour, like the bubble.
// help: a failed reply (chatcore.errorHelp) with its buttons; reply: the finished one (Copy…); stopped: Try again.
// plain: text as it is (a message of the user's); kicker: who and when (History); at: the message shown.
let cardAt = null; // the message the card shows, for "Open in chat"
function showCard(md, { follow = false, error = false, help = null, reply = null, stopped = false, plain = false, kicker = 'Latest reply', at = null, html = null } = {}) {
  const body = $('#replyCardBody');
  const visible = !replyCard().classList.contains('hidden');
  const atEnd = visible && body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  const k = replyCard().querySelector('.reply-card-kicker');
  if (k.textContent !== kicker) {
    k.textContent = kicker; // runs every frame while a reply streams: only when it changes
    replyCard().setAttribute('aria-label', kicker);
  }
  if (plain) body.textContent = md;
  else body.innerHTML = html ?? (md ? renderMarkdown(md, { wikilinks: 'open' }) : '');
  if (help) body.append(errorNode(help, { retry: true }));
  else if (!follow) decorateCode(body);
  body.classList.toggle('error-bubble', error);
  cardAt = at || reply?.id || null;
  fillCardActions({ follow, help, reply, stopped });
  replyCard().classList.remove('hidden');
  if (!visible) body.scrollTop = 0;
  else if (follow && atEnd) body.scrollTop = body.scrollHeight;
}

function hideCard() {
  const card = replyCard();
  const focused = card.contains(document.activeElement);
  card.classList.add('hidden');
  if (focused) $('#input').focus({ preventScroll: true });
}

// Put away by the user: it stays away for the rest of this reply.
function closeCard() {
  if (active) active.cardClosed = true;
  hideCard();
}

// The whole conversation instead (Split; the setting as the voice command saves it, so no layout.js import),
// opened at the message the card showed (one History found), else at the latest reply, at once (.messages
// scrolls smoothly; a layout switch must not). The 'settings' event has applied the layout by the time
// saveSettings resolves.
async function openCardInChat() {
  const at = cardAt;
  hideCard();
  await saveSettings({ ui: { chatLayout: 'split', showVisualizerInChat: true } });
  if (at && revealMessage(at)) return;
  const box = messagesEl();
  box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });
}

// A [[note]] link: the note in Notes (the user's own, Notes/ and Inbox/) or in the Vault (any other note),
// or a vault search when there is no such note. A click in the chat never creates one.
function onNoteLink(e) {
  const a = e.target.closest('a.wikilink');
  if (!a || (e.type === 'keydown' && e.key !== 'Enter')) return;
  e.preventDefault();
  openNoteLink(a.dataset.note);
}

async function openNoteLink(ref) {
  const n = await api.obsidian.read(ref).catch(() => null);
  if (!n) {
    toast(`No note called “${ref}” in your vault yet.`);
    return searchVault(ref);
  }
  // Notes/Notes.md and Inbox/Inbox.md are the folders' own lists (main/notebookcore.js isNotePath).
  if (/^(Notes|Inbox)\//.test(n.path) && !/^(Notes\/Notes|Inbox\/Inbox)\.md$/.test(n.path)) showNote(n.path);
  else showVaultNote(n.path);
}

// --------------------------------------------------------------------- send
// Spoken input: interrupts a reply in progress (the old turn is stopped and drained), then sends.
export function sendVoice(text) {
  const input = $('#input');
  if (!state.settings.stt.autoSend) {
    input.value = (input.value ? `${input.value} ` : '') + text;
    autosize();
    closeHistory({ focus: false }); // otherwise the composer is inert
    input.focus();
    return;
  }
  if (waitingFiles || queued) {
    // A message is waiting for its files to be read, or queued behind the reply being stopped: these words
    // wait in the box (attachcore.sendPlan 'hold'), never in its place.
    input.value = (input.value ? `${input.value} ` : '') + text;
    autosize();
    toast(waitingFiles ? 'Still reading your file; your words are in the box.' : 'Your last message goes first; these words are in the box.');
    return;
  }
  if (active) {
    queued = { text, voice: true, attach: true };
    stop();
    return;
  }
  send(text, { voice: true, attach: true });
}

// redo: Try again / Regenerate / Edit (runAgain), sent as chat:redo; main takes the old exchange out; kept:
// the files it keeps (shown on it until the stored copy comes). attach: the composer's attachments go with
// this message (the user's own words, typed or spoken); a suggestion, a skill run, a redo or the setup flow
// never takes them.
export async function send(text, { voice = false, hidden = false, attach = false, redo: again = null, kept = [] } = {}) {
  text = String(text || '').trim();
  const withFiles = attach && !hidden && !again && !state.setupMode && attachmentCount() > 0;
  if (!text && !withFiles && !again) return; // a redo may have no words of its own (a message of files only)
  if (editing) cancelEdit({ keepText: true }); // another message went first: the box keeps the edit as a draft
  if (active) {
    if (again) return; // runAgain checked first; a reply that started since wins
    queued = { text, voice, attach };
    toast('Interrupting the current reply…');
    stop();
    return;
  }
  if (withFiles && attachmentsReading()) return waitForFiles(() => send(text, { voice, attach }));
  speaker.stop();
  hideCard();
  closeHistory({ focus: false });
  $('#emptyState')?.remove();
  messagesEl().querySelector('.empty-state')?.remove();

  const requestId = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const sharing = !$('#screenThumb').classList.contains('hidden') && state.settings.screen?.attachToMessages !== false;
  const slash = text.match(/^\/([\w-]+)/);
  const files = withFiles ? takeAttachments() : { tokens: [], meta: [] };
  const showing = files.meta.length ? files.meta : again ? kept : [];
  if (!hidden) messagesEl().append(messageNode({ id: 'pending-user', pending: requestId, role: 'user', content: text, display: text, ...(showing.length ? { attachments: showing } : {}), createdAt: Date.now(), screen: sharing, skill: slash && skillList.some((x) => x.slug === slash[1].toLowerCase()) ? slash[1].toLowerCase() : null }));
  const wrap = el('div', { class: 'msg assistant' });
  const body = el('div', { class: 'msg-body' });
  const tools = el('div', { class: 'tools' });
  const bubble = el('div', { class: 'bubble streaming', 'data-stamp': `${agentName()} · live` });
  body.append(tools, bubble);
  wrap.append(avatarNode('assistant'), body);
  messagesEl().append(wrap);
  scrollToBottom(true);

  // During language practice, notes in a blockquote are shown but not spoken (practice.js).
  active = { requestId, wrap, body, bubble, toolsEl: tools, text: '', tools: new Map(), muted: false, speech: practiceLanguage(state.settings) ? quoteFilter() : (d) => d };
  setFlag('generating', true);
  setFlag('streamingText', false);
  setCaption(text || (showing.length ? attachmentsSummary(showing) : ''), 'user');
  // A spoken message hears something within a moment, even when the reply starts with tools or thinking.
  if (voice && ttsActive() && state.settings.voice.filler) {
    const turn = active;
    turn.fillerTimer = setTimeout(() => {
      if (active !== turn || turn.muted || turn.text.trim() || state.toolsRunning) return;
      const line = chatcore.earlyFiller(text);
      if (line) speaker.filler(line);
    }, chatcore.EARLY_FILLER_MS);
  }
  $('#sendBtn').classList.add('hidden');
  $('#stopBtn').classList.remove('hidden');

  try {
    const res = again ? await api.chat.redo({ ...again, requestId }) : await api.chat.send({ conversationId: currentId, text, requestId, voice, hidden, attachments: files.tokens });
    if (res?.refused) return refusedSend(res.refused, text, requestId, wrap);
    currentId = res.conversationId;
  } catch (err) {
    restoreAttachments(files);
    finish();
    bubble.classList.add('error-bubble');
    bubble.textContent = err.message;
    if (again) (toast(err.message, 'error'), openConversation(currentId)); // nothing was dropped on the computer
  }
}

// An attachment expired before the message was stored (main/attachments.js claim): nothing was sent.
// The message shown while sending goes; the words come back to an empty box.
function refusedSend(message, text, requestId, wrap) {
  finish();
  messagesEl().querySelector(`.msg[data-pending="${CSS.escape(requestId)}"]`)?.remove();
  wrap.remove();
  const input = $('#input');
  if (!input.value) ((input.value = text), autosize());
  toast(message, 'error');
  syncActions();
}

function stop() {
  if (active) api.chat.abort(active.requestId).catch(() => {});
  speaker.stop();
}

function renderActive() {
  if (!active || active.renderQueued) return;
  active.renderQueued = true;
  requestAnimationFrame(() => {
    if (!active) return;
    active.renderQueued = false;
    // The Face layout hides the message list: its bubble gets the text when the reply ends ('done', 'error',
    // 'aborted' render it) or when the layout changes (initReplyCard); only the card, when it shows the text, renders now.
    const face = faceLayout();
    const onCard = !replyCard().classList.contains('hidden');
    // Read on the card as it is written when it isn't spoken (cardLive) or no longer is (speakLimit reached);
    // once up it follows the text, also after a retract (whose speaker.stop() clears capped).
    const toCard = face && !active.cardClosed && (active.cardLive || speaker.capped || onCard);
    active.behind = face;
    if (face && !toCard) return;
    const html = renderMarkdown(active.text, { wikilinks: 'open' });
    if (toCard) showCard(active.text, { follow: true, html });
    else {
      active.bubble.innerHTML = html;
      scrollToBottom();
    }
  });
}

function handleEvent(ev) {
  if (!active || ev.requestId !== active.requestId) return;
  switch (ev.type) {
    case 'start': {
      currentId = ev.conversationId;
      $('#chatTitle').textContent = ev.title || 'Conversation';
      if (ev.replaces) dropFrom(ev.replaces, { keep: active.wrap }); // the unanswered copy this message replaces
      // The stored message (its id for ✎ Edit, its files' saved paths) in place of the one shown while sending.
      const pending = messagesEl().querySelector(`.msg[data-pending="${CSS.escape(active.requestId)}"]`);
      if (pending && ev.userMessage) pending.replaceWith(messageNode(ev.userMessage));
      if (ev.userMessage) shown.push(ev.userMessage);
      syncActions();
      refreshList();
      break;
    }
    case 'text':
      active.text += ev.delta;
      if (!state.streamingText) setFlag('streamingText', true);
      if (ttsActive() && !active.muted) speaker.feed(active.speech(ev.delta));
      else {
        active.cardLive = true; // not spoken: in the Face layout it is read on the card as it comes
        setCaption(active.text.slice(-280), 'assistant');
      }
      renderActive();
      break;
    case 'retract':
      active.text = active.text.slice(0, Math.max(0, active.text.length - ev.chars));
      speaker.stop();
      renderActive();
      break;
    case 'thinking':
      break;
    case 'tool_start': {
      setFlag('toolsRunning', state.toolsRunning + 1);
      const chip = toolChip({ name: ev.name, input: ev.input });
      active.tools.set(ev.id, { chip, input: ev.input });
      if (ttsActive() && state.settings.voice.filler && !active.muted && !active.text.trim()) speaker.filler(chatcore.fillerFor(ev.name));
      active.toolsEl.append(chip);
      scrollToBottom();
      break;
    }
    case 'tool_end': {
      setFlag('toolsRunning', Math.max(0, state.toolsRunning - 1));
      const prev = active.tools.get(ev.id);
      const chip = toolChip({ name: ev.name, input: prev?.input, ok: ev.ok, preview: ev.preview });
      prev ? prev.chip.replaceWith(chip) : active.toolsEl.append(chip);
      active.tools.set(ev.id, { chip, input: prev?.input });
      break;
    }
    case 'notice': {
      // Tools an earlier attempt or reply ran (main.js, a message sent again): named as the chips name them;
      // cut: calls that never reported back, so maybe never done.
      const label = (names) => names.map((n) => chatcore.toolLabel(n, TOOL_LABELS)).join(', ');
      const said = [ev.tools?.length ? `Already done by the earlier attempt or reply (not undone): ${label(ev.tools)}.` : '', ev.cut?.length ? `Cut off before it reported back (check before repeating): ${label(ev.cut)}.` : ''].filter(Boolean).join(' ');
      const text = `⚠ ${said || ev.message}`;
      active.body.insertBefore(el('div', { class: 'notice' }, text), active.bubble);
      if (ev.toast) toast(text); // the Face layout hides the list
      break;
    }
    case 'memory_changed':
      emit('memory-changed');
      break;
    case 'open_document':
      emit('open-document', ev.path);
      break;
    case 'vault_changed':
      emit('vault-changed', ev.path);
      break;
    case 'self_changed':
      emit('self-changed', ev.change);
      break;
    case 'setup_complete':
      emit('setup-complete', ev.summary);
      break;
    case 'setup_pick_image':
      emit('setup-pick-image');
      break;
    case 'settings_changed':
      loadSettings();
      break;
    case 'persona_switched':
      active.greeting = ev.greeting; // spoken in the new voice after this reply (done)
      break;
    case 'calendar_changed':
      emit('calendar-changed');
      break;
    case 'skills_changed':
      emit('skills-changed');
      break;
    case 'world_changed':
      emit('world-changed');
      break;
    case 'voice_preview':
      if (state.settings.voice.ttsEnabled) speaker.say(ev.text, { voice: ev.voice });
      break;
    case 'done': {
      const m = ev.message;
      active.bubble.classList.remove('streaming');
      active.bubble.innerHTML = renderMarkdown(m.content || '', { wikilinks: 'open' });
      active.wrap.dataset.id = m.id;
      shown.push(m);
      // The finished reply on the card (the voice, if on, goes on reading; the mini caption steps aside).
      // A turn that only used tools has nothing to read: no empty card.
      if (faceLayout() && !active.cardClosed) {
        if ((m.content || '').trim()) showCard(m.content, { reply: m });
        else hideCard();
      }
      announce(`${agentName()}: ${active.bubble.textContent}`);
      decorateCode(active.bubble); // after announce: its text must not read "Copy"
      active.bubble.dataset.stamp = stamp(m);
      active.body.append(metaNode(m));
      if (ttsActive() && !active.muted) speaker.flush();
      // A switch by voice: the new persona greets the user in its own voice, after the reply.
      if (active.greeting) {
        const greeting = active.greeting;
        loadSettings().then(() => ttsActive() && speaker.follow(greeting, { remember: true, firstAlone: true })).catch(() => {});
      }
      finish();
      if (!ttsActive()) celebrate();
      refreshList();
      syncActions();
      break;
    }
    case 'error':
    case 'aborted': {
      active.bubble.classList.remove('streaming');
      const failed = ev.type === 'error';
      markAttempt(failed ? 'failed' : 'stopped', ev.message); // main stored the full record
      const retryId = redo.actions(shown, { setup: openSetup }).again; // the message Try again sends, if any
      const help = failed ? chatcore.errorHelp(ev.message, { usage: currentUsage(), settings: state.settings }) : null;
      const onCard = !replyCard().classList.contains('hidden');
      if (failed) {
        // What was written before it failed, then the reason in plain words with the way out (Details: the raw text).
        active.bubble.innerHTML = active.text ? renderMarkdown(active.text, { wikilinks: 'open' }) : '';
        if (active.text) decorateCode(active.bubble);
        active.bubble.append(errorNode(help, { retry: Boolean(retryId), messageId: retryId }));
        active.bubble.classList.add('error-bubble');
      } else active.bubble.innerHTML = renderMarkdown(active.text || '*(stopped)*', { wikilinks: 'open' });
      // On the card: an error always (the Face layout shows nothing else); a stop only where it was being read.
      if (faceLayout() && !active.cardClosed && (failed || onCard)) {
        if (failed) showCard(active.text, { help, error: true });
        else showCard(active.text || '*(stopped)*', { stopped: true });
      }
      if (failed) {
        // Where the failure is in view, a short notice; elsewhere (another view, the card closed) one with the buttons.
        const seen = currentView === 'chat' && (!faceLayout() || !active.cardClosed);
        const convId = currentId;
        if (seen || !retryId) toast(`⚠ ${help.title}`, 'error', 6000);
        else toastActions(`⚠ ${help.title}. ${help.text}`, [['Try again', () => retryIn(convId, retryId)], ...(help.action ? [[help.action.label, () => runHelpAction(help.action)]] : [])]);
        announce(`Error: ${help.title}. ${help.text}`);
        raiseAlert(help.title);
        // 'info': main.js already logs the failed turn as an error, with its stack (one problem report, not two).
        logEvent('info', 'reply failed', ev.message);
      }
      finish();
      refreshList();
      syncActions();
      break;
    }
  }
}

// The finished reply for screen readers (#chatLive is aria-live; the message list itself is not, or
// every streamed word and every loaded conversation would be read out).
function announce(text) {
  const live = $('#chatLive');
  if (!live) return;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  live.textContent = '';
  setTimeout(() => (live.textContent = t.length > 1500 ? `${t.slice(0, 1500)}… (continued in the conversation)` : t), 50);
}

// ------------------------------------------- actions on the latest message
// Try again on a failed or stopped reply, ↻ Regenerate a reply, ✎ Edit and resend the latest message
// (redocore.mjs decides which message; main/redo.js checks again). There is no undo: the old exchange
// goes, what it did stays done, and the agent is told so.

/** The buttons under the latest exchange, after anything that changes it (open, start, done, error). */
function syncActions() {
  const box = messagesEl();
  box.querySelectorAll('.redo-btn, .msg-failed').forEach((n) => n.remove());
  const a = redo.actions(shown, { busy: busy(), setup: openSetup });
  // A failed reply's own Try again works only while it is the latest exchange.
  box.querySelectorAll('.reply-error .retry-btn').forEach((b) => (b.hidden = b.dataset.for !== a.again));
  if (!a.again) return;
  const userNode = box.querySelector(`.msg[data-id="${CSS.escape(a.again)}"]`);
  if (!userNode) return;
  userNode.querySelector('.msg-meta')?.append(redoButton('✎ Edit', 'Put this message back in the box to change it and send it again (↑). The old exchange is replaced; there is no undo.', () => startEdit(a.edit)));
  if (a.state === 'answered') {
    const replyNode = a.reply && box.querySelector(`.msg[data-id="${CSS.escape(a.reply)}"]`);
    const m = shown.find((x) => x.id === a.reply);
    const fresh = m?.provider === 'claude-code' ? ' (Claude starts a fresh session for it: a few seconds longer)' : '';
    replyNode?.querySelector('.msg-meta')?.append(redoButton('↻ Regenerate', `Write a new reply to your message; the old one is replaced, with no undo${fresh}`, () => runAgain('again', a.again)));
    return;
  }
  let reply = userNode.nextElementSibling;
  while (reply && !reply.matches('.msg.assistant')) reply = reply.nextElementSibling;
  if (reply) {
    // A reply that was stopped (or failed, with its own button): Try again under it.
    if (reply.querySelector('.reply-error')) return;
    const body = reply.querySelector('.msg-body');
    const meta = body.querySelector(':scope > .msg-meta') || body.appendChild(el('div', { class: 'msg-meta' }));
    meta.append(redoButton('↻ Try again', 'Send this message again (the stopped reply is replaced)', () => runAgain('again', a.again)));
    return;
  }
  // A conversation opened later: the failure (or the stop) under the message itself.
  const l = redo.latest(shown);
  const attempt = l.user.attempt || {};
  const node = !l.certain
    ? stopNode('This message got no reply.', a.again)
    : attempt.outcome === 'failed'
      ? errorNode(chatcore.errorHelp(attempt.error || '', { usage: currentUsage(), settings: state.settings }), { retry: true, messageId: a.again })
      : stopNode('Stopped.', a.again);
  userNode.querySelector('.msg-body').append(el('div', { class: 'msg-failed' }, node));
  scrollToBottom(true); // the conversation just opened at its end: the card is part of it
}

const redoButton = (label, title, onclick) => el('button', { class: 'redo-btn', type: 'button', title, onclick }, label);

// A stopped (or cut off) message's line with its Try again.
function stopNode(text, messageId) {
  return el('div', { class: 'reply-error stopped', role: 'group', 'aria-label': text }, el('p', {}, text), el('div', { class: 'reply-error-actions' }, el('button', { class: 'btn small primary retry-btn', type: 'button', 'data-for': messageId, onclick: () => runAgain('again', messageId) }, '↻ Try again')));
}

/** The failure in plain words with its way out (built with el(): no HTML from the message). */
function errorNode(help, { retry = false, messageId = null } = {}) {
  const id = messageId || redo.actions(shown, { setup: openSetup }).again;
  const buttons = el(
    'div',
    { class: 'reply-error-actions' },
    retry && id ? el('button', { class: 'btn small primary retry-btn', type: 'button', 'data-for': id, onclick: () => runAgain('again', id) }, '↻ Try again') : null,
    help.action ? el('button', { class: 'btn small', type: 'button', onclick: () => runHelpAction(help.action) }, help.action.label) : null,
  );
  return el(
    'div',
    { class: 'reply-error', role: 'group', 'aria-label': 'The reply failed' },
    el('div', { class: 'reply-error-title' }, `⚠ ${help.title}`),
    el('p', {}, help.text),
    buttons.childElementCount ? buttons : null,
    help.raw && help.raw !== help.text ? el('details', { class: 'reply-error-raw' }, el('summary', {}, 'Details'), el('pre', {}, help.raw)) : null,
  );
}

/** The way out a failure offers (chatcore.errorHelp action). */
function runHelpAction(a) {
  if (a.go === 'settings') return switchView('settings', a.section);
  if (a.go === 'helper') return api.helperApps.start(a.id).then(() => toast('Starting it… try again in a moment.'), toastError);
  if (currentView !== 'chat') switchView('chat');
  if (a.go === 'newchat') return newChat();
  if (a.go === 'edit') {
    const id = redo.actions(shown, { busy: busy(), setup: openSetup }).edit;
    if (id) startEdit(id);
  }
}

/** ✎ Edit: the latest message in the box; Enter sends it in place of the old exchange, Esc puts the draft back. */
function startEdit(id) {
  const m = shown.find((x) => x.id === id);
  if (waitingFiles) return toast('Still reading your file…'); // its message is sent once read: no edit in between
  if (!m || active) return;
  const input = $('#input');
  if (!editing) editing = { messageId: id, draft: input.value };
  else editing.messageId = id;
  input.value = redo.sentText(m);
  $('.composer').classList.add('editing');
  const files = (m.attachments || []).some((x) => x.kind !== 'image');
  $('#editText').textContent = `✎ Editing your last message: Enter sends it in place of the old one.${files ? ' Its files stay attached.' : ''}`;
  $('#editBar').classList.remove('hidden');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autosize();
  scrollToBottom(true); // the composer grew: the message being edited stays in view
}

/** Leaves edit mode; the box gets back what was in it before, unless keepText. */
function cancelEdit({ keepText = false } = {}) {
  if (!editing) return;
  const { draft } = editing;
  endEdit();
  if (!keepText) {
    $('#input').value = draft;
    autosize();
  }
}

// Leaves edit mode, the box as it is (the edit is being sent).
function endEdit() {
  editing = null;
  $('.composer')?.classList.remove('editing');
  $('#editBar')?.classList.add('hidden');
}

// The failed or stopped message as the window last saw it (main stored the full record).
function markAttempt(outcome, error) {
  const l = redo.latest(shown);
  if (!l?.own || l.state === 'answered') return;
  shown[l.index] = { ...l.user, attempt: { outcome, at: Date.now(), ...(outcome === 'failed' ? { error: String(error || '') } : {}) } };
}

/** Takes the latest exchange off the screen (main takes it out of the conversation). */
function dropFrom(id, { keep = null } = {}) {
  const node = messagesEl().querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (node) {
    let n = node.nextElementSibling;
    node.remove();
    while (n) {
      const next = n.nextElementSibling;
      if (n.classList.contains('msg') && n !== keep && !n.dataset.pending) n.remove();
      n = next;
    }
  }
  const i = shown.findIndex((m) => m.id === id);
  if (i >= 0) shown.splice(i);
  hideCard();
}

/**
 * Sends the latest message again: main checks it first (asking here when the old exchange already did
 * something, or when an attempt was cut off), then the old one goes and the new one is sent. True if sent.
 */
async function runAgain(kind, messageId, text = '') {
  if (busy()) return (toast(waitingFiles ? 'Still reading your file…' : 'Wait for the current reply to finish (or press stop).'), false);
  if (!currentId || !messageId) return false;
  const req = { conversationId: currentId, messageId, kind, text, expectLast: shown[shown.length - 1]?.id };
  const chk = await api.chat.redoCheck(req).catch((err) => ({ ok: false, error: err.message }));
  if (!chk.ok) {
    toast(chk.error, 'error');
    if (chk.changed) openConversation(currentId);
    return false;
  }
  if (chk.ask?.length || chk.more) {
    const label = (t) => `${chatcore.toolLabel(t.name, TOOL_LABELS)} ${typeof t.input === 'string' ? (t.input ? `· ${t.input.slice(0, 60)}` : '') : chatcore.briefInput(t.input)}`.trim();
    const ask = chk.ask || [];
    // A call cut off before it reported back (redocore.cutOff) may not have happened: never called done.
    const done = [...ask.filter((t) => !redo.cutOff(t)).map(label), ...(chk.more ? [`${chk.more} more action${chk.more === 1 ? '' : 's'}`] : [])].join(' · ');
    const cut = ask.filter(redo.cutOff).map(label).join(' · ');
    const what = chk.replyDropped ? 'reply' : 'attempt';
    const said = [done ? `The earlier ${what} already did this, and it isn’t undone: ${done}.` : '', cut ? `${done ? 'It was' : `The earlier ${what} was`} cut off while doing this, so it may or may not have happened: ${cut}.` : ''].filter(Boolean).join(' ');
    const told = cut ? `${agentName()} is told to check before doing it again` : `${agentName()} is told, so it shouldn’t do it twice`;
    if (!(await confirmDialog('Run it again?', `${said} ${told}; approvals follow your permission setting.`, 'Run again', false))) return false;
  } else if (chk.uncertain) {
    if (!(await confirmDialog('Try again?', `The earlier attempt was cut off (the app closed or restarted), so ${agentName()} can’t be sure what it already did. She’ll be told to check before repeating anything.`, 'Try again', false))) return false;
  }
  if (busy() || req.conversationId !== currentId) return false; // a reply started (or a message waits for its files), or another chat opened, meanwhile
  // The files it keeps show on it while it is sent (its pictures aren't kept); 'start' brings the stored copy.
  const kept = (shown.find((m) => m.id === messageId)?.attachments || []).filter((a) => a?.kind !== 'image');
  dropFrom(messageId);
  await send(chk.text, { voice: chk.voice, redo: { ...req, confirmed: true }, kept });
  return true;
}

/** Try again on the latest message (the voice command, a failed reply's button). True when something started. */
export async function retryLatest() {
  const a = redo.actions(shown, { busy: busy(), setup: openSetup });
  return a.again ? runAgain('again', a.again) : false;
}

/** Whether the latest reply failed or was stopped, so "try again" means it (commands.js). */
export function canRetryLatest() {
  const a = redo.actions(shown, { busy: busy(), setup: openSetup });
  return Boolean(a.again) && (a.state === 'unanswered' || a.state === 'stopped');
}

// From a notice while another view was open: back to that conversation, then Try again.
async function retryIn(convId, messageId) {
  if (currentView !== 'chat') switchView('chat');
  if (convId && convId !== currentId) await openConversation(convId);
  if (currentId === convId) runAgain('again', messageId);
}

/** In the Face layout, a recent failure (24 h) shows on the card when its conversation opens. True if shown. */
function showFailedCard() {
  if (!faceLayout()) return false;
  const a = redo.actions(shown, { setup: openSetup });
  const l = redo.latest(shown);
  if (!a.again || !l || l.state === 'answered') return false;
  const at = l.user.attempt?.at || l.replies[l.replies.length - 1]?.createdAt || l.user.createdAt || 0;
  if (Date.now() - at > 86400000) return false;
  if (l.certain && l.user.attempt?.outcome === 'failed') showCard('', { help: chatcore.errorHelp(l.user.attempt.error || '', { usage: currentUsage(), settings: state.settings }), error: true });
  else showCard(l.state === 'stopped' ? l.replies[l.replies.length - 1]?.content || '*(stopped)*' : l.certain ? '*(stopped)*' : 'This message got no reply.', { stopped: true });
  return true;
}

// The card's buttons: Copy, Regenerate and Edit on a finished reply; Try again and Edit after a stop
// (a failure's are in its own box).
function fillCardActions({ follow = false, help = null, reply = null, stopped = false } = {}) {
  const box = $('#replyCardActions');
  box.replaceChildren();
  if (follow || help) return;
  const a = redo.actions(shown, { busy: Boolean(waitingFiles), setup: openSetup }); // a finished or stopped reply: no reply runs now
  const button = (label, title, onclick) => el('button', { class: 'chip-btn', type: 'button', title, onclick }, label);
  const edit = () => a.edit && box.append(button('✎ Edit', 'Change your message and send it again (↑)', () => startEdit(a.edit)));
  if (reply) {
    box.append(button('Copy', 'Copy this reply', () => (navigator.clipboard.writeText(chatcore.copyText(reply)), toast('Copied'))));
    if (a.reply === reply.id) box.append(button('↻ Regenerate', 'Write a new reply; this one is replaced', () => runAgain('again', a.again)));
    if (a.reply === reply.id) edit();
  } else if (stopped && a.again) {
    box.append(button('↻ Try again', 'Send your message again', () => runAgain('again', a.again)));
    edit();
  }
}

/** Code blocks in a finished reply get their own Copy button (never while it streams, never in the error details). */
function decorateCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.closest('.reply-error, .code-block, .tool-chip')) continue;
    const wrap = el('div', { class: 'code-block' });
    pre.replaceWith(wrap);
    const copy = el('button', { class: 'code-copy', type: 'button', title: 'Copy code', 'aria-label': 'Copy code' }, 'Copy');
    copy.onclick = () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    };
    wrap.append(pre, copy);
  }
}

function finish() {
  clearTimeout(active?.fillerTimer);
  active = null;
  // The filler lines' audio, made in the quiet after a reply (speaker.filler plays only what is ready).
  if (ttsActive() && state.settings.voice.filler) speaker.warmFillers(chatcore.allFillers(), () => !active && !state.recording);
  state.toolsRunning = 0;
  if (queued) {
    const q = queued;
    queued = null;
    setTimeout(() => send(q.text, { voice: q.voice, attach: q.attach }), 0);
  }
  setFlag('generating', false);
  setFlag('streamingText', false);
  if (!speaker.busy) setCaption('');
  $('#sendBtn').classList.remove('hidden');
  $('#stopBtn').classList.add('hidden');
}

export function currentConversationId() {
  return currentId;
}

// Esc, or saying "cancel": stops the reply that is still being written (and its tools). True if there was one.
export function cancelReply() {
  const was = Boolean(active);
  stop();
  if (was) announce('Stopped.');
  return was;
}

// Continue in an existing conversation without re-rendering the message list (used by the setup
// flow, so the scripted first exchange stays on screen as the agent takes over).
export function continueIn(id, title) {
  currentId = id;
  openSetup = true;
  if (title) $('#chatTitle').textContent = title;
  refreshList();
}

// ------------------------------------------------------- /skill commands
// Typing "/" shows the saved skills; Tab or Enter completes the highlighted one.
let skillList = [];
let picker = null;

export async function loadSkillList() {
  skillList = await api.skills.list().catch(() => []);
}

function suggestSkills() {
  const input = $('#input');
  const m = input.value.match(/^\/([\w-]*)$/);
  picker?.el.remove();
  picker = null;
  if (!m) return;
  const matches = skillList.filter((s) => s.slug.startsWith(m[1].toLowerCase()) || s.name.toLowerCase().includes(m[1].toLowerCase())).slice(0, 6);
  if (!matches.length) return;
  const list = el('div', { class: 'dropdown-menu open slash-menu' });
  matches.forEach((s, i) => list.append(el('button', { class: i === 0 ? 'sel' : '', onclick: () => complete(s) }, el('b', {}, `/${s.slug}`), el('span', { class: 'muted' }, ` ${s.description || s.name}`))));
  $('.composer').append(list);
  picker = { el: list, matches, index: 0 };
}

function complete(s) {
  const input = $('#input');
  input.value = `/${s.slug} `;
  picker?.el.remove();
  picker = null;
  input.focus();
}

function slashPick(e) {
  if (!picker) return false;
  if (e.key === 'Escape') {
    e.preventDefault(); // only the suggestions close, not the reply (app.js setupShortcuts)
    picker.el.remove();
    picker = null;
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    picker.index = (picker.index + (e.key === 'ArrowDown' ? 1 : picker.matches.length - 1)) % picker.matches.length;
    [...picker.el.children].forEach((b, i) => b.classList.toggle('sel', i === picker.index));
    return true;
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    complete(picker.matches[picker.index]);
    return true;
  }
  return false;
}
