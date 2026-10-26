// Inner World view: the personas' village (main/innerworld.js, rules in main/worldcore.js) as a floating
// island in isometric storybook style (renderer/js/world/: map.js lays it out, art.js + places.js paint
// it, interiors.js shows inside a building, scene.js caches and animates it). Residents walk the roads
// along today's plan in real time; while a scene happens its people gather and talk in speech bubbles;
// the clock slider replays the day. The village also shows the present: whatever the assistant is doing
// sends the active persona to the matching building (code → the Workshop's forge, the web → the
// Lookout…); your skill tree shines in the night sky; banners, flowers, books and tables show your
// habits, topics and decks. Drag to look around, scroll to zoom, double-click a building to step inside.
// The side panel tells today; click a building, a resident or a star for theirs.
import { $, api, el, toast, toastError, on, promptDialog } from './util.js';
import { switchView, currentView } from './nav.js';
import { send } from './chat.js';
import { state, saveSettings } from './state.js';
import { fxLevel } from './hud.js';
import { buildMap, route, along } from './world/map.js';
import { palette, W, HZ } from './world/art.js';
import { buildIsland, frame as drawFrame, labels as drawLabels, bubble, fit, toScreen, toWorld, weatherOf } from './world/scene.js';

const ACTIONS = {
  library: ['Study session', () => ask('/study-session')],
  cafe: ['Review cards', () => ask('/drill')],
  grounds: ['Open habits', () => switchView('habits')],
  observatory: ['Open the skill tree', () => switchView('tree')],
  archive: ['Open memory', () => switchView('memory')],
  stage: ['🎭 Rehearse something', () => rehearse()],
  hearth: ['Personas', () => switchView('settings')],
};
const SCENE_MIN = 45; // a scene lasts this long on the map
const WALK_MIN = 20; // minutes to walk between places
const LIVE_LINGER_MS = 6000; // the persona stays at the work a moment after the reply is done
const TONES = ['c2', 'c3', 'ok', 'warn'];
const INSIDE_ZOOM = 2.6; // zoom (× the whole-island zoom) for stepping into a building

let data = null;
let canvas;
let ctx;
let size = { w: 0, h: 0, dpr: 1 };
let P = null; // palette from the theme
let map = null; // the island's layout (rebuilt only when the places change)
let mapKey = '';
let island = null; // the cached picture of (part of) the island
let islandKey = '';
let cam = null; // { x, y, z } in world pixels
let home = null; // the camera that shows everything
let interior = null; // a place id while looking inside it
let hits = { people: [], stars: [] };
let selected = null; // { type: 'place' | 'resident', id }
let hover = null;
let scrub = null; // minutes since midnight while the slider is held away from "live"
let frameId = 0;
let rebuildTimer = 0;
let flight = null; // a camera animation
let live = null; // { place, label, tool, at, done }
const stage = []; // live lines from a rehearsal running now

