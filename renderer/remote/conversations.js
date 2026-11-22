// The conversation shown, the conversation list (the drawer) and its search.
import { convCheck, unsentPlan } from './sync.js';
import { $, CONV_KEY, store, chat, state } from './state.js';
import { el, ago, toast, AuthError, NetError, setConvTitle, plainLoadError } from './ui.js';
import { api } from './net.js';
import { disarmUnpair, tapUnpair } from './pairing.js';
import { turnView, endTurn, addMessage, scrollDown, updateEmpty } from './chatview.js';
import { refreshFace } from './face.js';
import { syncBack } from './nav.js';

// ------------------------------------------------------------------ conversations
let convSeq = 0; // only the latest load draws (a reconnect and a tap can overlap)
export async function loadConversation(id) {
  const seq = ++convSeq;
  $('#messages').innerHTML = '';
  state.shownConv = undefined; // drawn again below, once its messages are in
  chat.open({ id }); // the replies followed in the old list go with it; own stays
  scrollDown(true);
  $('#empty').classList.add('hidden'); // not while the conversation loads
  if (!id) {
    state.shownConv = null;
    setConvTitle('New conversation');
    if (chat.own) $('#messages').append(chat.own.view.wrap); // being sent: its reply view stays
    keepUnsent(null, []);
    return updateEmpty();
  }
  state.loadingConv = true;
  try {
    const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
    if (seq !== convSeq) return;
    $('#messages').innerHTML = ''; // a reply started meanwhile is followed again below (running)
    chat.open({ id, messages: conv.messages });
    setConvTitle(conv.title || 'Conversation');
    for (const m of conv.messages) addMessage(m);
    state.shownConv = id;
    followRunning(conv.running);
    keepUnsent(id, conv.messages);
    scrollDown(true);
  } catch (err) {
    if (err instanceof AuthError || seq !== convSeq) return;
    // Out of reach: keep it (the reconnect loads it again). Gone on the computer: start a new one.
    if (err instanceof NetError) return updateEmpty();
    state.convId = null;
    state.shownConv = null; // an empty new conversation
    store.set(CONV_KEY, null);
    setConvTitle('New conversation');
    if (chat.own) endTurn(chat.own);
  } finally {
    if (seq === convSeq) state.loadingConv = false;
  }
  updateEmpty();
}

// The message that never reached the computer stays, with its Try again, in its own conversation.
function keepUnsent(id, messages) {
  const t = state.lastFailed;
  if (!t || t.outcome !== 'unsent' || t !== state.lastTurn) return;
  const plan = unsentPlan(t.view, id, messages);
  if (plan === 'drop') state.lastFailed = null;
  else if (plan === 'show') $('#messages').append(t.view.userNode, t.view.wrap);
}

// Replies still being written in the loaded conversation (the server's `running`, turnstate reconcile): the
// phone's own stays on screen if it is still running, and ends if it finished while the link was down (its
// reply is among the loaded messages); others get a live view, so their text and end show up here.
function followRunning(running) {
  const r = chat.reconcile(running);
  if (r.keepOwn) $('#messages').append(chat.own.view.wrap);
  else if (r.ended) endTurn(r.ended);
  for (const t of r.follow) t.view = turnView();
  refreshFace();
}

// The conversation list changed on the computer (a new one, renamed, deleted): the drawer and the title
// follow; the open conversation, deleted there, gives way to a new one.
export async function refreshConvs() {
  let list;
  try {
    list = await api('/api/conversations');
  } catch {
    return;
  }
  convs = list;
  if (!$('#drawer').classList.contains('hidden')) renderConvs();
  const id = state.convId;
  const c = convCheck(list, id);
  if (c.title && c.title !== state.convTitle) setConvTitle(c.title);
  if (c.listed || chat.own || state.loadingConv) return;
  // Not listed: make sure before letting it go (only "not found" means it really is gone).
  const gone = await api(`/api/conversations/${encodeURIComponent(id)}`).then(() => false, (err) => !(err instanceof AuthError) && !(err instanceof NetError) && /not found/i.test(err.message));
  if (!gone || state.convId !== id || chat.own) return;
  state.convId = null;
  store.set(CONV_KEY, null);
  loadConversation(null);
  toast('That conversation was deleted on the computer.');
}

function openConversation(id) {
  if (chat.own) return toast('Wait for the reply to finish first.');
  state.convId = id;
  store.set(CONV_KEY, id);
  closeDrawer();
  loadConversation(id);
}

let convs = [];

async function openDrawer() {
  $('#drawer').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
  syncBack(); // before the list loads: Back closes it meanwhile too
  $('#convSearch').value = '';
  const list = $('#convList');
  list.replaceChildren(el('li', { class: 'muted' }, 'Loading…'));
  try {
    convs = await api('/api/conversations');
    renderConvs();
  } catch (err) {
    if (!(err instanceof AuthError)) list.replaceChildren(el('li', { class: 'muted load-failed' }, el('span', {}, plainLoadError(err, 'Your conversations didn’t load.')), el('button', { class: 'btn small', type: 'button', onclick: openDrawer }, 'Try again')));
  }
}

function renderConvs() {
  const q = $('#convSearch').value.trim().toLowerCase();
  const shown = q ? convs.filter((c) => (c.title || '').toLowerCase().includes(q)) : convs;
  const list = $('#convList');
  list.replaceChildren();
  if (!shown.length) list.append(el('li', { class: 'muted' }, q ? 'No matching conversations.' : 'No conversations yet.'));
  let group = '';
  for (const c of shown) {
    const g = q ? '' : dayGroup(c.updatedAt);
    if (g && g !== group) list.append(el('li', { class: 'conv-group' }, (group = g)));
    const current = c.id === state.convId;
    list.append(el('li', {}, el('button', { class: `conv ${current ? 'current' : ''}`, 'aria-current': current ? 'true' : null, onclick: () => openConversation(c.id) }, el('span', {}, c.title || 'Conversation'), c.updatedAt ? el('small', {}, ago(c.updatedAt)) : null)));
  }
}

function dayGroup(t) {
  if (!t) return 'Earlier';
  const days = Math.floor((new Date().setHours(24, 0, 0, 0) - t) / 86400000);
  return days < 1 ? 'Today' : days < 2 ? 'Yesterday' : days < 7 ? 'This week' : 'Earlier';
}

export function closeDrawer() {
  $('#drawer').classList.add('hidden');
  $('#scrim').classList.add('hidden');
  disarmUnpair();
  syncBack();
}

$('#convSearch').addEventListener('input', renderConvs);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());
$('#convBtn').addEventListener('click', openDrawer);
$('#drawerClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#newBtn').addEventListener('click', () => openConversation(null));
$('#unpairBtn').addEventListener('click', tapUnpair);
