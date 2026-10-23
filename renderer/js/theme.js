// Theme engine: turns a theme object (generated from the persona's aesthetic, or edited by hand)
// into CSS variables, fonts, a background pattern and the face's palette/shape.
import { state } from './state.js';
import { emit } from './util.js';

// Fonts bundled with the app (via @fontsource) that a theme may choose from.
export const FONTS = {
  Orbitron: { pkg: 'orbitron', weights: [500, 700], fallback: 'sans-serif' },
  'Exo 2': { pkg: 'exo-2', weights: [400, 600], fallback: 'sans-serif' },
  Rajdhani: { pkg: 'rajdhani', weights: [500, 700], fallback: 'sans-serif' },
  Audiowide: { pkg: 'audiowide', weights: [400], fallback: 'sans-serif' },
  'Space Grotesk': { pkg: 'space-grotesk', weights: [400, 600], fallback: 'sans-serif' },
  Inter: { pkg: 'inter', weights: [400, 600], fallback: 'sans-serif' },
  Montserrat: { pkg: 'montserrat', weights: [400, 600], fallback: 'sans-serif' },
  Nunito: { pkg: 'nunito', weights: [400, 700], fallback: 'sans-serif' },
  Quicksand: { pkg: 'quicksand', weights: [400, 600], fallback: 'sans-serif' },
  Syne: { pkg: 'syne', weights: [400, 700], fallback: 'sans-serif' },
  'Playfair Display': { pkg: 'playfair-display', weights: [400, 700], fallback: 'serif' },
  'Cormorant Garamond': { pkg: 'cormorant-garamond', weights: [500, 700], fallback: 'serif' },
  Lora: { pkg: 'lora', weights: [400, 600], fallback: 'serif' },
  Cinzel: { pkg: 'cinzel', weights: [500, 700], fallback: 'serif' },
  'JetBrains Mono': { pkg: 'jetbrains-mono', weights: [400, 600], fallback: 'monospace' },
  VT323: { pkg: 'vt323', weights: [400], fallback: 'monospace' },
  'Press Start 2P': { pkg: 'press-start-2p', weights: [400], fallback: 'monospace' },
  Caveat: { pkg: 'caveat', weights: [400, 700], fallback: 'cursive' },
};

export const PATTERNS = ['circuit', 'grid', 'dots', 'hex', 'waves', 'stars', 'none'];
export const CORE_SHAPES = ['octagon', 'circle', 'hexagon', 'diamond', 'triangle'];
export const TRACE_STYLES = ['circuit', 'organic', 'radial', 'constellation'];

export const DEFAULT_THEME = {
  name: 'Neon Circuit',
  mode: 'dark',
  colors: {
    bg: '#0a0a0f',
    bg2: '#0d1017',
    bg3: '#121725',
    surface: '#0e1626',
    text: '#d9f4ff',
    text2: '#a9c3d6',
    muted: '#6f839b',
    accent: '#00e5ff',
    accent2: '#2f7bff',
    accent3: '#8b5cf6',
    success: '#22f5a5',
    warning: '#ffb547',
    danger: '#ff4d6d',
  },
  fonts: { display: 'Orbitron', body: 'Exo 2' },
  uppercaseDisplay: true,
  radius: 14,
  glass: { blur: 16, opacity: 0.55 },
  background: { pattern: 'circuit', intensity: 0.5 },
  face: {
    core: 'octagon',
    traces: 'circuit',
    density: 1,
    glow: 0.7,
    states: {
      idle: ['#00e5ff', '#2f7bff'],
      listening: ['#22f5a5', '#00e5ff'],
      thinking: ['#8b5cf6', '#2f7bff'],
      speaking: ['#00e5ff', '#7df9ff'],
    },
  },
};

