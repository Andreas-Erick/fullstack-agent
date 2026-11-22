// What the voice modules share: the one AudioContext (playback, the face's analyser, the microphone's
// worklets) and the clock and profile the model hosts (modelhost.js) run on.
import { state } from './state.js';
import { profile } from './perfcore.js';

let audioCtx = null;
export function ctx() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    state.analyser = audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.analyser.smoothingTimeConstant = 0.75;
    state.analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// The clock the model hosts run on (modelhost.js takes it injected, for the tests).
export const timers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };
export const byProfile = () => profile(state.settings);
