// The event stream from the computer: chat events, approvals, look and data changes, and the link's state.
import { render as renderScreen, busy as screenBusy } from './screens.js';
import { streamStale, refreshPlan, batcher, DEADLINES, retryAction, plainStatus } from './sync.js';
import { $, bridge, store, state } from './state.js';
import { unpair } from './pairing.js';
import { SEEN_KEY, renderOffline, renderBanner } from './offline.js';
import { onChat } from './chatview.js';
import { loadConversation, refreshConvs } from './conversations.js';
import { addApproval, removeApproval } from './approvals.js';
import { sched, renderSchedule } from './schedule.js';
import { showView } from './nav.js';
import { closeSplash } from './hud.js';
import { applyInfo } from './boot.js';

// ------------------------------------------------------------------ events
// Server-Sent Events over fetch (EventSource can't send the Authorization header). Reconnects with backoff.
export async function openStream() {
  let delay = 1000;
  for (;;) {
    if (!state.token) return;
    const ctl = new AbortController();
    state.stream = ctl;
    try {
      // An attempt that never connects (a tunnel holding the request, a half-open network) is given up.
      state.connecting = true;
      const giveUp = setTimeout(() => ctl.abort(), DEADLINES.connect);
      const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${state.token}` }, signal: ctl.signal }).finally(() => {
        clearTimeout(giveUp);
        state.connecting = false;
      });
      if (res.status === 401) return unpair('This device was disconnected from the assistant. Pair it again.');
      if (!res.ok) throw new Error(plainStatus(res.status));
      state.lastByte = Date.now();
      setConn(true);
      $('#approvals').innerHTML = ''; // the server replays every approval that is still open
      if (delay > 1000) {
        // Catch up on what happened while away, and on a face or theme changed on the desktop meanwhile.
        loadConversation(state.convId);
        applyInfo();
        refreshConvs();
      }
      delay = 1000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        state.lastByte = Date.now(); // pings count: the watchdog below only needs to know the link is alive
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          dispatch(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
    } catch (err) {
      if (ctl.signal.aborted && !state.token) return;
    }
    setConn(false);
    if (state.skipWait) {
      state.skipWait = false;
      continue; // "Try again now" gave up a hanging attempt: the next one at once
    }
    // "Try again now" on the offline screen ends the wait early (state.wake).
    state.retryAt = Date.now() + delay;
    await new Promise((r) => {
      state.wake = r;
      setTimeout(r, delay);
    });
    state.wake = null;
    delay = Math.min(15000, delay * 2);
  }
}

function dispatch(block) {
  let event = 'message';
  let data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return;
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  if (event === 'chat.event') onChat(payload);
  else if (event === 'approval.request') addApproval(payload);
  else if (event === 'approval.cancel') removeApproval(payload.id);
  else if (event === 'info.changed') onInfoChanged();
  else if (event === 'data.changed') onDataChanged(payload.topics);
}

// A stream can die without closing (a switch from Wi-Fi to mobile data, a radio asleep): nothing arrives,
// not even the server's pings, while the phone still shows "connected". Dropped here, it reconnects and
// catches up. Checked now and then, when the app comes back to the front, and when the network changes.
function checkStream() {
  if (streamStale(state.lastByte, Date.now(), state.connected)) state.stream?.abort();
}
setInterval(checkStream, 10000);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && (checkStream(), applyInfo()));
window.addEventListener('online', () => {
  if (state.connected) state.stream?.abort(); // the old connection belongs to the network that went away
  else retryNow();
});

// "Try again now", the network back: a hanging attempt is given up for a new one, a wait ends (sync.js retryAction).
export function retryNow() {
  const a = retryAction({ connected: state.connected, connecting: state.connecting });
  if (a === 'abort') (state.skipWait = true), state.stream?.abort();
  else if (a === 'wake') state.wake?.();
}

// Something the phone shows changed on the computer (a note the agent wrote, the schedule…):
// the screen on show is drawn again in place, unless the user is busy on it; the schedule's cached weeks
// are forgotten; the conversation list (and the open conversation's title) is checked.
const onDataChanged = batcher((topics) => {
  const plan = refreshPlan(topics, { view: state.view, busy: screenBusy(state.view) });
  if (plan.schedule) {
    sched.cache.clear();
    if (state.view === 'sched') renderSchedule(true);
  }
  if (plan.screen) renderScreen(state.view, $('#panel'), { quiet: true });
  if (plan.conversations) refreshConvs();
});

// The persona was switched, or its look changed, on the computer: name, colors, face and the rest of
// /api/info follow here at once; the Android app passes the news on to a paired watch.
let infoTimer = null;
function onInfoChanged() {
  clearTimeout(infoTimer);
  infoTimer = setTimeout(async () => {
    await applyInfo();
    bridge('lookChanged');
    if (state.view === 'more') showView('more'); // a new app version shows up there
  }, 250);
}

let connTimer;
function setConn(ok) {
  const c = $('#conn');
  c.classList.toggle('ok', ok);
  c.title = ok ? 'Connected' : 'Reconnecting…';
  c.parentElement.dataset.link = ok ? 'LINK' : 'NO LINK';
  if (ok) closeSplash();
  const was = state.connected;
  state.connected = ok;
  // A short drop isn't worth a banner; a longer one is (timed from the first failure, not each retry).
  if (ok) {
    clearTimeout(connTimer);
    store.set(SEEN_KEY, String(Date.now()));
    if (was === false) sched.cache.clear(); // the schedule may have changed while the link was down
    if (was === false && state.view !== 'chat') showView(state.view); // the screen behind may show an offline card
    state.offlineDismissed = false;
    renderBanner();
  } else if (was !== false) connTimer = setTimeout(renderBanner, 2500);
  renderOffline();
}
