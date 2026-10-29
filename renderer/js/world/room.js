// Inside a building, seen from above: a flat, outlined "crew quarters" room (the Among Us look) with
// the place's furniture made of your data (a shelf per learning topic, a table per vocabulary deck, a
// cabinet per batch of memories, a bed per resident, your recent documents as paper stacks…) and the
// residents as little bean-shaped figures who walk between the stations and do things: the active
// persona at the station of the tool it is using right now, everyone else following their day plan.
// Pure: layout from data, a small simulation of the walkers, drawing on a 2D context, picking. The
// desktop (innerworld.js) and the phone (remote/screens.js) both use it. Theme-tinted through the
// world palette P (art.js); everything else is fixed story colour, like the island.

export const RW = 1000; // the room's own units; drawn to fit the canvas
export const RH = 640;
const WALL_TOP = 76; // the back wall's face, seen from above-front
const WALL = 20; // the thin side and front walls
const DOOR = 110;

const rgba = (c, a = 1) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
// A well-scattered 32-bit hash of a string (a plain polynomial hash of "star1", "star2"… differs by one
// between neighbours, which lined the stars up in rows).
const hash = (s) => {
  let h = [...String(s)].reduce((a, ch) => (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0, 7);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};
const short = (s, n = 14) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

// ------------------------------------------------------------------ layout
// A station: something in the room with a place to stand at (slot) and what it says of you (info).
const st = (kind, x, y, w, h, extra = {}) => ({ kind, x, y, w, h, label: '', info: '', slot: { x: x + w / 2, y: y + h + 18 }, verbs: [], ...extra });

/** The furniture of a place from the data: { floor, open, stations, title }. */
export function layout(place, level, data = {}) {
  const d = data.details || {};
  const L = LAYOUTS[place] || LAYOUTS.hearth;
  const out = L(d, data, level || 1);
  for (const s of out.stations) {
    s.x = clamp(s.x, WALL + 6, RW - WALL - 6 - s.w);
    s.y = clamp(s.y, WALL_TOP + 4, RH - WALL - 6 - s.h);
    s.slot.x = clamp(s.slot.x, WALL + 20, RW - WALL - 20);
    s.slot.y = clamp(s.slot.y, WALL_TOP + 26, RH - WALL - 26);
  }
  return out;
}

// Shelves, tables… laid in rows across the room.
function row(items, y, w, h, gap, make) {
  const n = items.length;
  const total = n * w + (n - 1) * gap;
  const x0 = (RW - total) / 2;
  return items.map((it, i) => make(it, x0 + i * (w + gap), y, i));
}
function grid(items, cols, y0, w, h, gapX, gapY, make) {
  const rows = [];
  for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols));
  return rows.flatMap((r, ri) => row(r, y0 + ri * (h + gapY), w, h, gapX, (it, x, y, ci) => make(it, x, y, ri * cols + ci)));
}

