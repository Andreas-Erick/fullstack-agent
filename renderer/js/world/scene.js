// The Inner World scene: the island (map.js) painted once into a cached bitmap at the current zoom
// (tiles and objects back to front, in diagonal rows), then every frame: the sky with its sun, moon,
// clouds and your skill constellations; the island through the camera; water, the waterfall, smoke,
// sparks, the fountain, floating books, ravens, flames; the residents; night light; weather; names.
import { W, TW, TH, HZ, tile, tree, prop, person, rgba, mix, shadowAt } from './art.js';
import { N, noise2, rng } from './map.js';
import { drawPlace } from './places.js';
import { drawInterior } from './interiors.js';
import { sprite, count, drawSprite, point } from './sprites.js';

// Rendered art for a tree or a small thing, picked steadily by its place on the map; null = draw by code.
function natureSprite(family, gx, gy, season) {
  const n = count(family);
  if (!n) return null;
  const pick = Math.floor(Math.abs(Math.sin(gx * 12.9898 + gy * 78.233) * 43758.5453) % 1 * n);
  return sprite(`${family}-${pick}`, season);
}

const DEPTH = 6; // how far the cliffs hang below the island (levels)

/** World bounds of the island picture. */
export function bounds() {
  return { minX: W(0, N).x - 80, maxX: W(N, 0).x + 80, minY: -360, maxY: W(N, N).y + (DEPTH + 4) * HZ + 80 };
}

/** The camera that shows the whole island in a w × h view. */
export function fit(w, h, map) {
  // The island itself: its tiles, the buildings above (about 140 px) and the cliffs below.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!map?.tile(x, y)) continue;
      const p = W(x + 0.5, y + 0.5, map.hgt(x, y) * HZ);
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) {
    const b = bounds();
    ({ minX, maxX, minY, maxY } = b);
  }
  minY -= 150;
  maxY += DEPTH * HZ + 30;
  const z = Math.min((w * 0.94) / (maxX - minX + 60), (h * 0.94) / (maxY - minY));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z };
}

export const toScreen = (cam, w, h, p) => ({ x: (p.x - cam.x) * cam.z + w / 2, y: (p.y - cam.y) * cam.z + h / 2 });
export const toWorld = (cam, w, h, s) => ({ x: (s.x - w / 2) / cam.z + cam.x, y: (s.y - h / 2) / cam.z + cam.y });

// ------------------------------------------------------------ the cached island
/**
 * Paints the island, or the part of it in `region` (world px), at `scale`. data: { map, places (with
 * level), details, P, interior (a place id or null) }. Returns { canvas, scale, region, hits, lights,
 * emitters, water, fall }.
 */
