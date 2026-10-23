// Optional sound while the agent thinks, so long pauses during tool use never feel like a dead line.
// Synthesized with WebAudio (no assets). It waits a moment before starting, so quick replies stay
// silent. Styles: "grandfather" (a slow, deep tick-tock), "clock" (a lighter mechanical clock),
// "soft" (a low, slowly breathing pad), "classic" (the original shimmer), "off".
import { ctx } from './voice.js';

const DELAY_MS = 1500;
let nodes = null;
let pending = null;

// Old settings stored a boolean.
export function thinkingStyle(value) {
  if (value === true) return 'grandfather';
  if (value === false || value == null) return 'off';
  if (value === 'tick') return 'clock';
  return value;
}

export function startThinkingSound(style = 'grandfather', volume = 0.5) {
  if (nodes || pending || style === 'off') return;
  pending = setTimeout(() => {
    pending = null;
    const build = STYLES[style] || STYLES.grandfather;
    nodes = build(ctx(), Math.min(1, Math.max(0, Number(volume) || 0)));
  }, DELAY_MS);
}

export function stopThinkingSound() {
  clearTimeout(pending);
  pending = null;
  if (!nodes) return;
  const { out, stop } = nodes;
  nodes = null;
  const ac = ctx();
  out.gain.cancelScheduledValues(ac.currentTime);
  out.gain.setValueAtTime(out.gain.value, ac.currentTime);
  out.gain.linearRampToValueAtTime(0, ac.currentTime + 0.4);
  setTimeout(() => {
    stop();
    out.disconnect();
  }, 450);
}

// Plays a few seconds of a style, for choosing one in Settings.
export function previewThinkingSound(style, volume) {
  stopThinkingSound();
  if (style === 'off') return;
  nodes = (STYLES[style] || STYLES.grandfather)(ctx(), Math.min(1, Math.max(0, Number(volume) || 0)));
  setTimeout(stopThinkingSound, 4000);
}

// A mechanical tick: a metallic escapement click (noise through a narrow band around `click` Hz)
// plus a woody thunk (noise around `body` Hz), ringing briefly in the case (a short filtered
// echo). Beats alternate tick / tock, the tock a little lower and softer. Scheduled slightly ahead
// on the audio clock so the rhythm stays even.
let noiseBuffer = null;
function noise(ac) {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ac.sampleRate) {
    noiseBuffer = ac.createBuffer(1, ac.sampleRate * 0.25, ac.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

function clockwork(ac, volume, { period, click, body, decay, room, level }) {
  const out = output(ac, level * volume, 0.01);
  // The case: a short echo with feedback, darkened by a lowpass.
  const echo = ac.createDelay(0.2);
  echo.delayTime.value = room;
  const feedback = ac.createGain();
  feedback.gain.value = 0.38;
  const dark = ac.createBiquadFilter();
  dark.type = 'lowpass';
  dark.frequency.value = 1800;
  echo.connect(dark).connect(feedback).connect(echo);
  dark.connect(out);

  const burst = (t, freq, q, gain, length) => {
    const src = ac.createBufferSource();
    src.buffer = noise(ac);
    const band = ac.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = freq;
    band.Q.value = q;
    const env = ac.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    env.gain.exponentialRampToValueAtTime(0.0001, t + length);
    src.connect(band).connect(env);
    env.connect(out);
    env.connect(echo);
    src.start(t, Math.random() * 0.1);
    src.stop(t + length + 0.02);
  };

  let beat = 0;
  let next = ac.currentTime + 0.05;
  const schedule = () => {
    while (next < ac.currentTime + 0.3) {
      const tock = beat++ % 2 === 1;
      const pitch = tock ? 0.84 : 1;
      burst(next, click * pitch, 6, tock ? 0.8 : 1, 0.018);
      burst(next + 0.004, body * pitch, 2.5, tock ? 0.55 : 0.7, decay);
      next += period;
    }
  };
  schedule();
  const timer = setInterval(schedule, 100);
  return {
    out,
    stop: () => {
      clearInterval(timer);
      echo.disconnect();
      dark.disconnect();
    },
  };
}

function output(ac, level, fadeIn) {
  const out = ac.createGain();
  out.gain.value = 0;
  out.gain.linearRampToValueAtTime(level, ac.currentTime + fadeIn);
  out.connect(ac.destination);
  return out;
}

const STYLES = {
  // Two low tones (A3 + E4) through a lowpass, swelling in and out about every 7 seconds.
  soft(ac, volume) {
    const level = 0.03 * volume;
    const out = output(ac, level * 0.5, 1.5);
    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.connect(out);
    const swell = ac.createOscillator();
    const depth = ac.createGain();
    swell.frequency.value = 0.14;
    depth.gain.value = level * 0.5;
    swell.connect(depth).connect(out.gain);
    const tones = [220, 329.63].map((f, i) => {
      const o = ac.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      o.detune.value = i ? 4 : -4;
      o.connect(filter);
      o.start();
      return o;
    });
    swell.start();
    return { out, stop: () => [swell, ...tones].forEach((o) => o.stop()) };
  },

  // A grandfather clock: one slow, deep tick-tock per second with a wooden case ringing behind it.
  grandfather(ac, volume) {
    return clockwork(ac, volume, { period: 1.0, click: 2600, body: 190, decay: 0.09, room: 0.045, level: 0.22 });
  },

  // A mechanical mantel/desk clock: faster, lighter, drier.
  clock(ac, volume) {
    return clockwork(ac, volume, { period: 0.5, click: 3800, body: 420, decay: 0.035, room: 0.018, level: 0.14 });
  },

  // The original two-tone shimmer (C5 + G5).
  classic(ac, volume) {
    const level = 0.07 * volume;
    const out = output(ac, level, 0.6);
    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    lfo.frequency.value = 0.6;
    lfoGain.gain.value = level * 0.57;
    lfo.connect(lfoGain).connect(out.gain);
    const tones = [523.25, 783.99].map((f, i) => {
      const o = ac.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.detune.value = i ? 6 : -6;
      o.connect(out);
      o.start();
      return o;
    });
    lfo.start();
    return { out, stop: () => [lfo, ...tones].forEach((o) => o.stop()) };
  },
};
