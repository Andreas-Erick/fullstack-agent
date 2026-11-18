// Staying in step with the computer (pure; app.js and screens.js act on it; test/sync.test.js).
// The event stream says *that* something changed (data.changed: screen names from main/synccore.js),
// never what: these decide what to fetch again, when a silent stream is dead, and what to do with a
// reply that was running while the link was down.

// The server pings every 25 s; nothing for this long means the connection died without closing (a
// network switch, a sleeping radio) and the phone would wait forever while showing "connected".
export const STALE_MS = 65000;

/** True when an open stream has been silent too long and should be dropped and opened again. */
export function streamStale(lastByteAt, now, connected) {
  return Boolean(connected) && Number.isFinite(lastByteAt) && now - lastByteAt > STALE_MS;
}

// Screens drawn on a live canvas: fetching them again would reset the camera and the walkers, and the
// phone already follows live work through tool_start. They are fresh whenever they are opened.
export const LIVE = new Set(['world', 'arch']);

/**
 * What to do for a data.changed with `topics`, given the screen shown (`view`) and whether the user is
 * in the middle of something there (`busy`: a note open, typing a search).
 * → { screen: draw it again quietly, schedule: forget the cached weeks, conversations: check the list }
 */
export function refreshPlan(topics, { view, busy = false } = {}) {
  const t = new Set(Array.isArray(topics) ? topics : []);
  return {
    screen: Boolean(view) && view !== 'chat' && view !== 'sched' && t.has(view) && !busy && !LIVE.has(view),
    schedule: t.has('sched'),
    conversations: t.has('conversations'),
  };
}

/**
 * After the conversation was loaded again (a reconnect, the app opened mid-reply): `running` is the
 * server's list of replies still being written there. The phone's own reply in flight (`active`) is
 * kept when it is still running or not sent yet (no requestId), and ended when it finished while the
 * link was down (the loaded messages already hold it). Others still running are followed.
 * → { keepActive, endActive, follow: [requestId] }
 */
export function reconcile(active, running) {
  const list = Array.isArray(running) ? running.filter((x) => typeof x === 'string' && x) : [];
  const id = active?.requestId;
  const keepActive = Boolean(active) && (!id || list.includes(id));
  return { keepActive, endActive: Boolean(active) && !keepActive, follow: list.filter((x) => x !== id) };
}

/**
 * The shown conversation against a fresh list: its title (renamed on the computer) or that it is not
 * listed (deleted, or only beyond the list: the caller asks for it by id before believing it is gone).
 */
export function convCheck(list, convId) {
  if (!convId || !Array.isArray(list)) return { listed: true, title: null };
  const c = list.find((x) => x && x.id === convId);
  return c ? { listed: true, title: c.title || null } : { listed: false, title: null };
}

/**
 * A message this phone couldn't send (`failed`: { convId, sentText, priorUsers }) after conversation `id`
 * was loaded again with `messages`: 'show' it again (with its Try again), 'drop' it (the computer has it
 * after all: the answer was lost, not the message), or 'skip' (another conversation is shown).
 * `priorUsers`: how many of the user's messages the phone showed before this one. Only a message after
 * those with the same words is this one ("yes" again after an earlier "yes" is still unsent); without
 * that count it is always shown.
 */
export function unsentPlan(failed, id, messages) {
  if (!failed || (failed.convId || null) !== (id || null)) return 'skip';
  const prior = failed.priorUsers;
  if (!Number.isInteger(prior) || prior < 0) return 'show';
  const users = (Array.isArray(messages) ? messages : []).filter((m) => m?.role === 'user');
  const said = (m) => String(m?.display ?? m?.content ?? '').trim(); // the server stores the text trimmed
  const text = String(failed.sentText ?? '').trim();
  return text && users.slice(prior).some((m) => said(m) === text) ? 'drop' : 'show'; // the phone never sends an empty message
}

// Deadlines for an answer's headers (app.js fetchWithin): a send returns as soon as the turn starts,
// pairing at once; an event-stream connection that hasn't answered after `connect` is given up.
export const DEADLINES = { chat: 30000, pair: 20000, connect: 15000 };

/** A transcription's wait: a minute plus the recording's length (16 kHz mono 16-bit: 32 bytes a ms) plus 5 s. */
export function transcribeDeadline(wavBytes) {
  const bytes = Math.min(Math.max(Number(wavBytes) || 0, 0), 120000 * 32); // at most two minutes (app.js MAX_REC_MS)
  return 65000 + Math.round(bytes / 32);
}

/** "Try again now" or the network back while down: give up a hanging attempt, or end the wait. */
export function retryAction({ connected = false, connecting = false } = {}) {
  return connected ? 'none' : connecting ? 'abort' : 'wake';
}

/**
 * What Android Back closes first ('offline' | 'drawer' | 'face' | 'screen', or the view to show: 'chat',
 * 'more'), or null at the top (the app goes to the background then). `screenBack`: a note or a building is
 * open on the screen shown; `tabs`: the tab bar's views; `wide`: the chat is always beside the screens.
 */
export function backPlan({ offline = false, drawerOpen = false, faceFull = false, screenBack = false, view = 'chat', tabs = [], wide = false } = {}) {
  if (offline) return 'offline';
  if (drawerOpen) return 'drawer';
  if (faceFull) return 'face';
  if (screenBack) return 'screen';
  if (view === 'sched') return 'chat'; // opened from the chat's header ("Back to the chat")
  if (view !== 'chat' && !tabs.includes(view)) return 'more'; // a screen from the More menu
  if (view !== 'chat' && !wide) return 'chat';
  return null;
}

/** Collects topics for `waitMs` and calls `flush(topics)` once (several saves in a row: one refresh). */
export function batcher(flush, waitMs = 300, timers = { setTimeout, clearTimeout }) {
  const pending = new Set();
  let timer = null;
  return (topics) => {
    for (const t of Array.isArray(topics) ? topics : []) if (typeof t === 'string') pending.add(t);
    if (!pending.size) return;
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      const out = [...pending];
      pending.clear();
      flush(out);
    }, waitMs);
  };
}
