// Inner World view: the personas' village (main/innerworld.js, rules in main/worldcore.js) on a canvas.
// Buildings are drawn by their level (they grow with the user's real progress), residents walk between
// places along today's plan in real time, and while a scene is happening its people gather and talk in
// speech bubbles. The clock slider replays the day. The side panel tells today: scenes, residents, the
// Stage's rehearsals; click a building or a resident for theirs. Colors are theme tokens; a persona's
// own accent comes from its saved theme.
import { $, api, el, toast, toastError, on, promptDialog } from './util.js';
import { switchView, currentView } from './nav.js';
import { send } from './chat.js';
import { saveSettings } from './state.js';
import { fxLevel } from './hud.js';

const PLACE_TONES = { garden: 'ok', hearth: 'warn', library: 'c1', cafe: 'c3', grounds: 'ok', observatory: 'c2', archive: 'c1', stage: 'c3' };
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

let data = null;
let canvas;
let ctx;
let size = { w: 0, h: 0 };
let colors = {};
let selected = null; // { type: 'place' | 'resident', id }
let hover = null;
let scrub = null; // minutes since midnight while the slider is held away from "live"
let frame = 0;
let tick = 0;
const stage = []; // live lines from a rehearsal running now

export function initInnerWorld() {
  canvas = $('#worldCanvas');
  ctx = canvas.getContext('2d');
  new ResizeObserver(resize).observe(canvas);
  canvas.addEventListener('mousemove', (e) => {
    const h = hit(e);
    if (h?.id !== hover?.id) (hover = h), draw();
    canvas.style.cursor = h ? 'pointer' : 'default';
  });
  canvas.addEventListener('mouseleave', () => ((hover = null), draw()));
  canvas.addEventListener('click', (e) => select(hit(e)));
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
  on('world-changed', refresh);
  on('settings', () => currentView === 'world' && refresh());
  api.on('world:event', (ev) => {
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
  setInterval(() => currentView === 'world' && !document.hidden && !animated() && draw(), 60000);
}

export async function refresh() {
  try {
    data = await api.world.view();
  } catch (err) {
    data = null;
    toastError(err);
    return;
  }
  readColors();
  clockLabel();
  renderHead();
  renderPanel();
  resize();
  loop();
}

const animated = () => fxLevel() === 'hud' && !document.body.classList.contains('fx-still');
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

// ------------------------------------------------------------ head and clock
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
  const live = scrub === null;
  if (live) $('#worldClock').value = nowMinutes();
  $('#worldTime').textContent = `${hhmm(at())}${live ? ' · live' : ''}`;
  $('#worldLive').classList.toggle('hidden', live);
}

// ------------------------------------------------------------ colors
function readColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  colors = { c1: v('--c1', '0, 229, 255'), c2: v('--c2', '180, 90, 255'), c3: v('--c3', '255, 60, 172'), ok: v('--ok', '60, 255, 160'), warn: v('--warn', '255, 190, 60'), text: v('--text-rgb', '217, 244, 255'), bg: v('--bg-rgb', '10, 10, 15'), display: v('--font-display', 'sans-serif'), body: v('--font-body', 'sans-serif') };
}
const rgba = (tone, a) => `rgba(${colors[tone] || tone}, ${a})`;
const hexRgb = (hex) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : null;
};
// A resident's color: their persona's accent, or a theme accent by their place in the list.
const TONES = ['c2', 'c3', 'ok', 'warn'];
function residentRgb(r, i) {
  return hexRgb(r.color) || colors[TONES[i % 4]];
}

