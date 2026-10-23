// Shared helpers for all faces: theme palette per state (with the red alert override) and the
// current audio level (TTS analyser, system-voice fallback, microphone, or the scripted demo).
import { state, alertActive } from '../state.js';
import { DEFAULT_THEME, hexToRgb } from '../theme.js';

export const MOTION = {
  idle: { energy: 0.25, spin: 0.15 },
  listening: { energy: 0.6, spin: 0.35 },
  thinking: { energy: 0.85, spin: 2.2 },
  speaking: { energy: 1, spin: 0.6 },
};
const ALERT = { main: [255, 59, 79], accent: [255, 140, 120], energy: 0.9, spin: 1.2 };

export const theme = () => state.theme || DEFAULT_THEME;
export const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
export const lerp = (a, b, t) => a + (b - a) * t;
export const lerpColor = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

export function faceState() {
  return alertActive() ? 'alert' : state.agentState;
}

export function paletteFor(st) {
  if (st === 'alert') return ALERT;
  const pair = theme().face.states[st] || theme().face.states.idle;
  return { main: hexToRgb(pair[0]), accent: hexToRgb(pair[1]), ...(MOTION[st] || MOTION.idle) };
}

let freq = null;
let wave = null;
// { level 0..1, freq Uint8Array|null, wave Float32Array(64)|null }
export function audio() {
  const st = state.agentState;
  if (state.demo) return { level: state.demo.level || 0, freq: null, wave: null };
  if (st === 'speaking' && state.analyser && !state.synthLevel) {
    const a = state.analyser;
    if (!freq || freq.length !== a.frequencyBinCount) freq = new Uint8Array(a.frequencyBinCount);
    if (!wave || wave.length !== a.fftSize) wave = new Float32Array(a.fftSize);
    a.getByteFrequencyData(freq);
    a.getFloatTimeDomainData(wave);
    let sum = 0;
    const n = Math.min(freq.length, 96);
    for (let i = 2; i < n; i++) sum += freq[i];
    return { level: Math.min(1, sum / (n - 2) / 140), freq, wave };
  }
  if (st === 'speaking' && state.synthLevel) return { level: state.synthLevel, freq: null, wave: null };
  if (st === 'listening') return { level: Math.min(1, state.micLevel * 1.6), freq: null, wave: null };
  return { level: 0, freq: null, wave: null };
}

// 64 samples of the current waveform (for custom faces).
export function samples64() {
  const { wave, level } = audio();
  const out = new Array(64);
  for (let i = 0; i < 64; i++) out[i] = wave ? wave[Math.floor((i / 64) * wave.length)] : Math.sin(i / 4 + performance.now() / 120) * level * 0.5;
  return out;
}

// Base class: canvas sizing, rAF loop (paused when hidden), theme regeneration, teardown.
export class BaseFace {
  constructor(canvas, { compact = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.compact = compact;
    this.t = 0;
    this.last = performance.now();
    this.label = 'N';
    this.avatar = null;
    this.alive = true;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.frame = this.frame.bind(this);
    requestAnimationFrame(() => {
      this.resize();
      requestAnimationFrame(this.frame);
    });
  }

  setAvatar(dataUrl) {
    if (!dataUrl) return void (this.avatar = null);
    const img = new Image();
    img.onload = () => (this.avatar = img);
    img.src = dataUrl;
  }

  setLabel(name) {
    this.name = name || 'Nexus';
    this.label = (name || 'N').trim().charAt(0).toUpperCase() || 'N';
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.layout?.();
  }

  frame(now) {
    if (!this.alive) return;
    requestAnimationFrame(this.frame);
    if (!this.canvas.offsetParent || !this.w) {
      this.last = now;
      return;
    }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.draw(dt);
  }

  destroy() {
    this.alive = false;
    this.ro.disconnect();
    this.off?.();
  }
}
