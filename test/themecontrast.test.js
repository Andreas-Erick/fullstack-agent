// The theme engine's contrast guard (themecore.js guardContrast, run by normalizeTheme): whatever palette
// a model or the user makes, text stays readable on every background and glass surface, the shipped
// palettes don't move, and normalizing twice changes nothing. A seeded property test over random palettes:
// a failure prints its seed; re-run it with THEME_SEED=<seed>.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir, load } = require('./helpers');

// themecore.js is an ES module in a CommonJS package: test a copy in a folder of type module.
const ESM = tmpDir('nexus-themecore-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, 'renderer/js/themecore.js'), path.join(ESM, 'themecore.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const core = () => import(pathToFileURL(path.join(ESM, 'themecore.js')).href);

const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
const INKS = { text: 7, text2: 7, muted: 4.5, accent: 3, accent2: 3, accent3: 3, success: 3, warning: 3, danger: 3 };

// Small seeded generator (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['bg', 'bg2', 'bg3', 'surface', 'text', 'text2', 'muted', 'accent', 'accent2', 'accent3', 'success', 'warning', 'danger'];
const EXTREMES = ['#000000', '#ffffff', '#808080', '#777777', '#7f7f7f', '#000', '#FFF', 'abc', '#ff0000', '#0000ff', '#ffff00'];

function randomPalette(r) {
  const hex6 = () => '#' + Math.floor(r() * 0x1000000).toString(16).padStart(6, '0');
  const pick = () => {
    const x = r();
    if (x < 0.15) return EXTREMES[Math.floor(r() * EXTREMES.length)];
    if (x < 0.22) return '#' + Math.floor(r() * 0x1000).toString(16).padStart(3, '0').toUpperCase();
    return hex6();
  };
  const kind = r();
  const colors = {};
  if (kind < 0.1) {
    // One color everywhere (the worst case: text the same as its background).
    const one = pick();
    for (const k of KEYS) colors[k] = one;
  } else {
    for (const k of KEYS) if (r() > 0.15) colors[k] = pick(); // some missing: the defaults fill in
  }
  const theme = { colors };
  if (r() < 0.5) theme.glass = { opacity: 0.15 + r() * 0.82 };
  return theme;
}

function checkTheme(c, out, label) {
  for (const k of KEYS) assert.match(out.colors[k], HEX, `${label}: ${k} is not a hex color (${out.colors[k]})`);
  const L = c.luminance(out.colors.bg);
  assert.strictEqual(out.mode, L > 0.4 ? 'light' : 'dark', `${label}: mode`);
  // Every surface text sits on: the backgrounds, the solid surface, and the glass (surface over each
  // background) at the theme's opacity, the strong glass (0.85) and the Balanced profile's (0.96, 0.97).
  assert.deepStrictEqual(c.GLASS_ALPHAS, [0.85, 0.96, 0.97]);
  const grounds = [out.colors.surface];
  for (const under of [out.colors.bg, out.colors.bg2, out.colors.bg3]) {
    grounds.push(under);
    for (const a of [out.glass.opacity, 0.85, 0.96, 0.97]) grounds.push(c.mix(under, out.colors.surface, a));
  }
  for (const [k, min] of Object.entries(INKS)) {
    for (const g of grounds) {
      const ratio = c.contrast(out.colors[k], g);
      assert.ok(ratio >= min, `${label}: ${k} ${out.colors[k]} on ${g} is ${ratio.toFixed(2)}:1, under ${min}:1`);
    }
  }
}

test('random palettes: readable everywhere, valid hex, normalizing twice changes nothing', async () => {
  const c = await core();
  const seed = Number(process.env.THEME_SEED) || 20261120;
  const r = rng(seed);
  for (let i = 0; i < 300; i++) {
    const input = randomPalette(r);
    const label = `palette ${i} (seed ${seed}) ${JSON.stringify(input)}`;
    try {
      const out = c.normalizeTheme(input);
      checkTheme(c, out, label);
      assert.deepStrictEqual(c.normalizeTheme(out), out, `${label}: not idempotent`);
    } catch (err) {
      console.error(`themecontrast failed: re-run with THEME_SEED=${seed} (palette ${i})`);
      throw err;
    }
  }
});

test('extreme palettes: all black, all white, all mid grey, inverted, empty', async () => {
  const c = await core();
  const all = (hex) => Object.fromEntries(KEYS.map((k) => [k, hex]));
  const cases = {
    black: all('#000000'),
    white: all('#ffffff'),
    grey: all('#777777'),
    midBg: { bg: '#8a8a8a' },
    lightBgDefaults: { bg: '#f4f4f4' },
    darkTextOnDark: { bg: '#101010', text: '#202020', text2: '#181818', muted: '#151515' },
    lightCardOnDark: { bg: '#050505', surface: '#f0f0f0' },
  };
  for (const [name, colors] of Object.entries(cases)) {
    const out = c.normalizeTheme({ colors });
    checkTheme(c, out, name);
    assert.deepStrictEqual(c.normalizeTheme(out), out, `${name}: not idempotent`);
  }
  checkTheme(c, c.normalizeTheme({}), 'empty');
  checkTheme(c, c.normalizeTheme(null), 'null');
  // A light page stays light, a near-black one dark; a mid grey goes to the nearer side.
  assert.strictEqual(c.normalizeTheme({ colors: { bg: '#f4f4f4' } }).mode, 'light');
  assert.strictEqual(c.normalizeTheme({ colors: { bg: '#121212' } }).mode, 'dark');
  assert.strictEqual(c.normalizeTheme({ colors: { bg: '#a0a0a0' } }).mode, 'light');
  assert.strictEqual(c.normalizeTheme({ colors: { bg: '#3a3a3a' } }).mode, 'dark');
});

test('nudged colors keep their hue: only as far as needed toward white or black', async () => {
  const c = await core();
  const out = c.normalizeTheme({ colors: { bg: '#0a0a0f', muted: '#3a4050' } });
  assert.notStrictEqual(out.colors.muted, '#3a4050');
  assert.ok(c.contrast(out.colors.muted, out.colors.surface) >= 4.5);
  assert.ok(c.contrast(out.colors.muted, out.colors.surface) < 5, 'moved only as far as it had to');
  const [r, g, b] = c.hexToRgb(out.colors.muted);
  assert.ok(b > r && b > g, `still bluish: ${out.colors.muted}`);
});

test('the shipped palettes pass as they are and are not changed', async () => {
  const c = await core();
  const brand = load('main/brand.js');
  const { TEMPLATES } = load('main/personatemplates.js');
  const shipped = [['Neon Circuit', c.DEFAULT_THEME], ['Siren', brand.THEME], ...TEMPLATES.map((t) => [t.title, t.theme])];
  assert.ok(shipped.length >= 5);
  for (const [name, theme] of shipped) {
    assert.ok(theme?.colors, `${name} has colors`);
    const out = c.normalizeTheme(theme);
    for (const k of KEYS) assert.strictEqual(out.colors[k], theme.colors[k], `${name}: ${k} changed`);
    assert.strictEqual(out.mode, 'dark', `${name}: mode`);
    checkTheme(c, out, name);
  }
});

test('the old exports stay (the phone client and the faces import them)', async () => {
  const c = await core();
  for (const name of ['FONTS', 'PATTERNS', 'CORE_SHAPES', 'TRACE_STYLES', 'DEFAULT_THEME', 'hexToRgb', 'rgbToHex', 'triplet', 'mix', 'luminance', 'normalizeTheme']) assert.ok(name in c, name);
  assert.strictEqual(c.contrast('#000000', '#ffffff').toFixed(0), '21');
});