// ------------------------------------------------------------- color utils
export function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const triplet = (hex) => hexToRgb(hex).join(', ');
const mix = (a, b, t) => {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
};
export const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// Fill gaps and clamp values so a partially specified / LLM-generated theme is always usable.
export function normalizeTheme(t) {
  const d = DEFAULT_THEME;
  const out = JSON.parse(JSON.stringify(d));
  if (!t || typeof t !== 'object') return out;
  out.name = String(t.name || d.name).slice(0, 60);
  const isHex = (v) => typeof v === 'string' && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v.trim());
  const hex = (v) => (v.trim().startsWith('#') ? v.trim() : `#${v.trim()}`);
  for (const k of Object.keys(d.colors)) if (isHex(t.colors?.[k])) out.colors[k] = hex(t.colors[k]);
  out.mode = luminance(out.colors.bg) > 0.4 ? 'light' : 'dark';
  if (FONTS[t.fonts?.display]) out.fonts.display = t.fonts.display;
  if (FONTS[t.fonts?.body]) out.fonts.body = t.fonts.body;
  if (typeof t.uppercaseDisplay === 'boolean') out.uppercaseDisplay = t.uppercaseDisplay;
  if (Number.isFinite(+t.radius)) out.radius = Math.max(0, Math.min(28, +t.radius));
  if (Number.isFinite(+t.glass?.blur)) out.glass.blur = Math.max(0, Math.min(40, +t.glass.blur));
  if (Number.isFinite(+t.glass?.opacity)) out.glass.opacity = Math.max(0.15, Math.min(0.97, +t.glass.opacity));
  if (PATTERNS.includes(t.background?.pattern)) out.background.pattern = t.background.pattern;
  if (Number.isFinite(+t.background?.intensity)) out.background.intensity = Math.max(0, Math.min(1, +t.background.intensity));
  const f = t.face || {};
  if (CORE_SHAPES.includes(f.core)) out.face.core = f.core;
  if (TRACE_STYLES.includes(f.traces)) out.face.traces = f.traces;
  if (Number.isFinite(+f.density)) out.face.density = Math.max(0.3, Math.min(1.6, +f.density));
  if (Number.isFinite(+f.glow)) out.face.glow = Math.max(0, Math.min(1, +f.glow));
  // Face state colors: derived from the palette, then overridden by any the theme specifies.
  const c = out.colors;
  out.face.states = { idle: [c.accent, c.accent2], listening: [c.success, c.accent], thinking: [c.accent3, c.accent2], speaking: [c.accent, mix(c.accent, '#ffffff', 0.45)] };
  for (const s of Object.keys(out.face.states)) {
    const pair = f.states?.[s];
    if (Array.isArray(pair) && isHex(pair[0])) out.face.states[s] = [hex(pair[0]), isHex(pair[1]) ? hex(pair[1]) : hex(pair[0])];
  }
  if (t.voice) out.voice = String(t.voice);
  if (t.toneNotes) out.toneNotes = String(t.toneNotes).slice(0, 600);
  if (t.greeting) out.greeting = String(t.greeting).slice(0, 120);
  return out;
}

// ----------------------------------------------------------------- fonts
const loadedFonts = new Set();
function loadFont(name) {
  const f = FONTS[name];
  if (!f || loadedFonts.has(name)) return;
  loadedFonts.add(name);
  for (const w of f.weights) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `app://bundle/node_modules/@fontsource/${f.pkg}/${w}.css`;
    document.head.append(link);
  }
}
const fontStack = (name) => `"${name}", ${FONTS[name]?.fallback || 'sans-serif'}`;

// ---------------------------------------------------------- bg patterns
function patternUrl(kind, color, intensity) {
  const c = encodeURIComponent(color);
  const a = (0.04 + intensity * 0.1).toFixed(3);
  const b = (0.06 + intensity * 0.14).toFixed(3);
  let svg;
  switch (kind) {
    case 'circuit':
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><g fill='none' stroke='${c}' stroke-opacity='${a}'><path d='M0 40h40l20 20h40M100 60l20-20h40M20 160v-40l20-20V60M80 0v30l10 10M120 160v-30l20-20h20M60 100h30l20 20v40'/></g><g fill='${c}' fill-opacity='${b}'><circle cx='40' cy='40' r='2'/><circle cx='100' cy='60' r='2'/><circle cx='40' cy='100' r='2'/><circle cx='90' cy='40' r='2'/><circle cx='140' cy='110' r='2'/><circle cx='110' cy='120' r='2'/></g></svg>`;
      break;
    case 'grid':
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><path d='M48 0H0V48' fill='none' stroke='${c}' stroke-opacity='${a}'/></svg>`;
      break;
    case 'dots':
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='26' height='26'><circle cx='13' cy='13' r='1.3' fill='${c}' fill-opacity='${b}'/></svg>`;
      break;
    case 'hex':
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='56' height='97'><path d='M28 0l28 16v32L28 64 0 48V16zM28 64v33' fill='none' stroke='${c}' stroke-opacity='${a}'/></svg>`;
      break;
    case 'waves':
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='40'><path d='M0 20q30-20 60 0t60 0' fill='none' stroke='${c}' stroke-opacity='${a}'/></svg>`;
      break;
    case 'stars':
      svg = `<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><g fill='${c}' fill-opacity='${b}'><circle cx='20' cy='30' r='1'/><circle cx='90' cy='12' r='1.4'/><circle cx='150' cy='60' r='0.9'/><circle cx='60' cy='100' r='1.2'/><circle cx='130' cy='140' r='1'/><circle cx='30' cy='160' r='1.5'/><circle cx='170' cy='170' r='0.8'/></g></svg>`;
      break;
    default:
      return 'none';
  }
  return `url("data:image/svg+xml,${svg.replace(/"/g, "'").replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}")`;
}