const LAYOUTS = {
  library(d) {
    const topics = (d.topics || []).slice(0, 12);
    const items = topics.length ? topics : [{ name: 'Empty shelf', understood: 0, shaky: 0, empty: true }, { name: 'Empty shelf', understood: 0, shaky: 0, empty: true }, { name: 'Empty shelf', understood: 0, shaky: 0, empty: true }];
    const shelves = grid(items, 6, WALL_TOP + 8, 118, 64, 16, 150, (t, x, y, i) => st('shelf', x, y, 118, 64, { label: short(t.name, 16), info: t.empty ? 'Nothing tracked yet: learn something and a shelf fills.' : `${t.name}: ${t.understood} understood, ${t.shaky} shaky`, fill: t.empty ? 0 : t.understood / Math.max(1, t.understood + t.shaky), books: t.empty ? 0 : Math.min(9, 2 + t.understood), seed: i + 1, verbs: [/read|stud|learn|understand|library|book|shelf/i] }));
    const table = st('table', RW / 2 - 110, RH - 220, 220, 90, { label: 'Reading table', info: 'Where she reads, researches and takes notes.', verbs: [/research|read|stud|learn|note|library|book/i] });
    return { floor: 'planks', open: false, stations: [...shelves, table, st('lamp', WALL + 40, RH - 150, 30, 30, { info: 'A reading lamp.' }), st('plant', RW - WALL - 70, RH - 150, 40, 56, { info: 'A fern that likes the quiet.' }), st('rug', RW / 2 - 160, RH - 110, 320, 60, { info: 'A worn rug.', noslot: true })] };
  },
  cafe(d) {
    const decks = (d.decks || []).slice(0, 8);
    const items = decks.length ? decks : [{ name: 'A free table', mature: 0, total: 0, due: 0, empty: true }, { name: 'A free table', mature: 0, total: 0, due: 0, empty: true }];
    const tables = grid(items, 4, WALL_TOP + 110, 150, 96, 48, 130, (k, x, y, i) => st('roundtable', x, y, 150, 96, { label: short(k.name, 14), info: k.empty ? 'A table waiting for your first vocabulary deck.' : `${k.name}: ${k.total} cards, ${k.mature} mature, ${k.due} due today`, cups: k.empty ? 0 : Math.min(6, 1 + k.due), seed: i + 2, verbs: [/practi|vocab|word|language|caf|coffee|speak|talk/i] }));
    return { floor: 'checker', open: false, stations: [st('counter', RW / 2 - 170, WALL_TOP + 6, 340, 62, { label: 'Counter', info: 'Strong coffee, many languages.', verbs: [/coffee|order|serve|drink/i], slot: { x: RW / 2, y: WALL_TOP + 100 } }), ...tables, st('plant', WALL + 30, RH - 130, 40, 56, { info: 'A potted olive.' }), st('board', RW - WALL - 200, WALL_TOP + 8, 180, 60, { label: 'Specials', info: decks.length ? `Decks: ${decks.map((k) => k.name).join(', ')}` : 'No decks yet.', lines: decks.slice(0, 3).map((k) => `${short(k.name, 10)} · ${k.due} due`) })] };
  },
  workshop(d, data) {
    const docs = (data.docs || []).slice(0, 6);
    const work = d.work?.today || {};
    const papers = docs.length ? docs.map((doc, i) => st('papers', RW / 2 - 150 + (i % 3) * 100, RH - 250 + Math.floor(i / 3) * 60, 72, 44, { label: short(doc.name, 12), info: `${doc.name} (${doc.kind || 'document'})`, doc, seed: i + 3, verbs: [/document|write|draft|pdf|read|note/i] })) : [];
    const lines = Object.entries(work).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([p, n]) => `${p}: ${n}×`);
    return { floor: 'stone', open: false, stations: [
      st('forge', WALL + 30, WALL_TOP + 6, 170, 110, { label: 'Forge', info: 'Code is forged here.', verbs: [/forge|build|code|compil|test|fix|debug|self|change|git|craft|making/i], slot: { x: WALL + 215, y: WALL_TOP + 90 } }),
      st('anvil', WALL + 230, WALL_TOP + 60, 70, 44, { info: 'The anvil.' }),
      st('bench', RW - WALL - 330, WALL_TOP + 6, 300, 84, { label: 'Workbench', info: 'Tools for everything that is not code.', verbs: [/plan|diagram|chart|tool|make|craft|work/i] }),
      st('drafting', RW / 2 - 180, RH - 300, 360, 150, { label: 'Drafting table', info: docs.length ? `Your recent documents: ${docs.map((x) => x.name).join(', ')}` : 'Your recent documents would lie here.', verbs: [/document|write|draft|pdf|read|note/i], noslot: Boolean(docs.length) }),
      ...papers,
      st('board', WALL + 30, RH - 200, 180, 90, { label: 'Today', info: lines.length ? `Pieces of work today: ${lines.join(', ')}` : 'Nothing made yet today.', lines: lines.length ? lines : ['nothing yet'] }),
      st('crate', RW - WALL - 120, RH - 150, 70, 56, { info: 'Spare parts.', seed: 4 }),
      st('crate', RW - WALL - 200, RH - 110, 60, 48, { info: 'More spare parts.', seed: 5 }),
    ] };
  },
  archive(d, data) {
    const n = clamp(Math.ceil((d.memories || 0) / 25), 2, 8);
    const cabinets = row(Array.from({ length: n }, (_, i) => i), WALL_TOP + 6, 84, 110, 18, (i, x, y) => st('cabinet', x, y, 84, 110, { label: `${i * 25 + 1}–${(i + 1) * 25}`, info: `Memories ${i * 25 + 1} to ${(i + 1) * 25}${i === n - 1 ? ` (${d.memories || 0} kept in all)` : ''}`, drawers: 4, full: clamp(((d.memories || 0) - i * 25) / 25, 0, 1), seed: i + 6, verbs: [/memor|remember|file|note|archive|vault|journal|stream/i] }));
    const docs = (data.docs || []).slice(0, 4);
    const holes = st('pigeonholes', RW - WALL - 250, RH - 290, 230, 120, { label: 'Pigeonholes', info: docs.length ? `Recently opened: ${docs.map((x) => x.name).join(', ')}` : 'Recently opened documents land here.', papers: docs.map((x) => short(x.name, 10)), verbs: [/document|read|open/i] });
    return { floor: 'stone', open: false, stations: [...cabinets, st('desk', RW / 2 - 130, RH - 230, 200, 86, { label: 'Filing desk', info: 'Where every memory is filed and cross-referenced.', verbs: [/memor|remember|file|note|archive|vault|journal|stream|write/i] }), holes, st('lamp', RW / 2 + 90, RH - 240, 30, 30, { info: 'The clerk’s lamp.' }), st('plant', WALL + 30, RH - 140, 40, 56, { info: 'A fern.' })] };
  },
  hearth(d, data) {
    const names = (data.residents || []).map((r) => (typeof r === 'string' ? r : r.name)).slice(0, 8);
    const beds = (names.length ? names : ['Siren']).map((name, i) => st('bed', i < 4 ? WALL + 30 + i * 108 : RW - WALL - 118 - (i - 4) * 108, i < 4 ? WALL_TOP + 8 : WALL_TOP + 8, 96, 128, { label: short(name, 10), info: `${name}’s bed.`, who: name, seed: i + 7, verbs: [/sleep|rest|asleep|nap|bed/i], slot: { x: (i < 4 ? WALL + 30 + i * 108 : RW - WALL - 118 - (i - 4) * 108) + 48, y: WALL_TOP + 160 } }));
    return { floor: 'planks', open: false, stations: [
      st('fireplace', RW / 2 - 80, WALL_TOP + 2, 160, 70, { label: 'Hearth', info: 'The fire that gives the house its name.', verbs: [/fire|warm|evening|talk|chat|tidy|cook|eat|dinner|supper|breakfast/i], slot: { x: RW / 2, y: WALL_TOP + 110 } }),
      ...beds,
      st('longtable', RW / 2 - 200, RH - 250, 400, 100, { label: 'Table', info: 'Where the residents eat and talk late into the evening.', verbs: [/eat|dinner|supper|breakfast|talk|chat|meal|cook|tea/i] }),
      st('rug', RW / 2 - 140, RH - 120, 280, 60, { info: 'A rug by the door.', noslot: true }),
    ] };
  },
  observatory(d) {
    const skills = d.skills || [];
    const areas = [...new Set(skills.map((s) => s.area || 'Other'))].slice(0, 5);
    const charts = row(areas.length ? areas : ['The sky'], WALL_TOP + 6, 150, 96, 24, (area, x, y, i) => {
      const list = skills.filter((s) => (s.area || 'Other') === area);
      return st('chart', x, y, 150, 96, { label: short(area, 14), info: list.length ? `${area}: ${list.filter((s) => s.state === 'mastered').length} of ${list.length} mastered` : 'No skills charted yet.', stars: list.slice(0, 12).map((s) => ({ lit: s.state === 'mastered', warm: s.state === 'growing' || s.state === 'unlocked', seed: hash(s.name) })), seed: i + 8, verbs: [/chart|skill|star|plan|calendar|schedule|routine|next/i] });
    });
    return { floor: 'stone', open: false, stations: [...charts, st('telescope', RW / 2 - 90, RH / 2 - 60, 180, 150, { label: 'Telescope', info: 'Pointed at your skill constellations.', verbs: [/chart|skill|star|look|observ|plan|calendar|schedule|routine|next/i] }), st('desk', WALL + 40, RH - 200, 180, 80, { label: 'Almanac', info: 'The calendar and the routines, written up.', verbs: [/calendar|schedule|routine|plan|write/i] }), st('globe', RW - WALL - 110, RH - 190, 70, 90, { info: 'A globe of the known world.' })] };
  },
  stage(d, data) {
    const rehearsals = (data.rehearsals || []).slice(0, 3);
    const chairs = grid(Array.from({ length: 12 }, (_, i) => i), 6, RH - 230, 56, 44, 40, 60, (i, x, y) => st('chair', x, y, 56, 44, { info: 'A seat.', seed: i + 9, verbs: [/watch|listen|audience|sit/i] }));
    return { floor: 'planks', open: false, stations: [
      st('stage', RW / 2 - 300, WALL_TOP + 4, 600, 150, { label: 'Stage', info: rehearsals.length ? `Rehearsed here: ${rehearsals.map((r) => r.title || r.topic || 'a conversation').join('; ')}` : 'Where rehearsals are played out before the real thing.', verbs: [/rehears|perform|play|act|speak|practice|present/i], slot: { x: RW / 2, y: WALL_TOP + 110 } }),
      ...rehearsals.map((r, i) => st('poster', WALL + 8, WALL_TOP + 10 + i * 96, 70, 84, { label: short(r.title || r.topic || 'Rehearsal', 10), info: r.title || r.topic || 'A rehearsal', seed: i + 10 })),
      ...chairs,
    ] };
  },
  lookout(d) {
    const trips = d.work?.total?.lookout || 0;
    return { floor: 'stone', open: true, stations: [
      st('maptable', RW / 2 - 160, RH / 2 - 70, 320, 140, { label: 'Map table', info: `The wider world, pinned: ${trips} trips out so far.`, pins: clamp(Math.round(trips / 10), 1, 14), verbs: [/web|search|scout|look|fetch|browse|raven|service|connect|map|news/i] }),
      st('perch', RW - WALL - 150, WALL_TOP + 30, 90, 110, { label: 'Ravens', info: 'The ravens that carry messages out to connected services.', verbs: [/raven|service|connect|send|message/i] }),
      st('brazier', WALL + 60, WALL_TOP + 40, 70, 90, { info: 'A signal fire.', seed: 11 }),
      st('spyglass', WALL + 80, RH - 200, 120, 60, { label: 'Spyglass', info: 'For a closer look at the web.', verbs: [/web|search|look|browse|read|page/i] }),
    ] };
  },
  garden(d) {
    const habits = (d.habits || []).slice(0, 10);
    const beds = habits.length ? grid(habits, 5, WALL_TOP + 30, 120, 70, 40, 230, (h, x, y, i) => st('flowerbed', x, y, 120, 70, { label: short(h.name, 12), info: `${h.name}: ${h.done ? 'kept today' : 'not yet today'}${h.streak ? ` · streak ${h.streak}${h.unit}` : ''}`, bloom: h.done, seed: i + 12, verbs: [/habit|garden|water|flower|walk|stroll|think|rest/i] })) : [st('flowerbed', RW / 2 - 60, WALL_TOP + 30, 120, 70, { label: 'Bare bed', info: 'A flower blooms here for every habit you keep today.', bloom: false, seed: 12 })];
    return { floor: 'grass', open: true, stations: [...beds, st('fountain', RW / 2 - 70, RH / 2 - 40, 140, 110, { label: 'Fountain', info: 'The village fountain.', verbs: [/think|stroll|walk|rest|wonder|wander|muse|sit/i] }), st('seat', WALL + 60, RH - 150, 110, 48, { info: 'A bench in the sun.', verbs: [/sit|rest|read|think|stroll/i] }), st('seat', RW - WALL - 170, RH - 150, 110, 48, { info: 'A bench in the shade.', verbs: [/sit|rest|read|think|stroll/i] })] };
  },
  grounds(d) {
    const habits = (d.habits || []).slice(0, 10);
    const banners = habits.length ? row(habits, WALL_TOP + 6, 70, 120, 24, (h, x, y, i) => st('banner', x, y, 70, 120, { label: short(h.name, 10), info: `${h.name}: ${h.done ? 'raised today' : 'lowered until you keep it today'}`, up: h.done, seed: i + 13, verbs: [/habit|train|run|exercis|practi|work ?out|stretch|sport/i] })) : [st('banner', RW / 2 - 35, WALL_TOP + 6, 70, 120, { label: 'No banners', info: 'A banner is raised here for every habit you keep.', up: false, seed: 13 })];
    return { floor: 'grass', open: true, stations: [...banners, st('track', WALL + 60, RH - 240, RW - 2 * WALL - 120, 150, { label: 'Track', info: 'Laps for the body, rhythm for the mind.', verbs: [/run|train|exercis|lap|jog|sprint|work ?out/i], noslot: true }), st('dummy', RW - WALL - 110, WALL_TOP + 150, 60, 90, { info: 'A training dummy.', verbs: [/train|fight|practi|spar/i] })] };
  },
};

