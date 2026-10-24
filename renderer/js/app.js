// Renderer entry point: wires views, the agent face, push-to-talk and status indicators together.
import { $, $$, api, on, emit, el, toast, logEvent } from './util.js';
import { state, loadSettings, saveSettings, ttsActive, raiseAlert } from './state.js';
import { switchView, currentView } from './nav.js';
import { FaceHost, BUILT_IN, runDemo } from './faces/host.js';
import { startListening, stopListening, toggleListening, speaker, preloadLocalModel, setMicMode, handsFree } from './voice.js';
import { initChat, newChat, sendVoice, currentConversationId } from './chat.js';
import { initApprovals, handleSpokenAnswer } from './approval.js';
import { initRemote } from './remote.js';
import { initHandoff, handoffNote } from './handoff.js';
import { initHud, bootScreen } from './hud.js';
import { tryCommand } from './commands.js';
import { startThinkingSound, stopThinkingSound, thinkingStyle } from './sounds.js';
import { initSetup, startSetup, handleSetupVoice } from './setup.js';
import { initMemory, refresh as refreshMemory } from './memory.js';
import { initCalendar, refresh as refreshCalendar } from './calendar.js';
import { initKnowledge, refresh as refreshKnowledge } from './knowledge.js';
import { initDocs } from './docs.js';
import { initSettings } from './settings.js';
import { initEvolution, refresh as refreshEvolution } from './evolution.js';
import { initSkills, refresh as refreshSkills } from './skills.js';
import { initLayout, applyLayout, setLayout, zoomBy, setZoom, quickNote, toggleAppFullscreen } from './layout.js';
import { applyTheme } from './theme.js';

