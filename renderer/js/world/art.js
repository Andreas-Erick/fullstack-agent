// The Inner World's drawing kit: an isometric storybook style. World units are pixels at zoom 1: a tile
// is TW × TH, one ground level is HZ high. Light comes from the upper left: faces towards +y (the left
// front) are lit, faces towards +x (the right front) are in shade, roofs get both. Everything has a thin
// dark outline, like an illustration.
//
// Colours: an illustration needs natural colours (terracotta roofs, plaster, stone, grass), so this is
// the one place in the app with its own palette (STORY). It is lightly tinted towards the persona's
// theme, and the theme's accents colour banners, magic lights and a few roofs (see palette()).

export const TW = 48;
export const TH = 24;
export const HZ = 16;

const STORY = {
  grass: [112, 168, 78], grassDark: [84, 136, 62], grassLight: [150, 196, 98], grassSide: [78, 124, 56],
  dirt: [204, 176, 124], dirtDark: [170, 140, 96], sand: [222, 204, 158],
  cobble: [188, 180, 166], cobbleDark: [140, 132, 120], cobbleLight: [214, 208, 196],
  water: [78, 156, 206], waterDeep: [56, 120, 172], foam: [226, 244, 252],
  soil: [126, 92, 64], rock: [140, 124, 108], rockDark: [100, 88, 80], rockLight: [176, 160, 142],
  plaster: [240, 230, 206], plasterShade: [206, 192, 166],
  timber: [96, 64, 46], timberDark: [66, 44, 32],
  stone: [178, 172, 162], stoneShade: [138, 134, 126], stoneLight: [206, 202, 192],
  roof: [200, 96, 64], roofShade: [156, 68, 46], roofLight: [226, 134, 94],
  slate: [96, 106, 124], slateShade: [70, 78, 94], slateLight: [128, 140, 158],
  wood: [158, 110, 68], woodShade: [118, 80, 50], woodLight: [192, 146, 100],
  leaf: [92, 152, 70], leafDark: [62, 114, 54], leafLight: [146, 192, 96],
  pine: [54, 110, 76], pineDark: [38, 82, 58], pineLight: [84, 142, 96],
  trunk: [108, 76, 52], glass: [70, 92, 120], glassLight: [120, 150, 176], lamp: [255, 214, 130],
  skin: [240, 202, 166], outline: [48, 36, 30], wheat: [222, 190, 98], crop: [110, 160, 70],
  copper: [92, 170, 150], banner: [196, 64, 64], cloth: [232, 220, 196],
};

const tok = (css, name, fallback) => (css.getPropertyValue(name).trim() || fallback).split(',').map((v) => Number(v.trim()) || 0);
export function mix(a, b, t) {
  return [0, 1, 2].map((i) => Math.round(a[i] * (1 - t) + b[i] * t));
}
export const rgba = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

/** The palette: STORY tinted by the theme, plus the theme's own accents. */
// How each season changes the land (the rest of the palette stays).
const SEASON = {
  spring: { grass: [118, 184, 84], grassDark: [88, 150, 66], grassLight: [168, 212, 112], leaf: [104, 168, 76], leafLight: [160, 206, 104] },
  summer: {},
  autumn: { grass: [146, 158, 82], grassDark: [118, 128, 64], grassLight: [186, 178, 98], grassSide: [104, 112, 58], crop: [176, 150, 80], wheat: [206, 170, 92] },
  winter: { grass: [234, 240, 246], grassDark: [208, 220, 234], grassLight: [250, 252, 254], grassSide: [196, 208, 224], sand: [226, 232, 238], dirt: [206, 198, 186], water: [176, 206, 226], waterDeep: [150, 186, 212], crop: [236, 240, 246], wheat: [236, 240, 246], soil: [150, 124, 104], pine: [46, 96, 72], pineLight: [70, 124, 92] },
};
// Autumn leaves, picked per tree.
const AUTUMN = [[218, 112, 50], [234, 164, 62], [196, 70, 46], [226, 192, 82], [176, 96, 52]];

export function palette(season = 'summer') {
  const css = getComputedStyle(document.documentElement);
  const th = { c1: tok(css, '--c1', '0, 229, 255'), c2: tok(css, '--c2', '180, 90, 255'), c3: tok(css, '--c3', '255, 60, 172'), ok: tok(css, '--ok', '60, 255, 160'), warn: tok(css, '--warn', '255, 190, 60'), text: tok(css, '--text-rgb', '217, 244, 255'), bg: tok(css, '--bg-rgb', '10, 10, 15') };
  const P = { season };
  for (const [k, v] of Object.entries({ ...STORY, ...(SEASON[season] || {}) })) P[k] = mix(v, th.c1, 0.06);
  Object.assign(P, th, {
    display: css.getPropertyValue('--font-display').trim() || 'sans-serif',
    body: css.getPropertyValue('--font-body').trim() || 'sans-serif',
    accentRoof: mix(STORY.roof, th.c2, 0.55),
    accentRoof2: mix(STORY.roof, th.c3, 0.45),
    roofTint: mix(th.c1, [200, 90, 80], 0.25),
  });
  P.key = `${Object.values(th).join('|')}|${season}`;
  return P;
}

// ------------------------------------------------------------ projection and shapes
/** World pixels of grid point (gx, gy) at z pixels above ground level 0. */
export const W = (gx, gy, z = 0) => ({ x: (gx - gy) * (TW / 2), y: (gx + gy) * (TH / 2) - z });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function poly(c, pts, fill, stroke = null, lw = 1) {
  c.beginPath();
  pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  c.closePath();
  if (fill) {
    c.fillStyle = fill;
    c.fill();
  }
  if (stroke) {
    c.strokeStyle = stroke;
    c.lineWidth = lw;
    c.stroke();
  }
}
function line(c, a, b, color, lw = 1) {
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(b.x, b.y);
  c.strokeStyle = color;
  c.lineWidth = lw;
  c.stroke();
}
function hash(n) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * A wall face of a box: the left front face (side 'L', the +y side, lit) or the right front face
 * (side 'R', the +x side, shaded). f(u, v) maps u (0..1 along) and v (0..1 up) onto it.
 */
function face(gx, gy, a, b, z0, h, side) {
  const p0 = side === 'L' ? W(gx - a, gy + b, z0) : W(gx + a, gy + b, z0);
  const p1 = side === 'L' ? W(gx + a, gy + b, z0) : W(gx + a, gy - b, z0);
  const f = (u, v) => ({ x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u - v * h });
  f.quad = (u0, v0, u1, v1) => [f(u0, v0), f(u1, v0), f(u1, v1), f(u0, v1)];
  f.len = (side === 'L' ? a : b) * 2;
  f.h = h;
  f.side = side;
  return f;
}