// ------------------------------------------------------------------ the walkers
const SPEED = 120; // room units per second
const DO_MIN = 4;
const DO_MAX = 9;

/**
 * A small simulation: one state per person (by name), kept between frames by the host. `update`
 * takes who is in the room now (name, color, active, activity, working, thinking, asleep, kind) and
 * returns the actors to draw, with positions, facing, a walk phase and what they are doing.
 */
export function createSim() {
  const people = new Map();
  let rnd = 1;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pickStation = (stations, p, exclude) => {
    const wants = stations.filter((s) => !s.noslot && s.verbs.some((re) => re.test(p.activity || '')));
    const pool = (wants.length ? wants : stations.filter((s) => !s.noslot)).filter((s) => s !== exclude);
    if (!pool.length) return null;
    return pool[Math.floor(rand() * pool.length)];
  };
  return {
    people,
    update(present, stations, dt, t) {
      const seen = new Set();
      for (const p of present) {
        seen.add(p.name);
        let a = people.get(p.name);
        if (!a) {
          rnd = hash(p.name);
          // In through the door, each a little apart, so a group doesn't start as one pile.
          const door = { x: RW / 2 + (rand() - 0.5) * 60 + (people.size % 5) * 46 - 92, y: RH - WALL - 40 - (people.size % 3) * 22 };
          a = { name: p.name, x: door.x, y: door.y, face: 1, phase: 0, at: null, target: null, until: 0, mode: 'walk', bubble: '', bubbleUntil: 0, progress: 0 };
          people.set(p.name, a);
        }
        Object.assign(a, { color: p.color, active: p.active, kind: p.kind, activity: p.activity || '', working: Boolean(p.working), thinking: Boolean(p.thinking), asleep: Boolean(p.asleep) });
        // Asleep: to a bed (the hearth) or the nearest place to lie down.
        if (a.asleep) {
          const bed = stations.find((s) => s.kind === 'bed' && s.who === p.name) || stations.find((s) => s.kind === 'bed') || null;
          const spot = bed ? { x: bed.x + bed.w / 2, y: bed.y + bed.h * 0.55 } : { x: RW / 2, y: RH / 2 };
          a.target = spot;
          a.at = bed;
          a.mode = Math.hypot(spot.x - a.x, spot.y - a.y) < 4 ? 'sleep' : 'walk';
        } else if (a.working) {
          // Live work: straight to the tool's station and stay, with a progress bar that keeps cycling.
          const want = pickStation(stations, p, null);
          if (want && a.at !== want && !(a.target && a.mode === 'walk' && a.wantAt === want)) {
            a.target = { ...want.slot };
            a.wantAt = want;
            a.mode = 'walk';
          }
          if (a.mode === 'do') a.progress = (a.progress + dt / 3.2) % 1;
          a.bubble = p.activity || '';
          a.bubbleUntil = t + 1;
        } else if (a.mode === 'do' && t >= a.until) {
          const next = pickStation(stations, p, a.at);
          if (next) {
            a.target = { ...next.slot };
            a.wantAt = next;
            a.mode = 'walk';
          } else a.until = t + 3;
        } else if (a.mode === 'walk' && !a.target) {
          const next = pickStation(stations, p, null);
          if (next) ((a.target = { ...next.slot }), (a.wantAt = next));
          else a.mode = 'do';
        } else if (a.mode === 'sleep' && !a.asleep) a.mode = 'walk';
        if (a.mode === 'walk' && a.target) {
          const dx = a.target.x - a.x;
          const dy = a.target.y - a.y;
          const dist = Math.hypot(dx, dy);
          const step = SPEED * dt;
          if (dist <= step) {
            a.x = a.target.x;
            a.y = a.target.y;
            a.at = a.wantAt || a.at;
            a.target = null;
            a.mode = a.asleep ? 'sleep' : 'do';
            a.until = t + DO_MIN + rand() * (DO_MAX - DO_MIN);
            a.progress = 0;
            if (!a.working && a.activity && rand() < 0.7) ((a.bubble = a.activity), (a.bubbleUntil = t + 3.5));
          } else {
            a.x += (dx / dist) * step;
            a.y += (dy / dist) * step;
            a.face = dx < -1 ? -1 : dx > 1 ? 1 : a.face;
            a.phase += dt * 11;
          }
        }
        if (a.thinking && a.mode !== 'walk') ((a.bubble = '…'), (a.bubbleUntil = t + 1));
      }
      for (const name of [...people.keys()]) if (!seen.has(name)) people.delete(name);
      return [...people.values()].sort((a, b) => a.y - b.y);
    },
  };
}

// ------------------------------------------------------------------ drawing
/** The transform that fits the room into w×h: { k, ox, oy }. */
export function transform(w, h) {
  const k = Math.min(w / RW, h / RH);
  return { k, ox: (w - RW * k) / 2, oy: (h - RH * k) / 2 };
}

/** What is under the point (canvas coordinates): { type: 'actor' | 'station', ... } or null. */
export function pick(w, h, stations, actors, px, py) {
  const { k, ox, oy } = transform(w, h);
  const x = (px - ox) / k;
  const y = (py - oy) / k;
  for (const a of [...actors].reverse()) if (Math.abs(x - a.x) < 18 && y < a.y + 6 && y > a.y - 48) return { type: 'actor', actor: a };
  for (const s of [...stations].reverse()) if (x >= s.x && x <= s.x + s.w && y >= s.y - 10 && y <= s.y + s.h) return { type: 'station', station: s };
  return null;
}

/**
 * Draws the room. f = { w, h, P, t, place, level, name, stations, actors, floor, open, night, anim, lite, hover }.
 */
