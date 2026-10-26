// Inside a place (zoomed in): the roof and the front walls are cut away and the room shows what the
// place holds of you, like a floor plan: a shelf per learning topic, a table per vocabulary deck,
// cabinets of memories, the skill chart, a bed per resident. Names are returned as labels, which
// scene.js writes crisply on top. Open-air places draw as usual, with their name tags.
import { W, HZ, box, poly, rgba, mix, shadowAt, prop, windowOn } from './art.js';
import { drawPlace } from './places.js';

const ACCENTS = (P) => [P.c1, P.c3, P.ok, P.warn, P.c2];
const OPEN = new Set(['garden', 'grounds', 'stage', 'lookout']);

export function drawInterior(c, id, s, ctx) {
  const z = s.h * HZ;
  ctx.labels = [];
  if (OPEN.has(id) || (ctx.level === 0 && !['hearth', 'workshop'].includes(id))) {
    const top = drawPlace(c, id, s, ctx);
    openLabels(id, s, z, ctx);
    return top;
  }
  const room = { gx: s.gx, gy: s.gy, a: s.a + 0.25, b: s.b + 0.25, z };
  shell(c, ctx.P, room, ctx, id === 'library' || id === 'archive' || id === 'observatory' ? 'stone' : 'planks');
  (ROOMS[id] || ROOMS.hearth)(c, room, ctx);
  frontStubs(c, ctx.P, room);
  return W(room.gx - room.a, room.gy - room.b, z + 60).y;
}

// Floor, back walls with windows, and a lamp.
function shell(c, P, r, ctx, floor) {
  const { gx, gy, a, b, z } = r;
  const H = 44;
  // Back walls: their inner faces (+y facing is lit, +x facing in shade).
  const backA = [W(gx - a, gy - b, z), W(gx + a, gy - b, z), W(gx + a, gy - b, z + H), W(gx - a, gy - b, z + H)];
  const backB = [W(gx - a, gy + b, z), W(gx - a, gy - b, z), W(gx - a, gy - b, z + H), W(gx - a, gy + b, z + H)];
  poly(c, backB, rgba(P.plasterShade), rgba(P.outline, 0.7));
  poly(c, backA, rgba(P.plaster), rgba(P.outline, 0.7));
  for (const q of [backA, backB]) poly(c, [q[0], q[1], { x: q[1].x, y: q[1].y - 8 }, { x: q[0].x, y: q[0].y - 8 }], rgba(P.wood), rgba(P.outline, 0.4));
  // Windows in the back walls.
  const fA = (u, v) => ({ x: backA[0].x + (backA[1].x - backA[0].x) * u, y: backA[0].y + (backA[1].y - backA[0].y) * u - v * H });
  fA.quad = (u0, v0, u1, v1) => [fA(u0, v0), fA(u1, v0), fA(u1, v1), fA(u0, v1)];
  fA.side = 'L';
  for (const u of [0.25, 0.75]) windowOn(c, P, fA, u, 0.42, 0.14, 0.38, ctx.lights, { shutters: false });
  // The floor.
  const fl = [W(gx - a, gy - b, z), W(gx + a, gy - b, z), W(gx + a, gy + b, z), W(gx - a, gy + b, z)];
  poly(c, fl, rgba(floor === 'stone' ? P.stone : P.woodLight), rgba(P.outline, 0.6));
  if (floor === 'stone') {
    for (let x = Math.ceil(gx - a); x < gx + a; x += 0.5) poly(c, [W(x, gy - b, z), W(x, gy + b, z)], null, rgba(P.stoneShade, 0.8));
    for (let y = Math.ceil(gy - b); y < gy + b; y += 0.5) poly(c, [W(gx - a, y, z), W(gx + a, y, z)], null, rgba(P.stoneShade, 0.8));
  } else {
    for (let y = gy - b + 0.25; y < gy + b; y += 0.25) poly(c, [W(gx - a, y, z), W(gx + a, y, z)], null, rgba(P.wood, 0.9));
  }
  // A rug.
  const m = W(gx, gy, z);
  c.beginPath();
  c.ellipse(m.x, m.y, a * 18, b * 9, 0, 0, Math.PI * 2);
  c.fillStyle = rgba(mix(P.banner, P.c3, 0.3), 0.75);
  c.fill();
  c.strokeStyle = rgba(P.lamp, 0.7);
  c.lineWidth = 2;
  c.stroke();
}

