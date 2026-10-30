// The Inner World's island as a tile grid (pure: no DOM, no imports; tested in test/worldmap.test.js).
// A floating island: a noisy round mask, flat land at height 1, a hill under the Observatory and a rock
// under the Lookout; a river that runs off the edge as a waterfall; cobbled roads along a minimum
// spanning tree between the places (bridges where they cross the river); plazas under the places;
// fields, trees and small things on the open grass. Every place has a site (grid position, footprint
// half-sizes, ground height). Deterministic: the same places give the same island.

export const N = 40;
export const T = { VOID: 0, GRASS: 1, DIRT: 2, COBBLE: 3, WATER: 4, SAND: 5, PLAZA: 6, FIELD: 7, BRIDGE: 8 };

// Footprint half-sizes in tiles, and how much clear ground a place wants around it.
const SIZE = {
  hearth: [1.9, 1.7, 0.4], library: [1.6, 1.6, 0.5], cafe: [1.6, 1.3, 0.7], workshop: [1.5, 1.3, 0.6], garden: [2.6, 2.6, 0.6],
  grounds: [2.4, 1.9, 0.3], observatory: [1.4, 1.4, 0.4], archive: [1.8, 1.4, 0.5], stage: [2, 1.6, 0.5], lookout: [1, 1, 0.3],
};

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Smooth value noise (for the coastline, tree density and colour variation).
export function noise2(x, y, seed = 0) {
  const h = (i, j) => {
    let n = Math.imul(i * 374761393 + j * 668265263 + seed * 2246822519, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1103515245);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const s = (t) => t * t * (3 - 2 * t);
  const a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * s(fx);
  const b = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * s(fx);
  return a + (b - a) * s(fy);
}

const C = (N - 1) / 2;
const R = N * 0.44;
const K = R * 0.9;

/** Grid position for a place given on screen as x (left → right) and y (back → front), both 0..1. */
export function toGrid(x, y) {
  const u = x - 0.5;
  const v = y - 0.5;
  return { gx: C + (v + u) * K * 1.25, gy: C + (v - u) * K * 1.25 };
}

/** Builds the island for the places ([{ id, x, y }]). */
export function buildMap(places, seed = 7) {
  const tiles = new Uint8Array(N * N);
  const height = new Uint8Array(N * N);
  const at = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? -1 : y * N + x);
  const r = rng(seed);

  // The island: a wobbly disc.
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - C;
      const dy = y - C;
      const th = Math.atan2(dy, dx);
      const edge = R * (0.86 + 0.1 * Math.sin(3 * th + 1.3) + 0.05 * Math.sin(7 * th + 0.4) + 0.08 * (noise2(x / 5, y / 5, seed) - 0.5));
      if (Math.hypot(dx, dy) < edge) {
        tiles[at(x, y)] = T.GRASS;
        height[at(x, y)] = 1;
      }
    }
  }

  // Sites: where each place stands, pulled inside the island.
  const sites = {};
  for (const p of places) {
    let { gx, gy } = toGrid(p.x, p.y);
    const [a, b, pad] = SIZE[p.id] || [1.5, 1.5, 1];
    for (let k = 0; k < 40; k++) {
      const ok = [[gx - a - 1, gy - b - 1], [gx + a + 1, gy - b - 1], [gx - a - 1, gy + b + 1], [gx + a + 1, gy + b + 1]].every(([x, y]) => tiles[at(Math.round(x), Math.round(y))] > 0);
      if (ok) break;
      gx += (C - gx) * 0.06;
      gy += (C - gy) * 0.06;
    }
    sites[p.id] = { id: p.id, gx, gy, a, b, pad, h: 1 };
  }

  // Raised ground: a hill under the Observatory, a rock under the Lookout.
  const raise = (s, radius, level) => {
    if (!s) return;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = at(x, y);
        if (!tiles[i]) continue;
        const d = Math.hypot(x - s.gx, y - s.gy) + 0.6 * (noise2(x / 2.5, y / 2.5, seed + 9) - 0.5);
        if (d < radius) height[i] = Math.max(height[i], level);
        else if (d < radius + 1.6 && level > 2) height[i] = Math.max(height[i], level - 1);
      }
    }
    s.h = level;
  };
  raise(sites.observatory, 4.2, 2);
  raise(sites.lookout, 2.4, 3);

  // The river: from the far edge, down the left side, off the island as a waterfall.
  const riverPts = [toGrid(0.12, -0.12), toGrid(0.1, 0.25), toGrid(0.04, 0.55), toGrid(0.07, 0.8), toGrid(0.02, 1.25)];
  const river = [];
  for (let i = 0; i < riverPts.length - 1; i++) {
    const p = riverPts[i];
    const q = riverPts[i + 1];
    const steps = Math.ceil(Math.hypot(q.gx - p.gx, q.gy - p.gy) * 3);
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const wob = Math.sin((i + t) * 2.3) * 0.8;
      river.push({ x: p.gx + (q.gx - p.gx) * t + wob * 0.5, y: p.gy + (q.gy - p.gy) * t - wob * 0.5 });
    }
  }
  let fall = null;
  for (const p of river) {
    for (let y = Math.floor(p.y - 1); y <= Math.ceil(p.y + 1); y++) {
      for (let x = Math.floor(p.x - 1); x <= Math.ceil(p.x + 1); x++) {
        const i = at(x, y);
        if (i < 0 || !tiles[i] || height[i] !== 1) continue;
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < 1.05) tiles[i] = T.WATER;
        else if (d < 1.75 && tiles[i] === T.GRASS) tiles[i] = T.SAND;
      }
    }
    const i = at(Math.round(p.x), Math.round(p.y));
    if (i >= 0 && tiles[i] === T.WATER) fall = { x: Math.round(p.x), y: Math.round(p.y) };
  }

  // Ground under the places.
  for (const s of Object.values(sites)) {
    const ground = s.id === 'garden' ? T.PLAZA : s.id === 'grounds' || s.id === 'stage' ? T.DIRT : T.DIRT;
    for (let y = Math.floor(s.gy - s.b - s.pad); y <= Math.ceil(s.gy + s.b + s.pad); y++) {
      for (let x = Math.floor(s.gx - s.a - s.pad); x <= Math.ceil(s.gx + s.a + s.pad); x++) {
        const i = at(x, y);
        if (i < 0 || !tiles[i] || tiles[i] === T.WATER) continue;
        const round = s.id === 'garden' ? Math.hypot(x - s.gx, y - s.gy) <= s.a + 0.6 : true;
        if (round) tiles[i] = ground;
      }
    }
  }

  // Roads: a minimum spanning tree from the Garden (Prim), each edge a cobbled band 2 tiles wide.
  const list = Object.values(sites);
  const start = sites.garden || list[0];
  const inTree = [start];
  const rest = list.filter((s) => s !== start);
  const edges = [];
  const dist = (a, b) => Math.hypot(a.gx - b.gx, a.gy - b.gy);
  while (rest.length) {
    let best = null;
    for (const a of inTree) for (const b of rest) if (!best || dist(a, b) < best.d) best = { a, b, d: dist(a, b) };
    edges.push([best.a.id, best.b.id]);
    inTree.push(best.b);
    rest.splice(rest.indexOf(best.b), 1);
  }
  const roads = [];
  for (const [ai, bi] of edges) {
    const a = sites[ai];
    const b = sites[bi];
    // A gentle bend through a midpoint.
    const mx = (a.gx + b.gx) / 2 + (r() - 0.5) * 2;
    const my = (a.gy + b.gy) / 2 + (r() - 0.5) * 2;
    const pts = [];
    for (const [p, q] of [[a, { gx: mx, gy: my }], [{ gx: mx, gy: my }, b]]) {
      const steps = Math.ceil(dist(p, q) * 3);
      for (let k = 0; k <= steps; k++) pts.push({ x: p.gx + ((q.gx - p.gx) * k) / steps, y: p.gy + ((q.gy - p.gy) * k) / steps });
    }
    roads.push({ from: ai, to: bi, pts });
    for (const p of pts) {
      for (let y = Math.floor(p.y - 1); y <= Math.ceil(p.y + 1); y++) {
        for (let x = Math.floor(p.x - 1); x <= Math.ceil(p.x + 1); x++) {
          const i = at(x, y);
          if (i < 0 || !tiles[i] || Math.hypot(x - p.x, y - p.y) > 0.85) continue;
          if (tiles[i] === T.WATER) tiles[i] = T.BRIDGE;
          else if (tiles[i] !== T.PLAZA && tiles[i] !== T.BRIDGE) tiles[i] = T.COBBLE;
        }
      }
    }
  }

  // Keep tiles free where buildings stand.
  const nearSite = (x, y, extra) => list.some((s) => Math.abs(x - s.gx) < s.a + extra && Math.abs(y - s.gy) < s.b + extra);
  const isGround = (x, y) => tiles[at(x, y)] === T.GRASS && height[at(x, y)] === 1;
  const block2 = (x, y) => isGround(x, y) && isGround(x + 1, y) && isGround(x, y + 1) && isGround(x + 1, y + 1);

  // Fields on open grass.
  const fields = [];
  for (let k = 0; k < 400 && fields.length < 4; k++) {
    const x = Math.floor(4 + r() * (N - 8));
    const y = Math.floor(4 + r() * (N - 8));
    const w = 3;
    const h = 2 + Math.floor(r() * 2);
    let ok = true;
    for (let yy = y; yy < y + h && ok; yy++) for (let xx = x; xx < x + w && ok; xx++) ok = tiles[at(xx, yy)] === T.GRASS && height[at(xx, yy)] === 1;
    if (!ok || nearSite(x + 1, y + 1, 1.2) || fields.some((o) => Math.abs(o.x - x) < 5 && Math.abs(o.y - y) < 4)) continue;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) tiles[at(xx, yy)] = T.FIELD;
    fields.push({ x, y, w, h, crop: r() < 0.5 ? 'wheat' : 'green' });
  }
  // House lots along the roads: the village fills them as it grows (closest to the Garden first).
  const roadTiles = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (tiles[at(x, y)] === T.COBBLE) roadTiles.push([x, y]);
  const toRoad = (x, y) => roadTiles.reduce((m, [rx, ry]) => Math.min(m, Math.hypot(rx - x, ry - y)), Infinity);
  const garden = sites.garden || list[0];
  const candidates = [];
  for (let y = 2; y < N - 3; y++) {
    for (let x = 2; x < N - 3; x++) {
      if (!block2(x, y) || nearSite(x + 1, y + 1, 1.6)) continue;
      const d = toRoad(x + 1, y + 1);
      if (d < 1.6 || d > 3.2) continue;
      if (map0Water(x + 1, y + 1, 2.2)) continue;
      candidates.push({ gx: x + 1, gy: y + 1, h: 1, d: Math.hypot(x + 1 - garden.gx, y + 1 - garden.gy) });
    }
  }
  function map0Water(x, y, r0) {
    for (let yy = Math.floor(y - r0); yy <= Math.ceil(y + r0); yy++) for (let xx = Math.floor(x - r0); xx <= Math.ceil(x + r0); xx++) if (tiles[at(xx, yy)] === T.WATER || tiles[at(xx, yy)] === T.BRIDGE) return true;
    return false;
  }
  const lots = [];
  for (const c of candidates.sort((a, b) => a.d - b.d)) {
    if (lots.length >= 16) break;
    if (lots.some((l) => Math.hypot(l.gx - c.gx, l.gy - c.gy) < 3.1)) continue;
    lots.push({ gx: c.gx, gy: c.gy, h: 1, design: Math.floor(r() * 8) });
  }

  // A watermill on the river bank (its wheel towards the water, the app's +gy), a windmill on open land.
  const mills = { water: null, wind: null };
  const free = (x, y, extra) => !nearSite(x, y, extra) && !lots.some((l) => Math.hypot(l.gx - x, l.gy - y) < 2.6);
  let best = null;
  for (let y = 2; y < N - 3; y++) {
    for (let x = 2; x < N - 3; x++) {
      if (!block2(x, y) || !free(x + 1, y + 1, 1.5) || toRoad(x + 1, y + 1) < 1.4) continue;
      const wheel = tiles[at(x + 1, y + 2)] === T.WATER || tiles[at(x + 1, y + 3)] === T.WATER || tiles[at(x, y + 3)] === T.WATER;
      if (!wheel || tiles[at(x + 1, y + 2)] === T.BRIDGE) continue;
      const d = Math.hypot(x + 1 - C, y + 1 - C);
      if (!best || d < best.d) best = { gx: x + 1, gy: y + 1, h: 1, d };
    }
  }
  mills.water = best && { gx: best.gx, gy: best.gy, h: 1 };
  const near = (x, y, extra) => nearSite(x, y, extra) || lots.some((l) => Math.hypot(l.gx - x, l.gy - y) < 1.4 + extra) || [mills.water].some((m) => m && Math.hypot(m.gx - x, m.gy - y) < 1.4 + extra);

  best = null;
  for (let y = 2; y < N - 3; y++) {
    for (let x = 2; x < N - 3; x++) {
      if (!block2(x, y) || near(x + 1, y + 1, 1.2) || toRoad(x + 1, y + 1) < 1.4) continue;
      const toField = fields.reduce((m, fl) => Math.min(m, Math.hypot(fl.x + fl.w / 2 - x - 1, fl.y + fl.h / 2 - y - 1)), Infinity);
      const score = (Number.isFinite(toField) ? toField : 10) + Math.hypot(x + 1 - C, y + 1 - C) * 0.15;
      if (!best || score < best.score) best = { gx: x + 1, gy: y + 1, h: 1, score };
    }
  }
  mills.wind = best && { gx: best.gx, gy: best.gy, h: 1 };
  const nearAll = (x, y, extra) => near(x, y, extra) || (mills.wind && Math.hypot(mills.wind.gx - x, mills.wind.gy - y) < 1.2 + extra);

  // Trees: a forest towards the edges, groves in between; small things on the grass.
  const trees = [];
  const props = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = at(x, y);
      if (tiles[i] !== T.GRASS || nearAll(x, y, 1.1)) continue;
      const edge = Math.hypot(x - C, y - C) / R;
      const dense = noise2(x / 4, y / 4, seed + 3) * 0.9 + edge * 0.6 - 0.28;
      const roll = r();
      if (roll < dense) {
        trees.push({ gx: x + 0.5 + (r() - 0.5) * 0.5, gy: y + 0.5 + (r() - 0.5) * 0.5, kind: r() < 0.35 ? 'pine' : r() < 0.15 ? 'birch' : 'oak', k: 0.8 + r() * 0.45, h: height[i] });
      } else if (roll > 0.9) {
        const kinds = ['rock', 'bush', 'flowers', 'bush', 'stump', 'grass', 'flowers', 'mushroom', 'grass', 'log'];
        props.push({ gx: x + 0.3 + r() * 0.4, gy: y + 0.3 + r() * 0.4, kind: kinds[Math.floor(r() * kinds.length)], h: height[i], seed: Math.floor(r() * 1e6) });
      }
    }
  }

  return { N, tiles, height, sites, roads, edges, trees, props, fields, river, fall, seed, lots, mills, tile: (x, y) => (at(x, y) < 0 ? 0 : tiles[at(x, y)]), hgt: (x, y) => (at(x, y) < 0 ? 0 : height[at(x, y)]) };
}