export function draw(c, f) {
  const { w, h, P } = f;
  const { k, ox, oy } = transform(w, h);
  c.save();
  c.fillStyle = rgba(P.bg || [10, 12, 18]);
  c.fillRect(0, 0, w, h);
  c.translate(ox, oy);
  c.scale(k, k);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  floor(c, f);
  walls(c, f);
  // Stations and actors in depth order (by their bottom edge), so a figure stands in front of a table.
  const items = [...f.stations.map((s) => ({ y: s.y + s.h, s })), ...f.actors.map((a) => ({ y: a.y + 2, a }))].sort((p, q) => p.y - q.y);
  for (const it of items) it.s ? station(c, f, it.s) : actor(c, f, it.a);
  frontWall(c, f);
  for (const a of f.actors) bubble(c, f, a);
  if (f.hover?.type === 'station') highlight(c, f, f.hover.station);
  c.restore();
}

function floor(c, f) {
  const P = f.P;
  const x0 = WALL;
  const y0 = WALL_TOP;
  const x1 = RW - WALL;
  const y1 = RH - WALL;
  const fl = f.floor;
  const base = fl === 'grass' ? P.grass : fl === 'stone' ? P.stone : fl === 'checker' ? P.plaster : P.wood;
  c.fillStyle = rgba(base);
  c.fillRect(x0, y0, x1 - x0, y1 - y0);
  c.save();
  c.beginPath();
  c.rect(x0, y0, x1 - x0, y1 - y0);
  c.clip();
  if (fl === 'planks') {
    c.strokeStyle = rgba(P.woodShade, 0.5);
    c.lineWidth = 2;
    for (let y = y0; y < y1; y += 34) {
      c.beginPath();
      c.moveTo(x0, y);
      c.lineTo(x1, y);
      c.stroke();
      for (let x = x0 + ((y / 34) % 2) * 120; x < x1; x += 240) {
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x, y + 34);
        c.stroke();
      }
    }
  } else if (fl === 'stone') {
    c.strokeStyle = rgba(P.stoneShade, 0.7);
    c.lineWidth = 2;
    for (let y = y0; y < y1; y += 60) {
      for (let x = x0 - 40 + ((y / 60) % 2) * 45; x < x1; x += 90) {
        c.strokeRect(x + 3, y + 3, 84, 54);
      }
    }
  } else if (fl === 'checker') {
    c.fillStyle = rgba(P.plasterShade, 0.55);
    for (let y = y0; y < y1; y += 40) for (let x = x0 + ((y / 40) % 2) * 40; x < x1; x += 80) c.fillRect(x, y, 40, 40);
  } else if (fl === 'grass') {
    c.fillStyle = rgba(P.grassDark, 0.5);
    for (let i = 0; i < 70; i++) {
      const s = hash(`g${i}`);
      const x = x0 + (s % 1000) * ((x1 - x0) / 1000);
      const y = y0 + ((s >>> 10) % 1000) * ((y1 - y0) / 1000);
      c.beginPath();
      c.ellipse(x, y, 14 + (s % 9), 6 + (s % 5), 0, 0, Math.PI * 2);
      c.fill();
    }
    // A path to the door.
    c.fillStyle = rgba(P.dirt, 0.8);
    c.beginPath();
    c.moveTo(RW / 2 - 40, y1);
    c.quadraticCurveTo(RW / 2 - 30, RH / 2 + 60, RW / 2 - 20, RH / 2 + 50);
    c.lineTo(RW / 2 + 20, RH / 2 + 50);
    c.quadraticCurveTo(RW / 2 + 30, RH / 2 + 60, RW / 2 + 40, y1);
    c.closePath();
    c.fill();
  }
  // Light from the windows (day) or the lamps (night) across the floor.
  const g = c.createRadialGradient(RW / 2, y0 + 40, 20, RW / 2, y0 + 40, RH);
  g.addColorStop(0, rgba(f.night ? P.lamp : [255, 255, 240], f.night ? 0.12 : 0.14));
  g.addColorStop(1, rgba([0, 0, 10], f.night ? 0.42 : 0.1));
  c.fillStyle = g;
  c.fillRect(x0, y0, x1 - x0, y1 - y0);
  c.restore();
}

function walls(c, f) {
  const P = f.P;
  if (f.open) {
    // Open air: a low parapet or hedge instead of a back wall.
    c.fillStyle = rgba(f.floor === 'grass' ? P.leafDark : P.stoneShade);
    c.fillRect(0, WALL_TOP - 30, RW, 30);
    c.fillStyle = rgba(f.floor === 'grass' ? P.leaf : P.stone);
    c.fillRect(0, WALL_TOP - 36, RW, 10);
    c.fillStyle = rgba(f.night ? [18, 22, 48] : [150, 200, 236]);
    c.fillRect(0, 0, RW, WALL_TOP - 36);
    if (f.night) stars(c, 0, 0, RW, WALL_TOP - 36, 40, f);
    else clouds(c, f);
  } else {
    c.fillStyle = rgba(f.floor === 'stone' ? P.stoneShade : P.plasterShade);
    c.fillRect(0, 0, RW, WALL_TOP);
    c.fillStyle = rgba(f.floor === 'stone' ? P.stone : P.plaster);
    c.fillRect(0, 0, RW, WALL_TOP - 14);
    // Windows along the back wall.
    for (const x of [RW * 0.18, RW * 0.5, RW * 0.82]) window(c, f, x - 44, 12, 88, 46);
  }
  c.fillStyle = rgba(f.open ? (f.floor === 'grass' ? P.leafDark : P.stoneShade) : P.timberDark);
  c.fillRect(0, WALL_TOP - 6, RW, 6);
  // Side walls.
  c.fillStyle = rgba(f.open ? (f.floor === 'grass' ? P.leaf : P.stone) : P.timber);
  c.fillRect(0, WALL_TOP, WALL, RH - WALL_TOP);
  c.fillRect(RW - WALL, WALL_TOP, WALL, RH - WALL_TOP);
  c.strokeStyle = rgba(P.outline);
  c.lineWidth = 3;
  c.strokeRect(WALL, WALL_TOP, RW - 2 * WALL, RH - WALL_TOP - WALL);
}

function frontWall(c, f) {
  const P = f.P;
  c.fillStyle = rgba(f.open ? (f.floor === 'grass' ? P.leaf : P.stone) : P.timber);
  c.fillRect(0, RH - WALL, RW / 2 - DOOR / 2, WALL);
  c.fillRect(RW / 2 + DOOR / 2, RH - WALL, RW / 2 - DOOR / 2, WALL);
  // The doorway: a mat and the frame.
  c.fillStyle = rgba(P.woodShade);
  c.fillRect(RW / 2 - DOOR / 2, RH - WALL, DOOR, WALL);
  c.strokeStyle = rgba(P.outline);
  c.lineWidth = 3;
  c.strokeRect(RW / 2 - DOOR / 2, RH - WALL - 1, DOOR, WALL + 1);
}

function window(c, f, x, y, w, h) {
  const P = f.P;
  c.fillStyle = rgba(P.timberDark);
  c.fillRect(x - 4, y - 4, w + 8, h + 8);
  c.fillStyle = rgba(f.night ? [16, 20, 46] : [150, 200, 236]);
  c.fillRect(x, y, w, h);
  if (f.night) stars(c, x, y, w, h, 6, f);
  else {
    c.fillStyle = rgba([255, 255, 255], 0.5);
    c.beginPath();
    c.ellipse(x + w * 0.3, y + h * 0.45, 16, 7, 0, 0, Math.PI * 2);
    c.fill();
  }
  c.strokeStyle = rgba(P.timberDark);
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(x + w / 2, y);
  c.lineTo(x + w / 2, y + h);
  c.stroke();
}

