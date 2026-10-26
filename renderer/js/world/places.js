// The places of the Inner World, built from the drawing kit (art.js) on their sites (map.js). Each grows
// with its level (0 = a construction site) and shows the user's data: banners per habit, a table per
// deck, books for concepts understood… Static parts are drawn into the cached scene; moving parts are
// registered as emitters (smoke, forge fire, fountain, floating books, ravens, flames, magic light) and
// animated every frame by scene.js. Lights (windows, lamps) glow at night.
import { W, HZ, box, house, tower, prop, banner, poly, rgba, mix, shadowAt, windowOn, doorOn } from './art.js';

const ACCENTS = (P) => [P.c1, P.c3, P.ok, P.warn, P.c2];

/** Draw a place. ctx: { P, level, details, lights, emitters }. Returns its top (world y). */
export function drawPlace(c, id, site, ctx) {
  const z = site.h * HZ;
  if (ctx.level === 0 && !ALWAYS.has(id)) return construction(c, site, z, ctx);
  return (BUILD[id] || BUILD.garden)(c, site, z, ctx);
}
const ALWAYS = new Set(['garden', 'hearth', 'stage', 'lookout', 'workshop']);

function construction(c, s, z, { P }) {
  const { gx, gy, a, b } = s;
  // Foundation stones along the footprint, scaffolding, materials, a sign.
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    box(c, P, gx - a + t * 2 * a, gy - b, 0.13, 0.1, z, 5, { left: P.stone, right: P.stoneShade, top: P.stoneLight });
  }
  box(c, P, gx - 0.2, gy - 0.1, a * 0.8, b * 0.7, z, 6, { left: P.stone, right: P.stoneShade, top: P.stoneLight });
  for (const [dx, dy] of [[-a * 0.8, b * 0.7], [a * 0.8, b * 0.7], [a * 0.8, -b * 0.7]]) {
    const p = W(gx + dx, gy + dy, z);
    poly(c, [{ x: p.x - 1.5, y: p.y }, { x: p.x + 1.5, y: p.y }, { x: p.x + 1.5, y: p.y - 46 }, { x: p.x - 1.5, y: p.y - 46 }], rgba(P.wood), rgba(P.outline, 0.6));
  }
  const l1 = W(gx - a * 0.8, gy + b * 0.7, z + 30);
  const l2 = W(gx + a * 0.8, gy + b * 0.7, z + 30);
  const l3 = W(gx + a * 0.8, gy - b * 0.7, z + 30);
  for (const [p, q] of [[l1, l2], [l2, l3]]) poly(c, [p, q, { x: q.x, y: q.y + 3 }, { x: p.x, y: p.y + 3 }], rgba(P.woodLight), rgba(P.outline, 0.5));
  for (let k = 0; k < 3; k++) prop(c, P, 'crate', gx + a + 0.5, gy + b - 0.4 + k * 0.4, z + (k === 2 ? 10 : 0));
  // Sign.
  const p = W(gx - a - 0.3, gy + b + 0.4, z);
  poly(c, [{ x: p.x - 1, y: p.y }, { x: p.x + 1, y: p.y }, { x: p.x + 1, y: p.y - 18 }, { x: p.x - 1, y: p.y - 18 }], rgba(P.timberDark));
  poly(c, [{ x: p.x - 10, y: p.y - 24 }, { x: p.x + 10, y: p.y - 20 }, { x: p.x + 10, y: p.y - 12 }, { x: p.x - 10, y: p.y - 16 }], rgba(P.woodLight), rgba(P.outline, 0.7));
  return W(gx, gy, z + 50).y;
}