/** A plain box: top and the two front faces, outlined. Returns its faces. */
export function box(c, P, gx, gy, a, b, z0, h, colors) {
  const L = face(gx, gy, a, b, z0, h, 'L');
  const R = face(gx, gy, a, b, z0, h, 'R');
  poly(c, L.quad(0, 0, 1, 1), rgba(colors.left), rgba(P.outline, 0.55));
  poly(c, R.quad(0, 0, 1, 1), rgba(colors.right), rgba(P.outline, 0.55));
  if (colors.top) poly(c, [W(gx - a, gy - b, z0 + h), W(gx + a, gy - b, z0 + h), W(gx + a, gy + b, z0 + h), W(gx - a, gy + b, z0 + h)], rgba(colors.top), rgba(P.outline, 0.55));
  return { L, R };
}

// ------------------------------------------------------------ wall finishes
/** Half-timbering: plaster panels between dark beams, braces in the end panels. */
function timbered(c, P, f, floors = 1) {
  const lit = f.side === 'L';
  poly(c, f.quad(0, 0, 1, 1), rgba(lit ? P.plaster : P.plasterShade));
  const beam = rgba(lit ? P.timber : P.timberDark);
  const w = 3;
  for (let k = 0; k <= floors; k++) line(c, f(0, k / floors - (k === floors ? 0.02 : 0)), f(1, k / floors - (k === floors ? 0.02 : 0)), beam, w);
  line(c, f(0, 0.08), f(1, 0.08), beam, w);
  const posts = Math.max(2, Math.round(f.len * 1.4));
  for (let k = 0; k <= posts; k++) line(c, f(k / posts, 0), f(k / posts, 1), beam, k === 0 || k === posts ? 3.5 : 2.5);
  for (let fl = 0; fl < floors; fl++) {
    const v0 = fl / floors + 0.08;
    const v1 = (fl + 1) / floors;
    line(c, f(0, v0), f(1 / posts, v1), beam, 2);
    line(c, f(1, v0), f(1 - 1 / posts, v1), beam, 2);
  }
}

/** Stone courses with staggered blocks. */
function stoned(c, P, f, base = P.stone, shade = P.stoneShade) {
  const lit = f.side === 'L';
  poly(c, f.quad(0, 0, 1, 1), rgba(lit ? base : shade));
  const rows = Math.max(3, Math.round(f.h / 7));
  const cols = Math.max(3, Math.round(f.len * 3));
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? 0.5 / cols : 0;
    for (let k = -1; k < cols; k++) {
      const u0 = Math.max(0, k / cols + off + 0.01);
      const u1 = Math.min(1, (k + 1) / cols + off - 0.01);
      if (u1 <= u0) continue;
      const j = hash(r * 97 + k * 13 + Math.round(f(0, 0).x));
      const col = mix(lit ? base : shade, j < 0.5 ? P.rockDark : P.stoneLight, 0.12 + j * 0.12);
      poly(c, f.quad(u0, r / rows + 0.012, u1, (r + 1) / rows - 0.012), rgba(col));
    }
  }
}

/** Vertical planks. */
function planked(c, P, f, base = P.wood, shade = P.woodShade) {
  const lit = f.side === 'L';
  poly(c, f.quad(0, 0, 1, 1), rgba(lit ? base : shade));
  const n = Math.max(4, Math.round(f.len * 5));
  for (let k = 1; k < n; k++) line(c, f(k / n, 0), f(k / n, 1), rgba(P.outline, 0.3), 1);
}

/** A stone plinth along the bottom of a wall. */
function plinth(c, P, f, v = 0.16) {
  const lit = f.side === 'L';
  poly(c, f.quad(0, 0, 1, v), rgba(lit ? P.stone : P.stoneShade));
  const n = Math.max(3, Math.round(f.len * 4));
  for (let k = 0; k < n; k++) {
    const j = hash(k * 31 + Math.round(f(0, 0).y));
    poly(c, f.quad(k / n + 0.01, 0.015, (k + 1) / n - 0.01, v - 0.02), rgba(mix(lit ? P.stone : P.stoneShade, P.rockDark, 0.1 + j * 0.2)));
  }
}

/** A window on a face: frame, panes, a cross, shutters and maybe a flower box. Registers a light. */
export function windowOn(c, P, f, u, v, w, h, lights, { shutters = true, flowers = false, shutter = P.slate, arch = false } = {}) {
  const u0 = u - w / 2;
  const u1 = u + w / 2;
  const v0 = v;
  const v1 = v + h;
  if (shutters) {
    poly(c, f.quad(u0 - w * 0.42, v0, u0 - 0.004, v1), rgba(mix(shutter, P.outline, f.side === 'L' ? 0 : 0.2)), rgba(P.outline, 0.6));
    poly(c, f.quad(u1 + 0.004, v0, u1 + w * 0.42, v1), rgba(mix(shutter, P.outline, f.side === 'L' ? 0 : 0.2)), rgba(P.outline, 0.6));
  }
  const q = f.quad(u0, v0, u1, v1);
  if (arch) q.splice(2, 0, f(u, v1 + h * 0.25));
  poly(c, q, rgba(P.timberDark));
  const inner = f.quad(u0 + w * 0.12, v0 + h * 0.1, u1 - w * 0.12, v1 - h * 0.08);
  poly(c, inner, rgba(f.side === 'L' ? P.glass : mix(P.glass, P.outline, 0.25)));
  poly(c, f.quad(u0 + w * 0.15, v1 - h * 0.45, u0 + w * 0.4, v1 - h * 0.14), rgba(P.glassLight, 0.6));
  line(c, f(u, v0 + h * 0.1), f(u, v1 - h * 0.08), rgba(P.timberDark), 1.5);
  line(c, f(u0 + w * 0.12, v0 + h * 0.5), f(u1 - w * 0.12, v0 + h * 0.5), rgba(P.timberDark), 1.5);
  if (flowers) {
    poly(c, f.quad(u0 - w * 0.08, v0 - h * 0.18, u1 + w * 0.08, v0 + 0.01), rgba(P.wood), rgba(P.outline, 0.6));
    for (let k = 0; k < 5; k++) {
      const p = f(u0 + (k + 0.5) * (w / 5), v0 + 0.02);
      c.beginPath();
      c.arc(p.x, p.y - 2, 2.2, 0, Math.PI * 2);
      c.fillStyle = rgba(k % 2 ? P.c3 : [P.lamp, P.banner, P.c2][k % 3]);
      c.fill();
      c.beginPath();
      c.arc(p.x + 1.5, p.y, 1.6, 0, Math.PI * 2);
      c.fillStyle = rgba(P.leaf);
      c.fill();
    }
  }
  lights?.push({ kind: 'window', quad: inner, tone: P.lamp });
}

/** A plank door with a stone step. */
export function doorOn(c, P, f, u, w = 0.22, h = 0.55, { arch = true } = {}) {
  const u0 = u - w / 2;
  const u1 = u + w / 2;
  const q = f.quad(u0, 0.02, u1, h);
  if (arch) q.splice(2, 0, f(u, h + 0.12));
  poly(c, q, rgba(P.timberDark));
  const inner = f.quad(u0 + w * 0.12, 0.02, u1 - w * 0.12, h - 0.04);
  if (arch) inner.splice(2, 0, f(u, h + 0.06));
  poly(c, inner, rgba(f.side === 'L' ? P.wood : P.woodShade));
  for (let k = 1; k < 4; k++) line(c, f(u0 + (w * k) / 4, 0.03), f(u0 + (w * k) / 4, h - 0.02), rgba(P.outline, 0.35), 1);
  const knob = f(u1 - w * 0.25, h * 0.45);
  c.beginPath();
  c.arc(knob.x, knob.y, 1.4, 0, Math.PI * 2);
  c.fillStyle = rgba(P.lamp);
  c.fill();
}