// Safety net: an unexpected error anywhere in the UI is logged (repeats at most once a minute)
// instead of disappearing; the app keeps running.
const seenErrors = new Map();
function reportUiError(kind, err) {
  const message = String(err?.message || err || 'unknown error').slice(0, 300);
  const key = `${kind}:${message}`;
  if (Date.now() - (seenErrors.get(key) || 0) < 60000) return;
  seenErrors.set(key, Date.now());
  logEvent('error', `ui ${kind}`, { message, stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ') });
}
window.addEventListener('error', (e) => reportUiError('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => reportUiError('unhandled rejection', e.reason));

let appliedTheme = '';
function syncTheme() {
  const json = JSON.stringify(state.settings.appearance?.theme || null);
  if (json === appliedTheme) return;
  appliedTheme = json;
  const t = applyTheme(state.settings.appearance?.theme);
  // The OS window buttons (drawn over the title bar) follow the theme too.
  api.win.overlay({ color: t.colors.bg, symbolColor: t.colors.accent }).catch(() => {});
}

let miniFace;
let bigFace;

async function boot() {
  const info = await api.app.info();
  if (info.platform === 'darwin') document.body.classList.add('mac');
  await loadSettings();
  syncTheme();
  initHud();
  const boot = bootScreen();

  miniFace = new FaceHost($('#miniFace'), { compact: true });
  bigFace = new FaceHost($('#bigFace'));
  await refreshFaceList();

  initSettings();
  initChat();
  initMemory();
  initCalendar();
  initKnowledge();
  initDocs();
  initEvolution();
  initSkills();
  initLayout({ miniFace });
  initApprovals();
  initRemote();
  initHandoff();
  setupVoiceRouting();

  // Navigation
  $$('.rail-btn').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  on('view', ({ name }) => {
    if (name === 'memory') refreshMemory();
    if (name === 'calendar') refreshCalendar();
    if (name === 'knowledge') refreshKnowledge();
    if (name === 'evolution') refreshEvolution();
    if (name === 'skills') refreshSkills();
    if (name === 'chat') requestAnimationFrame(() => miniFace.resize());
    if (name === 'face') requestAnimationFrame(() => bigFace.resize());
    if (name !== 'face' && document.body.classList.contains('fullscreen-face')) exitFullscreen();
  });

  // Settings-driven UI
  on('settings', applySettings);
  on('layout', applySettings);
  applySettings();

  // Agent state → UI
  on('agent-state', (s) => {
    // Processing sound while thinking or running tools (only when replies are spoken, and not during the demo).
    if ((s === 'thinking' || s === 'working') && ttsActive() && !state.demo) startThinkingSound(thinkingStyle(state.settings.voice.thinkingSound), state.settings.voice.thinkingVolume ?? 0.5);
    else stopThinkingSound();
    const label = s.toUpperCase();
    const b = $('#brandState');
    b.textContent = s;
    b.className = `brand-state ${s}`;
    $('#miniFaceLabel').textContent = label;
    $('#faceState').textContent = label;
    $$('.mic-btn').forEach((m) => {
      m.classList.toggle('recording', s === 'listening');
      m.classList.toggle('busy', state.transcribing);
    });
  });
  on('caption', ({ text, role }) => {
    for (const c of [$('#faceCaption'), $('#miniCaption')]) {
      c.textContent = state.settings.ui.captions ? text : '';
      c.classList.toggle('user', role === 'user');
    }
  });
  on('speech-idle', () => {
    if (!state.generating) setTimeout(() => !state.playing && !state.recording && !state.generating && ($('#faceCaption').textContent = $('#miniCaption').textContent = ''), 2500);
  });

  setupPushToTalk();
  setupShortcuts();

  $('#fullscreenBtn').onclick = () => (document.fullscreenElement ? exitFullscreen() : enterFullscreen());
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) document.body.classList.remove('fullscreen-face');
    requestAnimationFrame(() => bigFace.resize());
  });

  refreshStatus();
  on('status-refresh', refreshStatus);
  // Settings can change mid-conversation (setup, voice commands, the agent fixing itself): refresh the status lights.
  let lastProvider = state.settings.llm.provider;
  on('settings', (st) => {
    if (st.llm.provider !== lastProvider) {
      lastProvider = st.llm.provider;
      refreshStatus();
    }
  });
  setInterval(refreshStatus, 60000);
  window.addEventListener('focus', refreshStatus);

  // Warm up the local speech model in the background so the first push-to-talk is fast.
  setTimeout(() => preloadLocalModel(), 3000);

  // Alerts turn the face red; vault edits by the agent refresh the open views.
  on('alert', (a) => {
    for (const n of [$('#brandState'), $('#miniFaceLabel'), $('#faceState')]) n.classList.toggle('alert', Boolean(a));
    if (a) $('#faceState').textContent = 'ALERT';
  });
  on('voice-fallback', (msg) => raiseAlert(`VoiceStudio unavailable: ${msg}`));
  api.on('vault:changed', (rel) => emit('vault-changed', rel));
  api.on('app:notice', ({ message, kind }) => toast(message, kind, 15000));
  // Helper apps (VoiceStudio, FreeLLMAPI) started by Nexus: say so, and refresh the status lights when ready.
  api.on('helperApps:event', (ev) => {
    if (ev.type === 'starting') toast(`Starting ${ev.name} in the background…`);
    else if (ev.type === 'ready') (toast(`${ev.name} is ready.`), emit('status-refresh'));
    else if (ev.type === 'failed') toast(`${ev.name} could not be started: ${ev.error}`, 'error', 10000);
  });

  // Face gallery + demo
  $('#faceSelect').onchange = () => saveSettings({ ui: { face: $('#faceSelect').value } });
  $('#faceDemo').onclick = () => runDemo();
  $('#faceFolder').onclick = async () => (await api.faces.openFolder(), setTimeout(refreshFaceList, 1500));

  // Hands-free mode, launch greeting (which also hides the first-turn warm-up), first-run setup.
  if (state.settings.stt.enabled && state.settings.stt.micMode === 'open') setMicMode('open');
  initSetup();
  if (!state.settings.onboarded) startSetup(); // first launch: the agent sets itself up by asking questions
  if (state.settings.onboarded) greetOnLaunch();
  boot.done();
}

let faceList = BUILT_IN.map((f) => ({ id: f.id, title: f.title }));
async function refreshFaceList() {
  const custom = await api.faces.list().catch(() => []);
  faceList = [...BUILT_IN.map((f) => ({ id: f.id, title: f.title })), ...custom.map((c) => ({ id: c.id, title: `${c.title} (custom)` }))];
  const sel = $('#faceSelect');
  sel.innerHTML = '';
  for (const f of faceList) sel.append(el('option', { value: f.id, selected: f.id === state.settings.ui.face }, f.title));
  applySettings();
}

function greetOnLaunch() {
  const s = state.settings;
  if (s.voice.ttsEnabled && s.voice.greetOnLaunch) {
    const name = s.agent.name || 'Nexus';
    // With a note from last time, the greeting says where we left off (one short sentence).
    handoffNote().then((n) => {
      const greeting = s.appearance.greeting || `Hello, I'm ${name}. What are we working on today?`;
      const recent = n && Date.now() - n.at < 3 * 24 * 60 * 60 * 1000;
      setTimeout(() => speaker.say(recent ? `${greeting} Last time we were on ${n.topic || n.title}; say the word and we continue.` : greeting), 900);
    });
  }
  setTimeout(() => {
    const id = currentConversationId();
    if (id) api.llm.prewarm(id).catch(() => {});
  }, 1500);
}

// Every transcript goes: pending approval → voice command → the agent (interrupting a reply in progress).
function setupVoiceRouting() {
  on('voice-input', async (text) => {
    if (handleSpokenAnswer(text)) return;
    if (handleSetupVoice(text)) return;
    if (await tryCommand(text, { newChat, stop: () => speaker.stop() })) return;
    sendVoice(text);
  });
  on('settings', (s) => {
    const want = s.stt.enabled && s.stt.micMode === 'open';
    if (want && !handsFree.running) setMicMode('open');
    if (!want && handsFree.running) setMicMode('ptt');
  });
}

function applySettings() {
  const s = state.settings;
  syncTheme();
  const name = s.agent.name || 'Nexus';
  $('#brandName').textContent = name.toUpperCase();
  $('#faceName').textContent = name.toUpperCase();
  document.title = `${name} · Nexus Agent`;
  $('#input').placeholder = `Message ${name}…  (Enter to send, Shift+Enter for a new line)`;
  const av = $('#brandAvatar');
  av.style.backgroundImage = s.agent.avatar ? `url(${s.agent.avatar})` : '';
  av.style.backgroundSize = 'cover';
  const faceId = faceList.some((f) => f.id === s.ui.face) ? s.ui.face : 'circuit';
  bigFace?.set(faceId, { avatar: s.agent.avatar, name });
  // In the face layout the chat's face is full size (and can be a custom face); otherwise compact.
  applyLayout();
  const big = $('#view-chat').classList.contains('layout-face');
  miniFace?.setCompact(!big);
  miniFace?.set(!big && faceId.startsWith('custom:') ? 'circuit' : faceId, { avatar: s.agent.avatar, name });
  if ($('#faceSelect').value !== faceId) $('#faceSelect').value = faceId;
  $$('.ptt-key').forEach((k) => (k.textContent = s.stt.pttKey));
  const hint = $('#pttHint');
  if (hint) hint.textContent = s.stt.pttKey;
}

// ------------------------------------------------------------ push-to-talk
function isTypingTarget(t) {
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function setupPushToTalk() {
  let held = false;
  window.addEventListener('keydown', (e) => {
    const key = state.settings.stt.pttKey;
    if (e.code !== key || e.repeat) return;
    // Letter/space keys would interfere with typing, so only function-style keys work inside inputs.
    if (isTypingTarget(e.target) && /^(Key|Digit|Space)/.test(key)) return;
    e.preventDefault();
    held = true;
    startListening();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === state.settings.stt.pttKey && held) {
      held = false;
      e.preventDefault();
      stopListening();
    }
  });
  window.addEventListener('blur', () => {
    if (held) {
      held = false;
      stopListening();
    }
  });

  for (const btn of [$('#micBtn'), $('#faceMicBtn')]) {
    let down = false;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      down = true;
      startListening();
    });
    const up = () => {
      if (!down) return;
      down = false;
      stopListening();
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
  }

  api.on('voice:toggle', () => toggleListening());
}

