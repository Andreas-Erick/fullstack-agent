// The face: the desktop's built-in or custom face, fed with this phone's state, the scene behind it,
// full screen, and the fallback orb.
import { faceState } from './js/turnstate.js';
import { BUILT_IN_FACES, DEFAULT_FACE } from './js/faces/registry.mjs';
import { $, inputEl, chat, state } from './state.js';
import { el, icon } from './ui.js';
import { api } from './net.js';
import { audio } from './voiceout.js';
import { syncBack } from './nav.js';

// ------------------------------------------------------------------ face
// The same face the desktop shows: its built-in faces are served from /js/ and fed with this phone's
// state through faces/env.js. The small orb further down is the fallback if they can't be loaded.
const STATES = { idle: ['IDLE', 0.3, 0.6], listening: ['LISTENING', 0.8, 1], thinking: ['THINKING', 2.4, 0.85], working: ['WORKING', 3.2, 0.9], 'speaking-text': ['REPLYING', 1.2, 1], speaking: ['SPEAKING', 1.2, 1], happy: ['DONE', 0.9, 1], sleeping: ['ASLEEP', 0.05, 0.35] };
const FACE_MODULES = Object.fromEntries(BUILT_IN_FACES.map((f) => [f.id, [`./js/${f.module}`, f.export]]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
export const faceView = { id: '', obj: null, themeFns: new Set(), orb: false };
state.happyUntil = 0;
state.lastActivity = Date.now();
state.sleepAfterMin = 0;
state.asleepAtStart = true; // asleep since the app opened, from the first frame (the desktop's ui.sleepOnLaunch may say otherwise), until something happens
state.micLevel = 0;

// What goes on now, for turnstate.faceState (the desktop's rule): the mic, the voice, a transcription, and every
// reply being written in the conversation shown, whoever started it. Replies are spoken only once done here.
const faceNow = () => ({ recording: state.recording, playing: state.playing, transcribing: state.transcribing, ...chat.activity(), spoken: false });

// The face follows what goes on (call after any of it changes).
export function refreshFace() {
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
export function agentState() {
  const now = Date.now();
  const sleeping = state.asleepAtStart || Boolean(state.sleepAfterMin && now - state.lastActivity > state.sleepAfterMin * 60000);
  return faceState({ ...faceNow(), happy: state.happyUntil > now, sleeping });
}

export function updateFaceLabel() {
  const s = state.face === 'speaking-text' ? 'speaking-text' : agentState();
  $('#faceState').textContent = (STATES[s] || STATES.idle)[0];
  document.body.classList.toggle('asleep', s === 'sleeping'); // the scene behind the face dims
}
setInterval(updateFaceLabel, 1000);
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => (state.lastActivity = Date.now()), { passive: true });
for (const ev of ['focus', 'pointerdown', 'keydown', 'input']) inputEl.addEventListener(ev, () => (wake(), updateFaceLabel()));
$('#micBtn').addEventListener('pointerdown', () => (wake(), updateFaceLabel()));

// The scene behind the face: fetched when its key in /api/info changes, cleaned again here (DOMPurify's
// SVG profile) before it joins the page; none → cleared.
const SCENE_PURIFY = { USE_PROFILES: { svg: true }, FORBID_TAGS: ['style', 'foreignObject', 'image', 'use', 'a', 'script', 'filter', 'animate', 'animateTransform', 'animateMotion', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'filter'] };
export async function applyScene(sc) {
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
export let voiceCtx = null;
let voiceAnalyser = null;
export function ensureAnalyser() {
  try {
    if (!voiceCtx) {
      voiceCtx = new AudioContext();
      const src = voiceCtx.createMediaElementSource(audio);
      voiceAnalyser = voiceCtx.createAnalyser();
      src.connect(voiceAnalyser);
      voiceAnalyser.connect(voiceCtx.destination);
    }
    voiceCtx.resume().catch(() => {}); // resumes on the next tap if the browser refuses now
  } catch {
    voiceCtx = null;
    voiceAnalyser = null;
  }
}
document.addEventListener('pointerdown', ensureAnalyser, { once: true, passive: true });
const analyserLive = () => Boolean(voiceAnalyser && voiceCtx?.state === 'running');

// Full screen: only the face (like the desktop's face layout). The button or Esc returns; the face keeps
// reacting to the conversation, so it works as a bedside or desk display on a tablet.
export function setFaceFull(on) {
  document.body.classList.toggle('face-full', on);
  $('#faceFull').setAttribute('aria-pressed', String(on));
  $('#faceFull').setAttribute('aria-label', on ? 'Back to the chat' : 'Show the face full screen');
  $('#faceFull').replaceChildren(icon(on ? 'close' : 'expand'));
  if (on) document.documentElement.requestFullscreen?.().catch(() => {}); // refused without a gesture: the face still fills the page
  else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); // already left full screen
  syncBack();
}
$('#faceFull').addEventListener('click', () => setFaceFull(!document.body.classList.contains('face-full')));
document.addEventListener('keydown', (e) => e.key === 'Escape' && document.body.classList.contains('face-full') && setFaceFull(false));
document.addEventListener('fullscreenchange', () => !document.fullscreenElement && document.body.classList.contains('face-full') && setFaceFull(false));

export async function mountFace(id, theme) {
  const want = FACE_MODULES[id] ? id : DEFAULT_FACE;
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
    if (theme.face?.custom && (await mountCustomFace().catch(() => false))) return; // a face that fails to load falls back to the built-in one below
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
export function startFace() {
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
