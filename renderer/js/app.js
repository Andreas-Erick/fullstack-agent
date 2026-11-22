// Renderer entry point: wires views, the agent face, push-to-talk and status indicators together.
import { $, $$, api, on, emit, el, toast, logEvent, dialogOpen, reportUiError, installErrorTrap } from './util.js';
import { state, loadSettings, saveSettings, ttsActive, raiseAlert, noteActivity } from './state.js';
import { applyScene } from './scene.js';
import { switchView, currentView } from './nav.js';
import { initMoreMenu } from './moremenu.js';
import { FaceHost, BUILT_IN, runDemo } from './faces/host.js';
import { startListening, stopListening, toggleListening, speaker, preloadSpeechIfUsed, preloadOfflineVoice, setMicMode, handsFree, warmMic } from './voice.js';
import { initChat, newChat, sendVoice, currentConversationId, cancelReply, retryLatest, canRetryLatest } from './chat.js';
import { initApprovals, handleSpokenAnswer } from './approval.js';
import { initRemote } from './remote.js';
import { initUsage } from './usage.js';
import { initUpdates } from './updates.js';
import { initIssues } from './issues.js';
import { initSysmon } from './sysmon.js';
import { handoffNote } from './handoff.js';
import { toggleHistory } from './history.js';
import { initHud } from './hud.js';
import { tryCommand } from './commands.js';
import { startThinkingSound, stopThinkingSound, thinkingStyle } from './sounds.js';
import { initSetup, handleSetupVoice } from './setup.js';
import { maybeStartOnboarding } from './onboarding.js';
import { initMemory, refresh as refreshMemory } from './memory.js';
import { initCalendar, refresh as refreshCalendar } from './calendar.js';
import { initKnowledge, refresh as refreshKnowledge } from './knowledge.js';
import { initDocs } from './docs.js';
import { initSettings } from './settings.js';
import { initEvolution, refresh as refreshEvolution } from './evolution.js';
import { initSkills, refresh as refreshSkills } from './skills.js';
import { initNotes, refresh as refreshNotes, openDump, newNote } from './notes.js';
import { initRoutines, refresh as refreshRoutines } from './routines.js';
import { initInnerWorld, refresh as refreshInnerWorld } from './innerworld.js';
import { initArchMap, refresh as refreshArchMap } from './archmap.js';
import { initLayout, applyLayout, setLayout, zoomBy, setZoom, toggleAppFullscreen, setFullscreen, isFullscreen } from './layout.js';
import { applyTheme } from './theme.js';
import { switchPersona } from './personas.js';
import { practiceLanguage, languageName } from './practice.js';
import { initPerf, perfReady } from './perf.js';
import { launchGreeting, HANDOFF_LATE_MS } from './phrasecore.js';
import { ownEndpoint } from './braintable.mjs';
import { pillText } from './statuscore.js';

// Safety net: an unexpected error anywhere in the UI is logged instead of disappearing (util.js).
installErrorTrap();

let appliedTheme = '';
function syncTheme() {
  const json = JSON.stringify(state.settings.appearance?.theme || null);
  if (json === appliedTheme) return;
  appliedTheme = json;
  const t = applyTheme(state.settings.appearance?.theme);
  // The OS window buttons (drawn over the title bar) follow the theme too.
  api.win.overlay({ color: t.colors.bg, symbolColor: t.colors.accent }).catch(() => {}); // the overlay colours are cosmetic; the window works without them
}

let miniFace;
let bigFace;

