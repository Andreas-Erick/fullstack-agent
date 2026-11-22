// Chat view: the open conversation (History's list is history.js), streaming messages, tool-call chips, voice integration.
import { $, api, el, renderMarkdown, toast, toastActions, toastError, confirmDialog, promptDialog, on, emit, plainError, dialogOpen } from './util.js';
import * as redo from './redocore.mjs';
import { createChat } from './turnstate.js';
import { switchView, currentView } from './nav.js';
import { currentUsage } from './usage.js';
import { practiceLanguage, quoteFilter } from './practice.js';
import { state, setFlag, setCaption, ttsActive, saveSettings, loadSettings, raiseAlert, celebrate } from './state.js';
import { logEvent } from './util.js';
import * as chatcore from './chatcore.js';
import { initAttach, tray, attachmentsSummary } from './attach.js';
import * as attachcore from './attachcore.mjs';
import { createOutbox } from './outbox.js';
import { showNote } from './notes.js';
import { showVaultNote, searchVault } from './knowledge.js';
import { speaker } from './voice.js';
import { handoffSlot } from './handoff.js';
import { initHistory, closeHistory, refreshList, drawList } from './history.js';
import { createReplyCard, scrollFor } from './replycard.js';

export { refreshList }; // the list read again (settings.js after Clear all, setup.js)

// The open conversation (its id, its messages as stored, the setup flag), this window's reply being written
// (chat.own: its text, tools, muted; turn.view: its nodes) and replies started on
// another device in it (chat.others), and what may be done to the latest exchange: turnstate.js, shared
// with the phone. This module draws it.
const chat = createChat({ redo });
// What leaves the composer, from any source (outbox.js): the wait for files, the message queued behind the
// reply being stopped, edit mode's draft, and the words and files given back on a refusal. This module
// draws what it decides.
const outbox = createOutbox({
  tray,
  box: {
    read: () => $('#input').value,
    write: (text) => (($('#input').value = text), autosize()),
  },
  turn: chat,
  deliver,
  again: runAgain,
  stop,
  notify: (text) => toast(text),
  setup: () => Boolean(state.setupMode),
  waitChanged: () => syncActions(),
  editEnded: () => {
    $('.composer')?.classList.remove('editing');
    $('#editBar')?.classList.add('hidden');
  },
});
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
      const id = chat.actions().edit;
      if (id) {
        e.preventDefault();
        startEdit(id);
        return;
      }
    }
    if (e.key === 'Escape' && outbox.editing) {
      e.preventDefault();
      e.stopPropagation(); // only the edit: the window's Esc (stop speaking, a reply) waits for the next press
      outbox.cancelEdit();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      outbox.typed();
    }
  });
  $('#sendBtn').onclick = () => outbox.typed();
  $('#stopBtn').onclick = stop;
  $('#newChatBtn').onclick = () => newChat();
  $('#newChatTop').onclick = () => newChat(); // ＋ in the header: History (and its ＋) slides over the chat where there is no room
  $('#chatTitle').ondblclick = renameCurrent;
  // F2 renames too, from anywhere in the chat view that isn't a text field.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F2' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
    const t = e.target;
    if (currentView !== 'chat' || dialogOpen() || t?.matches?.('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    renameCurrent();
  });
  initHistory({ current: () => chat.convId, open: openFromHistory, newChat: () => newChat({ focus: false }) });
  // [[Note]] links in replies open the note (click, or Enter on a focused one).
  for (const box of [messagesEl(), $('#replyCard')]) for (const type of ['click', 'keydown']) box.addEventListener(type, onNoteLink);
  initReplyCard();
  $('#editCancel').onclick = () => outbox.cancelEdit();
  document.querySelectorAll('.suggestion').forEach((b) => (b.onclick = () => send(b.textContent)));

  $('#speakToggle').onclick = async () => {
    await saveSettings({ voice: { autoSpeak: !state.settings.voice.autoSpeak } });
    if (!state.settings.voice.autoSpeak) speaker.stop();
  };
  on('settings', updateSpeakToggle);
  initAttach();

  api.on('chat:event', handleEvent);
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
    box.scrollTo({ top: box.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    latest.classList.add('hidden');
  };
  // Talking over the agent silences the rest of this reply, unless it answers an approval or turns out
  // to be nothing (turnstate.js bargeIn / bargeInOver).
  on('barge-in', () => chat.bargeIn({ approvalPending: Boolean(state.approvalPending) }));
  on('barge-in-over', () => chat.bargeInOver());

  // Open (and so warm) the user's own latest chat, not a routine's run that came after it.
  refreshList().then((list) => {
    const c = chatcore.launchConversation(list);
    if (c) openConversation(c.id, { quiet: true });
  });
}