export function buildIsland(data, scale, region = bounds()) {
  const { map, P } = data;
  const b = region;
  const cv = document.createElement('canvas');
  cv.width = Math.ceil((b.maxX - b.minX) * scale);
  cv.height = Math.ceil((b.maxY - b.minY) * scale);
  const c = cv.getContext('2d');
  c.setTransform(scale, 0, 0, scale, -b.minX * scale, -b.minY * scale);
  c.lineJoin = 'round';
  const noise = (x, y) => noise2(x, y, map.seed);
  const lights = [];
  const emitters = [];
  const hits = {};

  // Things that stand on the ground, each drawn right after the row of tiles it stands on.
  const rows = Array.from({ length: 2 * N }, () => []);
  const rowOf = (gx, gy) => Math.max(0, Math.min(2 * N - 1, Math.floor(gx) + Math.floor(gy)));
  const art = data.rendered;
  const drawTree = (t) => {
    const sp = art && natureSprite(`tree-${t.kind}`, t.gx, t.gy, P.season);
    if (!sp) return tree(c, P, t, t.h * HZ);
    const p = W(t.gx, t.gy, t.h * HZ);
    shadowAt(c, p.x + 8 * t.k, p.y + 2, 15 * t.k, 5.5 * t.k);
    drawSprite(c, sp, p.x, p.y, 0.78 * t.k);
  };
  const drawProp = (p) => {
    const sp = art && natureSprite(`prop-${p.kind}`, p.gx, p.gy, P.season);
    if (!sp) return prop(c, P, p.kind, p.gx, p.gy, p.h * HZ, lights, p.seed);
    const at = W(p.gx, p.gy, p.h * HZ);
    drawSprite(c, sp, at.x, at.y, 0.7);
  };
  const drawLamp = (l) => {
    const sp = art && sprite('prop-lamp-0', P.season);
    if (!sp) return prop(c, P, 'lamp', l.gx, l.gy, l.h * HZ, lights);
    const at = W(l.gx, l.gy, l.h * HZ);
    drawSprite(c, sp, at.x, at.y, 0.8);
    const q = point(sp, 'light', at.x, at.y, 0.8);
    if (q) lights.push({ kind: 'lamp', x: q.x, y: q.y, r: 34, tone: P.lamp });
  };
  for (const t of map.trees) rows[rowOf(t.gx, t.gy)].push({ k: t.gx + t.gy, draw: () => drawTree(t) });
  for (const p of map.props) rows[rowOf(p.gx, p.gy)].push({ k: p.gx + p.gy, draw: () => drawProp(p) });
  for (const l of roadLamps(map)) rows[rowOf(l.gx, l.gy)].push({ k: l.gx + l.gy, draw: () => drawLamp(l) });
  for (const p of data.places) {
    const s = map.sites[p.id];
    if (!s) continue;
    const row = rowOf(s.gx + s.a, s.gy + s.b);
    rows[row].push({
      k: s.gx + s.a + s.gy + s.b,
      draw: () => {
        const ctx = { P, level: p.level, details: data.details || {}, lights, emitters: [], rendered: art };
        const inside = data.interior === p.id;
        const top = inside ? drawInterior(c, p.id, s, ctx) : drawPlace(c, p.id, s, ctx);
        for (const e of ctx.emitters) emitters.push({ ...e, place: e.place || p.id });
        const z = s.h * HZ;
        hits[p.id] = { x0: W(s.gx - s.a - 0.7, s.gy + s.b + 0.7).x, x1: W(s.gx + s.a + 0.7, s.gy - s.b - 0.7).x, y0: top - 6, y1: W(s.gx + s.a, s.gy + s.b, z).y + 10, label: W(s.gx + s.a * 0.6, s.gy + s.b * 0.6, z), center: W(s.gx, s.gy, z), name: p.name, level: p.level, inside, labels: ctx.labels || [] };
      },
    });
  }

  for (let d = 0; d < 2 * N - 1; d++) {
    for (let x = Math.max(0, d - N + 1); x <= Math.min(d, N - 1); x++) tile(c, P, map, x, d - x, noise);
    for (const o of rows[d].sort((a, b) => a.k - b.k)) o.draw();
  }

  // Where the water runs and falls, for the animation.
  const water = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (map.tile(x, y) === 4) water.push(W(x + 0.5, y + 0.5, map.hgt(x, y) * HZ));
  let fall = null;
  if (map.fall) {
    const { x, y } = map.fall;
    const z = map.hgt(x, y) * HZ;
    const left = !map.tile(x, y + 1);
    fall = left ? { a: W(x, y + 1, z), b: W(x + 1, y + 1, z) } : { a: W(x + 1, y + 1, z), b: W(x + 1, y, z) };
  }
  return { canvas: cv, scale, region: b, hits, lights, emitters, water, fall, minX: b.minX, minY: b.minY };
}

// Lamps along the roads, every few steps, set beside the road.
function roadLamps(map) {
  const out = [];
  for (const rd of map.roads) {
    for (let i = 8; i < rd.pts.length - 8; i += 14) {
      const p = rd.pts[i];
      const q = rd.pts[i + 1];
      const nx = -(q.y - p.y);
      const ny = q.x - p.x;
      const len = Math.hypot(nx, ny) || 1;
      const gx = p.x + (nx / len) * 1.2;
      const gy = p.y + (ny / len) * 1.2;
      const t = map.tile(Math.floor(gx), Math.floor(gy));
      if (t !== 1 && t !== 2) continue;
      if (Object.values(map.sites).some((s) => Math.abs(gx - s.gx) < s.a + 0.8 && Math.abs(gy - s.gy) < s.b + 0.8)) continue;
      out.push({ gx, gy, h: map.hgt(Math.floor(gx), Math.floor(gy)) });
    }
  }
  return out;
}

// ------------------------------------------------------------ time of day
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
const hashStr = (s) => [...String(s)].reduce((h, ch) => Math.imul(h ^ ch.codePointAt(0), 16777619), 2166136261) >>> 0;

// ------------------------------------------------------------ the frame
let layer = null;