// --------------------------------------------------------------- shortcuts
function setupShortcuts() {
  const views = ['chat', 'face', 'memory', 'calendar', 'knowledge', 'docs', 'evolution', 'skills'];
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && /^Digit[1-3]$/.test(e.code)) {
      e.preventDefault();
      switchView('chat');
      setLayout(['chat', 'split', 'face'][Number(e.code.slice(5)) - 1]);
    } else if (mod && /^Digit[1-8]$/.test(e.code)) {
      e.preventDefault();
      switchView(views[Number(e.code.slice(5)) - 1]);
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoomBy(1);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      zoomBy(-1);
    } else if (mod && e.key === '0') {
      e.preventDefault();
      setZoom(1);
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      quickNote();
    } else if (mod && e.key === ',') {
      e.preventDefault();
      switchView('settings');
    } else if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      switchView('chat');
      newChat();
    } else if (e.key === 'F11' && currentView === 'face') {
      e.preventDefault();
      document.fullscreenElement ? exitFullscreen() : enterFullscreen();
    } else if (e.key === 'F11') {
      e.preventDefault();
      toggleAppFullscreen();
    } else if (e.key === 'Escape' && state.playing) {
      speaker.stop();
    }
  });
}

function enterFullscreen() {
  if (currentView !== 'face') switchView('face');
  document.body.classList.add('fullscreen-face');
  document.documentElement.requestFullscreen?.().catch(() => {});
  requestAnimationFrame(() => bigFace.resize());
}