function updateSpeakToggle() {
  const b = $('#speakToggle');
  const on_ = state.settings.voice.ttsEnabled && state.settings.voice.autoSpeak;
  b.textContent = on_ ? '🔊 Voice on' : '🔇 Voice off';
  b.classList.toggle('off', !on_);
  b.setAttribute('aria-pressed', String(on_));
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(220, t.scrollHeight)}px`;
}

// A reply being written in this conversation (here or on another device), or a message waiting for its
// files (the outbox tells turnstate): either way the latest exchange isn't settled, so Try again, Regenerate
// and Edit wait (one started meanwhile was stopped by it, or sent in its place). The rule is turnstate.js busy().
const busy = () => chat.busy();

// ------------------------------------------------------------- conversations
// The list of them is History's (history.js); chat tells it when the list may have changed.
async function renameCurrent() {
  const id = chat.convId;
  if (!id) return;
  const title = await promptDialog('Rename conversation', $('#chatTitle').textContent);
  if (!title) return;
  await api.conv.rename(id, title);
  $('#chatTitle').textContent = title;
  refreshList();
}

export function newChat({ focus = true } = {}) {
  openSeq++; // an open still loading must not land after this
  if (chat.own) stop();
  closeCard(); // closed, not just hidden: the stopped reply's last text and its 'aborted' must not bring it back
  if (focus) closeHistory({ focus: false });
  outbox.cancelEdit();
  chat.open({}); // a new conversation: no id, no messages
  earlier = [];
  $('#chatTitle').textContent = 'New conversation';
  messagesEl().innerHTML = '';
  messagesEl().append(emptyStateNode());
  drawList(); // no row is marked open now
  if (focus) $('#input').focus();
}

let emptyTemplate = null;
function emptyStateNode() {
  const node = emptyTemplate.cloneNode(true);
  node.querySelectorAll('.suggestion').forEach((b) => (b.onclick = () => send(b.textContent)));
  const name = state.settings?.agent?.name || 'Siren';
  node.querySelector('#welcomeTitle').textContent = name; // no status claim: the title bar's lights say whether the brain is ready
  node.querySelector('#welcomeGreeting').textContent = state.settings?.appearance?.greeting || '';
  node.querySelector('#pttHint').textContent = state.settings?.stt?.pttKey || 'F8';
  node.querySelector('.suggestions').before(handoffSlot(openConversation)); // "Where we left off"
  return node;
}

// at: a message to show (History's search found it there); card: in the Face layout, it (or the latest
// reply) on the card; quiet: the launch's open (a chat that is gone just starts a new one).
export async function openConversation(id, { at = null, card = false, quiet = false } = {}) {
  if (chat.own) return toast('Wait for the current reply to finish (or press stop).');
  const seq = ++openSeq;
  const conv = await api.conv.get(id).catch(() => null);
  if (seq !== openSeq || chat.own) return; // a newer open, New chat, or a message sent meanwhile wins
  if (!conv) {
    if (quiet) return newChat(); // launch: the latest chat is gone, start fresh as before
    refreshList();
    return toast('This conversation couldn’t be opened: it was deleted, or it can’t be read on this computer.', 'error');
  }
  hideCard();
  outbox.cancelEdit();
  chat.open({ id: conv.id, messages: conv.messages, setup: conv.setup }); // replies followed in the old list go with it
  $('#chatTitle').textContent = conv.title;
  const box = messagesEl();
  box.innerHTML = '';
  if (!conv.messages.length) box.append(emptyStateNode());
  // The latest messages first; older ones are added when you scroll up (or press the button).
  earlier = conv.messages.filter((m) => !m.hidden);
  const recent = earlier.splice(-MESSAGE_PAGE);
  for (const m of recent) box.append(settled(messageNode(m)));
  updateEarlierButton();
  box.scrollTop = box.scrollHeight;
  drawList(); // this one's row marked open
  api.llm.prewarm(conv.id).catch(() => {});
  syncActions();
  const revealed = at && revealMessage(at);
  // The Face layout's card shows one thing: the message asked for (History), else a recent failure,
  // else (opened from History) the latest reply (replycard.js).
  paintCard(cardState.opened({ messages: conv.messages, fromHistory: card, found: revealed ? at : null, failed: chat.failedCard(), agent: agentName() }));
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
// Messages drawn in bulk (a conversation opened, an earlier page) skip the entrance: forty bubbles rising at
// once is noise. A class on each node, never one toggled on the list: taking `animation: none` off later
// would start every entrance then.
function settled(node) {
  node.classList?.add('settled');
  return node;
}

function showEarlier() {
  const box = messagesEl();
  if (!earlier.length || !box.querySelector('.show-earlier')) return; // another view (setup) replaced the messages
  const page = earlier.splice(-MESSAGE_PAGE);
  const before = box.scrollHeight;
  const anchor = box.querySelector('.show-earlier')?.nextSibling || box.firstChild;
  const frag = document.createDocumentFragment();
  for (const m of page) frag.append(settled(messageNode(m)));
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

// A row in History: the chat opens (at the message the search found), and the drawer makes way. While a
// reply is being written nothing opens, and the drawer stays.
async function openFromHistory(id, at) {
  if (chat.own) return toast('Wait for the current reply to finish (or press stop).');
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
  const c = chatcore.toolChip(t);
  return el(
    'details',
    { class: `tool-chip ${c.state === 'running' ? '' : c.state}` },
    el('summary', {}, el('span', { class: 'st' }), el('span', {}, c.label), el('span', { class: 'muted' }, c.brief)),
    el('pre', {}, c.detail),
  );
}

// What a message shows is worked out in chatcore.js (pure, tested); here it becomes nodes.
function messageNode(m) {
  const d = chatcore.describeMessage(m);
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
const stamp = (m) => chatcore.replyStamp(m, agentName());

function metaNode(m) {
  const meta = el('div', { class: 'msg-meta' }, el('span', {}, new Date(m.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  if (m.model) meta.append(el('span', {}, m.model));
  // Nothing to copy (files without a word, a reply that only used tools): no Copy that empties the clipboard.
  const copy = chatcore.copyText(m);
  if (copy) meta.append(el('button', { onclick: () => navigator.clipboard.writeText(copy).then(() => toast('Copied'), toastError) }, 'Copy'));
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
// The Face layout hides the conversation, so the latest reply shows on a card over the face. What it shows
// (and when it goes) is replycard.js's decision; here it is painted.
const faceLayout = () => $('#view-chat').classList.contains('layout-face');
const replyCard = () => $('#replyCard');
const cardState = createReplyCard({ isFace: () => faceLayout() });

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
    const d = cardState.layout(s?.ui?.chatLayout === 'face', chat.own);
    if (!d) return;
    paintCard(d);
    // The bubble the Face layout left behind while the reply streams, filled at once and followed to its end as
    // the hidden list was before. Scrolled in the next frame: app.js applies the new layout after this listener,
    // and the narrower list makes the text taller (Open in chat scrolls there too, after saveSettings).
    if (d.fill) {
      const t = chat.own;
      t.view.bubble.innerHTML = renderMarkdown(t.text, { wikilinks: 'open' });
      requestAnimationFrame(() => chat.own && scrollToBottom(true));
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

// A decision of replycard.js on the screen: { type: 'show', card } | { type: 'hide' } | null (as it is).
function paintCard(d) {
  if (d?.type === 'show') showCard(d.card);
  else if (d?.type === 'hide') hideCardNode();
}

// A live card keeps the newest text in view (as the caption it replaces did), unless the user scrolled up to
// read; a card that just appeared starts at the top (replycard.scrollFor). An error: in the error colour, like
// the bubble, with chatcore.errorHelp's words and its buttons. html: the live text already rendered.
function showCard(card, { html = null } = {}) {
  const body = $('#replyCardBody');
  const wasShown = !replyCard().classList.contains('hidden');
  const atEnd = wasShown && body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  const k = replyCard().querySelector('.reply-card-kicker');
  if (k.textContent !== card.kicker) {
    k.textContent = card.kicker; // runs every frame while a reply streams: only when it changes
    replyCard().setAttribute('aria-label', card.kicker);
  }
  const error = card.kind === 'error';
  if (card.plain) body.textContent = card.text;
  else body.innerHTML = html ?? (card.text ? renderMarkdown(card.text, { wikilinks: 'open' }) : '');
  if (error) body.append(errorNode(chatcore.errorHelp(card.error, { usage: currentUsage(), settings: state.settings }), { retry: true }));
  else if (!card.follow) decorateCode(body);
  body.classList.toggle('error-bubble', error);
  fillCardActions();
  replyCard().classList.remove('hidden');
  const scroll = scrollFor({ wasShown, follow: card.follow, atEnd });
  if (scroll === 'top') body.scrollTop = 0;
  else if (scroll === 'end') body.scrollTop = body.scrollHeight;
}

// Hidden: a message sent, the latest exchange dropped, a conversation being opened.
function hideCard() {
  paintCard(cardState.hide());
}

function hideCardNode() {
  const card = replyCard();
  const focused = card.contains(document.activeElement);
  card.classList.add('hidden');
  if (focused) $('#input').focus({ preventScroll: true });
}

// Put away by the user (✕, Esc) or a new conversation: it stays away for the rest of this reply.
function closeCard() {
  paintCard(cardState.close(chat.own));
}

// The whole conversation instead (Split; the setting as the voice command saves it, so no layout.js import),
// opened at the message the card showed (one History found), else at the latest reply, at once (.messages
// scrolls smoothly; a layout switch must not). The 'settings' event has applied the layout by the time
// saveSettings resolves.
async function openCardInChat() {
  const d = cardState.openInChat();
  const at = d.at;
  paintCard(d);
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
// Spoken input: interrupts a reply in progress (the old turn is stopped and drained), then sends; while a
// message waits (for its files, or behind the reply being stopped) the words go into the box (outbox.js).
export function sendVoice(text) {
  if (outbox.spoken(text, { autoSend: state.settings.stt.autoSend }) !== 'box') return;
  closeHistory({ focus: false }); // otherwise the composer is inert
  $('#input').focus();
}

// redo: Try again / Regenerate / Edit (runAgain), sent as chat:redo; main takes the old exchange out; kept:
// the files it keeps (shown on it until the stored copy comes). attach: the composer's attachments go with
// this message (the user's own words, typed or spoken); a suggestion, a skill run, a redo or the setup flow
// never takes them. The outbox decides when it goes (outbox.js submit); deliver draws it and sends it.
export async function send(text, opts = {}) {
  await outbox.submit(text, opts);
}

// The message on screen and to main. Returns { refused } or { error } (drawn here; the outbox gives the
// words and files back), else {}.
async function deliver({ text, voice, hidden, redo: again, kept, files }) {
  speaker.stop();
  hideCard();
  closeHistory({ focus: false });
  $('#emptyState')?.remove();
  messagesEl().querySelector('.empty-state')?.remove();
  messagesEl().querySelectorAll('.msg.send-failed').forEach((n) => n.remove());

  const requestId = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const sharing = !$('#screenThumb').classList.contains('hidden') && state.settings.screen?.attachToMessages !== false;
  const slash = text.match(/^\/([\w-]+)/);
  const showing = files.meta.length ? files.meta : again ? kept : [];
  if (!hidden) messagesEl().append(messageNode({ id: 'pending-user', pending: requestId, role: 'user', content: text, display: text, ...(showing.length ? { attachments: showing } : {}), createdAt: Date.now(), screen: sharing, skill: slash && skillList.some((x) => x.slug === slash[1].toLowerCase()) ? slash[1].toLowerCase() : null }));
  const view = replyView();
  const { wrap, bubble } = view;
  scrollToBottom(true);

  // During language practice, notes in a blockquote are shown but not spoken (practice.js).
  view.speech = practiceLanguage(state.settings) ? quoteFilter() : (d) => d;
  const turn = chat.begin({ requestId, view });
  syncFlags(); // generating, nothing streamed yet
  setCaption(text || (showing.length ? attachmentsSummary(showing) : ''), 'user');
  // A spoken message hears something within a moment, even when the reply starts with tools or thinking.
  if (voice && ttsActive() && state.settings.voice.filler) {
    view.fillerTimer = setTimeout(() => {
      if (chat.own !== turn || turn.muted || turn.text.trim() || state.toolsRunning) return;
      const line = chatcore.earlyFiller(text);
      if (line) speaker.filler(line);
    }, chatcore.EARLY_FILLER_MS);
  }
  $('#sendBtn').classList.add('hidden');
  $('#stopBtn').classList.remove('hidden');

  try {
    const res = again ? await api.chat.redo({ ...again, requestId }) : await api.chat.send({ conversationId: chat.convId, text, requestId, voice, hidden, attachments: files.tokens });
    if (res?.refused) {
      refusedSend(res.refused, requestId, wrap);
      return { refused: res.refused };
    }
    chat.setConv(res.conversationId);
    return {};
  } catch (err) {
    if (again) {
      finish(chat.own === turn ? turn : null);
      wrap.remove();
      toast(plainError(err), 'error');
      openConversation(chat.convId); // nothing was dropped on the computer
      return { error: err };
    }
    // The message never reached the computer: as for a refusal, the pending copy goes and the words come back
    // (the outbox puts them and the files back), and the reason shows in plain words where the reply would
    // have been (Details: the raw text).
    const help = chatcore.errorHelp(plainError(err), { usage: currentUsage(), settings: state.settings });
    wrap.classList.add('send-failed'); // no reply of a stored message: syncActions passes it, the next send removes it
    refusedSend(null, requestId, wrap, { keepWrap: true });
    bubble.classList.remove('streaming');
    bubble.classList.add('error-bubble');
    bubble.replaceChildren(errorNode({ ...help, text: `${help.text} Your message wasn't sent: it is back in the box.` }));
    toast(`⚠ ${help.title}`, 'error', 6000); // the Face layout hides the bubble
    announce(`Error: ${help.title}. ${help.text}`);
    return { error: err };
  }
}

