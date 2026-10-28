// Phone client for the companion server (main/companion.js, docs/ROADMAP-mobile.md step 2).
// Talks only to the server it was loaded from. The device token lives in this browser's storage.
import { initScreens, render as renderScreen, TITLES } from './screens.js';
// Served by the desktop from renderer/js/ (companion.js STATIC), so loaded by URL, not by file.
let mathtext = null;
import('./js/mathtext.js').then((m) => (mathtext = m)).catch(() => {});

const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'nexus.token';
const CONV_KEY = 'nexus.conv';
const SPEAK_KEY = 'nexus.speak';
const NAME_KEY = 'nexus.deviceName';
// Present inside the Android app (android/): background notifications, the Talk tile, the share sheet.
const android = window.NexusAndroid || null;

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

const state = {
  token: store.get(TOKEN_KEY),
  convId: store.get(CONV_KEY),
  active: null, // { requestId, bubble, tools, text }
  mine: new Set(), // requestIds sent from this device
  turns: new Map(), // requestId -> turn view, for turns started elsewhere in this conversation
  held: [], // events that arrived while our own send was in flight
  face: 'idle',
  name: 'Siren',
  view: 'chat', // chat | sched | a screen from screens.js (today, habits, learn, memory, notes, tree, world, skills, more)
  info: null, // the computer's /api/info
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
// of it, and only web and mail links stay clickable.
window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
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

// A flashcard (screens.js): Markdown like a reply, plus the card's own pictures and sounds, which the
// computer sends inside the card as data: URLs. Nothing is loaded from anywhere else: any other image
// or audio source is dropped. Sounds become blob: URLs (this page's CSP allows media only from those).
function cardMarkdown(text) {
  const math = window.katex && mathtext ? mathtext.extractMath(String(text ?? '')) : { text: String(text ?? ''), items: [] };
  let html = window.marked.parse(math.text, { breaks: true, gfm: true });
  if (math.items.length) html = mathtext.restoreMath(html, math.items, renderTex);
  const frag = window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input'], FORBID_ATTR: ['style'], ADD_ATTR: ['target', 'controls'], RETURN_DOM_FRAGMENT: true });
  for (const n of frag.querySelectorAll('img, audio, video, source')) {
    const src = n.getAttribute('src') || '';
    if (n.tagName === 'IMG' && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(src)) continue;
    if (n.tagName === 'AUDIO' && /^data:audio\/[\w.+-]+;base64,/i.test(src)) {
      try {
        const [head, b64] = src.split(',');
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        n.setAttribute('src', URL.createObjectURL(new Blob([bytes], { type: head.slice(5, head.indexOf(';')) })));
        n.setAttribute('controls', '');
        continue;
      } catch {
        /* a broken sound: dropped below */
      }
    }
    n.remove();
  }
  return frag;
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

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// A phone has no developer console: a script error (a screen that failed to draw, a browser missing a
// feature) shows as a notice instead of a silent blank, so it can be reported.
let lastError = '';
window.addEventListener('error', (e) => {
  const text = String(e.message || e.error?.message || 'Script error');
  if (text === lastError) return;
  lastError = text;
  toast(`Something went wrong: ${text.slice(0, 160)}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r instanceof AuthError || r?.name === 'AbortError') return;
  const text = String(r?.message || r || 'Error');
  if (text === lastError) return;
  lastError = text;
  toast(`Something went wrong: ${text.slice(0, 160)}`);
});

class AuthError extends Error {}
// The computer didn't answer at all (off, asleep, Siren closed, another network): the screens show a
// "can't reach your computer" card instead of the browser's "Failed to fetch".
class NetError extends Error {}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${state.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new NetError('Can’t reach your computer right now.');
  }
  // A tunnel or proxy answering for a computer that is off (Cloudflare's or Tailscale Serve's error page);
  // the computer's own errors (voice 502/503 among them) are JSON.
  if ([502, 503, 504, 530].includes(res.status) && !/json/i.test(res.headers.get('content-type') || '')) throw new NetError('Your computer isn’t answering right now.');
  if (res.status === 401) {
    unpair('This device was disconnected from the assistant. Pair it again.');
    throw new AuthError('Not paired');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
  return raw ? res : res.json();
}

function setConvTitle(t) {
  state.convTitle = t;
  if (state.view === 'chat') $('#convTitle').textContent = t;
}

function show(screen) {
  $('#pair').classList.toggle('hidden', screen !== 'pair');
  $('#main').classList.toggle('hidden', screen !== 'main');
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
  android?.clearToken();
  state.stream?.abort();
  closeDrawer();
  show('pair');
  if (message) showPairError(message);
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
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...proof, name: $('#pairName').value.trim() || guessName() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (proof.secret && res.status === 403) throw new Error('This QR code has expired or was already used. Click “Pair a device” on the computer again.');
      throw new Error(data.error || `Error ${res.status}`);
    }
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
      const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${state.token}` }, signal: ctl.signal });
      if (res.status === 401) return unpair('This device was disconnected from the assistant. Pair it again.');
      if (!res.ok) throw new Error(`Error ${res.status}`);
      setConn(true);
      $('#approvals').innerHTML = ''; // the server replays every approval that is still open
      if (delay > 1000) {
        // Catch up on what happened while away, and on a face or theme changed on the desktop meanwhile.
        loadConversation(state.convId);
        applyInfo();
      }
      delay = 1000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
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
}

// The persona was switched, or its look changed, on the computer: name, colors, face and the rest of
// /api/info follow here at once; the Android app passes the news on to a paired watch.
let infoTimer = null;
function onInfoChanged() {
  clearTimeout(infoTimer);
  infoTimer = setTimeout(async () => {
    await applyInfo();
    android?.lookChanged?.();
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
        el('button', { class: 'btn primary', type: 'button', onclick: () => (state.wake?.(), (state.retryAt = Date.now()), tick()) }, 'Try again now'),
        android ? el('button', { class: 'btn', type: 'button', onclick: () => android.changeServer() }, 'Change the address') : null,
        el('button', { class: 'btn ghost', type: 'button', onclick: () => ((state.offlineDismissed = true), renderOffline()) }, 'Continue offline'),
      ),
    ),
  );
  tick();
  clearInterval(offlineTick);
  offlineTick = setInterval(tick, 1000);
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
function onChat(ev) {
  // While a send is in flight its requestId isn't known yet; hold events until it is (see send()).
  if (state.active && !state.active.requestId && !state.turns.has(ev.requestId)) return state.held.push(ev);
  const mine = state.mine.has(ev.requestId);
  if (!mine && ev.conversationId !== state.convId) return;
  if (ev.type === 'start') {
    if (mine) {
      state.convId = ev.conversationId;
      store.set(CONV_KEY, ev.conversationId);
      setConvTitle(ev.title || 'Conversation');
    } else {
      // A turn from the desktop or another device in the conversation shown here.
      addMessage(ev.userMessage);
      state.turns.set(ev.requestId, newTurnView(ev.requestId));
      if (state.face === 'idle') setFace('thinking');
    }
    return;
  }
  const turn = state.active?.requestId === ev.requestId ? state.active : state.turns.get(ev.requestId);
  if (!turn) return;
  switch (ev.type) {
    case 'text':
      turn.text += ev.delta;
      if (state.face !== 'speaking') setFace('speaking-text');
      renderTurn(turn);
      break;
    case 'retract':
      turn.text = turn.text.slice(0, Math.max(0, turn.text.length - ev.chars));
      renderTurn(turn);
      break;
    case 'tool_start':
      turn.tools.append(el('span', { class: 'chip', 'data-id': ev.id }, '⚙ ', label(ev.name)));
      turn.running++;
      setFace('working');
      scrollDown();
      break;
    case 'tool_end': {
      const chip = turn.tools.querySelector(`[data-id="${CSS.escape(String(ev.id))}"]`);
      if (chip) chip.className = `chip ${ev.ok === false ? 'bad' : 'good'}`;
      turn.running = Math.max(0, turn.running - 1);
      if (!turn.running) setFace(turn.text ? 'speaking-text' : 'thinking');
      break;
    }
    case 'notice':
      turn.wrap.insertBefore(el('div', { class: 'notice' }, `⚠ ${ev.message}`), turn.bubble);
      break;
    case 'done':
      turn.bubble.classList.remove('streaming');
      turn.bubble.innerHTML = markdown(ev.message?.content || '');
      turn.bubble.dataset.stamp = stamp(ev.message);
      turn.wrap.append(actions(ev.message?.content || ''));
      state.happyUntil = Date.now() + 1800; // the face's short "done" glow, as on the desktop
      sched.cache.clear(); // the reply may have changed the schedule
      endTurn(turn);
      if (turn.mine && state.speak) say(ev.message?.content || '');
      break;
    case 'error':
    case 'aborted':
      turn.bubble.classList.remove('streaming');
      if (ev.type === 'error') turn.bubble.classList.add('error');
      turn.bubble.innerHTML = markdown(ev.type === 'error' ? `${turn.text ? `${turn.text}\n\n---\n` : ''}**Error:** ${ev.message}` : turn.text || '*(stopped)*');
      endTurn(turn);
      break;
  }
}

// What a tool did, in words (the desktop's labels, shortened); anything else by its name.
const TOOL_WORDS = {
  calendar_get_events: 'Checked schedule', calendar_list_entries: 'Looked up schedule', calendar_add_event: 'Added to schedule', calendar_update_event: 'Changed schedule', calendar_delete_event: 'Removed from schedule',
  memory_save: 'Saved a memory', memory_update: 'Updated a memory', memory_search: 'Searched memory', web_search: 'Searched the web', web_fetch: 'Read a web page',
  vault_search: 'Searched notes', vault_read_note: 'Read a note', vault_write_note: 'Wrote a note', daily_note_log: 'Logged the day', priorities_update: 'Updated priorities', history_search: 'Searched history',
};
const label = (name) => {
  const n = String(name || 'tool').replace(/^mcp__\w+__/, '');
  return TOOL_WORDS[n] || n.replace(/_/g, ' ');
};

// The telemetry line the HUD shows on a reply: "NEXUS · 14:32:05 · OPUS 5.5".
function stamp(m) {
  const time = new Date(m?.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const model = String(m?.model || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ');
  return [state.name, time, model].filter(Boolean).join(' · ');
}

function newTurnView(requestId, mine = false) {
  const bubble = el('div', { class: 'bubble streaming', 'data-stamp': `${state.name} · live` });
  const tools = el('div', { class: 'tools' });
  const wrap = el('div', { class: 'msg assistant' }, tools, bubble);
  $('#messages').append(wrap);
  updateEmpty();
  scrollDown(mine);
  return { requestId, wrap, bubble, tools, text: '', running: 0, mine };
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
  if (turn.raf) return;
  turn.raf = requestAnimationFrame(() => {
    turn.raf = 0;
    turn.bubble.innerHTML = markdown(turn.text);
    scrollDown();
  });
}

function endTurn(turn) {
  state.mine.delete(turn.requestId);
  state.turns.delete(turn.requestId);
  if (turn === state.active) {
    state.active = null;
    document.body.classList.remove('busy');
    $('#sendBtn').classList.remove('hidden');
    $('#stopBtn').classList.add('hidden');
  }
  // The face follows the assistant, whoever started the reply: idle once nothing is running.
  if (!state.active && !state.turns.size && state.face !== 'speaking') setFace('idle');
  scrollDown();
}

function addMessage(m) {
  if (!m || m.hidden) return;
  const text = m.display ?? m.content;
  const wrap = el('div', { class: `msg ${m.role}` });
  if (m.role === 'assistant') {
    if (m.toolCalls?.length) wrap.append(el('div', { class: 'tools' }, m.toolCalls.map((t) => el('span', { class: 'chip good' }, '⚙ ', label(t.name)))));
    const b = el('div', { class: 'bubble', 'data-stamp': stamp(m) });
    b.innerHTML = markdown(text);
    wrap.append(b, actions(text));
  } else {
    wrap.append(el('div', { class: 'bubble' }, text));
    if (m.remote) wrap.append(el('div', { class: 'meta' }, `from ${m.remote}`));
  }
  $('#messages').append(wrap);
  updateEmpty();
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
$('#jumpBtn').addEventListener('click', () => {
  const m = $('#messages');
  stick = true;
  m.scrollTo({ top: m.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  $('#jumpBtn').classList.add('hidden');
});

const updateEmpty = () => $('#empty').classList.toggle('hidden', $('#messages').childElementCount > 0);

async function send(text) {
  if (!text.trim() || state.active) return;
  addMessage({ role: 'user', content: text });
  const turn = newTurnView(null, true);
  state.active = turn;
  document.body.classList.add('busy');
  state.held = [];
  setFace('thinking');
  $('#sendBtn').classList.add('hidden');
  $('#stopBtn').classList.remove('hidden');
  try {
    const r = await api('/api/chat', { method: 'POST', body: { text, conversationId: state.convId || undefined } });
    turn.requestId = r.requestId;
    state.mine.add(r.requestId);
  } catch (err) {
    turn.requestId = 'failed';
    turn.bubble.classList.remove('streaming');
    turn.bubble.classList.add('error');
    turn.bubble.textContent = err instanceof AuthError ? 'Not sent: this device is no longer paired.' : err.message;
    endTurn(turn);
  }
  const held = state.held;
  state.held = [];
  for (const ev of held) onChat(ev);
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
  i.style.height = '46px';
  i.style.height = `${Math.min(140, Math.max(46, i.scrollHeight + 2))}px`;
};
$('#input').addEventListener('input', autosize);
$('#stopBtn').addEventListener('click', () => {
  const id = state.active?.requestId;
  if (id) api(`/api/chat/${encodeURIComponent(id)}/abort`, { method: 'POST', body: {} }).catch((err) => toast(err.message));
});

// ------------------------------------------------------------------ conversations
async function loadConversation(id) {
  $('#messages').innerHTML = '';
  state.turns.clear();
  scrollDown(true);
  $('#empty').classList.add('hidden'); // not while the conversation loads
  if (!id) {
    setConvTitle('New conversation');
    return updateEmpty();
  }
  try {
    const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
    setConvTitle(conv.title || 'Conversation');
    for (const m of conv.messages) addMessage(m);
    scrollDown(true);
  } catch (err) {
    if (err instanceof AuthError) return;
    state.convId = null;
    store.set(CONV_KEY, null);
    setConvTitle('New conversation');
  }
  updateEmpty();
}

function openConversation(id) {
  if (state.active) return toast('Wait for the reply to finish first.');
  state.convId = id;
  store.set(CONV_KEY, id);
  closeDrawer();
  loadConversation(id);
}

let convs = [];

async function openDrawer() {
  $('#drawer').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
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
}

$('#convSearch').addEventListener('input', renderConvs);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());
$('#convBtn').addEventListener('click', openDrawer);
$('#drawerClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#newBtn').addEventListener('click', () => openConversation(null));
$('#unpairBtn').addEventListener('click', () => unpair('Disconnected. To remove this device completely, remove it in the desktop app’s Settings too.'));

// ------------------------------------------------------------------ approvals
const KIND = { self_modify: 'Change its own code', settings: 'Change a setting', delete: 'Delete something', command: 'Run a command', calendar: 'Change your calendar', invite: 'Send calendar invitations', voice: 'Change its voice', voice_clone: 'Clone a voice', repo_change: 'Change a repository', github_publish: 'Publish to GitHub', connector: 'Use a connected service', connector_trust: 'Stop asking for a service', browser: 'Act on a website' };

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
    el('div', { class: 'row' }, buttons),
  );
  $('#approvals').append(card);
  setTimeout(() => buttons.forEach((b) => b.removeAttribute('disabled')), ARM_MS);
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
  a.addEventListener('ended', () => setFace(state.active || state.turns.size ? 'thinking' : 'idle'));
  a.addEventListener('playing', () => setFace('speaking'));
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
// Hold the mic, release to send. The recording (16 kHz mono WAV, at most 60 s) is transcribed on the
// computer with its usual speech-to-text, then sent like a typed message. Browsers allow the
// microphone only on secure pages, so the button shows on the HTTPS address only.
const MAX_REC_MS = 60000;
let rec = null;

// toggle: started from the Talk tile or shortcut; it stops on the next tap of the mic, not on release.
async function startRecording({ toggle = false } = {}) {
  if (rec || state.active) return;
  rec = { chunks: [], starting: true, toggle };
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (!rec) return stream.getTracks().forEach((t) => t.stop()); // released while asking for permission
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
    Object.assign(rec, { stream, ctx, node, rate: ctx.sampleRate, started: Date.now(), starting: false, limit: setTimeout(stopRecording, MAX_REC_MS) });
    $('#micBtn').classList.add('live');
    showRecBar(rec);
    setFace('listening');
    navigator.vibrate?.(30);
  } catch (err) {
    rec = null;
    toast(err.name === 'NotAllowedError' ? 'Allow the microphone for this page to talk.' : err.message);
  }
}

async function stopRecording() {
  const r = rec;
  rec = null;
  if (!r || r.starting) return;
  clearTimeout(r.limit);
  r.node.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close().catch(() => {});
  state.micLevel = 0;
  $('#micBtn').classList.remove('live');
  hideRecBar();
  if (Date.now() - r.started < 400) return setFace('idle'), toast('Hold the button while you speak.');
  const mic = $('#micBtn');
  mic.classList.add('busy');
  setFace('thinking');
  $('#faceState').textContent = 'TRANSCRIBING';
  try {
    const wav = encodeWav(await to16k(r.chunks, r.rate));
    const res = await fetch('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'audio/wav' }, body: wav });
    if (res.status === 401) return unpair('This device was disconnected from the assistant. Pair it again.');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    setFace('idle');
    if (data.text?.trim()) send(data.text.trim());
    else toast('I didn’t catch that.');
  } catch (err) {
    setFace('idle');
    toast(err.message);
  } finally {
    mic.classList.remove('busy');
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
  const mic = $('#micBtn');
  mic.classList.remove('hidden');
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (rec?.toggle) return stopRecording();
    try {
      mic.setPointerCapture(e.pointerId); // keep the release even if the finger slides off
    } catch {
      /* not a real pointer */
    }
    startRecording();
  });
  for (const ev of ['pointerup', 'pointercancel']) mic.addEventListener(ev, () => !rec?.toggle && stopRecording());
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
state.asleepAtStart = false; // asleep since the app opened (the desktop's ui.sleepOnLaunch), until something happens
state.micLevel = 0;

function setFace(s) {
  state.face = s;
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
  const f = state.face === 'speaking-text' ? 'speaking' : state.face;
  if (f !== 'idle') return f;
  if (state.happyUntil > Date.now()) return 'happy';
  if (state.asleepAtStart) return 'sleeping';
  if (state.sleepAfterMin && Date.now() - state.lastActivity > state.sleepAfterMin * 60000) return 'sleeping';
  return 'idle';
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
const TABS = ['chat', 'today', 'habits', 'learn', 'more'];
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
    if (android?.moveTo) android.moveTo(url, secret);
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
    const res = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ move: secret }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
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
async function applyInfo() {
  try {
    const info = await api('/api/info');
    state.voice = info.voice;
    state.name = info.name;
    state.info = info;
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
      if (info.sleepOnLaunch !== false && state.face === 'idle' && !state.woken) state.asleepAtStart = true;
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
  android?.setToken(state.token, store.get(NAME_KEY) || '');
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
  sw.addEventListener('change', () => android.setBackground(sw.checked));
  window.nexusBackgroundChanged = (on) => {
    sw.checked = on;
    if (!on) toast('Notifications are off. Allow them in Android settings to get approvals while the app is closed.');
  };
  // The app lock (android AppLock): the phone's fingerprint, face or screen lock before anything shows.
  const lockSw = el('input', { type: 'checkbox', id: 'lockToggle' });
  const canLock = typeof android.lockAvailable === 'function' && android.lockAvailable();
  lockSw.checked = canLock && android.lockEnabled();
  lockSw.disabled = !canLock;
  lockSw.addEventListener('change', () => {
    const want = lockSw.checked;
    lockSw.checked = !want; // until the phone confirms it is you
    android.setLock(want);
  });
  window.nexusLockChanged = (on) => {
    lockSw.checked = on;
    toast(on ? 'Siren now asks for your fingerprint, face or screen lock when you open it.' : 'The app lock is off.');
  };
  $('#deviceBox').append(
    el('label', { class: 'switch-row' }, sw, el('span', {}, 'Notify me about approvals and replies while the app is closed')),
    el('label', { class: 'switch-row' }, lockSw, el('span', {}, canLock ? 'Lock Siren with fingerprint, face or screen lock' : 'Lock Siren with fingerprint, face or screen lock (set a screen lock on the phone first)')),
    el('button', { class: 'btn ghost', onclick: () => android.changeServer() }, 'Change the computer’s address'),
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
initScreens({ api, el, icon, markdown, cardMarkdown, toast, send, prefill, showView, AuthError, NetError, state });

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
