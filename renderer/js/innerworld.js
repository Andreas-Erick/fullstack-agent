// Inner World view: the personas' village (main/innerworld.js, rules in main/worldcore.js) as a floating
// island in isometric storybook style (renderer/js/world/: map.js lays it out, art.js + places.js paint
// it, interiors.js shows inside a building, scene.js caches and animates it). Residents walk the roads
// along today's plan in real time; while a scene happens its people gather and talk in speech bubbles;
// the clock slider replays the day. The village also shows the present: whatever the assistant is doing
// sends the active persona to the matching building (code → the Workshop's forge, the web → the
// Lookout…); your skill tree shines in the night sky; banners, flowers, books and tables show your
// habits, topics and decks. Drag to look around, scroll to zoom, double-click a building to step inside.
// The side panel tells today; click a building, a resident or a star for theirs.
import { $, api, el, toast, toastError, on, promptDialog, logEvent } from './util.js';
import { switchView, currentView } from './nav.js';
import { send } from './chat.js';
import { state, saveSettings } from './state.js';
import { fxLevel } from './hud.js';
import { buildMap, route, along } from './world/map.js';
import { seasonOf } from './world/season.js';
import { loadSprites, spritesReady } from './world/sprites.js';
import { palette, W, HZ } from './world/art.js';
import { buildIsland, release as releaseIsland, frame as drawFrame, labels as drawLabels, bubble, fit, toScreen, toWorld, weatherOf, bounds as sceneBounds } from './world/scene.js';
import { createReplay, replayBar } from './replay.js';

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
const CELEBRATE_MS = 8000;
let celebration = null; // { list: [{ id, name, from, to, stage }], at } after places gained a level
let lapse = null; // { replay, bar, last } while the timelapse is open
let lastStep = 0;

export function initInnerWorld() {
  canvas = $('#worldCanvas');
  ctx = canvas.getContext('2d');
  new ResizeObserver(resize).observe(canvas);
  setupCamera();
  setupMinimap();
  // The rendered art (renderer/assets/world): once loaded, the island is painted with it.
  loadSprites().then((ok) => {
    if (!ok) return logEvent('warn', 'inner world sprites unavailable', {});
    islandKey = '';
    if (currentView === 'world') draw();
  });
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
  $('#worldSettings').onclick = () => switchView('settings', 'world');
  $('#worldFit').onclick = () => (interior ? leave() : flyTo(home));
  $('#worldLeave').onclick = () => leave();
  $('#worldFollowStop').onclick = () => stopFollowing();
  $('#worldLapse').onclick = () => (lapse ? endLapse() : startLapse());
  const fps = $('#worldFps');
  fps.value = String(state.settings?.innerWorld?.fps || 'auto');
  fps.onchange = () => saveSettings({ innerWorld: { fps: fps.value } }).then(() => loop());
  on('settings', () => (fps.value = String(state.settings?.innerWorld?.fps || 'auto')));
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
      if (data?.details?.work) {
        data.details.work.today[ev.place] = (data.details.work.today[ev.place] || 0) + 1;
        sceneCache = null; // the count is painted on the building
      }
      if (currentView === 'world') (renderNow(), draw());
      return;
    }
    if (ev.type === 'rehearsal_turn') {
      stage.push(ev.line);
      if (stage.length > 8) stage.shift();
      if (currentView === 'world') (renderPanel(), draw());
      return;
    }
    if (ev.type === 'levelup') return celebrate(ev.places);
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
  if (data.levelups?.length) celebrate(data.levelups);
  clockLabel();
  renderHead();
  renderNow();
  renderPanel();
  resize();
  loop();
}

// ------------------------------------------------------------ level-ups and the timelapse
// A place gained a level since the village was last looked at: it glows and sparks for a while, the
// panel says so, and outside the view a toast does.
function celebrate(list) {
  if (!list?.length) return;
  celebration = { list, at: Date.now() };
  const names = list.map((l) => (l.from === 0 ? `${l.name} was built` : `${l.name} grew to ${l.stage}`));
  toast(`✨ ${names.join(' · ')}!`);
  if (currentView === 'world') (renderPanel(), loop());
}

const celebrating = () => Boolean(celebration && Date.now() - celebration.at < CELEBRATE_MS);

