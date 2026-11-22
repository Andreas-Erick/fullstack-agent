// The chat: replies as they stream in, the messages, the composer and sending.
import { priorUsersFor, DEADLINES } from './sync.js';
import * as chatcore from './js/chatcore.js';
import { $, inputEl, CONV_KEY, store, chat, state } from './state.js';
import { el, icon, markdown, toast, AuthError, setConvTitle, submitForm } from './ui.js';
import { api } from './net.js';
import { loadConversation } from './conversations.js';
import { say } from './voiceout.js';
import { refreshFace } from './face.js';
import { sched } from './schedule.js';

// ------------------------------------------------------------------ chat
// An event of the device stream: turnstate.js decides whose turn it is (this phone's, one started on the
// computer or another device in the conversation shown, or none) and keeps its text, tools and outcome.
export function onChat(ev) {
  const before = chat.convId;
  const step = chat.apply(ev);
  if (!step || step.type === 'held') return; // held: this phone's send is in flight (see send())
  const turn = step.turn;
  if (step.joined) turn.view = turnView(); // a reply here whose start went by: followed from now on
  switch (step.type) {
    case 'unknown':
      // A reply here that the phone wasn't following (its start went by while the conversation loaded):
      // load it again rather than miss the reply. Never under a reply of its own (that view would go).
      if (step.ev.type === 'done' && !state.loadingConv && !chat.own) loadConversation(state.convId);
      return;
    case 'start':
      if (!step.mine) {
        if (step.drop) {
          // Sent again on the computer (Try again, Regenerate, Edit): the old exchange went; show the conversation as it is now.
          chat.end(turn);
          if (!chat.own && !state.loadingConv) loadConversation(state.convId);
          return;
        }
        // A turn from the desktop or another device in the conversation shown here.
        addMessage(turn.userMessage);
        turn.view = turnView();
        refreshFace();
        return;
      }
      if (state.shownConv === null && !before) state.shownConv = chat.convId; // a new conversation got its id
      store.set(CONV_KEY, chat.convId);
      setConvTitle(step.title || 'Conversation');
      if (turn.view.userNode && turn.userMessage?.id) turn.view.userNode.dataset.id = turn.userMessage.id;
      // The same message again after a failure: the computer replaced the unanswered copy.
      if (step.drop) dropReplaced(step.drop, turn);
      return;
    case 'text':
    case 'retract':
      refreshFace();
      renderTurn(turn);
      return;
    case 'tool_start':
      if (step.work?.place) state.worldWork = { place: String(step.work.place), label: String(step.work.label || ''), done: 0 }; // the world screen sends the active persona there
      turn.view.tools.append(el('span', { class: 'chip', 'data-id': step.tool.id }, chatcore.toolLabel(step.tool.name)));
      refreshFace();
      scrollDown();
      return;
    case 'tool_end': {
      const chip = turn.view.tools.querySelector(`[data-id="${CSS.escape(String(step.tool.id))}"]`);
      if (chip) chip.className = `chip ${step.tool.ok === false ? 'bad' : 'good'}`;
      refreshFace();
      return;
    }
    case 'notice':
      turn.view.wrap.insertBefore(el('div', { class: 'notice' }, step.text), turn.view.bubble);
      return;
    case 'done': {
      const m = step.message || {};
      const v = turn.view;
      v.bubble.classList.remove('streaming');
      v.bubble.innerHTML = markdown(m.content || '');
      v.bubble.dataset.stamp = chatcore.replyStamp(m, state.name);
      v.wrap.append(actions(m.content || ''));
      announce(v.bubble.textContent);
      state.happyUntil = Date.now() + 1800; // the face's short "done" glow, as on the desktop
      sched.cache.clear(); // the reply may have changed the schedule
      endTurn(turn);
      if (turn.mine && state.speak) say(m.content || '');
      return;
    }
    case 'failed':
    case 'stopped':
      turn.view.bubble.classList.remove('streaming');
      if (step.type === 'failed') {
        turn.view.bubble.classList.add('error');
        showFailure(turn, step.error);
      } else turn.view.bubble.innerHTML = markdown(turn.text || '*(stopped)*');
      if (turn.mine) {
        turn.view.wrap.append(retryRow(turn));
        state.lastFailed = turn;
      }
      endTurn(turn);
      return;
  }
}

// A finished reply for a screen reader, once (#chatLive, as the desktop's): emptied first, so the same
// words twice are read twice.
function announce(text) {
  const live = $('#chatLive');
  const said = String(text || '').trim().slice(0, 2000);
  if (!live || !said) return;
  live.textContent = '';
  setTimeout(() => (live.textContent = said), 50);
}

// A failed reply: what was written, then the reason in plain words (the raw text under Details).
function showFailure(turn, message) {
  const help = chatcore.errorHelp(message);
  const b = turn.view.bubble;
  b.innerHTML = turn.text ? markdown(turn.text) : '';
  b.append(
    el(
      'div',
      { class: 'reply-help' },
      el('div', { class: 'reply-help-title' }, `⚠ ${help.title}`),
      el('p', {}, help.text),
      help.raw && help.raw !== help.text ? el('details', {}, el('summary', {}, 'Details'), el('pre', {}, help.raw)) : null,
    ),
  );
}