async function boot() {
  const info = await api.app.info();
  if (info.platform === 'darwin') document.body.classList.add('mac');
  await loadSettings();
  // Asleep from the very first frame (faces read state.agentState as soon as they exist); awake at once
  // only when the user turned that off, or during the setup wizard.
  state.sleeping = state.settings.onboarded && state.settings.ui.sleepOnLaunch !== false;
  state.agentState = state.sleeping ? 'sleeping' : 'idle';
  syncTheme();
  start('hud', initHud);

  miniFace = new FaceHost($('#miniFace'), { compact: true });
  bigFace = new FaceHost($('#bigFace'));
  await refreshFaceList();

  // From here on every part starts on its own (start): one that throws is logged and shown on its view,
  // and the rest still starts. First what gets you out of a broken start: the rail, the app's notices,
  // approvals and Evolution (where a bad self-change is reverted).
  start('rail', () => {
    // The rail's places and the More menu's (moremenu.js): each opens its view.
    $$('.rail-btn[data-view]').forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
    initMoreMenu();
    // Arrow keys move along the rail (Tab enters and leaves it; Enter or Space opens the view or More).
    $('#rail').addEventListener('keydown', (e) => {
      const btns = $$('#rail .rail-btn').filter((b) => b.offsetParent);
      const i = btns.indexOf(document.activeElement);
      const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: btns.length - 1 }[e.key];
      if (i < 0 || to === undefined) return;
      e.preventDefault();
      btns[(to + btns.length) % btns.length].focus();
    });
  });
  // Vault edits by the agent refresh the open views; the main process's notices (a self-change that
  // logged problems after going live) show as toasts.
  start('notices', () => {
    api.on('vault:changed', (rel) => emit('vault-changed', rel));
    api.on('app:notice', ({ message, kind }) => toast(message, kind, 15000));
  });
  start('approvals', initApprovals);
  start('evolution', initEvolution, 'evolution');
  start('view refresh', () => {
    on('view', ({ name }) => {
      if (name === 'memory') refreshMemory();
      if (name === 'calendar') refreshCalendar();
      if (name === 'knowledge') refreshKnowledge();
      if (name === 'evolution') refreshEvolution();
      if (name === 'skills') (refreshSkills(), refreshRoutines());
      if (name === 'notes') refreshNotes();
      if (name === 'world') requestAnimationFrame(() => refreshInnerWorld());
      if (name === 'arch') requestAnimationFrame(() => refreshArchMap());
      if (name === 'chat') requestAnimationFrame(() => miniFace.resize());
      if (name === 'face') requestAnimationFrame(() => bigFace.resize());
      if (name !== 'face' && document.body.classList.contains('fullscreen-face')) exitFullscreen();
    });
  });

  // The views and the title-bar parts.
  start('settings', initSettings, 'settings');
  start('chat', initChat, 'chat');
  start('memory', initMemory, 'memory');
  start('calendar', initCalendar, 'calendar');
  start('knowledge', initKnowledge, 'knowledge');
  start('documents', initDocs, 'docs');
  start('skills', initSkills, 'skills');
  start('notes', initNotes, 'notes');
  start('routines', initRoutines, 'skills');
  start('world', initInnerWorld, 'world');
  start('architecture', initArchMap, 'arch');
  start('layout', () => initLayout({ miniFace }));
  start('remote', initRemote);
  start('usage', initUsage);
  start('updates', initUpdates);
  start('issues', initIssues);
  start('system monitor', initSysmon);
  start('agent window', () => {
    $('#pillAgentWin').addEventListener('click', () => api.agentWindow.open().catch((err) => toast(err.message, 'error')));
    const showAgentWin = () => $('#pillAgentWin').classList.toggle('hidden', state.settings?.agentWindow?.enabled === false);
    on('settings', showAgentWin);
    showAgentWin();
  });
  start('voice routing', setupVoiceRouting);

  // Settings-driven UI
  start('settings-driven UI', () => {
    on('settings', applySettings);
    on('layout', applySettings);
    applySettings();
    // A connector's level saved outside the window (an approval's "Always allow…", the agent's
    // connector_permission): keep this window's copy current, so Settings shows it and never saves over it.
    api.on('claude:connectorLevels', (lists) => {
      state.settings = { ...state.settings, claudeCode: { ...state.settings.claudeCode, ...lists } };
      emit('settings', state.settings);
    });
  });

  // Agent state → UI
  start('agent state', () => {
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
  });

  start('push-to-talk', setupPushToTalk);
  start('shortcuts', setupShortcuts);

  start('fullscreen', () => {
    $('#fullscreenBtn').onclick = () => (document.body.classList.contains('fullscreen-face') ? exitFullscreen() : enterFullscreen());
    on('fullscreen', () => requestAnimationFrame(() => bigFace.resize()));
  });

  start('status lights', () => {
    // Clicking a light jumps to its settings.
    for (const [id, section] of Object.entries(pillTargets)) document.getElementById(id)?.addEventListener('click', () => switchView('settings', section));
    // The offline voice failing to load turns its light red; loading again turns it green.
    on('tts-progress', (p) => {
      if (p.status === 'error') voiceError = p.message || 'unknown error';
      else if (p.status === 'ready') voiceError = '';
      else return;
      if (state.settings.voice.engine === 'local' && state.settings.voice.ttsEnabled) offlineVoicePill();
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
    // Every 5 minutes, and on coming back to the window: at most every 5 minutes, every 15 s while a
    // light shows a problem (signing in elsewhere shows quickly). The checks start programs and walk the vault.
    setInterval(refreshStatus, STATUS_EVERY_MS);
    window.addEventListener('focus', () => {
      const troubled = ['#pillLlm', '#pillVoice', '#pillCal', '#pillKb'].some((id) => /\b(err|warn)\b/.test($(id).className));
      if (Date.now() - lastStatusAt > (troubled ? 15000 : STATUS_EVERY_MS)) refreshStatus();
    });
  });

  // Check what this computer can take (once, then every 30 days), then warm up the local speech model
  // for someone who used voice input this week (perfcore.js preloadSpeech); everyone else loads it
  // with the first press of the talk key, and Balanced never preloads.
  start('performance', () => {
    initPerf();
    preloadOfflineVoice();
    perfReady.then(() => setTimeout(preloadSpeechIfUsed, 3000));
    // The microphone, open before the first push-to-talk press (and again when you come back to the window).
    setTimeout(warmMic, 1500);
    window.addEventListener('focus', warmMic);
  });

  // Alerts turn the face red.
  start('alerts', () => {
    on('alert', (a) => {
      for (const n of [$('#brandState'), $('#miniFaceLabel'), $('#faceState')]) n.classList.toggle('alert', Boolean(a));
      if (a) $('#faceState').textContent = 'ALERT';
    });
    on('voice-fallback', (msg) => raiseAlert(`VoiceStudio unavailable: ${msg}`));
    // Helper apps (VoiceStudio, FreeLLMAPI) started by Nexus: say so, and refresh the status lights when ready.
    api.on('helperApps:event', (ev) => {
      if (ev.type === 'starting') toast(`Starting ${ev.name} in the background…`);
      else if (ev.type === 'ready') (toast(`${ev.name} is ready.`), emit('status-refresh'));
      else if (ev.type === 'failed') toast(`${ev.name} could not be started: ${ev.error}`, 'error', 10000);
    });
  });

  // Face gallery + demo
  start('face controls', () => {
    $('#faceSelect').onchange = () => saveSettings({ ui: { face: $('#faceSelect').value } });
    $('#pillPractice').onclick = () => saveSettings({ learning: { practiceLanguage: '' } }).then(() => toast('Language practice ended'));
    wirePersonaSelect();
    $('#faceDemo').onclick = () => runDemo();
    $('#faceFolder').onclick = async () => (await api.faces.openFolder(), setTimeout(refreshFaceList, 1500));
  });

  // Hands-free mode, launch greeting (which also hides the first-turn warm-up), first-run setup.
  start('hands-free', () => {
    if (state.settings.stt.enabled && state.settings.stt.micMode === 'open') setMicMode('open');
  });
  start('setup', initSetup);
  start('launch', () => {
    const setupOpen = maybeStartOnboarding({ then: greetOnLaunch }); // first launch: the guided setup (it ends with the agent's interview); the privacy step if never accepted, greeting after it
    // Asleep (since before the first frame, see the top of init) until the greeting or the first thing
    // you do wakes her (typing, the mic; any turn does too). The labels learn the state now that they listen.
    emit('agent-state', state.agentState);
    for (const ev of ['focus', 'pointerdown', 'keydown', 'input']) $('#input').addEventListener(ev, noteActivity);
    for (const b of ['#micBtn', '#faceMicBtn']) $(b)?.addEventListener('pointerdown', noteActivity);
    if (!setupOpen) greetOnLaunch();
  });
}

// One part failing to start (a view after a bad self-change, a title-bar widget) mustn't take the window
// down: it is logged, its view says so, and everything else still starts.
function start(name, fn, view = null) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') r.catch((err) => startFailed(name, err, view));
  } catch (err) {
    startFailed(name, err, view);
  }
}