// What glows this frame: { placeId: strength 0..1 }.
function glowing() {
  if (lapse) return Object.fromEntries(lapse.replay.state.heat);
  if (!celebrating()) return null;
  const k = Math.min(1, (CELEBRATE_MS - (Date.now() - celebration.at)) / 2000);
  return Object.fromEntries(celebration.list.map((l) => [l.id, k]));
}

// The village's growth replayed day by day from the daily snapshots (main/innerworld.js track()).
function startLapse() {
  const steps = data?.timelapse || [];
  if (steps.length < 2) return toast('The timelapse needs a few days of history first: the village keeps one snapshot a day.');
  if (interior) leave({ fly: false });
  const replay = createReplay(steps);
  replay.seek(0);
  const bar = replayBar(replay, {
    noun: 'building',
    count: (s) => `${s.present.size} of ${data.places.length} places · ${[...s.lines.values()].reduce((a, b) => a + b, 0)} levels`,
    onChange: () => (lapse?.bar.update(), (sceneCache = null), loop()),
    onClose: endLapse,
  });
  lapse = { replay, bar };
  $('#worldTimeline').replaceChildren(bar);
  $('#worldLapse').classList.add('active');
  $('#worldLapse').setAttribute('aria-pressed', 'true');
  replay.play();
  bar.update();
  flyTo(home);
  loop();
}

function endLapse() {
  if (!lapse) return;
  lapse = null;
  $('#worldTimeline').replaceChildren();
  $('#worldLapse').classList.remove('active');
  $('#worldLapse').setAttribute('aria-pressed', 'false');
  P = null;
  sceneCache = null;
  draw();
}