export function initInnerWorld() {
  canvas = $('#worldCanvas');
  ctx = canvas.getContext('2d');
  new ResizeObserver(resize).observe(canvas);
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, cam: { ...cam }, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (drag && cam) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) {
        cam = { ...drag.cam, x: drag.cam.x - dx / cam.z, y: drag.cam.y - dy / cam.z };
        flight = null;
        canvas.style.cursor = 'grabbing';
        draw();
        return;
      }
    }
    const h = hit(e);
    canvas.title = h?.type === 'star' ? `${h.id} · ${h.state}${h.state === 'mastered' ? '' : ` · ${Math.round(h.progress * 100)}%`} (your skill tree)` : h?.type === 'place' ? 'Click for details · double-click to step inside' : '';
    if (h?.id !== hover?.id) ((hover = h), draw());
    canvas.style.cursor = h ? 'pointer' : 'grab';
  });
  canvas.addEventListener('pointerup', (e) => {
    const was = drag;
    drag = null;
    canvas.style.cursor = 'grab';
    if (was?.moved) return scheduleRebuild();
    const h = hit(e);
    if (h?.type === 'star') return switchView('tree');
    select(h);
  });
  canvas.addEventListener('dblclick', (e) => {
    const h = hit(e);
    if (h?.type === 'place') enter(h.id);
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (!cam) return;
      const r = canvas.getBoundingClientRect();
      const s = { x: e.clientX - r.left, y: e.clientY - r.top };
      const before = toWorld(cam, size.w, size.h, s);
      const z = Math.max(home.z * 0.85, Math.min(home.z * 4.5, cam.z * (e.deltaY < 0 ? 1.12 : 0.89)));
      cam = { z, x: before.x - (s.x - size.w / 2) / z, y: before.y - (s.y - size.h / 2) / z };
      flight = null;
      if (interior && cam.z < home.z * 1.6) leave();
      draw();
      scheduleRebuild();
    },
    { passive: false },
  );
  $('#worldClock').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    scrub = Math.abs(v - nowMinutes()) < 3 ? null : v;
    clockLabel();
    draw();
  });
  $('#worldLive').onclick = () => ((scrub = null), clockLabel(), draw());
  $('#worldWrite').onclick = () => write(Boolean(data?.day));
  $('#worldAsk').onclick = () => ask('What happened in the Inner World today? Tell me about your day.');
  $('#worldChronicle').onclick = () => data && api.obsidian.openInObsidian(data.chronicle).catch(toastError);
  $('#worldFit').onclick = () => (interior ? leave() : flyTo(home));
  $('#worldLeave').onclick = () => leave();
  on('world-changed', refresh);
  on('settings', () => {
    P = null;
    islandKey = '';
    if (currentView === 'world') refresh();
  });
  // What the assistant is doing right now.
  on('agent-state', (s) => {
    if (['idle', 'happy', 'sleeping'].includes(s) && live && !live.done) live.done = Date.now();
    if (currentView === 'world') (renderNow(), draw());
  });
  api.on('world:event', (ev) => {
    if (ev.type === 'work') {
      live = { place: ev.place, label: ev.label, tool: ev.tool, at: Date.now(), done: 0 };
      if (data?.details?.work) data.details.work.today[ev.place] = (data.details.work.today[ev.place] || 0) + 1;
      if (currentView === 'world') (renderNow(), draw());
      return;
    }
    if (ev.type === 'rehearsal_turn') {
      stage.push(ev.line);
      if (stage.length > 8) stage.shift();
      if (currentView === 'world') (renderPanel(), draw());
      return;
    }
    if (ev.type === 'rehearsal') stage.length = 0;
    if (ev.type === 'failed') toast(`Inner World: ${ev.message}`, 'error');
    if (ev.type === 'day' && currentView !== 'world') toast('🏡 A new day in the Inner World');
    if (currentView === 'world' || ev.type === 'day') refresh();
  });
  document.addEventListener('visibilitychange', () => currentView === 'world' && !document.hidden && loop());
  // Residents move with the clock even without animation.
  setInterval(() => currentView === 'world' && !document.hidden && !animated() && draw(), 30000);
}

export async function refresh() {
  try {
    data = await api.world.view();
  } catch (err) {
    data = null;
    toastError(err);
    return;
  }
  clockLabel();
  renderHead();
  renderNow();
  renderPanel();
  resize();
  loop();
}

