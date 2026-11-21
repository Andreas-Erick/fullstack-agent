// Phone client for the companion server (main/companion.js, docs/ROADMAP-mobile.md step 2).
// Talks only to the server it was loaded from. The device token lives in this browser's storage.
import { initScreens, render as renderScreen, busy as screenBusy, TITLES, screenBack, hasScreenBack } from './screens.js';
import { streamStale, refreshPlan, convCheck, batcher, backPlan, unsentPlan, priorUsersFor, DEADLINES, transcribeDeadline, retryAction, plainStatus, networkFailure, micError, toastMs, keyboardState, releasePlan } from './sync.js';
// Served by the desktop from renderer/js/ (companion.js STATIC), so loaded by URL, not by file.
// The conversation's turns from the events, the face's state (turnstate.js), and what a message shows (the
// tool labels, the stamp, a failed reply in plain words: chatcore.js): the desktop's own modules.
import { createChat, faceState } from './js/turnstate.js';
import * as chatcore from './js/chatcore.js';
let mathtext = null;
import('./js/mathtext.js').then((m) => (mathtext = m)).catch(() => {});

const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'nexus.token';
const CONV_KEY = 'nexus.conv';
const SPEAK_KEY = 'nexus.speak';
const NAME_KEY = 'nexus.deviceName';
// Present inside the Android app (android/): background notifications, the Talk tile, the share sheet.
const android = window.NexusAndroid || null;
// The Android app's bridge: what changes something takes the key the app hands this page once per load
// (hello); a custom face's frame never gets it. Older apps have no hello and take no key.
const keyed = typeof android?.hello === 'function';
const bridgeKey = keyed ? String(android.hello() || '') : '';
function bridge(name, ...args) {
  if (typeof android?.[name] !== 'function') return undefined;
  if (!keyed) return android[name](...args);
  return bridgeKey ? android[name](bridgeKey, ...args) : undefined; // no key this load: skipped, never thrown
}

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
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* private mode: works until the page closes */
    }
  },
};

// The open conversation and its replies: this phone's own (chat.own, requestId null while its send is in
// flight, events held meanwhile) and those started elsewhere in it (chat.others). A turn's nodes are its view.
const chat = createChat();
chat.setConv(store.get(CONV_KEY));
const replying = () => Boolean(chat.own || chat.others.length);

const state = {
  token: store.get(TOKEN_KEY),
  get convId() {
    return chat.convId;
  },
  set convId(id) {
    chat.setConv(id);
  },
  shownConv: undefined, // the conversation whose messages are drawn (null: a new one; undefined: none yet)
  face: 'idle', // what the face shows now (refreshFace): faceState, 'speaking-text' for a reply written without a voice
  recording: false,
  transcribing: false,
  playing: false,
  name: 'Siren',
  view: 'chat', // chat | sched | a screen from screens.js (today, learn, memory, notes, world, arch, skills, more)
  info: null, // the computer's /api/info
  client: '', // the phone client's version this page was loaded as (/api/info client)
  calendar: false,
  convTitle: '',
  secureUrl: '', // the computer's https address, when it has one
  speak: store.get(SPEAK_KEY) === '1',
  voice: false,
  stream: null,
};

// ------------------------------------------------------------------ helpers
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}

const icon = (id) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${id}`);
  svg.append(use);
  return svg;
};

// Links in replies open outside the app (a new tab; in the Android app, the browser), never in place
// of it, and only web and mail links stay clickable. A [[link]] between notes (screens.js openNote
// writes it as #note:<name>) stays in the page: a fragment can't run anything.
window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  if ((node.getAttribute('href') || '').startsWith('#note:')) return;
  if (!/^(https?:|mailto:)/i.test(node.getAttribute('href') || '')) return node.removeAttribute('href');
  node.setAttribute('target', '_blank');
  node.setAttribute('rel', 'noopener noreferrer');
});

// Formulas as on the desktop (renderer/js/util.js): taken out before Markdown, rendered by KaTeX. Here
// as MathML only, which the browser draws itself: no inline styles (the page's CSP) and no math fonts.
function markdown(text) {
  const math = window.katex && mathtext ? mathtext.extractMath(String(text ?? '')) : { text: String(text ?? ''), items: [] };
  let html = window.marked.parse(math.text, { breaks: true, gfm: true });
  if (math.items.length) html = mathtext.restoreMath(html, math.items, renderTex);
  return window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'img'], FORBID_ATTR: ['style'], ADD_ATTR: ['target'] });
}

function renderTex(tex, display) {
  try {
    // Without the TeX source KaTeX keeps in <annotation>: the sanitizer would leave it as visible text.
    return window.katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'mathml', strict: 'ignore', trust: false, maxExpand: 1000 }).replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');
  } catch {
    return `<code>${tex.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])}</code>`;
  }
}

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return new Date(t).toLocaleDateString(undefined, { weekday: 'long' });
  return new Date(t).toLocaleDateString();
};

// A notice above the composer. Without a button it lets taps through (it often sits on the message box);
// `action` ({ label, run }) adds one, and then it takes taps.
let toastTimer;
function toast(msg, action = null) {
  const t = $('#toast');
  t.replaceChildren(el('span', {}, msg));
  if (action) t.append(el('button', { class: 'toast-btn', type: 'button', onclick: () => (t.classList.add('hidden'), action.run()) }, action.label));
  t.classList.toggle('actionable', Boolean(action));
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), toastMs(msg, Boolean(action)));
}

// A phone has no developer console: a script error (a screen that failed to draw, a browser missing a
// feature) shows as a notice instead of a silent blank, so it can be reported; its own words under Details.
let lastError = '';
function scriptError(text) {
  if (text === lastError) return;
  lastError = text;
  toast('Something went wrong on this device.', { label: 'Details', run: () => toast(text.slice(0, 300)) });
}
window.addEventListener('error', (e) => scriptError(String(e.message || e.error?.message || 'Script error')));
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r instanceof AuthError || r?.name === 'AbortError') return;
  scriptError(String(r?.message || r || 'Error'));
});

class AuthError extends Error {}
// The computer didn't answer at all (off, asleep, Siren closed, another network): the screens show a
// "can't reach your computer" card instead of the browser's "Failed to fetch".
class NetError extends Error {}

// fetch with a deadline for the answer's headers (a body being read, /api/speak's audio, is never cut
// off): past `ms` a NetError, as if the computer were off. 0 = no deadline.
async function fetchWithin(url, init, ms) {
  const ctl = new AbortController();
  const timer = ms ? setTimeout(() => ctl.abort(), ms) : 0;
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err) {
    if (ctl.signal.aborted) throw new NetError('Your computer isn’t answering right now.');
    if (networkFailure(err)) throw new NetError('Can’t reach your computer right now.'); // not the browser's "Failed to fetch"
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// A tunnel or proxy answering for a computer that is off (Cloudflare's or Tailscale Serve's error page);
// the computer's own errors (voice 502/503 among them) are JSON.
const tunnelDown = (res) => [502, 503, 504, 530].includes(res.status) && !/json/i.test(res.headers.get('content-type') || '');

// An answer that isn't ok, as an Error with the server's own words, else its status in plain words.
// `fromServer`: the text is meant for the user (screens.js shows it as it is).
async function answerError(res, opts) {
  const data = await res.json().catch(() => ({}));
  const err = new Error(typeof data.error === 'string' && data.error ? data.error : plainStatus(res.status, opts));
  err.fromServer = true;
  return err;
}

async function api(path, { method = 'GET', body, raw = false, timeoutMs = 0 } = {}) {
  let res;
  try {
    res = await fetchWithin(path, {
      method,
      headers: { Authorization: `Bearer ${state.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, timeoutMs);
  } catch (err) {
    if (err instanceof NetError || err?.name === 'AbortError') throw err;
    throw new NetError('Can’t reach your computer right now.');
  }
  if (tunnelDown(res)) throw new NetError('Your computer isn’t answering right now.');
  if (res.status === 401) {
    unpair('This device was disconnected from the assistant. Pair it again.');
    throw new AuthError('Not paired');
  }
  if (!res.ok) throw await answerError(res);
  return raw ? res : res.json();
}

function setConvTitle(t) {
  state.convTitle = t;
  if (state.view === 'chat') $('#convTitle').textContent = t;
}

function show(screen) {
  $('#pair').classList.toggle('hidden', screen !== 'pair');
  $('#main').classList.toggle('hidden', screen !== 'main');
  syncBack();
}