// ------------------------------------------------------------ roofs
// A sloped plane: shingle rows parallel to the eave, staggered tile edges, outline.
function shingles(c, P, eaveA, eaveB, ridgeB, ridgeA, base, lit) {
  poly(c, [eaveA, eaveB, ridgeB, ridgeA], rgba(base), rgba(P.outline, 0.7), 1.2);
  if (P.season === 'winter') return snowRoof(c, P, eaveA, eaveB, ridgeB, ridgeA, base, lit);
  const rows = Math.max(4, Math.round(Math.hypot(ridgeA.x - eaveA.x, ridgeA.y - eaveA.y) / 6));
  const along = Math.hypot(eaveB.x - eaveA.x, eaveB.y - eaveA.y);
  const cols = Math.max(4, Math.round(along / 7));
  for (let r = 1; r < rows; r++) {
    const t = r / rows;
    const a = lerp(eaveA, ridgeA, t);
    const b = lerp(eaveB, ridgeB, t);
    line(c, a, b, rgba(mix(base, P.outline, 0.45), 0.7), 1);
    const a2 = lerp(eaveA, ridgeA, t - 1 / rows);
    const b2 = lerp(eaveB, ridgeB, t - 1 / rows);
    for (let k = r % 2 ? 0.5 : 0; k < cols; k++) {
      const s = k / cols;
      line(c, lerp(a, b, s), lerp(a2, b2, s), rgba(mix(base, P.outline, 0.35), 0.45), 1);
    }
    if (lit && r % 2) line(c, lerp(a, b, 0.02), lerp(a, b, 0.98), rgba(mix(base, [255, 255, 255], 0.25), 0.25), 1);
  }
}

// A winter roof: shingles showing near the eave, snow above, icicles along the edge.
function snowRoof(c, P, eaveA, eaveB, ridgeB, ridgeA, base, lit) {
  const k = 0.32;
  const a = lerp(eaveA, ridgeA, k);
  const b = lerp(eaveB, ridgeB, k);
  for (let r = 1; r < 3; r++) line(c, lerp(eaveA, ridgeA, (r * k) / 3), lerp(eaveB, ridgeB, (r * k) / 3), rgba(mix(base, P.outline, 0.45), 0.7), 1);
  c.beginPath();
  c.moveTo(a.x, a.y);
  const n = 7;
  for (let i = 1; i <= n; i++) {
    const p = lerp(a, b, i / n);
    const mid = lerp(a, b, (i - 0.5) / n);
    c.quadraticCurveTo(mid.x, mid.y + 3, p.x, p.y);
  }
  c.lineTo(ridgeB.x, ridgeB.y);
  c.lineTo(ridgeA.x, ridgeA.y);
  c.closePath();
  c.fillStyle = rgba(lit ? [248, 250, 253] : [214, 224, 238]);
  c.fill();
  c.strokeStyle = rgba(P.outline, 0.35);
  c.lineWidth = 1;
  c.stroke();
  for (let i = 1; i < 6; i++) {
    const p = lerp(eaveA, eaveB, i / 6);
    poly(c, [{ x: p.x - 1.5, y: p.y }, { x: p.x + 1.5, y: p.y }, { x: p.x, y: p.y + 4 + (i % 3) * 2 }], rgba([226, 238, 250], 0.9));
  }
}

/**
 * A gable roof over a box (x: ridge along the grid x axis, y: along y). Draws the gable triangle on
 * the visible end with the wall finish, then both slopes. Returns the ridge's highest point.
 */
export function gableRoof(c, P, gx, gy, a, b, z, rh, { axis = 'x', color = P.roof, wall = 'plaster' } = {}) {
  const o = 0.22;
  const shade = mix(color, P.outline, 0.25);
  const light = mix(color, [255, 255, 255], 0.08);
  if (axis === 'x') {
    const r1 = W(gx - a - o, gy, z + rh);
    const r2 = W(gx + a + o, gy, z + rh);
    // The gable end at +x (on the right face), then the back slope, then the front slope.
    const gA = W(gx + a, gy + b, z);
    const gB = W(gx + a, gy - b, z);
    const gT = W(gx + a, gy, z + rh);
    poly(c, [gA, gB, gT], rgba(wall === 'stone' ? P.stoneShade : wall === 'wood' ? P.woodShade : P.plasterShade), rgba(P.outline, 0.6));
    if (wall === 'plaster') {
      line(c, lerp(gA, gB, 0.5), gT, rgba(P.timberDark), 2.5);
      line(c, lerp(gA, gT, 0.5), lerp(gB, gT, 0.5), rgba(P.timberDark), 2.5);
    }
    shingles(c, P, W(gx + a + o, gy - b - o, z), W(gx - a - o, gy - b - o, z), r1, r2, shade, false);
    shingles(c, P, W(gx - a - o, gy + b + o, z), W(gx + a + o, gy + b + o, z), r2, r1, light, true);
    line(c, r1, r2, rgba(mix(color, P.outline, 0.5)), 3);
    return r1.y < r2.y ? r1 : r2;
  }
  const r1 = W(gx, gy - b - o, z + rh);
  const r2 = W(gx, gy + b + o, z + rh);
  const gA = W(gx - a, gy + b, z);
  const gB = W(gx + a, gy + b, z);
  const gT = W(gx, gy + b, z + rh);
  poly(c, [gA, gB, gT], rgba(wall === 'stone' ? P.stone : wall === 'wood' ? P.wood : P.plaster), rgba(P.outline, 0.6));
  if (wall === 'plaster') {
    line(c, lerp(gA, gB, 0.5), gT, rgba(P.timber), 2.5);
    line(c, lerp(gA, gT, 0.5), lerp(gB, gT, 0.5), rgba(P.timber), 2.5);
  }
  shingles(c, P, W(gx - a - o, gy + b + o, z), W(gx - a - o, gy - b - o, z), r1, r2, light, true);
  shingles(c, P, W(gx + a + o, gy - b - o, z), W(gx + a + o, gy + b + o, z), r2, r1, shade, false);
  line(c, r1, r2, rgba(mix(color, P.outline, 0.5)), 3);
  return r1.y < r2.y ? r1 : r2;
}

/** A chimney on a roof: a stone stack with a cap. Returns its top (for smoke). */
export function chimney(c, P, gx, gy, z, h = 22) {
  box(c, P, gx, gy, 0.22, 0.22, z, h, { left: P.stone, right: P.stoneShade, top: P.rockDark });
  box(c, P, gx, gy, 0.28, 0.28, z + h, 3, { left: P.stoneLight, right: P.stone, top: P.rockDark });
  return W(gx, gy, z + h + 4);
}