const lapseLevel = (id) => (lapse.replay.state.present.has(id) ? lapse.replay.state.lines.get(id) || 0 : 0);

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
// The season: the real date on the user's half of the world, unless they chose one.
const season = () => seasonOf(lapse?.replay.current ? new Date(lapse.replay.current.at) : new Date(), { choice: state.settings?.innerWorld?.season || 'auto', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
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
  $('#worldLapse').classList.toggle('hidden', !ready || (data.timelapse?.length || 0) < 2);
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

// The data the picture depends on; when it changes, the island is painted again. Worked out once per
// data load (it is asked for every frame) and again when the interior, the palette or the art changes.
let sceneCache = null; // { data, interior, P, rendered, value, key }
function sceneData() {
  P ||= palette(season());
  const rendered = (state.settings?.innerWorld?.art || 'rendered') === 'rendered' && spritesReady();
  const c = sceneCache;
  const lapseAt = lapse ? lapse.replay.state.index : null;
  if (c && c.data === data && c.interior === interior && c.P === P && c.rendered === rendered && c.lapseAt === lapseAt) return c.value;
  const places = data.places.map((p) => ({ id: p.id, x: p.x, y: p.y, name: p.name, level: lapse ? lapseLevel(p.id) : p.level }));
  const key = places.map((p) => `${p.id}:${p.x}:${p.y}`).join('|');
  if (key !== mapKey) ((map = buildMap(places)), (mapKey = key), (routes = new Map()));
  const details = { ...data.details, residents: data.residents.map((r) => r.name), lastRehearsal: data.rehearsals?.[0]?.title || '' };
  // The village grows houses with everything else: two to start, then one per two levels across the places.
  const levels = places.reduce((n, p) => n + p.level, 0);
  const homes = Math.min(map.lots?.length || 0, 2 + Math.floor(levels / 2) + Math.max(0, data.residents.filter((r) => !r.npc).length - 1));
  // Which design each place has (some have two) is fixed per install, from the first persona's id.
  const seed = String(data.residents.find((r) => !r.npc)?.id || 'nexus');
  const designs = Object.fromEntries(places.map((p) => [p.id, [...(seed + p.id)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 2]));
  const value = { map, P, places, details, interior, rendered, homes, designs };
  value.key = JSON.stringify([places.map((p) => p.level), details, interior, P.key, rendered, homes, designs]);
  sceneCache = { data, interior, P, rendered, lapseAt, value };
  return value;
}

// The part of the island the camera sees, with a margin, at the camera's zoom (sharp when zoomed in).
// Bitmap budget for the cached island (pixels): big screens and deep zoom stay within it. Painting it
// takes a moment, so the budget is modest; the camera's margin takes the rest.
const BUDGET = () => (lite() ? 5e6 : 10e6);

function ensureIsland(force = false) {
  const d = sceneData();
  const key = d.key;
  const all = islandBounds();
  const tl = toWorld(cam, size.w, size.h, { x: 0, y: 0 });
  const br = toWorld(cam, size.w, size.h, { x: size.w, y: size.h });
  // What is on screen (never more than the island), with a margin for panning.
  const view = { minX: Math.max(all.minX, tl.x), minY: Math.max(all.minY, tl.y), maxX: Math.min(all.maxX, br.x), maxY: Math.min(all.maxY, br.y) };
  const inside = island && island.region.minX <= view.minX && island.region.minY <= view.minY && island.region.maxX >= view.maxX && island.region.maxY >= view.maxY;
  const want = Math.min(lite() ? 2 : 3, cam.z * size.dpr);
  // A picture within this range of the wanted sharpness is kept (a repaint per small zoom step stutters).
  const sharp = island && island.scale / want > 0.7 && island.scale / want < 1.5;
  if (!force && island && key === islandKey && inside && sharp) return;
  if (!force && island && key === islandKey) return scheduleRebuild();
  let margin = 0.4;
  let region;
  let scale = want;
  for (;;) {
    const mx = (view.maxX - view.minX) * margin;
    const my = (view.maxY - view.minY) * margin;
    region = { minX: Math.max(all.minX, view.minX - mx), minY: Math.max(all.minY, view.minY - my), maxX: Math.min(all.maxX, view.maxX + mx), maxY: Math.min(all.maxY, view.maxY + my) };
    const px = (region.maxX - region.minX) * (region.maxY - region.minY) * scale * scale;
    if (px <= BUDGET()) break;
    if (margin > 0.05) margin /= 2; // first give up panning room…
    else {
      scale *= Math.sqrt(BUDGET() / px) * 0.98; // …then sharpness
      break;
    }
  }
  const started = performance.now();
  const old = island;
  island = buildIsland(d, scale, region);
  releaseIsland(old);
  islandKey = key;
  logEvent('info', 'inner world painted', { w: island.canvas.width, h: island.canvas.height, mpx: Math.round((island.canvas.width * island.canvas.height) / 1e5) / 10, ms: Math.round(performance.now() - started), sharp: Math.round((scale / want) * 100) / 100 });
}

// The island's picture area in world pixels (from the island's bounds, see scene.bounds).
function islandBounds() {
  return islandBoundsCache || (islandBoundsCache = sceneBounds());
}
let islandBoundsCache = null;

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

// Only a built place has rooms to look into; an unbuilt one is a building site (its panel says what
// would build it).
const canEnter = (id) => Boolean(map?.sites[id] && placeById(id)?.level);

function enter(id) {
  const s = map?.sites[id];
  if (!s || !canEnter(id)) return;
  interior = id;
  islandKey = '';
  select({ type: 'place', id });
  const c = W(s.gx, s.gy, s.h * HZ + 12);
  flyTo({ x: c.x, y: c.y, z: home.z * INSIDE_ZOOM });
  $('#worldLeave').classList.remove('hidden');
}

/** Back outside: flies to the whole island, or (fly: false, after the user moved away) stays where it is. */
function leave({ fly = true } = {}) {
  if (!interior) return;
  interior = null;
  islandKey = '';
  $('#worldLeave').classList.add('hidden');
  renderPanel(); // its button turns back into "Step inside"
  if (fly) flyTo(home);
  else scheduleRebuild();
}

// Moving the camera away from the building (or zooming far out) while inside means leaving it.
function leftBuilding() {
  if (!interior || !cam) return false;
  const s = map?.sites[interior];
  if (!s) return true;
  const c = W(s.gx, s.gy, s.h * HZ + 12);
  const far = Math.hypot(cam.x - c.x, cam.y - c.y) * cam.z > Math.min(size.w, size.h) * 0.45;
  return far || cam.z < home.z * 1.6;
}

// ------------------------------------------------------------ camera controls
// Drag to pan (it glides on when you let go), two fingers or a trackpad pinch to zoom, the wheel to
// zoom around the pointer, arrow keys / WASD, + and − to zoom, 0 for the whole island, Esc to step out.
let glide = null; // { vx, vy } screen px per ms, slowing down
let follow = null; // a resident's name while the camera follows them

const clampZ = (z) => Math.max(home.z * 0.85, Math.min(home.z * 4.5, z));

/** Zoom by `factor` keeping the world point under screen point `s` in place. */
function zoomAt(s, factor) {
  if (!cam) return;
  const before = toWorld(cam, size.w, size.h, s);
  const z = clampZ(cam.z * factor);
  cam = { z, x: before.x - (s.x - size.w / 2) / z, y: before.y - (s.y - size.h / 2) / z };
  flight = null;
  if (leftBuilding()) leave({ fly: false });
  draw();
  scheduleRebuild();
}

function panBy(dx, dy) {
  if (!cam) return;
  cam = { ...cam, x: cam.x - dx / cam.z, y: cam.y - dy / cam.z };
  flight = null;
  stopFollowing();
  if (leftBuilding()) leave({ fly: false });
  draw();
  scheduleRebuild();
}

function setupCamera() {
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, local(e));
    canvas.setPointerCapture(e.pointerId);
    glide = null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, anchor: toWorld(cam, size.w, size.h, mid), z: cam.z };
      drag = null;
    } else drag = { start: local(e), last: local(e), cam: { ...cam }, moved: false, samples: [] };
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2 && cam) {
      const [a, b] = [...pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clampZ((pinch.z * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist);
      cam = { z, x: pinch.anchor.x - (mid.x - size.w / 2) / z, y: pinch.anchor.y - (mid.y - size.h / 2) / z };
      flight = null;
      stopFollowing();
      if (leftBuilding()) leave({ fly: false });
      draw();
      return;
    }
    if (drag && cam) {
      if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 4) drag.moved = true;
      if (drag.moved) {
        cam = { ...drag.cam, x: drag.cam.x - (p.x - drag.start.x) / cam.z, y: drag.cam.y - (p.y - drag.start.y) / cam.z };
        flight = null;
        stopFollowing();
        if (leftBuilding()) leave({ fly: false });
        drag.samples.push({ t: performance.now(), x: p.x, y: p.y });
        drag.samples = drag.samples.filter((s) => performance.now() - s.t < 90);
        canvas.style.cursor = 'grabbing';
        draw();
        return;
      }
    }
    const h = hit(e);
    canvas.title = h?.type === 'star' ? `${h.id} · ${h.state}${h.state === 'mastered' ? '' : ` · ${Math.round(h.progress * 100)}%`} (your skill tree)` : h?.type === 'place' ? (placeById(h.id)?.level ? 'Click for details · double-click to step inside' : 'Click for details (not built yet)') : h?.type === 'resident' ? `${h.id} · click for their day` : '';
    if (h?.id !== hover?.id) ((hover = h), draw());
    canvas.style.cursor = h ? 'pointer' : 'grab';
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) ((pinch = null), scheduleRebuild());
      return;
    }
    const was = drag;
    drag = null;
    canvas.style.cursor = 'grab';
    if (!was) return;
    if (was.moved) {
      // Let go while moving: glide on and slow down.
      const s = was.samples;
      if (s.length >= 2 && !document.body.classList.contains('fx-still')) {
        const dt = s[s.length - 1].t - s[0].t || 1;
        const vx = (s[s.length - 1].x - s[0].x) / dt;
        const vy = (s[s.length - 1].y - s[0].y) / dt;
        if (Math.hypot(vx, vy) > 0.15) ((glide = { vx, vy, at: performance.now() }), loop(true));
      }
      return scheduleRebuild();
    }
    if (e.type === 'pointercancel') return;
    const h = hit(e);
    if (h?.type === 'star') return switchView('tree');
    select(h);
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('dblclick', (e) => {
    const h = hit(e);
    if (h?.type !== 'place') return;
    if (canEnter(h.id)) enter(h.id);
    else select(h); // not built yet: the panel says what builds it
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // A trackpad pinch arrives as a wheel event with ctrlKey; mouse wheels and two-finger scrolls zoom smoothly.
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      glide = null;
      stopFollowing();
      zoomAt(local(e), Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0012)));
    },
    { passive: false },
  );
  document.addEventListener('keydown', (e) => {
    if (currentView !== 'world' || !cam || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.activeElement?.isContentEditable || document.querySelector('.modal:not(.hidden)')) return;
    const step = 70;
    const center = { x: size.w / 2, y: size.h / 2 };
    const keys = {
      ArrowLeft: () => panBy(step, 0), a: () => panBy(step, 0),
      ArrowRight: () => panBy(-step, 0), d: () => panBy(-step, 0),
      ArrowUp: () => panBy(0, step), w: () => panBy(0, step),
      ArrowDown: () => panBy(0, -step), s: () => panBy(0, -step),
      '+': () => zoomAt(center, 1.2), '=': () => zoomAt(center, 1.2),
      '-': () => zoomAt(center, 1 / 1.2),
      0: () => (interior ? leave() : flyTo(home)),
      Escape: () => (lapse ? endLapse() : follow ? stopFollowing() : interior ? leave() : selected ? select(null) : null),
      ' ': () => lapse && document.activeElement?.tagName !== 'BUTTON' && (lapse.replay.state.playing ? lapse.replay.pause() : lapse.replay.play(), lapse.bar.update(), loop()),
    };
    const fn = keys[e.key];
    if (!fn) return;
    e.preventDefault();
    fn();
  });
}