/**
 * Draws one frame. f: { w, h, dpr, cam, island, P, t, anim, lite, minute, weather, skills, residents
 * (world px: x, y, + person fields), live: place id | null, busy: { place: n } }.
 * Returns screen hit areas for residents and stars.
 */
export function frame(ctx, f) {
  const { w, h, cam, island, P } = f;
  const night = nightAt(f.minute);
  const dusk = duskAt(f.minute);
  const out = { people: [], stars: [] };
  ctx.clearRect(0, 0, w, h);
  sky(ctx, f, night, dusk, out);

  // The island on its own layer, so night only darkens the island.
  const dpr = f.dpr;
  if (!layer || layer.width !== Math.round(w * dpr) || layer.height !== Math.round(h * dpr)) {
    layer = document.createElement('canvas');
    layer.width = Math.round(w * dpr);
    layer.height = Math.round(h * dpr);
  }
  const L = layer.getContext('2d');
  L.setTransform(dpr, 0, 0, dpr, 0, 0);
  L.clearRect(0, 0, w, h);
  L.save();
  L.translate(w / 2, h / 2);
  L.scale(cam.z, cam.z);
  L.translate(-cam.x, -cam.y);
  L.drawImage(island.canvas, island.minX, island.minY, island.canvas.width / island.scale, island.canvas.height / island.scale);
  if (f.anim && P.season !== 'winter') waterMotion(L, P, island, f.t);
  waterfall(L, P, island, f.t, f.anim);
  for (const e of island.emitters) emitter(L, P, e, f);
  for (const p of [...f.residents].sort((a, b) => a.y - b.y)) {
    const r = person(L, P, p, f.t, f.anim);
    const s = toScreen(cam, w, h, { x: r.x, y: r.y });
    const top = toScreen(cam, w, h, { x: r.x, y: r.top });
    out.people.push({ name: p.name, x: s.x, y: s.y, r: Math.max(10, r.r * cam.z), top: top.y });
  }
  L.restore();
  // Night (and the warm light at dusk) on the island only.
  if (night > 0.02 || dusk > 0.02) {
    L.globalCompositeOperation = 'source-atop';
    L.fillStyle = rgba(mix([14, 22, 54], P.bg, 0.3), 0.58 * night);
    L.fillRect(0, 0, w, h);
    if (dusk > 0.02) {
      L.fillStyle = rgba([255, 140, 90], 0.12 * dusk);
      L.fillRect(0, 0, w, h);
    }
    L.globalCompositeOperation = 'source-over';
  }
  ctx.drawImage(layer, 0, 0, w, h);

  // Lamplight through the dark.
  const lamps = Math.min(1, night * 1.25 + dusk * 0.6);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.translate(w / 2, h / 2);
  ctx.scale(cam.z, cam.z);
  ctx.translate(-cam.x, -cam.y);
  if (lamps > 0.02) {
    for (const l of island.lights) {
      if (l.kind === 'sprite') {
        ctx.globalAlpha = Math.min(1, lamps * 1.1);
        ctx.drawImage(l.img, l.x, l.y, l.w, l.h);
        ctx.globalAlpha = Math.min(1, lamps * 0.45);
        ctx.drawImage(l.img, l.x - l.w * 0.02, l.y - l.h * 0.02, l.w * 1.04, l.h * 1.04); // a soft halo
        ctx.globalAlpha = 1;
      } else if (l.kind === 'window') {
        ctx.beginPath();
        l.quad.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = rgba(l.tone, 0.75 * lamps);
        ctx.fill();
        const cx = l.quad.reduce((s, p) => s + p.x, 0) / l.quad.length;
        const cy = l.quad.reduce((s, p) => s + p.y, 0) / l.quad.length;
        glow(ctx, cx, cy, 16, l.tone, 0.35 * lamps);
      } else glow(ctx, l.x, l.y, l.r, l.tone, 0.55 * lamps);
    }
  }
  for (const e of island.emitters) {
    if (e.kind === 'forge') glow(ctx, e.x, e.y, f.live === 'workshop' ? 60 : 34, P.lamp, 0.5 + 0.3 * lamps);
    if (e.kind === 'magic') glow(ctx, e.x, e.y, 46, e.tone, 0.5 + 0.4 * lamps);
    if (e.kind === 'flame') glow(ctx, e.x, e.y, 18, P.lamp, 0.5);
    if (e.kind === 'spot' && f.live === 'stage') glow(ctx, e.x, e.y - 20, 70, P.lamp, 0.6);
  }
  ctx.restore();

  if (f.anim && night > 0.3) fireflies(ctx, f, night);
  weather(ctx, f);
  return out;
}