/** A dormer window on a slope facing +y. */
function dormer(c, P, gx, gy, z, color, lights) {
  const f = box(c, P, gx, gy, 0.32, 0.25, z, 12, { left: P.plaster, right: P.plasterShade });
  windowOn(c, P, f.L, 0.5, 0.15, 0.5, 0.6, lights, { shutters: false });
  gableRoof(c, P, gx, gy, 0.32, 0.25, z + 12, 9, { axis: 'y', color });
}

// ------------------------------------------------------------ houses
/**
 * A house: walls (plaster with timbers, stone or planks) on a stone plinth, windows and a door, a gable
 * roof, a chimney, maybe dormers. opt: { a, b, floors, style, roof, axis, door, flowers, chimney, dormers }.
 * Returns { top, chimney } in world pixels.
 */
export function house(c, P, gx, gy, z0, opt, lights) {
  const { a = 1, b = 0.8, floors = 1, style = 'timber', roof = P.roof, axis = 'x', door = 'L', flowers = true, dormers = 0 } = opt;
  const h = 26 * floors + 4;
  const L = face(gx, gy, a, b, z0, h, 'L');
  const R = face(gx, gy, a, b, z0, h, 'R');
  for (const f of [R, L]) {
    if (style === 'stone') stoned(c, P, f);
    else if (style === 'wood') planked(c, P, f);
    else timbered(c, P, f, floors);
    if (style !== 'stone') plinth(c, P, f, 0.16 / floors + 0.02);
    poly(c, f.quad(0, 0, 1, 1), null, rgba(P.outline, 0.7), 1.2);
  }
  // Windows on both faces, a door on one.
  for (const f of [L, R]) {
    const n = Math.max(1, Math.round(f.len * 1.1));
    for (let fl = 0; fl < floors; fl++) {
      for (let k = 0; k < n; k++) {
        const u = (k + 0.5) / n;
        if (fl === 0 && f.side === door && Math.abs(u - 0.5) < 0.5 / n + 0.01 && n % 2) continue;
        if (fl === 0 && f.side === door && n === 2 && k === 0) continue;
        windowOn(c, P, f, u, fl / floors + 0.32 / floors + 0.06, Math.min(0.24, 0.6 / n), 0.32 / floors + 0.06, lights, { flowers: flowers && fl === floors - 1 && f.side === 'L', shutter: opt.shutter || P.slate });
      }
    }
  }
  doorOn(c, P, door === 'L' ? L : R, door === 'L' && Math.round(L.len * 1.1) === 2 ? 0.25 : 0.5, Math.min(0.3, 0.45 / (door === 'L' ? L.len : R.len)), 0.55 / floors + 0.08);
  const rh = (axis === 'x' ? b : a) * 26 + 10;
  const top = gableRoof(c, P, gx, gy, a, b, z0 + h, rh, { axis, color: roof, wall: style === 'stone' ? 'stone' : style === 'wood' ? 'wood' : 'plaster' });
  for (let k = 0; k < dormers; k++) dormer(c, P, gx - a * 0.4 + k * a * 0.8, gy + b * 0.55, z0 + h + 4, roof, lights);
  let smoke = null;
  if (opt.chimney !== false) smoke = chimney(c, P, gx + a * 0.45, gy - b * 0.2, z0 + h + rh * 0.55, 18);
  return { top: top.y - 4, smoke };
}

/** A round tower: stone courses, slit windows, a conical roof (or a dome). Returns its top. */
export function tower(c, P, gx, gy, z0, r, h, lights, { roof = P.slate, dome = false, windows = 3 } = {}) {
  const cx = W(gx, gy, z0);
  const rx = r * (TW / 2) * Math.SQRT2;
  const ry = r * (TH / 2) * Math.SQRT2;
  // Body with left-to-right shading.
  const g = c.createLinearGradient(cx.x - rx, 0, cx.x + rx, 0);
  g.addColorStop(0, rgba(P.stoneLight));
  g.addColorStop(0.55, rgba(P.stone));
  g.addColorStop(1, rgba(P.stoneShade));
  c.beginPath();
  c.moveTo(cx.x - rx, cx.y);
  c.ellipse(cx.x, cx.y, rx, ry, 0, Math.PI, 0, true);
  c.lineTo(cx.x + rx, cx.y - h);
  c.ellipse(cx.x, cx.y - h, rx, ry, 0, 0, Math.PI, false);
  c.closePath();
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = rgba(P.outline, 0.7);
  c.lineWidth = 1.2;
  c.stroke();
  // Courses: arcs, with staggered joints.
  for (let y = 7; y < h; y += 7) {
    c.beginPath();
    c.ellipse(cx.x, cx.y - y, rx, ry, 0, 0, Math.PI);
    c.strokeStyle = rgba(P.outline, 0.22);
    c.lineWidth = 1;
    c.stroke();
    for (let k = 0; k < 6; k++) {
      const t = ((k + (Math.round(y / 7) % 2) * 0.5) / 6) * Math.PI;
      const x = cx.x + Math.cos(t) * rx;
      const yy = cx.y - y + Math.sin(t) * ry;
      line(c, { x, y: yy }, { x, y: yy - 7 }, rgba(P.outline, 0.15));
    }
  }
  // Windows on the front of the curve.
  for (let k = 0; k < windows; k++) {
    const t = 0.35 + (k % 2) * 0.3;
    const x = cx.x + Math.cos(t * Math.PI) * rx * 0.9;
    const y = cx.y - 18 - k * ((h - 26) / Math.max(1, windows));
    const q = [{ x: x - 3, y: y + 6 }, { x: x + 3, y: y + 6 }, { x: x + 3, y: y - 4 }, { x, y: y - 8 }, { x: x - 3, y: y - 4 }];
    poly(c, q, rgba(P.glass), rgba(P.timberDark), 1.5);
    lights?.push({ kind: 'window', quad: q, tone: P.lamp });
  }
  // Top: a parapet ring, then a cone or a dome.
  c.beginPath();
  c.ellipse(cx.x, cx.y - h, rx + 2, ry + 1, 0, 0, Math.PI * 2);
  c.fillStyle = rgba(P.stoneShade);
  c.fill();
  c.stroke();
  if (dome) {
    const dg = c.createLinearGradient(cx.x - rx, 0, cx.x + rx, 0);
    dg.addColorStop(0, rgba(mix(roof, [255, 255, 255], 0.25)));
    dg.addColorStop(1, rgba(mix(roof, P.outline, 0.3)));
    c.beginPath();
    c.ellipse(cx.x, cx.y - h, rx, rx * 0.85, 0, Math.PI, 0);
    c.closePath();
    c.fillStyle = dg;
    c.fill();
    c.stroke();
    for (const t of [0.3, 0.5, 0.7]) {
      c.beginPath();
      c.ellipse(cx.x, cx.y - h, rx * Math.abs(Math.cos(t * Math.PI)) + 0.1, rx * 0.85, 0, Math.PI, 0);
      c.strokeStyle = rgba(P.outline, 0.25);
      c.stroke();
    }
    return { top: cx.y - h - rx * 0.85, apex: { x: cx.x, y: cx.y - h - rx * 0.85 } };
  }
  const apex = { x: cx.x, y: cx.y - h - r * 46 };
  const cg = c.createLinearGradient(cx.x - rx, 0, cx.x + rx, 0);
  cg.addColorStop(0, rgba(mix(roof, [255, 255, 255], 0.15)));
  cg.addColorStop(1, rgba(mix(roof, P.outline, 0.35)));
  c.beginPath();
  c.moveTo(cx.x - rx - 4, cx.y - h);
  c.ellipse(cx.x, cx.y - h, rx + 4, ry + 2, 0, Math.PI, 0, true);
  c.lineTo(apex.x, apex.y);
  c.closePath();
  c.fillStyle = cg;
  c.fill();
  c.strokeStyle = rgba(P.outline, 0.7);
  c.stroke();
  for (let k = 1; k < 6; k++) {
    c.beginPath();
    const t = k / 6;
    c.ellipse(cx.x, cx.y - h - (apex.y - (cx.y - h)) * -t, (rx + 4) * (1 - t), (ry + 2) * (1 - t), 0, 0, Math.PI);
    c.strokeStyle = rgba(P.outline, 0.25);
    c.stroke();
  }
  return { top: apex.y, apex };
}