// An attachment expired before the message was stored (main/attachments.js claim): nothing was sent.
// The message shown while sending goes (the outbox gives the words back to an empty box). keepWrap: the reply's
// place stays, to show why (a send that failed).
function refusedSend(message, requestId, wrap, { keepWrap = false } = {}) {
  finish(chat.own?.requestId === requestId ? chat.own : null);
  messagesEl().querySelector(`.msg[data-pending="${CSS.escape(requestId)}"]`)?.remove();
  if (!keepWrap) wrap.remove();
  if (message) toast(message, 'error');
  syncActions();
}

function stop() {
  if (chat.own) api.chat.abort(chat.own.requestId).catch(() => {});
  speaker.stop();
}

// The face's flags from this window's own reply (a reply on another device doesn't make this face think,
// and Esc or "cancel" stop only this window's).
function syncFlags() {
  const a = chat.activity({ ownOnly: true });
  state.toolsRunning = a.toolsRunning;
  state.streamingText = a.streamingText;
  setFlag('generating', a.generating);
}

// The nodes of a reply being written: its tool chips and its streaming bubble.
function replyView() {
  const wrap = el('div', { class: 'msg assistant' });
  const body = el('div', { class: 'msg-body' });
  const toolsEl = el('div', { class: 'tools' });
  const bubble = el('div', { class: 'bubble streaming', 'data-stamp': chatcore.liveStamp(agentName()) });
  body.append(toolsEl, bubble);
  wrap.append(avatarNode('assistant'), body);
  messagesEl().append(wrap);
  return { wrap, body, bubble, toolsEl, chips: new Map() };
}