// ------------------------------------------------------------------ pairing
// The pairing QR code opened in the phone's browser: open the Siren app with it (Chrome's intent: link,
// falling back to this page in the browser), and let the user choose if the browser held the jump back.
function offerApp(secret) {
  const link = `${location.origin}/#pair=${secret}`;
  const web = `${location.origin}/?web=1#pair=${secret}`;
  const intent = `intent://pair?u=${encodeURIComponent(link)}#Intent;scheme=siren;package=com.nexusagent.android;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  show('pair');
  $('#pairForm').classList.add('hidden');
  const box = el('div', { class: 'handoff' },
    el('p', {}, 'Open this pairing in the Siren app?'),
    el('a', { class: 'btn primary', href: intent }, 'Open in the Siren app'),
    el('a', { class: 'btn ghost', href: web }, 'Continue in the browser'),
  );
  $('#pairForm').after(box);
  location.href = intent; // may be held back without a tap; the buttons are then the way
}

function unpair(message) {
  state.token = null;
  store.set(TOKEN_KEY, null);
  bridge('clearToken');
  state.stream?.abort();
  closeDrawer();
  show('pair');
  if (message) showPairError(message);
}

// Disconnecting deletes this device's token (the watch stops too): the first tap arms, a second one
// within 5 s disconnects; a double tap (under 0.4 s) counts once. The note above the button says why
// (empty until armed, so the live region exists before it speaks).
const unpairNote = el('p', { class: 'unpair-note', role: 'status' });
$('#unpairBtn').before(unpairNote);
let unpairArmedAt = 0;
let unpairTimer = 0;
function disarmUnpair() {
  clearTimeout(unpairTimer);
  unpairArmedAt = 0;
  $('#unpairBtn').classList.remove('armed');
  $('#unpairBtn').textContent = 'Disconnect this device';
  unpairNote.textContent = '';
}
function tapUnpair() {
  if (unpairArmedAt && Date.now() - unpairArmedAt >= 400) return unpair('Disconnected. To remove this device completely, remove it in the desktop app’s Settings too.');
  if (unpairArmedAt) return;
  unpairArmedAt = Date.now();
  $('#unpairBtn').classList.add('armed');
  $('#unpairBtn').textContent = 'Tap again to disconnect';
  unpairNote.textContent = 'You’ll need a new pairing code from the computer; the watch stops too.';
  unpairTimer = setTimeout(disarmUnpair, 5000);
}

function showPairError(msg) {
  const e = $('#pairError');
  e.textContent = msg;
  e.classList.toggle('hidden', !msg);
}

// { code } typed, or { secret } from the QR code's link.
async function pair(proof) {
  const btn = $('#pairBtn');
  if (btn.disabled) return;
  showPairError('');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const res = await fetchWithin('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...proof, name: $('#pairName').value.trim() || guessName() }),
    }, DEADLINES.pair);
    if (tunnelDown(res)) throw new NetError('Your computer isn’t answering right now.');
    if (!res.ok) {
      if (proof.secret && res.status === 403) throw new Error('This QR code has expired or was already used. Click “Pair a device” on the computer again.');
      throw await answerError(res);
    }
    const data = await res.json().catch(() => ({}));
    state.token = data.token;
    store.set(TOKEN_KEY, data.token);
    store.set(NAME_KEY, data.name);
    $('#pairCode').value = '';
    start();
  } catch (err) {
    showPairError(err.message);
    if (!proof.secret) $('#pairCode').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

$('#pairForm').addEventListener('submit', (e) => {
  e.preventDefault();
  pair({ code: $('#pairCode').value.trim() });
});
// Digits only; the sixth one connects.
$('#pairCode').addEventListener('input', (e) => {
  const v = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (v !== e.target.value) e.target.value = v;
  if (v.length === 6 && document.activeElement === e.target) submitForm($('#pairForm'));
});

// Submits a form the way Enter would (older Safari has no requestSubmit).
function submitForm(form) {
  if (form.requestSubmit) form.requestSubmit();
  else form.querySelector('button[type="submit"]')?.click();
}

function guessName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/iPhone/i.test(ua)) return 'iPhone';
  // An iPad announces itself as a Mac (Safari's desktop mode), but a Mac has no touch screen.
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  return 'Browser';
}

// ------------------------------------------------------------------ events
// Server-Sent Events over fetch (EventSource can't send the Authorization header). Reconnects with backoff.
async function openStream() {
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
function retryNow() {
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

// ------------------------------------------------------------------ can't reach the computer
// Instead of an empty screen: what is going on, what to check, when it tries again, and a button to try
// now. Shown once the link has been down for a moment (state.connected false after the banner's delay);
// "Continue offline" keeps the banner and whatever is already on the screen.
const SEEN_KEY = 'nexus.lastSeen';
let offlineTick = null;
function renderOffline() {
  let box = $('#offline');
  const down = state.token && state.connected === false && !state.offlineDismissed && $('#banner').classList.contains('offline');
  if (!down) {
    clearInterval(offlineTick);
    offlineTick = null;
    box?.remove();
    syncBack();
    return;
  }
  if (!box) {
    box = el('div', { id: 'offline', class: 'offline-screen', role: 'alertdialog', 'aria-labelledby': 'offlineTitle', 'aria-describedby': 'offlineText' });
    document.body.append(box);
  }
  const seen = Number(store.get(SEEN_KEY)) || 0;
  const lan = /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.|\.local$|^localhost$/.test(location.hostname);
  const tips = [
    'Siren is open on your computer, and the computer is awake.',
    'Remote access is on there (Settings → Remote access).',
    lan ? 'This device is on the same Wi-Fi as the computer.' : /\.ts\.net$/.test(location.hostname) ? 'Tailscale is on, on this device and on the computer.' : 'The computer is online.',
  ];
  const when = el('span', { class: 'offline-when' });
  const tick = () => {
    const s = Math.max(0, Math.round(((state.retryAt || 0) - Date.now()) / 1000));
    when.textContent = s ? `Trying again in ${s} s` : 'Trying again…';
  };
  box.replaceChildren(
    el(
      'div',
      { class: 'offline-card' },
      el('div', { class: 'offline-orb', 'aria-hidden': 'true' }, el('span'), icon('unlink')),
      el('h2', { id: 'offlineTitle' }, 'Can’t reach your computer'),
      el('p', { id: 'offlineText', class: 'muted' }, `${state.name || 'Siren'} lives on your computer${location.host ? ` (${location.host})` : ''}, and it isn’t answering.${seen ? ` Last connected ${ago(seen)}.` : ''}`),
      el('ul', { class: 'offline-tips' }, ...tips.map((t) => el('li', {}, t))),
      el('div', { class: 'offline-status' }, el('span', { class: 'spin', 'aria-hidden': 'true' }), when),
      el(
        'div',
        { class: 'offline-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => (retryNow(), (state.retryAt = Date.now()), tick()) }, 'Try again now'),
        android ? el('button', { class: 'btn', type: 'button', onclick: () => bridge('changeServer') }, 'Change the address') : null,
        el('button', { class: 'btn ghost', type: 'button', onclick: () => ((state.offlineDismissed = true), renderOffline()) }, 'Continue offline'),
      ),
    ),
  );
  tick();
  clearInterval(offlineTick);
  offlineTick = setInterval(tick, 1000);
  syncBack();
}

// Plain http on another machine: the token and messages cross the network unencrypted.
const insecure = !window.isSecureContext && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const INSECURE_KEY = 'nexus.insecureSeen';
const insecureSeen = () => {
  try {
    return Boolean(sessionStorage.getItem(INSECURE_KEY));
  } catch {
    return false;
  }
};

function renderBanner() {
  const b = $('#banner');
  b.innerHTML = '';
  b.className = 'banner';
  if (state.token && state.connected === false) {
    b.classList.add('offline');
    b.append(el('span', { class: 'spin', 'aria-hidden': 'true' }), 'Can’t reach the computer. Retrying…');
  } else if (insecure && state.token && state.secureUrl) {
    b.classList.add('warn', 'offer');
    b.append(icon('lock-open'), el('span', {}, 'Not encrypted. A secure address is set up: switch once and it works away from home too.'), el('button', { class: 'banner-btn', type: 'button', onclick: moveToSecure }, 'Switch'));
  } else if (insecure && !insecureSeen()) {
    b.classList.add('warn');
    b.append(icon('lock-open'), el('span', {}, 'Not encrypted: local network only. Away from home, use the secure https address.'), el('button', { class: 'banner-x', 'aria-label': 'Dismiss', onclick: () => {
      try {
        sessionStorage.setItem(INSECURE_KEY, '1');
      } catch {
        /* private mode */
      }
      renderBanner();
    } }, icon('close')));
  } else b.classList.add('hidden');
  renderOffline();
}

// ------------------------------------------------------------------ chat
// An event of the device stream: turnstate.js decides whose turn it is (this phone's, one started on the
// computer or another device in the conversation shown, or none) and keeps its text, tools and outcome.
function onChat(ev) {
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
function turnView(mine = false) {
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

function renderTurn(turn) {
  const v = turn.view;
  if (v.raf) return;
  v.raf = requestAnimationFrame(() => {
    v.raf = 0;
    v.bubble.innerHTML = markdown(turn.text);
    scrollDown();
  });
}

// A turn is over (turnstate ended it on its event; a send that failed or a reconnect end it here).
function endTurn(turn) {
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

function addMessage(m) {
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
    // Files attached on the computer: their names only (main/companion.js messageForDevice).
    if (m.attachments?.length) wrap.append(el('div', { class: 'meta' }, `📎 ${m.attachments.map((a) => a.name).join(' · ')}`));
    if (m.remote) wrap.append(el('div', { class: 'meta' }, `from ${m.remote}`));
  }
  $('#messages').append(wrap);
  updateEmpty();
  return wrap;
}

// Follows new text only while the reader is at the bottom; scrolled up, a button jumps back down.
let stick = true;
function scrollDown(force = false) {
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

const updateEmpty = () => $('#empty').classList.toggle('hidden', $('#messages').childElementCount > 0);

async function send(text) {
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
  const input = $('#input');
  const text = input.value;
  input.value = '';
  autosize();
  send(text);
});
$('#input').addEventListener('keydown', (e) => {
  // On a hardware keyboard Enter sends; Shift+Enter makes a new line.
  // Tablets count too: a Book Cover keyboard doesn't make the pointer "fine".
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && (matchMedia('(pointer: fine)').matches || document.body.classList.contains('wide'))) {
    e.preventDefault();
    submitForm($('#composer'));
  }
});
const autosize = () => {
  const i = $('#input');
  i.style.height = '48px';
  i.style.height = `${Math.min(140, Math.max(48, i.scrollHeight + 2))}px`;
};
$('#input').addEventListener('input', autosize);
$('#stopBtn').addEventListener('click', () => {
  const id = chat.own?.requestId;
  if (id) api(`/api/chat/${encodeURIComponent(id)}/abort`, { method: 'POST', body: {} }).catch((err) => toast(err.message));
});

// ------------------------------------------------------------------ conversations
let convSeq = 0; // only the latest load draws (a reconnect and a tap can overlap)
async function loadConversation(id) {
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
async function refreshConvs() {
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
    if (!(err instanceof AuthError)) list.replaceChildren(el('li', { class: 'muted' }, err.message));
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

function closeDrawer() {
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

// ------------------------------------------------------------------ approvals
const KIND = { self_modify: 'Change its own code', settings: 'Change a setting', endpoint: 'Change where it connects', permissions: 'Get more access', delete: 'Delete something', command: 'Run a command', calendar: 'Change your calendar', invite: 'Send calendar invitations', voice: 'Change its voice', voice_clone: 'Clone a voice', repo_change: 'Change a repository', github_publish: 'Publish to GitHub', connector: 'Use a connected service', connector_trust: 'Stop asking for a service', browser: 'Act on a website', web_outbound: 'Open a web address' };

// The buttons wait a moment before they respond, so a tap meant for something else (the card pops in
// above the keyboard while typing) can't answer it.
const ARM_MS = 900;
const timers = new Map(); // approval id -> countdown interval

function addApproval(a) {
  removeApproval(a.id);
  const sources = Array.isArray(a.sources) ? a.sources.slice(0, 5).map((s) => String(s).slice(0, 200)) : [];
  const left = el('span', { class: 'left' });
  const buttons = [
    el('button', { class: 'btn', type: 'button', disabled: '', onclick: () => answer(a.id, false) }, 'Deny'),
    el('button', { class: 'btn primary', type: 'button', disabled: '', onclick: () => answer(a.id, true) }, 'Allow'),
  ];
  const card = el('div', { class: 'approval', 'data-id': a.id, role: 'alertdialog', 'aria-label': a.title || 'Approval needed' },
    el('div', { class: 'kind' }, KIND[a.kind] || a.kind, left),
    el('b', {}, a.title || 'Approval needed'),
    a.detail ? el('pre', { class: 'detail' }, String(a.detail).slice(0, 1500)) : null,
    a.tainted ? el('div', { class: 'warn' }, '⚠ This turn read outside content (web pages or documents). Make sure this is what you asked for.', sources.length ? el('ul', { class: 'sources' }, sources.map((s) => el('li', {}, s))) : null) : null,
    // Self-changes and "stop asking for a service" are answered only on the computer (companion.js).
    a.desktopOnly ? el('div', { class: 'desktop-only' }, 'Approve or deny this one on your computer.') : el('div', { class: 'row' }, buttons),
  );
  $('#approvals').append(card);
  if (!a.desktopOnly) setTimeout(() => buttons.forEach((b) => b.removeAttribute('disabled')), ARM_MS);
  // Countdown to the automatic "no" on the computer.
  const ends = Date.now() + (a.expiresIn ?? a.timeoutSec ?? 0) * 1000;
  const tick = () => {
    const s = Math.round((ends - Date.now()) / 1000);
    if (s <= 0) return removeApproval(a.id);
    left.textContent = ` · ${s}s`;
  };
  if (a.expiresIn ?? a.timeoutSec) {
    tick();
    timers.set(a.id, setInterval(tick, 1000));
  }
  navigator.vibrate?.(80);
}

function removeApproval(id) {
  clearInterval(timers.get(id));
  timers.delete(id);
  document.querySelector(`.approval[data-id="${CSS.escape(String(id))}"]`)?.remove();
}

async function answer(id, allow) {
  removeApproval(id);
  try {
    await api(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { allow } });
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message.includes('No open approval') ? 'Already answered (or timed out).' : err.message);
  }
}

// ------------------------------------------------------------------ voice out
// `audio` feeds the face's analyser once that exists (see ensureAnalyser); `plainAudio` is never routed,
// so a reply is still heard if the browser has suspended the analyser's audio graph.
const audio = new Audio();
const plainAudio = new Audio();
for (const a of [audio, plainAudio]) {
  a.addEventListener('ended', () => ((state.playing = false), refreshFace()));
  a.addEventListener('playing', () => ((state.playing = true), refreshFace()));
}

async function player() {
  if (!voiceCtx) return audio;
  if (voiceCtx.state !== 'running') await voiceCtx.resume().catch(() => {});
  return voiceCtx.state === 'running' ? audio : plainAudio;
}

function speakable(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_~>|#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function say(md) {
  const text = speakable(md);
  if (!text) return;
  try {
    const res = await api('/api/speak', { method: 'POST', body: { text }, raw: true });
    const p = await player();
    for (const a of [audio, plainAudio]) a.pause();
    if (p.src) URL.revokeObjectURL(p.src);
    p.src = URL.createObjectURL(await res.blob());
    await p.play();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message);
  }
}

function setSpeak(on) {
  state.speak = on;
  store.set(SPEAK_KEY, on ? '1' : '0');
  $('#speakBtn').replaceChildren(icon(on ? 'speaker-on' : 'speaker-off'));
  $('#speakBtn').classList.toggle('on', on);
  $('#speakBtn').setAttribute('aria-pressed', String(on));
  if (!on) for (const a of [audio, plainAudio]) a.pause();
}
$('#speakBtn').addEventListener('click', () => {
  if (!state.voice && !state.speak) return toast('No voice is set up on the computer (Settings → Voice).');
  setSpeak(!state.speak);
  // A tap unlocks audio playback on mobile browsers, and is the moment to set up the face's analyser.
  if (state.speak) {
    ensureAnalyser();
    for (const a of [audio, plainAudio]) a.play().catch(() => {});
  }
});

// ------------------------------------------------------------------ push-to-talk
// Hold the mic, release to send. The recording (16 kHz mono WAV, at most two minutes) is transcribed on the
// computer with its usual speech-to-text, then sent like a typed message. Browsers allow the
// microphone only on secure pages, so the button shows on the HTTPS address only.
const MAX_REC_MS = 120000; // the server takes as much (main/companion.js MAX_AUDIO_SEC)
let rec = null;

// toggle: a tap (or the Talk tile, a shortcut, Enter): it stops on the next tap of the mic, not on release.
async function startRecording({ toggle = false } = {}) {
  if (rec || chat.own) return;
  const mine = { chunks: [], starting: true, toggle, asked: Date.now() };
  rec = mine;
  $('#micBtn').setAttribute('aria-pressed', 'true'); // live from the press on, also while the microphone starts
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    state.micBlocked = false;
    if (rec !== mine) {
      stream.getTracks().forEach((t) => t.stop());
      // The permission prompt took the touch away (pointercancel, blur): say it is ready now, instead of nothing.
      if (mine.lost && Date.now() - mine.asked > 600) toast('Microphone allowed. Tap or hold the mic to talk.');
      return;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      rec?.chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      state.micLevel = Math.min(1, Math.sqrt(sum / data.length) * 5); // same scale as the desktop
    };
    src.connect(node);
    node.connect(ctx.destination);
    Object.assign(rec, { stream, ctx, node, rate: ctx.sampleRate, started: Date.now(), starting: false, limit: setTimeout(() => (toast('That’s the two-minute limit: sending what you said.'), stopRecording()), MAX_REC_MS) });
    $('#micBtn').classList.add('live');
    showRecBar(rec);
    state.recording = true;
    refreshFace();
    navigator.vibrate?.(30);
  } catch (err) {
    if (rec === mine) (rec = null), $('#micBtn').setAttribute('aria-pressed', 'false');
    // Refused for good in the Android app: the way back is its settings (nexusMicBlocked, below).
    if (android && state.micBlocked && err?.name === 'NotAllowedError') micBlockedNotice();
    else toast(micError(err, { app: Boolean(android) }));
  }
}

// Inside the Android app the microphone is the app's permission, not the page's: refused with "don't ask
// again" (MainActivity), only Android's settings can allow it.
function micBlockedNotice() {
  const settings = typeof android?.openAppSettings === 'function';
  toast('The microphone is off for Siren in Android settings.', settings ? { label: 'Open settings', run: () => bridge('openAppSettings', 'app') } : null);
}
window.nexusMicBlocked = () => {
  state.micBlocked = true;
  micBlockedNotice();
};

async function stopRecording() {
  const r = rec;
  rec = null;
  $('#micBtn').setAttribute('aria-pressed', 'false');
  if (!r || r.starting) return;
  clearTimeout(r.limit);
  r.node.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close().catch(() => {});
  state.micLevel = 0;
  $('#micBtn').classList.remove('live');
  hideRecBar();
  state.recording = false;
  if (Date.now() - r.started < 400) return refreshFace(), toast('Too short to hear anything: tap the mic, speak, then tap it again.');
  const mic = $('#micBtn');
  mic.classList.add('busy');
  state.transcribing = true;
  refreshFace();
  $('#faceState').textContent = 'TRANSCRIBING';
  try {
    const wav = encodeWav(await to16k(r.chunks, r.rate));
    const res = await fetchWithin('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'audio/wav' }, body: wav }, transcribeDeadline(wav.byteLength));
    if (res.status === 401) return unpair('This device was disconnected from the assistant. Pair it again.');
    // A tunnel's error page for a computer that is off (as api() reads it): not the computer's own JSON.
    if (tunnelDown(res)) throw new NetError('Your computer isn’t answering right now.');
    if (!res.ok) throw await answerError(res, { recording: true });
    const data = await res.json().catch(() => ({}));
    state.transcribing = false;
    refreshFace();
    if (data.text?.trim()) send(data.text.trim());
    else toast('I didn’t catch that.');
  } catch (err) {
    state.transcribing = false;
    refreshFace();
    toast(err.message);
  } finally {
    mic.classList.remove('busy');
    if (state.transcribing) (state.transcribing = false), refreshFace(); // unpaired meanwhile
  }
}

// While recording: elapsed time and the input level above the message box.
let recTimer = null;
function showRecBar(r) {
  $('#recHint').textContent = r.toggle ? 'Tap the mic to send' : 'Release to send';
  $('#recBar').classList.remove('hidden');
  const tick = () => {
    const s = Math.floor((Date.now() - r.started) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('#recLevel').style.transform = `scaleX(${Math.max(0.04, state.micLevel).toFixed(3)})`;
  };
  tick();
  clearInterval(recTimer);
  recTimer = setInterval(tick, 100);
}
function hideRecBar() {
  clearInterval(recTimer);
  $('#recBar').classList.add('hidden');
}

async function to16k(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) all.set(c, (o += c.length) - c.length);
  if (rate === 16000) return all;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil((n * 16000) / rate)), 16000);
  const buf = off.createBuffer(1, n, rate);
  buf.copyToChannel(all, 0);
  const s = off.createBufferSource();
  s.buffer = buf;
  s.connect(off.destination);
  s.start();
  return (await off.startRendering()).getChannelData(0);
}

function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return buf;
}

if (window.isSecureContext && navigator.mediaDevices?.getUserMedia) {
  // Hold and release to send, or tap to start and tap again to send (sync.js releasePlan): a quick touch,
  // TalkBack's double tap, Enter or Space all listen until the next tap.
  const mic = $('#micBtn');
  mic.classList.remove('hidden');
  let pressAt = 0; // the press in progress (0: none)
  let pointerAt = 0; // the last press by pointer: the click that follows it was handled already
  const toToggle = () => {
    rec.toggle = true;
    if (!rec.starting) $('#recHint').textContent = 'Tap the mic to send';
  };
  // The touch was taken away (the permission prompt, another app): a hold that recorded sends, one that
  // hadn't started is dropped (startRecording says when the microphone is ready).
  const lostPress = () => {
    if (!pressAt) return;
    pressAt = 0;
    pointerAt = Date.now();
    if (!rec || rec.toggle) return;
    if (rec.starting) (rec.lost = true), (rec = null), mic.setAttribute('aria-pressed', 'false');
    else stopRecording();
  };
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointerAt = Date.now();
    if (rec) return stopRecording(); // the second tap; or a hold whose release never arrived
    try {
      mic.setPointerCapture(e.pointerId); // keep the release even if the finger slides off
    } catch {
      /* not a real pointer */
    }
    pressAt = Date.now();
    startRecording();
  });
  mic.addEventListener('pointerup', () => {
    if (!pressAt) return;
    const heldMs = Date.now() - pressAt;
    pressAt = 0;
    pointerAt = Date.now();
    if (!rec || rec.toggle) return;
    if (releasePlan({ heldMs, starting: rec.starting }) === 'toggle') toToggle();
    else stopRecording();
  });
  mic.addEventListener('pointercancel', lostPress);
  window.addEventListener('blur', lostPress);
  mic.addEventListener('click', () => {
    if (Date.now() - pointerAt < 700) return; // the press above did it
    if (rec) return stopRecording();
    startRecording({ toggle: true });
  });
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
  // The Android Talk tile / shortcut: start listening; tap the mic to send.
  window.nexusTalk = () => {
    if (!state.token) return;
    startRecording({ toggle: true }).then(() => rec && toast('Listening… tap the mic to send.'));
  };
}

// ------------------------------------------------------------------ face
// The same face the desktop shows: its built-in faces are served from /js/ and fed with this phone's
// state through faces/env.js. The small orb further down is the fallback if they can't be loaded.
const STATES = { idle: ['IDLE', 0.3, 0.6], listening: ['LISTENING', 0.8, 1], thinking: ['THINKING', 2.4, 0.85], working: ['WORKING', 3.2, 0.9], 'speaking-text': ['REPLYING', 1.2, 1], speaking: ['SPEAKING', 1.2, 1], happy: ['DONE', 0.9, 1], sleeping: ['ASLEEP', 0.05, 0.35] };
const FACE_MODULES = { circuit: ['./js/visualizer.js', 'CircuitFace'], radial: ['./js/faces/radial.js', 'RadialFace'], rain: ['./js/faces/rain.js', 'RainFace'], neural: ['./js/faces/neural.js', 'NeuralFace'], companion: ['./js/faces/companion.js', 'CompanionFace'], siren: ['./js/faces/siren.js', 'SirenFace'] };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const faceView = { id: '', obj: null, themeFns: new Set(), orb: false };
state.happyUntil = 0;
state.lastActivity = Date.now();
state.sleepAfterMin = 0;
state.asleepAtStart = true; // asleep since the app opened, from the first frame (the desktop's ui.sleepOnLaunch may say otherwise), until something happens
state.micLevel = 0;

// What goes on now, for turnstate.faceState (the desktop's rule): the mic, the voice, a transcription, and every
// reply being written in the conversation shown, whoever started it. Replies are spoken only once done here.
const faceNow = () => ({ recording: state.recording, playing: state.playing, transcribing: state.transcribing, ...chat.activity(), spoken: false });

// The face follows what goes on (call after any of it changes).
function refreshFace() {
  const s = faceState(faceNow());
  setFace(s === 'speaking' && !state.playing ? 'speaking-text' : s);
}

function setFace(s) {
  state.face = s;
  if ((s === 'idle' || s === 'happy') && state.worldWork && !state.worldWork.done) state.worldWork.done = Date.now(); // the turn is over: the persona lingers, then is free
  if (s !== 'idle') wake();
  updateFaceLabel();
}

// Anything that counts as doing something: typing, the mic, a turn.
function wake() {
  state.lastActivity = Date.now();
  state.asleepAtStart = false;
  state.woken = true;
}

// The state as the desktop names it: replying without a voice is "speaking"; after a reply, a moment of
// "happy"; asleep since the app opened, or after quiet minutes (the desktop's ui.sleepAfterMin), "sleeping".
function agentState() {
  const now = Date.now();
  const sleeping = state.asleepAtStart || Boolean(state.sleepAfterMin && now - state.lastActivity > state.sleepAfterMin * 60000);
  return faceState({ ...faceNow(), happy: state.happyUntil > now, sleeping });
}

function updateFaceLabel() {
  const s = state.face === 'speaking-text' ? 'speaking-text' : agentState();
  $('#faceState').textContent = (STATES[s] || STATES.idle)[0];
  document.body.classList.toggle('asleep', s === 'sleeping'); // the scene behind the face dims
}
setInterval(updateFaceLabel, 1000);
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => (state.lastActivity = Date.now()), { passive: true });
for (const ev of ['focus', 'pointerdown', 'keydown', 'input']) $('#input').addEventListener(ev, () => (wake(), updateFaceLabel()));
$('#micBtn').addEventListener('pointerdown', () => (wake(), updateFaceLabel()));

// The scene behind the face: fetched when its key in /api/info changes, cleaned again here (DOMPurify's
// SVG profile) before it joins the page; none → cleared.
const SCENE_PURIFY = { USE_PROFILES: { svg: true }, FORBID_TAGS: ['style', 'foreignObject', 'image', 'use', 'a', 'script', 'filter', 'animate', 'animateTransform', 'animateMotion', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'filter'] };
async function applyScene(sc) {
  const key = typeof sc?.key === 'string' ? sc.key : '';
  if (key === state.sceneKey) return;
  const holder = $('#faceScene');
  if (!key) {
    state.sceneKey = '';
    holder.replaceChildren();
    holder.classList.remove('on');
    return;
  }
  try {
    const r = await api('/api/scene');
    const one = (text, cls) => window.DOMPurify.sanitize(String(text), SCENE_PURIFY).replace(/^<svg\b/, `<svg class="${cls}"`);
    holder.innerHTML = r.svg ? one(r.svg, 'landscape') + (r.portrait ? one(r.portrait, 'portrait') : '') : '';
    holder.classList.toggle('on', Boolean(r.svg));
    state.sceneKey = key;
  } catch {
    /* the next info.changed or reload tries again */
  }
}

// Spoken replies drive the face like on the desktop: an analyser on the reply audio. Created on a tap
// (a suspended audio graph would silence the replies), and only used while it is running.
let voiceCtx = null;
let voiceAnalyser = null;
function ensureAnalyser() {
  try {
    if (!voiceCtx) {
      voiceCtx = new AudioContext();
      const src = voiceCtx.createMediaElementSource(audio);
      voiceAnalyser = voiceCtx.createAnalyser();
      src.connect(voiceAnalyser);
      voiceAnalyser.connect(voiceCtx.destination);
    }
    voiceCtx.resume().catch(() => {});
  } catch {
    voiceCtx = null;
    voiceAnalyser = null;
  }
}
document.addEventListener('pointerdown', ensureAnalyser, { once: true, passive: true });
const analyserLive = () => Boolean(voiceAnalyser && voiceCtx?.state === 'running');

// Full screen: only the face (like the desktop's face layout). The button or Esc returns; the face keeps
// reacting to the conversation, so it works as a bedside or desk display on a tablet.
function setFaceFull(on) {
  document.body.classList.toggle('face-full', on);
  $('#faceFull').setAttribute('aria-pressed', String(on));
  $('#faceFull').setAttribute('aria-label', on ? 'Back to the chat' : 'Show the face full screen');
  $('#faceFull').replaceChildren(icon(on ? 'close' : 'expand'));
  if (on) document.documentElement.requestFullscreen?.().catch(() => {});
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  syncBack();
}
$('#faceFull').addEventListener('click', () => setFaceFull(!document.body.classList.contains('face-full')));
document.addEventListener('keydown', (e) => e.key === 'Escape' && document.body.classList.contains('face-full') && setFaceFull(false));
document.addEventListener('fullscreenchange', () => !document.fullscreenElement && document.body.classList.contains('face-full') && setFaceFull(false));

async function mountFace(id, theme) {
  const want = FACE_MODULES[id] ? id : 'siren';
  try {
    const [{ configureFaces }, { normalizeTheme }] = await Promise.all([import('./js/faces/env.js'), import('./js/themecore.js')]);
    state.theme = normalizeTheme(theme);
    configureFaces({
      agentState,
      alert: () => null,
      theme: () => state.theme,
      analyser: () => (analyserLive() ? voiceAnalyser : null),
      // Audio playing without an analyser still makes the face talk.
      synthLevel: () => (state.face === 'speaking' && !analyserLive() ? 0.35 + 0.35 * Math.abs(Math.sin(performance.now() / 90)) : 0),
      micLevel: () => state.micLevel,
      demo: () => null,
      onTheme: (fn) => (faceView.themeFns.add(fn), () => faceView.themeFns.delete(fn)),
    });
    faceView.themeFns.forEach((fn) => fn());
    if (theme.face?.custom && (await mountCustomFace().catch(() => false))) return;
    if (faceView.id === want && faceView.obj) return faceView.obj.setLabel(state.name);
    const [file, cls] = FACE_MODULES[want];
    const Face = (await import(file))[cls];
    faceView.obj?.destroy?.();
    const canvas = el('canvas', { id: 'face', 'aria-hidden': 'true' });
    $('#face').replaceWith(canvas);
    faceView.obj = new Face(canvas, { compact: true });
    faceView.obj.setLabel(state.name);
    faceView.id = want;
    faceView.orb = false;
  } catch {
    // An older desktop that doesn't serve the faces, or a face that failed: the built-in orb.
    if (!faceView.orb && !faceView.obj) (faceView.orb = true), startFace();
  }
}

// The desktop's custom face (a page from its faces folder): a short-lived link from /api/face, shown in a
// sandboxed frame (scripts only: no access to this page, its token or storage) and fed the agent state
// on every display frame, as on the desktop (renderer/js/faces/host.js, pumpFrame).
async function mountCustomFace() {
  const link = await api('/api/face');
  if (!link.custom || !/^\/f\/[\w-]{32}\/index\.html$/.test(link.url)) return false;
  if (faceView.id === 'custom' && faceView.obj) return true;
  const { faceState, samples64, audio: level, theme, pumpFrame } = await import('./js/faces/common.js');
  faceView.obj?.destroy?.();
  const frame = el('iframe', { id: 'face', class: 'face-frame', sandbox: 'allow-scripts', referrerpolicy: 'no-referrer', 'aria-hidden': 'true', tabindex: '-1', src: link.url });
  $('#face').replaceWith(frame);
  const stop = pumpFrame(frame, () => {
    const t = theme();
    return { type: 'av', state: faceState(), level: level().level, samples: samples64(), env: { name: state.name, colors: t.colors, states: t.face.states, alert: null } };
  });
  faceView.obj = { setLabel() {}, destroy: stop };
  faceView.id = 'custom';
  faceView.orb = false;
  return true;
}

const hudOn = () => document.body.classList.contains('fx-hud') || document.body.classList.contains('fx-subtle');

// The fallback: a small orb with orbiting arcs; color and motion follow the agent's state.
function startFace() {
  const c = $('#face');
  const g = c.getContext('2d');
  let spin = 0;
  let last = performance.now();
  let level = 0;
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim() || '#00e5ff';
  const frame = (now) => {
    if (!faceView.orb) return; // a shared face took over
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(h * dpr));
    const [, fullSpeed, bright] = STATES[state.face] || STATES.idle;
    const speed = reduceMotion.matches ? fullSpeed * 0.15 : fullSpeed;
    const talking = state.face === 'speaking' || state.face === 'speaking-text';
    const beat = reduceMotion.matches ? 0.35 : 0.35 + 0.35 * Math.abs(Math.sin(now / 90));
    level += ((talking ? beat : 0) - level) * Math.min(1, dt * 10);
    spin += dt * speed;
    const main = color('--accent');
    const accent = color('--accent2');
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = spin * (i % 2 ? -1 : 1) + (i * Math.PI * 2) / 3;
      g.strokeStyle = i % 2 ? accent : main;
      g.globalAlpha = 0.75 * bright;
      g.lineWidth = 2.5;
      g.beginPath();
      g.arc(cx, cy, R * (1.45 + i * 0.22), a, a + 1.1);
      g.stroke();
    }
    // HUD layer: a ring of instrument ticks, every fifth one longer, turning slowly.
    if (hudOn()) {
      const ticks = 72;
      const r0 = R * 2.05;
      const turn = document.body.classList.contains('fx-hud') ? spin * 0.15 : 0;
      g.strokeStyle = main;
      g.lineWidth = 1;
      for (let i = 0; i < ticks; i++) {
        const a = turn + (i / ticks) * Math.PI * 2;
        const long = i % 6 === 0;
        g.globalAlpha = (long ? 0.55 : 0.25) * bright;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        g.lineTo(cx + Math.cos(a) * (r0 + (long ? 7 : 3.5)), cy + Math.sin(a) * (r0 + (long ? 7 : 3.5)));
        g.stroke();
      }
    }
    g.globalAlpha = 0.5 * bright;
    g.strokeStyle = main;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(cx, cy, R * (1.18 + level * 0.25), 0, Math.PI * 2);
    g.stroke();
    g.globalAlpha = 1;
    const pulse = R * (1 + Math.sin(now / 700) * 0.04 + level * 0.2);
    const orb = g.createRadialGradient(cx, cy, 0, cx, cy, pulse);
    orb.addColorStop(0, `rgba(255,255,255,${0.85 * bright})`);
    orb.addColorStop(0.35, main);
    orb.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = orb;
    g.beginPath();
    g.arc(cx, cy, pulse, 0, Math.PI * 2);
    g.fill();
    g.globalCompositeOperation = 'source-over';
  };
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ schedule
// The schedule the assistant keeps on the computer (Schedule.md in its vault), read-only here: a week
// strip, the chosen day as a timeline, and what's next. New entries go through the assistant.
const DAY_MS = 86400000;
const TINTS = ['--accent', '--accent2', '--ok'];
const sched = { week: null, day: null, cache: new Map(), loading: null };
const FIRST_DAY = (() => {
  try {
    const l = new Intl.Locale(navigator.language);
    return ((l.getWeekInfo?.() || l.weekInfo)?.firstDay ?? 1) % 7;
  } catch {
    return 1;
  }
})();
const dayOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const plusDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const weekOf = (d) => plusDays(dayOf(d), -((d.getDay() - FIRST_DAY + 7) % 7));
const clock = (s) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// One theme color per entry (CSSOM, since the page's CSP allows no inline styles).
function tint(node, id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  node.style.setProperty('--ev', `var(${TINTS[h % TINTS.length]})`);
  return node;
}

// The tab bar's highlight: More covers every screen that has no tab of its own.
const TABS = ['chat', 'today', 'notes', 'learn', 'more'];

// Android Back (MainActivity calls nexusBack): the top layer closes first (sync.js backPlan); the app
// hears whether there is one (backTarget), so Back leaves it from the bare chat.
function backState() {
  if ($('#main').classList.contains('hidden')) return {}; // the pairing screen: nothing to close, Back leaves the app
  return { offline: Boolean($('#offline')), drawerOpen: !$('#drawer').classList.contains('hidden'), faceFull: document.body.classList.contains('face-full'), screenBack: hasScreenBack(state.view), view: state.view, tabs: TABS, wide: document.body.classList.contains('wide') };
}
function syncBack() {
  const open = Boolean(backPlan(backState()));
  if (open === state.backOpen) return;
  state.backOpen = open;
  android?.backTarget?.(open);
}
window.nexusBack = () => {
  const plan = backPlan(backState());
  if (plan === 'offline') (state.offlineDismissed = true), renderOffline();
  else if (plan === 'drawer') closeDrawer();
  else if (plan === 'face') setFaceFull(false);
  else if (plan === 'screen') screenBack();
  else if (plan) showView(plan);
  syncBack();
  return Boolean(plan);
};

function showView(v) {
  // Wide (tablet, DeX): the chat is always on screen, so the side shows Today instead of nothing.
  if (v === 'chat' && wide.matches && state.info?.share) v = 'today';
  state.view = v;
  const panel = v !== 'chat' && v !== 'sched';
  document.body.classList.toggle('view-sched', v === 'sched');
  document.body.classList.toggle('view-panel', panel);
  $('#sched').classList.toggle('hidden', v !== 'sched');
  $('#panel').classList.toggle('hidden', !panel);
  const tab = TABS.includes(v) ? v : 'more';
  for (const b of document.querySelectorAll('#tabs button')) {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
  }
  if (panel) {
    decode($('#convTitle'), TITLES[v] || '');
    renderScreen(v, $('#panel'));
  }
  $('#schedBtn').classList.toggle('on', v === 'sched');
  $('#schedBtn').setAttribute('aria-pressed', String(v === 'sched'));
  $('#schedBtn').replaceChildren(icon(v === 'sched' ? 'chat' : 'calendar'));
  $('#schedBtn').setAttribute('aria-label', v === 'sched' ? 'Back to the chat' : 'Schedule');
  if (!panel) $('#convTitle').textContent = v === 'sched' ? 'Schedule' : state.convTitle || 'New conversation';
  if (v === 'sched') {
    sched.day ||= dayOf(new Date());
    sched.week = weekOf(sched.day);
    renderSchedule();
  }
  syncBack();
}

async function weekEvents(week, fresh = false) {
  const key = ymd(week);
  if (!fresh && sched.cache.has(key)) return sched.cache.get(key);
  const data = await api(`/api/schedule?from=${key}&to=${ymd(plusDays(week, 7))}`);
  sched.cache.set(key, data.events);
  return data.events;
}

const onDate = (list, day) => {
  const a = `${ymd(day)}T00:00:00`;
  const b = `${ymd(plusDays(day, 1))}T00:00:00`;
  return list.filter((e) => e.start < b && e.end > a);
};

async function renderSchedule(fresh = false) {
  const week = sched.week;
  const today = dayOf(new Date());
  // The week strip and the day's heading right away (known without loading), so nothing jumps when the
  // events arrive; then the dots and the list.
  if (!sched.cache.has(ymd(week)) || fresh) {
    drawWeek(week, today, []);
    $('#schedList').replaceChildren(el('div', { class: 'muted sched-loading' }, 'Loading…'));
  }
  let list;
  try {
    list = await weekEvents(week, fresh);
  } catch (err) {
    if (err instanceof AuthError) return;
    return $('#schedList').replaceChildren(el('div', { class: 'sched-empty' }, el('p', {}, err.message)));
  }
  if (week !== sched.week || state.view !== 'sched') return; // moved on meanwhile
  const items = drawWeek(week, today, list);
  const day = sched.day;
  const isToday = ymd(day) === ymd(today);
  const next = isToday && items.find((e) => !e.allDay && new Date(e.end) > new Date());
  const rows = items.filter((e) => e !== next).map((e) => schedRow(e, isToday));
  if (next) {
    const mins = Math.round((new Date(next.start) - Date.now()) / 60000);
    rows.unshift(tint(el('div', { class: `sched-next ${mins <= 0 ? 'live' : ''}` }, el('small', {}, mins <= 0 ? 'NOW' : mins < 60 ? `NEXT · IN ${mins} MIN` : `NEXT · IN ${Math.floor(mins / 60)} H ${String(mins % 60).padStart(2, '0')}`), el('b', {}, next.title), next.location ? el('span', {}, next.location) : null), next.entryId));
  }
  $('#schedList').replaceChildren(...(rows.length ? rows : [el('div', { class: 'sched-empty' }, el('p', {}, isToday ? 'Nothing scheduled today.' : 'Nothing scheduled.'), el('p', { class: 'muted' }, 'Tell the assistant about lectures, shifts or appointments, and it keeps them here.'))]));
}

/** The week strip (dots from `list`) and the selected day's heading; returns that day's events. */
function drawWeek(week, today, list) {
  $('#schedDays').replaceChildren(...[...Array(7)].map((_, i) => {
    const d = plusDays(week, i);
    const n = onDate(list, d).length;
    const cls = ['sched-day', ymd(d) === ymd(today) && 'today', ymd(d) === ymd(sched.day) && 'sel', d < today && 'past'].filter(Boolean).join(' ');
    return el('button', { class: cls, type: 'button', 'aria-label': d.toDateString(), 'aria-pressed': String(ymd(d) === ymd(sched.day)), onclick: () => pickDay(d) },
      el('span', {}, d.toLocaleDateString(undefined, { weekday: 'narrow' })),
      el('b', {}, d.getDate()),
      el('i', { class: n ? 'dots' : 'dots none' }, '•'.repeat(Math.min(3, n)) || '·'),
    );
  }));
  const day = sched.day;
  const isToday = ymd(day) === ymd(today);
  $('#schedHead').replaceChildren(
    el('div', { class: 'sched-date' }, el('b', {}, day.getDate()), el('div', {}, el('span', {}, day.toLocaleDateString(undefined, { weekday: 'long' })), el('small', {}, day.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })))),
    isToday ? el('i', { class: 'sched-badge' }, 'TODAY') : el('button', { class: 'sched-today', type: 'button', onclick: () => pickDay(today) }, 'Today'),
  );
  return onDate(list, day);
}

function schedRow(e, isToday) {
  const past = isToday && new Date(e.end) < new Date();
  return tint(el('div', { class: `sched-row ${past ? 'past' : ''}` },
    el('div', { class: 'tm' }, e.allDay ? el('b', {}, 'ALL DAY') : [el('b', {}, clock(e.start)), e.openEnd ? null : el('span', {}, clock(e.end))]),
    el('span', { class: 'bar' }),
    el('div', { class: 'what' },
      el('b', {}, e.title),
      e.location ? el('span', {}, icon('pin'), e.location) : null,
      e.recurring ? el('span', { class: 'rule' }, icon('repeat'), e.rule.split(' (')[0]) : null,
      e.notes ? el('span', { class: 'notes' }, e.notes) : null,
    ),
  ), e.entryId);
}

function pickDay(d) {
  sched.day = dayOf(d);
  const week = weekOf(d);
  if (ymd(week) !== ymd(sched.week)) sched.week = week;
  navigator.vibrate?.(8);
  renderSchedule();
}

$('#schedBtn').addEventListener('click', () => showView(state.view === 'sched' ? 'chat' : 'sched'));
$('#schedPrev').addEventListener('click', () => pickDay(plusDays(sched.day, -7)));
$('#schedNext').addEventListener('click', () => pickDay(plusDays(sched.day, 7)));
$('#schedTell').addEventListener('click', () => {
  showView('chat');
  prefill('Add to my schedule: ');
});
// Swipe the day list sideways for the next or previous day.
let swipe = null;
$('#schedList').addEventListener('pointerdown', (e) => (swipe = { x: e.clientX, y: e.clientY }), { passive: true });
$('#schedList').addEventListener('pointerup', (e) => {
  if (!swipe) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) pickDay(plusDays(sched.day, dx < 0 ? 1 : -1));
}, { passive: true });

function prefill(text) {
  const input = $('#input');
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

// ------------------------------------------------------------------ secure address
// On the plain local address with a secure one set up on the computer: one tap moves this device
// there (same pairing, new token). See companion.js "moving to the secure address".
async function moveToSecure() {
  const btn = $('#moveBtn');
  btn.disabled = true;
  try {
    const { url, secret } = await api('/api/move', { method: 'POST', body: {} });
    if (android?.moveTo) bridge('moveTo', url, secret);
    else location.assign(`${url}/#move=${secret}`);
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message);
  } finally {
    btn.disabled = false;
  }
}
$('#moveBtn').addEventListener('click', moveToSecure);