// ------------------------------------------------------------ terrain
const TILE_COLORS = (P) => ({ 1: P.grass, 2: P.dirt, 3: P.cobble, 4: P.water, 5: P.sand, 6: P.cobble, 7: P.dirtDark, 8: P.wood });

/** One ground tile: its top (with texture) and the side faces where the neighbour is lower. */
export function tile(c, P, map, x, y, noise) {
  const t = map.tile(x, y);
  if (!t) return;
  const h = map.hgt(x, y);
  const z = h * HZ;
  const top = [W(x, y, z), W(x + 1, y, z), W(x + 1, y + 1, z), W(x, y + 1, z)];
  const jitter = noise(x / 3, y / 3) - 0.5;
  const base = TILE_COLORS(P)[t];
  const col = t === 1 ? mix(base, jitter > 0 ? P.grassLight : P.grassDark, Math.abs(jitter) * 0.5) : mix(base, P.outline, Math.max(0, jitter) * 0.1);
  // Sides first (they hang below the top).
  for (const [dx, dy, side] of [[0, 1, 'L'], [1, 0, 'R']]) {
    const nh = map.tile(x + dx, y + dy) ? map.hgt(x + dx, y + dy) : -(2 + Math.floor(noise(x * 0.9, y * 0.9) * 4));
    if (nh >= h) continue;
    cliff(c, P, x, y, h, nh, side, t, noise, map);
  }
  // Stroked in its own colour, so neighbouring tiles meet without hairline gaps.
  poly(c, top, rgba(col), rgba(col), 1);
  if (t === 1) {
    if (P.season !== 'winter') grassTuft(c, P, x, y, z, noise);
    else if (noise(x * 1.3, y * 1.3) > 0.7) speckle(c, P, x, y, z, noise, P.grassSide);
  }
  else if (t === 3 || t === 6) cobbles(c, P, x, y, z, noise);
  else if (t === 2 || t === 5) speckle(c, P, x, y, z, noise, t === 5 ? P.dirtDark : P.dirtDark);
  else if (t === 4) water(c, P, x, y, z, noise);
  else if (t === 7) furrows(c, P, x, y, z, noise);
  else if (t === 8) bridge(c, P, x, y, z);
}

function grassTuft(c, P, x, y, z, noise) {
  const n = noise(x * 1.7, y * 1.7);
  for (let k = 0; k < 3; k++) {
    const p = W(x + 0.2 + hash(x * 7 + y * 13 + k) * 0.6, y + 0.2 + hash(x * 11 + y * 5 + k) * 0.6, z);
    c.strokeStyle = rgba(k % 2 ? P.grassLight : P.grassDark, 0.8);
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(p.x - 2, p.y);
    c.lineTo(p.x - 3, p.y - 4);
    c.moveTo(p.x, p.y);
    c.lineTo(p.x, p.y - 5);
    c.moveTo(p.x + 2, p.y);
    c.lineTo(p.x + 3, p.y - 4);
    c.stroke();
  }
  if (n > 0.72) {
    const p = W(x + 0.5, y + 0.5, z);
    for (let k = 0; k < 3; k++) {
      c.beginPath();
      c.arc(p.x + (k - 1) * 4, p.y - 1 + (k % 2) * 2, 1.6, 0, Math.PI * 2);
      c.fillStyle = rgba([P.lamp, [240, 240, 250], P.c3][k]);
      c.fill();
    }
  }
}

function cobbles(c, P, x, y, z, noise) {
  for (let k = 0; k < 5; k++) {
    const u = 0.12 + ((k % 3) / 3) * 0.8 + hash(x * 3 + y * 17 + k) * 0.08;
    const v = 0.15 + Math.floor(k / 3) * 0.45 + hash(x * 19 + y * 3 + k) * 0.15;
    const p = W(x + u, y + v, z);
    c.beginPath();
    c.ellipse(p.x, p.y, 6 + hash(k + x) * 2, 3 + hash(k + y) * 1.2, 0, 0, Math.PI * 2);
    c.fillStyle = rgba(mix(P.cobbleLight, P.cobble, hash(x * 5 + y * 7 + k)));
    c.fill();
    c.strokeStyle = rgba(P.cobbleDark, 0.8);
    c.lineWidth = 1;
    c.stroke();
  }
}

function speckle(c, P, x, y, z, noise, dark) {
  for (let k = 0; k < 4; k++) {
    const p = W(x + hash(x * 13 + y * 7 + k), y + hash(x * 5 + y * 11 + k * 3), z);
    c.fillStyle = rgba(dark, 0.6);
    c.fillRect(p.x, p.y, 2, 1.5);
  }
}

function water(c, P, x, y, z, noise) {
  const p = W(x + 0.5, y + 0.5, z);
  if (P.season === 'winter') {
    // Ice: pale, with cracks.
    line(c, { x: p.x - 10, y: p.y - 2 }, { x: p.x + 2, y: p.y + 1 }, rgba([255, 255, 255], 0.7), 1);
    line(c, { x: p.x + 2, y: p.y + 1 }, { x: p.x + 8, y: p.y - 3 }, rgba(P.outline, 0.25), 1);
    return;
  }
  c.strokeStyle = rgba(P.foam, 0.45);
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(p.x - 8, p.y - 1);
  c.quadraticCurveTo(p.x - 4, p.y - 3, p.x, p.y - 1);
  c.stroke();
}

function furrows(c, P, x, y, z) {
  for (let k = 1; k < 4; k++) {
    const a = W(x + k / 4, y, z);
    const b = W(x + k / 4, y + 1, z);
    line(c, a, b, rgba(P.soil, 0.7), 2);
    for (let s = 0; s < 3; s++) {
      const p = lerp(a, b, (s + 0.5) / 3);
      c.fillStyle = rgba(hash(x + y + k) < 0.5 ? P.wheat : P.crop);
      c.fillRect(p.x - 1, p.y - 6, 2, 6);
    }
  }
}

