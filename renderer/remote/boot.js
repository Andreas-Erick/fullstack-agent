// Starting the client and reading the computer's /api/info.
import { busy as screenBusy } from './screens.js';
import { $, inputEl, NAME_KEY, bridge, store, replying, state } from './state.js';
import { api } from './net.js';
import { show, renderLinkInfo } from './pairing.js';
import { openStream } from './stream.js';
import { renderBanner } from './offline.js';
import { loadConversation } from './conversations.js';
import { setSpeak } from './voiceout.js';
import { faceView, updateFaceLabel, applyScene, mountFace, startFace } from './face.js';
import { showView, applyWide } from './nav.js';
import { setFx, openSplash } from './hud.js';

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
  const typing = inputEl.value.trim() || ($('#composer').contains(document.activeElement) && document.activeElement.matches('textarea'));
  const recording = !$('#recBar').classList.contains('hidden');
  const reading = state.view !== 'chat' && state.view !== 'sched' && screenBusy(state.view);
  if (replying() || state.face === 'speaking' || typing || recording || reading) reloadTimer = setTimeout(reloadWhenFree, 5000);
  else location.reload();
}

export async function applyInfo() {
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

export async function start() {
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