// What a walker keeps clear of: each building's footprint with a little room, and the Garden's fountain
// (the plaza around it is open ground).
const CLEARANCE = 0.5;
function obstacles(map) {
  return Object.values(map.sites).map((s) => {
    const [a, b] = s.id === 'garden' ? [0.85, 0.85] : [s.a + CLEARANCE, s.b + CLEARANCE];
    return { x0: s.gx - a, x1: s.gx + a, y0: s.gy - b, y1: s.gy + b };
  });
}

const inside = (o, p) => p.x > o.x0 && p.x < o.x1 && p.y > o.y0 && p.y < o.y1;

// From p to q (both outside o) along o's edge, the shorter way round.
function around(o, p, q) {
  const w = o.x1 - o.x0;
  const h = o.y1 - o.y0;
  const L = 2 * (w + h);
  const onEdge = (pt) => ({ x: Math.min(o.x1, Math.max(o.x0, pt.x)), y: Math.min(o.y1, Math.max(o.y0, pt.y)) });
  const pos = ({ x, y }) => (y === o.y0 ? x - o.x0 : x === o.x1 ? w + y - o.y0 : y === o.y1 ? w + h + o.x1 - x : 2 * w + h + o.y1 - y);
  const corners = [
    { s: 0, x: o.x0, y: o.y0 },
    { s: w, x: o.x1, y: o.y0 },
    { s: w + h, x: o.x1, y: o.y1 },
    { s: 2 * w + h, x: o.x0, y: o.y1 },
  ];
  const a = onEdge(p);
  const b = onEdge(q);
  const sa = pos(a);
  const d = (pos(b) - sa + L) % L;
  const forward = d <= L / 2;
  const off = (c) => (forward ? c.s - sa : sa - c.s) + L * 2;
  const span = forward ? d : L - d;
  const between = corners.filter((c) => off(c) % L > 0 && off(c) % L < span).sort((c1, c2) => (off(c1) % L) - (off(c2) % L));
  return [a, ...between.map(({ x, y }) => ({ x, y })), b];
}

