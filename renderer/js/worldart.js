// The Inner World's painter: a small fantasy village in perspective, drawn procedurally on a canvas.
// Sky with sun, moon and your skill tree as constellations; mountains, forest, a river, cobbled paths
// with lanterns; each place with its own architecture, grander with every level (a construction site
// before it is built); residents as little figures; smoke, sparks, ravens, weather and night light.
// Every color is mixed from the theme tokens (--ok for grass, --warn for wood and lamplight, --c1 for
// water…), so the village takes on the persona's look. innerworld.js owns the data and interaction.

// ------------------------------------------------------------ palette
const tok = (css, name, fallback) => (css.getPropertyValue(name).trim() || fallback).split(',').map((v) => Number(v.trim()) || 0);
export function palette() {
  const css = getComputedStyle(document.documentElement);
  const P = {
    c1: tok(css, '--c1', '0, 229, 255'),
    c2: tok(css, '--c2', '180, 90, 255'),
    c3: tok(css, '--c3', '255, 60, 172'),
    ok: tok(css, '--ok', '60, 255, 160'),
    warn: tok(css, '--warn', '255, 190, 60'),
    err: tok(css, '--err', '255, 80, 100'),
    text: tok(css, '--text-rgb', '217, 244, 255'),
    bg: tok(css, '--bg-rgb', '10, 10, 15'),
    display: css.getPropertyValue('--font-display').trim() || 'sans-serif',
    body: css.getPropertyValue('--font-body').trim() || 'sans-serif',
  };
  const m = (a, b, t) => mix(P[a], P[b], t);
  Object.assign(P, {
    grass: m('ok', 'bg', 0.7),
    grassFar: m('ok', 'bg', 0.8),
    grassLight: m('ok', 'text', 0.35).map((v, i) => v * 0.55 + P.bg[i] * 0.45),
    leaf: m('ok', 'bg', 0.6),
    leafDark: m('ok', 'bg', 0.78),
    wood: m('warn', 'bg', 0.5),
    woodDark: m('warn', 'bg', 0.7),
    stone: m('text', 'bg', 0.55),
    stoneDark: m('text', 'bg', 0.72),
    water: m('c1', 'bg', 0.55),
    path: mix(m('warn', 'text', 0.5), P.bg, 0.55),
    skin: m('warn', 'text', 0.55),
    mountain: m('c2', 'bg', 0.78),
    mountainFar: m('c2', 'bg', 0.86),
  });
  P.key = [P.c1, P.c2, P.ok, P.warn, P.bg, P.text].join('|');
  return P;
}
function mix(a, b, t) {
  return a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
}
const rgba = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const TONE = { lookout: 'c2', hearth: 'warn', library: 'c1', cafe: 'c3', workshop: 'err', garden: 'ok', grounds: 'ok', observatory: 'c2', archive: 'c1', stage: 'c3' };

// Deterministic randomness, so trees and stars stay where they are.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash = (s) => [...String(s)].reduce((h, c) => Math.imul(h ^ c.codePointAt(0), 16777619), 2166136261) >>> 0;

// ------------------------------------------------------------ the view: meadow in perspective
/** Screen geometry for a canvas of w × h: the horizon and where a place (x, y in 0..1) stands. */
export function makeView(w, h) {
  const horizon = Math.round(h * 0.2);
  const gh = h - horizon;
  const base = Math.max(0.7, Math.min(1.7, Math.min(w / 820, h / 600)));
  const project = (px, py) => {
    const f = 0.62 + 0.38 * py;
    return { x: w / 2 + (px - 0.5) * w * 0.9 * f, y: horizon + gh * (0.1 + py * 0.78), s: base * (0.78 + 0.6 * py) };
  };
  return { w, h, horizon, base, project };
}

// Day and night: 1 = full night.
export function nightAt(m) {
  const h = m / 60;
  if (h < 5.5 || h >= 21.5) return 1;
  if (h < 7.5) return (7.5 - h) / 2;
  if (h > 18.5) return (h - 18.5) / 3;
  return 0;
}
const duskAt = (m) => {
  const h = m / 60;
  return Math.max(0, 1 - Math.abs(h - 6.8) / 1.3, 1 - Math.abs(h - 19.6) / 1.5);
};

export function weatherOf(text) {
  const t = String(text || '').toLowerCase();
  if (/snow|sleet|frost/.test(t)) return 'snow';
  if (/rain|drizzl|shower|storm|wet/.test(t)) return 'rain';
  if (/fog|mist|haz/.test(t)) return 'fog';
  if (/cloud|overcast|grey|gray/.test(t)) return 'cloudy';
  return 'clear';
}