// What is left of the front walls: a low course, so the room reads as a cutaway.
function frontStubs(c, P, r) {
  const { gx, gy, a, b, z } = r;
  box(c, P, gx, gy + b - 0.06, a, 0.06, z, 6, { left: P.stone, right: P.stoneShade, top: P.stoneLight });
  box(c, P, gx + a - 0.06, gy, 0.06, b, z, 6, { left: P.stone, right: P.stoneShade, top: P.stoneLight });
}

function shelf(c, P, gx, gy, z, books, color) {
  box(c, P, gx, gy, 0.42, 0.1, z, 34, { left: P.wood, right: P.woodShade, top: P.woodLight });
  // Rows of books on the visible face.
  for (let row = 0; row < 3; row++) {
    const y0 = z + 4 + row * 10;
    for (let k = 0; k < 8; k++) {
      if (row * 8 + k >= books) break;
      const u0 = -0.38 + k * 0.095;
      const p0 = W(gx + u0, gy + 0.1, y0);
      const p1 = W(gx + u0 + 0.08, gy + 0.1, y0);
      poly(c, [p0, p1, { x: p1.x, y: p1.y - 8 }, { x: p0.x, y: p0.y - 8 }], rgba(mix(ACCENTS(P)[(row + k) % 5], color, 0.3)), rgba(P.outline, 0.5));
    }
  }
}

function table(c, P, gx, gy, z, round = true, cloth = null) {
  const p = W(gx, gy, z);
  shadowAt(c, p.x + 3, p.y + 2, 16, 6);
  poly(c, [{ x: p.x - 1.5, y: p.y }, { x: p.x + 1.5, y: p.y }, { x: p.x + 1.5, y: p.y - 12 }, { x: p.x - 1.5, y: p.y - 12 }], rgba(P.timberDark));
  c.beginPath();
  c.ellipse(p.x, p.y - 12, round ? 14 : 18, round ? 7 : 8, 0, 0, Math.PI * 2);
  c.fillStyle = rgba(cloth || P.woodLight);
  c.fill();
  c.strokeStyle = rgba(P.outline, 0.7);
  c.lineWidth = 1.2;
  c.stroke();
  for (const [dx, dy] of [[-0.45, 0], [0.45, 0], [0, 0.45]]) {
    const q = W(gx + dx, gy + dy, z);
    c.beginPath();
    c.ellipse(q.x, q.y - 6, 5, 2.5, 0, 0, Math.PI * 2);
    c.fillStyle = rgba(P.wood);
    c.fill();
    c.stroke();
  }
}

function candle(c, P, x, y, lights) {
  poly(c, [{ x: x - 1.5, y }, { x: x + 1.5, y }, { x: x + 1.5, y: y - 6 }, { x: x - 1.5, y: y - 6 }], rgba([246, 240, 226]));
  c.beginPath();
  c.ellipse(x, y - 8.5, 1.6, 2.6, 0, 0, Math.PI * 2);
  c.fillStyle = rgba(P.lamp);
  c.fill();
  lights.push({ kind: 'lamp', x, y: y - 8, r: 28, tone: P.lamp });
}