// ----------------------------------------------------------------- apply
export function applyTheme(raw) {
  const t = normalizeTheme(raw);
  const c = t.colors;
  const root = document.documentElement.style;
  const set = (k, v) => root.setProperty(k, v);
  set('--bg', c.bg);
  set('--bg-rgb', triplet(c.bg));
  set('--bg-2', c.bg2);
  set('--bg-3', c.bg3);
  set('--surface', triplet(c.surface));
  set('--well', triplet(t.mode === 'light' ? mix(c.bg, '#ffffff', 0.6) : mix(c.bg, '#000000', 0.4)));
  set('--shadow', t.mode === 'light' ? '60, 60, 80' : '0, 0, 0');
  set('--c1', triplet(c.accent));
  set('--c1-soft', triplet(mix(c.accent, t.mode === 'light' ? '#000000' : '#ffffff', 0.35)));
  set('--c2', triplet(c.accent2));
  set('--c2-soft', triplet(mix(c.accent2, t.mode === 'light' ? '#000000' : '#ffffff', 0.4)));
  set('--c3', triplet(c.accent3));
  set('--ok', triplet(c.success));
  set('--warn', triplet(c.warning));
  set('--err', triplet(c.danger));
  set('--text', c.text);
  set('--text-rgb', triplet(c.text));
  set('--text-2', c.text2);
  set('--muted', c.muted);
  set('--radius', `${t.radius}px`);
  set('--blur', `${t.glass.blur}px`);
  set('--glass-alpha', String(t.glass.opacity));
  set('--display-transform', t.uppercaseDisplay ? 'uppercase' : 'none');
  set('--display-spacing', t.uppercaseDisplay ? '0.08em' : '0.01em');
  set('--bg-pattern', patternUrl(t.background.pattern, c.accent, t.background.intensity));
  root.colorScheme = t.mode;
  loadFont(t.fonts.display);
  loadFont(t.fonts.body);
  set('--font-display', fontStack(t.fonts.display));
  set('--font-body', fontStack(t.fonts.body));
  state.theme = t;
  emit('theme', t);
  return t;
}

// --------------------------------------------- palette from the agent image
export function extractPalette(dataUrl, count = 6) {
  return new Promise((resolve) => {
    if (!dataUrl) return resolve([]);
    const img = new Image();
    img.onload = () => {
      const size = 64;
      const cv = document.createElement('canvas');
      cv.width = cv.height = size;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, size, size);
      const data = g.getImageData(0, 0, size, size).data;
      const buckets = new Map();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        const b = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        b.n++;
        b.r += data[i];
        b.g += data[i + 1];
        b.b += data[i + 2];
        buckets.set(key, b);
      }
      const sorted = [...buckets.values()].sort((a, b) => b.n - a.n).map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
      const picked = [];
      for (const col of sorted) {
        if (picked.every((p) => Math.hypot(p[0] - col[0], p[1] - col[1], p[2] - col[2]) > 60)) picked.push(col);
        if (picked.length >= count) break;
      }
      resolve(picked.map((p) => rgbToHex(...p)));
    };
    img.onerror = () => resolve([]);
    img.src = dataUrl;
  });
}
