// Shared app state: settings + the agent's visual state (idle / listening / thinking / speaking).
import { api, emit } from './util.js';

export const state = {
  settings: null,
  agentState: 'idle',
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
  else if (state.generating) s = state.streamingText && !ttsActive() ? 'speaking' : 'thinking';
  if (state.agentState === s) return;
  state.agentState = s;
  emit('agent-state', s);
}

export function setFlag(name, value) {
  state[name] = value;
  refreshAgentState();
}

export function setCaption(text, role = 'assistant') {
  state.caption = text;
  state.captionRole = role;
  emit('caption', { text, role });
}