const animated = () => fxLevel() === 'hud' && !document.body.classList.contains('fx-still');
const lite = () => document.body.classList.contains('perf-lite');
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};
const at = () => scrub ?? nowMinutes();
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(Math.floor(m % 60)).padStart(2, '0')}`;
const minutes = (t) => {
  const m = String(t || '').match(/^(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const placeById = (id) => data?.places.find((p) => p.id === id);
const activeResident = () => data?.residents.find((r) => r.active) || data?.residents.find((r) => !r.npc);
// Live work shows only in "live" time, while it lasts.
const liveNow = () => (scrub === null && live && (!live.done || Date.now() - live.done < LIVE_LINGER_MS) ? live : null);

function ask(text) {
  switchView('chat');
  send(text);
}

async function rehearse() {
  const what = await promptDialog('What conversation do you want to rehearse? (who, what is at stake)');
  if (what?.trim()) ask(`I want to rehearse a conversation: ${what.trim()}. Ask me what you need to know about the people, then run it with rehearsal_run.`);
}

async function write(force) {
  const btn = $('#worldWrite');
  btn.disabled = true;
  btn.textContent = '✍ Writing the day…';
  try {
    await api.world.simulate(force);
  } catch (err) {
    toastError(err);
  } finally {
    btn.disabled = false;
    refresh();
  }
}

async function wake() {
  try {
    await saveSettings({ innerWorld: { enabled: true } });
    await refresh();
    if (data?.canSimulate) write(false);
  } catch (err) {
    toastError(err);
  }
}

// ------------------------------------------------------------ head, clock and "now"
function renderHead() {
  const d = data?.day;
  $('#worldDate').textContent = d ? `${d.weekday} · ${d.weather || ''}` : data?.enabled ? 'today is not written yet' : 'asleep';
  const ready = Boolean(data?.enabled && data.vault);
  $('#worldWrite').classList.toggle('hidden', !ready || (!d && !data.canSimulate));
  $('#worldWrite').textContent = data?.simulating ? '✍ Writing the day…' : d ? '↻ Rewrite today' : '✍ Write today';
  $('#worldWrite').disabled = Boolean(data?.simulating);
  $('#worldAsk').classList.toggle('hidden', !d);
  $('#worldChronicle').classList.toggle('hidden', !ready);
  $('#worldClockBox').classList.toggle('hidden', !d);
}

function clockLabel() {
  const isLive = scrub === null;
  if (isLive) $('#worldClock').value = nowMinutes();
  $('#worldTime').textContent = `${hhmm(at())}${isLive ? ' · live' : ''}`;
  $('#worldLive').classList.toggle('hidden', isLive);
}

// The banner over the village: where the persona you talk to is working right now.
function renderNow() {
  const box = $('#worldNow');
  const l = liveNow();
  const who = activeResident()?.name || state.settings?.agent?.name || 'Your assistant';
  const thinking = !l && ['thinking', 'working'].includes(state.agentState);
  box.classList.toggle('hidden', !(l || thinking) || !data?.enabled);
  box.textContent = l ? `● ${who} is ${l.label}` : thinking ? `● ${who} is thinking…` : '';
}

// ------------------------------------------------------------ the island and the camera
function resize() {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  size = { w: r.width, h: r.height, dpr };
  if (data?.places) sceneData();
  // A camera at the overview stays at the overview; one you moved stays where you put it.
  const atHome = !cam || !home || (Math.abs(cam.z - home.z) < 1e-6 && Math.abs(cam.x - home.x) < 1e-3 && Math.abs(cam.y - home.y) < 1e-3);
  home = fit(size.w, size.h, map);
  if (atHome && !interior) cam = { ...home };
  island = null;
  draw();
}

// The data the picture depends on; when it changes, the island is painted again.
function sceneData() {
  P ||= palette();
  const places = data.places.map((p) => ({ id: p.id, x: p.x, y: p.y, name: p.name, level: p.level }));
  const key = places.map((p) => `${p.id}:${p.x}:${p.y}`).join('|');
  if (key !== mapKey) ((map = buildMap(places)), (mapKey = key));
  const details = { ...data.details, residents: data.residents.map((r) => r.name), lastRehearsal: data.rehearsals?.[0]?.title || '' };
  return { map, P, places, details, interior };
}

// The part of the island the camera sees, with a margin, at the camera's zoom (sharp when zoomed in).
function ensureIsland(force = false) {
  const d = sceneData();
  const key = JSON.stringify([d.places.map((p) => p.level), d.details, interior, P.key]);
  const scale = Math.min(lite() ? 2 : 3.2, cam.z * size.dpr);
  const tl = toWorld(cam, size.w, size.h, { x: 0, y: 0 });
  const br = toWorld(cam, size.w, size.h, { x: size.w, y: size.h });
  const mx = (br.x - tl.x) * 0.4;
  const my = (br.y - tl.y) * 0.4;
  const inside = island && island.region.minX <= tl.x && island.region.minY <= tl.y && island.region.maxX >= br.x && island.region.maxY >= br.y;
  const sharp = island && island.scale / scale > 0.8 && island.scale / scale < 1.3;
  if (!force && island && key === islandKey && inside && sharp) return;
  if (!force && island && key === islandKey) return scheduleRebuild();
  island = buildIsland(d, scale, { minX: tl.x - mx, minY: tl.y - my, maxX: br.x + mx, maxY: br.y + my });
  islandKey = key;
}

function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    if (!data || !cam) return;
    const before = island;
    ensureIsland(true);
    if (before !== island) draw();
  }, 180);
}

function flyTo(target, then) {
  flight = { from: { ...cam }, to: target, start: performance.now(), then };
  loop(true);
}

function enter(id) {
  const s = map?.sites[id];
  if (!s) return;
  interior = id;
  islandKey = '';
  select({ type: 'place', id });
  const c = W(s.gx, s.gy, s.h * HZ + 12);
  flyTo({ x: c.x, y: c.y, z: home.z * INSIDE_ZOOM });
  $('#worldLeave').classList.remove('hidden');
}

function leave() {
  if (!interior) return;
  interior = null;
  islandKey = '';
  $('#worldLeave').classList.add('hidden');
  flyTo(home);
}

// ------------------------------------------------------------ residents
// Where a resident stands at a place: beside it (or inside, when looking in), side by side.
function spot(placeId, j) {
  const s = map.sites[placeId] || map.sites.garden;
  if (placeId === interior) return { x: s.gx - s.a * 0.4 + (j % 3) * 0.55, y: s.gy + s.b * 0.25 + Math.floor(j / 3) * 0.5 };
  if (placeId === 'garden') {
    const a = 2.3 + j * 0.9;
    return { x: s.gx + Math.cos(a) * 1.35, y: s.gy + Math.sin(a) * 1.35 };
  }
  return { x: s.gx + s.a + 0.75 - (j % 2) * 0.1, y: s.gy + s.b * 0.35 - j * 0.6 };
}

const groundZ = (g) => map.hgt(Math.floor(g.x), Math.floor(g.y)) * HZ;

const colorOf = (r, i) => {
  P ||= palette(); // the side panel can ask before the first draw
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(r.color || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : P[TONES[i % 4]];
};

// The scene happening at this minute, if any.
function sceneAt(m) {
  return (data?.day?.scenes || []).find((s) => {
    const t = minutes(s.time);
    return t !== null && m >= t && m < t + SCENE_MIN;
  });
}

/** Everyone at minute m: in a scene, at live work, walking the roads, at their plan's place, or asleep. */
function positions(m) {
  const out = [];
  if (!data?.residents) return out;
  if (!map) sceneData();
  const scene = sceneAt(m);
  const l = liveNow();
  const me = activeResident();
  const thinking = scrub === null && ['thinking', 'working'].includes(state.agentState);
  const crowd = new Map();
  data.residents.forEach((r, i) => {
    let place = 'garden';
    let activity = 'strolling';
    let from = null;
    let k = 1;
    let asleep = false;
    const plan = r.plan || [];
    if (l && r === me) {
      place = l.place;
      activity = l.label;
    } else if (scene && scene.who.includes(r.name)) {
      place = scene.place;
      activity = scene.title || 'talking';
    } else if (m < 6 * 60 || m >= 23 * 60) {
      place = 'hearth';
      activity = 'asleep';
      asleep = true;
    } else if (plan.length) {
      let idx = -1;
      plan.forEach((b, j) => minutes(b.start) !== null && minutes(b.start) <= m && (idx = j));
      if (idx < 0) {
        place = 'hearth';
        activity = 'asleep';
        asleep = true;
      } else {
        place = plan[idx].place;
        activity = plan[idx].activity;
        const since = m - minutes(plan[idx].start);
        const prev = idx > 0 ? plan[idx - 1].place : 'hearth';
        if (since < WALK_MIN && prev !== place) ((from = prev), (k = since / WALK_MIN));
      }
    }
    const list = crowd.get(place) || [];
    list.push(r.name);
    crowd.set(place, list);
    out.push({ r, i, name: r.name, place, activity, from, k, asleep, working: Boolean(l && r === me), thinking: thinking && !l && r === me });
  });
  for (const p of out) {
    let g = spot(p.place, crowd.get(p.place).indexOf(p.name));
    if (p.from) {
      const path = route(map, p.from, p.place);
      g = path.length ? along([spot(p.from, 0), ...path, g], p.k) : g;
    }
    const wp = W(g.x, g.y, groundZ(g));
    Object.assign(p, { x: wp.x, y: wp.y, walking: Boolean(p.from), color: colorOf(p.r, p.i), kind: p.r === me ? 'active' : p.r.npc ? 'npc' : 'persona' });
  }
  return out;
}

// ------------------------------------------------------------ drawing
function loop(once = false) {
  cancelAnimationFrame(frameId);
  if (currentView !== 'world' || document.hidden) return;
  const step = () => {
    if (flight) {
      const k = Math.min(1, (performance.now() - flight.start) / 650);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      cam = { x: flight.from.x + (flight.to.x - flight.from.x) * e, y: flight.from.y + (flight.to.y - flight.from.y) * e, z: flight.from.z + (flight.to.z - flight.from.z) * e };
      if (k >= 1) {
        const then = flight.then;
        flight = null;
        ensureIsland(true);
        then?.();
      }
    }
    draw();
    if (flight || (animated() && currentView === 'world' && !document.hidden)) frameId = requestAnimationFrame(() => setTimeout(step, lite() ? 66 : 33));
  };
  if (once || animated() || flight) step();
  else draw();
}

function draw() {
  if (!ctx || !size.w || !data?.places) return;
  if (!cam) cam = { ...home };
  ensureIsland();
  const m = at();
  const people = positions(m).filter((p) => !p.asleep);
  const l = liveNow();
  const f = {
    w: size.w,
    h: size.h,
    dpr: size.dpr,
    cam,
    island,
    P,
    t: performance.now(),
    anim: animated(),
    lite: lite(),
    minute: m,
    weather: weatherOf(data.day?.weather),
    skills: data.details?.skills || [],
    residents: people,
    live: l?.place || (stage.length ? 'stage' : null),
    busy: data.details?.work?.today,
  };
  hits = drawFrame(ctx, f);
  drawLabels(ctx, f, island, { hover: hover?.type === 'place' ? hover.id : null, selected: selected?.type === 'place' ? selected.id : null });
  // Speech: a scene playing now, a live rehearsal, or what the assistant is doing.
  const scene = sceneAt(m);
  if (scene) {
    const t = minutes(scene.time);
    const line = scene.lines[Math.min(scene.lines.length - 1, Math.floor(((m - t) / SCENE_MIN) * scene.lines.length))];
    const who = hits.people.find((p) => p.name === line.who);
    if (who) bubble(ctx, f, who.x, who.top, `${line.who}: ${line.text}`);
  } else if (stage.length && island.hits.stage) {
    const p = toScreen(cam, size.w, size.h, island.hits.stage.center);
    const line = stage[stage.length - 1];
    bubble(ctx, f, p.x, p.y - 60 * cam.z, `${line.who}: ${line.text}`, { live: true });
  }
  if (l && !scene) {
    const me = hits.people.find((p) => p.name === activeResident()?.name);
    if (me) bubble(ctx, f, me.x, me.top, `${l.label}…`, { live: true });
  }
}

// ------------------------------------------------------------ interaction
function hit(e) {
  if (!data?.places || !cam || !island) return null;
  const r = canvas.getBoundingClientRect();
  const s = { x: e.clientX - r.left, y: e.clientY - r.top };
  for (const p of hits.people) if (Math.hypot(s.x - p.x, s.y - p.y) < p.r) return { type: 'resident', id: p.name };
  const wpt = toWorld(cam, size.w, size.h, s);
  let best = null;
  for (const [id, b] of Object.entries(island.hits)) {
    if (wpt.x < b.x0 || wpt.x > b.x1 || wpt.y < b.y0 || wpt.y > b.y1) continue;
    // Several boxes can overlap: the one in front (lowest on screen) wins.
    if (!best || b.y1 > best.b.y1) best = { id, b };
  }
  if (best) return { type: 'place', id: best.id };
  for (const st of hits.stars) if (Math.hypot(s.x - st.x, s.y - st.y) < st.r) return { type: 'star', id: st.name, state: st.state, progress: st.progress };
  return null;
}

function select(h) {
  selected = h;
  renderPanel();
  draw();
}

// ------------------------------------------------------------ the side panel
function renderPanel() {
  const box = $('#worldPanel');
  box.innerHTML = '';
  if (!data) return;
  if (!data.vault) return box.append(el('h3', { class: 'display' }, 'The Inner World needs a vault'), el('p', {}, 'It keeps its chronicle and the residents’ memories as notes in your vault. Set one up in Settings → Memory vault.'));
  if (!data.enabled) return box.append(...wakeCard());
  if (selected?.type === 'place') return box.append(...placePanel(placeById(selected.id)));
  if (selected?.type === 'resident') return residentPanel(box, selected.id);
  box.append(...todayPanel());
}

function wakeCard() {
  return [
    el('h3', { class: 'display' }, 'The village is asleep'),
    el('p', {}, 'Wake it and your personas start living a small fictional life here: every morning a narrator writes their day (plans, chance meetings, conversations), and each of them remembers it and draws their own insights over time.'),
    el('p', {}, 'The village mirrors you. The Library grows with what you come to understand, the Café with your vocabulary, the Training Grounds fly a banner for each habit, the Observatory charts your skills, and at night your skill tree shines in the sky. Whatever your assistant is doing right now, you’ll see its persona at work: at the forge when it writes code, up the Lookout when it searches the web.'),
    el('p', { class: 'hint' }, 'It costs one model call a day (plus an occasional one when a resident reflects). Everything stays in your vault under “Inner World/”. Your assistant talks about it only when you ask.'),
    el('button', { class: 'btn primary', onclick: wake }, '🌅 Wake the world'),
  ];
}

function sceneCard(s) {
  const name = placeById(s.place)?.name || s.place;
  return el(
    'div',
    { class: 'world-scene', title: 'Watch it in the village', onclick: () => ((scrub = minutes(s.time) + 1), ($('#worldClock').value = scrub), clockLabel(), draw()) },
    el('div', { class: 'hint' }, `${s.time} · ${name}`),
    el('b', {}, s.title || 'A moment'),
    ...s.lines.map((l) => el('div', { class: 'world-line', style: lineStyle(l.who) }, el('span', { class: 'who' }, l.who), ` ${l.text}`)),
    s.outcome ? el('div', { class: 'world-outcome' }, s.outcome) : '',
  );
}

// A speaker's color on a line: their persona's accent (validated hex from the main process), or a
// theme accent by their place in the list (the same one the village uses).
function lineStyle(who) {
  const i = data.residents.findIndex((x) => x.name === who);
  if (i < 0) return '';
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(data.residents[i].color || '');
  return m ? `--who: ${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : `--who: var(--${TONES[i % 4]})`;
}