// Each frame: glide on after a drag, and keep a followed resident in view.
function moveCamera(people) {
  if (glide && cam) {
    const now = performance.now();
    const dt = Math.min(50, now - glide.at);
    glide.at = now;
    cam = { ...cam, x: cam.x - (glide.vx * dt) / cam.z, y: cam.y - (glide.vy * dt) / cam.z };
    const decay = Math.exp(-dt / 260);
    glide.vx *= decay;
    glide.vy *= decay;
    if (Math.hypot(glide.vx, glide.vy) < 0.02) ((glide = null), scheduleRebuild());
  }
  if (follow && cam && !flight) {
    const p = people.find((x) => x.name === follow);
    if (!p) return stopFollowing();
    const k = 0.12;
    cam = { ...cam, x: cam.x + (p.x - cam.x) * k, y: cam.y + (p.y - 20 - cam.y) * k };
    if (Math.hypot(p.x - cam.x, p.y - 20 - cam.y) > 4) scheduleRebuild();
  }
}

function followResident(name) {
  follow = name;
  glide = null;
  if (cam.z < home.z * 2.2) flyTo({ ...cam, z: home.z * 2.4 });
  $('#worldFollow').classList.remove('hidden');
  $('#worldFollowName').textContent = name;
  loop(true);
}

