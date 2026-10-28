// Stepping inside a building (Inner World → a place → 🚪 Step inside): the room from above, drawn by
// the pure world/room.js on its own canvas over the island (#worldRoom), with the residents who are
// there now walking between the stations, and your data as the furniture. innerworld.js opens and
// closes it and lends it what it knows (the palette, the data, who is where, the clock); clicks go
// back to it (a resident's day) or to the Documents view (a paper stack is a document you opened).
import { $, el } from './util.js';
import { openDocument } from './docs.js';
import { layout, createSim, draw, pick, transform } from './world/room.js';

let src = null; // { palette, data, people, minute, frameMs, place, showResident }
let open = null; // { id, sim, layout, actors, hover, level, name, icon, tip }
let canvas;
let ctx;
let size = { w: 0, h: 0, dpr: 1 };
let frameId = 0;
let last = 0;
let lastDraw = 0;
const sims = new Map(); // one simulation per place, kept while the view lives (figures stay where they were)

export function initRoom(source) {
  src = source;
  canvas = $('#worldRoomCanvas');
  ctx = canvas.getContext('2d');
  new ResizeObserver(() => open && (resize(), render())).observe(canvas);
  $('#worldRoomLeave').onclick = () => src.leave();
  canvas.addEventListener('pointermove', (e) => {
    if (!open) return;
    const hit = pick(size.w, size.h, open.layout.stations, open.actors, e.offsetX, e.offsetY);
    open.hover = hit;
    canvas.style.cursor = hit ? 'pointer' : 'default';
    tip(hit, e.offsetX, e.offsetY);
  });
  canvas.addEventListener('pointerleave', () => open && ((open.hover = null), tip(null)));
  canvas.addEventListener('click', (e) => {
    if (!open) return;
    const hit = pick(size.w, size.h, open.layout.stations, open.actors, e.offsetX, e.offsetY);
    if (!hit) return;
    if (hit.type === 'actor') return src.showResident(hit.actor.name);
    if (hit.station.doc?.path) return openDocument(hit.station.doc.path);
    tip(hit, e.offsetX, e.offsetY, true);
  });
  document.addEventListener('visibilitychange', () => open && !document.hidden && loop());
}

export const roomOpen = () => (open ? open.id : null);

/** Opens the room of place `id` (a place object from the view data). */
export function openRoom(place) {
  if (!src || !place) return;
  const d = src.data();
  const sim = sims.get(place.id) || createSim();
  sims.set(place.id, sim);
  open = { id: place.id, sim, layout: layout(place.id, place.level, roomData(d)), actors: [], hover: null, level: place.level, name: place.name, icon: place.icon };
  $('#worldRoom').classList.remove('hidden');
  $('#worldRoomTitle').textContent = `${place.icon} ${place.name}`;
  $('#worldRoomSub').textContent = `level ${place.level} of 3 · ${open.layout.stations.filter((s) => s.label).length} things to look at`;
  resize();
  last = 0;
  loop();
}

export function closeRoom() {
  if (!open) return;
  open = null;
  cancelAnimationFrame(frameId);
  $('#worldRoom').classList.add('hidden');
  tip(null);
}

/** The data changed (a refresh, live work): the furniture is laid out again, the figures stay. */
export function refreshRoom() {
  if (!open) return;
  const place = src.place(open.id);
  if (!place) return closeRoom();
  open.layout = layout(open.id, place.level, roomData(src.data()));
  open.level = place.level;
  render();
}

function roomData(d) {
  return { details: d?.details, residents: d?.residents || [], docs: d?.docs || [], rehearsals: d?.rehearsals || [], scenes: d?.day?.scenes || [] };
}

function resize() {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  size = { w: r.width, h: r.height, dpr: Math.min(window.devicePixelRatio || 1, document.body.classList.contains('perf-lite') ? 1 : 2) };
  canvas.width = Math.round(r.width * size.dpr);
  canvas.height = Math.round(r.height * size.dpr);
}

const animated = () => !document.body.classList.contains('fx-still') && !matchMedia('(prefers-reduced-motion: reduce)').matches;

function loop() {
  cancelAnimationFrame(frameId);
  if (!open || document.hidden) return;
  const step = (now) => {
    if (!open || document.hidden) return;
    frameId = requestAnimationFrame(step);
    if (now - lastDraw < src.frameMs() - 4) return;
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
    last = now;
    lastDraw = now;
    render(dt, now / 1000);
  };
  frameId = requestAnimationFrame(step);
}

function render(dt = 0, t = performance.now() / 1000) {
  if (!open || !ctx || !size.w) return;
  const m = src.minute();
  const here = src.people(m).filter((p) => p.place === open.id);
  open.actors = open.sim.update(here.map((p) => ({ name: p.name, color: p.color, active: p.kind === 'active', kind: p.kind, activity: p.activity, working: p.working, thinking: p.thinking, asleep: p.asleep })), open.layout.stations, animated() ? dt : 0, t);
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  draw(ctx, { w: size.w, h: size.h, P: src.palette(), t, place: open.id, level: open.level, name: open.name, stations: open.layout.stations, actors: open.actors, floor: open.layout.floor, open: open.layout.open, night: m < 6 * 60 || m >= 20 * 60, anim: animated(), lite: document.body.classList.contains('perf-lite'), hover: open.hover });
  $('#worldRoomEmpty').classList.toggle('hidden', here.length > 0);
}

// A small card near the pointer: what a station holds of you, or what a resident is doing.
function tip(hit, x = 0, y = 0, pinned = false) {
  const box = $('#worldRoomTip');
  if (!hit) return box.classList.add('hidden');
  const text = hit.type === 'actor' ? `${hit.actor.name}: ${hit.actor.activity || 'here'}${hit.actor.working ? ' (right now)' : ''}` : hit.station.info || hit.station.label;
  if (!text) return box.classList.add('hidden');
  box.replaceChildren(el('b', {}, hit.type === 'actor' ? hit.actor.name : hit.station.label || hit.station.kind), el('div', {}, text), hit.type === 'station' && hit.station.doc ? el('div', { class: 'hint' }, 'Click to open it') : hit.type === 'actor' ? el('div', { class: 'hint' }, 'Click for their day') : '');
  box.classList.remove('hidden');
  const { k, ox } = transform(size.w, size.h);
  const left = Math.min(size.w - 260, Math.max(8, x + 14));
  const top = y > size.h / 2 ? Math.max(8, y - 90) : y + 16;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.classList.toggle('pinned', pinned);
  void k;
  void ox;
}