// A streamed reply is rendered whole each time (marked, DOMPurify, layout), so a long one costs more per
// frame as it grows. The next render waits RENDER_SPACING times the last one's cost: a cheap render still
// runs every frame, an expensive one takes at most about a quarter of the time (the face keeps its frames).
const RENDER_SPACING = 3;

function renderActive() {
  const t = chat.own;
  if (!t || t.view.renderQueued) return;
  t.view.renderQueued = true;
  const wait = Math.max(0, (t.view.nextRenderAt || 0) - performance.now());
  if (wait > 0) setTimeout(() => renderFrame(t), wait);
  else renderFrame(t);
}

function renderFrame(t) {
  requestAnimationFrame(() => {
    if (chat.own !== t) return;
    const v = t.view;
    v.renderQueued = false;
    // The Face layout hides the message list: its bubble gets the text when the reply ends ('done', 'error',
    // 'aborted' render it) or when the layout changes (initReplyCard); only the card, when it shows the text,
    // renders now (replycard.js frame: read on the card when it isn't spoken or past speakLimit).
    const { render, decision } = cardState.frame(t, { text: t.text, capped: speaker.capped });
    if (!render) return;
    const started = performance.now();
    const html = renderMarkdown(t.text, { wikilinks: 'open' });
    if (render === 'card') showCard(decision.card, { html });
    else {
      v.bubble.innerHTML = html;
      scrollToBottom();
    }
    const now = performance.now();
    v.nextRenderAt = now + RENDER_SPACING * (now - started);
  });
}