function startFailed(name, err, view) {
  reportUiError(`init ${name}`, err);
  // Also on the console, as a failed boot() was: the launch check (main/smoke.js) fails on console errors,
  // and DevTools shows the stack.
  console.error(`${name} couldn’t start`, err);
  const host = view && document.getElementById(`view-${view}`);
  const box = el('div', { class: 'view-error', role: 'alert' },
    el('b', {}, `${name} couldn’t start: ${err?.message || err}`),
    el('button', { class: 'btn small', onclick: () => location.reload() }, '⟳ Reload'),
    el('button', { class: 'btn small', onclick: () => switchView('evolution') }, 'Open Evolution'),
  );
  if (host) host.prepend(box);
  else toast(`${name} couldn’t start: ${err?.message || err}`, 'error', 15000);
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
    // The greeting plays from its kept audio (phrases.js) as the window opens. With a note from last
    // time, one short line about it follows from the voice (never kept: it holds conversation content),
    // unless you started typing or it would come too late.
    let typed = false;
    $('#input').addEventListener('input', () => (typed = true), { once: true });
    handoffNote().then((n) => {
      const { greeting, handoff } = launchGreeting(s, n);
      setTimeout(() => {
        const at = performance.now();
        speaker.say(greeting, undefined, { remember: true });
        if (handoff) speaker.follow(handoff, { skipIf: () => typed || performance.now() - at > HANDOFF_LATE_MS });
      }, 900);
    });
  }
  setTimeout(() => {
    const id = currentConversationId();
    if (id) api.llm.prewarm(id, { now: true }).catch(() => {}); // at once, not after the settle time
  }, 1500);
}

