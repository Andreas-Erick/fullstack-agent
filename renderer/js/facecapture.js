// The watch's face (main/facecapture.js): this hidden page draws the active face, built-in or custom,
// in one agent state at a time, with a made-up voice level for speaking and listening. Main records it
// into short loops. No app state, no network: everything it needs comes from mount().
import { configureFaces } from './faces/env.js';
import { normalizeTheme } from './themecore.js';
import { faceState, samples64, audio } from './faces/common.js';

const BUILT_IN = {
  siren: ['./faces/siren.js', 'SirenFace'],
  circuit: ['./visualizer.js', 'CircuitFace'],
  radial: ['./faces/radial.js', 'RadialFace'],
  rain: ['./faces/rain.js', 'RainFace'],
  neural: ['./faces/neural.js', 'NeuralFace'],
  companion: ['./faces/companion.js', 'CompanionFace'],
};

let current = 'idle';
let theme = normalizeTheme({});
const start = performance.now();

// The same synthetic voice as the desktop's face demo (faces/host.js runDemo).
function level() {
  const t = (performance.now() - start) / 1000;
  if (current === 'speaking') return 0.35 + 0.45 * Math.abs(Math.sin(t * 7)) * Math.abs(Math.sin(t * 1.3));
  if (current === 'listening') return 0.3 + 0.3 * Math.abs(Math.sin(t * 5));
  return 0;
}

configureFaces({
  agentState: () => current,
  theme: () => theme,
  demo: () => ({ state: current, level: level() }),
});

window.__face = {
  // { face: 'siren' | 'custom:<folder>', theme, name, scene } → resolves once the face is drawing.
  async mount({ face, theme: t, name, scene }) {
    theme = normalizeTheme(t || {});
    document.body.style.background = theme.colors.bg;
    // The scene behind the face (appearance.scene, cleaned in main/scenecore.js and again here), dimmed
    // in the sleeping state through body[data-agent] (the page's CSS).
    const back = document.getElementById('scene');
    back.style.setProperty('--bg', theme.colors.bg);
    back.innerHTML = scene && window.DOMPurify ? window.DOMPurify.sanitize(String(scene), { USE_PROFILES: { svg: true }, FORBID_TAGS: ['style', 'foreignObject', 'image', 'use', 'a', 'script', 'filter', 'animate', 'animateTransform', 'animateMotion', 'set'], FORBID_ATTR: ['href', 'xlink:href', 'filter'] }) : '';
    const stage = document.getElementById('stage');
    if (String(face).startsWith('custom:')) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('scrolling', 'no'); // no scrollbars in the recording
      frame.src = `faces://${encodeURIComponent(face.slice(7))}/index.html`;
      await new Promise((resolve) => {
        frame.addEventListener('load', resolve, { once: true });
        stage.append(frame);
        setTimeout(resolve, 5000);
      });
      setInterval(() => frame.contentWindow?.postMessage({ type: 'av', state: faceState(), level: audio().level, samples: samples64(), env: { name, colors: theme.colors, states: theme.face.states, alert: null } }, '*'), 33);
      return true;
    }
    const [file, cls] = BUILT_IN[face] || BUILT_IN.siren;
    const Face = (await import(file))[cls];
    const canvas = document.createElement('canvas');
    stage.append(canvas);
    const f = new Face(canvas, { compact: false });
    f.setLabel(name);
    return true;
  },
  set(s) {
    current = s;
    document.body.dataset.agent = s;
  },
};