// Try again on a reply of this phone's own that failed or stopped (hidden on a view-only device).
const retryRow = (turn) => el('div', { class: 'actions' }, el('button', { class: 'act retry', type: 'button', onclick: () => phoneRetry(turn) }, '↻ Try again'));

// The same text again: the computer replaces the unanswered message with it (main/redo.js supersedes).
function phoneRetry(turn) {
  if (chat.own) return toast('Wait for the reply to finish first.');
  turn.view.userNode?.remove();
  turn.view.wrap?.remove();
  if (state.lastFailed === turn) state.lastFailed = null;
  send(turn.view.sentText || '');
}

// The unanswered message (and a stopped reply after it) that the new one replaced, and this phone's own failed try.
function dropReplaced(id, keep) {
  const node = $('#messages').querySelector(`.msg[data-id="${CSS.escape(id)}"]`);
  if (node && node !== keep?.view.userNode) {
    let next = node.nextElementSibling;
    node.remove();
    while (next && next.matches('.msg.assistant') && next !== keep?.view.wrap) {
      const after = next.nextElementSibling;
      next.remove();
      next = after;
    }
  }
  const old = state.lastFailed;
  if (old && old !== keep) {
    old.view.userNode?.remove();
    old.view.wrap?.remove();
    state.lastFailed = null;
  }
  updateEmpty();
}

// A reply being written: its tool chips and its streaming bubble, at the end of the list.
export function turnView(mine = false) {
  const bubble = el('div', { class: 'bubble streaming', 'data-stamp': chatcore.liveStamp(state.name) });
  const tools = el('div', { class: 'tools' });
  const wrap = el('div', { class: 'msg assistant' }, tools, bubble);
  $('#messages').append(wrap);
  updateEmpty();
  scrollDown(mine);
  return { wrap, bubble, tools };
}

// Under a finished reply: copy it (as written, Markdown included).
function actions(text) {
  if (!text) return document.createDocumentFragment();
  return el('div', { class: 'actions' }, el('button', { class: 'act', type: 'button', 'aria-label': 'Copy reply', onclick: () => copyText(text) }, icon('copy'), 'Copy'));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The clipboard API needs a secure page; on the plain local address fall back to a selection.
    const t = el('textarea', { class: 'offscreen', readonly: '' });
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    if (!ok) return toast('Couldn’t copy on this connection.');
  }
  toast('Copied');
}

// The reply is rendered whole each time, so a long one costs more as it grows: the next render waits
// RENDER_SPACING times the last one's cost (cheap ones still run every frame), as the desktop's chat.js.
const RENDER_SPACING = 3;

function renderTurn(turn) {
  const v = turn.view;
  if (v.raf || v.renderWait) return;
  const draw = () => {
    v.renderWait = 0;
    v.raf = requestAnimationFrame(() => {
      v.raf = 0;
      const started = performance.now();
      v.bubble.innerHTML = markdown(turn.text);
      scrollDown();
      const now = performance.now();
      v.nextRenderAt = now + RENDER_SPACING * (now - started);
    });
  };
  const wait = Math.max(0, (v.nextRenderAt || 0) - performance.now());
  if (wait > 0) v.renderWait = setTimeout(draw, wait);
  else draw();
}

// A turn is over (turnstate ended it on its event; a send that failed or a reconnect end it here).
export function endTurn(turn) {
  chat.end(turn);
  if (turn.mine && !chat.own) {
    document.body.classList.remove('busy');
    $('#sendBtn').classList.remove('hidden');
    $('#stopBtn').classList.add('hidden');
  }
  // The face follows the assistant, whoever started the reply: idle once nothing is running.
  refreshFace();
  scrollDown();
}

export function addMessage(m) {
  if (!m || m.hidden) return null;
  const text = m.display ?? m.content;
  const wrap = el('div', { class: `msg ${m.role}`, 'data-id': m.id || '' });
  if (m.role === 'assistant') {
    if (m.toolCalls?.length) wrap.append(el('div', { class: 'tools' }, m.toolCalls.map((t) => el('span', { class: 'chip good' }, chatcore.toolLabel(t.name)))));
    const b = el('div', { class: 'bubble', 'data-stamp': chatcore.replyStamp(m, state.name) });
    b.innerHTML = markdown(text);
    wrap.append(b, actions(text));
  } else {
    if (text) wrap.append(el('div', { class: 'bubble' }, text));
    // Files attached on the computer: their names only (main/projections.js messagesFor('device')).
    if (m.attachments?.length) wrap.append(el('div', { class: 'meta' }, `📎 ${m.attachments.map((a) => a.name).join(' · ')}`));
    if (m.remote) wrap.append(el('div', { class: 'meta' }, `from ${m.remote}`));
  }
  $('#messages').append(wrap);
  updateEmpty();
  return wrap;
}

