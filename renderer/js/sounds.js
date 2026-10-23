// Soft "processing" sound while the agent thinks, so pauses during tool use never feel like a dead
// line. Synthesized with WebAudio (no asset): a quiet two-tone shimmer that fades in and out.
import { ctx } from './voice.js';

let nodes = null;

export function startThinkingSound() {
  if (nodes) return;
  const ac = ctx();
  const out = ac.createGain();
  out.gain.value = 0;
  out.gain.linearRampToValueAtTime(0.035, ac.currentTime + 0.6);
  out.connect(ac.destination);
  const lfo = ac.createOscillator();
  const lfoGain = ac.createGain();
  lfo.frequency.value = 0.6;
  lfoGain.gain.value = 0.02;
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
  nodes = { out, lfo, tones };
}

export function stopThinkingSound() {
  if (!nodes) return;
  const { out, lfo, tones } = nodes;
  nodes = null;
  const ac = ctx();
  out.gain.cancelScheduledValues(ac.currentTime);
  out.gain.setValueAtTime(out.gain.value, ac.currentTime);
  out.gain.linearRampToValueAtTime(0, ac.currentTime + 0.25);
  setTimeout(() => {
    [lfo, ...tones].forEach((o) => o.stop());
    out.disconnect();
  }, 300);
}
