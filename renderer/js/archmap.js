// Architecture view: the app's own structure on an infinite canvas (map from main/archmap.js, model in
// main/archcore.js, drawn by the pure renderer/js/archdraw.js, which the phone client shares). Semantic
// zoom, C4 style: from far away you see the containers (processes, apps, outside systems); zoom into one
// and its components appear, then their files, then each file's functions. Lines are the connections
// between whatever is visible at the current zoom (calls, IPC, events, HTTP, processes, files). Drag to
// move, wheel to zoom, click for details, double-click to dive in. Rebuild scans the code again, so the
// map follows self-changes. This module is the desktop host: the canvas, the input, the legend, the
// crumbs, the minimap and the side panel (a part's details, or Learn).
import { $, api, el, toast, toastError, on } from './util.js';
import { switchView, currentView } from './nav.js';
import { send } from './chat.js';
import { fxLevel } from './hud.js';
import { createArchScene, KINDS, LEVEL, KIND_LABEL } from './archdraw.js';

const scene = createArchScene();
let panelMode = null; // 'node' | 'learn' | null
let canvas;
let ctx;
let frame = 0;
let lastCrumbs = '';
let loading = false;
let lastDrawAt = 0;

try {
  const saved = JSON.parse(localStorage.getItem('arch.hidden') || 'null');
  if (Array.isArray(saved)) {
    scene.hidden.clear();
    saved.forEach((k) => scene.hidden.add(k));
  }
} catch {
  /* storage unavailable: defaults */
}

export function initArchMap() {
  canvas = $('#archCanvas');
  ctx = canvas.getContext('2d');
  $('#archRebuild').onclick = rebuild;
  $('#archFit').onclick = () => fitAll();
  $('#archLearn').onclick = () => (panelMode === 'learn' ? closePanel() : showLearn());
  $('#archSearch').addEventListener('change', (e) => find(e.target.value));
  new ResizeObserver(resize).observe(canvas);
  setupInput();
  setupMini();
  on('theme', () => (readColors(), draw()));
  on('settings', () => draw());
  window.addEventListener('keydown', onKey);
}

export async function refresh() {
  readColors();
  resize();
  if (scene.map || loading) return draw();
  loading = true;
  status('Reading the code…');
  try {
    load(await api.arch.get());
    fitAll(false);
  } catch (err) {
    status(`Couldn't build the map: ${err.message}`);
  } finally {
    loading = false;
  }
}

async function rebuild() {
  const btn = $('#archRebuild');
  btn.disabled = true;
  btn.textContent = '⟳ Scanning…';
  try {
    const first = !scene.map;
    const next = await api.arch.build();
    load(next);
    if (first) fitAll(false);
    const c = next.changes || {};
    if (c.first) toast('Architecture map built.');
    else if (!c.added.length && !c.removed.length) toast('Rebuilt: same parts as before (connections and sizes refreshed).');
    else toast(`Rebuilt: ${c.added.length} new part${c.added.length === 1 ? '' : 's'}${c.removed.length ? `, ${c.removed.length} gone` : ''}. New parts are marked NEW.`);
  } catch (err) {
    toastError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = '⟳ Rebuild';
  }
}

function load(next) {
  scene.setAnimated(animated());
  scene.load(next);
  const map = scene.map;
  $('#archFind').replaceChildren(...map.nodes.filter((n) => n.kind !== 'virtual').map((n) => el('option', { value: n.path || n.name })));
  legend();
  status();
  if (panelMode === 'node' && scene.selected) showNode(scene.selected);
  else if (panelMode === 'learn') showLearn();
  draw();
}

// ------------------------------------------------------------ colors (theme tokens)
function readColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  scene.setColors({
    c1: v('--c1', '0, 229, 255'),
    c2: v('--c2', '180, 90, 255'),
    c3: v('--c3', '255, 60, 172'),
    ok: v('--ok', '60, 255, 160'),
    warn: v('--warn', '255, 190, 60'),
    err: v('--err', '255, 80, 100'),
    text: v('--text-rgb', '217, 244, 255'),
    surface: v('--surface', '14, 18, 30'),
    bg: v('--bg-rgb', '10, 10, 15'),
    display: v('--font-display', 'sans-serif'),
    body: v('--font-body', 'sans-serif'),
    mono: v('--font-mono', 'monospace'),
  });
}
const animated = () => fxLevel() === 'hud' && !document.body.classList.contains('fx-still');
const still = () => document.body.classList.contains('fx-still');
const rgba = (tone, a) => scene.rgba(tone, a);