const ROOMS = {
  library(c, r, { P, details, lights, labels }) {
    const { gx, gy, a, b, z } = r;
    const topics = details.topics?.length ? details.topics : [{ name: 'Your first topic', understood: 0 }];
    // A shelf per topic along the back walls; its books are the concepts understood.
    topics.slice(0, 6).forEach((t, i) => {
      const alongX = i < 3;
      const sx = alongX ? gx - a + 0.6 + i * ((2 * a - 1.2) / 2) : gx - a + 0.15;
      const sy = alongX ? gy - b + 0.15 : gy - b + 0.8 + (i - 3) * ((2 * b - 1.2) / 2);
      shelf(c, P, sx, sy, z, Math.max(2, t.understood * 2), ACCENTS(P)[i % 5]);
      labels.push({ ...W(sx, sy, z + 42), text: `${t.name} · ${t.understood}` });
    });
    table(c, P, gx + 0.2, gy + 0.3, z, false);
    const p = W(gx + 0.2, gy + 0.3, z + 12);
    poly(c, [{ x: p.x - 8, y: p.y - 2 }, { x: p.x + 2, y: p.y - 5 }, { x: p.x + 8, y: p.y - 2 }, { x: p.x - 2, y: p.y + 1 }], rgba([248, 244, 230]), rgba(P.outline, 0.5));
    candle(c, P, p.x + 10, p.y, lights);
  },

  cafe(c, r, { P, details, lights, labels }) {
    const { gx, gy, a, b, z } = r;
    // The bar along the back with barrels, a fireplace on the side, a table per deck.
    box(c, P, gx, gy - b + 0.35, a - 0.3, 0.18, z, 14, { left: P.wood, right: P.woodShade, top: P.woodLight });
    for (let k = 0; k < 3; k++) prop(c, P, 'barrel', gx - a + 0.4 + k * 0.4, gy - b + 0.2, z);
    box(c, P, gx - a + 0.2, gy + 0.2, 0.18, 0.45, z, 26, { left: P.stone, right: P.stoneShade, top: P.rockDark });
    const fire = W(gx - a + 0.4, gy + 0.2, z + 6);
    for (const [rr, col] of [[6, [255, 120, 40]], [3.5, [255, 210, 120]]]) {
      c.beginPath();
      c.ellipse(fire.x, fire.y, rr, rr * 0.7, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(col);
      c.fill();
    }
    lights.push({ kind: 'lamp', x: fire.x, y: fire.y, r: 46, tone: P.lamp });
    const decks = details.decks?.length ? details.decks : [{ name: 'No decks yet', mature: 0, total: 0 }];
    decks.slice(0, 4).forEach((d, i) => {
      const tx = gx - 0.5 + (i % 2) * 1.1;
      const ty = gy - 0.2 + Math.floor(i / 2) * 0.9;
      table(c, P, tx, ty, z, true, mix(ACCENTS(P)[i % 5], [255, 255, 255], 0.55));
      candle(c, P, W(tx, ty, z + 12).x, W(tx, ty, z + 12).y, lights);
      labels.push({ ...W(tx, ty, z + 30), text: d.total ? `${d.name} · ${d.mature}/${d.total}` : d.name });
    });
  },

  workshop(c, r, { P, details, lights, labels, emitters }) {
    const { gx, gy, a, b, z } = r;
    // The forge in the back corner, the anvil, a workbench with tools.
    box(c, P, gx - a + 0.5, gy - b + 0.5, 0.45, 0.45, z, 16, { left: P.stone, right: P.stoneShade, top: P.rockDark });
    const f = W(gx - a + 0.5, gy - b + 0.5, z + 16);
    emitters.push({ kind: 'forge', x: f.x, y: f.y });
    box(c, P, gx - a + 0.5, gy - b + 0.5, 0.25, 0.25, z + 16, 40, { left: P.stoneShade, right: P.rockDark });
    box(c, P, gx, gy + 0.2, 0.12, 0.08, z, 7, { left: P.rockDark, right: [60, 56, 54] });
    box(c, P, gx, gy + 0.2, 0.3, 0.13, z + 7, 4, { left: [96, 96, 104], right: [66, 66, 72], top: [150, 150, 158] });
    box(c, P, gx + 0.5, gy - b + 0.3, 0.7, 0.2, z, 12, { left: P.wood, right: P.woodShade, top: P.woodLight });
    for (let k = 0; k < 4; k++) {
      const p = W(gx + 0.0 + k * 0.3, gy - b + 0.12, z + 26);
      poly(c, [{ x: p.x, y: p.y }, { x: p.x + 1.5, y: p.y }, { x: p.x + 1.5, y: p.y + 12 }, { x: p.x, y: p.y + 12 }], rgba([110, 110, 118]));
    }
    const work = details.work || {};
    labels.push({ ...W(gx, gy + 0.2, z + 30), text: `Made together: ${work.today?.workshop || 0} today · ${work.total?.workshop || 0} in all` });
    candle(c, P, W(gx + 0.8, gy - b + 0.3, z + 12).x, W(gx + 0.8, gy - b + 0.3, z + 12).y, lights);
  },

  archive(c, r, { P, details, lights, labels }) {
    const { gx, gy, a, b, z } = r;
    // Cabinets of memories along the back; insights as scrolls on a lectern.
    const total = (details.memories || 0) + (details.records || 0);
    const cabinets = Math.max(1, Math.min(8, Math.ceil(total / 10)));
    for (let k = 0; k < cabinets; k++) {
      const alongX = k < 4;
      const cx = alongX ? gx - a + 0.45 + k * ((2 * a - 0.9) / 3) : gx - a + 0.2;
      const cy = alongX ? gy - b + 0.2 : gy - b + 0.8 + (k - 4) * 0.5;
      const f = box(c, P, cx, cy, 0.3, 0.14, z, 30, { left: P.wood, right: P.woodShade, top: P.woodLight });
      for (let d = 0; d < 4; d++) {
        poly(c, f.L.quad(0.1, 0.08 + d * 0.23, 0.9, 0.26 + d * 0.23), rgba(P.woodLight), rgba(P.outline, 0.5));
        const h = f.L(0.5, 0.17 + d * 0.23);
        c.fillStyle = rgba(P.lamp);
        c.fillRect(h.x - 1.5, h.y - 1, 3, 2);
      }
    }
    labels.push({ ...W(gx - a + 0.45, gy - b + 0.2, z + 40), text: `${details.memories || 0} memories · ${details.records || 0} stream records` });
    const l = W(gx + 0.3, gy + 0.3, z);
    poly(c, [{ x: l.x - 2, y: l.y }, { x: l.x + 2, y: l.y }, { x: l.x + 2, y: l.y - 16 }, { x: l.x - 2, y: l.y - 16 }], rgba(P.timberDark));
    poly(c, [{ x: l.x - 10, y: l.y - 16 }, { x: l.x + 10, y: l.y - 20 }, { x: l.x + 10, y: l.y - 24 }, { x: l.x - 10, y: l.y - 20 }], rgba(P.wood), rgba(P.outline, 0.6));
    for (let k = 0; k < Math.min(5, details.insights || 0); k++) {
      c.beginPath();
      c.ellipse(l.x - 6 + k * 3, l.y - 23 - k, 4, 1.6, -0.2, 0, Math.PI * 2);
      c.fillStyle = rgba([246, 236, 206]);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.5);
      c.stroke();
    }
    labels.push({ ...W(gx + 0.3, gy + 0.3, z + 36), text: `${details.insights || 0} insights` });
    candle(c, P, l.x + 12, l.y - 18, lights);
  },

  observatory(c, r, { P, details, lights, labels }) {
    const { gx, gy, a, b, z } = r;
    // The great telescope, and the chart of your skills on a table.
    const t = W(gx - 0.3, gy - 0.3, z);
    shadowAt(c, t.x + 6, t.y + 2, 16, 6);
    poly(c, [{ x: t.x - 6, y: t.y }, { x: t.x + 6, y: t.y }, { x: t.x + 2, y: t.y - 20 }, { x: t.x - 2, y: t.y - 20 }], rgba(P.timberDark));
    poly(c, [{ x: t.x - 4, y: t.y - 18 }, { x: t.x + 34, y: t.y - 52 }, { x: t.x + 40, y: t.y - 44 }, { x: t.x + 2, y: t.y - 12 }], rgba([150, 120, 80]), rgba(P.outline, 0.8));
    poly(c, [{ x: t.x + 32, y: t.y - 54 }, { x: t.x + 42, y: t.y - 52 }, { x: t.x + 40, y: t.y - 42 }, { x: t.x + 30, y: t.y - 44 }], rgba(P.lamp, 0.8));
    table(c, P, gx + 0.5, gy + 0.4, z, false, [38, 46, 80]);
    const chart = W(gx + 0.5, gy + 0.4, z + 12);
    const skills = (details.skills || []).slice(0, 6);
    skills.forEach((s, i) => {
      c.beginPath();
      c.arc(chart.x - 10 + (i % 3) * 10, chart.y - 3 + Math.floor(i / 3) * 4, s.state === 'mastered' ? 2.2 : 1.3, 0, Math.PI * 2);
      c.fillStyle = rgba(s.state === 'mastered' ? P.lamp : [220, 230, 255]);
      c.fill();
    });
    skills.slice(0, 4).forEach((s, i) => labels.push({ ...W(gx - a + 0.6 + i * 0.6, gy - b + 0.3, z + 40 + (i % 2) * 14), text: `${s.state === 'mastered' ? '✦' : '✧'} ${s.name} ${Math.round(s.progress * 100)}%` }));
    candle(c, P, chart.x + 14, chart.y, lights);
  },

  hearth(c, r, { P, details, lights, labels }) {
    const { gx, gy, a, b, z } = r;
    // A bed for each resident, the fireplace, the long table.
    const names = details.residents?.length ? details.residents : ['A resident'];
    names.slice(0, 6).forEach((n, i) => {
      const bx = gx - a + 0.5 + (i % 3) * 0.9;
      const by = gy - b + 0.45 + Math.floor(i / 3) * 1.1;
      const f = box(c, P, bx, by, 0.3, 0.42, z, 7, { left: P.wood, right: P.woodShade, top: mix(ACCENTS(P)[i % 5], [255, 255, 255], 0.35) });
      box(c, P, bx, by - 0.28, 0.24, 0.1, z + 7, 3, { left: [246, 240, 230], right: [220, 214, 204], top: [252, 250, 246] });
      labels.push({ ...W(bx, by, z + 20), text: n });
      void f;
    });
    box(c, P, gx + a - 0.25, gy - b + 0.6, 0.18, 0.45, z, 28, { left: P.stone, right: P.stoneShade, top: P.rockDark });
    const fire = W(gx + a - 0.45, gy - b + 0.6, z + 5);
    for (const [rr, col] of [[6, [255, 120, 40]], [3.5, [255, 210, 120]]]) {
      c.beginPath();
      c.ellipse(fire.x, fire.y, rr, rr * 0.7, 0, 0, Math.PI * 2);
      c.fillStyle = rgba(col);
      c.fill();
    }
    lights.push({ kind: 'lamp', x: fire.x, y: fire.y, r: 50, tone: P.lamp });
    table(c, P, gx + 0.4, gy + b - 0.6, z, false);
    candle(c, P, W(gx + 0.4, gy + b - 0.6, z + 12).x, W(gx + 0.4, gy + b - 0.6, z + 12).y, lights);
  },
};