async function finishMove(secret) {
  show('pair');
  showPairError('');
  $('#pairBtn').disabled = true;
  $('#pairBtn').textContent = 'Switching…';
  try {
    const res = await fetchWithin('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ move: secret }) }, DEADLINES.pair);
    if (tunnelDown(res)) throw new NetError('Your computer isn’t answering right now.');
    if (!res.ok) throw await answerError(res);
    const data = await res.json().catch(() => ({}));
    state.token = data.token;
    store.set(TOKEN_KEY, data.token);
    store.set(NAME_KEY, data.name);
    start();
    toast('Switched to the secure address 🔒');
  } catch (err) {
    showPairError(`${err.message} You can also pair again with a code.`);
  } finally {
    $('#pairBtn').disabled = false;
    $('#pairBtn').textContent = 'Connect';
  }
}

function renderLinkInfo() {
  const secure = !insecure;
  const here = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  $('#linkInfo').replaceChildren(icon(secure ? 'lock' : 'lock-open'), el('div', {}, el('b', {}, here ? 'This computer' : secure ? 'Encrypted connection' : 'Local network, not encrypted'), el('small', {}, location.host)));
  $('#linkInfo').classList.toggle('secure', secure);
  $('#moveBtn').classList.toggle('hidden', !(insecure && state.secureUrl));
}

// ------------------------------------------------------------------ boot
// A new phone client on the computer (an update, or a change to these files): reload into it, but not
// in the middle of something (a reply coming in, a recording, text typed, a note being read).
let reloadTimer = 0;
function noteClient(v) {
  if (!v) return;
  if (!state.client) state.client = v;
  else if (v !== state.client && !reloadTimer) reloadWhenFree();
}
function reloadWhenFree() {
  reloadTimer = 0;
  const typing = $('#input').value.trim() || ($('#composer').contains(document.activeElement) && document.activeElement.matches('textarea'));
  const recording = !$('#recBar').classList.contains('hidden');
  const reading = state.view !== 'chat' && state.view !== 'sched' && screenBusy(state.view);
  if (replying() || state.face === 'speaking' || typing || recording || reading) reloadTimer = setTimeout(reloadWhenFree, 5000);
  else location.reload();
}

async function applyInfo() {
  try {
    const info = await api('/api/info');
    state.voice = info.voice;
    state.name = info.name;
    state.info = info;
    noteClient(info.client);
    // View only (set on the computer): no composer, approvals or check-offs here.
    document.body.classList.toggle('view-only', info.readOnly === true);
    state.calendar = Boolean(info.calendar);
    // Older computers (or sharing turned off there): only the chat and the schedule.
    $('#tabs').classList.toggle('hidden', !info.share);
    if (!info.share && !['chat', 'sched'].includes(state.view)) showView('chat');
    applyWide();
    $('#agentName').textContent = info.name.toUpperCase();
    document.title = info.name;
    setFx(info.fx);
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries({ bg: '--bg', surface: '--surface', text: '--text', muted: '--muted', accent: '--accent', accent2: '--accent2', danger: '--danger', success: '--ok', warning: '--warn' })) {
      if (info.colors[k]) root.setProperty(v, info.colors[k]);
    }
    if (info.colors.bg) document.querySelector('meta[name="theme-color"]').setAttribute('content', info.colors.bg);
    state.sleepAfterMin = Number(info.sleepAfterMin) || 0;
    // The first look at the computer: asleep until something happens, as on the desktop.
    if (!state.infoSeen) {
      state.infoSeen = true;
      state.asleepAtStart = info.sleepOnLaunch !== false && state.face === 'idle' && !state.woken;
      updateFaceLabel();
    }
    applyScene(info.scene);
    state.secureUrl = typeof info.secureUrl === 'string' && info.secureUrl.startsWith('https://') ? info.secureUrl : '';
    $('#schedBtn').classList.toggle('hidden', !info.calendar);
    if (!info.calendar && state.view === 'sched') showView('chat');
    renderLinkInfo();
    renderBanner();
    await mountFace(info.face?.id, { colors: info.colors, face: info.face || {} });
  } catch {
    /* defaults */
  }
  if (!faceView.obj && !faceView.orb) (faceView.orb = true), startFace();
}

