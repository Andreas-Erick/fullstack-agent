// The phone's screens beyond the chat (renderer/remote/app.js shows them): Today, Learn,
// Memory, Notes, Inner World, Architecture, Skills & routines, and the "More" menu. The data comes from
// the computer (main/companiondata.js, /api/data/*): read-only. The page's
// CSP allows no inline styles, so dynamic values go through CSSOM (style.setProperty).
let ctx = null; // { api, el, icon, markdown, toast, send, prefill, showView, AuthError, state }

export function initScreens(c) {
  ctx = c;
}

export const TITLES = { today: 'Today', learn: 'Learning', memory: 'Memory', notes: 'Notes', world: 'Inner World', arch: 'Architecture', skills: 'Skills & routines', more: 'More' };

// The "More" menu: every screen that isn't a tab, with what it shows (Notes is a tab).
const MORE = [
  ['sched', 'calendar', 'Schedule', 'Your week, from Schedule.md'],
  ['memory', 'brain', 'Memory', 'What she remembers about you, and her stream of observations'],
  ['world', 'world', 'Inner World', 'The village where your personas live'],
  ['arch', 'arch', 'Architecture', 'How she is built: a map of her own code, to explore and learn from'],
  ['skills', 'spark', 'Skills & routines', 'Ready-made workflows to run, and what runs on a schedule'],
];

let renderSeq = 0; // only the latest drawing lands (a quiet refresh must not cover a note opened meanwhile)
let noteOpen = false; // a note is shown in the panel (openNote) instead of the Notes list

/**
 * Renders screen `view` into `box`. `quiet`: a refresh because the data changed on the computer
 * (app.js data.changed): no "Loading…", the scroll position and open sections stay, and a failure
 * keeps what is shown.
 */
export async function render(view, box, { quiet = false } = {}) {
  const { el } = ctx;
  const seq = ++renderSeq;
  if (!quiet) {
    stopWorld();
    stopArch();
    noteOpen = false;
    box.replaceChildren(el('div', { class: 'panel-loading muted' }, 'Loading…'));
  }
  try {
    const node = await SCREENS[view]();
    if (ctx.state.view !== view || seq !== renderSeq) return; // moved on meanwhile
    if (quiet) {
      if (busy(view)) return; // started typing or opened a note while it loaded
      const open = openSections(box);
      const top = box.scrollTop;
      box.replaceChildren(...[node].flat());
      reopen(box, open);
      box.scrollTop = top;
      return;
    }
    box.replaceChildren(...[node].flat());
    box.scrollTop = 0;
    enter(box);
  } catch (err) {
    if (quiet || seq !== renderSeq) return;
    if (err instanceof ctx.AuthError || ctx.state.view !== view) return;
    // The computer is out of reach: say so, and offer to try again (it also comes back by itself on reconnect).
    if (err instanceof ctx.NetError) {
      box.replaceChildren(el('div', { class: 'panel-empty panel-offline' }, ctx.icon('unlink'), el('h3', {}, 'Your computer is out of reach'), el('p', { class: 'muted' }, `${TITLES[view] || 'This screen'} comes from your computer. It shows up again as soon as the link is back.`), el('button', { class: 'btn', type: 'button', onclick: () => render(view, box) }, 'Try again')));
      return;
    }
    box.replaceChildren(el('div', { class: 'panel-empty panel-offline' }, el('h3', {}, 'This screen didn’t load'), el('p', { class: 'muted' }, err.message), el('button', { class: 'btn', type: 'button', onclick: () => render(view, box) }, 'Try again')));
  }
}

const SCREENS = { today, learn, memory, notes, world, arch, skills, more };

/**
 * The user is in the middle of something on `view`, so a change on the computer must not redraw it:
 * reading a note, or typing (a search with text in it counts: its results would go).
 */
export function busy(view) {
  if (view === 'notes' && noteOpen) return true;
  const panel = document.querySelector('#panel');
  const a = document.activeElement;
  if (panel && a && panel.contains(a) && a.matches('input, textarea, select')) return true;
  return [...(panel?.querySelectorAll('input.search') || [])].some((i) => i.value.trim());
}

// Open <details> (topics, memories) by their summary's text, so a refresh doesn't fold them up again.
const openSections = (box) => new Set([...box.querySelectorAll('details[open] > summary')].map((s) => s.textContent));
function reopen(box, open) {
  if (!open.size) return;
  for (const s of box.querySelectorAll('details > summary')) if (open.has(s.textContent)) s.parentElement.open = true;
}

// The desktop's view opening (renderer/js/hud.js): a beam crosses the screen and its cards cascade in.
// Only with the HUD on (styles.css .fx-hud .panel.enter); the CSS stops it under reduced motion.
function enter(box) {
  [...box.children].forEach((n, i) => n.style?.setProperty('--i', String(Math.min(i, 8))));
  box.classList.remove('enter');
  void box.offsetWidth; // restart the animation
  box.classList.add('enter');
}