// Name tags for open-air places.
function openLabels(id, s, z, ctx) {
  const { gx, gy, a, b } = s;
  const d = ctx.details || {};
  if (id === 'grounds') {
    const habits = d.habits || [];
    habits.slice(0, 8).forEach((h, i, all) => {
      const t = (i + 0.5) / all.length;
      ctx.labels.push({ ...W(gx - a + 0.4 + t * (2 * a - 0.8), gy - b + 0.4, z + 62 + (i % 2) * 14), text: `${h.name}${h.streak ? ` · ${h.streak}${h.unit}` : ''}${h.done ? ' ✓' : ''}` });
    });
  } else if (id === 'garden') {
    const habits = d.habits || [];
    const beds = Math.max(4, Math.min(8, habits.length || 4));
    habits.slice(0, beds).forEach((h, i) => {
      const ang = (i / beds) * Math.PI * 2 + 0.4;
      ctx.labels.push({ ...W(gx + Math.cos(ang) * 2.3, gy + Math.sin(ang) * 2.3, z + 18), text: `${h.done ? '🌸' : '🌱'} ${h.name}` });
    });
  } else if (id === 'lookout') {
    const w = d.work || {};
    ctx.labels.push({ ...W(gx, gy, z + 120), text: `Scouted: ${w.today?.lookout || 0} today · ${w.total?.lookout || 0} in all` });
  } else if (id === 'stage') {
    ctx.labels.push({ ...W(gx, gy, z + 70), text: d.lastRehearsal ? `Last: ${d.lastRehearsal}` : 'No rehearsals yet' });
  }
}