function exitFullscreen() {
  document.body.classList.remove('fullscreen-face');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ---------------------------------------------------------- status pills
function setPill(id, cls, title) {
  const p = $(id);
  p.className = `pill ${cls}`;
  p.title = title;
}

async function refreshStatus() {
  const s = state.settings;
  // Brain
  if (s.llm.provider === 'auto') {
    api.llm
      .routerStatus()
      .then((list) => {
        const on_ = list.filter((p) => p.enabled && p.configured);
        const ready = on_.filter((p) => !p.resting);
        const detail = on_.map((p) => `${p.name}${p.resting ? ` (skipped ${p.resting.minutes} min: ${p.resting.reason})` : ''}`).join(' > ');
        setPill('#pillLlm', !ready.length ? 'err' : ready.length < on_.length || ready.length === 1 ? 'warn' : 'ok', ready.length ? `Multi-provider · ${detail}` : 'Multi-provider: no provider is ready');
      })
      .catch((e) => setPill('#pillLlm', 'err', e.message));
  } else if (s.llm.provider === 'claude-code') {
    api.claude
      .status()
      .then((c) => setPill('#pillLlm', c.loggedIn ? 'ok' : 'err', !c.installed ? 'Claude Code not installed' : c.loggedIn ? `Claude account · ${c.email || ''} (${c.subscription || c.authMethod})` : 'Claude account not connected'))
      .catch((e) => setPill('#pillLlm', 'err', e.message));
  } else if (s.llm.provider === 'anthropic') {
    setPill('#pillLlm', s.anthropic.apiKey ? 'ok' : 'err', s.anthropic.apiKey ? `Claude · ${s.anthropic.model}` : 'Claude: API key missing');
  } else {
    api.llm
      .models()
      .then((m) => setPill('#pillLlm', 'ok', `FreeLLMAPI · ${s.llm.model || m[0]?.id || 'default model'} (${m.length} models)`))
      .catch((e) => setPill('#pillLlm', 'err', `FreeLLMAPI unreachable: ${e.message}`));
  }
  api.tts
    .ping()
    .then((r) => setPill('#pillVoice', !r.enabled ? '' : r.ok ? 'ok' : 'err', !r.enabled ? 'Voice disabled' : r.ok ? `VoiceStudio · ${s.voice.baseUrl}` : `VoiceStudio unreachable at ${s.voice.baseUrl}`))
    .catch(() => setPill('#pillVoice', 'err', 'VoiceStudio error'));
  api.calendar
    .status()
    .then((c) => setPill('#pillCal', !c.enabled ? '' : c.connected ? 'ok' : 'warn', !c.enabled ? 'Calendar disabled' : c.connected ? [c.signedIn && `Google Calendar${c.email ? ` · ${c.email}` : ''}`, c.feeds && `${c.feeds} calendar link${c.feeds > 1 ? 's' : ''} (read-only)`].filter(Boolean).join(' + ') : 'Calendar not connected'))
    .catch(() => setPill('#pillCal', 'err', 'Calendar error'));
  api.obsidian
    .status()
    .then((o) => setPill('#pillKb', !o.enabled ? '' : o.ok ? 'ok' : 'warn', !o.enabled ? 'Vault disabled' : o.ok ? `Obsidian vault · ${o.count} notes · ${o.path}` : 'Vault folder unavailable'))
    .catch(() => setPill('#pillKb', 'err', 'Vault error'));
}

// Clicking a pill jumps to its settings.
const pillTargets = { pillLlm: 'brain', pillVoice: 'voice', pillCal: 'calendar', pillKb: 'obsidian' };
for (const [id, section] of Object.entries(pillTargets)) document.getElementById(id).addEventListener('click', () => switchView('settings', section));

boot().catch((err) => {
  console.error(err);
  reportUiError('startup', err);
  const bar = el('div', { style: { position: 'fixed', bottom: '0', left: '0', right: '0', padding: '12px', background: 'var(--glass)', color: 'rgb(var(--err))', zIndex: '99', display: 'flex', gap: '12px', alignItems: 'center' } }, `Startup error: ${err.message}`);
  bar.append(el('button', { class: 'btn', onclick: () => location.reload() }, 'Reload'));
  document.body.append(bar);
});

emit('ready');