// An event from main (chat:event): turnstate.js decides whose turn it is and keeps the data; here it is drawn.
function handleEvent(ev) {
  const step = chat.apply(ev);
  if (!step || step.type === 'held') return;
  if (step.type === 'unknown') return missedTurn(step.ev);
  if (!step.mine) return drawOther(step);
  const t = step.turn;
  const v = t.view;
  switch (step.type) {
    case 'start': {
      $('#chatTitle').textContent = step.title || 'Conversation';
      if (step.drop) dropFrom(step.drop, { keep: v.wrap }); // the unanswered copy this message replaces
      // The stored message (its id for ✎ Edit, its files' saved paths) in place of the one shown while sending.
      const pending = messagesEl().querySelector(`.msg[data-pending="${CSS.escape(t.requestId)}"]`);
      if (pending && t.userMessage) pending.replaceWith(messageNode(t.userMessage));
      syncActions();
      refreshList();
      break;
    }
    case 'text':
      if (ttsActive() && !t.muted) speaker.feed(v.speech(step.delta));
      else {
        cardState.text(t); // not spoken: in the Face layout it is read on the card as it comes
        setCaption(t.text.slice(-280), 'assistant');
      }
      syncFlags();
      renderActive();
      break;
    case 'retract':
      speaker.stop();
      syncFlags();
      renderActive();
      break;
    case 'tool_start': {
      syncFlags();
      const chip = toolChip(step.tool);
      v.chips.set(step.tool.id, chip);
      if (ttsActive() && state.settings.voice.filler && !t.muted && !t.text.trim()) speaker.filler(chatcore.fillerFor(step.tool.name));
      v.toolsEl.append(chip);
      scrollToBottom();
      break;
    }
    case 'tool_end':
      syncFlags();
      drawToolEnd(v, step.tool);
      break;
    case 'notice':
      // Tools an earlier attempt or reply ran (a message sent again), named as the chips name them: turnstate.noticeText.
      v.body.insertBefore(el('div', { class: 'notice' }, step.text), v.bubble);
      if (step.toast) toast(step.text); // the Face layout hides the list
      break;
    case 'other':
      sideEvent(step.ev);
      break;
    case 'done': {
      const m = step.message || { role: 'assistant', content: t.text };
      v.bubble.classList.remove('streaming');
      v.bubble.innerHTML = renderMarkdown(m.content || '', { wikilinks: 'open' });
      v.wrap.dataset.id = m.id;
      // The finished reply on the card (the voice, if on, goes on reading; the mini caption steps aside);
      // none for a turn that only used tools.
      paintCard(cardState.ended(t, { outcome: 'done', text: t.text, message: m }).decision);
      announce(`${agentName()}: ${v.bubble.textContent}`);
      decorateCode(v.bubble); // after announce: its text must not read "Copy"
      v.bubble.dataset.stamp = stamp(m);
      v.body.append(metaNode(m));
      if (ttsActive() && !t.muted) speaker.flush();
      // A switch by voice: the new persona greets the user in its own voice, after the reply.
      if (t.greeting) {
        const greeting = t.greeting;
        loadSettings().then(() => ttsActive() && speaker.follow(greeting, { remember: true, firstAlone: true })).catch(() => {});
      }
      finish(t);
      if (!ttsActive()) celebrate();
      refreshList();
      syncActions();
      break;
    }
    case 'failed':
    case 'stopped': {
      v.bubble.classList.remove('streaming');
      const failed = step.type === 'failed';
      const retryId = chat.actions().again; // the message Try again sends, if any (turnstate recorded the attempt)
      const help = failed ? chatcore.errorHelp(step.error, { usage: currentUsage(), settings: state.settings }) : null;
      drawEnded(t, help, retryId);
      // On the card: an error always (the Face layout shows nothing else); a stop only where it was being read.
      const ended = cardState.ended(t, { outcome: step.type, text: t.text, error: step.error });
      paintCard(ended.decision);
      if (failed) {
        // Where the failure is in view, a short notice; elsewhere (another view, the card closed) one with the buttons.
        const seen = currentView === 'chat' && ended.onScreen;
        const convId = chat.convId;
        if (seen || !retryId) toast(`⚠ ${help.title}`, 'error', 6000);
        else toastActions(`⚠ ${help.title}. ${help.text}`, [['Try again', () => retryIn(convId, retryId)], ...(help.action ? [[help.action.label, () => runHelpAction(help.action)]] : [])]);
        announce(`Error: ${help.title}. ${help.text}`);
        raiseAlert(help.title);
        // 'info': main.js already logs the failed turn as an error, with its stack (one problem report, not two).
        logEvent('info', 'reply failed', { turn: String(t.requestId || '').slice(-6), error: String(step.error || '').slice(0, 300) });
      }
      finish(t);
      refreshList();
      syncActions();
      break;
    }
  }
}