// ------------------------------------------------------------ geometry
function resize() {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const dpr = window.devicePixelRatio || 1;
  scene.setSize(r.width, r.height);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

// ------------------------------------------------------------ drawing
function draw() {
  if (frame || !ctx) return;
  frame = requestAnimationFrame(render);
}

function render(now) {
  frame = 0;
  scene.setFx(fxLevel());
  scene.setAnimated(animated());
  scene.setPanel(panelMode ? Math.min(380, scene.size.w * 0.42) + 16 : 0);
  const { moving } = scene.render(ctx, now);
  lastDrawAt = now;
  crumbs();
  mini();
  // Smooth while something moves; with HUD effects the map stays alive (packets flowing) at ~30 fps,
  // on the display's own beat (frames skipped, not delayed).
  if (moving) frame = requestAnimationFrame(render);
  else if (animated() && currentView === 'arch' && !document.hidden) frame = requestAnimationFrame(idle);
}

function idle(now) {
  frame = 0;
  if (now - lastDrawAt < 29) {
    frame = requestAnimationFrame(idle);
    return;
  }
  render(now);
}

// ------------------------------------------------------------ moving around
function flyTo(b, animate = true, pad) {
  scene.flyTo(b, animate && !still(), pad);
  draw();
}

function fitAll(animate = true) {
  scene.fitAll(animate && !still());
  draw();
}

function zoomAt(sx, sy, factor) {
  scene.zoomAt(sx, sy, factor);
  draw();
}

function setupInput() {
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, vx: scene.view.x, vy: scene.view.y, moved: false, trail: [] };
    scene.hold();
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        scene.view.x = drag.vx + dx;
        scene.view.y = drag.vy + dy;
        drag.trail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
        if (drag.trail.length > 6) drag.trail.shift();
        canvas.classList.add('panning');
        tip(null);
        return draw();
      }
    }
    const n = scene.pick(e.clientX - r.left, e.clientY - r.top);
    if (n !== scene.hovered) {
      scene.hovered = n;
      canvas.style.cursor = n ? 'pointer' : '';
      draw();
    }
    tip(n, e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('panning');
    const d = drag;
    drag = null;
    if (d?.moved) {
      // Release speed over the last ~80 ms becomes the glide (px per frame at 60 fps).
      const t = d.trail.filter((p) => performance.now() - p.t < 80);
      if (animated() && t.length > 1) {
        const dt = Math.max(1, t[t.length - 1].t - t[0].t);
        scene.setGlide({ vx: ((t[t.length - 1].x - t[0].x) / dt) * 16, vy: ((t[t.length - 1].y - t[0].y) / dt) * 16 });
        draw();
      }
      return;
    }
    if (!d) return;
    const r = canvas.getBoundingClientRect();
    select(scene.pick(e.clientX - r.left, e.clientY - r.top));
  });
  canvas.addEventListener('pointerleave', () => {
    if (scene.hovered) (scene.hovered = null), draw();
    tip(null);
  });
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const n = scene.pick(e.clientX - r.left, e.clientY - r.top);
    if (n) dive(n);
    else fitAll();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-Math.max(-120, Math.min(120, dy)) * 0.0018));
    },
    { passive: false },
  );
}

// Dive into a part: fit it to the screen, so its inside opens up.
function dive(n) {
  select(n, false);
  flyTo(n, true, n.level === 'file' ? 60 : 30);
}

function onKey(e) {
  if (currentView !== 'arch' || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || document.querySelector('.modal:not(.hidden)')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '0' || e.key === 'Home') fitAll();
  else if (e.key === '+' || e.key === '=') zoomAt(scene.availW() / 2, scene.size.h / 2, 1.4);
  else if (e.key === '-') zoomAt(scene.availW() / 2, scene.size.h / 2, 1 / 1.4);
  else if (e.key.toLowerCase() === 'l') panelMode === 'learn' ? closePanel() : showLearn();
  else if (e.key === 'Escape') {
    // Up one level from where you are.
    const path = scene.focusPath();
    const up = path.length > 1 ? path[path.length - 2] : null;
    if (panelMode) closePanel();
    if (up) dive(up);
    else fitAll();
  } else return;
  e.preventDefault();
}

