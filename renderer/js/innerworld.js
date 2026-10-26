// Inner World view: the personas' village (main/innerworld.js, rules in main/worldcore.js), painted by
// worldart.js. Residents walk between places along today's plan in real time; while a scene happens its
// people gather and talk in speech bubbles; the clock slider replays the day. The village also shows the
// present: whatever the assistant is doing right now sends the active persona to the matching building
// (code → the Workshop's forge, the web → the Lookout…), your skill tree shines in the night sky, the
// Training Grounds fly a banner per habit and the Garden blooms for the habits kept today.
// The side panel tells today; click a building, a resident or a star for theirs.
import { $, api, el, toast, toastError, on, promptDialog } from './util.js';
import { switchView, currentView } from './nav.js';
import { send } from './chat.js';
import { state, saveSettings } from './state.js';
import { fxLevel } from './hud.js';
import { palette, makeView, drawScene, bubble, weatherOf, resetArt } from './worldart.js';

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

let data = null;
let canvas;
let ctx;
let V = null; // view geometry (worldart.makeView)
let P = null; // palette from the theme
let hits = { places: {}, people: [], stars: [] };
let selected = null; // { type: 'place' | 'resident', id }
let hover = null;
let scrub = null; // minutes since midnight while the slider is held away from "live"
let frame = 0;
let live = null; // { place, label, tool, at, done }
const stage = []; // live lines from a rehearsal running now

export function initInnerWorld() {
  canvas = $('#worldCanvas');
  ctx = canvas.getContext('2d');
  new ResizeObserver(resize).observe(canvas);
  canvas.addEventListener('mousemove', (e) => {
    const h = hit(e);
    canvas.title = h?.type === 'star' ? `${h.id} · ${h.state}${h.state === 'mastered' ? '' : ` · ${Math.round(h.progress * 100)}%`} (your skill tree)` : '';
    if (h?.id !== hover?.id) ((hover = h), draw());
    canvas.style.cursor = h ? 'pointer' : 'default';
  });
  canvas.addEventListener('mouseleave', () => ((hover = null), draw()));
  canvas.addEventListener('click', (e) => {
    const h = hit(e);
    if (h?.type === 'star') return switchView('tree');
    select(h);
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
  on('world-changed', refresh);
  on('settings', () => {
    resetArt();
    P = null;
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

// ------------------------------------------------------------ geometry
function resize() {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  V = makeView(r.width, r.height);
  draw();
}

// The scene happening at this minute, if any.
function sceneAt(m) {
  return (data?.day?.scenes || []).find((s) => {
    const t = minutes(s.time);
    return t !== null && m >= t && m < t + SCENE_MIN;
  });
}

const colorOf = (r, i) => {
  P ||= palette(); // the side panel can ask before the first draw
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(r.color || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : P[TONES[i % 4]];
};

// Where a resident stands at a place: beside the building, side by side with the others there.
function spot(placeId, j) {
  const p = placeById(placeId) || placeById('garden');
  const a = V.project(p.x, p.y);
  if (placeId === 'garden') return { x: a.x - 34 * a.s + j * 15 * a.s, y: a.y + 8 * a.s, s: a.s };
  return { x: a.x + (40 + j * 13) * a.s, y: a.y + (4 + (j % 2) * 7) * a.s, s: a.s };
}

/** Everyone's position at minute m: in a scene, at live work, walking, at their plan's place, or asleep. */
function positions(m) {
  const out = [];
  if (!data?.residents || !V) return out;
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
    const j = crowd.get(p.place).indexOf(p.name);
    let pos = spot(p.place, j);
    if (p.from) {
      const a = spot(p.from, 0);
      const e = p.k * p.k * (3 - 2 * p.k);
      pos = { x: a.x + (pos.x - a.x) * e, y: a.y + (pos.y - a.y) * e, s: a.s + (pos.s - a.s) * e };
    }
    Object.assign(p, pos, { walking: Boolean(p.from), color: colorOf(p.r, p.i), kind: p.r === me ? 'active' : p.r.npc ? 'npc' : 'persona' });
  }
  return out;
}

// ------------------------------------------------------------ drawing
function loop() {
  cancelAnimationFrame(frame);
  if (currentView !== 'world' || document.hidden || !animated()) return draw();
  const step = () => {
    draw();
    if (currentView === 'world' && !document.hidden && animated()) frame = requestAnimationFrame(() => setTimeout(step, lite() ? 66 : 33));
  };
  step();
}

function draw() {
  if (!ctx || !V || !data?.places) return;
  P ||= palette();
  const m = at();
  const people = positions(m).filter((p) => !p.asleep);
  const l = liveNow();
  const scene = sceneAt(m);
  hits = drawScene(
    ctx,
    V,
    P,
    {
      places: data.places,
      details: data.details,
      residents: people,
      minute: m,
      weather: weatherOf(data.day?.weather),
      live: l || (stage.length ? { place: 'stage' } : null),
      busy: data.details?.work?.today,
      hover: hover?.type === 'place' ? hover.id : null,
      selected: selected?.type === 'place' ? selected.id : null,
    },
    { t: performance.now(), anim: animated(), lite: lite() },
  );
  // Speech: a scene playing now, a live rehearsal, or what the assistant is doing.
  if (scene) {
    const t = minutes(scene.time);
    const line = scene.lines[Math.min(scene.lines.length - 1, Math.floor(((m - t) / SCENE_MIN) * scene.lines.length))];
    const who = hits.people.find((p) => p.name === line.who) || hits.places[scene.place];
    if (who) bubble(ctx, V, P, who.x, (who.top ?? who.y) - 6, `${line.who}: ${line.text}`, { s: who.s || 1 });
  } else if (stage.length && hits.places.stage) {
    const b = hits.places.stage;
    const line = stage[stage.length - 1];
    bubble(ctx, V, P, b.x, b.top, `${line.who}: ${line.text}`, { live: true, s: b.s });
  }
  if (l) {
    const me = hits.people.find((p) => p.name === activeResident()?.name);
    if (me && !scene) bubble(ctx, V, P, me.x, me.top - 8, `${l.label}…`, { live: true });
  }
  // Sleepers: a "z" over the Hearth.
  if (positions(m).some((p) => p.asleep) && hits.places.hearth) {
    const b = hits.places.hearth;
    ctx.font = `${Math.round(13 * b.s)}px sans-serif`;
    ctx.fillStyle = `rgba(${P.text.join(', ')}, 0.6)`;
    ctx.fillText('z z', b.x + 26 * b.s, b.top + 6 * b.s);
  }
}

// ------------------------------------------------------------ interaction
function hit(e) {
  if (!data?.places || !V) return null;
  const r = canvas.getBoundingClientRect();
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  for (const p of hits.people) if (Math.hypot(mx - p.x, my - p.y) < p.r) return { type: 'resident', id: p.name };
  for (const [id, b] of Object.entries(hits.places)) {
    if (Math.abs(mx - b.x) < 58 * b.s && my > b.top && my < b.y + 36 * b.s) return { type: 'place', id };
  }
  for (const s of hits.stars) if (Math.hypot(mx - s.x, my - s.y) < s.r) return { type: 'star', id: s.name, state: s.state, progress: s.progress };
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
