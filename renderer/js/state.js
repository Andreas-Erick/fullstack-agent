// Shared app state: settings + the agent's visual state: idle / listening / thinking / working (running
// tools) / speaking, plus happy (a moment after a reply finished) and sleeping (no activity for a while).
import { api, emit } from './util.js';

export const state = {
  settings: null,
  agentState: 'sleeping', // asleep from the first frame (app.js init decides from ui.sleepOnLaunch)
  micLevel: 0, // 0..1 while listening
  analyser: null, // AnalyserNode for TTS output while speaking
  caption: '',
  captionRole: 'assistant',
  // Activity flags that determine the visual state.
  recording: false,
  transcribing: false,
  generating: false,
  streamingText: false,
  playing: false,
  toolsRunning: 0, // tool calls in progress
  happyUntil: 0, // brief "done" glow after a reply
  sleeping: true, // asleep at launch (ui.sleepOnLaunch), or dozed off after ui.sleepAfterMin without activity
  alert: null, // { message, until } — faces turn red while set
  demo: null, // { state, level } — scripted demo drives the faces
  approvalPending: null, // the approval request currently waiting for an answer
};

// Faces turn red and show ALERT for a few seconds when something fails.
export function raiseAlert(message, ms = 6000) {
  state.alert = { message, until: Date.now() + ms };
  emit('alert', state.alert);
  setTimeout(() => {
    if (state.alert && state.alert.until <= Date.now()) {
      state.alert = null;
      emit('alert', null);
    }
  }, ms + 50);
}

export const alertActive = () => Boolean(state.alert && state.alert.until > Date.now());

export async function loadSettings() {
  state.settings = await api.settings.get();
  emit('settings', state.settings);
  return state.settings;
}

export async function saveSettings(patch) {
  state.settings = await api.settings.set(patch);
  emit('settings', state.settings);
  return state.settings;
}

export function ttsActive() {
  const v = state.settings?.voice;
  return Boolean(v?.ttsEnabled && v?.autoSpeak);
}

// Derive the face state from what's going on right now.
export function refreshAgentState() {
  let s = 'idle';
  if (state.demo) s = state.demo.state;
  else if (state.recording) s = 'listening';
  else if (state.playing) s = 'speaking';
  else if (state.transcribing) s = 'thinking';
  else if (state.generating) s = state.toolsRunning > 0 ? 'working' : state.streamingText && !ttsActive() ? 'speaking' : 'thinking';
  else if (state.happyUntil > Date.now()) s = 'happy';
  else if (state.sleeping) s = 'sleeping';
  if (state.agentState === s) return;
  state.agentState = s;
  emit('agent-state', s);
}

export function setFlag(name, value) {
  state[name] = value;
  refreshAgentState();
}

// A short happy glow when a reply finished well.
export function celebrate(ms = 1800) {
  state.happyUntil = Date.now() + ms;
  refreshAgentState();
  setTimeout(refreshAgentState, ms + 30);
}

// Any activity wakes the face; it dozes off again after ui.sleepAfterMin quiet minutes.
let lastActivity = Date.now();
export function noteActivity() {
  lastActivity = Date.now();
  if (state.sleeping) setFlag('sleeping', false);
}
setInterval(() => {
  const min = Number(state.settings?.ui?.sleepAfterMin) || 0;
  const quiet = !state.recording && !state.playing && !state.generating && !state.transcribing && !state.demo;
  if (min > 0 && quiet && !state.sleeping && Date.now() - lastActivity > min * 60000) setFlag('sleeping', true);
}, 15000);

export function setCaption(text, role = 'assistant') {
  state.caption = text;
  state.captionRole = role;
  emit('caption', { text, role });
}