function crumbs() {
  const path = scene.focusPath();
  const sig = path.map((n) => n.id).join('>');
  if (sig === lastCrumbs) return;
  lastCrumbs = sig;
  const box = $('#archCrumbs');
  box.replaceChildren(el('button', { onclick: () => fitAll() }, 'Siren'), ...path.flatMap((n) => [el('span', { class: 'sep' }, '›'), el('button', { class: `lvl-${n.level}`, title: LEVEL[n.level], onclick: () => dive(n) }, n.name)]));
}

// ------------------------------------------------------------ hover tip (only when the label is too small to read)
function tip(n, x, y) {
  const t = $('#archTip');
  if (!n) return t.classList.add('hidden');
  if (scene.legible(n)) return t.classList.add('hidden');
  t.replaceChildren(el('b', {}, n.name), el('span', {}, `${KIND_LABEL[n.kind]}${n.about ? ` — ${n.about.slice(0, 120)}${n.about.length > 120 ? '…' : ''}` : ''}`));
  t.style.left = `${Math.min(x + 14, scene.size.w - 280)}px`;
  t.style.top = `${y + 16}px`;
  t.classList.remove('hidden');
}

// ------------------------------------------------------------ minimap
function setupMini() {
  const m = $('#archMini');
  const jump = (e) => {
    if (!scene.map) return;
    const r = m.getBoundingClientRect();
    const s = scene.miniScale(r.width, r.height);
    const wx = (e.clientX - r.left - s.ox) / s.k + scene.map.bounds.x;
    const wy = (e.clientY - r.top - s.oy) / s.k + scene.map.bounds.y;
    scene.hold();
    scene.setView(scene.view.k, wx, wy);
    draw();
  };
  let down = false;
  m.addEventListener('pointerdown', (e) => ((down = true), m.setPointerCapture(e.pointerId), jump(e)));
  m.addEventListener('pointermove', (e) => down && jump(e));
  m.addEventListener('pointerup', () => (down = false));
}

function mini() {
  const m = $('#archMini');
  const r = m.getBoundingClientRect();
  if (!r.width || !scene.map) return;
  const dpr = window.devicePixelRatio || 1;
  if (m.width !== Math.round(r.width * dpr)) (m.width = Math.round(r.width * dpr)), (m.height = Math.round(r.height * dpr));
  scene.drawMini(m.getContext('2d'), r.width, r.height, dpr);
}

// ------------------------------------------------------------ legend and status
function legend() {
  const box = $('#archLegend');
  const map = scene.map;
  box.replaceChildren(
    ...Object.entries(KINDS)
      .filter(([k]) => map.edges.some((e) => e.kind === k))
      .map(([k, v]) =>
        el(
          'button',
          {
            class: `arch-kind${scene.hidden.has(k) ? ' off' : ''}`,
            title: `${v.what} Click to ${scene.hidden.has(k) ? 'show' : 'hide'}.`,
            onclick: () => {
              scene.hidden.has(k) ? scene.hidden.delete(k) : scene.hidden.add(k);
              try {
                localStorage.setItem('arch.hidden', JSON.stringify([...scene.hidden]));
              } catch {
                /* fine */
              }
              legend();
              draw();
            },
          },
          el('i', { style: { background: rgba(v.tone, 1) } }),
          v.label,
        ),
      ),
    el('span', { class: 'arch-hint' }, 'Scroll to zoom into a part · drag to move · double-click to dive in · Esc to go up'),
  );
}

function status(text) {
  const box = $('#archStatus');
  if (text) return box.replaceChildren(el('span', {}, text));
  const map = scene.map;
  const s = map.stats;
  const ago = timeSince(map.builtAt);
  box.replaceChildren(
    el('span', {}, `${s.containers} containers · ${s.components} components · ${s.files} files · ${s.lines.toLocaleString()} lines · ${s.connections} connections · built ${ago}`),
    map.stale ? el('button', { class: 'arch-stale', onclick: rebuild, title: 'Files were added or changed since this map was built' }, '● Code changed: rebuild') : '',
  );
}