// ------------------------------------------------------------ the still layer (cached)
let cache = null;
function stillLayer(V, P, places, lite) {
  const key = `${V.w}x${V.h}|${P.key}|${lite}|${places.map((p) => p.id).join()}`;
  if (cache?.key === key) return cache;
  const dpr = window.devicePixelRatio || 1;
  const cv = document.createElement('canvas');
  cv.width = Math.round(V.w * dpr);
  cv.height = Math.round(V.h * dpr);
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rand = rng(7);
  // Mountains on the horizon, two ranges.
  for (const [far, color, amp, seed] of [[true, P.mountainFar, 0.14, 3], [false, P.mountain, 0.1, 9]]) {
    const r = rng(seed);
    let x = -V.w * 0.05;
    while (x < V.w * 1.05) {
      const width = V.w * (0.09 + r() * 0.12);
      const peakX = x + width * (0.35 + r() * 0.3);
      const peakY = V.horizon - V.h * amp * (0.4 + r() * 0.6);
      const foot = V.horizon + 2;
      c.beginPath();
      c.moveTo(x, foot);
      c.lineTo(peakX, peakY);
      c.lineTo(x + width, foot);
      c.closePath();
      c.fillStyle = rgba(color, far ? 0.9 : 1);
      c.fill();
      // The lit flank.
      c.beginPath();
      c.moveTo(peakX, peakY);
      c.lineTo(x + width, foot);
      c.lineTo(peakX + width * 0.08, foot);
      c.closePath();
      c.fillStyle = rgba(mix(color, P.text, far ? 0.05 : 0.09));
      c.fill();
      // Snow on the high ones.
      if (foot - peakY > V.h * amp * 0.7) {
        const k = 0.22;
        const dy = foot - peakY;
        c.beginPath();
        c.moveTo(peakX, peakY);
        c.lineTo(peakX + (x + width - peakX) * k, peakY + dy * k);
        c.lineTo(peakX + (x + width - peakX) * k * 0.4, peakY + dy * k * 0.8);
        c.lineTo(peakX - (peakX - x) * k * 0.3, peakY + dy * k * 1.05);
        c.lineTo(peakX - (peakX - x) * k, peakY + dy * k);
        c.closePath();
        c.fillStyle = rgba(mix(P.text, color, 0.25), far ? 0.55 : 0.75);
        c.fill();
      }
      x += width * (0.55 + r() * 0.3);
    }
  }
  // The meadow.
  const g = c.createLinearGradient(0, V.horizon, 0, V.h);
  g.addColorStop(0, rgba(P.grassFar));
  g.addColorStop(1, rgba(P.grass));
  c.fillStyle = g;
  c.fillRect(0, V.horizon, V.w, V.h - V.horizon);
  // Patches of lighter grass and tufts.
  for (let i = 0; i < 26; i++) {
    const p = V.project(rand(), rand());
    c.beginPath();
    c.ellipse(p.x, p.y, 70 * p.s * (0.6 + rand()), 22 * p.s * (0.6 + rand()), 0, 0, Math.PI * 2);
    c.fillStyle = rgba(P.grassLight, 0.18);
    c.fill();
  }
  c.strokeStyle = rgba(P.grassLight, 0.3);
  c.lineWidth = 1;
  for (let i = 0; i < (lite ? 60 : 140); i++) {
    const p = V.project(rand(), rand());
    c.beginPath();
    c.moveTo(p.x, p.y);
    c.lineTo(p.x - 1.5 * p.s, p.y - 4 * p.s);
    c.moveTo(p.x, p.y);
    c.lineTo(p.x + 1.5 * p.s, p.y - 4.5 * p.s);
    c.stroke();
  }
  const clear = (x, y, d) => !places.some((p) => Math.hypot((p.x - x) * 1.3, p.y - y) < d);
  // Farm fields: striped plots in the open land.
  for (let i = 0, made = 0; i < 60 && made < 5; i++) {
    const x = 0.15 + rand() * 0.75;
    const y = 0.05 + rand() * 0.85;
    if (!clear(x, y, 0.17)) continue;
    made++;
    const a = V.project(x, y);
    const w = 70 * a.s;
    const h = 26 * a.s;
    const crop = rand() < 0.5 ? mix(P.warn, P.grass, 0.55) : mix(mix(P.ok, P.text, 0.15), P.bg, 0.4);
    c.save();
    c.translate(a.x, a.y);
    c.transform(1, 0, -0.35, 1, 0, 0);
    c.fillStyle = rgba(mix(crop, P.bg, 0.25));
    c.fillRect(-w / 2, -h / 2, w, h);
    c.strokeStyle = rgba(mix(crop, P.text, 0.2), 0.6);
    for (let k = 1; k < 6; k++) {
      c.beginPath();
      c.moveTo(-w / 2, -h / 2 + (k * h) / 6);
      c.lineTo(w / 2, -h / 2 + (k * h) / 6);
      c.stroke();
    }
    c.strokeStyle = rgba(P.woodDark, 0.8);
    c.strokeRect(-w / 2, -h / 2, w, h);
    c.restore();
  }
  // Rocks and bushes.
  for (let i = 0; i < 40; i++) {
    const x = rand();
    const y = rand();
    if (!clear(x, y, 0.1)) continue;
    const a = V.project(x, y);
    c.beginPath();
    if (rand() < 0.4) {
      c.ellipse(a.x, a.y, 5 * a.s, 3.2 * a.s, 0, Math.PI, 0);
      c.fillStyle = rgba(P.stone);
    } else {
      c.arc(a.x, a.y - 3 * a.s, 5 * a.s, 0, Math.PI * 2);
      c.arc(a.x + 5 * a.s, a.y - 2 * a.s, 4 * a.s, 0, Math.PI * 2);
      c.fillStyle = rgba(P.leafDark);
    }
    c.fill();
  }
  // The river along the left, from the mountains to the front.
  const river = riverPath(V);
  c.beginPath();
  river.left.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
  [...river.right].reverse().forEach((p) => c.lineTo(p.x, p.y));
  c.closePath();
  c.fillStyle = rgba(P.water);
  c.fill();
  c.strokeStyle = rgba(mix(P.path, P.text, 0.2), 0.5);
  c.lineWidth = 2;
  c.stroke();
  // Roads: every place joined to its nearest neighbour (a minimum spanning tree), cobbled.
  const lanterns = [];
  for (const [from, p] of roads(places)) {
    const g0 = V.project(from.x, from.y);
    const q = V.project(p.x, p.y);
    const bend = ((hash(p.id) % 100) / 100 - 0.5) * 80;
    const cx = (g0.x + q.x) / 2 + bend * V.base;
    const cy = (g0.y + q.y) / 2 - Math.abs(bend) * 0.2 * V.base;
    const width = 12 * ((g0.s + q.s) / 2);
    for (const [wd, color, dash] of [[width + 4, mix(P.path, P.bg, 0.4), null], [width, P.path, null], [width * 0.6, mix(P.path, P.text, 0.18), [2, 7]]]) {
      c.beginPath();
      c.moveTo(g0.x, g0.y + 8);
      c.quadraticCurveTo(cx, cy, q.x, q.y + 8 * q.s);
      c.strokeStyle = rgba(color, dash ? 0.5 : 1);
      c.lineWidth = wd;
      c.lineCap = 'round';
      c.setLineDash(dash || []);
      c.stroke();
    }
    c.setLineDash([]);
    // A lantern halfway.
    const t = 0.55;
    const lx = (1 - t) ** 2 * g0.x + 2 * (1 - t) * t * cx + t * t * q.x + width * 0.9;
    const ly = (1 - t) ** 2 * (g0.y + 8) + 2 * (1 - t) * t * cy + t * t * (q.y + 8 * q.s);
    const ls = (g0.s + q.s) / 2;
    lanterns.push({ x: lx, y: ly - 22 * ls, s: ls });
    c.strokeStyle = rgba(P.woodDark);
    c.lineWidth = 2 * ls;
    c.beginPath();
    c.moveTo(lx, ly);
    c.lineTo(lx, ly - 20 * ls);
    c.stroke();
    c.fillStyle = rgba(P.stoneDark);
    c.fillRect(lx - 3 * ls, ly - 25 * ls, 6 * ls, 6 * ls);
  }
  // Trees: a forest along the edges and a few in between, clear of the places.
  const trees = [];
  for (let i = 0; i < 260 && trees.length < (lite ? 40 : 70); i++) {
    const x = rand();
    const y = rand() * 1.05 - 0.03;
    const edge = x < 0.1 || x > 0.93 || y < 0.03;
    if (!edge && rand() > 0.12) continue;
    if (places.some((p) => Math.hypot((p.x - x) * 1.3, p.y - y) < 0.12)) continue;
    if (x < 0.13 && Math.abs(x - river.at(y)) < 0.05) continue;
    trees.push({ x, y, kind: rand() < 0.5 ? 'pine' : 'round', k: 0.8 + rand() * 0.5 });
  }
  trees.sort((a, b) => a.y - b.y).forEach((t) => tree(c, V.project(t.x, t.y), t, P));
  cache = { key, canvas: cv, lanterns, river };
  return cache;
}

// Prim's algorithm from the Garden: the shortest set of roads that reaches every place.
function roads(places) {
  const start = places.find((p) => p.id === 'garden') || places[0];
  const inTree = [start];
  const out = [];
  const rest = places.filter((p) => p !== start);
  const dist = (a, b) => Math.hypot((a.x - b.x) * 1.4, a.y - b.y);
  while (rest.length) {
    let best = null;
    for (const a of inTree) for (const b of rest) if (!best || dist(a, b) < best.d) best = { a, b, d: dist(a, b) };
    out.push([best.a, best.b]);
    inTree.push(best.b);
    rest.splice(rest.indexOf(best.b), 1);
  }
  return out;
}

function riverPath(V) {
  const at = (y) => 0.055 + Math.sin(y * 5.2 + 0.6) * 0.025 - y * 0.03;
  const left = [];
  const right = [];
  for (let i = 0; i <= 24; i++) {
    const y = -0.11 + (i / 24) * 1.25;
    const p = V.project(at(y), y);
    const half = (5 + 26 * Math.max(0, y + 0.1)) * p.s;
    left.push({ x: p.x - half, y: p.y });
    right.push({ x: p.x + half, y: p.y });
  }
  return { at, left, right, center: left.map((p, i) => ({ x: (p.x + right[i].x) / 2, y: p.y, w: right[i].x - p.x })) };
}