// Follows new text only while the reader is at the bottom; scrolled up, a button jumps back down.
let stick = true;
export function scrollDown(force = false) {
  const m = $('#messages');
  if (force) stick = true;
  if (stick) m.scrollTop = m.scrollHeight;
  $('#jumpBtn').classList.toggle('hidden', stick);
}
$('#messages').addEventListener('scroll', () => {
  const m = $('#messages');
  stick = m.scrollHeight - m.scrollTop - m.clientHeight < 60;
  $('#jumpBtn').classList.toggle('hidden', stick);
}, { passive: true });
// The list gets shorter without scrolling (the keyboard opens, the message box grows, an approval or the
// recording bar appears): still following, the end of the reply stays in view instead of under the composer.
if (window.ResizeObserver) new ResizeObserver(() => stick && ($('#messages').scrollTop = $('#messages').scrollHeight)).observe($('#messages'));
$('#jumpBtn').addEventListener('click', () => {
  const m = $('#messages');
  stick = true;
  m.scrollTo({ top: m.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('#jumpBtn').classList.add('hidden');
});

export const updateEmpty = () => $('#empty').classList.toggle('hidden', $('#messages').childElementCount > 0);

export async function send(text) {
  if (!text.trim() || chat.own) return;
  // The user's messages shown so far, without those that never reached the computer: after a reload only
  // a newer message with these words is this one (keepUnsent, sync.js unsentPlan). Not counted when the
  // conversation's messages aren't drawn (opened while out of reach): then it is always shown again.
  const priorUsers = priorUsersFor({ shownConv: state.shownConv, convId: state.convId, count: $('#messages').querySelectorAll('.msg.user:not([data-unsent])').length });
  const userNode = addMessage({ role: 'user', content: text });
  // userNode: Try again takes both away and sends the same words. convId: only the latest message is kept
  // across a reload (keepUnsent): an older failure would land below newer messages.
  const turn = chat.begin({ view: { ...turnView(true), userNode, sentText: text, convId: state.convId || null, priorUsers } });
  state.lastTurn = turn;
  document.body.classList.add('busy');
  refreshFace();
  $('#sendBtn').classList.add('hidden');
  $('#stopBtn').classList.remove('hidden');
  let requestId = null;
  try {
    const r = await api('/api/chat', { method: 'POST', body: { text, conversationId: state.convId || undefined }, timeoutMs: DEADLINES.chat });
    requestId = r.requestId;
    // Known now even if the stream's "start" never arrives (the link dropped): a reconnect loads this one.
    if (r.conversationId && !state.convId) {
      state.convId = r.conversationId;
      store.set(CONV_KEY, r.conversationId);
      if (state.shownConv === null) state.shownConv = r.conversationId; // the new conversation on screen is this one
    }
  } catch (err) {
    userNode.dataset.unsent = ''; // not counted by a later send's priorUsers
    turn.view.bubble.classList.remove('streaming');
    turn.view.bubble.classList.add('error');
    turn.view.bubble.textContent = err instanceof AuthError ? 'Not sent: this device is no longer paired.' : err.message;
    // Out of reach, refused…: the same words again, once it answers (not for an unpaired device).
    if (!(err instanceof AuthError) && !document.body.classList.contains('view-only')) {
      turn.view.wrap.append(retryRow(turn));
      state.lastFailed = turn;
    }
    chat.end(turn, 'unsent');
    endTurn(turn);
  }
  // The events that came while the send was in flight, now that its requestId is known.
  for (const ev of chat.sent(requestId)) onChat(ev);
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = inputEl;
  const text = input.value;
  input.value = '';
  autosize();
  send(text);
});
inputEl.addEventListener('keydown', (e) => {
  // On a hardware keyboard Enter sends; Shift+Enter makes a new line.
  // Tablets count too: a Book Cover keyboard doesn't make the pointer "fine".
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (matchMedia('(pointer: fine)').matches || document.body.classList.contains('wide'))) {
    e.preventDefault();
    submitForm($('#composer'));
  }
});
export const autosize = () => {
  const i = inputEl;
  i.style.height = '48px';
  i.style.height = `${Math.min(140, Math.max(48, i.scrollHeight + 2))}px`;
};
inputEl.addEventListener('input', autosize);
$('#stopBtn').addEventListener('click', () => {
  const id = chat.own?.requestId;
  if (id) api(`/api/chat/${encodeURIComponent(id)}/abort`, { method: 'POST', body: {} }).catch((err) => toast(err.message));
});

export function prefill(text) {
  const input = inputEl;
  input.value = text;
  autosize();
  input.focus();
  input.setSelectionRange(text.length, text.length);
}

// ------------------------------------------------------------------ empty chat
const SUGGESTIONS = [
  ['What’s on my schedule today?'],
  ['Plan my week with me'],
  ['Where did we leave off?'],
  ['Add to my schedule…', 'Add to my schedule: '],
];
$('#suggest').replaceChildren(...SUGGESTIONS.map(([label, fill]) => el('button', { class: 'suggestion', type: 'button', onclick: () => (fill ? prefill(fill) : send(label)) }, label)));