// A night sky: stars of a few sizes (twinkling a little), and a moon in a wide band.
function stars(c, x, y, w, h, n, f) {
  for (let i = 0; i < n; i++) {
    const s = hash(`s${x}${w}${i}`);
    const r = 1 + (s % 3) * 0.7;
    const tw = f?.anim ? 0.7 + 0.3 * Math.sin(f.t * 1.5 + i) : 0.85;
    c.fillStyle = rgba([255, 250, 220], tw);
    c.beginPath();
    c.arc(x + 6 + (s % 997) * ((w - 12) / 997), y + 4 + ((s >>> 9) % 991) * ((h - 8) / 991), r, 0, Math.PI * 2);
    c.fill();
  }
  if (w > 400) {
    c.fillStyle = rgba([250, 240, 200], 0.95);
    c.beginPath();
    c.arc(x + w * 0.78, y + h * 0.5, 14, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = rgba([18, 22, 48]);
    c.beginPath();
    c.arc(x + w * 0.78 + 7, y + h * 0.5 - 4, 12, 0, Math.PI * 2);
    c.fill();
  }
}

function clouds(c, f) {
  c.fillStyle = rgba([255, 255, 255], 0.8);
  const drift = f.anim ? (f.t * 6) % (RW + 200) : 0;
  for (const [x, y, r] of [[120, 18, 14], [460, 24, 18], [800, 14, 12]]) {
    const cx = ((x + drift) % (RW + 200)) - 100;
    for (const [dx, dy, rr] of [[0, 0, r], [r, 4, r * 0.8], [-r, 5, r * 0.7]]) {
      c.beginPath();
      c.ellipse(cx + dx, y + dy, rr * 1.6, rr, 0, 0, Math.PI * 2);
      c.fill();
    }
  }
}

// A box seen slightly from the front: top face lighter, a front face, an outline, a soft shadow.
function block(c, P, x, y, w, h, top, front, { r = 6, depth = 12 } = {}) {
  c.fillStyle = rgba([0, 0, 0], 0.18);
  c.beginPath();
  c.ellipse(x + w / 2, y + h + 4, w * 0.55, 8, 0, 0, Math.PI * 2);
  c.fill();
  rr(c, x, y + h - depth, w, depth, r);
  c.fillStyle = rgba(front);
  c.fill();
  rr(c, x, y, w, h - depth, r);
  c.fillStyle = rgba(top);
  c.fill();
  c.strokeStyle = rgba(P.outline);
  c.lineWidth = 3;
  rr(c, x, y, w, h, r);
  c.stroke();
  c.beginPath();
  c.moveTo(x + 2, y + h - depth);
  c.lineTo(x + w - 2, y + h - depth);
  c.stroke();
}

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function label(c, f, s, text, y) {
  if (!text) return;
  c.font = `600 13px ${f.P.body || 'sans-serif'}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const wdt = c.measureText(text).width + 14;
  c.fillStyle = rgba(f.P.bg || [10, 12, 18], 0.72);
  rr(c, s.x + s.w / 2 - wdt / 2, y - 9, wdt, 18, 6);
  c.fill();
  c.fillStyle = rgba(f.P.text || [230, 236, 240]);
  c.fillText(text, s.x + s.w / 2, y);
}

const ACC = (P) => [P.c1, P.c3, P.ok, P.warn, P.c2];

function station(c, f, s) {
  const P = f.P;
  const { x, y, w, h } = s;
  const acc = ACC(P);
  switch (s.kind) {
    case 'shelf': {
      block(c, P, x, y, w, h, P.wood, P.woodShade, { r: 4, depth: 10 });
      // Books: the understood ones in accent colours, a gap where things are shaky.
      const n = s.books;
      for (let i = 0; i < n; i++) {
        const bw = (w - 16) / 9;
        const lit = i / Math.max(1, n) < s.fill || n < 3;
        c.fillStyle = rgba(lit ? acc[(s.seed + i) % acc.length] : P.stoneShade);
        c.fillRect(x + 8 + i * bw, y + 8 + ((s.seed * 7 + i) % 3) * 3, bw - 3, h - 26 - ((s.seed * 7 + i) % 3) * 3);
      }
      c.fillStyle = rgba(P.woodShade);
      c.fillRect(x + 4, y + h / 2 - 2, w - 8, 4);
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'table':
    case 'desk':
    case 'longtable':
    case 'bench':
    case 'drafting': {
      block(c, P, x, y, w, h, s.kind === 'bench' ? P.timber : P.woodLight, P.woodShade, { r: 8, depth: 16 });
      if (s.kind === 'desk' || s.kind === 'table') {
        c.fillStyle = rgba([245, 240, 225]);
        c.fillRect(x + w * 0.2, y + 12, w * 0.3, h * 0.4);
        c.fillStyle = rgba(P.outline, 0.5);
        for (let i = 0; i < 3; i++) c.fillRect(x + w * 0.24, y + 18 + i * 7, w * 0.2, 2);
      }
      if (s.kind === 'bench') for (let i = 0; i < 4; i++) {
        c.fillStyle = rgba(acc[i % acc.length]);
        rr(c, x + 20 + i * 64, y + 14, 36, 14, 4);
        c.fill();
      }
      if (s.kind === 'longtable') for (let i = 0; i < 4; i++) {
        c.fillStyle = rgba([250, 250, 250]);
        c.beginPath();
        c.ellipse(x + 60 + i * 95, y + h / 2 - 6, 18, 11, 0, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = rgba(P.outline, 0.7);
        c.lineWidth = 2;
        c.stroke();
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'roundtable': {
      c.fillStyle = rgba([0, 0, 0], 0.18);
      c.beginPath();
      c.ellipse(x + w / 2, y + h * 0.8, w * 0.45, 12, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = rgba(P.woodShade);
      c.beginPath();
      c.ellipse(x + w / 2, y + h * 0.55 + 10, w * 0.42, h * 0.3, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = rgba(P.woodLight);
      c.beginPath();
      c.ellipse(x + w / 2, y + h * 0.55, w * 0.42, h * 0.3, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 3;
      c.stroke();
      for (let i = 0; i < s.cups; i++) {
        const a = (i / Math.max(1, s.cups)) * Math.PI * 2 + s.seed;
        const cx = x + w / 2 + Math.cos(a) * w * 0.22;
        const cy = y + h * 0.55 + Math.sin(a) * h * 0.14;
        c.fillStyle = rgba([250, 250, 250]);
        c.beginPath();
        c.ellipse(cx, cy, 7, 5, 0, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = rgba(P.outline, 0.7);
        c.lineWidth = 2;
        c.stroke();
        if (f.anim && !f.lite) {
          c.strokeStyle = rgba([255, 255, 255], 0.35);
          c.lineWidth = 1.5;
          c.beginPath();
          const ph = f.t * 2 + i;
          c.moveTo(cx, cy - 6);
          c.quadraticCurveTo(cx + Math.sin(ph) * 4, cy - 12, cx, cy - 18);
          c.stroke();
        }
      }
      label(c, f, s, s.label, y + h + 6);
      break;
    }
    case 'counter': {
      block(c, P, x, y, w, h, P.timber, P.timberDark, { r: 6, depth: 18 });
      block(c, P, x + w - 90, y - 26, 60, 50, P.copper, mix(P.copper, [0, 0, 0], 0.3), { r: 6, depth: 14 });
      if (f.anim && !f.lite) {
        c.strokeStyle = rgba([255, 255, 255], 0.4);
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(x + w - 60, y - 30);
        c.quadraticCurveTo(x + w - 60 + Math.sin(f.t * 2) * 6, y - 44, x + w - 58, y - 56);
        c.stroke();
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'board':
    case 'chart':
    case 'poster': {
      block(c, P, x, y, w, h, s.kind === 'chart' ? [24, 30, 64] : s.kind === 'poster' ? P.cloth : [40, 52, 44], P.timberDark, { r: 4, depth: 8 });
      if (s.kind === 'chart') {
        for (const star of s.stars || []) {
          const sx = x + 10 + (star.seed % 100) * ((w - 20) / 100);
          const sy = y + 8 + ((star.seed >>> 7) % 100) * ((h - 26) / 100);
          c.fillStyle = rgba(star.lit ? P.warn : star.warm ? P.c1 : [120, 130, 170], star.lit ? 1 : 0.7);
          c.beginPath();
          c.arc(sx, sy, star.lit ? 4 : 2.5, 0, Math.PI * 2);
          c.fill();
        }
      } else if (s.kind === 'board') {
        c.fillStyle = rgba([235, 235, 225], 0.9);
        c.font = `12px ${P.body || 'sans-serif'}`;
        c.textAlign = 'left';
        c.textBaseline = 'top';
        (s.lines || []).slice(0, 3).forEach((l, i) => c.fillText(short(l, 22), x + 10, y + 8 + i * 15));
      } else {
        c.fillStyle = rgba(acc[s.seed % acc.length], 0.9);
        rr(c, x + 10, y + 10, w - 20, h - 36, 4);
        c.fill();
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'cabinet': {
      block(c, P, x, y, w, h, P.stoneLight, P.stoneShade, { r: 4, depth: 10 });
      for (let i = 0; i < s.drawers; i++) {
        const dy = y + 8 + i * ((h - 24) / s.drawers);
        const full = i / s.drawers < s.full;
        c.fillStyle = rgba(full ? mix(P.copper, P.stoneLight, 0.4) : P.stone);
        rr(c, x + 8, dy, w - 16, (h - 24) / s.drawers - 4, 3);
        c.fill();
        c.strokeStyle = rgba(P.outline, 0.6);
        c.lineWidth = 2;
        c.stroke();
        c.fillStyle = rgba(P.outline, 0.8);
        c.fillRect(x + w / 2 - 6, dy + (h - 24) / s.drawers / 2 - 3, 12, 3);
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'pigeonholes': {
      block(c, P, x, y, w, h, P.wood, P.woodShade, { r: 4, depth: 8 });
      const cols = 4;
      const cw = (w - 16) / cols;
      for (let i = 0; i < cols * 2; i++) {
        const cx = x + 8 + (i % cols) * cw;
        const cy = y + 8 + Math.floor(i / cols) * ((h - 24) / 2);
        c.fillStyle = rgba(P.woodShade);
        c.fillRect(cx + 2, cy, cw - 4, (h - 24) / 2 - 4);
        if (s.papers[i]) {
          c.fillStyle = rgba([245, 240, 225]);
          c.fillRect(cx + 6, cy + 6, cw - 12, (h - 24) / 2 - 14);
        }
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'papers': {
      c.fillStyle = rgba([0, 0, 0], 0.12);
      c.fillRect(x + 4, y + 4, w, h);
      for (let i = 2; i >= 0; i--) {
        c.fillStyle = rgba([248, 244, 230]);
        c.fillRect(x - i * 2, y + i * 3, w, h - 6);
        c.strokeStyle = rgba(P.outline, 0.8);
        c.lineWidth = 2;
        c.strokeRect(x - i * 2, y + i * 3, w, h - 6);
      }
      c.fillStyle = rgba(P.outline, 0.45);
      for (let i = 0; i < 3; i++) c.fillRect(x + 8, y + 10 + i * 7, w - 24, 2);
      label(c, f, s, s.label, y + h + 10);
      break;
    }
    case 'bed': {
      block(c, P, x, y, w, h, P.woodLight, P.woodShade, { r: 6, depth: 10 });
      c.fillStyle = rgba(acc[s.seed % acc.length], 0.85);
      rr(c, x + 8, y + 40, w - 16, h - 60, 6);
      c.fill();
      c.fillStyle = rgba([250, 250, 250]);
      rr(c, x + 12, y + 10, w - 24, 24, 8);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.7);
      c.lineWidth = 2;
      c.stroke();
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'fireplace': {
      block(c, P, x, y, w, h, P.stone, P.stoneShade, { r: 4, depth: 14 });
      c.fillStyle = rgba([30, 20, 18]);
      rr(c, x + 30, y + 12, w - 60, h - 30, 8);
      c.fill();
      flame(c, f, x + w / 2, y + h - 22, 26, s.seed || 1);
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'forge': {
      block(c, P, x, y, w, h, P.stone, P.stoneShade, { r: 6, depth: 18 });
      c.fillStyle = rgba([30, 20, 18]);
      rr(c, x + 20, y + 14, w - 40, h - 44, 8);
      c.fill();
      flame(c, f, x + w / 2, y + h - 34, 34, 2);
      if (f.anim && !f.lite) {
        for (let i = 0; i < 6; i++) {
          const ph = (f.t * 1.4 + i * 0.37) % 1;
          c.fillStyle = rgba(P.warn, 1 - ph);
          c.fillRect(x + w / 2 - 20 + i * 8 + Math.sin(f.t * 5 + i) * 6, y + h - 40 - ph * 70, 3, 3);
        }
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'seat': {
      block(c, P, x, y + 14, w, h - 14, P.wood, P.woodShade, { r: 5, depth: 10 });
      block(c, P, x + 6, y, w - 12, 16, P.woodLight, P.woodShade, { r: 4, depth: 6 });
      break;
    }
    case 'anvil': {
      block(c, P, x, y + h * 0.4, w, h * 0.6, [70, 74, 84], [44, 46, 54], { r: 4, depth: 10 });
      block(c, P, x + 6, y, w - 12, h * 0.45, [96, 100, 110], [60, 62, 70], { r: 6, depth: 8 });
      break;
    }
    case 'crate': {
      block(c, P, x, y, w, h, P.wood, P.woodShade, { r: 3, depth: 10 });
      c.strokeStyle = rgba(P.outline, 0.5);
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x + 4, y + 4);
      c.lineTo(x + w - 4, y + h - 14);
      c.moveTo(x + w - 4, y + 4);
      c.lineTo(x + 4, y + h - 14);
      c.stroke();
      break;
    }
    case 'lamp': {
      c.fillStyle = rgba(P.timberDark);
      c.fillRect(x + w / 2 - 3, y + 10, 6, h + 10);
      c.fillStyle = rgba(P.lamp, f.night ? 1 : 0.8);
      c.beginPath();
      c.moveTo(x, y + 14);
      c.lineTo(x + w, y + 14);
      c.lineTo(x + w - 8, y);
      c.lineTo(x + 8, y);
      c.closePath();
      c.fill();
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 2;
      c.stroke();
      if (f.night) {
        const g = c.createRadialGradient(x + w / 2, y + 14, 4, x + w / 2, y + 14, 90);
        g.addColorStop(0, rgba(P.lamp, 0.35));
        g.addColorStop(1, rgba(P.lamp, 0));
        c.fillStyle = g;
        c.fillRect(x - 90, y - 80, w + 180, 180);
      }
      break;
    }
    case 'plant': {
      block(c, P, x + 6, y + h - 26, w - 12, 26, P.copper, mix(P.copper, [0, 0, 0], 0.3), { r: 4, depth: 8 });
      c.fillStyle = rgba(P.leaf);
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.5 + (f.anim ? Math.sin(f.t * 1.3 + i) * 0.05 : 0);
        c.beginPath();
        c.ellipse(x + w / 2 + Math.cos(a) * 16, y + h - 26 + Math.sin(a) * 18, 16, 7, a, 0, Math.PI * 2);
        c.fill();
      }
      c.strokeStyle = rgba(P.outline, 0.6);
      c.lineWidth = 2;
      c.beginPath();
      c.arc(x + w / 2, y + h - 30, 16, Math.PI, 0);
      c.stroke();
      break;
    }
    case 'rug': {
      c.fillStyle = rgba(P.cloth, 0.9);
      rr(c, x, y, w, h, 10);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.5);
      c.lineWidth = 2;
      rr(c, x + 8, y + 8, w - 16, h - 16, 6);
      c.stroke();
      break;
    }
    case 'telescope': {
      block(c, P, x + w / 2 - 40, y + h - 40, 80, 40, [70, 74, 84], [44, 46, 54], { r: 6, depth: 14 });
      c.save();
      c.translate(x + w / 2, y + h - 40);
      c.rotate(-0.9);
      c.fillStyle = rgba(P.copper);
      rr(c, -16, -h + 20, 32, h - 20, 8);
      c.fill();
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 3;
      c.stroke();
      c.fillStyle = rgba([120, 180, 220]);
      c.beginPath();
      c.ellipse(0, -h + 22, 15, 6, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'globe': {
      block(c, P, x + w / 2 - 14, y + h - 26, 28, 26, P.wood, P.woodShade, { r: 4, depth: 8 });
      c.fillStyle = rgba([80, 140, 200]);
      c.beginPath();
      c.arc(x + w / 2, y + h / 2 - 8, w / 2 - 4, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = rgba(P.leaf);
      c.beginPath();
      c.ellipse(x + w / 2 - 6, y + h / 2 - 12, 12, 8, 0.6, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 3;
      c.beginPath();
      c.arc(x + w / 2, y + h / 2 - 8, w / 2 - 4, 0, Math.PI * 2);
      c.stroke();
      break;
    }
    case 'stage': {
      block(c, P, x, y, w, h, P.wood, P.woodShade, { r: 6, depth: 22 });
      c.fillStyle = rgba(P.banner, 0.95);
      c.fillRect(x - 10, y - 30, w + 20, 40);
      for (let i = 0; i < w / 40; i++) {
        c.fillStyle = rgba(mix(P.banner, [0, 0, 0], 0.25));
        c.fillRect(x - 10 + i * 40, y - 30, 12, 40);
      }
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 3;
      c.strokeRect(x - 10, y - 30, w + 20, 40);
      if (f.night || !f.lite) {
        const g = c.createRadialGradient(x + w / 2, y + 20, 10, x + w / 2, y + 20, 200);
        g.addColorStop(0, rgba(P.lamp, 0.3));
        g.addColorStop(1, rgba(P.lamp, 0));
        c.fillStyle = g;
        c.fillRect(x, y, w, h);
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'chair': {
      block(c, P, x + 8, y + 10, w - 16, h - 10, acc[s.seed % acc.length], mix(acc[s.seed % acc.length], [0, 0, 0], 0.35), { r: 6, depth: 12 });
      c.fillStyle = rgba(P.woodShade);
      rr(c, x + 8, y, w - 16, 12, 4);
      c.fill();
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 2;
      c.stroke();
      break;
    }
    case 'maptable': {
      block(c, P, x, y, w, h, P.woodLight, P.woodShade, { r: 8, depth: 18 });
      c.fillStyle = rgba([236, 224, 190]);
      rr(c, x + 16, y + 12, w - 32, h - 46, 4);
      c.fill();
      c.fillStyle = rgba([120, 170, 110], 0.8);
      c.beginPath();
      c.ellipse(x + w * 0.4, y + h * 0.4, 60, 26, 0.2, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.ellipse(x + w * 0.7, y + h * 0.35, 36, 18, -0.4, 0, Math.PI * 2);
      c.fill();
      for (let i = 0; i < s.pins; i++) {
        const sd = hash(`pin${i}`);
        c.fillStyle = rgba(acc[i % acc.length]);
        c.beginPath();
        c.arc(x + 24 + (sd % 100) * ((w - 48) / 100), y + 18 + ((sd >>> 7) % 100) * ((h - 58) / 100), 4, 0, Math.PI * 2);
        c.fill();
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'perch': {
      c.fillStyle = rgba(P.timberDark);
      c.fillRect(x + w / 2 - 4, y + 30, 8, h - 30);
      c.fillRect(x + 6, y + 30, w - 12, 8);
      for (const dx of [x + 16, x + w - 24]) {
        const bob = f.anim ? Math.sin(f.t * 3 + dx) * 2 : 0;
        c.fillStyle = rgba([24, 24, 30]);
        c.beginPath();
        c.ellipse(dx + 4, y + 20 + bob, 12, 9, 0, 0, Math.PI * 2);
        c.fill();
        c.beginPath();
        c.arc(dx + 12, y + 12 + bob, 6, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = rgba(P.warn);
        c.beginPath();
        c.moveTo(dx + 17, y + 12 + bob);
        c.lineTo(dx + 24, y + 14 + bob);
        c.lineTo(dx + 17, y + 16 + bob);
        c.fill();
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'brazier': {
      block(c, P, x + 10, y + h - 40, w - 20, 40, [70, 74, 84], [44, 46, 54], { r: 10, depth: 14 });
      flame(c, f, x + w / 2, y + h - 44, 28, s.seed || 3);
      break;
    }
    case 'spyglass': {
      block(c, P, x, y + h - 24, w, 24, P.wood, P.woodShade, { r: 4, depth: 10 });
      c.save();
      c.translate(x + w / 2, y + h - 24);
      c.rotate(-0.5);
      c.fillStyle = rgba(P.copper);
      rr(c, -10, -60, 20, 60, 6);
      c.fill();
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 2;
      c.stroke();
      c.restore();
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'flowerbed': {
      c.fillStyle = rgba(P.soil);
      rr(c, x, y, w, h, 10);
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.8);
      c.lineWidth = 3;
      c.stroke();
      for (let i = 0; i < 6; i++) {
        const sd = hash(`fl${s.seed}${i}`);
        const fx = x + 16 + (sd % 100) * ((w - 32) / 100);
        const fy = y + 14 + ((sd >>> 7) % 100) * ((h - 28) / 100);
        c.fillStyle = rgba(P.leaf);
        c.beginPath();
        c.arc(fx, fy, 6, 0, Math.PI * 2);
        c.fill();
        if (s.bloom) {
          c.fillStyle = rgba(acc[(s.seed + i) % acc.length]);
          c.beginPath();
          c.arc(fx, fy - 4 + (f.anim ? Math.sin(f.t * 2 + i) : 0), 5, 0, Math.PI * 2);
          c.fill();
        }
      }
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'fountain': {
      c.fillStyle = rgba(P.stoneShade);
      c.beginPath();
      c.ellipse(x + w / 2, y + h / 2 + 10, w / 2, h / 2 - 10, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = rgba(P.water);
      c.beginPath();
      c.ellipse(x + w / 2, y + h / 2, w / 2 - 10, h / 2 - 20, 0, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 3;
      c.beginPath();
      c.ellipse(x + w / 2, y + h / 2 + 10, w / 2, h / 2 - 10, 0, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = rgba(P.foam, 0.9);
      for (let i = 0; i < 5; i++) {
        const ph = f.anim ? (f.t * 0.9 + i * 0.2) % 1 : 0.5;
        c.beginPath();
        c.arc(x + w / 2 + Math.sin(i * 2.3) * 18 * ph, y + h / 2 - 20 - 30 * Math.sin(ph * Math.PI), 3, 0, Math.PI * 2);
        c.fill();
      }
      label(c, f, s, s.label, y + h + 6);
      break;
    }
    case 'banner': {
      c.fillStyle = rgba(P.timberDark);
      c.fillRect(x + w / 2 - 3, y, 6, h);
      const top = s.up ? y + 6 : y + h * 0.55;
      c.fillStyle = rgba(acc[s.seed % acc.length], s.up ? 1 : 0.55);
      const wave = f.anim && s.up ? Math.sin(f.t * 3 + s.seed) * 4 : 0;
      c.beginPath();
      c.moveTo(x + w / 2 + 3, top);
      c.lineTo(x + w - 6, top + 4 + wave);
      c.lineTo(x + w - 14, top + 22 + wave);
      c.lineTo(x + w - 6, top + 40 + wave);
      c.lineTo(x + w / 2 + 3, top + 44);
      c.closePath();
      c.fill();
      c.strokeStyle = rgba(P.outline, 0.7);
      c.lineWidth = 2;
      c.stroke();
      label(c, f, s, s.label, y + h + 12);
      break;
    }
    case 'track': {
      c.strokeStyle = rgba(P.dirt);
      c.lineWidth = 26;
      c.beginPath();
      c.ellipse(x + w / 2, y + h / 2, w / 2 - 20, h / 2 - 20, 0, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = rgba([250, 250, 250], 0.5);
      c.lineWidth = 2;
      c.setLineDash([10, 12]);
      c.stroke();
      c.setLineDash([]);
      break;
    }
    case 'dummy': {
      c.fillStyle = rgba(P.timberDark);
      c.fillRect(x + w / 2 - 4, y + 20, 8, h - 20);
      block(c, P, x + 8, y + 24, w - 16, 40, P.cloth, mix(P.cloth, [0, 0, 0], 0.3), { r: 8, depth: 10 });
      c.fillStyle = rgba(P.wheat);
      c.beginPath();
      c.arc(x + w / 2, y + 14, 12, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = rgba(P.outline);
      c.lineWidth = 2;
      c.stroke();
      break;
    }
    default:
      block(c, P, x, y, w, h, P.wood, P.woodShade);
      label(c, f, s, s.label, y + h + 12);
  }
}

function flame(c, f, x, y, size, seed) {
  const t = f.anim ? f.t * 9 + seed : 0;
  for (const [col, k] of [[[255, 120, 40], 1], [[255, 200, 70], 0.62], [[255, 250, 200], 0.3]]) {
    c.fillStyle = rgba(col, 0.95);
    c.beginPath();
    c.moveTo(x - size * 0.5 * k, y);
    c.quadraticCurveTo(x - size * 0.6 * k, y - size * 0.6 * k, x + Math.sin(t) * 3 * k, y - size * k * (1 + Math.sin(t * 1.7) * 0.1));
    c.quadraticCurveTo(x + size * 0.6 * k, y - size * 0.6 * k, x + size * 0.5 * k, y);
    c.closePath();
    c.fill();
  }
}

function highlight(c, f, s) {
  c.strokeStyle = rgba(f.P.c1, 0.9);
  c.lineWidth = 3;
  c.setLineDash([8, 6]);
  rr(c, s.x - 6, s.y - 6, s.w + 12, s.h + 12, 10);
  c.stroke();
  c.setLineDash([]);
}

// The bean: a rounded body with a visor, a backpack behind, two stub legs, outlined.
function actor(c, f, a) {
  const P = f.P;
  const col = a.color || P.c1;
  const dark = mix(col, [0, 0, 0], 0.35);
  const { x, y } = a;
  if (a.mode === 'sleep') {
    c.save();
    c.translate(x, y - 10);
    c.rotate(-Math.PI / 2);
  }
  c.fillStyle = rgba([0, 0, 0], 0.2);
  c.beginPath();
  c.ellipse(a.mode === 'sleep' ? 0 : x, a.mode === 'sleep' ? 0 : y + 3, 16, 6, 0, 0, Math.PI * 2);
  c.fill();
  const bx = a.mode === 'sleep' ? 0 : x;
  const by = a.mode === 'sleep' ? 0 : y;
  const walking = a.mode === 'walk';
  const legA = walking ? Math.sin(a.phase) * 5 : 0;
  // Legs.
  c.fillStyle = rgba(dark);
  c.strokeStyle = rgba(P.outline);
  c.lineWidth = 2.5;
  for (const [dx, lg] of [[-7, legA], [7, -legA]]) {
    rr(c, bx + dx - 5, by - 8 + lg * 0.5, 10, 12, 4);
    c.fill();
    c.stroke();
  }
  // Backpack (on the far side from the face).
  c.fillStyle = rgba(dark);
  rr(c, bx - a.face * 20 - 7, by - 30, 14, 20, 5);
  c.fill();
  c.stroke();
  // Body.
  c.fillStyle = rgba(col);
  rr(c, bx - 14, by - 42, 28, 38, 13);
  c.fill();
  c.strokeStyle = rgba(P.outline);
  c.lineWidth = 3;
  c.stroke();
  // Visor.
  c.fillStyle = rgba([150, 210, 240]);
  c.beginPath();
  c.ellipse(bx + a.face * 6, by - 32, 10, 6.5, 0, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = rgba(P.outline);
  c.lineWidth = 2;
  c.stroke();
  c.fillStyle = rgba([255, 255, 255], 0.8);
  c.beginPath();
  c.ellipse(bx + a.face * 9, by - 34, 3.5, 2, 0, 0, Math.PI * 2);
  c.fill();
  if (a.mode === 'sleep') {
    c.restore();
    c.fillStyle = rgba(P.text || [230, 236, 240], 0.8);
    c.font = `700 13px ${P.display || 'sans-serif'}`;
    c.textAlign = 'center';
    const zz = f.anim ? (f.t * 0.6) % 1 : 0.3;
    c.fillText('z', x + 18 + zz * 10, y - 30 - zz * 22);
    c.fillText('z', x + 26 + zz * 10, y - 42 - zz * 22);
  }
  // Working: the tool animation at the station, a progress bar above.
  if (a.working && a.mode === 'do') {
    c.fillStyle = rgba(P.bg || [10, 12, 18], 0.8);
    rr(c, x - 22, y - 64, 44, 8, 4);
    c.fill();
    c.fillStyle = rgba(P.c1);
    rr(c, x - 20, y - 62, 40 * a.progress, 4, 2);
    c.fill();
    if (f.anim && !f.lite) {
      for (let i = 0; i < 3; i++) {
        const ph = (f.t * 2 + i / 3) % 1;
        c.fillStyle = rgba(P.warn, 1 - ph);
        c.beginPath();
        c.arc(x + a.face * 22 + Math.sin(i * 7) * 6, y - 20 - ph * 30, 2.5, 0, Math.PI * 2);
        c.fill();
      }
    }
  }
  if (a.active) {
    c.fillStyle = rgba(P.warn);
    c.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 2.5 : 5.5;
      const an = -Math.PI / 2 + (i * Math.PI) / 5;
      c.lineTo(x + Math.cos(an) * r, y - 50 + Math.sin(an) * r);
    }
    c.closePath();
    c.fill();
  }
  // Name.
  c.font = `600 11px ${P.body || 'sans-serif'}`;
  c.textAlign = 'center';
  c.textBaseline = 'top';
  c.fillStyle = rgba(P.bg || [10, 12, 18], 0.6);
  const nw = c.measureText(a.name).width + 10;
  rr(c, x - nw / 2, y + 8, nw, 14, 5);
  c.fill();
  c.fillStyle = rgba(P.text || [230, 236, 240]);
  c.fillText(a.name, x, y + 9);
}

function bubble(c, f, a) {
  if (!a.bubble || f.t > a.bubbleUntil) return;
  const text = short(a.bubble, 38);
  c.font = `12px ${f.P.body || 'sans-serif'}`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const w = c.measureText(text).width + 18;
  const x = clamp(a.x, WALL + w / 2, RW - WALL - w / 2);
  const y = a.y - (a.working ? 84 : 68);
  c.fillStyle = rgba([255, 255, 255], 0.95);
  rr(c, x - w / 2, y - 11, w, 22, 9);
  c.fill();
  c.beginPath();
  c.moveTo(a.x - 5, y + 10);
  c.lineTo(a.x, y + 18);
  c.lineTo(a.x + 5, y + 10);
  c.fill();
  c.strokeStyle = rgba(f.P.outline, 0.8);
  c.lineWidth = 2;
  rr(c, x - w / 2, y - 11, w, 22, 9);
  c.stroke();
  c.fillStyle = rgba([20, 22, 30]);
  c.fillText(text, x, y);
}