// --------------------------------------------------------------- helpers
const card = (title, ...children) => ctx.el('section', { class: 'card' }, title ? ctx.el('h3', {}, title) : null, ...children);
// An empty screen: an icon in a soft ring, what is missing, and the one thing to do about it.
const empty = (text, action, ico) => ctx.el('div', { class: 'panel-empty' }, ico ? ctx.el('div', { class: 'empty-orb', 'aria-hidden': 'true' }, ctx.icon(ico)) : null, ctx.el('p', {}, text), action || null);
const chip = (text, cls = '') => ctx.el('span', { class: `chip ${cls}` }, text);
const ask = (label, message) => ctx.el('button', { class: 'btn ghost small', type: 'button', onclick: () => (ctx.showView('chat'), ctx.send(message)) }, label);
const pct = (node, v) => (node.style.setProperty('--p', `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`), node);
const timeOf = (s) => new Date(s).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// --------------------------------------------------------------- Today
async function today() {
  const { el, api, markdown } = ctx;
  const d = await api('/api/data/today');
  const now = new Date();
  const hello = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening';
  const upcoming = d.events.filter((e) => e.allDay || new Date(e.end) > now);
  const vocab = (d.decks || []).map((x) => ({ language: x.language, due: (x.dueCount || 0) + (x.newCount || 0) })).filter((x) => x.due);
  const words = vocab.reduce((n, x) => n + x.due, 0);
  // At a glance: three tiles, each opening where that number lives.
  const glance = (ico, value, label, view, cls) => el('button', { class: `glance ${cls}`, type: 'button', onclick: () => ctx.showView(view) }, ctx.icon(ico), el('b', {}, value), el('small', {}, label));
  const out = [
    el('div', { class: 'today-head' }, el('small', {}, now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })), el('h2', {}, hello)),
    el('div', { class: 'glance-row' },
      glance('calendar', String(upcoming.length), upcoming.length === 1 ? 'event left' : 'events left', ctx.state.calendar ? 'sched' : 'today', 't1'),
      glance('note', String(d.notesToday || 0), d.notesToday === 1 ? 'note today' : 'notes today', 'notes', 't2'),
      glance('learn', String(words), words === 1 ? 'word to review' : 'words to review', 'learn', 't3'),
    ),
  ];
  if (d.handoff) {
    out.push(card('Where we left off', el('p', {}, el('b', {}, d.handoff.topic)), d.handoff.summary ? el('p', { class: 'muted' }, d.handoff.summary) : null, ...(d.handoff.nextSteps || []).map((s) => el('div', { class: 'li' }, '→ ', s)), el('div', { class: 'row' }, ask('Continue', 'Let’s continue where we left off.'))));
  }
  out.push(card('Schedule', ...(upcoming.length ? upcoming.map((e) => el('div', { class: 'today-ev' }, el('b', {}, e.allDay ? 'all day' : timeOf(e.start)), el('span', {}, e.title, e.location ? el('small', {}, ` · ${e.location}`) : null))) : [el('p', { class: 'muted' }, d.events.length ? 'Nothing more today.' : 'Nothing scheduled today.')])));
  if (vocab.length) out.push(card('Vocabulary to review', ...vocab.map((x) => el('button', { class: 'study-row', type: 'button', onclick: () => (ctx.showView('chat'), ctx.send(`Let’s review my ${x.language} vocabulary.`)) }, el('span', { class: 'what' }, el('b', {}, x.language), el('small', {}, `${x.due} to review`)), el('span', { class: 'go' }, 'Review ›')))));
  if (d.shaky.length) out.push(card('Still shaky', ...d.shaky.map((s) => el('div', { class: 'li' }, el('b', {}, `${s.topic}: `), s.text)), el('div', { class: 'row' }, ask('Go over them', 'Help me go over what is still shaky in what I am learning.'))));
  const priorities = filledSections(d.priorities || '');
  if (priorities) out.push(card('Active priorities', el('div', { class: 'md' }, ...htmlOf(markdown(priorities)))));
  else if (d.priorities) out.push(card('Active priorities', el('p', { class: 'muted' }, 'Nothing set yet.'), el('div', { class: 'row' }, ask('Set my priorities', 'Help me set my active priorities.'))));
  return out;
}