// ------------------------------------------------------------------ HUD layer
// The desktop's "Visual effects" setting: hud (with motion) | subtle (static) | off. Remembered, so
// the next start looks right before the computer answers.
const FX_KEY = 'nexus.fx';
const stillMedia = matchMedia('(prefers-reduced-motion: reduce)');

// The desktop's decoding titles (renderer/js/hud.js decode): glyphs settle into the text, left to right.
// Plain text when the HUD is off or motion is reduced; stops if the title changes meanwhile.
function decode(node, text) {
  const GLYPHS = '#%&*+=<>/|01ABCDEFGHJKLMNPRSTUVXYZ';
  node.textContent = text;
  if (!document.body.classList.contains('fx-hud') || matchMedia('(prefers-reduced-motion: reduce)').matches || !text) return;
  const start = performance.now();
  let shown = text;
  const step = (now) => {
    // Stop when another decode took over or the app set the text itself meanwhile (Schedule, a conversation title).
    if (node.dataset.decoding !== text || node.textContent !== shown) return;
    const done = Math.floor(((now - start) / 420) * text.length);
    if (done >= text.length) return void ((node.textContent = text), delete node.dataset.decoding);
    shown = text.slice(0, done) + [...text.slice(done)].map((c) => (c === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
    node.textContent = shown;
    requestAnimationFrame(step);
  };
  node.dataset.decoding = text;
  requestAnimationFrame(step);
}
function setFx(fx) {
  const level = ['hud', 'subtle', 'off'].includes(fx) ? fx : 'hud';
  store.set(FX_KEY, level);
  document.body.classList.toggle('fx-hud', level === 'hud');
  document.body.classList.toggle('fx-subtle', level === 'subtle');
  document.body.classList.toggle('fx-still', level !== 'off' && stillMedia.matches);
}
setFx(store.get(FX_KEY) || 'hud');

// While the phone connects: a short "establishing link" splash (until connected, at most 2.5 s).
let splash = null;
function openSplash() {
  if (!document.body.classList.contains('fx-hud') || stillMedia.matches || splash) return;
  splash = el('div', { class: 'hud-splash', role: 'status', onclick: () => closeSplash() },
    el('div', { class: 'hud-splash-box' }, el('div', { class: 'hud-splash-ring' }), el('div', { class: 'hud-splash-title' }, state.name.toUpperCase()), el('div', { class: 'hud-splash-sub' }, 'ESTABLISHING LINK')),
  );
  document.body.append(splash);
  setTimeout(closeSplash, 2500);
}
function closeSplash() {
  const s = splash;
  if (!s || s.classList.contains('out')) return;
  s.classList.add('out');
  setTimeout(() => (s.remove(), splash === s && (splash = null)), 450);
}

async function start() {
  show('main');
  renderBanner();
  setSpeak(state.speak);
  if (state.token) openSplash();
  await applyInfo();
  if (!state.token) return;
  bridge('setToken', state.token, store.get(NAME_KEY) || '');
  loadConversation(state.convId);
  openStream();
}

// ------------------------------------------------------------------ Android app
// Shared text (Share → Nexus) goes into the message box for the user to check and send.
window.nexusShare = (text) => {
  const input = $('#input');
  input.value = input.value ? `${input.value}\n${text}` : text;
  autosize();
  input.focus();
};
if (!window.nexusTalk) window.nexusTalk = () => toast('Push-to-talk needs the secure (https) address.');

if (android) {
  const sw = el('input', { type: 'checkbox', id: 'bgToggle' });
  sw.checked = android.backgroundEnabled();
  sw.addEventListener('change', () => bridge('setBackground', sw.checked));
  // `blocked`: off in Android's settings (refused for good, or switched off there), where only they can
  // turn them back on. The app checks again whenever it comes back to the front.
  window.nexusBackgroundChanged = (on, blocked = false) => {
    sw.checked = on;
    if (on) return;
    if (blocked && typeof android.openAppSettings === 'function') toast('Notifications are off for Siren in Android settings. Turn them on there to get approvals while the app is closed.', { label: 'Open settings', run: () => bridge('openAppSettings', 'notifications') });
    else toast('Notifications are off. Allow them in Android settings to get approvals while the app is closed.');
  };
  // The app lock (android AppLock): the phone's fingerprint, face or screen lock before anything shows.
  const lockSw = el('input', { type: 'checkbox', id: 'lockToggle' });
  const canLock = typeof android.lockAvailable === 'function' && android.lockAvailable();
  lockSw.checked = canLock && android.lockEnabled();
  lockSw.disabled = !canLock;
  lockSw.addEventListener('change', () => {
    const want = lockSw.checked;
    lockSw.checked = !want; // until the phone confirms it is you
    bridge('setLock', want);
  });
  window.nexusLockChanged = (on) => {
    lockSw.checked = on;
    toast(on ? 'Siren now asks for your fingerprint, face or screen lock when you open it.' : 'The app lock is off.');
  };
  $('#deviceBox').append(
    el('label', { class: 'switch-row' }, sw, el('span', {}, 'Notify me about approvals and replies while the app is closed')),
    el('label', { class: 'switch-row' }, lockSw, el('span', {}, canLock ? 'Lock Siren with fingerprint, face or screen lock' : 'Lock Siren with fingerprint, face or screen lock (set a screen lock on the phone first)')),
    el('button', { class: 'btn ghost', onclick: () => bridge('changeServer') }, 'Change the computer’s address'),
  );
}

// Tablets (also upright), Samsung DeX and large windows: the chat beside the screens (styles.css
// body.wide). Not phones turned sideways: they are wide but too short for two panes. Follows rotation,
// split screen and window resizing.
const wide = matchMedia('(min-width: 760px) and (min-height: 560px)');
function applyWide() {
  // Without the shared screens (an older computer, or sharing off) there is nothing to put beside the chat.
  document.body.classList.toggle('wide', wide.matches && state.info?.share !== false);
  if (wide.matches && state.view === 'chat' && state.info?.share) showView('today');
}
wide.addEventListener('change', applyWide);
applyWide();

// The soft keyboard is up (sync.js keyboardState): the face and the tab bar step aside on a phone, so the
// conversation keeps more than a few lines (styles.css body.kbd).
let kbd = null;
function syncKeyboard() {
  const a = document.activeElement;
  const typing = Boolean(a?.matches?.('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'));
  kbd = keyboardState(kbd, { width: innerWidth, height: innerHeight, typing });
  document.body.classList.toggle('kbd', kbd.up);
}
window.addEventListener('resize', syncKeyboard);
window.visualViewport?.addEventListener('resize', syncKeyboard);
// Focus moves before the keyboard opens or closes; the resize that follows decides again.
document.addEventListener('focusin', syncKeyboard);
document.addEventListener('focusout', () => setTimeout(syncKeyboard, 0));
syncKeyboard();

// Keyboard (tablet keyboards, DeX): Ctrl+1–5 the tabs, Ctrl+K a new chat, Esc back to the chat.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const n = Number(e.key);
  const tabs = [...document.querySelectorAll('#tabs button')].filter((b) => getComputedStyle(b).display !== 'none');
  if (n >= 1 && n <= tabs.length && !$('#tabs').classList.contains('hidden')) {
    e.preventDefault();
    tabs[n - 1].click();
  } else if (e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#newBtn').click();
  }
});