// Every transcript goes: pending approval → voice command → the agent (interrupting a reply in progress).
function setupVoiceRouting() {
  on('voice-input', async (text) => {
    if (handleSpokenAnswer(text)) return emit('barge-in-over'); // an approval answer: the reply goes on speaking
    if (handleSetupVoice(text)) return;
    if (await tryCommand(text, { newChat, stop: () => speaker.stop(), cancel: () => (cancelReply(), speaker.stop()), retry: retryLatest, canRetry: canRetryLatest })) return;
    sendVoice(text);
  });
  on('settings', (s) => {
    const want = s.stt.enabled && s.stt.micMode === 'open';
    if (want && !handsFree.running) setMicMode('open');
    if (!want && handsFree.running) setMicMode('ptt');
  });
}

// A pick with the mouse switches at once. The arrow keys on the closed list fire a change for every
// persona they pass, and each switch speaks a greeting and restarts the session: from the keyboard the
// choice counts on Enter or when the list loses the focus; Esc puts the active persona back.
function wirePersonaSelect() {
  const sel = $('#personaSelect');
  let keyed = false;
  let pending = false;
  const commit = async () => {
    pending = false;
    syncPersonaSelect((await switchPersona(sel.value)).personas);
  };
  sel.addEventListener('pointerdown', () => (keyed = false));
  sel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && pending) (e.preventDefault(), commit());
    else if (e.key === 'Escape' && pending) (e.preventDefault(), (pending = false), (sel.value = state.settings.personas?.active || ''));
    else if (e.key !== 'Tab') keyed = true;
  });
  sel.addEventListener('keyup', (e) => e.key === 'Enter' && pending && commit()); // Enter in the open list: the change comes after the keydown
  sel.addEventListener('change', () => (keyed ? (pending = true) : commit()));
  sel.addEventListener('blur', () => pending && commit());
}

// The title-bar persona switcher, shown once there is more than one persona.
let personaOptions = '';
function syncPersonaSelect(p) {
  const sel = $('#personaSelect');
  const list = p?.list || [];
  sel.classList.toggle('hidden', list.length < 2);
  const key = JSON.stringify(list.map((x) => [x.id, x.name]));
  if (key !== personaOptions) {
    personaOptions = key;
    sel.innerHTML = '';
    for (const x of list) sel.append(el('option', { value: x.id }, x.name || 'Unnamed'));
  }
  sel.value = p?.active || '';
}