// ------------------------------------------------------------ geometry
function resize() {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = window.devicePixelRatio || 1;
  size = { w: r.width, h: r.height };
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function project(p) {
  const pad = { x: Math.max(70, size.w * 0.08), y: 64 };
  return { x: pad.x + p.x * (size.w - pad.x * 2), y: pad.y + p.y * (size.h - pad.y * 2) };
}
const placeById = (id) => data?.places.find((p) => p.id === id);
const scale = () => Math.max(0.7, Math.min(1.25, Math.min(size.w / 900, size.h / 620)));

// The scene happening at this minute, if any.
function sceneAt(m) {
  return (data?.day?.scenes || []).find((s) => {
    const t = minutes(s.time);
    return t !== null && m >= t && m < t + SCENE_MIN;
  });
}

// Where everyone is at minute m: in a scene, walking, or at the place of their current plan block.
function positions(m) {
  const out = new Map();
  if (!data?.day) return out;
  const scene = sceneAt(m);
  const crowd = new Map(); // place → residents there
  data.residents.forEach((r, i) => {
    let place = 'hearth';
    let activity = 'asleep';
    let from = null;
    let t = 1;
    if (scene && scene.who.includes(r.name)) {
      place = scene.place;
      activity = scene.title || 'talking';
    } else if (m >= 6 * 60 && m < 23 * 60 && r.plan?.length) {
      const blocks = r.plan.filter((b) => minutes(b.start) !== null);
      let k = -1;
      blocks.forEach((b, j) => minutes(b.start) <= m && (k = j));
      if (k >= 0) {
        place = blocks[k].place;
        activity = blocks[k].activity;
        const since = m - minutes(blocks[k].start);
        const prev = k > 0 ? blocks[k - 1].place : 'hearth';
        if (since < WALK_MIN && prev !== place) (from = prev), (t = since / WALK_MIN);
      }
    }
    (crowd.get(place) || crowd.set(place, []).get(place)).push(r.name);
    out.set(r.name, { place, activity, from, t, i, r });
  });
  // Spread the people at one place around it.
  for (const [place, names] of crowd) {
    const c = placeById(place);
    if (!c) continue;
    const s = scale();
    names.forEach((name, j) => {
      const p = out.get(name);
      const a = (j / Math.max(1, names.length)) * Math.PI * 2 + 0.6;
      const ring = names.length > 1 ? 18 * s : 0;
      const target = project(c);
      let x = target.x + (58 + c.level * 6) * s + Math.cos(a) * ring;
      let y = target.y - 8 * s + Math.sin(a) * ring;
      if (p.from && placeById(p.from)) {
        const f = project(placeById(p.from));
        const e = p.t * p.t * (3 - 2 * p.t);
        x = f.x + (x - f.x) * e;
        y = f.y + (y - f.y) * e;
      }
      Object.assign(p, { x, y });
    });
  }
  return out;
}

// ------------------------------------------------------------ drawing
function loop() {
  cancelAnimationFrame(frame);
  if (currentView !== 'world' || document.hidden || !animated()) return draw();
  const step = () => {
    tick = performance.now();
    draw();
    if (currentView === 'world' && !document.hidden && animated()) frame = requestAnimationFrame(() => setTimeout(step, 33));
  };
  step();
}

function draw() {
  if (!ctx || !size.w) return;
  ctx.clearRect(0, 0, size.w, size.h);
  if (!data?.places) return;
  const m = at();
  sky(m);
  const s = scale();
  // Paths: from the Garden to every place, and around the ring.
  const garden = project(placeById('garden'));
  for (const p of data.places) {
    if (p.id === 'garden') continue;
    const q = project(p);
    ctx.beginPath();
    ctx.moveTo(garden.x, garden.y);
    ctx.lineTo(q.x, q.y);
    const lit = p.level > 0;
    ctx.strokeStyle = lit ? rgba(PLACE_TONES[p.id], 0.28) : rgba('text', 0.08);
    ctx.lineWidth = lit ? 2 : 1;
    ctx.setLineDash(lit ? [] : [4, 6]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const p of data.places) building(p, s);
  const pos = positions(m);
  const scene = sceneAt(m);
  for (const p of pos.values()) resident(p, s);
  if (scene) bubble(scene, m, s);
  else if (stage.length) bubble({ place: 'stage', lines: stage.slice(-1), live: true }, m, s);
}

// Night darkens the village; dawn and dusk tint it.
function sky(m) {
  const h = m / 60;
  const night = h < 6 || h >= 21 ? 1 : h < 8 ? (8 - h) / 2 : h > 19 ? (h - 19) / 2 : 0;
  const g = ctx.createRadialGradient(size.w / 2, size.h / 2, 40, size.w / 2, size.h / 2, Math.max(size.w, size.h) * 0.7);
  g.addColorStop(0, rgba('c1', 0.05 * (1 - night)));
  g.addColorStop(1, rgba('bg', 0.15 + night * 0.4));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size.w, size.h);
  if ((h > 5.5 && h < 8) || (h > 18.5 && h < 21)) {
    ctx.fillStyle = rgba('c3', 0.04);
    ctx.fillRect(0, 0, size.w, size.h);
  }
  // Stars at night, fixed so they don't flicker on redraws.
  if (night > 0.3) {
    for (let i = 0; i < 40; i++) {
      const x = ((i * 9301 + 49297) % 233280) / 233280;
      const y = ((i * 4271 + 1993) % 98765) / 98765;
      ctx.fillStyle = rgba('text', 0.25 * night * (0.5 + (i % 3) / 4));
      ctx.fillRect(x * size.w, y * size.h * 0.6, 1.5, 1.5);
    }
  }
}

function building(p, s) {
  const { x, y } = project(p);
  const tone = PLACE_TONES[p.id];
  const focus = hover?.id === p.id || (selected?.type === 'place' && selected.id === p.id);
  const w = (40 + p.level * 12) * s;
  const h = (14 + p.level * 12) * s;
  ctx.save();
  // Plinth.
  ctx.beginPath();
  ctx.ellipse(x, y + 6 * s, w * 0.85, 12 * s, 0, 0, Math.PI * 2);
  ctx.fillStyle = rgba(tone, focus ? 0.16 : 0.08);
  ctx.fill();
  ctx.strokeStyle = rgba(tone, focus ? 0.7 : 0.3);
  ctx.lineWidth = 1;
  ctx.stroke();
  if (p.level === 0) {
    // A foundation: dashed outline, waiting.
    ctx.setLineDash([3, 4]);
    ctx.strokeRect(x - w / 2, y - 18 * s, w, 18 * s);
    ctx.setLineDash([]);
  } else {
    // A block with a roof; taller per level; the top level carries a beacon.
    const glow = p.level >= 3 && animated() ? 0.5 + 0.5 * Math.sin(tick / 700 + p.x * 9) : 0.6;
    ctx.fillStyle = rgba(tone, 0.14 + p.level * 0.05);
    ctx.strokeStyle = rgba(tone, 0.85);
    ctx.lineWidth = 1.4;
    ctx.fillRect(x - w / 2, y - h, w, h);
    ctx.strokeRect(x - w / 2, y - h, w, h);
    ctx.beginPath();
    ctx.moveTo(x - w / 2 - 4 * s, y - h);
    ctx.lineTo(x, y - h - 16 * s - p.level * 3 * s);
    ctx.lineTo(x + w / 2 + 4 * s, y - h);
    ctx.closePath();
    ctx.fillStyle = rgba(tone, 0.28);
    ctx.fill();
    ctx.stroke();
    // Lit windows, more with each level.
    for (let i = 0; i < p.level * 2; i++) {
      ctx.fillStyle = rgba('warn', 0.35 + 0.3 * ((i + Math.floor(tick / 2000)) % 3 === 0 && animated() ? 1 : 0.5));
      ctx.fillRect(x - w / 2 + 7 * s + (i % 4) * 10 * s, y - h + 6 * s + Math.floor(i / 4) * 10 * s, 5 * s, 5 * s);
    }
    if (p.level >= 3) {
      const top = y - h - 16 * s - p.level * 3 * s;
      ctx.beginPath();
      ctx.arc(x, top - 5 * s, 4 * s, 0, Math.PI * 2);
      ctx.fillStyle = rgba(tone, 0.9);
      ctx.shadowColor = rgba(tone, 0.9);
      ctx.shadowBlur = document.body.classList.contains('perf-lite') ? 0 : 14 * glow;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
  // Icon, name, level pips.
  ctx.font = `${Math.round(18 * s)}px ${colors.body}`;
  ctx.textAlign = 'center';
  ctx.globalAlpha = p.level === 0 ? 0.5 : 1;
  ctx.fillText(p.icon, x, y - h - (p.level ? 26 : 10) * s - p.level * 3 * s);
  ctx.globalAlpha = 1;
  ctx.font = `600 ${Math.round(12 * s)}px ${colors.display}`;
  ctx.fillStyle = rgba('text', focus ? 0.95 : p.level ? 0.75 : 0.4);
  ctx.fillText(p.name, x, y + 28 * s);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x - 8 * s + i * 8 * s, y + 38 * s, 2.4 * s, 0, Math.PI * 2);
    ctx.fillStyle = i < p.level ? rgba(tone, 0.9) : rgba('text', 0.15);
    ctx.fill();
  }
  ctx.restore();
}

function resident(p, s) {
  const rgb = residentRgb(p.r, p.i);
  const focus = hover?.id === p.r.name || (selected?.type === 'resident' && selected.id === p.r.name);
  const bob = animated() && !p.from ? Math.sin(tick / 500 + p.i * 1.7) * 1.5 : 0;
  const x = p.x;
  const y = p.y + bob;
  const r = (p.r.active ? 10 : 8.5) * s;
  ctx.save();
  if (p.from) {
    // Footsteps behind someone walking.
    ctx.fillStyle = rgba(rgb, 0.25);
    const f = project(placeById(p.from));
    for (let k = 1; k <= 3; k++) ctx.fillRect(x + (f.x - x) * k * 0.06 - 1, y + (f.y - y) * k * 0.06 - 1, 2, 2);
  }
  ctx.beginPath();
  ctx.arc(x, y, r + (focus ? 5 : 3), 0, Math.PI * 2);
  ctx.fillStyle = rgba(rgb, focus ? 0.3 : 0.15);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = rgba(rgb, p.activity === 'asleep' ? 0.35 : 0.9);
  ctx.fill();
  ctx.strokeStyle = rgba('text', p.r.active ? 0.9 : 0.4);
  ctx.lineWidth = p.r.active ? 1.6 : 1;
  ctx.stroke();
  ctx.font = `700 ${Math.round(10 * s)}px ${colors.display}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = rgba('bg', 0.9);
  ctx.fillText(p.r.name[0].toUpperCase(), x, y + 3.5 * s);
  if (p.activity === 'asleep') {
    ctx.fillStyle = rgba('text', 0.5);
    ctx.font = `${Math.round(9 * s)}px ${colors.body}`;
    ctx.fillText('z', x + r + 3, y - r);
  }
  if (focus || size.w > 900) {
    ctx.font = `${Math.round(10.5 * s)}px ${colors.body}`;
    ctx.fillStyle = rgba('text', focus ? 0.95 : 0.6);
    ctx.fillText(p.r.name, x, y + r + 12 * s);
  }
  ctx.restore();
}

// The line being said now: scenes play their lines across their time on the map.
function bubble(scene, m, s) {
  const c = placeById(scene.place);
  if (!c || !scene.lines?.length) return;
  const t = minutes(scene.time);
  const idx = scene.live ? 0 : Math.min(scene.lines.length - 1, Math.floor(((m - t) / SCENE_MIN) * scene.lines.length));
  const line = scene.lines[idx];
  const { x, y } = project(c);
  const maxW = Math.min(300, size.w * 0.4);
  ctx.save();
  ctx.font = `${Math.round(12.5 * s)}px ${colors.body}`;
  const words = `${line.who}: ${line.text}`.split(' ');
  const rows = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW - 20 && cur) (rows.push(cur), (cur = w));
    else cur = next;
  }
  if (cur) rows.push(cur);
  const shown = rows.slice(0, 4);
  if (rows.length > 4) shown[3] = `${shown[3].replace(/\s*\S*$/, '')} …`;
  const lh = 16 * s;
  const bw = Math.min(maxW, Math.max(...shown.map((r) => ctx.measureText(r).width)) + 20);
  const bh = shown.length * lh + 14;
  let bx = x - bw / 2;
  const by = Math.max(6, y - 110 * s - bh);
  bx = Math.max(6, Math.min(size.w - bw - 6, bx));
  ctx.fillStyle = rgba('bg', 0.88);
  ctx.strokeStyle = rgba(scene.live ? 'c3' : 'c1', 0.6);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 10);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 6, by + bh);
  ctx.lineTo(x, by + bh + 9);
  ctx.lineTo(x + 6, by + bh);
  ctx.fill();
  ctx.fillStyle = rgba('text', 0.92);
  ctx.textAlign = 'left';
  shown.forEach((r, i) => ctx.fillText(r, bx + 10, by + 7 + lh * (i + 0.8)));
  ctx.restore();
}

// ------------------------------------------------------------ interaction
function hit(e) {
  if (!data?.places) return null;
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  for (const p of positions(at()).values()) {
    if (Math.hypot(mx - p.x, my - p.y) < 14) return { type: 'resident', id: p.r.name };
  }
  for (const p of data.places) {
    const q = project(p);
    if (Math.abs(mx - q.x) < 50 && my > q.y - 80 && my < q.y + 45) return { type: 'place', id: p.id };
  }
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
    el('p', {}, 'The buildings grow with your real progress: the Library with what you come to understand, the Café with your vocabulary, the Training Grounds with your habit streaks, the Observatory with mastered skills. Rehearsals for real conversations play on the Stage.'),
    el('p', { class: 'hint' }, 'It costs one model call a day (plus an occasional one when a resident reflects). Everything stays in your vault under “Inner World/”. Your assistant talks about it only when you ask.'),
    el('button', { class: 'btn primary', onclick: wake }, '🌅 Wake the world'),
  ];
}

function sceneCard(s) {
  const name = placeById(s.place)?.name || s.place;
  const card = el(
    'div',
    { class: 'world-scene', title: 'Watch it on the map', onclick: () => ((scrub = minutes(s.time) + 1), ($('#worldClock').value = scrub), clockLabel(), draw()) },
    el('div', { class: 'hint' }, `${s.time} · ${name}`),
    el('b', {}, s.title || 'A moment'),
    ...s.lines.map((l) => el('div', { class: 'world-line', style: lineStyle(l.who) }, el('span', { class: 'who' }, l.who), ` ${l.text}`)),
    s.outcome ? el('div', { class: 'world-outcome' }, s.outcome) : '',
  );
  return card;
}

// A speaker's color on a line: their persona's accent (validated hex from the main process).
function lineStyle(who) {
  const i = data.residents.findIndex((x) => x.name === who);
  if (i < 0) return '';
  const rgb = hexRgb(data.residents[i].color);
  return rgb ? `--who: ${rgb}` : `--who: var(--${TONES[i % 4]})`;
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
  const pos = positions(at());
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

function placePanel(p) {
  if (!p) return [back()];
  const here = [...positions(at()).values()].filter((x) => x.place === p.id).map((x) => x.r.name);
  const scenes = (data.day?.scenes || []).filter((s) => s.place === p.id);
  const action = ACTIONS[p.id];
  return [
    back(),
    el('div', { class: 'hint' }, `${p.stage}${p.level ? ` · level ${p.level} of 3` : ''}`),
    el('h3', { class: 'display' }, `${p.icon} ${p.name}`),
    el('p', {}, p.about),
    el('div', { class: 'world-grow' }, el('b', {}, 'Grows with'), el('div', {}, p.hint)),
    here.length ? el('div', { class: 'world-sec' }, el('b', {}, 'Here now'), el('div', {}, here.join(', '))) : '',
    scenes.length ? el('div', { class: 'world-sec' }, el('b', {}, 'Today here'), ...scenes.map(sceneCard)) : '',
    p.id === 'stage' ? stagePanel() : '',
    action && p.id !== 'stage' ? el('button', { class: 'btn', onclick: action[1] }, action[0]) : '',
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
  const now = positions(at()).get(name);
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