// A tool call's chip once it reported back (in place of the running one).
function drawToolEnd(v, tool) {
  const chip = toolChip(tool);
  const prev = v.chips.get(tool.id);
  prev ? prev.replaceWith(chip) : v.toolsEl.append(chip);
  v.chips.set(tool.id, chip);
}

// A failed or stopped reply's bubble: what was written, then the reason in plain words with the way out
// (Details: the raw text), or "(stopped)".
function drawEnded(t, help, retryId) {
  const b = t.view.bubble;
  if (help) {
    b.innerHTML = t.text ? renderMarkdown(t.text, { wikilinks: 'open' }) : '';
    if (t.text) decorateCode(b);
    b.append(errorNode(help, { retry: Boolean(retryId), messageId: retryId }));
    b.classList.add('error-bubble');
  } else b.innerHTML = renderMarkdown(t.text || '*(stopped)*', { wikilinks: 'open' });
}

// What a reply tells the rest of the window (only this window's own: a reply on another device doesn't
// open documents here or speak a voice preview).
function sideEvent(ev) {
  switch (ev.type) {
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
  }
}

// A reply started on another device (the phone, the watch) or by the app in the open conversation: shown
// as it is written, so the latest exchange reads as running (Try again, Edit and Regenerate wait for it)
// instead of "This message got no reply." Never spoken, never on the card, no notices.
function drawOther(step) {
  const t = step.turn;
  if (step.joined) {
    // Its start went by (the chat was opened here after it began): followed from now on, as running.
    t.view = replyView();
    syncActions();
  }
  switch (step.type) {
    case 'start':
      if (step.drop) dropFrom(step.drop, { keep: chat.own?.view.wrap }); // sent again there: the old exchange went
      $('#emptyState')?.remove();
      messagesEl().querySelector('.empty-state')?.remove();
      if (t.userMessage && !t.userMessage.hidden) messagesEl().append(messageNode(t.userMessage));
      t.view = replyView();
      scrollToBottom();
      syncActions();
      refreshList();
      break;
    case 'text':
    case 'retract':
      if (t.view.renderQueued) break;
      t.view.renderQueued = true;
      requestAnimationFrame(() => {
        t.view.renderQueued = false;
        if (t.outcome !== 'running') return;
        t.view.bubble.innerHTML = renderMarkdown(t.text, { wikilinks: 'open' });
        scrollToBottom();
      });
      break;
    case 'tool_start': {
      const chip = toolChip(step.tool);
      t.view.chips.set(step.tool.id, chip);
      t.view.toolsEl.append(chip);
      scrollToBottom();
      break;
    }
    case 'tool_end':
      drawToolEnd(t.view, step.tool);
      break;
    case 'notice':
      t.view.body.insertBefore(el('div', { class: 'notice' }, step.text), t.view.bubble);
      break;
    case 'done': {
      const m = step.message || { role: 'assistant', content: t.text };
      const b = t.view.bubble;
      b.classList.remove('streaming');
      b.innerHTML = renderMarkdown(m.content || '', { wikilinks: 'open' });
      decorateCode(b);
      b.dataset.stamp = stamp(m);
      t.view.wrap.dataset.id = m.id;
      t.view.body.append(metaNode(m));
      refreshList();
      syncActions();
      break;
    }
    case 'failed':
    case 'stopped':
      t.view.bubble.classList.remove('streaming');
      drawEnded(t, step.type === 'failed' ? chatcore.errorHelp(step.error, { usage: currentUsage(), settings: state.settings }) : null, chat.actions().again);
      refreshList();
      syncActions();
      break;
  }
}