function bridge(c, P, x, y, z) {
  for (let k = 0; k < 4; k++) {
    const a = W(x + k / 4 + 0.03, y, z + 3);
    const b = W(x + k / 4 + 0.03, y + 1, z + 3);
    line(c, a, b, rgba(P.woodLight), 5);
    line(c, a, b, rgba(P.outline, 0.3), 1);
  }
}

/** A cliff face from height h down to nh: soil, then rock strata, lit on the left, in shade on the right. */
function cliff(c, P, x, y, h, nh, side, t, noise, map) {
  const top = h * HZ;
  const bottom = nh * HZ;
  const a = side === 'L' ? W(x, y + 1, top) : W(x + 1, y + 1, top);
  const b = side === 'L' ? W(x + 1, y + 1, top) : W(x + 1, y, top);
  const drop = top - bottom;
  const lit = side === 'L';
  const rock = lit ? P.rock : P.rockDark;
  poly(c, [a, b, { x: b.x, y: b.y + drop }, { x: a.x, y: a.y + drop }], rgba(rock));
  // Strata and boulders.
  for (let s = 10; s < drop; s += 9) {
    const wob = (hash(x * 3 + y * 7 + s) - 0.5) * 3;
    line(c, { x: a.x, y: a.y + s + wob }, { x: b.x, y: b.y + s - wob }, rgba(P.outline, 0.25), 1);
  }
  for (let k = 0; k < Math.min(4, drop / 14); k++) {
    const u = hash(x * 31 + y * 17 + k);
    const v = 8 + hash(x * 13 + y * 29 + k) * (drop - 12);
    const p = lerp(a, b, u);
    c.beginPath();
    c.ellipse(p.x, p.y + v, 4 + u * 3, 2.5 + u, 0, 0, Math.PI * 2);
    c.fillStyle = rgba(lit ? P.rockLight : P.rock);
    c.fill();
  }
  // A band of soil and the grass lip with hanging blades.
  if (t === 1 || t === 5 || t === 7) {
    poly(c, [a, b, { x: b.x, y: b.y + 6 }, { x: a.x, y: a.y + 6 }], rgba(P.soil));
    poly(c, [a, b, { x: b.x, y: b.y + 3 }, { x: a.x, y: a.y + 3 }], rgba(lit ? P.grass : P.grassSide));
    for (let k = 0; k < 4; k++) {
      const p = lerp(a, b, (k + 0.5) / 4);
      line(c, p, { x: p.x + 1, y: p.y + 5 + hash(x + k * 3 + y) * 4 }, rgba(P.grassSide), 1.5);
    }
  }
  // Steps where a road meets a step in the ground.
  const road = (tt) => tt === 3 || tt === 6;
  const nx = side === 'L' ? x : x + 1;
  const ny = side === 'L' ? y + 1 : y;
  if (road(t) && nh > 0 && road(map.tile(nx, ny))) {
    const steps = Math.round(drop / 5);
    for (let k = 0; k < steps; k++) {
      const yy = (k * drop) / steps;
      poly(c, [{ x: a.x, y: a.y + yy }, { x: b.x, y: b.y + yy }, { x: b.x, y: b.y + yy + 3 }, { x: a.x, y: a.y + yy + 3 }], rgba(lit ? P.cobbleLight : P.cobble));
      line(c, { x: a.x, y: a.y + yy + 3 }, { x: b.x, y: b.y + yy + 3 }, rgba(P.outline, 0.4));
    }
  }
  line(c, { x: a.x, y: a.y }, { x: a.x, y: a.y + drop }, rgba(P.outline, 0.25), 1);
}

// ------------------------------------------------------------ trees and props
/** A tree: a trunk and a canopy of overlapping clusters, outlined, lit from the upper left. */
export function tree(c, P, t, z) {
  const p = W(t.gx, t.gy, z);
  const k = t.k;
  shadowAt(c, p.x + 8 * k, p.y + 2, 16 * k, 6 * k);
  if (t.kind === 'pine') {
    poly(c, [{ x: p.x - 2, y: p.y }, { x: p.x + 2, y: p.y }, { x: p.x + 2, y: p.y - 10 * k }, { x: p.x - 2, y: p.y - 10 * k }], rgba(P.trunk));
    for (let i = 0; i < 4; i++) {
      const y = p.y - 8 * k - i * 11 * k;
      const w = (17 - i * 3.6) * k;
      poly(c, [{ x: p.x - w, y }, { x: p.x, y: y - 18 * k }, { x: p.x + w, y }], rgba(P.pineDark), rgba(P.outline, 0.6));
      poly(c, [{ x: p.x - w, y }, { x: p.x, y: y - 18 * k }, { x: p.x + w * 0.1, y }], rgba(P.pine));
      line(c, { x: p.x - w * 0.6, y: y - 3 }, { x: p.x - w * 0.15, y: y - 12 * k }, rgba(P.pineLight, 0.8), 1.5);
      // Snow resting on each tier.
      if (P.season === 'winter') poly(c, [{ x: p.x - w * 0.55, y: y - 7 * k }, { x: p.x, y: y - 18 * k }, { x: p.x + w * 0.55, y: y - 7 * k }, { x: p.x + w * 0.2, y: y - 9 * k }, { x: p.x - w * 0.15, y: y - 6 * k }], rgba([246, 249, 253]));
    }
    return;
  }
  if (P.season === 'winter') return bareTree(c, P, p, t, k);
  const trunk = t.kind === 'birch' ? [236, 232, 220] : P.trunk;
  poly(c, [{ x: p.x - 3 * k, y: p.y }, { x: p.x + 3 * k, y: p.y }, { x: p.x + 2 * k, y: p.y - 16 * k }, { x: p.x - 2 * k, y: p.y - 16 * k }], rgba(trunk), rgba(P.outline, 0.6));
  if (t.kind === 'birch') for (let i = 0; i < 3; i++) line(c, { x: p.x - 2 * k, y: p.y - 4 - i * 4 }, { x: p.x + 1, y: p.y - 4 - i * 4 }, rgba(P.outline, 0.6), 1);
  const blobs = [[-9, -20, 10], [9, -21, 10], [0, -30, 12], [-5, -36, 8], [7, -33, 8]];
  const pick = hash(Math.round(t.gx * 97 + t.gy * 31));
  const autumn = P.season === 'autumn' ? AUTUMN[Math.floor(pick * AUTUMN.length)] : null;
  const leaf = autumn || (t.kind === 'birch' ? mix(P.leaf, P.wheat, 0.25) : P.leaf);
  const dark = autumn ? mix(autumn, P.outline, 0.3) : P.leafDark;
  const light = autumn ? mix(autumn, [255, 240, 200], 0.35) : P.leafLight;
  // Outline pass, shade pass, colour, highlight.
  for (const [dx, dy, r] of blobs) circle(c, p.x + dx * k, p.y + dy * k, (r + 1.5) * k, rgba(P.outline, 0.7));
  for (const [dx, dy, r] of blobs) circle(c, p.x + dx * k, p.y + dy * k, r * k, rgba(dark));
  for (const [dx, dy, r] of blobs) circle(c, p.x + (dx - 2) * k, p.y + (dy - 2) * k, r * 0.82 * k, rgba(leaf));
  for (const [dx, dy, r] of blobs.slice(2)) circle(c, p.x + (dx - 4) * k, p.y + (dy - 4) * k, r * 0.35 * k, rgba(light));
  // Spring blossom; fallen leaves around autumn trees.
  if (P.season === 'spring' && pick < 0.6) {
    for (let i = 0; i < 9; i++) circle(c, p.x + (hash(i * 7 + pick * 1e3) - 0.5) * 30 * k, p.y - 18 * k - hash(i * 13 + pick * 1e3) * 22 * k, 1.8 * k, rgba(i % 3 ? [250, 196, 214] : [255, 236, 244]));
  }
  if (autumn) for (let i = 0; i < 6; i++) circle(c, p.x + (hash(i * 5 + pick * 1e3) - 0.5) * 34 * k, p.y + (hash(i * 11 + pick * 1e3) - 0.3) * 9 * k, 1.6 * k, rgba(AUTUMN[(i + Math.floor(pick * 5)) % AUTUMN.length]));
}

