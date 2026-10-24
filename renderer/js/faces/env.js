// What the faces read from the app around them, and nothing else: the agent state, an alert, the
// theme, the audio sources and theme changes. The desktop wires it to state.js (faces/host.js); the
// phone client (renderer/remote/app.js) to its own state. Keeping the faces behind this one seam is
// what lets both apps draw the very same faces.
import { DEFAULT_THEME } from '../themecore.js';

export const env = {
  agentState: () => 'idle', // idle | listening | thinking | working | speaking | happy | sleeping
  alert: () => null, // { message } while an alert is active, else null
  theme: () => DEFAULT_THEME, // a normalized theme (themecore.normalizeTheme)
  analyser: () => null, // AnalyserNode of the voice being played, if any
  synthLevel: () => 0, // 0..1 level of a voice without an analyser (system voice fallback)
  micLevel: () => 0, // 0..1 microphone level while listening
  demo: () => null, // { state, level } during the scripted demo
  onTheme: () => () => {}, // onTheme(fn) → unsubscribe; fn runs when the theme changes
};

export function configureFaces(parts) {
  Object.assign(env, parts);
}