// The end of a reply in the open conversation that wasn't followed (it started before the chat was opened
// here): the conversation is read again, so its reply shows. Not under a reply of this window's own, nor
// over an edit in the box.
function missedTurn(ev) {
  if (!['done', 'error', 'aborted'].includes(ev.type) || chat.own || outbox.editing || !chat.convId) return;
  openConversation(chat.convId);
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
  const a = chat.actions();
  // A failed reply's own Try again works only while it is the latest exchange.
  box.querySelectorAll('.reply-error .retry-btn').forEach((b) => (b.hidden = b.dataset.for !== a.again));
  if (!a.again) return;
  const userNode = box.querySelector(`.msg[data-id="${CSS.escape(a.again)}"]`);
  if (!userNode) return;
  userNode.querySelector('.msg-meta')?.append(redoButton('✎ Edit', 'Put this message back in the box to change it and send it again (↑). The old exchange is replaced; there is no undo.', () => startEdit(a.edit)));
  if (a.state === 'answered') {
    const replyNode = a.reply && box.querySelector(`.msg[data-id="${CSS.escape(a.reply)}"]`);
    const m = chat.messages.find((x) => x.id === a.reply);
    const fresh = m?.provider === 'claude-code' ? ' (Claude starts a fresh session for it: a few seconds longer)' : '';
    replyNode?.querySelector('.msg-meta')?.append(redoButton('↻ Regenerate', `Write a new reply to your message; the old one is replaced, with no undo${fresh}`, () => runAgain('again', a.again)));
    return;
  }
  let reply = userNode.nextElementSibling;
  while (reply && !reply.matches('.msg.assistant:not(.send-failed)')) reply = reply.nextElementSibling;
  if (reply) {
    // A reply that was stopped (or failed, with its own button): the same visible card with Try again as a
    // conversation opened later shows, not a button hidden in the meta row.
    if (reply.querySelector('.reply-error')) return;
    reply.querySelector('.msg-body')?.append(el('div', { class: 'msg-failed' }, stopNode('Stopped.', a.again)));
    return;
  }
  // A conversation opened later: the failure (or the stop) under the message itself.
  const f = chat.failure();
  if (!f) return;
  const node = f.kind === 'noreply'
    ? stopNode('This message got no reply.', a.again)
    : f.kind === 'failed'
      ? errorNode(chatcore.errorHelp(f.error, { usage: currentUsage(), settings: state.settings }), { retry: true, messageId: a.again })
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
  const id = messageId || chat.actions().again;
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
    const id = chat.actions().edit;
    if (id) startEdit(id);
  }
}

/** ✎ Edit: the latest message in the box; Enter sends it in place of the old exchange, Esc puts the draft back. */
function startEdit(id) {
  const m = chat.messages.find((x) => x.id === id);
  // Refused while a message waits for its files (it is sent once read: no edit in between) or a reply runs.
  if (!outbox.startEdit(id, m ? redo.sentText(m) : null)) return;
  const input = $('#input');
  $('.composer').classList.add('editing');
  const files = (m.attachments || []).some((x) => x.kind !== 'image');
  $('#editText').textContent = `✎ Editing your last message: Enter sends it in place of the old one.${files ? ' Its files stay attached.' : ''}`;
  $('#editBar').classList.remove('hidden');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  autosize();
  scrollToBottom(true); // the composer grew: the message being edited stays in view
}

/** Takes the latest exchange off the screen and out of the open conversation (main takes it out of the stored one). */
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
  chat.dropFrom(id);
  hideCard();
}

/**
 * Sends the latest message again: main checks it first (asking here when the old exchange already did
 * something, or when an attempt was cut off), then the old one goes and the new one is sent. True if sent.
 */