function stopFollowing() {
  if (!follow) return;
  follow = null;
  $('#worldFollow').classList.add('hidden');
}

// ------------------------------------------------------------ minimap
// The whole island in the corner, the camera's view drawn on it; click or drag to go there.
let mini = null; // { canvas, key, b (world bounds), k (scale) }

function setupMinimap() {
  const box = $('#worldMini');
  let down = false;
  const go = (e) => {
    if (!mini || !cam) return;
    const r = box.getBoundingClientRect();
    const x = (e.clientX - r.left) / mini.k + mini.b.minX;
    const y = (e.clientY - r.top) / mini.k + mini.b.minY;
    cam = { ...cam, x, y };
    flight = null;
    glide = null;
    stopFollowing();
    draw();
    scheduleRebuild();
  };
  box.addEventListener('pointerdown', (e) => ((down = true), box.setPointerCapture(e.pointerId), go(e)));
  box.addEventListener('pointermove', (e) => down && go(e));
  box.addEventListener('pointerup', () => (down = false));
}

function drawMinimap() {
  const box = $('#worldMini');
  if (!box || !map || !P || !data?.enabled || size.w < 520) return box?.classList.add('hidden');
  box.classList.remove('hidden');
  const W0 = 176;
  const H0 = 112;
  const dpr = size.dpr;
  const key = `${mapKey}|${P.key}|${data.places.map((p) => p.level).join()}`;
  if (mini?.key !== key) {
    // World bounds of the island's tiles.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < map.N; y++) {
      for (let x = 0; x < map.N; x++) {
        if (!map.tile(x, y)) continue;
        const p = W(x + 0.5, y + 0.5, map.hgt(x, y) * HZ);
        minX = Math.min(minX, p.x - 24);
        maxX = Math.max(maxX, p.x + 24);
        minY = Math.min(minY, p.y - 40);
        maxY = Math.max(maxY, p.y + 20);
      }
    }
    const k = Math.min(W0 / (maxX - minX), H0 / (maxY - minY));
    const cv = document.createElement('canvas');
    cv.width = Math.round(W0 * dpr);
    cv.height = Math.round(H0 * dpr);
    const c = cv.getContext('2d');
    c.setTransform(dpr * k, 0, 0, dpr * k, -minX * k * dpr + ((W0 - (maxX - minX) * k) / 2) * dpr, -minY * k * dpr + ((H0 - (maxY - minY) * k) / 2) * dpr);
    const colors = { 1: P.grass, 2: P.dirt, 3: P.cobble, 4: P.water, 5: P.sand, 6: P.cobble, 7: P.crop, 8: P.wood };
    for (let y = 0; y < map.N; y++) {
      for (let x = 0; x < map.N; x++) {
        const t = map.tile(x, y);
        if (!t) continue;
        const z = map.hgt(x, y) * HZ;
        c.beginPath();
        for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
          const p = W(x + dx, y + dy, z);
          c.lineTo(p.x, p.y);
        }
        c.closePath();
        c.fillStyle = `rgb(${colors[t].join(',')})`;
        c.fill();
        c.strokeStyle = c.fillStyle;
        c.lineWidth = 1 / k;
        c.stroke();
      }
    }
    for (const p of data.places) {
      const s = map.sites[p.id];
      if (!s) continue;
      const q = W(s.gx, s.gy, s.h * HZ);
      c.beginPath();
      c.arc(q.x, q.y - 8, (p.level ? 5 + p.level * 1.5 : 4) / k / 3, 0, Math.PI * 2);
      c.fillStyle = p.level ? `rgb(${P.roof.join(',')})` : 'rgba(255, 255, 255, 0.5)';
      c.fill();
      c.strokeStyle = 'rgba(30, 24, 20, 0.8)';
      c.lineWidth = 1.5 / k;
      c.stroke();
    }
    const offX = (W0 - (maxX - minX) * k) / 2;
    const offY = (H0 - (maxY - minY) * k) / 2;
    mini = { canvas: cv, key, k, b: { minX: minX - offX / k, minY: minY - offY / k } };
  }
  if (box.width !== Math.round(W0 * dpr)) ((box.width = Math.round(W0 * dpr)), (box.height = Math.round(H0 * dpr)));
  const c = box.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W0, H0);
  c.drawImage(mini.canvas, 0, 0, W0, H0);
  // The camera's view.
  const tl = toWorld(cam, size.w, size.h, { x: 0, y: 0 });
  const br = toWorld(cam, size.w, size.h, { x: size.w, y: size.h });
  const x0 = (tl.x - mini.b.minX) * mini.k;
  const y0 = (tl.y - mini.b.minY) * mini.k;
  c.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  c.lineWidth = 1.5;
  c.strokeRect(x0, y0, (br.x - tl.x) * mini.k, (br.y - tl.y) * mini.k);
  c.fillStyle = 'rgba(255, 255, 255, 0.08)';
  c.fillRect(x0, y0, (br.x - tl.x) * mini.k, (br.y - tl.y) * mini.k);
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
  return { x: s.gx + s.a + 0.7 + (j % 2) * 0.55, y: s.gy + s.b * 0.45 - Math.floor(j / 2) * 0.62 };
}