function applySettings() {
  const s = state.settings;
  syncTheme();
  applyScene(s.appearance?.scene);
  const name = s.agent.name || 'Siren';
  $('#brandName').textContent = name.toUpperCase();
  $('#faceName').textContent = name.toUpperCase();
  document.title = `${name} · Siren Assistant`;
  $('#input').placeholder = `Message ${name}…  (Enter to send, Shift+Enter for a new line)`;
  const av = $('#brandAvatar');
  av.style.backgroundImage = s.agent.avatar ? `url(${s.agent.avatar})` : '';
  av.style.backgroundSize = 'cover';
  syncPersonaSelect(s.personas);
  const practice = practiceLanguage(s);
  $('#pillPractice').classList.toggle('hidden', !practice);
  $('#pillPractice span').textContent = practice ? `Practice · ${languageName(practice)}` : 'Practice';
  const faceId = faceList.some((f) => f.id === s.ui.face) ? s.ui.face : 'circuit';
  bigFace?.set(faceId, { avatar: s.agent.avatar, name });
  // In the face layout the chat's face is full size; otherwise compact (custom faces scale themselves).
  applyLayout();
  const big = $('#view-chat').classList.contains('layout-face');
  miniFace?.setCompact(!big);
  miniFace?.set(faceId, { avatar: s.agent.avatar, name });
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
  // Ctrl+1-5 follow the rail, top to bottom; the places under More have no number (spec #17).
  const views = ['chat', 'notes', 'calendar', 'memory', 'docs'];
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && /^Digit[1-3]$/.test(e.code)) {
      e.preventDefault();
      switchView('chat');
      setLayout(['chat', 'split', 'face'][Number(e.code.slice(5)) - 1]);
    } else if (mod && /^Digit[1-5]$/.test(e.code)) {
      e.preventDefault();
      switchView(views[Number(e.code.slice(5)) - 1]);
    } else if (mod && !e.shiftKey && e.code === 'Digit9') {
      // Notes' old number, kept for habits from before the everyday rail.
      e.preventDefault();
      switchView('notes');
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
      // Capture from anywhere: the Notes view's brain-dump page.
      e.preventDefault();
      openDump();
    } else if (mod && e.key === ',') {
      e.preventDefault();
      switchView('settings');
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h' && !dialogOpen() && $('#onboarding').classList.contains('hidden') && !$('#notesDumpLayer')) {
      // History: the earlier chats and the search through them (history.js), from any view.
      e.preventDefault();
      if (currentView !== 'chat') switchView('chat');
      toggleHistory();
    } else if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      // In the Notes view a new note, also when the focus is outside the view (Ctrl+2 moves none); a chat elsewhere.
      if (currentView === 'notes') {
        if (!dialogOpen() && !$('#notesDumpLayer')) newNote();
        return;
      }
      switchView('chat');
      newChat();
    } else if (e.key === 'F11' && currentView === 'face') {
      e.preventDefault();
      isFullscreen() ? exitFullscreen() : enterFullscreen();
    } else if (e.key === 'F11') {
      e.preventDefault();
      toggleAppFullscreen();
    } else if (e.key === 'Escape' && state.playing) {
      // Muted like talking over it (chat.js barge-in), or the next sentence of a reply still being
      // written would speak again and the next Esc stop the voice once more instead of the reply.
      emit('barge-in');
      speaker.stop();
    } else if (e.key === 'Escape' && isFullscreen()) {
      exitFullscreen();
    } else if (e.key === 'Escape' && state.generating && !e.defaultPrevented && ['chat', 'face'].includes(currentView) && !dialogOpen()) {
      // The first Esc stops the voice (above), the next one the reply still being written.
      cancelReply();
    } else if (e.key === 'End' && !mod && !e.shiftKey && !e.defaultPrevented && currentView === 'chat' && !isTypingTarget(e.target)) {
      // The ↓ Latest button's key (the rail's own End moves along the rail instead).
      e.preventDefault();
      $('#scrollLatest').click();
    }
  });
}

// The face alone, full screen (layout.js does the window part).
function enterFullscreen() {
  if (currentView !== 'face') switchView('face');
  setFullscreen('face');
}

function exitFullscreen() {
  setFullscreen(null);
}

// ---------------------------------------------------------- status pills
// The words come from statuscore.js pillText: plain, "Click to fix." on a problem, never a raw error,
// address or product name (those are in Settings → Health).
function setPill(id, pill, status, detail) {
  const p = $(id);
  const { level, text, aria } = pillText(pill, status, detail);
  p.className = `pill ${level}`;
  p.title = text;
  // The light's name and its state, for screen readers (the light itself is only a colour); the visible
  // name stays first, so a voice user can still say it.
  p.setAttribute('aria-label', aria);
}