async function runAgain(kind, messageId, text = '') {
  if (busy()) return (toast(outbox.waitingFiles ? 'Still reading your file…' : 'Wait for the current reply to finish (or press stop).'), false);
  if (!chat.convId || !messageId) return false;
  const req = { conversationId: chat.convId, messageId, kind, text, expectLast: chat.messages[chat.messages.length - 1]?.id };
  const chk = await api.chat.redoCheck(req).catch((err) => ({ ok: false, error: err.message }));
  if (!chk.ok) {
    toast(chk.error, 'error');
    if (chk.changed) openConversation(chat.convId);
    return false;
  }
  if (chk.ask?.length || chk.more) {
    const label = (t) => `${chatcore.toolLabel(t.name)} ${typeof t.input === 'string' ? (t.input ? `· ${t.input.slice(0, 60)}` : '') : chatcore.briefInput(t.input)}`.trim();
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
  if (busy() || req.conversationId !== chat.convId) return false; // a reply started (or a message waits for its files), or another chat opened, meanwhile
  // The files it keeps show on it while it is sent (its pictures aren't kept); 'start' brings the stored copy.
  const kept = (chat.messages.find((m) => m.id === messageId)?.attachments || []).filter((a) => a?.kind !== 'image');
  dropFrom(messageId);
  await send(chk.text, { voice: chk.voice, redo: { ...req, confirmed: true }, kept });
  return true;
}

/** Try again on the latest message (the voice command, a failed reply's button). True when something started. */
export async function retryLatest() {
  const a = chat.actions();
  return a.again ? runAgain('again', a.again) : false;
}

/** Whether the latest reply failed or was stopped, so "try again" means it (commands.js). */
export function canRetryLatest() {
  const a = chat.actions();
  return Boolean(a.again) && (a.state === 'unanswered' || a.state === 'stopped');
}

// From a notice while another view was open: back to that conversation, then Try again.
async function retryIn(convId, messageId) {
  if (currentView !== 'chat') switchView('chat');
  if (convId && convId !== chat.convId) await openConversation(convId);
  if (chat.convId === convId) runAgain('again', messageId);
}

// The card's buttons (replycard.js buttons, from turnstate's actions): Copy, Regenerate and Edit on a
// finished reply; Try again and Edit after a stop (a failure's are in its own box).
const CARD_BUTTONS = {
  copy: ['Copy', 'Copy this reply'],
  regenerate: ['↻ Regenerate', 'Write a new reply; this one is replaced'],
  try: ['↻ Try again', 'Send your message again'],
  edit: ['✎ Edit', 'Change your message and send it again (↑)'],
};
function fillCardActions() {
  const box = $('#replyCardActions');
  const reply = cardState.card?.reply;
  const buttons = cardState.buttons(chat.actions()); // drawn after turnstate ended the reply, so a finished one offers its buttons
  box.replaceChildren(...buttons.map((b) => {
    const [label, title] = CARD_BUTTONS[b.label || b.action];
    const onclick = b.action === 'copy' ? () => navigator.clipboard.writeText(chatcore.copyText(reply)).then(() => toast('Copied'), toastError) : b.action === 'edit' ? () => startEdit(b.id) : () => runAgain('again', b.id);
    return el('button', { class: 'chip-btn', type: 'button', title, onclick }, label);
  }));
}

/** Code blocks in a finished reply get their own Copy button (never while it streams, never in the error details). */
function decorateCode(root) {
  for (const pre of root.querySelectorAll('pre')) {
    if (pre.closest('.reply-error, .code-block, .tool-chip')) continue;
    const wrap = el('div', { class: 'code-block' });
    pre.replaceWith(wrap);
    const copy = el('button', { class: 'code-copy', type: 'button', title: 'Copy code', 'aria-label': 'Copy code' }, 'Copy');
    copy.onclick = () => {
      navigator.clipboard.writeText(pre.querySelector('code')?.textContent ?? pre.textContent).then(() => {
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      }, toastError);
    };
    wrap.append(pre, copy);
  }
}

// This window's reply is over (turnstate ended it on its event; a send that failed or was refused ends here).
function finish(turn) {
  clearTimeout(turn?.view?.fillerTimer);
  if (turn && chat.own === turn) chat.end(turn, 'unsent');
  // The filler lines' audio, made in the quiet after a reply (speaker.filler plays only what is ready).
  if (ttsActive() && state.settings.voice.filler) speaker.warmFillers(chatcore.allFillers(), () => !chat.own && !state.recording);
  outbox.replyEnded(); // a message queued behind it goes now
  syncFlags(); // not generating, no tools, nothing streaming
  if (!speaker.busy) setCaption('');
  $('#sendBtn').classList.remove('hidden');
  $('#stopBtn').classList.add('hidden');
}

export function currentConversationId() {
  return chat.convId;
}

// Esc, or saying "cancel": stops the reply that is still being written (and its tools). True if there was one.
export function cancelReply() {
  const was = Boolean(chat.own);
  stop();
  if (was) announce('Stopped.');
  return was;
}

// Continue in an existing conversation without re-rendering the message list (used by the setup
// flow, so the scripted first exchange stays on screen as the agent takes over).
export function continueIn(id, title) {
  chat.continueIn(id);
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