const BUILD = {
  hearth(c, s, z, { P, level, lights, emitters }) {
    const { gx, gy } = s;
    const homes = [{ dx: 0, dy: -0.4, a: 1.1, b: 0.85, floors: 2, roof: P.roof, axis: 'x', dormers: 1 }];
    if (level >= 2) homes.push({ dx: -1.4, dy: 1.3, a: 0.8, b: 0.7, floors: 1, roof: P.slate, axis: 'y', shutter: P.banner });
    if (level >= 3) homes.push({ dx: 1.6, dy: 0.9, a: 0.8, b: 0.75, floors: 1, roof: P.accentRoof, axis: 'x', shutter: P.copper });
    let top = Infinity;
    for (const h of homes.sort((a, b) => a.dx + a.dy - (b.dx + b.dy))) {
      const r = house(c, P, gx + h.dx, gy + h.dy, z, h, lights);
      if (r.smoke) emitters.push({ kind: 'smoke', ...r.smoke });
      top = Math.min(top, r.top);
    }
    prop(c, P, 'barrel', gx + 1.2, gy + 0.75, z);
    prop(c, P, 'barrel', gx + 1.5, gy + 0.55, z);
    prop(c, P, 'bench', gx - 0.3, gy + 1, z);
    prop(c, P, 'flowers', gx + 0.3, gy + 1.25, z);
    if (level >= 3) prop(c, P, 'well', gx + 0.4, gy + 1.9, z);
    prop(c, P, 'lamp', gx - 1, gy + 0.9, z, lights);
    return top;
  },

  library(c, s, z, { P, level, details, lights, emitters }) {
    const { gx, gy } = s;
    // The tower stands at the back corner, the hall in front of it.
    const t = tower(c, P, gx - 0.55, gy - 0.6, z, 0.8, 56 + level * 18, lights, { roof: P.accentRoof, windows: 2 + level });
    const hall = house(c, P, gx + 0.3, gy + 0.35, z, { a: 1.1, b: 0.85, floors: level >= 2 ? 2 : 1, style: 'stone', roof: P.slate, axis: 'x', flowers: false, chimney: false, dormers: level >= 2 ? 2 : 0 }, lights);
    // Book stacks and a reading bench by the door.
    for (let k = 0; k < Math.min(3, details.topics?.length || 1); k++) {
      const p = W(gx + 1.5, gy + 0.9 - k * 0.35, z);
      for (let j = 0; j < 3; j++) poly(c, [{ x: p.x - 5, y: p.y - j * 3 }, { x: p.x + 5, y: p.y - j * 3 }, { x: p.x + 5, y: p.y - j * 3 - 3 }, { x: p.x - 5, y: p.y - j * 3 - 3 }], rgba(ACCENTS(P)[(k + j) % 5]), rgba(P.outline, 0.6));
    }
    prop(c, P, 'bench', gx - 0.6, gy + 1.5, z);
    prop(c, P, 'lamp', gx + 1.6, gy + 1.5, z, lights);
    const books = Math.min(14, (details.topics || []).reduce((n, x) => n + x.understood, 0));
    if (books) emitters.push({ kind: 'books', ...W(gx - 0.55, gy - 0.6, z + 30 + level * 8), n: books, r: 40 });
    if (level >= 3) emitters.push({ kind: 'magic', ...t.apex, tone: P.c1 });
    return Math.min(t.top, hall.top);
  },

  cafe(c, s, z, { P, level, details, lights, emitters }) {
    const { gx, gy } = s;
    const floors = level >= 2 ? 2 : 1;
    const r = house(c, P, gx - 0.2, gy - 0.4, z, { a: 1.3, b: 0.85, floors, roof: P.roof, axis: 'x', dormers: level >= 3 ? 2 : 0 }, lights);
    if (r.smoke) emitters.push({ kind: 'smoke', ...r.smoke });
    // A striped awning over the front.
    const zA = z + 22;
    const back = [W(gx - 1.45, gy + 0.46, zA), W(gx + 1.05, gy + 0.46, zA)];
    const front = [W(gx - 1.45, gy + 1.05, zA - 8), W(gx + 1.05, gy + 1.05, zA - 8)];
    const stripes = 8;
    for (let k = 0; k < stripes; k++) {
      const t0 = k / stripes;
      const t1 = (k + 1) / stripes;
      const L = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      poly(c, [L(back[0], back[1], t0), L(back[0], back[1], t1), L(front[0], front[1], t1), L(front[0], front[1], t0)], rgba(k % 2 ? P.cloth : P.accentRoof2));
    }
    poly(c, [back[0], back[1], front[1], front[0]], null, rgba(P.outline, 0.7));
    // The hanging sign: a mug.
    const sp = W(gx + 1.15, gy + 0.3, z + 30);
    poly(c, [{ x: sp.x, y: sp.y }, { x: sp.x + 12, y: sp.y - 6 }], null, rgba(P.timberDark), 2);
    poly(c, [{ x: sp.x + 4, y: sp.y }, { x: sp.x + 16, y: sp.y - 6 }, { x: sp.x + 16, y: sp.y + 6 }, { x: sp.x + 4, y: sp.y + 12 }], rgba(P.woodLight), rgba(P.outline, 0.8));
    poly(c, [{ x: sp.x + 8, y: sp.y + 2 }, { x: sp.x + 12, y: sp.y }, { x: sp.x + 12, y: sp.y + 6 }, { x: sp.x + 8, y: sp.y + 8 }], rgba(P.lamp));
    // A table with a parasol for each deck.
    const decks = details.decks?.length ? details.decks : [{ name: '' }];
    decks.slice(0, 4).forEach((d, i) => {
      const tx = gx - 1.1 + i * 0.8;
      const ty = gy + 1.55 + (i % 2) * 0.3;
      const p = W(tx, ty, z);
      shadowAt(c, p.x + 3, p.y + 1, 10, 4);
      for (const dx of [-7, 7]) poly(c, [{ x: p.x + dx - 2, y: p.y }, { x: p.x + dx + 2, y: p.y }, { x: p.x + dx + 2, y: p.y - 5 }, { x: p.x + dx - 2, y: p.y - 5 }], rgba(P.woodShade));
      poly(c, [{ x: p.x - 0.8, y: p.y }, { x: p.x + 0.8, y: p.y }, { x: p.x + 0.8, y: p.y - 9 }, { x: p.x - 0.8, y: p.y - 9 }], rgba(P.timberDark));
      c.beginPath();
      c.ellipse(p.x, p.y - 9, 7, 3, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.woodLight);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.6);
      c.stroke();
      poly(c, [{ x: p.x - 0.6, y: p.y - 9 }, { x: p.x + 0.6, y: p.y - 9 }, { x: p.x + 0.6, y: p.y - 26 }, { x: p.x - 0.6, y: p.y - 26 }], rgba(P.timberDark));
      const col = ACCENTS(P)[i % 5];
      c.beginPath();
      c.moveTo(p.x - 12, p.y - 22);
      c.quadraticCurveTo(p.x, p.y - 34, p.x + 12, p.y - 22);
      c.quadraticCurveTo(p.x, p.y - 19, p.x - 12, p.y - 22);
      c.fillStyle = rgba(col);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.6);
      c.stroke();
    });
    for (let k = 0; k < 3; k++) prop(c, P, 'barrel', gx + 1.3, gy - 0.5 + k * 0.35, z);
    prop(c, P, 'lamp', gx + 1.5, gy + 1.4, z, lights);
    return r.top;
  },

  workshop(c, s, z, { P, level, lights, emitters }) {
    const { gx, gy } = s;
    // Woodpile behind, the smithy, its open forge on the left front face.
    for (let k = 0; k < 3 + level; k++) {
      const p = W(gx - 1.4, gy - 0.6 + k * 0.25, z + (k % 2) * 6);
      c.beginPath();
      c.ellipse(p.x, p.y - 4, 4, 4, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.woodLight);
      c.fill();
      c.strokeStyle = rgba(P.trunk);
      c.lineWidth = 2;
      c.stroke();
    }
    const r = house(c, P, gx, gy - 0.2, z, { a: 1.2, b: 0.9, floors: 1, style: 'stone', roof: P.slate, axis: 'x', door: 'R', flowers: false, chimney: false }, lights);
    // The forge opening.
    const L = (u, v) => {
      const p0 = W(gx - 1.2, gy + 0.7, z);
      const p1 = W(gx + 1.2, gy + 0.7, z);
      return { x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u - v * 30 };
    };
    poly(c, [L(0.18, 0.02), L(0.62, 0.02), L(0.62, 0.62), L(0.4, 0.75), L(0.18, 0.62)], rgba([30, 22, 20]), rgba(P.outline, 0.9), 1.5);
    emitters.push({ kind: 'forge', ...L(0.4, 0.18), place: 'workshop' });
    // A tall chimney with smoke (and sparks while working).
    const top = W(gx + 0.55, gy - 0.75, z + 76);
    box(c, P, gx + 0.55, gy - 0.75, 0.2, 0.2, z + 30, 42, { left: mix(P.roof, P.stone, 0.45), right: mix(P.roofShade, P.stoneShade, 0.45), top: P.rockDark });
    box(c, P, gx + 0.55, gy - 0.75, 0.26, 0.26, z + 72, 4, { left: P.stoneLight, right: P.stone, top: [40, 34, 32] });
    emitters.push({ kind: 'smoke', ...top, place: 'workshop', heavy: true });
    // Anvil, grindstone, crates.
    const an = W(gx - 0.1, gy + 1.5, z);
    shadowAt(c, an.x + 3, an.y + 1, 9, 3);
    box(c, P, gx - 0.1, gy + 1.5, 0.12, 0.08, z, 6, { left: P.rockDark, right: [60, 56, 54], top: P.rock });
    box(c, P, gx - 0.1, gy + 1.5, 0.28, 0.12, z + 6, 4, { left: [90, 90, 96], right: [64, 64, 70], top: [140, 140, 148] });
    for (let k = 0; k < level; k++) prop(c, P, 'crate', gx + 1.5, gy + 0.4 + k * 0.4, z);
    if (level >= 2) prop(c, P, 'barrel', gx + 0.9, gy + 1.4, z);
    if (level >= 3) {
      // A cart.
      box(c, P, gx - 1.3, gy + 1.5, 0.45, 0.3, z + 5, 7, { left: P.woodLight, right: P.wood, top: P.woodShade });
      for (const dx of [-0.3, 0.3]) {
        const w = W(gx - 1.3 + dx, gy + 1.82, z + 5);
        c.beginPath();
        c.ellipse(w.x, w.y, 4, 5, -0.4, 0, Math.PI * 2);
        c.strokeStyle = rgba(P.timberDark);
        c.lineWidth = 2;
        c.stroke();
      }
    }
    prop(c, P, 'lamp', gx + 1.4, gy + 1.3, z, lights);
    return Math.min(r.top, top.y);
  },

  garden(c, s, z, { P, level, details, lights, emitters }) {
    const { gx, gy } = s;
    // Flower beds around the plaza: a bloom for each habit kept today, buds for the others.
    const habits = details.habits || [];
    const beds = Math.max(4, Math.min(8, habits.length || 4));
    for (let i = 0; i < beds; i++) {
      const a = (i / beds) * Math.PI * 2 + 0.4;
      const bx = gx + Math.cos(a) * 2.3;
      const by = gy + Math.sin(a) * 2.3;
      const p = W(bx, by, z);
      c.beginPath();
      c.ellipse(p.x, p.y, 13, 6, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.soil);
      c.fill();
      c.strokeStyle = rgba(P.stoneShade);
      c.lineWidth = 2;
      c.stroke();
      const h = habits[i];
      const bloom = h ? h.done : level >= 2;
      for (let k = 0; k < 6; k++) {
        const fx = p.x - 8 + (k % 3) * 8;
        const fy = p.y - 2 + Math.floor(k / 3) * 3;
        c.beginPath();
        c.arc(fx, fy - 4, bloom ? 2.6 : 1.6, 0, Math.PI * 2);
        c.fillStyle = rgba(bloom ? ACCENTS(P)[(i + k) % 5] : P.leafDark);
        c.fill();
        c.beginPath();
        c.arc(fx + 1.5, fy - 1, 1.8, 0, Math.PI * 2);
        c.fillStyle = rgba(P.leaf);
        c.fill();
      }
    }
    // The fountain: two tiers of stone basins.
    const f = W(gx, gy, z);
    const basin = (y, rx, ry, h) => {
      c.beginPath();
      c.ellipse(f.x, y, rx, ry, 0, 0, Math.PI);
      c.lineTo(f.x - rx, y - h);
      c.ellipse(f.x, y - h, rx, ry, 0, Math.PI, 0, true);
      c.closePath();
      c.fillStyle = rgba(P.stone);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.7);
      c.lineWidth = 1.2;
      c.stroke();
      c.beginPath();
      c.ellipse(f.x, y - h, rx, ry, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.stoneLight);
      c.fill();
      c.stroke();
      c.beginPath();
      c.ellipse(f.x, y - h, rx - 4, ry - 2, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.water);
      c.fill();
    };
    shadowAt(c, f.x + 6, f.y + 2, 36, 14);
    basin(f.y, 34, 16, 9);
    box(c, P, gx, gy, 0.15, 0.15, z + 9, 16, { left: P.stone, right: P.stoneShade });
    basin(f.y - 25, 14, 6.5, 4);
    emitters.push({ kind: 'fountain', x: f.x, y: f.y - 32, base: f.y - 9 });
    // Benches and lamps around.
    prop(c, P, 'bench', gx - 1.6, gy + 1.1, z);
    prop(c, P, 'bench', gx + 1.1, gy - 1.6, z);
    for (const [dx, dy] of [[-1.9, -1.9], [1.9, 1.9], [1.9, -1.9], [-1.9, 1.9]].slice(0, 2 + level)) prop(c, P, 'lamp', gx + dx, gy + dy, z, lights);
    if (level >= 2) {
      // A market stall.
      const sx = gx + 1.7;
      const sy = gy + 0.2;
      box(c, P, sx, sy, 0.5, 0.3, z, 9, { left: P.woodLight, right: P.wood, top: P.woodLight });
      for (const [dx, dy] of [[-0.5, 0.3], [0.5, 0.3], [0.5, -0.3]]) {
        const p = W(sx + dx, sy + dy, z + 9);
        poly(c, [{ x: p.x - 1, y: p.y }, { x: p.x + 1, y: p.y }, { x: p.x + 1, y: p.y - 18 }, { x: p.x - 1, y: p.y - 18 }], rgba(P.timberDark));
      }
      poly(c, [W(sx - 0.6, sy + 0.4, z + 27), W(sx + 0.6, sy + 0.4, z + 27), W(sx + 0.6, sy - 0.4, z + 30), W(sx - 0.6, sy - 0.4, z + 30)], rgba(P.accentRoof2), rgba(P.outline, 0.7));
      for (let k = 0; k < 4; k++) {
        const p = W(sx - 0.35 + k * 0.23, sy + 0.1, z + 9);
        c.beginPath();
        c.arc(p.x, p.y - 2, 2.5, 0, Math.PI * 2);
        c.fillStyle = rgba([P.banner, P.lamp, P.leaf, P.c3][k]);
        c.fill();
      }
    }
    return f.y - 60;
  },

  grounds(c, s, z, { P, level, details, lights, emitters }) {
    const { gx, gy, a, b } = s;
    // The fence: back sides first.
    const post = (x, y) => {
      const p = W(x, y, z);
      poly(c, [{ x: p.x - 1.5, y: p.y }, { x: p.x + 1.5, y: p.y }, { x: p.x + 1.5, y: p.y - 12 }, { x: p.x - 1.5, y: p.y - 12 }], rgba(P.wood), rgba(P.outline, 0.5));
    };
    const rail = (x0, y0, x1, y1) => {
      for (const hh of [5, 10]) poly(c, [W(x0, y0, z + hh), W(x1, y1, z + hh), W(x1, y1, z + hh - 2), W(x0, y0, z + hh - 2)], rgba(P.woodLight), rgba(P.outline, 0.4));
    };
    const side = (x0, y0, x1, y1) => {
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5);
      for (let k = 0; k <= n; k++) post(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
      rail(x0, y0, x1, y1);
    };
    side(gx - a, gy - b, gx + a, gy - b);
    side(gx - a, gy - b, gx - a, gy + b);
    // Banners along the back: one per habit, raised when kept today; flames for long streaks.
    const habits = details.habits?.length ? details.habits : [{ name: '', done: false, streak: 0, unit: 'd' }];
    habits.slice(0, 8).forEach((h, i, all) => {
      const t = (i + 0.5) / all.length;
      const p = W(gx - a + 0.4 + t * (2 * a - 0.8), gy - b + 0.4, z);
      banner(c, P, p.x, p.y, 40, ACCENTS(P)[i % 5], h.done ? 1 : 0.15);
      const days = h.unit === 'wk' ? h.streak * 7 : h.streak;
      if (days >= 7) emitters.push({ kind: 'flame', x: p.x, y: p.y - 46, n: days >= 30 ? 2 : 1 });
    });
    // Training dummies, an archery target, a weapon rack.
    const dummy = (x, y) => {
      const p = W(x, y, z);
      shadowAt(c, p.x + 3, p.y + 1, 7, 3);
      poly(c, [{ x: p.x - 1.5, y: p.y }, { x: p.x + 1.5, y: p.y }, { x: p.x + 1.5, y: p.y - 22 }, { x: p.x - 1.5, y: p.y - 22 }], rgba(P.wood));
      poly(c, [{ x: p.x - 9, y: p.y - 17 }, { x: p.x + 9, y: p.y - 17 }, { x: p.x + 9, y: p.y - 14 }, { x: p.x - 9, y: p.y - 14 }], rgba(P.wood), rgba(P.outline, 0.5));
      c.beginPath();
      c.ellipse(p.x, p.y - 15, 6, 8, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(P.wheat);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.6);
      c.stroke();
      c.beginPath();
      c.arc(p.x, p.y - 26, 4.5, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    };
    dummy(gx - 0.6, gy + 0.2);
    if (level >= 2) dummy(gx + 0.4, gy - 0.3);
    if (level >= 3) {
      const p = W(gx + a - 0.5, gy + 0.3, z);
      poly(c, [{ x: p.x - 1, y: p.y }, { x: p.x + 1, y: p.y }, { x: p.x + 1, y: p.y - 14 }, { x: p.x - 1, y: p.y - 14 }], rgba(P.timberDark));
      for (const [r, col] of [[10, P.cloth], [7.5, P.banner], [5, P.cloth], [2.5, P.banner]]) {
        c.beginPath();
        c.ellipse(p.x, p.y - 22, r * 0.75, r, 0, 0, Math.PI * 2);
        c.fillStyle = rgba(col);
        c.fill();
        c.strokeStyle = rgba(P.outline, 0.5);
        c.stroke();
      }
    }
    prop(c, P, 'hay', gx + 0.6, gy + b - 0.3, z);
    // Front sides of the fence last.
    side(gx - a, gy + b, gx + a, gy + b);
    side(gx + a, gy - b, gx + a, gy + b);
    prop(c, P, 'lamp', gx + a + 0.4, gy + b + 0.4, z, lights);
    return W(gx - a, gy - b, z + 60).y;
  },

  observatory(c, s, z, { P, level, lights, emitters }) {
    const { gx, gy } = s;
    if (level >= 2) house(c, P, gx - 1, gy + 0.4, z, { a: 0.6, b: 0.6, floors: 1, style: 'stone', roof: P.slate, axis: 'y', chimney: false, flowers: false }, lights);
    const t = tower(c, P, gx + 0.2, gy - 0.2, z, 1.0, 34 + level * 10, lights, { roof: mix(P.copper, P.c1, 0.35), dome: true, windows: 2 });
    // The telescope through the dome's slit.
    const a = W(gx + 0.2, gy - 0.2, z + 34 + level * 10 + 18);
    poly(c, [{ x: a.x - 3, y: a.y }, { x: a.x + 22, y: a.y - 20 }, { x: a.x + 26, y: a.y - 15 }, { x: a.x + 1, y: a.y + 5 }], rgba([110, 100, 92]), rgba(P.outline, 0.8));
    poly(c, [{ x: a.x + 18, y: a.y - 17 }, { x: a.x + 24, y: a.y - 22 }, { x: a.x + 28, y: a.y - 17 }, { x: a.x + 22, y: a.y - 12 }], rgba(P.lamp, 0.8));
    if (level >= 3) emitters.push({ kind: 'magic', x: a.x + 25, y: a.y - 18, tone: P.c2 });
    prop(c, P, 'lamp', gx + 1.2, gy + 1.1, z, lights);
    prop(c, P, 'bench', gx - 0.4, gy + 1.4, z);
    return t.top;
  },

  archive(c, s, z, { P, level, details, lights }) {
    const { gx, gy } = s;
    // Steps, the stone hall, a portico of columns, a pediment.
    for (let k = 0; k < 3; k++) box(c, P, gx, gy, 1.7 - k * 0.12, 1.3 - k * 0.12, z + k * 3, 3, { left: P.stoneLight, right: P.stone, top: P.stoneLight });
    const zz = z + 9;
    const hall = box(c, P, gx - 0.25, gy - 0.25, 1.25, 0.95, zz, 34, { left: P.stone, right: P.stoneShade });
    // Lit slits on the side for memories kept.
    const slits = Math.min(6, Math.ceil(((details.memories || 0) + (details.records || 0)) / 5));
    for (let k = 0; k < slits; k++) windowOn(c, P, hall.R, (k + 0.5) / Math.max(slits, 3), 0.3, 0.06, 0.45, lights, { shutters: false });
    doorOn(c, P, hall.L, 0.5, 0.2, 0.62);
    // Columns along the front.
    const cols = 3 + level;
    for (let k = 0; k < cols; k++) {
      const cx = gx - 1.45 + (k * 2.4) / (cols - 1);
      const p = W(cx, gy + 1.05, zz);
      const g = c.createLinearGradient(p.x - 4, 0, p.x + 4, 0);
      g.addColorStop(0, rgba(P.stoneLight));
      g.addColorStop(1, rgba(P.stoneShade));
      poly(c, [{ x: p.x - 4, y: p.y }, { x: p.x + 4, y: p.y }, { x: p.x + 4, y: p.y - 34 }, { x: p.x - 4, y: p.y - 34 }], g, rgba(P.outline, 0.6));
      poly(c, [{ x: p.x - 6, y: p.y - 34 }, { x: p.x + 6, y: p.y - 34 }, { x: p.x + 6, y: p.y - 37 }, { x: p.x - 6, y: p.y - 37 }], rgba(P.stoneLight), rgba(P.outline, 0.6));
      for (const dx of [-1.5, 1.5]) poly(c, [{ x: p.x + dx - 0.3, y: p.y - 2 }, { x: p.x + dx + 0.3, y: p.y - 2 }, { x: p.x + dx + 0.3, y: p.y - 32 }, { x: p.x + dx - 0.3, y: p.y - 32 }], rgba(P.outline, 0.15));
    }
    box(c, P, gx, gy + 0.15, 1.6, 1.05, zz + 37, 5, { left: P.stoneLight, right: P.stone, top: P.stone });
    // Pediment: a shallow gable over the front, stone faced.
    const p1 = W(gx - 1.6, gy + 1.2, zz + 42);
    const p2 = W(gx + 1.6, gy + 1.2, zz + 42);
    const pk = W(gx, gy + 1.2, zz + 62);
    poly(c, [W(gx - 1.7, gy - 0.9, zz + 42), W(gx + 1.7, gy - 0.9, zz + 42), W(gx + 1.7, gy + 0.15, zz + 62), W(gx - 1.7, gy + 0.15, zz + 62)], rgba(mix(P.slate, P.stoneShade, 0.3)), rgba(P.outline, 0.7));
    poly(c, [W(gx + 1.7, gy - 0.9, zz + 42), W(gx + 1.7, gy + 1.25, zz + 42), W(gx + 1.7, gy + 0.15, zz + 62)], rgba(P.stoneShade), rgba(P.outline, 0.7));
    poly(c, [p1, p2, pk], rgba(P.stoneLight), rgba(P.outline, 0.7));
    poly(c, [{ x: (p1.x + pk.x) / 2 + 6, y: (p1.y + pk.y) / 2 + 3 }, { x: (p2.x + pk.x) / 2 - 6, y: (p2.y + pk.y) / 2 + 3 }, { x: pk.x, y: pk.y + 8 }], rgba(P.stone));
    for (let k = 0; k < 2 + level; k++) prop(c, P, 'crate', gx + 1.9, gy - 0.6 + k * 0.4, z);
    prop(c, P, 'lamp', gx - 1.9, gy + 1.6, z, lights);
    return pk.y - 4;
  },

  stage(c, s, z, { P, level, lights, emitters }) {
    const { gx, gy } = s;
    // The back frame with curtains, the platform, rows of benches in front.
    const zz = z + 9;
    const f0 = W(gx - 1.3, gy - 0.7, zz);
    const f1 = W(gx + 1.3, gy - 0.7, zz);
    for (const p of [f0, f1]) poly(c, [{ x: p.x - 2.5, y: p.y }, { x: p.x + 2.5, y: p.y }, { x: p.x + 2.5, y: p.y - 52 }, { x: p.x - 2.5, y: p.y - 52 }], rgba(P.wood), rgba(P.outline, 0.7));
    poly(c, [{ x: f0.x - 4, y: f0.y - 52 }, { x: f1.x + 4, y: f1.y - 52 }, { x: f1.x + 4, y: f1.y - 58 }, { x: f0.x - 4, y: f0.y - 58 }], rgba(P.woodLight), rgba(P.outline, 0.7));
    const curtain = mix(P.banner, P.c3, 0.4);
    const L = (t, dy) => ({ x: f0.x + (f1.x - f0.x) * t, y: f0.y + (f1.y - f0.y) * t - dy });
    for (const [t0, t1] of [[0.02, 0.36], [0.64, 0.98]]) {
      poly(c, [L(t0, 50), L(t1, 50), L(t1 - 0.08, 0), L(t0, 0)], rgba(curtain), rgba(P.outline, 0.7));
      for (let k = 1; k < 4; k++) poly(c, [L(t0 + ((t1 - t0) * k) / 4, 50), L(t0 + ((t1 - t0) * k) / 4 - 0.02, 2)], null, rgba(mix(curtain, P.outline, 0.4)), 1.5);
    }
    poly(c, [L(0.02, 50), L(0.98, 50), L(0.98, 44), L(0.5, 40), L(0.02, 44)], rgba(mix(curtain, P.outline, 0.2)), rgba(P.outline, 0.7));
    box(c, P, gx, gy - 0.1, 1.4, 0.75, z, 9, { left: P.wood, right: P.woodShade, top: P.woodLight });
    for (let k = 1; k < 7; k++) poly(c, [W(gx - 1.4 + (k * 2.8) / 7, gy - 0.85, zz), W(gx - 1.4 + (k * 2.8) / 7, gy + 0.65, zz)], null, rgba(P.outline, 0.25));
    for (let row = 0; row < 1 + level; row++) for (const dx of [-0.8, 0.5]) prop(c, P, 'bench', gx + dx, gy + 1.1 + row * 0.55, z);
    for (let k = 0; k < level; k++) {
      const p = W(gx - 1.6, gy - 0.4 + k * 0.6, z);
      banner(c, P, p.x, p.y, 34, curtain, 1);
    }
    emitters.push({ kind: 'spot', ...W(gx, gy - 0.1, zz), place: 'stage' });
    prop(c, P, 'lamp', gx + 1.7, gy + 0.9, z, lights);
    return f0.y - 60;
  },

  lookout(c, s, z, { P, level, lights, emitters }) {
    const { gx, gy } = s;
    const hgt = 70 + level * 16;
    const legs = [[-0.55, 0.55], [0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]];
    const top = legs.map(([dx, dy]) => W(gx + dx * 0.6, gy + dy * 0.6, z + hgt));
    const foot = legs.map(([dx, dy]) => W(gx + dx, gy + dy, z));
    const legLine = (i) => poly(c, [{ x: foot[i].x - 2, y: foot[i].y }, { x: foot[i].x + 2, y: foot[i].y }, { x: top[i].x + 2, y: top[i].y }, { x: top[i].x - 2, y: top[i].y }], rgba(i === 3 ? P.woodShade : P.wood), rgba(P.outline, 0.7));
    legLine(3);
    legLine(2);
    // Cross braces and a ladder.
    for (let k = 1; k < 4; k++) {
      const t = k / 4;
      const at = (i) => ({ x: foot[i].x + (top[i].x - foot[i].x) * t, y: foot[i].y + (top[i].y - foot[i].y) * t });
      const t2 = (k + 1) / 4;
      const at2 = (i) => ({ x: foot[i].x + (top[i].x - foot[i].x) * t2, y: foot[i].y + (top[i].y - foot[i].y) * t2 });
      poly(c, [at(0), at2(1)], null, rgba(P.woodShade), 2);
      poly(c, [at(1), at2(0)], null, rgba(P.woodShade), 2);
      poly(c, [at(1), at2(2)], null, rgba(P.woodShade), 2);
    }
    legLine(0);
    legLine(1);
    const lad = W(gx, gy + 0.62, z);
    for (let y = 0; y < hgt; y += 7) poly(c, [{ x: lad.x - 4, y: lad.y - y }, { x: lad.x + 4, y: lad.y - y }], null, rgba(P.woodLight), 1.5);
    // The platform and its little hut.
    box(c, P, gx, gy, 0.75, 0.75, z + hgt, 4, { left: P.woodLight, right: P.wood, top: P.woodLight });
    const hut = house(c, P, gx, gy, z + hgt + 4, { a: 0.5, b: 0.5, floors: 1, style: 'wood', roof: P.slate, axis: 'x', flowers: false, chimney: false }, lights);
    const fl = W(gx + 0.5, gy - 0.5, z + hgt + 40);
    banner(c, P, fl.x, fl.y, 18, P.c2, 1);
    emitters.push({ kind: 'ravens', ...W(gx, gy, z + hgt + 60), place: 'lookout' });
    return Math.min(hut.top, fl.y - 20);
  },
};
