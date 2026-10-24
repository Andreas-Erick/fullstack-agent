// Phone client for the companion server (main/companion.js, docs/ROADMAP-mobile.md step 2).
// Talks only to the server it was loaded from. The device token lives in this browser's storage.
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

function markdown(text) {
  const html = window.marked.parse(String(text ?? ''), { breaks: true, gfm: true });
  return window.DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'input', 'img'], FORBID_ATTR: ['style'] });
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

class AuthError extends Error {}

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${state.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    unpair('This device was disconnected from the assistant. Pair it again.');
    throw new AuthError('Not paired');
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Error ${res.status}`);
  return raw ? res : res.json();
}

function show(screen) {
  $('#pair').classList.toggle('hidden', screen !== 'pair');
  $('#main').classList.toggle('hidden', screen !== 'main');
}

// ------------------------------------------------------------------ pairing
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

$('#pairForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  showPairError('');
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: $('#pairCode').value.trim(), name: $('#pairName').value.trim() || guessName() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    state.token = data.token;
    store.set(TOKEN_KEY, data.token);
    store.set(NAME_KEY, data.name);
    $('#pairCode').value = '';
    start();
  } catch (err) {
    showPairError(err.message);
  }
});

function guessName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android phone';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
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
      if (delay > 1000) loadConversation(state.convId); // catch up on what happened while away
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
    await new Promise((r) => setTimeout(r, delay));
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
}

function setConn(ok) {
  const c = $('#conn');
  c.classList.toggle('ok', ok);
  c.title = ok ? 'Connected' : 'Reconnecting…';
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
      $('#convTitle').textContent = ev.title || 'Conversation';
    } else {
      // A turn from the desktop or another device in the conversation shown here.
      addMessage(ev.userMessage);
      state.turns.set(ev.requestId, newTurnView(ev.requestId));
    }
    return;
  }
  const turn = state.active?.requestId === ev.requestId ? state.active : state.turns.get(ev.requestId);
  if (!turn) return;
  switch (ev.type) {
    case 'text':
      turn.text += ev.delta;
      if (turn === state.active) setFace('speaking-text');
      renderTurn(turn);
      break;
    case 'retract':
      turn.text = turn.text.slice(0, Math.max(0, turn.text.length - ev.chars));
      renderTurn(turn);
      break;
    case 'tool_start':
      turn.tools.append(el('span', { class: 'chip', 'data-id': ev.id }, '⚙ ', label(ev.name)));
      turn.running++;
      if (turn === state.active) setFace('working');
      scrollDown();
      break;
    case 'tool_end': {
      const chip = turn.tools.querySelector(`[data-id="${CSS.escape(String(ev.id))}"]`);
      if (chip) chip.className = `chip ${ev.ok === false ? 'bad' : 'good'}`;
      turn.running = Math.max(0, turn.running - 1);
      if (turn === state.active && !turn.running) setFace(turn.text ? 'speaking-text' : 'thinking');
      break;
    }
    case 'notice':
      turn.wrap.insertBefore(el('div', { class: 'notice' }, `⚠ ${ev.message}`), turn.bubble);
      break;
    case 'done':
      turn.bubble.classList.remove('streaming');
      turn.bubble.innerHTML = markdown(ev.message?.content || '');
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

const label = (name) => String(name || 'tool').replace(/^mcp__\w+__/, '').replace(/_/g, ' ');

function newTurnView(requestId, mine = false) {
  const bubble = el('div', { class: 'bubble streaming' });
  const tools = el('div', { class: 'tools' });
  const wrap = el('div', { class: 'msg assistant' }, tools, bubble);
  $('#messages').append(wrap);
  scrollDown();
  return { requestId, wrap, bubble, tools, text: '', running: 0, mine };
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
    $('#sendBtn').classList.remove('hidden');
    $('#stopBtn').classList.add('hidden');
    if (state.face !== 'speaking') setFace('idle');
  }
  scrollDown();
}

function addMessage(m) {
  if (!m || m.hidden) return;
  const text = m.display ?? m.content;
  const wrap = el('div', { class: `msg ${m.role}` });
  if (m.role === 'assistant') {
    if (m.toolCalls?.length) wrap.append(el('div', { class: 'tools' }, m.toolCalls.map((t) => el('span', { class: 'chip good' }, '⚙ ', label(t.name)))));
    const b = el('div', { class: 'bubble' });
    b.innerHTML = markdown(text);
    wrap.append(b);
  } else {
    wrap.append(el('div', { class: 'bubble' }, text));
    if (m.remote) wrap.append(el('div', { class: 'meta' }, `from ${m.remote}`));
  }
  $('#messages').append(wrap);
}

function scrollDown() {
  const m = $('#messages');
  m.scrollTop = m.scrollHeight;
}

async function send(text) {
  if (!text.trim() || state.active) return;
  addMessage({ role: 'user', content: text });
  const turn = newTurnView(null, true);
  state.active = turn;
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
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
    e.preventDefault();
    $('#composer').requestSubmit();
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
  if (!id) {
    $('#convTitle').textContent = 'New conversation';
    return;
  }
  try {
    const conv = await api(`/api/conversations/${encodeURIComponent(id)}`);
    $('#convTitle').textContent = conv.title || 'Conversation';
    for (const m of conv.messages) addMessage(m);
    scrollDown();
  } catch (err) {
    if (err instanceof AuthError) return;
    state.convId = null;
    store.set(CONV_KEY, null);
    $('#convTitle').textContent = 'New conversation';
  }
}

function openConversation(id) {
  if (state.active) return toast('Wait for the reply to finish first.');
  state.convId = id;
  store.set(CONV_KEY, id);
  closeDrawer();
  loadConversation(id);
}

async function openDrawer() {
  $('#drawer').classList.remove('hidden');
  $('#scrim').classList.remove('hidden');
  const list = $('#convList');
  list.innerHTML = '<li class="muted">Loading…</li>';
  try {
    const convs = (await api('/api/conversations')).filter((c) => !c.setup);
    list.innerHTML = '';
    if (!convs.length) list.append(el('li', { class: 'muted' }, 'No conversations yet.'));
    for (const c of convs) {
      list.append(el('li', {}, el('button', { class: `conv ${c.id === state.convId ? 'current' : ''}`, onclick: () => openConversation(c.id) }, el('span', {}, c.title || 'Conversation'), c.updatedAt ? el('small', {}, new Date(c.updatedAt).toLocaleString()) : null)));
    }
  } catch (err) {
    if (!(err instanceof AuthError)) list.innerHTML = `<li class="muted">${err.message.replace(/</g, '&lt;')}</li>`;
  }
}

function closeDrawer() {
  $('#drawer').classList.add('hidden');
  $('#scrim').classList.add('hidden');
}

$('#convBtn').addEventListener('click', openDrawer);
$('#drawerClose').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
$('#newBtn').addEventListener('click', () => openConversation(null));
$('#unpairBtn').addEventListener('click', () => unpair('Disconnected. To remove this device completely, remove it in the desktop app’s Settings too.'));

// ------------------------------------------------------------------ approvals
const KIND = { self_modify: 'Change its own code', settings: 'Change a setting', delete: 'Delete something', command: 'Run a command', calendar: 'Change your calendar', invite: 'Send calendar invitations', voice: 'Change its voice', voice_clone: 'Clone a voice', repo_change: 'Change a repository', github_publish: 'Publish to GitHub' };

function addApproval(a) {
  removeApproval(a.id);
  const card = el('div', { class: 'approval', 'data-id': a.id },
    el('div', { class: 'kind' }, KIND[a.kind] || a.kind),
    el('b', {}, a.title || 'Approval needed'),
    a.detail ? el('pre', { class: 'detail' }, String(a.detail).slice(0, 1500)) : null,
    a.tainted ? el('div', { class: 'warn' }, '⚠ This turn read outside content (web pages or documents). Make sure this is what you asked for.') : null,
    el('div', { class: 'row' },
      el('button', { class: 'btn', onclick: () => answer(a.id, false) }, 'Deny'),
      el('button', { class: 'btn primary', onclick: () => answer(a.id, true) }, 'Allow'),
    ),
  );
  $('#approvals').append(card);
  navigator.vibrate?.(80);
}

function removeApproval(id) {
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
const audio = new Audio();
audio.addEventListener('ended', () => setFace(state.active ? 'thinking' : 'idle'));
audio.addEventListener('playing', () => setFace('speaking'));

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
    if (audio.src) URL.revokeObjectURL(audio.src);
    audio.src = URL.createObjectURL(await res.blob());
    await audio.play();
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message);
  }
}

function setSpeak(on) {
  state.speak = on;
  store.set(SPEAK_KEY, on ? '1' : '0');
  $('#speakBtn').textContent = on ? '🔊' : '🔈';
  $('#speakBtn').setAttribute('aria-pressed', String(on));
  if (!on) audio.pause();
}
$('#speakBtn').addEventListener('click', () => {
  if (!state.voice && !state.speak) return toast('No voice is set up on the computer (Settings → Voice).');
  setSpeak(!state.speak);
  // A tap unlocks audio playback on mobile browsers.
  if (state.speak) audio.play().catch(() => {});
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
    node.onaudioprocess = (e) => rec?.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(node);
    node.connect(ctx.destination);
    Object.assign(rec, { stream, ctx, node, rate: ctx.sampleRate, started: Date.now(), starting: false, limit: setTimeout(stopRecording, MAX_REC_MS) });
    $('#micBtn').classList.add('live');
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
  $('#micBtn').classList.remove('live');
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
// A small orb with orbiting arcs; color and motion follow the agent's state.
const STATES = { idle: ['IDLE', 0.3, 0.6], listening: ['LISTENING', 0.8, 1],thinking: ['THINKING', 2.4, 0.85], working: ['WORKING', 3.2, 0.9], 'speaking-text': ['REPLYING', 1.2, 1], speaking: ['SPEAKING', 1.2, 1] };

function setFace(s) {
  state.face = s;
  $('#faceState').textContent = (STATES[s] || STATES.idle)[0];
}

function startFace() {
  const c = $('#face');
  const g = c.getContext('2d');
  let spin = 0;
  let last = performance.now();
  let level = 0;
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim() || '#00e5ff';
  const frame = (now) => {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) (c.width = Math.round(w * dpr)), (c.height = Math.round(h * dpr));
    const [, speed, bright] = STATES[state.face] || STATES.idle;
    const talking = state.face === 'speaking' || state.face === 'speaking-text';
    level += ((talking ? 0.35 + 0.35 * Math.abs(Math.sin(now / 90)) : 0) - level) * Math.min(1, dt * 10);
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

// ------------------------------------------------------------------ boot
async function applyInfo() {
  try {
    const info = await api('/api/info');
    state.voice = info.voice;
    $('#agentName').textContent = info.name.toUpperCase();
    document.title = info.name;
    const root = document.documentElement.style;
    for (const [k, v] of Object.entries({ bg: '--bg', surface: '--surface', text: '--text', muted: '--muted', accent: '--accent', accent2: '--accent2', danger: '--danger', success: '--ok' })) {
      if (info.colors[k]) root.setProperty(v, info.colors[k]);
    }
    if (info.colors.bg) document.querySelector('meta[name="theme-color"]').setAttribute('content', info.colors.bg);
  } catch {
    /* defaults */
  }
}

async function start() {
  show('main');
  setSpeak(state.speak);
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
  const unpairBtn = $('#unpairBtn');
  unpairBtn.before(
    el('label', { class: 'switch-row' }, sw, el('span', {}, 'Notify me about approvals and replies while the app is closed')),
    el('button', { class: 'btn ghost', onclick: () => android.changeServer() }, 'Change the computer’s address'),
  );
}

startFace();
// Offline app shell (needs HTTPS or localhost; on the plain local network the browser doesn't allow it).
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (state.token) start();
else show('pair');
