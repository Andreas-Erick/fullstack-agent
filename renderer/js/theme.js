// Theme engine: turns a theme object (generated from the persona's aesthetic, or edited by hand)
// into CSS variables, fonts, a background pattern and the face's palette/shape.
import { state } from './state.js';
import { emit } from './util.js';
import { FONTS, PATTERNS, CORE_SHAPES, TRACE_STYLES, DEFAULT_THEME, hexToRgb, rgbToHex, triplet, mix, luminance, normalizeTheme } from './themecore.js';

// The pure part (default theme, color math, normalizeTheme) lives in themecore.js, shared with the faces
// and the phone client; re-exported so existing imports keep working.
export { FONTS, PATTERNS, CORE_SHAPES, TRACE_STYLES, DEFAULT_THEME, hexToRgb, rgbToHex, luminance, normalizeTheme };

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
