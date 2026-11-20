// The pure part of the theme engine: the default theme, color math and normalizeTheme(). No DOM, no
// app state, no imports, so the faces can use it on the desktop and in the phone client alike.
// theme.js builds on it (CSS variables, fonts, background patterns) and re-exports all of it.

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
      working: ['#8b5cf6', '#00e5ff'],
      happy: ['#22f5a5', '#9cfbd6'],
      sleeping: ['#0b5f6e', '#1d3a70'],
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
export const triplet = (hex) => hexToRgb(hex).join(', ');
export const mix = (a, b, t) => {
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
// WCAG contrast ratio of two colors (1 to 21).
export const contrast = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// ------------------------------------------------------- contrast guard
// A generated or hand-edited palette may put grey text on a grey card. normalizeTheme keeps every theme
// readable: the backgrounds stay on one side (dark ones dark enough for light text, light ones light
// enough for dark text), then each ink is nudged toward white or black until it clears its minimum
// against every background. Colors that already pass are kept exactly, so the shipped palettes don't move.
export const CONTRAST = {
  text: 7, // body text: WCAG AAA
  text2: 7,
  muted: 4.5, // hints: WCAG AA
  accent: 3, // glows, borders, chips, status colors: WCAG non-text 3:1
  accent2: 3,
  accent3: 3,
  success: 3,
  warning: 3,
  danger: 3,
};
const DARK_MAX = 0.09; // a dark background's highest luminance: white text still reaches 7.5:1
const LIGHT_MIN = 0.325; // a light surface's lowest luminance: black text still reaches 7.5:1
const LIGHT_BG = 0.42; // a page background lifted into light mode lands here (mode is light above 0.4)
const SURFACES = ['bg', 'bg2', 'bg3', 'surface'];
// Glass is the surface over a background at these alphas besides the theme's own (styles.css: --glass-strong,
// and the opaque panels of the Balanced profile). Mixed in sRGB, a glass can be darker than both colors it
// mixes, so the guard measures it too.
export const GLASS_ALPHAS = [0.85, 0.96, 0.97];

// The smallest step of mix(hex, toward, t) that passes `ok` (which holds at t = 1); hex itself if it passes.
function nudge(hex, toward, ok) {
  if (ok(hex)) return hex;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    if (ok(mix(hex, toward, t))) hi = t;
    else lo = t;
  }
  const out = mix(hex, toward, hi);
  return ok(out) ? out : toward;
}

// The palette made readable (see above), for glass at `opacity`. Returns the colors and their mode.
export function guardContrast(colors, { opacity = DEFAULT_THEME.glass.opacity } = {}) {
  const c = { ...colors };
  const alphas = [opacity, ...GLASS_ALPHAS];
  const glasses = (surface) => [c.bg, c.bg2, c.bg3].flatMap((under) => alphas.map((a) => mix(under, surface, a)));
  const L = luminance(c.bg);
  // The page background: a mid tone goes to whichever side is nearer.
  if (L > DARK_MAX && L <= 0.4) {
    c.bg = L - DARK_MAX <= LIGHT_BG - L ? nudge(c.bg, '#000000', (h) => luminance(h) <= DARK_MAX) : nudge(c.bg, '#ffffff', (h) => luminance(h) >= LIGHT_BG);
  }
  const mode = luminance(c.bg) > 0.4 ? 'light' : 'dark';
  const dark = mode === 'dark';
  const ink = dark ? '#ffffff' : '#000000';
  const fits = dark ? (h) => luminance(h) <= DARK_MAX : (h) => luminance(h) >= LIGHT_MIN;
  for (const k of ['bg2', 'bg3']) c[k] = nudge(c[k], dark ? '#000000' : '#ffffff', fits);
  // The surface, alone and as glass over each background (moving it toward the ink's opposite moves
  // every glass the same way, so the search stays monotone).
  c.surface = nudge(c.surface, dark ? '#000000' : '#ffffff', (h) => fits(h) && glasses(h).every(fits));
  const grounds = [...SURFACES.map((k) => c[k]), ...glasses(c.surface)];
  for (const [k, min] of Object.entries(CONTRAST)) {
    c[k] = nudge(c[k], ink, (h) => grounds.every((g) => contrast(h, g) >= min));
  }
  return { colors: c, mode };
}

// Fill gaps and clamp values so a partially specified / LLM-generated theme is always usable.
export function normalizeTheme(t) {
  const d = DEFAULT_THEME;
  const out = JSON.parse(JSON.stringify(d));
  if (!t || typeof t !== 'object') return out;
  out.name = String(t.name || d.name).slice(0, 60);
  const isHex = (v) => typeof v === 'string' && /^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v.trim());
  const hex = (v) => (v.trim().startsWith('#') ? v.trim() : `#${v.trim()}`);
  for (const k of Object.keys(d.colors)) if (isHex(t.colors?.[k])) out.colors[k] = hex(t.colors[k]);
  if (FONTS[t.fonts?.display]) out.fonts.display = t.fonts.display;
  if (FONTS[t.fonts?.body]) out.fonts.body = t.fonts.body;
  if (typeof t.uppercaseDisplay === 'boolean') out.uppercaseDisplay = t.uppercaseDisplay;
  if (Number.isFinite(+t.radius)) out.radius = Math.max(0, Math.min(28, +t.radius));
  if (Number.isFinite(+t.glass?.blur)) out.glass.blur = Math.max(0, Math.min(40, +t.glass.blur));
  if (Number.isFinite(+t.glass?.opacity)) out.glass.opacity = Math.max(0.15, Math.min(0.97, +t.glass.opacity));
  const guarded = guardContrast(out.colors, { opacity: out.glass.opacity });
  out.colors = guarded.colors;
  out.mode = guarded.mode;
  if (PATTERNS.includes(t.background?.pattern)) out.background.pattern = t.background.pattern;
  if (Number.isFinite(+t.background?.intensity)) out.background.intensity = Math.max(0, Math.min(1, +t.background.intensity));
  const f = t.face || {};
  if (CORE_SHAPES.includes(f.core)) out.face.core = f.core;
  if (TRACE_STYLES.includes(f.traces)) out.face.traces = f.traces;
  if (Number.isFinite(+f.density)) out.face.density = Math.max(0.3, Math.min(1.6, +f.density));
  if (Number.isFinite(+f.glow)) out.face.glow = Math.max(0, Math.min(1, +f.glow));
  // Face state colors: derived from the palette, then overridden by any the theme specifies.
  const c = out.colors;
  out.face.states = {
    idle: [c.accent, c.accent2],
    listening: [c.success, c.accent],
    thinking: [c.accent3, c.accent2],
    speaking: [c.accent, mix(c.accent, '#ffffff', 0.45)],
    working: [c.accent3, c.accent], // running tools
    happy: [c.success, mix(c.success, '#ffffff', 0.5)], // a reply just finished
    sleeping: [mix(c.accent, c.bg, 0.55), mix(c.accent2, c.bg, 0.6)], // no activity for a while
  };
  for (const s of Object.keys(out.face.states)) {
    const pair = f.states?.[s];
    if (Array.isArray(pair) && isHex(pair[0])) out.face.states[s] = [hex(pair[0]), isHex(pair[1]) ? hex(pair[1]) : hex(pair[0])];
  }
  if (t.voice) out.voice = String(t.voice);
  if (t.toneNotes) out.toneNotes = String(t.toneNotes).slice(0, 600);
  if (t.greeting) out.greeting = String(t.greeting).slice(0, 120);
  return out;
}