// A note's headings that have something under them (a fresh Active Priorities note is only its
// headings), without the note's own title: the card already names it.
function filledSections(md) {
  const lines = String(md).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').split(/\r?\n/);
  const level = (l) => /^(#{1,6})\s/.exec(l)?.[1].length || 0;
  const keep = lines.map((l, i) => {
    const lv = level(l);
    if (!lv) return l.trim() !== '' && !/^<!--.*-->$/.test(l.trim());
    for (let j = i + 1; j < lines.length; j++) {
      const lj = level(lines[j]);
      if (lj && lj <= lv) return false;
      if (!lj && lines[j].trim() && !/^<!--.*-->$/.test(lines[j].trim())) return true;
    }
    return false;
  });
  const out = lines.filter((l, i) => keep[i] || (!l.trim() && i > 0 && keep[i - 1]));
  if (out.length && level(out[0]) === 1) out.shift();
  return out.join('\n').trim();
}

// Sanitized HTML (app.js markdown → DOMPurify) as nodes.
function htmlOf(html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  return [...t.content.childNodes];
}


// --------------------------------------------------------------- Learn
async function learn() {
  const { el, api } = ctx;
  const d = await api('/api/data/learn');
  const out = [];
  if (d.decks.length) {
    out.push(card('Vocabulary', ...d.decks.map((x) => el('div', { class: 'deck' },
      el('div', {}, el('b', {}, x.language), el('small', {}, `${x.total} cards · ${x.mature} known`)),
      pct(el('div', { class: 'bar' }, el('i')), x.total ? x.mature / x.total : 0),
      x.dueCount || x.newCount ? ask(`Review ${x.dueCount + x.newCount}`, `Let’s review my ${x.language} vocabulary.`) : chip('all done', 'ok'),
    ))));
  }
  if (d.topics.length) {
    out.push(...d.topics.map((t) => {
      const det = el('details', { class: 'topic' },
        el('summary', {}, el('b', {}, t.topic), el('span', { class: 'chips' }, chip(`${t.understood.length} understood`, 'ok'), t.shaky.length ? chip(`${t.shaky.length} shaky`, 'warn') : null, t.questions.length ? chip(`${t.questions.length} open`) : null)),
        section('Understood', t.understood),
        section('Shaky', t.shaky),
        section('Misconceptions', t.misconceptions),
        section('Open questions', t.questions),
        el('div', { class: 'row' }, ask('Study this', `Let’s study ${t.topic}.`), ask('Quiz me', `/teach-back ${t.topic}`)),
      );
      return det;
    }));
  }
  if (!out.length) return empty('Nothing tracked yet. Learn something with her and she keeps track of what you understood.', ask('Let’s study', 'Let’s study.'), 'learn');
  return out;
}

const section = (title, items) => (items?.length ? ctx.el('div', { class: 'sec' }, ctx.el('small', {}, title), ...items.map((x) => ctx.el('div', { class: 'li' }, x))) : '');

// --------------------------------------------------------------- Memory
async function memory() {
  const { el, api } = ctx;
  const search = el('input', { class: 'input search', type: 'search', placeholder: 'Search memories', 'aria-label': 'Search memories' });
  const list = el('div', { class: 'mem-list' });
  const stream = el('div', {});
  const load = async () => {
    const { memories } = await api(`/api/data/memories${search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}` : ''}`);
    list.replaceChildren(...(memories.length ? memories.map((m) => el('details', { class: 'mem' }, el('summary', {}, el('b', {}, m.title), chip(m.category || 'note')), el('p', {}, m.content), el('small', { class: 'muted' }, new Date(m.updated).toLocaleDateString()))) : [search.value ? el('p', { class: 'muted center' }, 'No match.') : empty('No memories yet. Tell her about yourself, and what matters is kept here.', null, 'brain')]));
  };
  let t;
  search.addEventListener('input', () => (clearTimeout(t), (t = setTimeout(load, 300))));
  await load();
  api('/api/data/stream').then((s) => {
    if (s.off || !s.records.length) return;
    stream.replaceChildren(card('Memory stream', el('p', { class: 'muted' }, 'Small observations she noted, and the insights she drew from them.'), ...s.records.slice(0, 30).map((r) => el('div', { class: `stream ${r.kind === 'reflection' ? 'insight' : ''}` }, el('small', {}, `${new Date(r.at).toLocaleDateString()} · ★${r.importance}${r.kind === 'reflection' ? ' · insight' : ''}`), el('div', {}, r.text)))));
  }).catch(() => {});
  return [search, list, stream];
}

// --------------------------------------------------------------- Notes
async function notes() {
  const { el, api } = ctx;
  const search = el('input', { class: 'input search', type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes' });
  const list = el('div', { class: 'note-list' });
  const load = async () => {
    const q = search.value.trim();
    const { notes: items } = await api(`/api/data/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const meta = (n) => [n.modified ? new Date(n.modified).toLocaleDateString() : '', n.folder && n.folder !== '/' && n.folder !== 'Notes' ? n.folder : '', ...(n.tags || []).map((t) => `#${t}`)].filter(Boolean).join(' · ');
    list.replaceChildren(...(items.length ? items.map((n) => el('button', { class: 'note-row', type: 'button', onclick: () => openNote(n.path) }, el('b', {}, n.pinned ? '📌 ' : '', n.title), n.snippet ? el('span', { class: 'note-snip' }, n.snippet) : null, el('small', {}, meta(n)))) : [el('p', { class: 'muted' }, q ? 'No match.' : 'No notes yet. Write one in the Notes view on your computer.')]));
  };
  let t;
  search.addEventListener('input', () => (clearTimeout(t), (t = setTimeout(load, 300))));
  await load();
  return [search, list];
}

async function openNote(path) {
  const { el, api, markdown } = ctx;
  const box = document.querySelector('#panel');
  renderSeq++; // a refresh of the list still loading must not cover the note
  noteOpen = true;
  box.replaceChildren(el('div', { class: 'panel-loading muted' }, 'Opening…'));
  try {
    const n = await api(`/api/data/note?path=${encodeURIComponent(path)}`);
    const body = n.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    box.replaceChildren(
      el('button', { class: 'btn ghost small back', type: 'button', onclick: () => ctx.showView('notes') }, '‹ All notes'),
      el('article', { class: 'note md' }, el('h2', {}, n.title), el('small', { class: 'muted' }, `${n.path} · ${new Date(n.modified).toLocaleString()}`), ...htmlOf(markdown(body.replace(/^#\s+(.+)\r?\n/, (m, t) => (t.trim().toLowerCase() === n.title.trim().toLowerCase() ? '' : m)).replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_m, a, b) => `[${b || a}](#note:${encodeURIComponent(a.trim())})`)))),
      el('div', { class: 'row center' }, ask('Ask about this note', `About my note "${n.title}": `)),
    );
    box.scrollTop = 0;
    // [[Links]] open the note they name (found by its title).
    box.querySelector('article.note')?.addEventListener('click', async (e) => {
      const a = e.target.closest('a[href^="#note:"]');
      if (!a) return;
      e.preventDefault();
      const name = decodeURIComponent(a.getAttribute('href').slice(6)).split('/').pop();
      const { notes: hits } = await api(`/api/data/notes?q=${encodeURIComponent(name)}`).catch(() => ({ notes: [] }));
      const hit = hits.find((x) => x.title.toLowerCase() === name.toLowerCase());
      if (hit) openNote(hit.path);
      else ctx.toast(`No note called “${name}” yet`);
    });
  } catch (err) {
    if (!(err instanceof ctx.AuthError)) box.replaceChildren(empty(err.message));
  }
}

// --------------------------------------------------------------- Skills & routines
async function skills() {
  const { el, api } = ctx;
  const [{ skills: list }, { routines }] = await Promise.all([api('/api/data/skills'), api('/api/data/routines')]);
  return [
    card('Skills', el('p', { class: 'muted' }, 'Tap one to start it in the chat.'), ...list.map((s) => el('button', { class: 'note-row', type: 'button', onclick: () => (ctx.showView('chat'), ctx.prefill(`/${s.slug} `)) }, el('b', {}, `/${s.slug}`), el('small', {}, s.description || s.name)))),
    routines.length ? card('Routines', ...routines.map((r) => el('div', { class: 'li' }, el('b', {}, r.name), el('small', { class: 'muted' }, ` · ${r.enabled ? r.when || '' : 'paused'}${r.lastRun ? ` · last ${new Date(r.lastRun).toLocaleString()}` : ''} `), ROUTINE_CHIP.has(r.lastStatus) ? chip(...ROUTINE_CHIP.get(r.lastStatus)) : null))) : '',
  ];
}

// How the last run went, as on the desktop (a good run needs no chip). A Map: a status is never read
// off Object.prototype.
const ROUTINE_CHIP = new Map(Object.entries({ error: ['failed', 'bad'], skipped: ['skipped', 'warn'], waiting: ['waiting', 'warn'], interrupted: ['cut off', 'warn'], running: ['running', ''], stopped: ['stopped', ''] }));

// --------------------------------------------------------------- More
// In the Android app: a newer APK than this one is out (the computer checks GitHub, /api/info `update`).
function appUpdate() {
  const { el } = ctx;
  const u = ctx.state.info?.update;
  const mine = window.NexusAndroid?.appVersion?.();
  const v = (s) => String(s || '').split('.').map(Number);
  const newer = (a, b) => {
    const [x, y] = [v(a), v(b)];
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
    return false;
  };
  if (!u?.android || !mine || !/^\d+\.\d+\.\d+$/.test(mine) || !newer(u.version, mine)) return null;
  return el('section', { class: 'card app-update' }, el('h3', {}, `Siren ${u.version} for Android`), el('p', { class: 'muted' }, `You have ${mine}. Download the new app and install it over this one (your pairing stays).${u.wear ? ' The watch app is on the same release page.' : ''}`), el('a', { class: 'btn', href: u.android, target: '_blank', rel: 'noopener' }, '⬇ Download'), u.page ? el('a', { class: 'btn ghost', href: u.page, target: '_blank', rel: 'noopener' }, 'Release page') : null);
}

async function more() {
  const { el, icon } = ctx;
  const update = appUpdate();
  return [...(update ? [update] : []), el('div', { class: 'more-grid' }, ...MORE.filter(([v]) => v !== 'sched' || ctx.state.calendar).map(([v, ico, title, desc], i) => el('button', { class: `more-tile t${(i % 4) + 1}`, type: 'button', onclick: () => ctx.showView(v) }, el('span', { class: 'tile-ico' }, icon(ico)), el('b', {}, title), el('small', {}, desc))))];
}

// --------------------------------------------------------------- Inner World
// The same village as on the computer (renderer/js/world/*), drawn here: drag to look around, pinch
// to zoom, tap a building for what it shows of you. Residents stand where their day plan puts them.
let worldLoop = null;
function stopWorld() {
  if (worldLoop) cancelAnimationFrame(worldLoop.raf);
  worldLoop?.off?.();
  worldLoop = null;
}

async function world() {
  const { el, api } = ctx;
  const d = await api('/api/data/world');
  if (!d.vault) return empty('The Inner World needs the vault on the computer.', null, 'world');
  if (!d.enabled) return empty('The village is asleep. Wake it on the computer (World view) and your personas start living there.', null, 'world');
  const [{ buildMap, route, along }, { palette, W, HZ }, scene, { loadSprites, spritesReady }, { seasonOf }, room, where] = await Promise.all([import('/js/world/map.js'), import('/js/world/art.js'), import('/js/world/scene.js'), import('/js/world/sprites.js'), import('/js/world/season.js'), import('/js/world/room.js'), import('/js/world/whereabouts.js')]);
  if (ctx.state.info?.art !== 'drawn') await loadSprites().catch(() => false);
  const canvas = el('canvas', { class: 'world-canvas', 'aria-label': 'The village' });
  const info = el('div', { class: 'world-info' });
  const wrap = el('div', { class: 'world-wrap' }, canvas);
  const places = d.places.map((p) => ({ id: p.id, x: p.x, y: p.y, name: p.name, level: p.level }));
  const map = buildMap(places);
  const season = seasonOf(new Date(), { choice: ctx.state.info?.season || 'auto', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  const P = palette(season);
  const levels = places.reduce((n, p) => n + p.level, 0);
  const seed = String(d.residents.find((r) => !r.npc)?.id || 'nexus');
  const data = {
    map,
    P,
    places,
    details: { ...d.details, residents: d.residents.map((r) => r.name) },
    interior: null,
    rendered: ctx.state.info?.art !== 'drawn' && spritesReady(),
    homes: Math.min(map.lots?.length || 0, 2 + Math.floor(levels / 2) + Math.max(0, d.residents.filter((r) => !r.npc).length - 1)),
    designs: Object.fromEntries(places.map((p) => [p.id, [...(seed + p.id)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 2])),
  };
  const TONES = ['c2', 'c3', 'ok', 'warn'];
  const minutes = (t) => {
    const m = String(t || '').match(/^(\d{2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  // Who is where: the same rules as the desktop (world/whereabouts.js). The active persona walks to
  // the work the chat stream reports (state.worldWork), strolls the village when free.
  const walker = where.createWalker();
  const ring = where.strollOrder(map.sites, places.filter((p) => p.level > 0).map((p) => p.id));
  const LINGER_MS = 6000;
  const roads = new Map(); // the road between two places, found once
  const people = () => {
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    const ww = ctx.state.worldWork;
    const live = ww && (!ww.done || Date.now() - ww.done < LINGER_MS) ? ww : null;
    const agent = ctx.agentState ? ctx.agentState() : 'idle';
    const crowd = new Map();
    const out = d.residents.map((r, i) => {
      let w;
      if (r.active) w = agent === 'sleeping' ? { place: 'hearth', activity: 'asleep', asleep: true } : walker.update({ target: where.activeTarget({ live, agentState: agent }), order: ring, now: Date.now() });
      else if (!r.npc) w = where.offDuty(m, i);
      else w = where.byPlan(r.plan, m, minutes, 0);
      const j = (crowd.get(w.place) || 0);
      crowd.set(w.place, j + 1);
      const s = map.sites[w.place] || map.sites.garden;
      let g = { x: s.gx + s.a + 0.7 + (j % 2) * 0.55, y: s.gy + s.b * 0.45 - Math.floor(j / 2) * 0.62 };
      if (w.from && map.sites[w.from]) {
        const f = map.sites[w.from];
        const key = `${w.from}>${w.place}>${j}`;
        if (!roads.has(key)) roads.set(key, route(map, w.from, w.place, { start: { x: f.gx + f.a + 0.7, y: f.gy + f.b * 0.45 }, end: g }));
        g = along(roads.get(key), w.k) || g;
      }
      const wp = W(g.x, g.y, map.hgt(Math.floor(g.x), Math.floor(g.y)) * HZ);
      const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(r.color || '');
      return { r, i, name: r.name, place: w.place, activity: w.activity, asleep: Boolean(w.asleep), x: wp.x, y: wp.y, color: hex ? [1, 2, 3].map((k) => parseInt(hex[k], 16)) : P[TONES[i % 4]], kind: r.active ? 'active' : r.npc ? 'npc' : 'persona', walking: Boolean(w.from), working: Boolean(w.working), thinking: Boolean(w.thinking) };
    });
    return out.filter((p) => !p.asleep);
  };

  // The island's bitmap stays within 4 megapixels and 4096 px a side: sharp enough on a phone or tablet,
  // and within what a mobile GPU holds as one picture (a bigger canvas can go black on some devices).
  const full = scene.bounds();
  const fullW = full.maxX - full.minX;
  const fullH = full.maxY - full.minY;
  const islandScale = (want) => Math.max(0.05, Math.min(want, Math.sqrt(4e6 / (fullW * fullH)), 4096 / Math.max(fullW, fullH)));
  const size = { w: 0, h: 0, dpr: 1 };
  let cam = null;
  let home = null;
  let island = null;
  let selected = null;
  let flight = null; // { from, to, start }: the camera gliding into or out of a building
  let lastDraw = 0;
  const g = canvas.getContext('2d');
  const paint = (scale) => {
    const old = island;
    island = scene.buildIsland(data, scale);
    scene.release(old); // the old bitmap's memory goes at once (a phone has little to spare)
  };
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    size.dpr = Math.min(window.devicePixelRatio || 1, 2);
    size.w = r.width;
    size.h = r.height;
    canvas.width = Math.round(r.width * size.dpr);
    canvas.height = Math.round(r.height * size.dpr);
    home = scene.fit(size.w, size.h, map);
    cam ||= { ...home };
    paint(islandScale(cam.z * size.dpr));
    return true;
  };
  const draw = (t) => {
    if (!size.w && !resize()) return;
    g.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    const now = new Date();
    const f = { w: size.w, h: size.h, dpr: size.dpr, cam, island, P, t, anim: !matchMedia('(prefers-reduced-motion: reduce)').matches, lite: true, minute: now.getHours() * 60 + now.getMinutes(), weather: scene.weatherOf(d.day?.weather), residents: people(), live: null, busy: d.details?.work?.today };
    scene.frame(g, f);
    scene.labels(g, f, island, { selected });
  };
  // The computer's frame rate setting (innerWorld.fps; 30 unless chosen) on the display's own beat, the
  // camera's glide at full rate. A frame that throws stops the loop and says why, instead of a silent black box.
  const tick = (t) => {
    if (!canvas.isConnected) return stopWorld();
    try {
      if (flight) {
        const k = Math.min(1, (performance.now() - flight.start) / 600);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        cam = { x: flight.from.x + (flight.to.x - flight.from.x) * e, y: flight.from.y + (flight.to.y - flight.from.y) * e, z: flight.from.z + (flight.to.z - flight.from.z) * e };
        if (k >= 1) ((flight = null), rescale());
      }
      if (flight || gesture || t - lastDraw >= 1000 / (ctx.state.info?.worldFps || 30) - 4) {
        lastDraw = t;
        draw(t);
      }
    } catch (err) {
      stopWorld();
      info.replaceChildren(empty(`The village couldn’t be drawn on this device: ${err.message}`, ask('Tell Siren', `The Inner World screen on my phone failed with: ${err.message}`)));
      return;
    }
    worldLoop.raf = requestAnimationFrame(tick);
  };

  // Stepping inside a built place (as on the desktop, renderer/js/roomview.js): the room from above
  // opens over the island (/js/world/room.js), its furniture made of your data, the residents who are
  // there now walking between the stations. A double tap or the card's button goes in; the button goes
  // back out. One simulation per place, so the figures stay where they were when you come back.
  const rescale = () => {
    const want = islandScale(cam.z * size.dpr);
    if (Math.abs(want - island.scale) / island.scale > 0.4) paint(want);
  };
  const canEnter = (id) => Boolean(map.sites[id] && places.find((p) => p.id === id)?.level);
  const roomSims = new Map();
  let roomRaf = 0;
  const leaveRoom = () => {
    cancelAnimationFrame(roomRaf);
    wrap.querySelector('.world-room')?.remove();
    wrap.style.removeProperty('height');
  };
  const enter = (id) => {
    if (!canEnter(id)) return;
    leaveRoom();
    data.interior = id;
    selected = id;
    const place = places.find((p) => p.id === id);
    const icon = d.places.find((p) => p.id === id)?.icon || '';
    const sim = roomSims.get(id) || room.createSim();
    roomSims.set(id, sim);
    const lay = room.layout(id, place.level, { details: d.details, residents: d.residents, docs: [], rehearsals: [], scenes: d.day?.scenes || [] });
    const rc = el('canvas', { class: 'world-room-canvas', 'aria-label': 'Inside the building: the residents at work and what the place holds of you' });
    const tipEl = el('div', { class: 'world-room-tip hidden' });
    wrap.append(el('div', { class: 'world-room' }, el('div', { class: 'world-room-head' }, el('b', {}, `${icon} ${place.name}`), el('button', { class: 'btn small', type: 'button', onclick: () => leave() }, '← Step outside')), rc, tipEl));
    // A phone's box takes the room's own shape (its width × the room's proportions, plus the head), set once.
    if (!document.body.classList.contains('wide')) wrap.style.height = `${Math.round(wrap.clientWidth * (room.RH / room.RW) + 44)}px`;
    const rs = { w: 0, h: 0, dpr: 1 };
    const g2 = rc.getContext('2d');
    let actors = [];
    let hover = null;
    let last = 0;
    let lastRoomDraw = 0;
    const anim = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const resizeRoom = () => {
      const r = rc.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      rs.dpr = Math.min(window.devicePixelRatio || 1, 2);
      rs.w = r.width;
      rs.h = r.height;
      rc.width = Math.round(r.width * rs.dpr);
      rc.height = Math.round(r.height * rs.dpr);
      return true;
    };
    const tickRoom = (t) => {
      if (!rc.isConnected || data.interior !== id) return;
      roomRaf = requestAnimationFrame(tickRoom);
      if (t - lastRoomDraw < 1000 / (ctx.state.info?.worldFps || 30) - 4) return;
      const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
      last = t;
      lastRoomDraw = t;
      if (!rs.w && !resizeRoom()) return;
      const now = new Date();
      const m = now.getHours() * 60 + now.getMinutes();
      const here = people().filter((p) => p.place === id && !p.walking).map((p) => ({ name: p.name, color: p.color, active: p.kind === 'active', kind: p.kind, activity: p.activity, working: p.working, thinking: p.thinking, asleep: p.asleep }));
      actors = sim.update(here, lay.stations, anim ? dt : 0, t / 1000);
      g2.setTransform(rs.dpr, 0, 0, rs.dpr, 0, 0);
      room.draw(g2, { w: rs.w, h: rs.h, P, t: t / 1000, place: id, level: place.level, name: place.name, stations: lay.stations, actors, floor: lay.floor, open: lay.open, night: m < 6 * 60 || m >= 20 * 60, anim, lite: true, hover });
    };
    // A tap says what a thing holds of you, or what a resident is doing.
    rc.addEventListener('click', (e) => {
      const r = rc.getBoundingClientRect();
      const hit = room.pick(rs.w, rs.h, lay.stations, actors, e.clientX - r.left, e.clientY - r.top);
      hover = hit?.type === 'station' ? hit : null;
      if (!hit) return tipEl.classList.add('hidden');
      tipEl.replaceChildren(el('b', {}, hit.type === 'actor' ? hit.actor.name : hit.station.label || hit.station.kind), ' · ', hit.type === 'actor' ? `${hit.actor.activity || 'here'}${hit.actor.working ? ' (right now)' : ''}` : hit.station.info || '');
      tipEl.classList.remove('hidden');
    });
    roomRaf = requestAnimationFrame(tickRoom);
    showPlace(info, d, id, nav);
  };
  const leave = () => {
    if (!data.interior) return;
    leaveRoom();
    data.interior = null;
    showPlace(info, d, selected, nav);
  };
  const leftBuilding = () => {
    if (!data.interior) return false;
    const s = map.sites[data.interior];
    const c = W(s.gx, s.gy, s.h * HZ + 12);
    return cam.z < home.z * 1.6 || Math.hypot(cam.x - c.x, cam.y - c.y) * cam.z > Math.min(size.w, size.h) * 0.6;
  };
  const nav = { enter, leave: () => leave(), canEnter, inside: () => data.interior };
  let lastTap = { at: 0, id: null };

  // Touch: one finger drags, two pinch; a tap picks a building, a double tap steps inside.
  const pts = new Map();
  let gesture = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    flight = null;
    gesture = { cam: { ...cam }, pts: new Map([...pts].map(([k, v]) => [k, { ...v }])), moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !gesture) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [a, b] = [...pts.values()];
    const [a0, b0] = [...gesture.pts.values()];
    if (b && b0) {
      const ratio = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, Math.hypot(a0.x - b0.x, a0.y - b0.y));
      cam.z = Math.max(home.z * 0.8, Math.min(home.z * 6, gesture.cam.z * ratio));
      gesture.moved = true;
    } else if (a0) {
      const dx = a.x - a0.x;
      const dy = a.y - a0.y;
      if (Math.hypot(dx, dy) > 6) gesture.moved = true;
      cam.x = gesture.cam.x - dx / cam.z;
      cam.y = gesture.cam.y - dy / cam.z;
    }
    if (gesture.moved && leftBuilding()) leave({ fly: false });
  });
  const end = (e) => {
    const wasTap = gesture && !gesture.moved && pts.size === 1 && cam; // before the first frame there is no camera to tap through
    pts.delete(e.pointerId);
    if (wasTap) {
      const r = canvas.getBoundingClientRect();
      const p = scene.toWorld(cam, size.w, size.h, { x: e.clientX - r.left, y: e.clientY - r.top });
      const hit = Object.entries(island.hits).find(([, b]) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1);
      selected = hit ? hit[0] : null;
      const double = selected && lastTap.id === selected && performance.now() - lastTap.at < 400;
      lastTap = { at: performance.now(), id: selected };
      if (double && canEnter(selected)) enter(selected);
      else showPlace(info, d, selected, nav);
    }
    gesture = pts.size ? { cam: { ...cam }, pts: new Map([...pts].map(([k, v]) => [k, { ...v }])), moved: true } : null;
    if (cam && island) rescale(); // a touch before the first frame has nothing to rescale yet
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // The canvas follows its box (a tablet's side pane, rotation, split screen), not only the window.
  const onResize = () => size.w && resize();
  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(onResize);
    ro.observe(wrap);
  } else window.addEventListener('resize', onResize);
  worldLoop = { raf: 0, off: () => (ro ? ro.disconnect() : window.removeEventListener('resize', onResize), scene.release(island)) };
  worldLoop.raf = requestAnimationFrame(tick);

  showPlace(info, d, null, nav);
  return [wrap, info];
}

// --------------------------------------------------------------- Architecture
// The same map as the desktop's Architecture view (renderer/js/archdraw.js draws it; the model comes
// from the computer, /api/data/arch): drag to move, pinch to zoom, tap a box for what it is and what it
// talks to, double tap to dive in. Below the map: the part you tapped, or how to read the map and the
// design principles behind it.
let archLoop = null;
function stopArch() {
  if (archLoop) cancelAnimationFrame(archLoop.raf);
  archLoop?.off?.();
  archLoop = null;
}

async function arch() {
  const { el, icon } = ctx;
  const [m, draw] = await Promise.all([ctx.api('/api/data/arch'), import('/js/archdraw.js')]);
  const { createArchScene, hexToTriplet, KINDS, LEVEL, KIND_LABEL } = draw;
  const scene = createArchScene();
  const css = getComputedStyle(document.documentElement);
  const c = (name) => hexToTriplet(css.getPropertyValue(name));
  scene.setColors({ c1: c('--accent'), c2: c('--accent2'), c3: c('--danger'), ok: c('--ok'), warn: c('--warn'), err: c('--danger'), text: c('--text'), surface: c('--surface'), bg: c('--bg'), display: 'system-ui, sans-serif', body: 'system-ui, sans-serif', mono: 'ui-monospace, "SF Mono", "Roboto Mono", monospace' });
  const fx = document.body.classList.contains('fx-hud') ? 'hud' : document.body.classList.contains('fx-subtle') ? 'subtle' : 'off';
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animated = fx === 'hud' && !still;
  scene.setFx(fx);
  scene.setAnimated(animated);
  scene.setTop(8);
  scene.load(m);

  const canvas = el('canvas', { class: 'arch-canvas', 'aria-label': 'Architecture map: drag to move, pinch to zoom, tap a part for details' });
  const crumbs = el('div', { class: 'arch-crumbs' });
  const fitBtn = el('button', { class: 'arch-tool', type: 'button', 'aria-label': 'Show everything', title: 'Show everything' }, icon('fit'));
  const learnBtn = el('button', { class: 'arch-tool', type: 'button', 'aria-label': 'How to read this map', title: 'How to read this map' }, icon('learn'));
  const wrap = el('div', { class: 'arch-wrap' }, canvas, el('div', { class: 'arch-tools' }, learnBtn, fitBtn), crumbs);
  const info = el('div', { class: 'arch-info' });
  const g = canvas.getContext('2d');
  const size = { w: 0, h: 0, dpr: 1 };
  let dirty = true;
  let lastDraw = 0;
  let lastCrumbs = '';
  const redraw = () => (dirty = true);
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    size.dpr = Math.min(window.devicePixelRatio || 1, 2);
    size.w = r.width;
    size.h = r.height;
    canvas.width = Math.round(r.width * size.dpr);
    canvas.height = Math.round(r.height * size.dpr);
    const first = !scene.size.w;
    scene.setSize(r.width, r.height);
    if (first) scene.fitAll(false);
    redraw();
    return true;
  };
  const drawCrumbs = () => {
    const path = scene.focusPath();
    const sig = path.map((n) => n.id).join('>');
    if (sig === lastCrumbs) return;
    lastCrumbs = sig;
    crumbs.replaceChildren(el('button', { type: 'button', onclick: () => home() }, ctx.state.name), ...path.flatMap((n) => [el('span', { class: 'sep' }, '›'), el('button', { type: 'button', title: LEVEL[n.level], onclick: () => dive(n) }, n.name)]));
  };
  const tick = (t) => {
    if (!canvas.isConnected) return stopArch();
    try {
      if (!size.w && !resize()) {
        archLoop.raf = requestAnimationFrame(tick);
        return;
      }
      const due = scene.moving || dirty || (animated && t - lastDraw >= 29);
      if (due) {
        lastDraw = t;
        dirty = false;
        g.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
        scene.render(g, t);
        drawCrumbs();
      }
    } catch (err) {
      stopArch();
      info.replaceChildren(empty(`The map couldn’t be drawn on this device: ${err.message}`));
      return;
    }
    archLoop.raf = requestAnimationFrame(tick);
  };

  // Moving around: fit, dive into a part, the overview card.
  const fly = (b, pad) => (scene.flyTo(b, !still, pad), redraw());
  const dive = (n) => {
    scene.selected = n;
    fly(n, n.level === 'file' ? 40 : 20);
    showArchNode(n);
  };
  const home = () => {
    scene.selected = null;
    scene.fitAll(!still);
    redraw();
    showArchHome();
  };
  const chipTo = (n, text) => el('button', { class: 'chip arch-chip', type: 'button', title: n.about || '', onclick: () => dive(n) }, text || n.name);

  function showArchHome() {
    const s = m.stats;
    const built = m.builtAt ? new Date(m.builtAt).toLocaleString() : '';
    info.replaceChildren(
      card(`${ctx.state.name}’s architecture`,
        el('p', { class: 'muted' }, `${s.containers} containers · ${s.components} components · ${s.files} files · ${s.lines.toLocaleString()} lines · ${s.connections} connections${built ? ` · built ${built}` : ''}${m.stale ? ' · the code changed since (rebuild on the computer)' : ''}`),
        el('p', {}, 'Pinch to zoom in and the parts open up: containers, then their components, then the files and what is in them. Drag to move, tap a box for what it does and what it talks to, double tap to dive in.'),
        el('div', { class: 'row' }, ask('Explain the big picture', 'Walk me through your own architecture at the top level: the containers, why they are separate, and the one idea each of them embodies.')),
      ),
      learnCard(),
    );
  }

  function learnCard() {
    return card('Reading this map',
      el('p', {}, 'It follows the C4 model: software at four zoom levels. Each level answers a different question.'),
      el('ol', { class: 'arch-c4' },
        el('li', {}, el('b', {}, 'Context'), ' — who uses the system and which outside systems it depends on.'),
        el('li', {}, el('b', {}, 'Containers'), ' — the things that run separately: processes, apps, windows, servers. Their boundaries are where security and protocols matter.'),
        el('li', {}, el('b', {}, 'Components'), ' — groups of modules with one responsibility inside a container.'),
        el('li', {}, el('b', {}, 'Code'), ' — the files and the functions in them. Bold names are a module’s public interface.'),
      ),
      el('div', { class: 'arch-kinds' }, ...Object.entries(KINDS).map(([, v]) => el('div', { class: 'arch-kindrow' }, el('b', {}, v.label), el('span', { class: 'muted' }, v.what)))),
      el('h4', {}, 'Principles in this design'),
      ...(m.principles || []).map((p) =>
        el('details', { class: 'mem' },
          el('summary', {}, el('b', {}, p.title)),
          el('p', {}, p.idea),
          el('p', { class: 'muted' }, el('b', {}, 'Why: '), p.why),
          el('p', { class: 'muted' }, el('b', {}, 'In your projects: '), p.apply),
          el('div', { class: 'row' }, ...p.where.map((id) => scene.byId.get(id)).filter(Boolean).map((n) => chipTo(n))),
        ),
      ),
      el('div', { class: 'row' }, ask('Quiz me', 'Quiz me on your own architecture, one question at a time: which part does what, why a boundary is where it is, what would break if a rule were removed. Start easy and adapt to my answers.'), ask('Design mine', 'Help me design the architecture of a project of mine, using the principles in your own design as examples. Start by asking me what I want to build, then sketch containers, components and their connections with me.')),
    );
  }

  function showArchNode(n) {
    const path = scene.ancestors(n);
    const conn = scene.connections(n);
    const link = (x) => el('button', { class: 'arch-conn', type: 'button', onclick: () => dive(x.peer) }, el('span', {}, x.peer.name), el('small', {}, `${KINDS[x.kind]?.label || x.kind}${x.count > 1 ? ` ×${x.count}` : ''}`));
    const outs = conn.filter((x) => x.dir === 'out').map(link);
    const ins = conn.filter((x) => x.dir === 'in').map(link);
    const children = scene.kids.get(n.id) || [];
    const counts = scene.counts(n);
    const links = conn.slice(0, 8).map((x) => `${x.dir === 'out' ? '→' : '←'} ${x.peer.name} (${KINDS[x.kind]?.label})`).join(', ');
    const explain = `Teach me how the ${n.path ? `file ${n.path}` : `${LEVEL[n.level].toLowerCase()} “${n.name}”`} in your own architecture works: what it is responsible for, how it talks to the rest${links ? ` (${links})` : ''}, and the design principle behind it that I could reuse in my own projects. Keep it concrete.`;
    info.replaceChildren(...[
      card(`${KIND_LABEL[n.kind]}${n.level === 'container' ? ' · C4 level 2' : n.level === 'component' ? ' · C4 level 3' : ' · C4 level 4'}`,
        el('h2', { class: 'arch-name' }, n.name),
        path.length ? el('div', { class: 'row arch-path' }, ...path.flatMap((p, i) => [i ? el('span', { class: 'muted' }, '›') : null, chipTo(p)])) : null,
        n.path && !n.path.startsWith('virtual/') ? el('code', { class: 'arch-file' }, n.path) : null,
        n.tech ? el('small', { class: 'muted' }, n.tech) : null,
        n.auto ? el('p', { class: 'muted' }, 'Found by the last rebuild; no description yet.') : null,
        el('p', {}, n.about || 'No description yet.'),
        n.lesson ? el('div', { class: 'arch-lesson' }, el('b', {}, '💡 Design note'), el('p', {}, n.lesson)) : null,
        n.level !== 'file' && children.length ? el('p', { class: 'muted' }, [[counts.comps, 'components'], [counts.files, 'files'], [counts.lines, 'lines']].filter(([v]) => v).map(([v, l]) => `${v.toLocaleString()} ${l}`).join(' · ')) : null,
        el('div', { class: 'row' }, el('button', { class: 'btn primary small', type: 'button', onclick: () => (ctx.showView('chat'), ctx.send(explain)) }, '💬 Explain this to me'), el('button', { class: 'btn small', type: 'button', onclick: () => dive(n) }, '⤢ Zoom here')),
      ),
      outs.length ? card('Talks to', ...outs) : null,
      ins.length ? card('Used by', ...ins) : null,
      children.length ? card(n.level === 'container' ? 'Components' : 'Files', el('div', { class: 'row' }, ...children.map((k) => chipTo(k)))) : null,
      n.symbols?.length ? card(`Inside (${n.symbols.length})`, el('ul', { class: 'arch-syms' }, ...n.symbols.slice(0, 40).map((s) => el('li', { class: s.exported ? 'pub' : '' }, el('span', { class: 'k' }, String(s.kind).replace('export ', '')), el('span', { class: 'n' }, s.name), el('span', { class: 'l' }, String(s.line))))), n.symbols.length > 40 ? el('p', { class: 'muted' }, `and ${n.symbols.length - 40} more`) : null) : null,
      el('button', { class: 'btn ghost small', type: 'button', onclick: home }, '‹ The whole map'),
    ].filter(Boolean));
  }

  // Touch and mouse: one finger drags (and glides on), two pinch around their midpoint, a tap picks a
  // box, a double tap dives in; a mouse wheel (DeX, a tablet keyboard with a trackpad) zooms.
  const pts = new Map();
  let gesture = null; // { pts: start positions, view: start view, moved, trail, dist }
  let lastTap = { at: 0, id: null };
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, local(e));
    scene.hold();
    gesture = { pts: new Map([...pts].map(([k, v]) => [k, { ...v }])), view: { ...scene.view }, moved: false, trail: [], dist: null };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId) || !gesture) return;
    pts.set(e.pointerId, local(e));
    const [a, b] = [...pts.values()];
    const [a0, b0] = [...gesture.pts.values()];
    if (b && b0) {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      if (gesture.dist) scene.zoomBy(mid.x, mid.y, dist / gesture.dist);
      if (gesture.mid) {
        scene.view.x += mid.x - gesture.mid.x;
        scene.view.y += mid.y - gesture.mid.y;
      }
      gesture.dist = dist;
      gesture.mid = mid;
      gesture.moved = true;
    } else if (a0) {
      const dx = a.x - a0.x;
      const dy = a.y - a0.y;
      if (Math.hypot(dx, dy) > 6) gesture.moved = true;
      if (gesture.moved) {
        scene.view.x = gesture.view.x + dx;
        scene.view.y = gesture.view.y + dy;
        gesture.trail.push({ x: a.x, y: a.y, t: performance.now() });
        if (gesture.trail.length > 6) gesture.trail.shift();
      }
    }
    redraw();
  });
  const end = (e) => {
    const was = gesture;
    const wasTap = was && !was.moved && pts.size === 1;
    const p = pts.get(e.pointerId);
    pts.delete(e.pointerId);
    if (wasTap && p) {
      const n = scene.pick(p.x, p.y);
      const double = lastTap.id === (n?.id || null) && performance.now() - lastTap.at < 400;
      lastTap = { at: performance.now(), id: n?.id || null };
      if (double) n ? dive(n) : home();
      else if (n) ((scene.selected = n), showArchNode(n));
      else ((scene.selected = null), showArchHome());
      redraw();
    } else if (was?.moved && pts.size === 0 && animated) {
      // Let go while moving: glide on.
      const t = was.trail.filter((x) => performance.now() - x.t < 80);
      if (t.length > 1) {
        const dt = Math.max(1, t[t.length - 1].t - t[0].t);
        scene.setGlide({ vx: ((t[t.length - 1].x - t[0].x) / dt) * 16, vy: ((t[t.length - 1].y - t[0].y) / dt) * 16 });
        redraw();
      }
    }
    // A finger lifted mid-pinch: the one left drags from here.
    gesture = pts.size ? { pts: new Map([...pts].map(([k, v]) => [k, { ...v }])), view: { ...scene.view }, moved: true, trail: [], dist: null } : null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    scene.zoomAt(p.x, p.y, Math.exp(-Math.max(-120, Math.min(120, dy)) * 0.0018));
    redraw();
  }, { passive: false });
  fitBtn.addEventListener('click', home);
  learnBtn.addEventListener('click', () => ((scene.selected = null), redraw(), info.replaceChildren(learnCard()), info.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'start' })));

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => size.w && resize());
    ro.observe(wrap);
  }
  archLoop = { raf: 0, off: () => ro?.disconnect() };
  archLoop.raf = requestAnimationFrame(tick);
  showArchHome();
  return [wrap, info];
}