const groundZ = (g) => map.hgt(Math.floor(g.x), Math.floor(g.y)) * HZ;

// The road from one place to another, found once per pair (it is asked for every frame while someone
// walks it); emptied when the island is laid out again.
let routes = new Map();
function routeBetween(from, to) {
  const key = `${from}>${to}`;
  let path = routes.get(key);
  if (!path) routes.set(key, (path = route(map, from, to)));
  return path;
}

const colorOf = (r, i) => {
  P ||= palette(season()); // the side panel can ask before the first draw
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
      const path = routeBetween(p.from, p.place);
      g = path.length ? along([spot(p.from, 0), ...path, g], p.k) : g;
    }
    const wp = W(g.x, g.y, groundZ(g));
    Object.assign(p, { x: wp.x, y: wp.y, walking: Boolean(p.from), color: colorOf(p.r, p.i), kind: p.r === me ? 'active' : p.r.npc ? 'npc' : 'persona' });
  }
  return out;
}

// ------------------------------------------------------------ drawing
let lastDrawAt = 0;
// The timelapse playing (or a building still warm from it) and a fresh level-up need frames even
// without the village's own animation.
// The village's frame time: the user's choice (innerWorld.fps), or 30 a second (15 on Balanced).
const frameMs = () => {
  const fps = Number(state.settings?.innerWorld?.fps);
  return [15, 30, 60, 120].includes(fps) ? 1000 / fps : lite() ? 66 : 33;
};
const busyGlowing = () => Boolean((lapse && (lapse.replay.state.playing || lapse.replay.state.heat.size)) || celebrating());
function loop(once = false) {
  cancelAnimationFrame(frameId);
  if (currentView !== 'world' || document.hidden) return;
  const step = (now = performance.now()) => {
    if (currentView !== 'world' || document.hidden) return;
    // Camera motion runs at the display's rate; the village's own animation at the chosen frame rate
    // (innerWorld.fps; automatic: 30, or 15 on Balanced), on the display's own beat: frames are skipped, never put off with a timer,
    // so each one lands on a vertical sync instead of between two.
    const moving = flight || glide || follow;
    const every = frameMs();
    if (!moving && now - lastDrawAt < every - 4) {
      frameId = requestAnimationFrame(step);
      return;
    }
    const dt = Math.min(100, now - (lastStep || now));
    lastStep = now;
    lastDrawAt = now;
    if (lapse && lapse.replay.tick(dt)) lapse.bar.update();
    if (flight) {
      const k = Math.min(1, (now - flight.start) / 650);
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
    if (flight || glide || follow || animated() || busyGlowing()) frameId = requestAnimationFrame(step);
    else lastStep = 0;
  };
  if (once || animated() || flight || glide || follow || busyGlowing()) step();
  else draw();
}

function draw() {
  if (!ctx || !size.w || !data?.places) return;
  if (!cam) cam = { ...home };
  if (P && P.season !== season()) P = null; // a new season (or the setting changed): repaint
  const m = at();
  const people = positions(m).filter((p) => !p.asleep);
  moveCamera(people);
  ensureIsland();
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
    celebrate: glowing(),
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
  drawMinimap();
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
  if (celebrating()) {
    out.push(el('div', { class: 'world-levelup', role: 'status' }, ...celebration.list.map((l) => el('div', {}, `✨ ${l.from === 0 ? `${l.name} was built` : `${l.name} grew: it is ${l.stage} now`}`))));
  }
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
  // Every building, reachable without the canvas (keyboard, screen readers).
  out.push(
    el(
      'div',
      { class: 'world-sec' },
      el('b', {}, 'Places'),
      ...data.places.map((p) =>
        el(
          'button',
          { class: 'world-res world-place', onclick: () => select({ type: 'place', id: p.id }), 'aria-label': `${p.name}, ${p.stage}${p.level ? `, level ${p.level} of 3` : ''}` },
          el('span', { class: 'icon', 'aria-hidden': 'true' }, p.icon),
          el('span', { class: 'name' }, p.name),
          el('span', { class: 'hint' }, p.level ? `level ${p.level} of 3 · ${p.hint}` : p.hint),
        ),
      ),
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
      interior === p.id ? el('button', { class: 'btn', onclick: () => leave() }, '← Step outside') : p.level ? el('button', { class: 'btn primary', onclick: () => enter(p.id) }, '🚪 Step inside') : el('span', { class: 'hint' }, 'Not built yet: nothing to step into.'),
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
      el('button', { class: 'btn small primary', onclick: () => followResident(r.name) }, '👁 Follow'),
      el('button', { class: 'btn small', onclick: () => ask(info.active ? 'What did you do today in the Inner World?' : `What has ${r.name} been up to in the Inner World lately?`) }, 'Ask about their day'),
      el('button', { class: 'btn small', onclick: () => api.obsidian.openInObsidian(r.note).catch(toastError) }, 'Their memories in the vault'),
    ),
  );
}