function tree(c, p, t, P) {
  const s = p.s * t.k;
  c.fillStyle = rgba(P.bg, 0.25);
  c.beginPath();
  c.ellipse(p.x + 4 * s, p.y, 13 * s, 4 * s, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = rgba(P.woodDark);
  c.fillRect(p.x - 2 * s, p.y - 10 * s, 4 * s, 10 * s);
  if (t.kind === 'pine') {
    for (let i = 0; i < 3; i++) {
      const y = p.y - 8 * s - i * 9 * s;
      const w = (16 - i * 4) * s;
      c.beginPath();
      c.moveTo(p.x - w, y);
      c.lineTo(p.x, y - 16 * s);
      c.lineTo(p.x + w, y);
      c.closePath();
      c.fillStyle = rgba(i % 2 ? P.leaf : P.leafDark);
      c.fill();
    }
  } else {
    for (const [dx, dy, r, col] of [[-6, -16, 9, P.leafDark], [6, -17, 9, P.leafDark], [0, -24, 11, P.leaf], [-3, -27, 6, mix(P.leaf, P.text, 0.15)]]) {
      c.beginPath();
      c.arc(p.x + dx * s, p.y + dy * s, r * s, 0, Math.PI * 2);
      c.fillStyle = rgba(col);
      c.fill();
    }
  }
}

// ------------------------------------------------------------ sky
function sky(c, V, P, m, night, weather, t) {
  const dusk = duskAt(m);
  const g = c.createLinearGradient(0, 0, 0, V.horizon + 4);
  const top = mix(mix(P.c1, P.bg, 0.55), P.bg, 0.15 + night * 0.8);
  const low = mix(mix(P.c1, P.text, 0.3), P.bg, 0.35 + night * 0.6);
  g.addColorStop(0, rgba(top));
  g.addColorStop(1, rgba(dusk > 0 ? mix(low, P.c3, dusk * 0.45) : low));
  c.fillStyle = g;
  c.fillRect(0, 0, V.w, V.horizon + 4);
  // Sun by day, moon by night, along an arc.
  const h = m / 60;
  if (h >= 5.5 && h <= 21) {
    const k = (h - 5.5) / 15.5;
    const x = V.w * (0.08 + 0.84 * k);
    const y = V.horizon - Math.sin(k * Math.PI) * V.horizon * 0.85 + 6;
    const glow = c.createRadialGradient(x, y, 2, x, y, 60 * V.base);
    glow.addColorStop(0, rgba(mix(P.warn, P.text, 0.4), weather === 'clear' ? 0.9 : 0.5));
    glow.addColorStop(1, rgba(P.warn, 0));
    c.fillStyle = glow;
    c.fillRect(x - 60 * V.base, y - 60 * V.base, 120 * V.base, 120 * V.base);
    c.beginPath();
    c.arc(x, y, 11 * V.base, 0, Math.PI * 2);
    c.fillStyle = rgba(mix(P.warn, P.text, 0.5), weather === 'clear' ? 1 : 0.55);
    c.fill();
  }
  if (night > 0.2) {
    const k = ((h + 24 - 19) % 24) / 11;
    const x = V.w * (0.1 + 0.8 * Math.min(1, k));
    const y = V.horizon * 0.25 + Math.abs(k - 0.5) * V.horizon * 0.5;
    c.beginPath();
    c.arc(x, y, 9 * V.base, 0, Math.PI * 2);
    c.fillStyle = rgba(mix(P.text, P.c1, 0.15), 0.85 * night);
    c.fill();
    c.beginPath();
    c.arc(x + 4 * V.base, y - 2 * V.base, 8 * V.base, 0, Math.PI * 2);
    c.fillStyle = rgba(top, night);
    c.fill();
  }
  // Ordinary stars, then your skills as constellations (bright when mastered).
  if (night > 0.05) {
    const r = rng(42);
    for (let i = 0; i < 70; i++) {
      const x = r() * V.w;
      const y = r() * V.horizon * 0.9;
      const tw = 0.6 + 0.4 * Math.sin(t / 900 + i * 2.1);
      c.fillStyle = rgba(P.text, 0.35 * night * tw);
      c.fillRect(x, y, 1.2, 1.2);
    }
  }
  // Clouds: a few on clear days, many when it's grey.
  {
    const n = weather === 'clear' ? 3 : weather === 'cloudy' || weather === 'rain' ? 7 : 4;
    const r = rng(11);
    for (let i = 0; i < n; i++) {
      const speed = 4 + r() * 6;
      const x = ((r() * V.w + (t / 1000) * speed) % (V.w + 200)) - 100;
      const y = V.horizon * (0.15 + r() * 0.55);
      const k = (0.7 + r() * 0.8) * V.base;
      const col = weather === 'rain' ? mix(P.text, P.bg, 0.65) : mix(P.text, P.bg, 0.35 + night * 0.4);
      c.fillStyle = rgba(col, weather === 'clear' ? 0.25 : 0.5);
      for (const [dx, dy, rr] of [[0, 0, 16], [16, -5, 13], [-16, -3, 12], [30, 2, 10], [-28, 3, 9]]) {
        c.beginPath();
        c.arc(x + dx * k, y + dy * k, rr * k, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
}

// Your skill tree as constellations, over the mountains: brighter with progress, mastered ones glow
// and are named at night; lines join a skill to what it builds on.
function constellations(c, V, P, night, skills, t, labels) {
  const pos = new Map();
  for (const sk of skills) {
    const r = rng(hash(sk.name));
    pos.set(sk.name, { x: V.w * (0.4 + r() * 0.56), y: V.horizon * (0.12 + r() * 0.5), sk });
  }
  // Spread stars that landed too close, so their names stay readable.
  const list = [...pos.values()];
  const gap = 95 * V.base;
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x || 1;
        const dy = (b.y - a.y) * 2.5;
        const d = Math.hypot(dx, dy);
        if (d >= gap) continue;
        const push = (gap - d) / 2;
        a.x -= (dx / d) * push;
        b.x += (dx / d) * push;
        a.y -= (dy / d) * push * 0.2;
        b.y += (dy / d) * push * 0.2;
      }
    }
    for (const p of list) {
      p.x = Math.max(V.w * 0.38, Math.min(V.w * 0.97, p.x));
      p.y = Math.max(V.horizon * 0.1, Math.min(V.horizon * 0.65, p.y));
    }
  }
  const vis = Math.max(0.12, night);
  c.lineWidth = 1;
  for (const { x, y, sk } of pos.values()) {
    for (const n of sk.needs || []) {
      const q = pos.get(n);
      if (!q) continue;
      c.strokeStyle = rgba(P.c1, 0.35 * vis);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(q.x, q.y);
      c.stroke();
    }
  }
  for (const { x, y, sk } of pos.values()) {
    const bright = sk.state === 'mastered' ? 1 : sk.state === 'locked' ? 0.25 : 0.4 + sk.progress * 0.5;
    const rad = (2 + bright * 3) * V.base;
    const tw = 0.85 + 0.15 * Math.sin(t / 700 + x);
    if (sk.state !== 'locked') {
      const gl = c.createRadialGradient(x, y, 0, x, y, rad * 5);
      gl.addColorStop(0, rgba(P.c1, (sk.state === 'mastered' ? 0.55 : 0.25) * vis));
      gl.addColorStop(1, rgba(P.c1, 0));
      c.fillStyle = gl;
      c.fillRect(x - rad * 5, y - rad * 5, rad * 10, rad * 10);
    }
    c.beginPath();
    c.arc(x, y, rad, 0, Math.PI * 2);
    c.fillStyle = rgba(sk.state === 'mastered' ? mix(P.c1, P.text, 0.5) : P.text, bright * vis * tw);
    c.fill();
    labels.stars.push({ x, y, r: rad + 6, name: sk.name, state: sk.state, progress: sk.progress });
    if (sk.state !== 'locked' && night > 0.5) {
      c.font = `${sk.state === 'mastered' ? '600 ' : ''}${Math.round(10.5 * V.base)}px ${P.body}`;
      c.textAlign = 'center';
      c.fillStyle = rgba(P.text, (sk.state === 'mastered' ? 0.85 : 0.5) * night);
      c.fillText(sk.name, x, y - rad - 5);
    }
  }
}

// ------------------------------------------------------------ building blocks
// A box seen from the front-left: front face, a side face going back to the right, a gabled roof.
function house(c, x, y, w, h, d, wall, roof, P, { roofH = 0.6, sideShade = 0.25, roofColor } = {}) {
  const side = mix(wall, P.bg, sideShade);
  // Side face.
  c.beginPath();
  c.moveTo(x + w / 2, y);
  c.lineTo(x + w / 2 + d, y - d * 0.5);
  c.lineTo(x + w / 2 + d, y - h - d * 0.5);
  c.lineTo(x + w / 2, y - h);
  c.closePath();
  c.fillStyle = rgba(side);
  c.fill();
  // Front face.
  c.fillStyle = rgba(wall);
  c.fillRect(x - w / 2, y - h, w, h);
  // Roof: the gable at the front, the slope going back.
  const rh = w * roofH;
  const rc = roofColor || roof;
  c.beginPath();
  c.moveTo(x - w / 2 - 3, y - h);
  c.lineTo(x, y - h - rh);
  c.lineTo(x + d, y - h - rh - d * 0.5);
  c.lineTo(x + w / 2 + d + 3, y - h - d * 0.5);
  c.lineTo(x + w / 2 + 3, y - h);
  c.closePath();
  c.fillStyle = rgba(mix(rc, P.bg, 0.2));
  c.fill();
  c.beginPath();
  c.moveTo(x - w / 2 - 3, y - h);
  c.lineTo(x, y - h - rh);
  c.lineTo(x + w / 2 + 3, y - h);
  c.closePath();
  c.fillStyle = rgba(rc);
  c.fill();
  c.strokeStyle = rgba(P.bg, 0.35);
  c.lineWidth = 1;
  c.stroke();
  return { top: y - h - rh - d * 0.5 };
}

function windowAt(c, x, y, w, h, F, lit = true) {
  const on = lit ? F.lamps : 0;
  c.fillStyle = on > 0.05 ? rgba(mix(F.P.warn, F.P.text, 0.25), 0.55 + on * 0.45) : rgba(F.P.bg, 0.55);
  c.fillRect(x, y, w, h);
  if (on > 0.05) F.lights.push({ x: x + w / 2, y: y + h / 2, r: 18 * F.s, a: on * 0.6, tone: F.P.warn });
}

function door(c, x, y, w, h, P) {
  c.fillStyle = rgba(P.woodDark);
  c.beginPath();
  c.moveTo(x - w / 2, y);
  c.lineTo(x - w / 2, y - h + w / 2);
  c.arc(x, y - h + w / 2, w / 2, Math.PI, 0);
  c.lineTo(x + w / 2, y);
  c.closePath();
  c.fill();
}

function shadow(c, x, y, rx, ry, P) {
  c.beginPath();
  c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  c.fillStyle = rgba(P.bg, 0.3);
  c.fill();
}

function smoke(c, x, y, F, n = 5, color) {
  if (!F.anim) return;
  for (let i = 0; i < n; i++) {
    const k = ((F.t / 2600 + i / n) % 1);
    c.beginPath();
    c.arc(x + Math.sin(k * 6 + i) * 5 * F.s + k * 14 * F.s, y - k * 46 * F.s, (2 + k * 7) * F.s, 0, Math.PI * 2);
    c.fillStyle = rgba(color || mix(F.P.text, F.P.bg, 0.45), 0.35 * (1 - k));
    c.fill();
  }
}

function sparks(c, x, y, F, n = 8) {
  if (!F.anim) return;
  for (let i = 0; i < n; i++) {
    const k = ((F.t / 900 + i / n) % 1);
    const a = (hash(`s${i}`) % 628) / 100;
    c.fillStyle = rgba(mix(F.P.warn, F.P.err, 0.3), 1 - k);
    c.fillRect(x + Math.cos(a) * k * 18 * F.s, y - k * 26 * F.s + Math.sin(a) * 4, 2, 2);
  }
  F.lights.push({ x, y, r: 30 * F.s, a: 0.5, tone: F.P.warn });
}

function flag(c, x, y, h, color, F, raised = 1) {
  c.strokeStyle = rgba(F.P.woodDark);
  c.lineWidth = 1.5 * F.s;
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x, y - h);
  c.stroke();
  const fy = y - h + (1 - raised) * h * 0.6;
  const wave = F.anim ? Math.sin(F.t / 300 + x) * 2 * F.s : 0;
  c.beginPath();
  c.moveTo(x, fy);
  c.quadraticCurveTo(x + 7 * F.s, fy + wave, x + 14 * F.s, fy + 3 * F.s);
  c.lineTo(x, fy + 8 * F.s);
  c.closePath();
  c.fillStyle = rgba(color);
  c.fill();
}

function construction(c, x, y, F) {
  const { s, P } = F;
  c.setLineDash([3, 4]);
  c.strokeStyle = rgba(P.text, 0.35);
  c.beginPath();
  c.ellipse(x, y, 30 * s, 10 * s, 0, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  // Scaffolding and a pile of stones and planks.
  c.strokeStyle = rgba(P.wood, 0.9);
  c.lineWidth = 1.5 * s;
  for (const dx of [-16, 0, 16]) {
    c.beginPath();
    c.moveTo(x + dx * s, y);
    c.lineTo(x + dx * s, y - 30 * s);
    c.stroke();
  }
  c.beginPath();
  c.moveTo(x - 18 * s, y - 15 * s);
  c.lineTo(x + 18 * s, y - 15 * s);
  c.moveTo(x - 18 * s, y - 28 * s);
  c.lineTo(x + 18 * s, y - 28 * s);
  c.moveTo(x - 16 * s, y);
  c.lineTo(x, y - 28 * s);
  c.stroke();
  for (let i = 0; i < 5; i++) {
    c.fillStyle = rgba(i % 2 ? P.stone : P.stoneDark);
    c.fillRect(x + 20 * s + (i % 3) * 6 * s, y - 4 * s - Math.floor(i / 3) * 5 * s, 6 * s, 4 * s);
  }
  return { top: y - 34 * s };
}

// ------------------------------------------------------------ the places
const BUILD = {
  hearth(c, x, y, F) {
    const { s, P, level } = F;
    const homes = [[0, 0, 1]];
    if (level >= 2) homes.push([-44, 8, 0.8]);
    if (level >= 3) homes.push([44, 10, 0.85]);
    let top = y;
    for (const [dx, dy, k] of homes.sort((a, b) => a[1] - b[1])) {
      const hx = x + dx * s;
      const hy = y + dy * s;
      shadow(c, hx + 6 * s, hy, 30 * s * k, 8 * s, P);
      const r = house(c, hx, hy, 40 * s * k, 26 * s * k, 14 * s * k, P.wood, F.roof, P);
      // Chimney with smoke.
      c.fillStyle = rgba(P.stoneDark);
      c.fillRect(hx + 8 * s * k, hy - 26 * s * k - 18 * s * k, 6 * s * k, 14 * s * k);
      smoke(c, hx + 11 * s * k, hy - 46 * s * k, F, 5);
      door(c, hx - 6 * s * k, hy, 8 * s * k, 13 * s * k, P);
      windowAt(c, hx + 4 * s * k, hy - 18 * s * k, 7 * s * k, 6 * s * k, F);
      top = Math.min(top, r.top);
    }
    if (level >= 3) {
      // A well.
      c.fillStyle = rgba(P.stone);
      c.fillRect(x - 6 * s, y + 18 * s, 12 * s, 6 * s);
      c.strokeStyle = rgba(P.woodDark);
      c.beginPath();
      c.moveTo(x - 6 * s, y + 18 * s);
      c.lineTo(x - 6 * s, y + 8 * s);
      c.lineTo(x + 6 * s, y + 8 * s);
      c.lineTo(x + 6 * s, y + 18 * s);
      c.stroke();
    }
    return { top };
  },

  library(c, x, y, F) {
    const { s, P, level, details } = F;
    if (level >= 2) house(c, x - 30 * s, y + 4 * s, 34 * s, 22 * s, 12 * s, P.stone, F.roof, P);
    shadow(c, x + 6 * s, y, 26 * s, 8 * s, P);
    const th = (54 + level * 18) * s;
    const tw = 28 * s;
    c.fillStyle = rgba(mix(P.stone, P.bg, 0.2));
    c.fillRect(x + tw / 2, y - th - 6 * s, 9 * s, th + 6 * s);
    c.fillStyle = rgba(P.stone);
    c.fillRect(x - tw / 2, y - th, tw, th);
    // Stone courses.
    c.strokeStyle = rgba(P.bg, 0.15);
    for (let yy = y - 8 * s; yy > y - th; yy -= 8 * s) {
      c.beginPath();
      c.moveTo(x - tw / 2, yy);
      c.lineTo(x + tw / 2, yy);
      c.stroke();
    }
    // A window per topic you track (up to the tower's height), lit.
    const topics = details.topics?.length || 1;
    const rows = Math.min(Math.floor((th - 20 * s) / (14 * s)), Math.ceil(topics / 2));
    for (let i = 0; i < Math.min(topics, rows * 2); i++) windowAt(c, x - 9 * s + (i % 2) * 11 * s, y - 24 * s - Math.floor(i / 2) * 14 * s, 6 * s, 9 * s, F);
    door(c, x, y, 10 * s, 16 * s, P);
    // Conical roof.
    c.beginPath();
    c.moveTo(x - tw / 2 - 5 * s, y - th);
    c.lineTo(x + 2 * s, y - th - (30 + level * 6) * s);
    c.lineTo(x + tw / 2 + 14 * s, y - th - 6 * s);
    c.closePath();
    c.fillStyle = rgba(F.roof);
    c.fill();
    const tip = y - th - (30 + level * 6) * s;
    if (level >= 3) {
      c.beginPath();
      c.arc(x + 2 * s, tip - 5 * s, 4 * s, 0, Math.PI * 2);
      c.fillStyle = rgba(mix(P.c1, P.text, 0.4));
      c.fill();
      F.lights.push({ x: x + 2 * s, y: tip - 5 * s, r: 40 * s, a: 0.8, tone: P.c1, always: true });
    }
    // Glowing books for concepts understood, circling the tower.
    const books = Math.min(14, details.topics?.reduce((n, t) => n + t.understood, 0) || 0);
    for (let i = 0; i < books; i++) {
      const a = (F.anim ? F.t / 4000 : 0) + (i / books) * Math.PI * 2;
      const bx = x + Math.cos(a) * (tw + 10 * s);
      const by = y - th * 0.55 + Math.sin(a) * 8 * s - i * 0.6 * s;
      c.fillStyle = rgba(i % 3 === 0 ? P.c1 : i % 3 === 1 ? P.c2 : P.warn, 0.85);
      c.fillRect(bx - 3 * s, by - 2 * s, 6 * s, 4 * s);
      if (F.lamps > 0.3) F.lights.push({ x: bx, y: by, r: 8 * s, a: 0.4, tone: P.c1 });
    }
    return { top: tip - 10 * s };
  },

  cafe(c, x, y, F) {
    const { s, P, level, details } = F;
    const w = (46 + level * 10) * s;
    shadow(c, x + 8 * s, y, w * 0.7, 9 * s, P);
    const r = house(c, x, y, w, 28 * s, 16 * s, mix(P.wood, P.text, 0.15), F.roof, P, { roofH: 0.45 });
    // Striped awning.
    const stripes = 6;
    for (let i = 0; i < stripes; i++) {
      c.fillStyle = rgba(i % 2 ? mix(P.text, P.bg, 0.2) : F.roof);
      c.beginPath();
      const x0 = x - w / 2 + (i * w) / stripes;
      c.moveTo(x0, y - 20 * s);
      c.lineTo(x0 + w / stripes, y - 20 * s);
      c.lineTo(x0 + w / stripes + 2 * s, y - 13 * s);
      c.lineTo(x0 + 2 * s, y - 13 * s);
      c.closePath();
      c.fill();
    }
    windowAt(c, x - w / 2 + 6 * s, y - 12 * s, 9 * s, 8 * s, F);
    windowAt(c, x + w / 2 - 15 * s, y - 12 * s, 9 * s, 8 * s, F);
    door(c, x, y, 9 * s, 12 * s, P);
    // A table for each deck, out front.
    const tables = Math.min(4, Math.max(1, details.decks?.length || 0));
    for (let i = 0; i < tables; i++) {
      const tx = x - w / 2 + 6 * s + i * 16 * s;
      const ty = y + 12 * s + (i % 2) * 5 * s;
      c.fillStyle = rgba(P.woodDark);
      c.fillRect(tx - 1, ty - 6 * s, 2, 6 * s);
      c.beginPath();
      c.ellipse(tx, ty - 6 * s, 6 * s, 2.5 * s, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.wood);
      c.fill();
      c.beginPath();
      c.arc(tx, ty - 9 * s, 1.5 * s, 0, Math.PI * 2);
      c.fillStyle = rgba(P.c3);
      c.fill();
    }
    // A string of lanterns.
    for (let i = 0; i < 5; i++) {
      const lx = x - w / 2 - 6 * s + i * ((w + 12 * s) / 4);
      const ly = y - 22 * s + Math.sin((i / 4) * Math.PI) * 4 * s;
      c.fillStyle = rgba(i % 2 ? P.warn : P.c3, 0.9);
      c.fillRect(lx - 1.5 * s, ly, 3 * s, 4 * s);
      if (F.lamps > 0.1) F.lights.push({ x: lx, y: ly + 2 * s, r: 14 * s, a: F.lamps * 0.7, tone: i % 2 ? P.warn : P.c3 });
    }
    return r;
  },

  workshop(c, x, y, F) {
    const { s, P, level } = F;
    shadow(c, x + 8 * s, y, 34 * s, 9 * s, P);
    const r = house(c, x, y, (44 + level * 6) * s, 24 * s, 16 * s, P.stoneDark, F.roof, P, { roofH: 0.4 });
    // Open forge front with fire.
    c.fillStyle = rgba(P.bg, 0.8);
    c.fillRect(x - 14 * s, y - 16 * s, 20 * s, 16 * s);
    const fire = F.live ? 1 : 0.35 + level * 0.1;
    c.fillStyle = rgba(mix(P.warn, P.err, 0.4), fire);
    c.beginPath();
    c.ellipse(x - 4 * s, y - 4 * s, 7 * s, (3 + (F.anim ? Math.sin(F.t / 120) : 0)) * s, 0, 0, Math.PI * 2);
    c.fill();
    F.lights.push({ x: x - 4 * s, y: y - 6 * s, r: (F.live ? 46 : 26) * s, a: fire * 0.8, tone: P.warn, always: true });
    // Chimney: smoke, and sparks while the assistant works here.
    c.fillStyle = rgba(P.stone);
    c.fillRect(x + 10 * s, y - 50 * s, 8 * s, 22 * s);
    smoke(c, x + 14 * s, y - 52 * s, F, F.live ? 8 : 4, F.live ? mix(P.text, P.bg, 0.3) : null);
    if (F.live) sparks(c, x + 14 * s, y - 52 * s, F);
    // Anvil outside, and crates at higher levels.
    c.fillStyle = rgba(P.stoneDark);
    c.fillRect(x + 18 * s, y + 4 * s, 10 * s, 4 * s);
    c.fillRect(x + 21 * s, y + 8 * s, 4 * s, 5 * s);
    for (let i = 0; i < level; i++) {
      c.fillStyle = rgba(i % 2 ? P.wood : P.woodDark);
      c.fillRect(x - 32 * s - i * 9 * s, y + 2 * s - (i % 2) * 7 * s, 8 * s, 7 * s);
    }
    return r;
  },

  garden(c, x, y, F) {
    const { s, P, level, details } = F;
    // The plaza.
    c.beginPath();
    c.ellipse(x, y, 62 * s, 22 * s, 0, 0, Math.PI * 2);
    c.fillStyle = rgba(P.path);
    c.fill();
    c.strokeStyle = rgba(mix(P.path, P.text, 0.2), 0.5);
    c.setLineDash([2, 5]);
    c.beginPath();
    c.ellipse(x, y, 48 * s, 16 * s, 0, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    // Flowers: one blooms for each habit kept today; buds for the rest.
    const habits = details.habits || [];
    const n = Math.max(habits.length, 6);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const fx = x + Math.cos(a) * 70 * s;
      const fy = y + Math.sin(a) * 26 * s;
      const h = habits[i];
      c.strokeStyle = rgba(P.leaf);
      c.beginPath();
      c.moveTo(fx, fy);
      c.lineTo(fx, fy - 7 * s);
      c.stroke();
      const bloom = h ? h.done : level >= 2;
      const col = [P.c3, P.warn, P.c2, P.c1][i % 4];
      if (bloom) {
        for (let k = 0; k < 5; k++) {
          const pa = (k / 5) * Math.PI * 2 + (F.anim ? F.t / 3000 : 0);
          c.beginPath();
          c.arc(fx + Math.cos(pa) * 2.6 * s, fy - 8 * s + Math.sin(pa) * 2.6 * s, 2 * s, 0, Math.PI * 2);
          c.fillStyle = rgba(col);
          c.fill();
        }
        c.beginPath();
        c.arc(fx, fy - 8 * s, 1.5 * s, 0, Math.PI * 2);
        c.fillStyle = rgba(P.warn);
        c.fill();
      } else {
        c.beginPath();
        c.arc(fx, fy - 8 * s, 2 * s, 0, Math.PI * 2);
        c.fillStyle = rgba(P.leafDark);
        c.fill();
      }
    }
    // Benches.
    for (const dx of [-40, 40]) {
      c.fillStyle = rgba(P.wood);
      c.fillRect(x + dx * s - 8 * s, y + 10 * s, 16 * s, 3 * s);
    }
    let top = y - 10 * s;
    if (level >= 3) {
      // An old tree in the middle.
      tree(c, { x: x - 30 * s, y: y - 6 * s, s: s * 1.4 }, { kind: 'round', k: 1 }, P);
    }
    // The fountain.
    c.beginPath();
    c.ellipse(x, y, 18 * s, 7 * s, 0, 0, Math.PI * 2);
    c.fillStyle = rgba(P.stone);
    c.fill();
    c.beginPath();
    c.ellipse(x, y - 2 * s, 14 * s, 5 * s, 0, 0, Math.PI * 2);
    c.fillStyle = rgba(P.water);
    c.fill();
    c.fillStyle = rgba(P.stone);
    c.fillRect(x - 2 * s, y - 16 * s, 4 * s, 14 * s);
    for (let i = 0; i < 6; i++) {
      const k = F.anim ? ((F.t / 800 + i / 6) % 1) : 0.5;
      const dir = i % 2 ? 1 : -1;
      c.beginPath();
      c.arc(x + dir * k * 12 * s, y - 16 * s + (k * k * 14 - k * 6) * s, 1.3 * s, 0, Math.PI * 2);
      c.fillStyle = rgba(mix(P.water, P.text, 0.5), 0.8);
      c.fill();
    }
    top = Math.min(top, y - 24 * s);
    return { top };
  },

  grounds(c, x, y, F) {
    const { s, P, level, details } = F;
    // A fenced yard.
    const w = 70 * s;
    const d = 20 * s;
    c.beginPath();
    c.ellipse(x, y, w * 0.6, d * 0.9, 0, 0, Math.PI * 2);
    c.fillStyle = rgba(mix(P.path, P.grass, 0.4), 0.8);
    c.fill();
    c.strokeStyle = rgba(P.wood);
    c.lineWidth = 1.4 * s;
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI;
      const px = x + Math.cos(a) * w * 0.62;
      const py = y + Math.sin(a) * d;
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(px, py - 8 * s);
      c.stroke();
    }
    c.beginPath();
    c.ellipse(x, y - 6 * s, w * 0.62, d, 0, 0, Math.PI);
    c.stroke();
    // A banner for each habit: high when kept today; flames for long streaks.
    const habits = details.habits?.length ? details.habits : [{ name: '', done: false, streak: 0, unit: 'd' }];
    const n = Math.min(habits.length, 8);
    let top = y - 50 * s;
    for (let i = 0; i < n; i++) {
      const h = habits[i];
      const fx = x - w * 0.45 + (i + 0.5) * ((w * 0.9) / n);
      const fy = y - 4 * s - (i % 2) * 6 * s;
      const col = [P.c1, P.c3, P.ok, P.warn, P.c2][i % 5];
      flag(c, fx, fy, 38 * s, col, F, h.done ? 1 : 0.15);
      const days = h.unit === 'wk' ? h.streak * 7 : h.streak;
      const flames = days >= 30 ? 2 : days >= 7 ? 1 : 0;
      for (let k = 0; k < flames; k++) {
        const fl = F.anim ? Math.sin(F.t / 140 + i + k) : 0;
        c.beginPath();
        c.ellipse(fx + k * 5 * s, fy - 44 * s, 2 * s, (4 + fl) * s, 0, 0, Math.PI * 2);
        c.fillStyle = rgba(mix(P.warn, P.err, 0.3));
        c.fill();
        F.lights.push({ x: fx, y: fy - 44 * s, r: 12 * s, a: 0.6, tone: P.warn, always: true });
      }
    }
    if (level >= 2) {
      // A training dummy.
      c.fillStyle = rgba(P.wood);
      c.fillRect(x + w * 0.4, y - 18 * s, 3 * s, 18 * s);
      c.fillRect(x + w * 0.4 - 6 * s, y - 14 * s, 15 * s, 3 * s);
      c.beginPath();
      c.arc(x + w * 0.4 + 1.5 * s, y - 21 * s, 4 * s, 0, Math.PI * 2);
      c.fill();
    }
    return { top };
  },

  observatory(c, x, y, F) {
    const { s, P, level } = F;
    // A hill.
    c.beginPath();
    c.ellipse(x, y + 2 * s, 54 * s, 18 * s, 0, Math.PI, 0);
    c.fillStyle = rgba(P.leafDark);
    c.fill();
    const by = y - 10 * s;
    const w = (30 + level * 4) * s;
    const h = (18 + level * 6) * s;
    shadow(c, x + 6 * s, by, w * 0.7, 6 * s, P);
    c.fillStyle = rgba(P.stone);
    c.fillRect(x - w / 2, by - h, w, h);
    c.fillStyle = rgba(mix(P.stone, P.bg, 0.25));
    c.fillRect(x + w / 2, by - h - 3 * s, 6 * s, h + 3 * s);
    windowAt(c, x - 4 * s, by - h + 6 * s, 6 * s, 8 * s, F);
    // The dome with its slit and telescope.
    c.beginPath();
    c.ellipse(x + 3 * s, by - h, w / 2 + 3 * s, w / 2.2, 0, Math.PI, 0);
    c.fillStyle = rgba(F.roof);
    c.fill();
    const aim = F.anim ? Math.sin(F.t / 6000) * 0.4 : 0;
    c.save();
    c.translate(x + 3 * s, by - h - w / 4);
    c.rotate(-0.7 + aim);
    c.fillStyle = rgba(P.stoneDark);
    c.fillRect(0, -2.5 * s, 22 * s, 5 * s);
    c.restore();
    c.strokeStyle = rgba(P.bg, 0.5);
    c.lineWidth = 2 * s;
    c.beginPath();
    c.moveTo(x + 3 * s, by - h);
    c.lineTo(x + 3 * s, by - h - w / 2.2);
    c.stroke();
    if (level >= 3) F.lights.push({ x: x + 3 * s, y: by - h - w / 3, r: 30 * s, a: 0.5, tone: P.c2, always: true });
    return { top: by - h - w / 2 - 14 * s };
  },

  archive(c, x, y, F) {
    const { s, P, level, details } = F;
    const cols = 3 + level;
    const w = (cols * 11 + 8) * s;
    const h = 28 * s;
    shadow(c, x + 6 * s, y, w * 0.65, 8 * s, P);
    // Steps.
    for (let i = 0; i < 3; i++) {
      c.fillStyle = rgba(mix(P.stone, P.bg, i * 0.1));
      c.fillRect(x - w / 2 - (3 - i) * 3 * s, y - i * 3 * s, w + (3 - i) * 6 * s, 3 * s);
    }
    c.fillStyle = rgba(mix(P.stone, P.bg, 0.35));
    c.fillRect(x - w / 2 + 4 * s, y - 9 * s - h, w - 8 * s, h);
    // A lit slit for every few memories.
    const slits = Math.min(cols, Math.ceil((details.memories + details.records) / 5));
    for (let i = 0; i < slits; i++) windowAt(c, x - w / 2 + 9 * s + i * 11 * s, y - 9 * s - h + 8 * s, 4 * s, 12 * s, F);
    // Columns.
    for (let i = 0; i < cols; i++) {
      const cx = x - w / 2 + 4 * s + i * ((w - 8 * s) / (cols - 1));
      c.fillStyle = rgba(mix(P.stone, P.text, 0.12));
      c.fillRect(cx - 2.5 * s, y - 9 * s - h, 5 * s, h);
    }
    // Entablature and pediment.
    c.fillStyle = rgba(P.stone);
    c.fillRect(x - w / 2, y - 9 * s - h - 5 * s, w, 5 * s);
    c.beginPath();
    c.moveTo(x - w / 2 - 2 * s, y - 14 * s - h);
    c.lineTo(x, y - 14 * s - h - 14 * s);
    c.lineTo(x + w / 2 + 2 * s, y - 14 * s - h);
    c.closePath();
    c.fillStyle = rgba(F.roof);
    c.fill();
    return { top: y - h - 30 * s };
  },

  stage(c, x, y, F) {
    const { s, P, level } = F;
    // Tiers of seats, a half bowl facing the stage.
    for (let i = 3; i >= 1; i--) {
      c.beginPath();
      c.ellipse(x, y + 6 * s, (24 + i * 13) * s, (8 + i * 5) * s, 0, 0, Math.PI);
      c.strokeStyle = rgba(mix(P.stone, P.bg, i * 0.1));
      c.lineWidth = 5 * s;
      c.stroke();
    }
    // The stage: a platform, posts and curtains.
    const w = (38 + level * 6) * s;
    c.fillStyle = rgba(P.wood);
    c.fillRect(x - w / 2, y - 6 * s, w, 8 * s);
    c.fillStyle = rgba(P.woodDark);
    c.fillRect(x - w / 2, y - 40 * s, 3 * s, 34 * s);
    c.fillRect(x + w / 2 - 3 * s, y - 40 * s, 3 * s, 34 * s);
    c.fillRect(x - w / 2, y - 42 * s, w, 4 * s);
    const open = F.live ? 0.25 : 0.42;
    c.fillStyle = rgba(F.roof);
    c.fillRect(x - w / 2 + 3 * s, y - 38 * s, w * open, 30 * s);
    c.fillRect(x + w / 2 - 3 * s - w * open, y - 38 * s, w * open, 30 * s);
    if (F.live) {
      // A spotlight while a rehearsal plays.
      c.beginPath();
      c.moveTo(x, y - 60 * s);
      c.lineTo(x - 18 * s, y - 4 * s);
      c.lineTo(x + 18 * s, y - 4 * s);
      c.closePath();
      c.fillStyle = rgba(mix(P.warn, P.text, 0.5), 0.18);
      c.fill();
      F.lights.push({ x, y: y - 10 * s, r: 40 * s, a: 0.7, tone: P.warn, always: true });
    }
    for (let i = 0; i < level; i++) flag(c, x - w / 2 + (i * w) / Math.max(1, level - 1 || 1), y - 42 * s, 10 * s, P.c3, F);
    return { top: y - 56 * s };
  },

  lookout(c, x, y, F) {
    const { s, P, level } = F;
    const h = (66 + level * 14) * s;
    shadow(c, x + 6 * s, y, 18 * s, 6 * s, P);
    c.strokeStyle = rgba(P.wood);
    c.lineWidth = 2.5 * s;
    // Four legs and cross braces.
    for (const [a, b] of [[-12, -7], [12, 7], [-6, -4], [6, 4]]) {
      c.beginPath();
      c.moveTo(x + a * s, y);
      c.lineTo(x + b * s, y - h);
      c.stroke();
    }
    c.lineWidth = 1.2 * s;
    for (let k = 1; k < 4; k++) {
      const yy = y - (h * k) / 4;
      const sp = 12 - k * 1.3;
      c.beginPath();
      c.moveTo(x - sp * s, yy + 10 * s);
      c.lineTo(x + sp * s, yy);
      c.moveTo(x + sp * s, yy + 10 * s);
      c.lineTo(x - sp * s, yy);
      c.stroke();
    }
    // The cabin and its roof.
    c.fillStyle = rgba(P.wood);
    c.fillRect(x - 12 * s, y - h - 14 * s, 24 * s, 14 * s);
    windowAt(c, x - 7 * s, y - h - 11 * s, 14 * s, 6 * s, F);
    c.beginPath();
    c.moveTo(x - 16 * s, y - h - 14 * s);
    c.lineTo(x, y - h - 32 * s);
    c.lineTo(x + 16 * s, y - h - 14 * s);
    c.closePath();
    c.fillStyle = rgba(F.roof);
    c.fill();
    flag(c, x, y - h - 32 * s, 14 * s, P.c2, F);
    if (F.live) F.lights.push({ x, y: y - h - 8 * s, r: 34 * s, a: 0.7, tone: P.c1, always: true });
    // Ravens circling when the assistant is out on the web.
    if (F.live || F.busy) {
      for (let i = 0; i < 3; i++) {
        const a = (F.anim ? F.t / (1400 + i * 300) : i) + i * 2.1;
        const rx = x + Math.cos(a) * (30 + i * 8) * s;
        const ry = y - h - 50 * s + Math.sin(a) * 10 * s;
        const flap = F.anim ? Math.sin(F.t / 120 + i) * 3 * s : 2 * s;
        c.strokeStyle = rgba(P.bg, 0.85);
        c.lineWidth = 1.6 * s;
        c.beginPath();
        c.moveTo(rx - 6 * s, ry - flap);
        c.lineTo(rx, ry);
        c.lineTo(rx + 6 * s, ry - flap);
        c.stroke();
      }
    }
    return { top: y - h - 46 * s };
  },
};

// ------------------------------------------------------------ residents
const HATS = { Wren: 'cap', Bram: 'straw' };

/** A little figure. kind: 'active' (the persona you talk to), 'persona', or a villager. */
function person(c, p, F) {
  const { P } = F;
  const s = p.s * 1.2;
  const x = p.x;
  const walk = p.walking && F.anim ? Math.sin(F.t / 110 + p.i) : 0;
  const bob = F.anim && !p.walking && !p.asleep ? Math.sin(F.t / 600 + p.i * 1.7) * 0.8 * s : 0;
  const y = p.y + bob;
  const col = p.color;
  shadow(c, x, p.y + 1, 7 * s, 2.4 * s, P);
  // Legs.
  c.strokeStyle = rgba(mix(col, P.bg, 0.55));
  c.lineWidth = 2 * s;
  c.beginPath();
  c.moveTo(x - 2 * s, y - 6 * s);
  c.lineTo(x - 2 * s + walk * 2.5 * s, y);
  c.moveTo(x + 2 * s, y - 6 * s);
  c.lineTo(x + 2 * s - walk * 2.5 * s, y);
  c.stroke();
  // Robe.
  c.beginPath();
  c.moveTo(x - 4 * s, y - 17 * s);
  c.lineTo(x + 4 * s, y - 17 * s);
  c.lineTo(x + 6.5 * s, y - 5 * s);
  c.lineTo(x - 6.5 * s, y - 5 * s);
  c.closePath();
  c.fillStyle = rgba(col);
  c.fill();
  c.fillStyle = rgba(mix(col, P.bg, 0.35));
  c.fillRect(x - 6 * s, y - 8 * s, 12 * s, 2 * s);
  // Arms: busy hands when working.
  const arm = p.working && F.anim ? Math.sin(F.t / 90) * 3 * s : walk * 2 * s;
  c.strokeStyle = rgba(mix(col, P.bg, 0.2));
  c.lineWidth = 2 * s;
  c.beginPath();
  c.moveTo(x - 4 * s, y - 15 * s);
  c.lineTo(x - 7 * s, y - 10 * s - arm);
  c.moveTo(x + 4 * s, y - 15 * s);
  c.lineTo(x + 7 * s, y - 10 * s + arm);
  c.stroke();
  // Head.
  c.beginPath();
  c.arc(x, y - 20.5 * s, 4.2 * s, 0, Math.PI * 2);
  c.fillStyle = rgba(P.skin);
  c.fill();
  // Hat.
  const hat = p.kind === 'active' ? 'wizard' : HATS[p.name] || 'hood';
  c.fillStyle = rgba(hat === 'straw' ? mix(P.warn, P.text, 0.3) : hat === 'cap' ? mix(P.bg, P.text, 0.2) : mix(col, P.bg, 0.3));
  c.beginPath();
  if (hat === 'wizard') {
    c.moveTo(x - 6 * s, y - 22 * s);
    c.lineTo(x + 2 * s, y - 36 * s);
    c.lineTo(x + 6 * s, y - 22 * s);
    c.closePath();
    c.fill();
    c.fillRect(x - 7 * s, y - 23 * s, 14 * s, 2 * s);
  } else if (hat === 'straw') {
    c.ellipse(x, y - 23.5 * s, 8 * s, 2.2 * s, 0, 0, Math.PI * 2);
    c.fill();
    c.fillRect(x - 3.5 * s, y - 27 * s, 7 * s, 4 * s);
  } else if (hat === 'cap') {
    c.fillRect(x - 5 * s, y - 26 * s, 10 * s, 3 * s);
    c.fillRect(x - 6.5 * s, y - 27 * s, 13 * s, 1.5 * s);
  } else {
    c.arc(x, y - 21.5 * s, 4.8 * s, Math.PI, 0);
    c.fill();
  }
  // The persona you talk to wears a floating marker.
  if (p.kind === 'active') {
    const my = y - 44 * s + (F.anim ? Math.sin(F.t / 400) * 1.5 * s : 0);
    c.beginPath();
    c.moveTo(x, my - 4 * s);
    c.lineTo(x + 3 * s, my);
    c.lineTo(x, my + 4 * s);
    c.lineTo(x - 3 * s, my);
    c.closePath();
    c.fillStyle = rgba(P.c1);
    c.fill();
    F.lights.push({ x, y: my, r: 12 * s, a: 0.6, tone: P.c1, always: true });
  }
  if (p.asleep) {
    c.font = `${Math.round(9 * s)}px ${P.body}`;
    c.fillStyle = rgba(P.text, 0.6);
    c.fillText('z', x + 6 * s, y - 28 * s);
  }
  if (p.working) sparksSmall(c, x + 8 * s, y - 12 * s, F);
  if (p.thinking) thought(c, x, y - 30 * s, s, F);
  return { x, y: y - 12 * s, r: 14 * s, top: y - 30 * s };
}

function sparksSmall(c, x, y, F) {
  const n = 4;
  for (let i = 0; i < n; i++) {
    const k = F.anim ? (F.t / 600 + i / n) % 1 : i / n;
    c.fillStyle = rgba(F.P.c1, 1 - k);
    c.fillRect(x + Math.cos(i * 1.7) * k * 9, y - k * 12, 2, 2);
  }
}

function thought(c, x, y, s, F) {
  const k = F.anim ? Math.floor(F.t / 400) % 4 : 3;
  c.fillStyle = rgba(F.P.text, 0.85);
  for (let i = 0; i < 3; i++) {
    c.globalAlpha = i < k ? 1 : 0.3;
    c.beginPath();
    c.arc(x - 5 * s + i * 5 * s, y - 6 * s, 1.6 * s, 0, Math.PI * 2);
    c.fill();
  }
  c.globalAlpha = 1;
}

// ------------------------------------------------------------ weather and night
function weatherLayer(c, V, P, weather, F) {
  if (weather === 'rain') {
    c.strokeStyle = rgba(mix(P.water, P.text, 0.4), 0.35);
    c.lineWidth = 1;
    const r = rng(5);
    c.beginPath();
    for (let i = 0; i < 140; i++) {
      const x = (r() * V.w + (F.t / 6) * (0.5 + r() * 0.2)) % V.w;
      const y = (r() * V.h + F.t / 2.2) % V.h;
      c.moveTo(x, y);
      c.lineTo(x - 2, y + 9);
    }
    c.stroke();
  } else if (weather === 'snow') {
    const r = rng(6);
    c.fillStyle = rgba(P.text, 0.7);
    for (let i = 0; i < 110; i++) {
      const x = (r() * V.w + Math.sin(F.t / 1500 + i) * 14 + V.w) % V.w;
      const y = (r() * V.h + F.t / 30) % V.h;
      c.fillRect(x, y, 2, 2);
    }
  } else if (weather === 'fog') {
    for (let i = 0; i < 4; i++) {
      const y = V.horizon + (V.h - V.horizon) * (0.15 + i * 0.22);
      const g = c.createLinearGradient(0, y - 30, 0, y + 30);
      g.addColorStop(0, rgba(P.text, 0));
      g.addColorStop(0.5, rgba(P.text, 0.08));
      g.addColorStop(1, rgba(P.text, 0));
      c.fillStyle = g;
      c.fillRect(0, y - 30, V.w, 60);
    }
  }
}

function fireflies(c, V, P, F) {
  const r = rng(13);
  for (let i = 0; i < 26; i++) {
    const p = V.project(r(), 0.3 + r() * 0.7);
    const x = p.x + Math.sin(F.t / 1700 + i) * 18;
    const y = p.y - 10 - Math.cos(F.t / 1300 + i * 2) * 10;
    const a = (0.5 + 0.5 * Math.sin(F.t / 400 + i * 3)) * F.night;
    c.fillStyle = rgba(mix(P.warn, P.ok, 0.4), a);
    c.fillRect(x, y, 2, 2);
  }
}

function nightLight(c, V, P, F) {
  if (F.night <= 0.02 && F.dusk <= 0.02) return;
  // Darken the meadow, then let windows, lanterns and fires glow through.
  c.fillStyle = rgba(P.bg, 0.55 * F.night + 0.08 * F.dusk);
  c.fillRect(0, V.horizon, V.w, V.h - V.horizon);
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (const l of F.lights) {
    const a = l.a * (l.always ? 0.35 + 0.65 * F.night : F.night);
    if (a < 0.02) continue;
    const g = c.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
    g.addColorStop(0, rgba(l.tone, a * 0.55));
    g.addColorStop(1, rgba(l.tone, 0));
    c.fillStyle = g;
    c.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
  }
  c.restore();
}

// ------------------------------------------------------------ the scene
/**
 * Draws everything. scene: { places, details, residents (with x, y, s, color, kind, flags), minute,
 * weather, live: { place } | null, busy: { place: n today }, hover, selected, stage: bool }.
 * Returns hit areas: { places: { id: box }, people: [{ name, x, y, r }], stars: [...] }.
 */
export function drawScene(c, V, P, scene, { t = 0, anim = false, lite = false } = {}) {
  const still = stillLayer(V, P, scene.places, lite);
  const night = nightAt(scene.minute);
  const dusk = duskAt(scene.minute);
  const lamps = Math.min(1, night * 1.3 + dusk * 0.5);
  const labels = { stars: [] };
  const lights = [];
  c.clearRect(0, 0, V.w, V.h);
  sky(c, V, P, scene.minute, night, scene.weather, t);
  c.drawImage(still.canvas, 0, 0, V.w, V.h);
  constellations(c, V, P, night, scene.details?.skills || [], t, labels);
  // The river glints.
  if (anim) {
    c.strokeStyle = rgba(mix(P.water, P.text, 0.5), 0.35);
    c.lineWidth = 1;
    still.river.center.forEach((p, i) => {
      if (i % 2) return;
      const k = ((t / 1800 + i * 0.13) % 1) - 0.5;
      c.beginPath();
      c.moveTo(p.x + k * p.w * 0.6, p.y);
      c.lineTo(p.x + k * p.w * 0.6 + p.w * 0.15, p.y + 1);
      c.stroke();
    });
  }
  for (const l of still.lanterns) lights.push({ x: l.x, y: l.y, r: 26 * l.s, a: 0.8, tone: P.warn });

  // Buildings and people back to front.
  const items = [];
  for (const p of scene.places) {
    const at = V.project(p.x, p.y);
    items.push({ y: at.y, draw: () => drawPlace(c, p, at) });
  }
  const people = [];
  for (const r of scene.residents) items.push({ y: r.y, draw: () => people.push({ name: r.name, ...person(c, r, F) }) });
  const boxes = {};
  const F = { P, t, anim, lights, night, dusk, lamps, details: scene.details || {} };
  function drawPlace(cx, p, at) {
    const tone = P[TONE[p.id]] || P.c1;
    const f = Object.assign(F, { s: at.s, level: p.level, roof: mix(tone, P.bg, 0.3), live: scene.live?.place === p.id, busy: (scene.busy?.[p.id] || 0) > 0 });
    const focus = scene.hover === p.id || scene.selected === p.id;
    if (focus) {
      cx.beginPath();
      cx.ellipse(at.x, at.y, 70 * at.s, 24 * at.s, 0, 0, Math.PI * 2);
      cx.fillStyle = rgba(P.c1, 0.12);
      cx.fill();
    }
    const r = p.level === 0 && BUILD[p.id] && !['garden', 'hearth', 'stage', 'lookout', 'workshop'].includes(p.id) ? construction(cx, at.x, at.y, f) : BUILD[p.id](cx, at.x, at.y, f);
    boxes[p.id] = { x: at.x, y: at.y, top: r.top, s: at.s, name: p.name, level: p.level, focus, live: f.live };
  }
  items.sort((a, b) => a.y - b.y).forEach((it) => it.draw());

  if (anim && night > 0.3) fireflies(c, V, P, F);
  weatherLayer(c, V, P, scene.weather, F);
  nightLight(c, V, P, F);

  // Names under the buildings, readable on any background.
  for (const [id, b] of Object.entries(boxes)) {
    const label = b.name;
    c.font = `600 ${Math.round(11.5 * b.s)}px ${P.display}`;
    const w = c.measureText(label).width + 14;
    const y = b.y + (id === 'garden' ? 34 : 26) * b.s;
    c.fillStyle = rgba(P.bg, b.focus ? 0.8 : 0.55);
    c.beginPath();
    c.roundRect(b.x - w / 2, y - 11 * b.s, w, 16 * b.s, 8);
    c.fill();
    c.fillStyle = rgba(P.text, b.level ? (b.focus ? 1 : 0.85) : 0.5);
    c.textAlign = 'center';
    c.fillText(label, b.x, y + 1);
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.arc(b.x - 7 * b.s + i * 7 * b.s, y + 10 * b.s, 2 * b.s, 0, Math.PI * 2);
      c.fillStyle = i < b.level ? rgba(P[TONE[id]] || P.c1) : rgba(P.text, 0.2);
      c.fill();
    }
  }
  return { places: boxes, people, stars: labels.stars };
}