function timeSince(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

// ------------------------------------------------------------ the side panel: a part's details, or Learn
function select(n, open = true) {
  scene.selected = n;
  if (n && (open || panelMode === 'node')) showNode(n);
  else if (!n && panelMode === 'node') closePanel();
  draw();
}

function closePanel() {
  panelMode = null;
  $('#archPanel').classList.add('hidden');
  draw();
}

function openPanel(mode, ...children) {
  panelMode = mode;
  const p = $('#archPanel');
  p.replaceChildren(el('button', { class: 'icon-btn arch-close', title: 'Close (Esc)', onclick: closePanel }, '✕'), ...children);
  p.classList.remove('hidden');
  p.scrollTop = 0;
  draw();
}

const chip = (n, text) => el('button', { class: 'chip', title: n.about || '', onclick: () => dive(n) }, text || n.name);

function showNode(n) {
  const path = scene.ancestors(n);
  const conn = scene.connections(n);
  const list = (dir) =>
    conn
      .filter((c) => c.dir === dir)
      .map((c) =>
        el(
          'button',
          { class: 'arch-conn', title: [...c.labels].join(', ') || KINDS[c.kind]?.what || '', onclick: () => dive(c.peer) },
          el('i', { style: { background: rgba(KINDS[c.kind]?.tone || 'text', 1) } }),
          el('span', {}, c.peer.name),
          el('small', {}, `${KINDS[c.kind]?.label || c.kind}${c.count > 1 ? ` ×${c.count}` : ''}`),
        ),
      );
  const outs = list('out');
  const ins = list('in');
  const children = scene.kids.get(n.id) || [];
  const c = scene.counts(n);
  const ask = () => {
    const links = conn.slice(0, 8).map((x) => `${x.dir === 'out' ? '→' : '←'} ${x.peer.name} (${KINDS[x.kind]?.label})`).join(', ');
    switchView('chat');
    send(`Teach me how the ${n.path ? `file ${n.path}` : `${LEVEL[n.level].toLowerCase()} “${n.name}”`} in your own architecture works: what it is responsible for, how it talks to the rest${links ? ` (${links})` : ''}, and the design principle behind it that I could reuse in my own projects. Look at the code with code_outline / reading files where it helps, and keep it concrete.`);
  };
  openPanel(
    'node',
    el('div', { class: 'arch-kicker' }, `${KIND_LABEL[n.kind]}${n.level === 'container' ? ' · C4 level 2' : n.level === 'component' ? ' · C4 level 3' : ' · C4 level 4'}`),
    el('h3', { class: 'display' }, n.name),
    path.length ? el('div', { class: 'arch-path' }, ...path.flatMap((p, i) => [i ? el('span', {}, ' › ') : '', chip(p)])) : '',
    n.path && !n.path.startsWith('virtual/') ? el('code', { class: 'arch-file' }, n.path) : '',
    n.tech ? el('div', { class: 'arch-tech' }, n.tech) : '',
    n.isNew ? el('div', { class: 'arch-note ok' }, '✦ New since the previous build.') : '',
    n.about ? el('p', {}, n.about) : el('p', { class: 'muted' }, 'No description yet.'),
    n.lesson ? el('div', { class: 'arch-lesson' }, el('b', {}, '💡 Design note'), el('p', {}, n.lesson)) : '',
    n.auto
      ? el(
          'div',
          { class: 'arch-note warn' },
          'Discovered by the last rebuild: no rule in main/archcore.js describes this part yet, so it got its own component.',
          el('button', { class: 'btn', onclick: () => (switchView('chat'), send(`The architecture map found a part it has no description for: ${n.name} (${children.map((f) => f.path).join(', ')}). Read it, then add it to COMPONENTS in main/archcore.js (in the right container, with a short about and, if there is one, a design lesson) so the Architecture view explains it.`)) }, 'Ask Nexus to describe it'),
        )
      : '',
    n.level !== 'file' && scene.kids.has(n.id) ? el('div', { class: 'arch-stats' }, ...[[c.comps, 'components'], [c.files, 'files'], [c.lines, 'lines']].filter(([v]) => v).map(([v, l]) => el('div', {}, el('b', {}, v.toLocaleString()), el('span', {}, l)))) : '',
    outs.length ? el('div', { class: 'arch-sec' }, el('h4', {}, 'Talks to'), ...outs) : '',
    ins.length ? el('div', { class: 'arch-sec' }, el('h4', {}, 'Used by'), ...ins) : '',
    children.length ? el('div', { class: 'arch-sec' }, el('h4', {}, n.level === 'container' ? 'Components' : 'Files'), el('div', { class: 'arch-chips' }, ...children.map((k) => chip(k)))) : '',
    n.symbols?.length
      ? el(
          'div',
          { class: 'arch-sec' },
          el('h4', {}, `Inside (${n.symbols.length})`),
          el('div', { class: 'hint' }, 'Bold = part of its public interface (exported); the rest is internal.'),
          el('ul', { class: 'arch-syms' }, ...n.symbols.map((s) => el('li', { class: s.exported ? 'pub' : '' }, el('span', { class: 'k' }, s.kind.replace('export ', '')), el('span', { class: 'n' }, s.name), el('span', { class: 'd' }, s.detail || ''), el('span', { class: 'l' }, String(s.line))))),
        )
      : '',
    el('div', { class: 'arch-actions' }, el('button', { class: 'btn primary', onclick: ask }, '💬 Explain this to me'), el('button', { class: 'btn', onclick: () => dive(n) }, '⤢ Zoom here')),
  );
}

function showLearn() {
  const map = scene.map;
  const s = map?.stats;
  const byIdOrNull = (id) => scene.byId.get(id);
  const exercise = (label, text) => el('button', { class: 'btn', onclick: () => (switchView('chat'), send(text)) }, label);
  openPanel(
    'learn',
    el('div', { class: 'arch-kicker' }, 'Learn'),
    el('h3', { class: 'display' }, 'Reading this map'),
    el('p', {}, 'It follows the C4 model, a common way to draw software at four zoom levels. Zoom in to go one level deeper; every level answers a different question.'),
    el(
      'ol',
      { class: 'arch-c4' },
      el('li', {}, el('b', {}, 'Context'), ' — who uses the system and which outside systems it depends on (you, AI model APIs, the vault…).'),
      el('li', {}, el('b', {}, 'Containers'), ' — the things that run separately: processes, apps, windows, servers. Boundaries between them are where security and protocols matter.'),
      el('li', {}, el('b', {}, 'Components'), ' — groups of modules with one responsibility inside a container.'),
      el('li', {}, el('b', {}, 'Code'), ' — the files and the functions in them. Bold names are a module’s public interface.'),
    ),
    el('div', { class: 'arch-sec' }, el('h4', {}, 'Kinds of connections'), ...Object.entries(KINDS).map(([, v]) => el('div', { class: 'arch-kindrow' }, el('i', { style: { background: rgba(v.tone, 1) } }), el('b', {}, v.label), el('span', {}, v.what)))),
    el('h3', { class: 'display arch-h' }, 'Principles in this design'),
    el('p', { class: 'muted' }, 'Each one is visible on the map. Click a part to fly to it.'),
    ...(map?.principles || []).map((p) =>
      el(
        'div',
        { class: 'arch-principle' },
        el('h4', {}, p.title),
        el('p', {}, p.idea),
        el('p', { class: 'why' }, el('b', {}, 'Why: '), p.why),
        el('p', { class: 'apply' }, el('b', {}, 'In your projects: '), p.apply),
        el('div', { class: 'arch-chips' }, ...p.where.map(byIdOrNull).filter(Boolean).map((n) => chip(n)), ...(p.evidence || []).slice(0, 12).map((f) => scene.byId.get(`f:${f}`)).filter(Boolean).map((n) => chip(n))),
      ),
    ),
    s?.undescribed?.length ? el('div', { class: 'arch-note warn' }, `Not described yet: ${s.undescribed.join(', ')}. Click one on the map to ask Siren to describe it.`) : '',
    el(
      'div',
      { class: 'arch-sec' },
      el('h4', {}, 'Practice'),
      el(
        'div',
        { class: 'arch-actions wrap' },
        exercise('Quiz me', 'Quiz me on your own architecture, one question at a time: which part does what, why a boundary is where it is, what would break if a rule were removed. Start easy and adapt to my answers.'),
        exercise('What if it grew 10×?', 'Thinking about your own architecture: which parts would strain first if the app grew ten times bigger (more features, more users, more integrations), and how would you restructure them? Explain the trade-offs.'),
        exercise('Design mine', 'Help me design the architecture of a project of mine, using the principles in your own design as examples. Start by asking me what I want to build, then sketch containers, components and their connections with me.'),
      ),
    ),
  );
}

function find(q) {
  const v = String(q || '').trim().toLowerCase();
  const map = scene.map;
  if (!v || !map) return;
  const n = map.nodes.find((x) => (x.path || '').toLowerCase() === v) || map.nodes.find((x) => x.name.toLowerCase() === v) || map.nodes.find((x) => (x.path || x.name).toLowerCase().includes(v));
  if (!n) return toast('No part by that name.');
  $('#archSearch').value = '';
  $('#archSearch').blur();
  dive(n);
}