// Below the village: today, or the building you tapped.
function showPlace(box, d, id, nav) {
  const { el } = ctx;
  const p = d.places.find((x) => x.id === id);
  if (!p) {
    const day = d.day;
    box.replaceChildren(
      day ? card(`${day.weekday}${day.weather ? ` · ${day.weather}` : ''}`, el('p', {}, day.summary), ...(day.news || []).map((n) => el('div', { class: 'li' }, `🏗 ${n}`))) : card('A new day', el('p', { class: 'muted' }, 'Today hasn’t been written yet.')),
      card('Residents', ...d.residents.map((r) => el('div', { class: 'li' }, el('b', {}, `${r.name}${r.active ? ' ★' : ''}`), el('small', { class: 'muted' }, ` · ${r.mood ? `${r.mood} · ` : ''}${r.npc ? 'villager' : 'persona'}`)))),
      day?.scenes?.length ? card('Scenes', ...day.scenes.map((s) => el('details', { class: 'mem' }, el('summary', {}, el('b', {}, s.title || 'A moment'), el('small', { class: 'muted' }, ` ${s.time}`)), ...s.lines.map((l) => el('div', { class: 'li' }, el('b', {}, `${l.who}: `), l.text)), s.outcome ? el('p', { class: 'muted' }, s.outcome) : null))) : '',
      el('p', { class: 'muted center' }, 'Tap a building to see what it shows of you.'),
    );
    return;
  }
  const inside = nav?.inside() === id;
  const door = !nav ? '' : inside ? el('button', { class: 'btn small', type: 'button', onclick: () => nav.leave() }, '← Step outside') : nav.canEnter(id) ? el('button', { class: 'btn primary small', type: 'button', onclick: () => nav.enter(id) }, '🚪 Step inside') : el('small', { class: 'muted' }, 'Not built yet: nothing to step into.');
  box.replaceChildren(
    card(`${p.icon || ''} ${p.name}`, el('small', { class: 'muted' }, `${p.stage}${p.level ? ` · level ${p.level} of 3` : ''}`), el('p', {}, p.about), el('p', { class: 'muted' }, el('b', {}, 'Grows with: '), p.hint), el('div', { class: 'row' }, door)),
    el('button', { class: 'btn ghost small', type: 'button', onclick: () => (inside && nav.leave(), showPlace(box, d, null, nav)) }, '‹ The day'),
  );
}