function glow(c, x, y, r, tone, a) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(tone, a));
  g.addColorStop(1, rgba(tone, 0));
  c.fillStyle = g;
  c.fillRect(x - r, y - r, r * 2, r * 2);
}

// ------------------------------------------------------------ sky
function sky(c, f, night, dusk, out) {
  const { w, h, P, t } = f;
  const day0 = mix([92, 160, 222], P.c1, 0.1);
  const day1 = mix([196, 228, 244], P.c1, 0.06);
  const top = mix(day0, mix([8, 12, 30], P.bg, 0.4), night);
  const bottom = mix(mix(day1, [250, 176, 130], dusk * 0.6), mix([26, 34, 72], P.bg, 0.3), night);
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, rgba(top));
  g.addColorStop(1, rgba(bottom));
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  const hr = f.minute / 60;
  // Sun and moon along an arc.
  if (hr >= 5.5 && hr <= 21) {
    const k = (hr - 5.5) / 15.5;
    const x = w * (0.08 + 0.84 * k);
    const y = h * 0.42 - Math.sin(k * Math.PI) * h * 0.36;
    glow(c, x, y, 90, [255, 236, 170], f.weather === 'clear' ? 0.7 : 0.35);
    c.beginPath();
    c.arc(x, y, 16, 0, Math.PI * 2);
    c.fillStyle = rgba([255, 244, 200], f.weather === 'clear' ? 1 : 0.6);
    c.fill();
  }
  if (night > 0.2) {
    const r = rng(42);
    for (let i = 0; i < 120; i++) {
      const x = r() * w;
      const y = r() * h * 0.7;
      c.fillStyle = rgba([235, 240, 255], 0.5 * night * (0.6 + 0.4 * Math.sin(t / 900 + i * 2.1)));
      c.fillRect(x, y, 1.3, 1.3);
    }
    const k = ((hr + 24 - 19) % 24) / 11;
    const x = w * (0.12 + 0.76 * Math.min(1, k));
    const y = h * 0.1 + Math.abs(k - 0.5) * h * 0.2;
    glow(c, x, y, 50, [210, 220, 255], 0.3 * night);
    c.beginPath();
    c.arc(x, y, 12, 0, Math.PI * 2);
    c.fillStyle = rgba([236, 238, 250], night);
    c.fill();
    c.beginPath();
    c.arc(x + 5, y - 3, 11, 0, Math.PI * 2);
    c.fillStyle = rgba(top, night);
    c.fill();
  }
  clouds(c, f, night, 'back');
  constellations(c, f, night, out);
}

// Your skill tree as constellations in the upper sky; mastered stars glow and are named at night.
function constellations(c, f, night, out) {
  const { w, h, P, t } = f;
  const skills = f.skills || [];
  const pos = new Map();
  for (const sk of skills) {
    const r = rng(hashStr(sk.name));
    pos.set(sk.name, { x: w * (0.4 + r() * 0.56), y: h * (0.05 + r() * 0.22), sk });
  }
  const list = [...pos.values()];
  for (let round = 0; round < 30; round++) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const dx = b.x - a.x || 1;
        const dy = (b.y - a.y) * 2.5;
        const d = Math.hypot(dx, dy);
        if (d >= 110) continue;
        const push = (110 - d) / 2;
        a.x -= (dx / d) * push;
        b.x += (dx / d) * push;
      }
    }
    for (const p of list) p.x = Math.max(w * 0.38, Math.min(w * 0.97, p.x));
  }
  const vis = Math.max(0.15, night);
  for (const { x, y, sk } of list) {
    for (const n of sk.needs || []) {
      const q = pos.get(n);
      if (!q) continue;
      c.strokeStyle = rgba(P.c1, 0.35 * vis);
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(q.x, q.y);
      c.stroke();
    }
  }
  for (const { x, y, sk } of list) {
    const bright = sk.state === 'mastered' ? 1 : sk.state === 'locked' ? 0.25 : 0.4 + sk.progress * 0.5;
    const rad = 2.2 + bright * 3;
    if (sk.state !== 'locked') glow(c, x, y, rad * 5, P.c1, (sk.state === 'mastered' ? 0.55 : 0.25) * vis);
    c.beginPath();
    c.arc(x, y, rad, 0, Math.PI * 2);
    c.fillStyle = rgba(sk.state === 'mastered' ? mix(P.c1, [255, 255, 255], 0.5) : [240, 244, 255], bright * vis * (0.85 + 0.15 * Math.sin(t / 700 + x)));
    c.fill();
    out.stars.push({ x, y, r: rad + 8, name: sk.name, state: sk.state, progress: sk.progress });
    if (sk.state !== 'locked' && night > 0.5) {
      c.font = `${sk.state === 'mastered' ? '600 ' : ''}11px ${P.body}`;
      c.textAlign = 'center';
      c.fillStyle = rgba([236, 240, 255], (sk.state === 'mastered' ? 0.9 : 0.55) * night);
      c.fillText(sk.name, x, y - rad - 5);
    }
  }
}