// A walk that would cross a building goes round it instead. A stretch that runs to either end of the
// walk stays (someone heading inside a place walks in).
function avoid(pts, boxes) {
  let out = pts;
  for (const o of boxes) {
    for (let guard = 0; guard < 8; guard++) {
      const i = out.findIndex((p, k) => k > 0 && inside(o, p) && !inside(o, out[k - 1]));
      if (i < 0) break;
      let j = i;
      while (j < out.length && inside(o, out[j])) j++;
      if (j >= out.length) break;
      out = [...out.slice(0, i), ...around(o, out[i - 1], out[j]), ...out.slice(j)];
    }
  }
  return out;
}

/**
 * The walk between two places along the roads: grid points, start to end. With `ends`
 * ({ start, end }: where the walker stands at each place) the walk starts and ends there and goes
 * round the buildings on the way, never through them.
 */
export function route(map, from, to, ends) {
  const path = roadPath(map, from, to);
  if (!path.length || !ends) return path;
  return avoid([ends.start || path[0], ...path, ends.end || path[path.length - 1]], obstacles(map));
}

function roadPath(map, from, to) {
  if (from === to || !map.sites[from] || !map.sites[to]) return [];
  const adj = new Map();
  for (const rd of map.roads) {
    (adj.get(rd.from) || adj.set(rd.from, []).get(rd.from)).push([rd.to, rd.pts]);
    (adj.get(rd.to) || adj.set(rd.to, []).get(rd.to)).push([rd.from, [...rd.pts].reverse()]);
  }
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const [next, pts] of adj.get(cur) || []) if (!prev.has(next)) (prev.set(next, [cur, pts]), queue.push(next));
  }
  if (!prev.has(to)) return [];
  const legs = [];
  for (let cur = to; prev.get(cur); cur = prev.get(cur)[0]) legs.unshift(prev.get(cur)[1]);
  return legs.flat().map((p) => ({ x: p.x, y: p.y }));
}

/** A point part-way (0..1) along a polyline of grid points. */
export function along(pts, t) {
  if (!pts.length) return null;
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const target = Math.max(0, Math.min(1, t)) * len[len.length - 1];
  let i = 1;
  while (i < pts.length - 1 && len[i] < target) i++;
  const seg = len[i] - len[i - 1] || 1;
  const k = (target - len[i - 1]) / seg;
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k };
}
