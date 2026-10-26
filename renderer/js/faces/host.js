// Face host: shows the selected face in a container — a built-in canvas face, or a custom face from
// <userData>/faces/<name>/ in a sandboxed iframe fed with the agent state ~30×/s (see faces/core.js).
import { CircuitFace } from '../visualizer.js';
import { RadialFace } from './radial.js';
import { RainFace } from './rain.js';
import { NeuralFace } from './neural.js';
import { CompanionFace } from './companion.js';
import { SirenFace } from './siren.js';
import { state, setFlag, alertActive } from '../state.js';
import { on } from '../util.js';
import { DEFAULT_THEME } from '../themecore.js';
import { faceState, samples64, audio, theme } from './common.js';
import { configureFaces } from './env.js';
import { profile } from '../perfcore.js';

// On the desktop the faces read the app's state (the phone client wires its own, see faces/env.js).
configureFaces({
  agentState: () => state.agentState,
  alert: () => (alertActive() ? state.alert : null),
  theme: () => state.theme || DEFAULT_THEME,
  analyser: () => state.analyser,
  synthLevel: () => state.synthLevel,
  micLevel: () => state.micLevel,
  demo: () => state.demo,
  onTheme: (fn) => on('theme', fn),
  lite: () => profile(state.settings) === 'balanced',
});

export const BUILT_IN = [
  { id: 'siren', title: 'Siren', tagline: 'A sea-nymph who sings: fins spread, a lyre halo turns, song rings ripple with her voice', Face: SirenFace },
  { id: 'circuit', title: 'Circuit Board', tagline: 'Living PCB — pulses run the traces', Face: CircuitFace },
  { id: 'radial', title: 'Radial', tagline: 'Starburst bars around a particle orb', Face: RadialFace },
  { id: 'rain', title: 'Code Rain', tagline: 'Glyph rain; a face appears when it speaks', Face: RainFace },
  { id: 'neural', title: 'Neural Core', tagline: 'Constellation brain with live regions', Face: NeuralFace },
  { id: 'companion', title: 'Companion', tagline: 'A friendly character: eyes and smile show what it is doing', Face: CompanionFace },
];

export class FaceHost {
  constructor(container, { compact = false } = {}) {
    this.container = container;
    this.compact = compact;
    this.face = null;
    this.frame = null;
    this.id = '';
  }

  // Compact faces are drawn for a small panel; the chat's face layout shows the full-size version.
  setCompact(compact) {
    if (compact === this.compact) return;
    this.compact = compact;
    const { id, opts } = this;
    this.teardown();
    this.id = '';
    if (id) this.set(id, opts);
  }

  set(id, { avatar, name } = {}) {
    this.opts = { avatar, name };
    if (id === this.id && (this.face || this.frame)) {
      this.face?.setAvatar(avatar);
      this.face?.setLabel(name);
      return;
    }
    this.teardown();
    this.id = id;
    if (id?.startsWith('custom:')) {
      const folder = id.slice(7);
      const frame = document.createElement('iframe');
      frame.className = 'face-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = `faces://${encodeURIComponent(folder)}/index.html`;
      this.container.append(frame);
      this.frame = frame;
      this.pump = setInterval(() => this.post(name), 33);
      return;
    }
    const def = BUILT_IN.find((f) => f.id === id) || BUILT_IN[0];
    const canvas = document.createElement('canvas');
    canvas.className = 'face-canvas';
    this.container.append(canvas);
    this.face = new def.Face(canvas, { compact: this.compact });
    this.face.setAvatar(avatar);
    this.face.setLabel(name);
  }

  post(name) {
    // Skip while hidden (the chat-only layout hides the face panel).
    if (!this.frame?.contentWindow || !this.frame.offsetParent) return;
    const t = theme();
    this.frame.contentWindow.postMessage(
      {
        type: 'av',
        state: faceState(),
        level: audio().level,
        samples: samples64(),
        env: { name, colors: t.colors, states: t.face.states, alert: state.alert?.message || null },
      },
      '*',
    );
  }

  setAvatar(a) {
    this.face?.setAvatar(a);
  }

  setLabel(n) {
    this.face?.setLabel(n);
  }

  resize() {
    this.face?.resize();
  }

  teardown() {
    clearInterval(this.pump);
    this.face?.destroy?.();
    this.face = null;
    this.frame?.remove();
    this.frame = null;
    this.container.querySelectorAll('.face-canvas, .face-frame').forEach((n) => n.remove());
  }
}

// Scripted demo: idle → listening → thinking → speaking → idle, with a synthetic voice level.
export function runDemo() {
  if (state.demo) return;
  const steps = [
    ['idle', 1500],
    ['listening', 3000],
    ['thinking', 3000],
    ['working', 3000],
    ['speaking', 5000],
    ['happy', 2200],
    ['sleeping', 4500],
    ['idle', 1000],
  ];
  let i = 0;
  const start = performance.now();
  state.demo = { state: 'idle', level: 0 };
  const tick = setInterval(() => {
    const t = (performance.now() - start) / 1000;
    if (state.demo) state.demo.level = state.demo.state === 'speaking' ? 0.35 + 0.45 * Math.abs(Math.sin(t * 7)) * Math.abs(Math.sin(t * 1.3)) : state.demo.state === 'listening' ? 0.3 + 0.3 * Math.abs(Math.sin(t * 5)) : 0;
  }, 50);
  const next = () => {
    if (i >= steps.length) {
      clearInterval(tick);
      state.demo = null;
      setFlag('demo', null);
      return;
    }
    const [s, ms] = steps[i++];
    state.demo.state = s;
    setFlag('demo', state.demo);
    setTimeout(next, ms);
  };
  next();
}