// Fluffy clouds: behind the island (some below it, so it floats) and a few in front.
function clouds(c, f, night, which) {
  const { w, h, t } = f;
  const r = rng(which === 'back' ? 11 : 17);
  const n = which === 'back' ? (f.weather === 'clear' ? 7 : 11) : 3;
  for (let i = 0; i < n; i++) {
    const speed = 3 + r() * 5;
    const x = ((r() * (w + 400) + (t / 1000) * speed) % (w + 400)) - 200;
    const y = which === 'back' ? (i % 3 === 0 ? h * (0.72 + r() * 0.22) : h * (0.12 + r() * 0.4)) : h * (0.8 + r() * 0.15);
    const k = (0.8 + r() * 1.1) * (which === 'back' && y > h * 0.7 ? 1.6 : 1);
    const lightC = mix(f.weather === 'rain' ? [200, 206, 216] : [252, 252, 255], [60, 70, 110], night * 0.8);
    const shadeC = mix(lightC, [120, 130, 160], 0.35);
    const a = which === 'front' ? 0.35 : 0.9;
    const puffs = [[0, 0, 22], [24, -8, 18], [-24, -4, 17], [44, 4, 14], [-42, 5, 13], [10, -18, 15]];
    for (const [dx, dy, rr] of puffs) {
      c.beginPath();
      c.arc(x + dx * k, y + dy * k + 4 * k, rr * k, 0, Math.PI * 2);
      c.fillStyle = rgba(shadeC, a);
      c.fill();
    }
    for (const [dx, dy, rr] of puffs) {
      c.beginPath();
      c.arc(x + dx * k - 2 * k, y + dy * k, rr * k * 0.92, 0, Math.PI * 2);
      c.fillStyle = rgba(lightC, a);
      c.fill();
    }
  }
}

// ------------------------------------------------------------ moving things (world space)
function waterMotion(c, P, island, t) {
  c.strokeStyle = rgba(P.foam, 0.55);
  c.lineWidth = 1.2;
  island.water.forEach((p, i) => {
    const k = ((t / 1600 + i * 0.37) % 1) - 0.5;
    c.beginPath();
    c.moveTo(p.x + k * 22 - 5, p.y + k * 6);
    c.lineTo(p.x + k * 22 + 3, p.y + k * 6 - 2);
    c.stroke();
  });
}

function waterfall(c, P, island, t, anim) {
  if (!island.fall) return;
  const { a, b } = island.fall;
  const drop = (DEPTH + 3) * HZ + 120;
  const g = c.createLinearGradient(0, a.y, 0, a.y + drop);
  g.addColorStop(0, rgba(P.water, 0.95));
  g.addColorStop(0.7, rgba(mix(P.water, P.foam, 0.4), 0.8));
  g.addColorStop(1, rgba(P.foam, 0));
  c.beginPath();
  c.moveTo(a.x, a.y);
  c.lineTo(b.x, b.y);
  c.lineTo(b.x + 6, b.y + drop);
  c.lineTo(a.x - 6, a.y + drop);
  c.closePath();
  c.fillStyle = g;
  c.fill();
  // Streaks falling, and spray where it leaves the edge.
  c.strokeStyle = rgba(P.foam, 0.7);
  c.lineWidth = 1.5;
  for (let i = 0; i < 9; i++) {
    const u = (i + 0.5) / 9;
    const x = a.x + (b.x - a.x) * u;
    const y0 = a.y + (b.y - a.y) * u;
    const k = anim ? (t / 700 + i * 0.29) % 1 : (i * 0.29) % 1;
    c.beginPath();
    c.moveTo(x, y0 + k * drop * 0.8);
    c.lineTo(x, y0 + k * drop * 0.8 + 18);
    c.stroke();
  }
  for (let i = 0; i < 5; i++) {
    const u = (i + 0.5) / 5;
    const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    c.beginPath();
    c.arc(p.x, p.y + 2, 3 + (anim ? Math.sin(t / 200 + i) : 0), 0, Math.PI * 2);
    c.fillStyle = rgba(P.foam, 0.8);
    c.fill();
  }
}