// Winter: a bare deciduous tree, snow on its branches.
function bareTree(c, P, p, t, k) {
  const trunk = t.kind === 'birch' ? [236, 232, 220] : P.trunk;
  poly(c, [{ x: p.x - 3 * k, y: p.y }, { x: p.x + 3 * k, y: p.y }, { x: p.x + 1.5 * k, y: p.y - 26 * k }, { x: p.x - 1.5 * k, y: p.y - 26 * k }], rgba(trunk), rgba(P.outline, 0.6));
  const branch = (x0, y0, ang, len, depth) => {
    const x1 = x0 + Math.cos(ang) * len;
    const y1 = y0 - Math.sin(ang) * len;
    line(c, { x: x0, y: y0 }, { x: x1, y: y1 }, rgba(mix(trunk, P.outline, 0.25)), Math.max(1, depth * 0.9));
    if (depth > 1) {
      branch(x1, y1, ang + 0.45, len * 0.68, depth - 1);
      branch(x1, y1, ang - 0.45, len * 0.68, depth - 1);
    } else circle(c, x1, y1 - 0.5, 1.6, rgba([248, 250, 253]));
  };
  branch(p.x, p.y - 22 * k, Math.PI / 2 + 0.5, 10 * k, 3);
  branch(p.x, p.y - 22 * k, Math.PI / 2 - 0.5, 10 * k, 3);
  branch(p.x, p.y - 25 * k, Math.PI / 2, 9 * k, 2);
}

function circle(c, x, y, r, fill) {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
}

export function shadowAt(c, x, y, rx, ry, a = 0.2) {
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = `rgba(0, 0, 0, ${a})`;
  c.fill();
}

/** Small things: barrels, crates, rocks, bushes, flowers, stumps, lamp posts, benches, hay. */
export function prop(c, P, kind, gx, gy, z, lights, seed = 0) {
  const p = W(gx, gy, z);
  switch (kind) {
    case 'barrel': {
      shadowAt(c, p.x + 3, p.y + 1, 7, 3);
      poly(c, [{ x: p.x - 5, y: p.y }, { x: p.x + 5, y: p.y }, { x: p.x + 6, y: p.y - 6 }, { x: p.x + 5, y: p.y - 12 }, { x: p.x - 5, y: p.y - 12 }, { x: p.x - 6, y: p.y - 6 }], rgba(P.wood), rgba(P.outline, 0.7));
      line(c, { x: p.x - 6, y: p.y - 3 }, { x: p.x + 6, y: p.y - 3 }, rgba(P.rockDark), 1.5);
      line(c, { x: p.x - 6, y: p.y - 9 }, { x: p.x + 6, y: p.y - 9 }, rgba(P.rockDark), 1.5);
      c.beginPath();
      c.ellipse(p.x, p.y - 12, 5, 2, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.woodLight);
      c.fill();
      c.stroke();
      return;
    }
    case 'crate':
      box(c, P, gx, gy, 0.18, 0.18, z, 10, { left: P.woodLight, right: P.wood, top: mix(P.woodLight, [255, 255, 255], 0.1) });
      line(c, W(gx - 0.18, gy + 0.18, z), W(gx + 0.18, gy + 0.18, z + 10), rgba(P.woodShade), 1.5);
      return;
    case 'rock':
      c.beginPath();
      c.ellipse(p.x, p.y - 2, 7, 4.5, 0, Math.PI, 0);
      c.closePath();
      c.fillStyle = rgba(P.rock);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.6);
      c.stroke();
      circle(c, p.x - 2, p.y - 4, 2, rgba(P.rockLight));
      return;
    case 'bush':
      for (const [dx, dy, r] of [[-5, -4, 5], [4, -4, 5], [0, -8, 5.5]]) circle(c, p.x + dx, p.y + dy, r + 1, rgba(P.outline, 0.6));
      for (const [dx, dy, r] of [[-5, -4, 5], [4, -4, 5], [0, -8, 5.5]]) circle(c, p.x + dx, p.y + dy, r, rgba(P.leafDark));
      circle(c, p.x - 2, p.y - 8, 3, rgba(P.leaf));
      if (seed % 3 === 0) for (let k = 0; k < 4; k++) circle(c, p.x - 5 + k * 3.5, p.y - 6 + (k % 2) * 3, 1.3, rgba(k % 2 ? P.c3 : P.lamp));
      return;
    case 'flowers':
      for (let k = 0; k < 6; k++) circle(c, p.x - 6 + (k % 3) * 6, p.y - 2 - Math.floor(k / 3) * 4, 1.8, rgba([P.c3, P.lamp, [245, 245, 250], P.c2][k % 4]));
      return;
    case 'stump':
      c.beginPath();
      c.ellipse(p.x, p.y - 4, 5, 2.5, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.woodLight);
      c.fill();
      poly(c, [{ x: p.x - 5, y: p.y - 4 }, { x: p.x + 5, y: p.y - 4 }, { x: p.x + 5, y: p.y }, { x: p.x - 5, y: p.y }], rgba(P.trunk), rgba(P.outline, 0.6));
      return;
    case 'lamp': {
      line(c, p, { x: p.x, y: p.y - 26 }, rgba(P.timberDark), 2.5);
      line(c, { x: p.x, y: p.y - 26 }, { x: p.x + 5, y: p.y - 26 }, rgba(P.timberDark), 2);
      poly(c, [{ x: p.x + 2, y: p.y - 25 }, { x: p.x + 8, y: p.y - 25 }, { x: p.x + 7, y: p.y - 18 }, { x: p.x + 3, y: p.y - 18 }], rgba(P.lamp, 0.9), rgba(P.outline, 0.7));
      lights?.push({ kind: 'lamp', x: p.x + 5, y: p.y - 21, r: 34, tone: P.lamp });
      return;
    }
    case 'bench':
      box(c, P, gx, gy, 0.35, 0.1, z + 5, 2, { left: P.woodLight, right: P.wood, top: P.woodLight });
      line(c, W(gx - 0.3, gy + 0.1, z), W(gx - 0.3, gy + 0.1, z + 5), rgba(P.timberDark), 2);
      line(c, W(gx + 0.3, gy + 0.1, z), W(gx + 0.3, gy + 0.1, z + 5), rgba(P.timberDark), 2);
      return;
    case 'hay':
      c.beginPath();
      c.ellipse(p.x, p.y - 5, 8, 6, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.wheat);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.6);
      c.stroke();
      line(c, { x: p.x - 6, y: p.y - 6 }, { x: p.x + 6, y: p.y - 4 }, rgba(P.dirtDark), 1);
      return;
    case 'well': {
      tower(c, P, gx, gy, z, 0.35, 8, null, { roof: P.roof, windows: 0, dome: false });
      return;
    }
    default:
  }
}