/** A speech bubble over (x, y). */
export function bubble(c, V, P, x, y, text, { live = false, s = 1 } = {}) {
  const maxW = Math.min(300, V.w * 0.4);
  c.save();
  c.font = `${Math.round(12.5 * Math.max(0.85, s))}px ${P.body}`;
  const rows = [];
  let cur = '';
  for (const w of String(text).split(' ')) {
    const next = cur ? `${cur} ${w}` : w;
    if (c.measureText(next).width > maxW - 20 && cur) (rows.push(cur), (cur = w));
    else cur = next;
  }
  if (cur) rows.push(cur);
  const shown = rows.slice(0, 4);
  if (rows.length > 4) shown[3] = `${shown[3].replace(/\s*\S*$/, '')} …`;
  const lh = 16;
  const bw = Math.min(maxW, Math.max(...shown.map((r) => c.measureText(r).width)) + 20);
  const bh = shown.length * lh + 12;
  const bx = Math.max(6, Math.min(V.w - bw - 6, x - bw / 2));
  const by = Math.max(6, y - bh - 10);
  c.fillStyle = rgba(P.bg, 0.9);
  c.strokeStyle = rgba(live ? P.c3 : P.c1, 0.65);
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(bx, by, bw, bh, 10);
  c.fill();
  c.stroke();
  c.beginPath();
  c.moveTo(x - 6, by + bh);
  c.lineTo(x, by + bh + 8);
  c.lineTo(x + 6, by + bh);
  c.fill();
  c.fillStyle = rgba(P.text, 0.95);
  c.textAlign = 'left';
  shown.forEach((r, i) => c.fillText(r, bx + 10, by + 6 + lh * (i + 0.8)));
  c.restore();
}

/** Forget the cached still layer (theme change). */
export function resetArt() {
  cache = null;
}