function emitter(c, P, e, f) {
  const t = f.t;
  const anim = f.anim;
  const live = f.live === e.place;
  switch (e.kind) {
    case 'smoke': {
      const n = e.heavy && live ? 9 : 5;
      for (let i = 0; i < n; i++) {
        const k = anim ? (t / (live ? 1800 : 2600) + i / n) % 1 : i / n;
        c.beginPath();
        c.arc(e.x + Math.sin(k * 6 + i) * 5 + k * 18, e.y - k * 60, 3 + k * 9, 0, Math.PI * 2);
        c.fillStyle = rgba(live && e.heavy ? [90, 86, 86] : [236, 236, 240], 0.55 * (1 - k));
        c.fill();
      }
      if (e.heavy && live) sparks(c, P, e.x, e.y, t, anim, 10);
      return;
    }
    case 'forge': {
      const fl = anim ? Math.sin(t / 110) * 2 : 0;
      for (const [r, col, a] of [[12, [255, 120, 40], 0.9], [8, [255, 190, 80], 0.95], [4, [255, 240, 180], 1]]) {
        c.beginPath();
        c.ellipse(e.x, e.y, r + fl, (r + fl) * 0.6, 0, 0, Math.PI * 2);
        c.fillStyle = rgba(col, live ? a : a * 0.75);
        c.fill();
      }
      if (live) sparks(c, P, e.x, e.y - 4, t, anim, 6);
      return;
    }
    case 'fountain': {
      for (let i = 0; i < 10; i++) {
        const k = anim ? (t / 900 + i / 10) % 1 : i / 10;
        const dir = i % 2 ? 1 : -1;
        const spread = 6 + (i % 3) * 5;
        c.beginPath();
        c.arc(e.x + dir * k * spread, e.y + (k * k * 26 - k * 10), 1.6, 0, Math.PI * 2);
        c.fillStyle = rgba(P.foam, 0.85);
        c.fill();
      }
      return;
    }
    case 'books':
      for (let i = 0; i < e.n; i++) {
        const a = (anim ? t / 4000 : 0) + (i / e.n) * Math.PI * 2;
        const x = e.x + Math.cos(a) * e.r;
        const y = e.y + Math.sin(a) * e.r * 0.4 - (i % 3) * 6;
        c.fillStyle = rgba([P.c1, P.c3, P.lamp, P.c2][i % 4]);
        c.fillRect(x - 4, y - 2.5, 8, 5);
        c.fillStyle = rgba([255, 255, 255], 0.7);
        c.fillRect(x - 3.5, y - 0.5, 7, 1);
      }
      return;
    case 'ravens':
      if (!(live || (f.busy?.lookout || 0) > 0)) return;
      for (let i = 0; i < 3 + (live ? 2 : 0); i++) {
        const a = (anim ? t / (1400 + i * 300) : i) + i * 2.1;
        const x = e.x + Math.cos(a) * (40 + i * 10);
        const y = e.y + Math.sin(a) * 14;
        const flap = anim ? Math.sin(t / 120 + i) * 4 : 3;
        c.strokeStyle = rgba([30, 28, 36], 0.9);
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(x - 8, y - flap);
        c.quadraticCurveTo(x - 3, y - 2, x, y);
        c.quadraticCurveTo(x + 3, y - 2, x + 8, y - flap);
        c.stroke();
      }
      return;
    case 'flame':
      for (let k = 0; k < e.n; k++) {
        const fl = anim ? Math.sin(t / 140 + k + e.x) : 0;
        c.beginPath();
        c.ellipse(e.x + k * 6, e.y, 2.6, 5 + fl, 0, 0, Math.PI * 2);
        c.fillStyle = rgba([255, 150, 50]);
        c.fill();
        c.beginPath();
        c.ellipse(e.x + k * 6, e.y + 1, 1.3, 2.6, 0, 0, Math.PI * 2);
        c.fillStyle = rgba([255, 236, 160]);
        c.fill();
      }
      return;
    case 'magic': {
      const pulse = anim ? 0.75 + 0.25 * Math.sin(t / 500) : 1;
      c.beginPath();
      c.arc(e.x, e.y, 4 * pulse, 0, Math.PI * 2);
      c.fillStyle = rgba(mix(e.tone, [255, 255, 255], 0.5));
      c.fill();
      return;
    }
    case 'spot':
      if (!live) return;
      c.beginPath();
      c.moveTo(e.x, e.y - 90);
      c.lineTo(e.x - 34, e.y);
      c.lineTo(e.x + 34, e.y);
      c.closePath();
      c.fillStyle = rgba([255, 240, 200], 0.18);
      c.fill();
      return;
    default:
  }
}