function todayPanel() {
  const out = [];
  const d = data.day;
  if (!d) {
    out.push(
      el('h3', { class: 'display' }, 'A new day'),
      el('p', {}, data.canSimulate ? 'Today hasn’t been written yet. It happens on its own in a moment, or now:' : 'The village wakes at 7. Until then everyone is asleep.'),
      data.canSimulate ? el('button', { class: 'btn primary', onclick: () => write(false) }, '✍ Write today') : '',
    );
    if (data.lastDay) out.push(el('div', { class: 'world-sec' }, el('b', {}, `Last time · ${data.lastDay.date}`), el('p', {}, data.lastDay.summary)));
  } else {
    out.push(el('h3', { class: 'display' }, `${d.weekday}${d.weather ? ` · ${d.weather}` : ''}`), el('p', {}, d.summary));
    if (d.news?.length) out.push(el('div', { class: 'world-news' }, ...d.news.map((n) => el('div', {}, `🏗 ${n}`))));
    if (d.scenes.length) out.push(el('div', { class: 'world-sec' }, el('b', {}, 'Scenes'), ...d.scenes.map(sceneCard)));
  }
  const pos = new Map(positions(at()).map((p) => [p.name, p]));
  out.push(
    el(
      'div',
      { class: 'world-sec' },
      el('b', {}, 'Residents'),
      ...data.residents.map((r) => {
        const p = pos.get(r.name);
        return el(
          'button',
          { class: 'world-res', style: lineStyle(r.name), onclick: () => select({ type: 'resident', id: r.name }) },
          el('span', { class: 'dot' }),
          el('span', { class: 'name' }, `${r.name}${r.active ? ' ★' : ''}`),
          el('span', { class: 'hint' }, p ? `${r.mood ? `${r.mood} · ` : ''}${p.activity} · ${placeById(p.place)?.name || ''}` : r.npc ? 'villager' : 'persona'),
        );
      }),
    ),
  );
  const work = Object.entries(data.details?.work?.today || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (work.length) out.push(el('div', { class: 'world-sec' }, el('b', {}, 'Worked on today'), el('div', { class: 'world-work' }, ...work.map(([id, n]) => el('span', { class: 'chip' }, `${placeById(id)?.icon || ''} ${placeById(id)?.name || id} · ${n}`)))));
  out.push(stagePanel());
  if (data.days.length > 1) out.push(el('div', { class: 'world-sec' }, el('b', {}, 'Earlier days'), ...data.days.filter((x) => x.date !== d?.date).map((x) => el('div', { class: 'world-day' }, el('span', { class: 'hint' }, `${x.weekday || ''} ${x.date}`), el('div', {}, x.summary)))));
  return out;
}

function stagePanel() {
  return el(
    'div',
    { class: 'world-sec' },
    el('b', {}, '🎭 The Stage'),
    stage.length ? el('div', { class: 'world-scene live' }, el('div', { class: 'hint' }, 'On stage now'), ...stage.map((l) => el('div', { class: 'world-line' }, el('span', { class: 'who' }, l.who), ` ${l.text}`))) : '',
    ...data.rehearsals.map((r) =>
      el(
        'div',
        { class: 'world-day' },
        el('span', { class: 'hint' }, `${new Date(r.at).toLocaleDateString()} · ${r.cast?.join(', ') || ''}`),
        el('div', {}, el('b', {}, r.title), r.outcome ? ` — ${r.outcome}` : ''),
        r.note ? el('button', { class: 'btn small', onclick: () => api.obsidian.openInObsidian(r.note).catch(toastError) }, 'Open') : '',
      ),
    ),
    el('button', { class: 'btn small', onclick: rehearse }, '＋ Rehearse a conversation'),
  );
}

function back() {
  return el('button', { class: 'btn small world-back', onclick: () => select(null) }, '← Today');
}

// What a place shows of you: the topics on its shelves, the banners, the stars…
function placeDetails(p) {
  const d = data.details || {};
  const list = (title, items) => (items.length ? el('div', { class: 'world-sec' }, el('b', {}, title), ...items) : '');
  const row = (text, cls = '') => el('div', { class: `world-plan ${cls}` }, text);
  switch (p.id) {
    case 'library':
      return list('On the shelves', (d.topics || []).map((t) => row(`📖 ${t.name} · ${t.understood} understood${t.shaky ? `, ${t.shaky} shaky` : ''}`)));
    case 'cafe':
      return list('At the tables', (d.decks || []).map((x) => row(`🗂 ${x.name} · ${x.mature} mature of ${x.total}${x.due ? ` · ${x.due} due` : ''}`)));
    case 'grounds':
      return list('Banners', (d.habits || []).map((h) => row(`${h.done ? '🚩' : '🏳'} ${h.name}${h.streak ? ` · streak ${h.streak} ${h.unit}` : ''}${h.done ? ' · kept today' : ''}`, h.done ? 'now' : '')));
    case 'garden':
      return list('In bloom today', (d.habits || []).map((h) => row(`${h.done ? '🌸' : '🌱'} ${h.name}`, h.done ? 'now' : '')));
    case 'observatory':
      return list('Charted skills (the night sky)', (d.skills || []).map((s) => row(`${s.state === 'mastered' ? '✦' : s.state === 'locked' ? '·' : '✧'} ${s.name} · ${s.state === 'mastered' ? 'mastered' : `${Math.round(s.progress * 100)}%`}`, s.state === 'mastered' ? 'now' : '')));
    case 'archive':
      return el('div', { class: 'world-grow' }, el('b', {}, 'Filed here'), el('div', {}, `${d.memories || 0} memories · ${d.records || 0} stream records · ${d.insights || 0} insights`));
    case 'workshop':
    case 'lookout':
      return el('div', { class: 'world-grow' }, el('b', {}, 'Work done here'), el('div', {}, `${d.work?.today?.[p.id] || 0} today · ${d.work?.total?.[p.id] || 0} in all`));
    default:
      return '';
  }
}

function placePanel(p) {
  if (!p) return [back()];
  const here = positions(at()).filter((x) => x.place === p.id && !x.asleep).map((x) => x.name);
  const scenes = (data.day?.scenes || []).filter((s) => s.place === p.id);
  const action = ACTIONS[p.id];
  return [
    back(),
    el('div', { class: 'hint' }, `${p.stage}${p.level ? ` · level ${p.level} of 3` : ''}`),
    el('h3', { class: 'display' }, `${p.icon} ${p.name}`),
    el('p', {}, p.about),
    el('div', { class: 'world-grow' }, el('b', {}, 'Grows with'), el('div', {}, p.hint)),
    placeDetails(p),
    here.length ? el('div', { class: 'world-sec' }, el('b', {}, 'Here now'), el('div', {}, here.join(', '))) : '',
    scenes.length ? el('div', { class: 'world-sec' }, el('b', {}, 'Today here'), ...scenes.map(sceneCard)) : '',
    p.id === 'stage' ? stagePanel() : '',
    el(
      'div',
      { class: 'row' },
      interior === p.id ? el('button', { class: 'btn', onclick: leave }, '← Step outside') : el('button', { class: 'btn primary', onclick: () => enter(p.id) }, '🚪 Step inside'),
      action && p.id !== 'stage' ? el('button', { class: 'btn', onclick: action[1] }, action[0]) : '',
    ),
  ];
}

async function residentPanel(box, name) {
  box.append(back(), el('div', { class: 'hint' }, 'Remembering…'));
  let r;
  try {
    r = await api.world.resident(name);
  } catch (err) {
    box.lastChild.textContent = err.message;
    return;
  }
  if (selected?.id !== name) return; // the user moved on meanwhile
  const info = data.residents.find((x) => x.name === name) || {};
  const now = positions(at()).find((p) => p.name === name);
  box.innerHTML = '';
  box.append(
    back(),
    el('div', { class: 'hint' }, r.npc ? 'villager' : info.active ? 'persona · the one you talk to now' : 'persona'),
    el('h3', { class: 'display', style: lineStyle(name) }, el('span', { class: 'world-swatch' }), ` ${r.name}`),
    el('p', { class: 'world-persona' }, r.persona),
    now ? el('div', { class: 'world-grow' }, el('b', {}, 'Now'), el('div', {}, `${now.activity} · ${placeById(now.place)?.name || ''}${info.mood ? ` · feeling ${info.mood}` : ''}`)) : '',
    r.today?.plan?.length
      ? el('div', { class: 'world-sec' }, el('b', {}, 'Today'), ...r.today.plan.map((b) => el('div', { class: `world-plan ${now && b.activity === now.activity && b.place === now.place ? 'now' : ''}` }, el('span', { class: 'hint' }, b.start), ` ${b.activity} · ${placeById(b.place)?.name || b.place}`)))
      : '',
    el(
      'div',
      { class: 'world-sec' },
      el('b', {}, 'Memories'),
      ...(r.records.length ? r.records.slice(0, 25).map((x) => el('div', { class: `world-mem ${x.kind}` }, x.kind === 'reflection' ? `✨ ${x.text}` : x.text)) : [el('div', { class: 'hint' }, 'Nothing yet: memories come with the first day.')]),
    ),
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn small', onclick: () => ask(info.active ? 'What did you do today in the Inner World?' : `What has ${r.name} been up to in the Inner World lately?`) }, 'Ask about their day'),
      el('button', { class: 'btn small', onclick: () => api.obsidian.openInObsidian(r.note).catch(toastError) }, 'Their memories in the vault'),
    ),
  );
}