const STATUS_EVERY_MS = 5 * 60000;
let lastStatusAt = 0;
let voiceError = ''; // why the offline voice failed to load ('' once it loads); voice.js tries again a minute later

// The light of the offline voice (the main voice, running in the app).
function offlineVoicePill() {
  // voiceError and the device are in Settings → Health and the log; the light only says whether it works.
  setPill('#pillVoice', 'voice', voiceError ? 'failed' : 'ready');
}

// The brain's light: b is the current brain's catalogue entry (main/brains.js entry()).
function brainPill(s, b, routing) {
  if (b.id === 'auto') {
    const on_ = (routing || []).filter((p) => p.enabled && p.configured);
    const ready = on_.filter((p) => !p.resting);
    setPill('#pillLlm', 'brain', !ready.length ? 'unreachable' : ready.length < on_.length || ready.length === 1 ? 'partial' : 'ready');
  } else if (b.id === 'claude-code') {
    setPill('#pillLlm', 'brain', b.state === 'unchecked' ? 'unchecked' : b.state === 'missing' ? 'missing' : b.ready ? 'ready' : 'signedOut');
  } else if (b.id === 'anthropic') {
    setPill('#pillLlm', 'brain', b.ready ? 'ready' : 'noKey');
  } else {
    // A brain on the OpenAI path (FreeLLMAPI, or one multi-provider brain on its own, switched in the
    // chat, whose model is in its own section): ready when its server answers.
    api.llm
      .models()
      .then(() => setPill('#pillLlm', 'brain', ownEndpoint(b.id) && !b.model ? 'noModel' : 'ready'))
      .catch(() => setPill('#pillLlm', 'brain', 'unreachable')); // the error is in Settings → Health
  }
}

async function refreshStatus() {
  lastStatusAt = Date.now();
  const s = state.settings;
  // Brain: which one answers and whether it is ready, from the catalogue (main/brains.js).
  api.llm
    .brains()
    .then(({ current, routing }) => brainPill(s, current, routing))
    .catch(() => setPill('#pillLlm', 'brain', 'error')); // the error is in Settings → Health
  // The offline voice runs in the app, so there is no server to check: red only while it failed to load.
  if (s.voice.engine === 'local') {
    if (s.voice.ttsEnabled) offlineVoicePill();
    else setPill('#pillVoice', 'voice', 'off');
  } else if (s.voice.engine === 'cloud') {
    const openai = s.cloudVoice?.provider === 'openai';
    const keyed = openai ? Boolean(s.cloudVoice?.apiKey) : Boolean(s.groq?.apiKey);
    setPill('#pillVoice', 'voice', !s.voice.ttsEnabled ? 'off' : keyed ? 'ready' : 'noKey');
  } else api.tts
    .ping()
    .then((r) => setPill('#pillVoice', 'voice', !r.enabled ? 'off' : r.ok ? 'ready' : 'unreachable'))
    .catch(() => setPill('#pillVoice', 'voice', 'unreachable')); // the address and error are in Settings → Health
  api.calendar
    .status()
    .then((c) => setPill('#pillCal', 'calendar', !c.enabled ? 'off' : c.unreadable ? 'unreadable' : !c.connected ? 'needsNotes' : c.problems ? 'problems' : 'ready'))
    .catch(() => setPill('#pillCal', 'calendar', 'error')); // why is in Settings → Health
  api.obsidian
    .status()
    .then((o) => setPill('#pillKb', 'notes', !o.enabled ? 'off' : o.ok ? 'ready' : 'missing', { count: o.count }))
    .catch(() => setPill('#pillKb', 'notes', 'error')); // why is in Settings → Health
}

// Clicking a light jumps to its settings (wired in boot's status lights).
const pillTargets = { pillLlm: 'brain', pillVoice: 'voice', pillCal: 'calendar', pillKb: 'obsidian', pillUsage: 'brain' };

boot().then(() => api.app.ready(performance.now()).catch(() => {}), (err) => { // the main process only times the launch
  console.error(err);
  reportUiError('startup', err);
  const bar = el('div', { class: 'startup-error', role: 'alert' }, `Startup error: ${err.message}`);
  bar.append(el('button', { class: 'btn', onclick: () => location.reload() }, 'Reload'));
  document.body.append(bar);
});

emit('ready');