function sparks(c, P, x, y, t, anim, n) {
  for (let i = 0; i < n; i++) {
    const k = anim ? (t / 800 + i / n) % 1 : i / n;
    const a = i * 2.39;
    c.fillStyle = rgba([255, 190, 80], 1 - k);
    c.fillRect(x + Math.cos(a) * k * 22, y - k * 34 + Math.sin(a) * 4, 2, 2);
  }
}

function fireflies(c, f, night) {
  const r = rng(13);
  for (let i = 0; i < 40; i++) {
    const x = r() * f.w + Math.sin(f.t / 1700 + i) * 18;
    const y = f.h * (0.35 + r() * 0.55) - Math.cos(f.t / 1300 + i * 2) * 10;
    c.fillStyle = rgba([220, 255, 150], (0.5 + 0.5 * Math.sin(f.t / 400 + i * 3)) * night * 0.9);
    c.fillRect(x, y, 2, 2);
  }
}

function weather(c, f) {
  const { w, h, t } = f;
  if (f.weather === 'rain') {
    c.strokeStyle = 'rgba(200, 220, 240, 0.35)';
    c.lineWidth = 1;
    const r = rng(5);
    c.beginPath();
    for (let i = 0; i < 160; i++) {
      const x = (r() * w + t / 5) % w;
      const y = (r() * h + t / 2) % h;
      c.moveTo(x, y);
      c.lineTo(x - 3, y + 10);
    }
    c.stroke();
  } else if (f.weather === 'snow') {
    const r = rng(6);
    c.fillStyle = 'rgba(255, 255, 255, 0.85)';
    for (let i = 0; i < 130; i++) {
      const x = (r() * w + Math.sin(t / 1500 + i) * 14 + w) % w;
      const y = (r() * h + t / 28) % h;
      c.fillRect(x, y, 2.2, 2.2);
    }
  } else if (f.weather === 'fog') {
    for (let i = 0; i < 4; i++) {
      const y = h * (0.3 + i * 0.18);
      const g = c.createLinearGradient(0, y - 40, 0, y + 40);
      g.addColorStop(0, 'rgba(240, 244, 250, 0)');
      g.addColorStop(0.5, 'rgba(240, 244, 250, 0.16)');
      g.addColorStop(1, 'rgba(240, 244, 250, 0)');
      c.fillStyle = g;
      c.fillRect(0, y - 40, w, 80);
    }
  }
  if (f.anim) seasonal(c, f);
  clouds(c, f, nightAt(f.minute), 'front');
}

// The season in the air: a few snowflakes, falling leaves or blossom petals drifting by.
function seasonal(c, f) {
  const { w, h, t, P } = f;
  const kind = P.season;
  if (kind === 'summer' || (kind === 'winter' && f.weather === 'snow')) return;
  const r = rng(23);
  const n = kind === 'winter' ? 60 : 26;
  for (let i = 0; i < n; i++) {
    const speed = kind === 'winter' ? 40 : 26 + r() * 14;
    const x = (r() * w + Math.sin(t / 1300 + i) * 30 + (t / 1000) * (kind === 'winter' ? 4 : 18)) % w;
    const y = (r() * h + (t / 1000) * speed) % h;
    if (kind === 'winter') {
      c.fillStyle = 'rgba(255, 255, 255, 0.75)';
      c.fillRect(x, y, 2, 2);
      continue;
    }
    const spin = t / 400 + i;
    c.save();
    c.translate(x, y);
    c.rotate(spin);
    c.scale(1, Math.abs(Math.cos(spin)) * 0.8 + 0.2);
    c.beginPath();
    c.ellipse(0, 0, kind === 'autumn' ? 4 : 3, kind === 'autumn' ? 2.2 : 2, 0, 0, Math.PI * 2);
    c.fillStyle = kind === 'autumn' ? rgba([[218, 112, 50], [234, 164, 62], [196, 70, 46], [226, 192, 82]][i % 4], 0.9) : rgba(i % 3 ? [250, 196, 214] : [255, 236, 244], 0.9);
    c.fill();
    c.restore();
  }
}