// The tab bar and the screens beyond the chat (screens.js).
for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => (navigator.vibrate?.(6), showView(b.dataset.tab)));
initScreens({ api, el, icon, markdown, toast, send, prefill, showView, AuthError, NetError, state, agentState, syncBack });

$('#pairInsecure').classList.toggle('hidden', !insecure);
// Offline app shell (needs HTTPS or localhost; on the plain local network the browser doesn't allow it).
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Opened from the pairing QR code (…/#pair=<secret>): take the secret out of the address bar and
// history at once, then pair with it.
const qr = /^#pair=([A-Za-z0-9_-]{43})$/.exec(location.hash);
const fromMove = /^#move=([A-Za-z0-9_-]{43})$/.exec(location.hash);
if (qr || fromMove) history.replaceState(null, '', location.pathname + location.search);
// Scanned with an Android phone's camera, the link opens in the browser. If the Siren app is installed,
// hand the link to it (siren://pair, android MainActivity); Chrome falls back to this page with ?web=1
// when it isn't, and the browser pairs as before. The one-time secret is used only once: either here or
// in the app, never both.
const handOff = qr && !android && /Android/i.test(navigator.userAgent) && !new URLSearchParams(location.search).has('web');
const fromQr = handOff ? null : qr;
renderLinkInfo();
if (handOff) offerApp(qr[1]);
else if (fromMove) finishMove(fromMove[1]);
else if (state.token) {
  start();
  if (fromQr) toast('This device is already connected.');
} else {
  show('pair');
  if (fromQr) pair({ secret: fromQr[1] });
}