/** A banner on a pole. raised: 0 (lowered) … 1 (at the top). */
export function banner(c, P, x, y, h, color, raised = 1, wave = 0) {
  line(c, { x, y }, { x, y: y - h }, rgba(P.timberDark), 2);
  circle(c, x, y - h - 1.5, 2, rgba(P.lamp));
  const fy = y - h + 2 + (1 - raised) * h * 0.6;
  c.beginPath();
  c.moveTo(x, fy);
  c.quadraticCurveTo(x + 8, fy + wave, x + 16, fy + 2);
  c.lineTo(x + 14, fy + 7);
  c.lineTo(x + 16, fy + 12);
  c.quadraticCurveTo(x + 8, fy + 10 + wave, x, fy + 12);
  c.closePath();
  c.fillStyle = rgba(color);
  c.fill();
  c.strokeStyle = rgba(P.outline, 0.7);
  c.lineWidth = 1;
  c.stroke();
}

// ------------------------------------------------------------ people
const HATS = { Wren: 'cap', Bram: 'straw' };

/** A little villager, about 28 world pixels tall. p: { x, y (feet, world px), color, kind, name, i, walking, asleep, working, thinking }. */
export function person(c, P, p, t, anim) {
  const walk = p.walking && anim ? Math.sin(t / 110 + p.i) : 0;
  const bob = anim && !p.walking ? Math.sin(t / 600 + p.i * 1.7) * 0.6 : 0;
  const x = p.x;
  const y = p.y + bob;
  const col = p.color;
  shadowAt(c, x + 2, p.y + 1, 7, 2.6, 0.25);
  c.lineCap = 'round';
  line(c, { x: x - 2, y: y - 7 }, { x: x - 2 + walk * 2.5, y }, rgba(mix(col, P.outline, 0.55)), 2.4);
  line(c, { x: x + 2, y: y - 7 }, { x: x + 2 - walk * 2.5, y }, rgba(mix(col, P.outline, 0.55)), 2.4);
  // Robe with a belt.
  poly(c, [{ x: x - 4.5, y: y - 19 }, { x: x + 4.5, y: y - 19 }, { x: x + 7, y: y - 5 }, { x: x - 7, y: y - 5 }], rgba(col), rgba(P.outline, 0.8), 1.2);
  poly(c, [{ x: x - 4.5, y: y - 19 }, { x: x - 1, y: y - 19 }, { x: x - 3, y: y - 5 }, { x: x - 7, y: y - 5 }], rgba(mix(col, [255, 255, 255], 0.18)));
  line(c, { x: x - 6, y: y - 10 }, { x: x + 6, y: y - 10 }, rgba(mix(col, P.outline, 0.5)), 2);
  const arm = p.working && anim ? Math.sin(t / 90) * 3 : walk * 2;
  line(c, { x: x - 4.5, y: y - 17 }, { x: x - 8, y: y - 11 - arm }, rgba(mix(col, P.outline, 0.15)), 2.4);
  line(c, { x: x + 4.5, y: y - 17 }, { x: x + 8, y: y - 11 + arm }, rgba(mix(col, P.outline, 0.15)), 2.4);
  c.lineCap = 'butt';
  circle(c, x, y - 23, 5.2, rgba(P.outline, 0.8));
  circle(c, x, y - 23, 4.4, rgba(P.skin));
  circle(c, x + 1.5, y - 23.5, 0.8, rgba(P.outline));
  const hat = p.kind === 'active' ? 'wizard' : HATS[p.name] || 'hood';
  const hc = hat === 'straw' ? P.wheat : hat === 'cap' ? [60, 56, 70] : mix(col, P.outline, 0.25);
  if (hat === 'wizard') {
    poly(c, [{ x: x - 7, y: y - 25 }, { x: x + 3, y: y - 41 }, { x: x + 7, y: y - 25 }], rgba(hc), rgba(P.outline, 0.8));
    poly(c, [{ x: x - 8, y: y - 26 }, { x: x + 8, y: y - 26 }, { x: x + 8, y: y - 24 }, { x: x - 8, y: y - 24 }], rgba(mix(hc, P.outline, 0.2)));
    circle(c, x + 0.5, y - 31, 1.4, rgba(P.lamp));
  } else if (hat === 'straw') {
    c.beginPath();
    c.ellipse(x, y - 26, 9, 2.6, 0, 0, Math.PI * 2);
    c.fillStyle = rgba(hc);
    c.fill();
    c.strokeStyle = rgba(P.outline, 0.7);
    c.stroke();
    poly(c, [{ x: x - 4, y: y - 26 }, { x: x + 4, y: y - 26 }, { x: x + 3, y: y - 30 }, { x: x - 3, y: y - 30 }], rgba(hc), rgba(P.outline, 0.7));
  } else if (hat === 'cap') {
    poly(c, [{ x: x - 7, y: y - 28 }, { x: x + 7, y: y - 28 }, { x: x + 5, y: y - 30 }, { x: x - 5, y: y - 30 }], rgba(hc), rgba(P.outline, 0.7));
    line(c, { x: x + 5, y: y - 29 }, { x: x + 7, y: y - 25 }, rgba(P.lamp), 1);
  } else {
    c.beginPath();
    c.arc(x, y - 24, 5.6, Math.PI, 0);
    c.fillStyle = rgba(hc);
    c.fill();
  }
  if (p.kind === 'active') {
    const my = y - 50 + (anim ? Math.sin(t / 400) * 1.5 : 0);
    poly(c, [{ x, y: my - 5 }, { x: x + 3.5, y: my }, { x, y: my + 5 }, { x: x - 3.5, y: my }], rgba(P.c1), rgba(P.outline, 0.5));
  }
  if (p.asleep) {
    c.font = `9px ${P.body}`;
    c.fillStyle = rgba(P.outline, 0.7);
    c.fillText('z', x + 7, y - 31);
  }
  if (p.working) {
    for (let i = 0; i < 4; i++) {
      const k = anim ? (t / 600 + i / 4) % 1 : i / 4;
      c.fillStyle = rgba(P.c1, 1 - k);
      c.fillRect(x + 9 + Math.cos(i * 1.7) * k * 9, y - 14 - k * 12, 2, 2);
    }
  }
  if (p.thinking) {
    const n = anim ? Math.floor(t / 400) % 4 : 3;
    for (let i = 0; i < 3; i++) circle(c, x - 5 + i * 5, y - 44, 1.7, rgba(P.outline, i < n ? 0.9 : 0.25));
  }
  return { x, y: y - 14, r: 14, top: y - 44 };
}