/** Names under the places, readable on any background (screen space). */
export function labels(c, f, island, { hover, selected } = {}) {
  const { w, h, cam, P } = f;
  const size = Math.round(Math.max(10, Math.min(15, 12 * Math.sqrt(cam.z * 1.6))));
  for (const [id, b] of Object.entries(island.hits)) {
    const p = toScreen(cam, w, h, b.label);
    const focus = hover === id || selected === id;
    c.font = `600 ${size}px ${P.display}`;
    const tw = c.measureText(b.name).width + 16;
    c.fillStyle = rgba([24, 20, 26], focus ? 0.85 : 0.6);
    c.beginPath();
    c.roundRect(p.x - tw / 2, p.y - size, tw, size + 8, 9);
    c.fill();
    if (focus) {
      c.strokeStyle = rgba(P.c1, 0.8);
      c.lineWidth = 1;
      c.stroke();
    }
    c.fillStyle = rgba([250, 246, 236], b.level ? 1 : 0.6);
    c.textAlign = 'center';
    c.fillText(b.name, p.x, p.y);
    for (let i = 0; i < 3; i++) {
      c.beginPath();
      c.arc(p.x - 8 + i * 8, p.y + 10, 2.4, 0, Math.PI * 2);
      c.fillStyle = i < b.level ? rgba(P.lamp) : 'rgba(255, 255, 255, 0.25)';
      c.fill();
    }
  }
  // Inside a building: what is written on its things (shelves, tables, cabinets).
  for (const b of Object.values(island.hits)) {
    if (!b.inside) continue;
    c.font = `${Math.max(10, Math.min(13, 9 * cam.z))}px ${P.body}`;
    c.textAlign = 'center';
    for (const l of b.labels) {
      const p = toScreen(cam, w, h, l);
      const tw = c.measureText(l.text).width + 10;
      c.fillStyle = 'rgba(24, 20, 26, 0.72)';
      c.beginPath();
      c.roundRect(p.x - tw / 2, p.y - 13, tw, 17, 6);
      c.fill();
      c.fillStyle = 'rgba(250, 246, 236, 0.95)';
      c.fillText(l.text, p.x, p.y);
    }
  }
}

/** A speech bubble at a screen point. */
export function bubble(c, f, x, y, text, { live = false } = {}) {
  const { w, P } = f;
  const maxW = Math.min(300, w * 0.4);
  c.save();
  c.font = `13px ${P.body}`;
  const rows = [];
  let cur = '';
  for (const word of String(text).split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (c.measureText(next).width > maxW - 22 && cur) (rows.push(cur), (cur = word));
    else cur = next;
  }
  if (cur) rows.push(cur);
  const shown = rows.slice(0, 4);
  if (rows.length > 4) shown[3] = `${shown[3].replace(/\s*\S*$/, '')} …`;
  const lh = 17;
  const bw = Math.min(maxW, Math.max(...shown.map((r) => c.measureText(r).width)) + 22);
  const bh = shown.length * lh + 12;
  const bx = Math.max(6, Math.min(w - bw - 6, x - bw / 2));
  const by = Math.max(6, y - bh - 12);
  c.fillStyle = 'rgba(252, 248, 238, 0.96)';
  c.strokeStyle = rgba(live ? P.c3 : [80, 60, 50], 0.8);
  c.lineWidth = 1.5;
  c.beginPath();
  c.roundRect(bx, by, bw, bh, 10);
  c.fill();
  c.stroke();
  c.beginPath();
  c.moveTo(x - 6, by + bh);
  c.lineTo(x, by + bh + 9);
  c.lineTo(x + 6, by + bh);
  c.fill();
  c.fillStyle = 'rgba(40, 30, 26, 0.95)';
  c.textAlign = 'left';
  shown.forEach((r, i) => c.fillText(r, bx + 11, by + 6 + lh * (i + 0.8)));
  c.restore();
}

export { TW, TH, HZ };
