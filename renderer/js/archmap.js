// Architecture view: the app's own structure on an infinite canvas (map from main/archmap.js, model in
// main/archcore.js). Semantic zoom, C4 style: from far away you see the containers (processes, apps,
// outside systems); zoom into one and its components appear, then their files, then each file's
// functions. Lines are the connections between whatever is visible at the current zoom (calls, IPC,
// events, HTTP, processes, files). Drag to move, wheel to zoom, click for details, double-click to dive
// in. Rebuild scans the code again, so the map follows self-changes.
import { $, api, el, toast, toastError, on } from './util.js';
import { switchView, currentView } from './nav.js';
import { send } from './chat.js';
import { fxLevel } from './hud.js';

const KINDS = {
  call: { label: 'Calls', tone: 'text', what: 'One module uses another’s functions (import / require).' },
  ipc: { label: 'IPC request', tone: 'c1', what: 'The UI asks the main process to do something, through the preload bridge.' },
  event: { label: 'Event', tone: 'c2', what: 'The main process pushes news to the UI (a reply streaming in, a state change).' },
  http: { label: 'HTTP', tone: 'c3', what: 'A request over the network or a local port.' },
  process: { label: 'Process / window', tone: 'warn', what: 'Starts, hosts or opens another process or window.' },
  fs: { label: 'Files', tone: 'ok', what: 'Reads and writes files on disk.' },
  user: { label: 'Person', tone: 'text', what: 'You, using it.' },
  test: { label: 'Tests', tone: 'muted', what: 'A test exercises the module (off by default: there are many).' },
};
const LEVEL = { container: 'Container', component: 'Component', file: 'Code' };
const KIND_LABEL = { actor: 'Person', external: 'External system', system: 'Container', component: 'Component', file: 'Code', virtual: 'Code (not ours)' };
const SYM_TONE = { ipc: 'c2', tool: 'warn', class: 'c3', 'export class': 'c3', section: 'c2' };
// Screen widths (px) at which a box opens up: containers show components, components files, files symbols.
const OPEN_AT = { container: 500, component: 280, file: 220 };

let map = null;
let byId = new Map();
let kids = new Map();
let view = { x: 0, y: 0, k: 0.05 };
let selected = null;
let hovered = null;
let panelMode = null; // 'node' | 'learn' | null
let hidden = new Set(['test']);
let colors = {};
let canvas;
let ctx;
let size = { w: 0, h: 0 };
let frame = 0;
let fly = null;
let zoomTo = null; // smooth wheel zoom: { k, sx, sy }
let glideV = null; // pan inertia after a drag: { vx, vy } px per frame
let intro = 0; // when the map materialized (HUD effects), 0 when done
let lastCrumbs = '';
let loading = false;

// Line icons per container (24×24 SVG paths, stroked in the container's color).
const ICONS = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7',
  desktop: 'M3 4h18v12H3zM8 20h8M12 16v4',
  windows: 'M3 7h13v11H3zM8 3h13v11h-5M3 10h13',
  phone: 'M7 2h10v20H7zM11 18h2',
  android: 'M6 10h12v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2zM6 10a6 6 0 0 1 12 0M8 3l1.5 2.5M16 3l-1.5 2.5M10 7.5h0M14 7.5h0',
  preload: 'M2 17h20M5 17V9M19 17V9M5 9c4 4.5 10 4.5 14 0M9.5 17v-5M14.5 17v-5',
  main: 'M7 7h10v10H7zM10 10h4v4h-4zM9.5 3v4M14.5 3v4M9.5 17v4M14.5 17v4M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4',
  mcp: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5',
  quality: 'M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5zM8.5 12l2.5 2.5 4.5-5',
  'ext-web': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
  'ext-git': 'M6 3v12M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9c0 5-12 3-12 6',
  'ext-os': 'M3 4h18v16H3zM7 9l3 3-3 3M12 15h5',
  'ext-llm': 'M12 2l2.2 6.3 6.3 2.2-6.3 2.2L12 19l-2.2-6.3-6.3-2.2 6.3-2.2zM19 16l.8 2.2 2.2.8-2.2.8L19 22l-.8-2.2-2.2-.8 2.2-.8z',
  'ext-claude': 'M3 4h18v16H3zM12 8v8M8.5 10l7 4M15.5 10l-7 4',
  'ext-voice': 'M3 12h1M7 8v8M11 4v16M15 7v10M19 10v4',
  'ext-tunnel': 'M3 20v-8a9 9 0 0 1 18 0v8M7 20v-8a5 5 0 0 1 10 0v8M3 20h18',
  'ext-vault': 'M4 4h11a3 3 0 0 1 3 3v13H7a3 3 0 0 1-3-3zM4 17a3 3 0 0 1 3-3h11',
  'ext-data': 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
};
const paths = new Map();
const STORES = new Set(['c:ext-vault', 'c:ext-data']); // drawn as cylinders, the C4 shape for storage
// The far starfield behind the grid (moves slower than the map: parallax).
const STARS = Array.from({ length: 140 }, (_, i) => ({ x: (i * 0.6180339) % 1, y: (i * 0.7548776 + 0.31) % 1, r: 0.5 + ((i * 37) % 10) / 10, p: i * 1.7 }));

try {
  const saved = JSON.parse(localStorage.getItem('arch.hidden') || 'null');
  if (Array.isArray(saved)) hidden = new Set(saved);
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
  if (map || loading) return draw();
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
    const first = !map;
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
  map = next;
  byId = new Map(map.nodes.map((n) => [n.id, n]));
  kids = new Map();
  const added = new Set(map.changes?.added || []);
  for (const n of map.nodes) {
    n.isNew = !map.changes?.first && added.has(n.id);
    if (n.parent) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n);
  }
  // Containers materialize top-left to bottom-right.
  [...map.nodes.filter((n) => n.level === 'container')].sort((a, b) => a.y - b.y || a.x - b.x).forEach((n, i) => (n.order = i));
  intro = animated() ? performance.now() : 0;
  if (selected && !byId.has(selected.id)) selected = null;
  else if (selected) selected = byId.get(selected.id);
  hovered = null;
  $('#archFind').replaceChildren(...map.nodes.filter((n) => n.kind !== 'virtual').map((n) => el('option', { value: n.path || n.name })));
  legend();
  status();
  if (panelMode === 'node' && selected) showNode(selected);
  else if (panelMode === 'learn') showLearn();
  draw();
}

// ------------------------------------------------------------ colors (theme tokens)
function readColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  colors = {
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
  };
  colors.muted = colors.text;
}
const rgba = (tone, a) => `rgba(${colors[tone] || colors.text}, ${tone === 'muted' ? a * 0.45 : a})`;
const animated = () => fxLevel() === 'hud' && !document.body.classList.contains('fx-still');

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

const rect = (n) => ({ x: n.x * view.k + view.x, y: n.y * view.k + view.y, w: n.w * view.k, h: n.h * view.k });
const onScreen = (r) => r.x < size.w && r.y < size.h && r.x + r.w > 0 && r.y + r.h > 0;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// How open a box is, 0 (closed: a card with its name) to 1 (its inside shown), with a short crossfade.
function openness(n) {
  if (n.level !== 'file' && !kids.has(n.id)) return 0;
  if (n.level === 'file' && !n.symbols?.length) return 0;
  const t = OPEN_AT[n.level];
  return clamp((n.w * view.k - t * 0.9) / (t * 0.2), 0, 1);
}
const isOpen = (n) => openness(n) >= 0.5 && n.level !== 'file';
const ancestors = (n) => {
  const out = [];
  for (let p = n.parent && byId.get(n.parent); p; p = p.parent && byId.get(p.parent)) out.unshift(p);
  return out;
};
const within = (n, outer) => n === outer || ancestors(n).includes(outer);

// The box an edge end is drawn to: the outermost closed box around it.
function visibleRep(n) {
  for (const a of ancestors(n)) if (!isOpen(a)) return a;
  return n;
}

// The deepest box under a screen point.
function pick(sx, sy) {
  const inside = (n) => {
    const r = rect(n);
    return sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h;
  };
  const walk = (list) => {
    for (const n of list) {
      if (!inside(n)) continue;
      if (isOpen(n)) return walk(kids.get(n.id) || []) || n;
      return n;
    }
    return null;
  };
  return map ? walk(map.nodes.filter((n) => n.level === 'container')) : null;
}

// ------------------------------------------------------------ drawing
function draw() {
  if (frame || !ctx) return;
  frame = requestAnimationFrame(render);
}

function render(now) {
  frame = 0;
  if (fly) step(now);
  if (zoomTo) zoomStep();
  if (glideV) glide();
  ctx.clearRect(0, 0, size.w, size.h);
  if (!map || !size.w) return;
  backdrop(now);
  grid();
  for (const n of map.nodes) {
    if (n.level !== 'container') continue;
    const e = appear(n, now);
    if (e <= 0) continue;
    if (e >= 1) {
      box(n, 1);
      continue;
    }
    // Materializing: grows from 90% while it fades in.
    const r = rect(n);
    ctx.save();
    ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
    ctx.scale(0.9 + 0.1 * e, 0.9 + 0.1 * e);
    ctx.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
    box(n, e);
    ctx.restore();
  }
  edges(now, intro ? clamp((now - intro - 700) / 700, 0, 1) : 1);
  if (selected) outline(selected, 'c1', 2.5, true, now);
  if (hovered && hovered !== selected) outline(hovered, 'c1', 1.5, false, now);
  crumbs();
  mini();
  if (intro && now - intro > 2400) intro = 0;
  // Smooth while something moves; with HUD effects the map stays alive (packets flowing) at ~30 fps.
  const moving = fly || zoomTo || glideV || intro;
  if (moving) frame = requestAnimationFrame(render);
  else if (animated() && currentView === 'arch' && !document.hidden) frame = requestAnimationFrame(() => setTimeout(() => render(performance.now()), 16));
}

// How far a container has materialized (eased 0 → 1), staggered by its order.
function appear(n, now) {
  if (!intro) return 1;
  const p = clamp((now - intro - (n.order || 0) * 70) / 520, 0, 1);
  return 1 - (1 - p) ** 3;
}

// Behind everything: a vignette, a slow starfield (parallax) and, with HUD effects, a scan line.
function backdrop(now) {
  // Each gradient stays within one color: canvas blends stops un-premultiplied, so mixing the accent
  // into the background color would tint the whole canvas.
  const cx = size.w / 2;
  const cy = size.h / 2;
  const v = ctx.createRadialGradient(cx, cy, Math.min(size.w, size.h) * 0.3, cx, cy, Math.max(size.w, size.h) * 0.75);
  v.addColorStop(0, `rgba(${colors.bg}, 0)`);
  v.addColorStop(1, `rgba(${colors.bg}, 0.6)`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, size.w, size.h);
  const glowR = Math.min(size.w, size.h) * 0.55;
  const l = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
  l.addColorStop(0, rgba('c1', 0.05));
  l.addColorStop(1, rgba('c1', 0));
  ctx.fillStyle = l;
  ctx.fillRect(0, 0, size.w, size.h);
  if (fxLevel() === 'off') return;
  const live = animated();
  const W = size.w + 40;
  const H = size.h + 40;
  for (const s of STARS) {
    const x = (((s.x * W * 3 + view.x * 0.12) % W) + W) % W - 20;
    const y = (((s.y * H * 3 + view.y * 0.12) % H) + H) % H - 20;
    const a = live ? 0.25 + 0.25 * Math.sin(now * 0.0012 + s.p) : 0.35;
    ctx.fillStyle = rgba(s.r > 1.2 ? 'c2' : 'c1', a * 0.6);
    ctx.fillRect(x, y, s.r, s.r);
  }
  if (!live) return;
  const y = ((now * 0.05) % (size.h + 400)) - 200;
  const g = ctx.createLinearGradient(0, y - 90, 0, y + 90);
  g.addColorStop(0, rgba('c1', 0));
  g.addColorStop(0.5, rgba('c1', 0.045));
  g.addColorStop(1, rgba('c1', 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 90, size.w, 180);
}

function icon(name, cx, cy, s, tone, alpha = 1) {
  if (!ICONS[name]) return;
  if (!paths.has(name)) paths.set(name, new Path2D(ICONS[name]));
  ctx.save();
  ctx.translate(cx - s / 2, cy - s / 2);
  ctx.scale(s / 24, s / 24);
  ctx.strokeStyle = rgba(tone, 0.95 * alpha);
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (fxLevel() !== 'off') (ctx.shadowColor = rgba(tone, 0.8)), (ctx.shadowBlur = s * 0.25);
  ctx.stroke(paths.get(name));
  ctx.restore();
}

// The infinite canvas: a dot grid whose spacing adapts to the zoom.
function grid() {
  let s = 10;
  while (s * view.k < 28) s *= 5;
  const step = s * view.k;
  const x0 = view.x % step;
  const y0 = view.y % step;
  ctx.fillStyle = rgba('c1', 0.13);
  for (let x = x0; x < size.w; x += step) for (let y = y0; y < size.h; y += step) ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
}

function font(px, family = colors.body, weight = 400) {
  ctx.font = `${weight} ${px.toFixed(1)}px ${family}`;
}

// Lines of text that fit `max` px wide; the last one ends with … when cut.
function wrap(text, max, lines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= max || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
      if (out.length === lines) break;
    }
  }
  if (cur && out.length < lines) out.push(cur);
  if (out.length === lines && out.join(' ').length < words.join(' ').length) {
    let last = out[lines - 1];
    while (last && ctx.measureText(`${last}…`).width > max) last = last.slice(0, -1);
    out[lines - 1] = `${last}…`;
  }
  return out;
}

function fit(text, max) {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > max) t = t.slice(0, -1);
  return `${t}…`;
}

function counts(n) {
  const all = [];
  const walk = (id) => (kids.get(id) || []).forEach((c) => (all.push(c), walk(c.id)));
  walk(n.id);
  const comps = all.filter((c) => c.level === 'component').length;
  const files = all.filter((c) => c.level === 'file' && c.kind === 'file').length;
  const lines = all.reduce((s, c) => s + (c.lines || 0), 0) + (n.lines || 0);
  return { comps, files, lines };
}

function metaOf(n) {
  if (n.level === 'file') return `${n.lines ? `${n.lines.toLocaleString()} lines · ` : ''}${n.symbols.length} symbol${n.symbols.length === 1 ? '' : 's'}`;
  const c = counts(n);
  if (n.level === 'component') return `${c.files} file${c.files === 1 ? '' : 's'} · ${c.lines.toLocaleString()} lines`;
  if (!kids.has(n.id)) return n.tech || '';
  return `${c.comps} component${c.comps === 1 ? '' : 's'} · ${c.files} files${n.tech ? ` · ${n.tech}` : ''}`;
}

function box(n, alpha) {
  const r = rect(n);
  if (!onScreen(r) || r.w < 2) return;
  const t = openness(n);
  ctx.globalAlpha = alpha;
  if (n.level === 'file') fileCard(n, r, t);
  else {
    if (t < 1) closedCard(n, r, (1 - t) ** 2);
    if (t > 0) {
      openFrame(n, r, t);
      for (const c of kids.get(n.id) || []) box(c, alpha * t);
    }
  }
  if (n.isNew) {
    if (animated()) {
      const p = 0.5 + 0.5 * Math.sin(performance.now() / 260);
      ctx.beginPath();
      ctx.roundRect(r.x - 4, r.y - 4, r.w + 8, r.h + 8, radiusFor(r) + 4);
      ctx.strokeStyle = rgba('ok', 0.35 + 0.5 * p);
      ctx.lineWidth = 2;
      ctx.shadowColor = rgba('ok', 0.8);
      ctx.shadowBlur = 8 + 12 * p;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    badge(r, 'NEW', 'ok');
  }
  else if (n.auto && r.w > 90) badge(r, 'UNDESCRIBED', 'warn');
  ctx.globalAlpha = 1;
}

function badge(r, text, tone) {
  const fs = clamp(r.w * 0.035, 8, 11);
  font(fs, colors.mono, 700);
  const w = ctx.measureText(text).width + 10;
  if (w > r.w * 0.6) return;
  const x = r.x + r.w - w - 8;
  const y = r.y + 8;
  ctx.fillStyle = rgba(tone, 0.18);
  ctx.strokeStyle = rgba(tone, 0.8);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, fs + 8, 4);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = rgba(tone, 1);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 5, y + (fs + 8) / 2);
}

function radiusFor(r) {
  return clamp(Math.min(r.w, r.h) * 0.06, 2, 16);
}

// The outline of a closed box: a rounded card, or a cylinder for storage (the C4 shape for data).
function cardPath(n, r) {
  ctx.beginPath();
  if (!STORES.has(n.id)) return ctx.roundRect(r.x, r.y, r.w, r.h, radiusFor(r));
  const ry = Math.min(r.h * 0.13, r.w * 0.12);
  const cx = r.x + r.w / 2;
  ctx.ellipse(cx, r.y + ry, r.w / 2, ry, 0, Math.PI, 2 * Math.PI);
  ctx.lineTo(r.x + r.w, r.y + r.h - ry);
  ctx.ellipse(cx, r.y + r.h - ry, r.w / 2, ry, 0, 0, Math.PI);
  ctx.closePath();
}

// A closed box: a card with an icon, its kind, name, size and description, sized to the box.
function closedCard(n, r, a) {
  const base = ctx.globalAlpha;
  ctx.globalAlpha = base * a;
  const tone = n.tone || 'c1';
  const hot = hovered === n;
  const glow = fxLevel() !== 'off';
  const g = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
  g.addColorStop(0, rgba(tone, hot ? 0.26 : 0.16));
  g.addColorStop(1, rgba(tone, hot ? 0.08 : 0.03));
  cardPath(n, r);
  ctx.fillStyle = `rgba(${colors.surface}, 0.92)`;
  ctx.fill();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.setLineDash(n.kind === 'external' && !STORES.has(n.id) ? [6, 5] : n.auto ? [6, 5] : []);
  ctx.strokeStyle = rgba(tone, hot ? 1 : 0.7);
  ctx.lineWidth = n.level === 'container' ? 1.6 : 1.1;
  if (glow && n.level === 'container') (ctx.shadowColor = rgba(tone, hot ? 0.9 : 0.45)), (ctx.shadowBlur = hot ? 28 : 14);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.setLineDash([]);
  if (STORES.has(n.id)) {
    // The cylinder's front rim.
    const ry = Math.min(r.h * 0.13, r.w * 0.12);
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + ry, r.w / 2, ry, 0, 0, Math.PI);
    ctx.strokeStyle = rgba(tone, 0.55);
    ctx.lineWidth = 1.2;
    ctx.stroke();
  } else if (n.level === 'container' && glow) brackets(r, tone);
  // A sheen across the top of containers.
  if (n.level === 'container' && glow && !STORES.has(n.id)) {
    const s = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h * 0.4);
    s.addColorStop(0, `rgba(255, 255, 255, ${hot ? 0.07 : 0.04})`);
    s.addColorStop(1, 'rgba(255, 255, 255, 0)');
    cardPath(n, r);
    ctx.fillStyle = s;
    ctx.fill();
  }

  const name = n.name;
  const nameFs = Math.min((r.w * 0.86) / (Math.max(6, name.length) * 0.62), r.h * 0.2, 56);
  if (nameFs < 5) return void (ctx.globalAlpha = base);
  const kindFs = nameFs * 0.34;
  const metaFs = nameFs * 0.42;
  const aboutFs = Math.min(nameFs * 0.4, 15);
  const glyph = n.level === 'container' ? n.id.slice(2) : null;
  const iconS = glyph && ICONS[glyph] ? Math.min(nameFs * 1.7, r.h * 0.26, 64) : 0;
  const parts = [];
  if (iconS >= 12) parts.push(['icon', iconS * 1.3]);
  if (kindFs >= 7.5) parts.push(['kind', kindFs * 1.5]);
  parts.push(['name', nameFs * 1.25]);
  const meta = metaOf(n);
  if (meta && metaFs >= 8.5) parts.push(['meta', metaFs * 1.5]);
  let aboutLines = [];
  if (n.about && aboutFs >= 9.5) {
    font(aboutFs);
    const used = parts.reduce((s, p) => s + p[1], 0);
    const room = Math.floor((r.h * 0.8 - used - aboutFs) / (aboutFs * 1.35));
    if (room > 0) aboutLines = wrap(n.about, r.w * 0.82, Math.min(room, 6));
    if (aboutLines.length) parts.push(['about', aboutFs * 0.6 + aboutLines.length * aboutFs * 1.35]);
  }
  let y = r.y + (r.h - parts.reduce((s, p) => s + p[1], 0)) / 2 + (STORES.has(n.id) ? Math.min(r.h * 0.13, r.w * 0.12) / 2 : 0);
  const cx = r.x + r.w / 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [kind, h] of parts) {
    if (kind === 'icon') icon(glyph, cx, y + h / 2, iconS, tone);
    if (kind === 'kind') {
      font(kindFs, colors.mono, 700);
      ctx.fillStyle = rgba(tone, 0.85);
      ctx.fillText(KIND_LABEL[n.kind].toUpperCase().split('').join(' '), cx, y + h / 2);
    }
    if (kind === 'name') {
      font(nameFs, colors.display, 700);
      ctx.fillStyle = rgba('text', 0.96);
      ctx.shadowColor = rgba(tone, 0.6);
      ctx.shadowBlur = nameFs * 0.4;
      ctx.fillText(fit(name, r.w * 0.92), cx, y + h / 2);
      ctx.shadowBlur = 0;
    }
    if (kind === 'meta') {
      font(metaFs, colors.mono);
      ctx.fillStyle = rgba('muted', 1);
      ctx.fillText(fit(meta, r.w * 0.9), cx, y + h / 2);
    }
    if (kind === 'about') {
      font(aboutFs);
      ctx.fillStyle = rgba('text', 0.72);
      aboutLines.forEach((l, i) => ctx.fillText(l, cx, y + aboutFs * 0.6 + (i + 0.5) * aboutFs * 1.35));
    }
    y += h;
  }
  ctx.globalAlpha = base;
}

// HUD corner brackets on containers.
function brackets(r, tone) {
  const L = clamp(Math.min(r.w, r.h) * 0.08, 6, 28);
  const o = 4;
  ctx.strokeStyle = rgba(tone, 0.9);
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [x, y, dx, dy] of [[r.x - o, r.y - o, 1, 1], [r.x + r.w + o, r.y - o, -1, 1], [r.x - o, r.y + r.h + o, 1, -1], [r.x + r.w + o, r.y + r.h + o, -1, -1]]) {
    ctx.moveTo(x + dx * L, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * L);
  }
  ctx.stroke();
}

// An open box: a frame with a header (name, what it is); its children are drawn inside.
function openFrame(n, r, a) {
  const base = ctx.globalAlpha;
  ctx.globalAlpha = base * a;
  const tone = n.tone || 'c1';
  const rad = radiusFor(r);
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, rad);
  ctx.fillStyle = rgba(tone, n.level === 'container' ? 0.035 : 0.06);
  ctx.fill();
  ctx.setLineDash(n.auto ? [6, 5] : []);
  ctx.strokeStyle = rgba(tone, n.level === 'container' ? 0.55 : 0.4);
  ctx.lineWidth = n.level === 'container' ? 1.5 : 1;
  ctx.stroke();
  ctx.setLineDash([]);
  if (n.level === 'container' && fxLevel() !== 'off') brackets(r, tone);
  const head = (n.head || 40) * view.k;
  // Header band
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, head, [rad, rad, 0, 0]);
  ctx.clip();
  const g = ctx.createLinearGradient(r.x, r.y, r.x + r.w, r.y);
  g.addColorStop(0, rgba(tone, 0.2));
  g.addColorStop(1, rgba(tone, 0.02));
  ctx.fillStyle = g;
  ctx.fillRect(r.x, r.y, r.w, head);
  ctx.restore();
  const pad = Math.max(8, head * 0.32);
  const nameFs = clamp(head * 0.36, 0, 34);
  if (nameFs >= 6) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const withAbout = head * 0.2 >= 9 && n.about;
    const y1 = r.y + head * (withAbout ? 0.38 : 0.5);
    font(nameFs, colors.display, 700);
    ctx.fillStyle = rgba('text', 0.95);
    const label = fit(n.name, r.w - pad * 2);
    ctx.fillText(label, r.x + pad, y1);
    const after = r.x + pad + ctx.measureText(label).width + nameFs * 0.6;
    font(nameFs * 0.5, colors.mono);
    ctx.fillStyle = rgba(tone, 0.85);
    const meta = metaOf(n);
    if (after + 40 < r.x + r.w - pad) ctx.fillText(fit(meta, r.x + r.w - pad - after), after, y1 + nameFs * 0.05);
    if (withAbout) {
      font(head * 0.2);
      ctx.fillStyle = rgba('text', 0.65);
      ctx.fillText(fit(n.about, r.w - pad * 2), r.x + pad, r.y + head * 0.74);
    }
  }
  ctx.globalAlpha = base;
}

// A file: name and description always; its functions appear as you zoom in.
function fileCard(n, r, t) {
  const tone = n.tone || 'c1';
  const rad = radiusFor(r);
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.w, r.h, rad);
  ctx.fillStyle = `rgba(${colors.surface}, 0.94)`;
  ctx.fill();
  ctx.setLineDash(n.kind === 'virtual' ? [5, 4] : []);
  ctx.strokeStyle = rgba(tone, 0.45);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  // Accent strip on the left
  ctx.fillStyle = rgba(tone, 0.75);
  ctx.fillRect(r.x, r.y + rad, Math.max(1.5, r.w * 0.008), Math.max(0, r.h - 2 * rad));
  const k = view.k;
  const fs = r.w * 0.052;
  if (fs < 4.5) return;
  const pad = r.w * 0.05;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  font(fs, colors.mono, 700);
  ctx.fillStyle = rgba('text', 0.96);
  ctx.fillText(fit(n.name, r.w * 0.62), r.x + pad, r.y + 18 * k);
  if (n.lines) {
    font(fs * 0.72, colors.mono);
    ctx.fillStyle = rgba('muted', 1);
    ctx.textAlign = 'right';
    ctx.fillText(`${n.lines} ln`, r.x + r.w - pad, r.y + 18 * k);
    ctx.textAlign = 'left';
  }
  if (fs * 0.78 >= 6 && n.about) {
    font(fs * 0.78);
    ctx.fillStyle = rgba('text', 0.66);
    wrap(n.about, r.w - pad * 2, 3).forEach((l, i) => ctx.fillText(l, r.x + pad, r.y + (38 + i * 14) * k));
  }
  if (t <= 0) return;
  const { fileHead, symRow, maxRows } = map.sizes;
  const base = ctx.globalAlpha;
  ctx.globalAlpha = base * t;
  ctx.strokeStyle = rgba(tone, 0.2);
  ctx.beginPath();
  ctx.moveTo(r.x + pad, r.y + (fileHead - 4) * k);
  ctx.lineTo(r.x + r.w - pad, r.y + (fileHead - 4) * k);
  ctx.stroke();
  const sfs = symRow * k * 0.62;
  const rows = n.symbols.slice(0, maxRows);
  rows.forEach((s, i) => {
    const y = r.y + (fileHead + 6 + i * symRow + symRow / 2) * k;
    const st = s.exported ? 'ok' : SYM_TONE[s.kind] || 'muted';
    ctx.fillStyle = rgba(st, s.exported || SYM_TONE[s.kind] ? 0.95 : 1);
    ctx.beginPath();
    ctx.arc(r.x + pad + sfs * 0.3, y, sfs * 0.24, 0, Math.PI * 2);
    ctx.fill();
    font(sfs, colors.mono, s.exported ? 700 : 400);
    ctx.fillStyle = rgba('text', s.exported ? 0.95 : 0.75);
    const x = r.x + pad + sfs * 1.0;
    const label = s.kind === 'ipc' || s.kind === 'tool' || s.kind === 'section' ? `${s.kind} ${s.name}` : s.name;
    const shown = fit(label, r.w - pad * 2 - sfs * 3.2);
    ctx.fillText(shown, x, y);
    if (s.detail) {
      const w = ctx.measureText(shown).width;
      font(sfs * 0.9, colors.mono);
      ctx.fillStyle = rgba('muted', 1);
      ctx.fillText(fit(s.detail, Math.max(0, r.w - pad * 2 - sfs * 3.2 - w)), x + w, y);
    }
    font(sfs * 0.8, colors.mono);
    ctx.fillStyle = rgba('muted', 0.8);
    ctx.textAlign = 'right';
    ctx.fillText(String(s.line), r.x + r.w - pad, y);
    ctx.textAlign = 'left';
  });
  if (n.symbols.length > maxRows) {
    font(sfs * 0.9, colors.mono);
    ctx.fillStyle = rgba(tone, 0.85);
    ctx.fillText(`+ ${n.symbols.length - maxRows} more (click for all)`, r.x + pad + sfs, r.y + (fileHead + 6 + maxRows * symRow + symRow / 2) * k);
  }
  ctx.globalAlpha = base;
}

// Hover and selection rings; the selection breathes with HUD effects.
function outline(n, tone, width, glow, now) {
  const r = rect(n);
  if (!onScreen(r)) return;
  const pulse = glow && animated() ? 0.5 + 0.5 * Math.sin(now / 320) : 1;
  ctx.beginPath();
  ctx.roundRect(r.x - 3, r.y - 3, r.w + 6, r.h + 6, radiusFor(r) + 3);
  ctx.strokeStyle = rgba(tone, glow ? 0.65 + 0.35 * pulse : 0.7);
  ctx.lineWidth = width;
  if (glow) (ctx.shadowColor = rgba(tone, 0.9)), (ctx.shadowBlur = 10 + 14 * pulse);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// ------------------------------------------------------------ connections
function edges(now, fade = 1) {
  if (fade <= 0) return false;
  const focus = hovered || selected;
  const agg = new Map();
  for (const e of map.edges) {
    if (hidden.has(e.kind)) continue;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const ra = visibleRep(a);
    const rb = visibleRep(b);
    if (ra === rb || within(ra, rb) || within(rb, ra)) continue;
    const key = `${ra.id}|${rb.id}|${e.kind}`;
    const x = agg.get(key);
    if (x) x.count += e.count;
    else agg.set(key, { a: ra, b: rb, kind: e.kind, count: e.count, label: e.labels[0] || '' });
  }
  const list = [...agg.values()];
  // An open box in focus: only what crosses its edge (its inside talks to itself all the time).
  const open = focus && isOpen(focus);
  const touches = (x) => focus && (open ? within(x.a, focus) !== within(x.b, focus) : within(x.a, focus) || within(x.b, focus) || within(focus, x.a) || within(focus, x.b));
  // Faint ones first, highlighted ones on top.
  list.sort((p, q) => Number(touches(p)) - Number(touches(q)));
  let flowing = false;
  const labels = [];
  for (const x of list) {
    const hot = touches(x);
    if (hot) flowing = true;
    const curve = route(rect(x.a), rect(x.b));
    if (!curve) continue;
    const tone = KINDS[x.kind]?.tone || 'text';
    const alpha = (focus ? (hot ? 0.95 : 0.06) : x.kind === 'call' ? 0.22 : 0.5) * fade;
    const width = clamp(1 + Math.log2(x.count) * 0.7, 1, 5) * (hot ? 1.3 : 1);
    // Fainter where it leaves, brighter where it arrives: the direction reads at a glance.
    const g = ctx.createLinearGradient(curve[0], curve[1], curve[6], curve[7]);
    g.addColorStop(0, rgba(tone, alpha * 0.35));
    g.addColorStop(1, rgba(tone, alpha));
    ctx.strokeStyle = g;
    ctx.lineWidth = width;
    if (hot && fxLevel() !== 'off') (ctx.shadowColor = rgba(tone, 0.8)), (ctx.shadowBlur = 8);
    ctx.beginPath();
    ctx.moveTo(curve[0], curve[1]);
    ctx.bezierCurveTo(curve[2], curve[3], curve[4], curve[5], curve[6], curve[7]);
    ctx.stroke();
    ctx.shadowBlur = 0;
    arrow(curve, rgba(tone, alpha), 5 + width * 1.5);
    if (animated() && fade >= 1 && (!focus || hot)) packets(curve, x, tone, hot, now);
    if (hot) labels.push({ x, curve, tone });
  }
  // A few labels, biggest first, never on top of each other.
  const placed = [];
  for (const l of labels.sort((p, q) => q.x.count - p.x.count).slice(0, 12)) edgeLabel(l.x, l.curve, l.tone, placed);
  return flowing;
}

// A curve from box A to box B: leaves and enters on the facing sides, aimed at the other box.
function route(a, b) {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h));
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
  let p;
  if (gapY >= gapX) {
    const down = bcy > acy;
    const ax = clamp(bcx, a.x + a.w * 0.15, a.x + a.w * 0.85);
    const bx = clamp(acx, b.x + b.w * 0.15, b.x + b.w * 0.85);
    const ay = down ? a.y + a.h : a.y;
    const by = down ? b.y : b.y + b.h;
    const d = Math.max(30, Math.abs(by - ay) * 0.45) * (down ? 1 : -1);
    p = [ax, ay, ax, ay + d, bx, by - d, bx, by];
  } else {
    const right = bcx > acx;
    const ay = clamp(bcy, a.y + a.h * 0.15, a.y + a.h * 0.85);
    const by = clamp(acy, b.y + b.h * 0.15, b.y + b.h * 0.85);
    const ax = right ? a.x + a.w : a.x;
    const bx = right ? b.x : b.x + b.w;
    const d = Math.max(30, Math.abs(bx - ax) * 0.45) * (right ? 1 : -1);
    p = [ax, ay, ax + d, ay, bx - d, by, bx, by];
  }
  const xs = [p[0], p[2], p[4], p[6]];
  const ys = [p[1], p[3], p[5], p[7]];
  if (Math.max(...xs) < 0 || Math.min(...xs) > size.w || Math.max(...ys) < 0 || Math.min(...ys) > size.h) return null;
  return p;
}

// A point on the cubic curve c = [x0, y0, cx1, cy1, cx2, cy2, x1, y1] at t (0..1).
function bez(c, t) {
  const m = 1 - t;
  const a = m * m * m;
  const b = 3 * m * m * t;
  const d = 3 * m * t * t;
  const e = t * t * t;
  return [a * c[0] + b * c[2] + d * c[4] + e * c[6], a * c[1] + b * c[3] + d * c[5] + e * c[7]];
}

// Data packets travelling along a connection: more of them on busier ones, faster when highlighted.
function packets(c, x, tone, hot, now) {
  const len = Math.hypot(c[6] - c[0], c[7] - c[1]) * 1.15 + 1;
  const n = hot ? clamp(2 + Math.floor(Math.log2(x.count)), 2, 7) : clamp(1 + Math.floor(Math.log2(x.count) / 2), 1, 3);
  const speed = hot ? 0.16 : 0.07; // px per ms
  let seed = 0;
  for (const ch of `${x.a.id}${x.b.id}${x.kind}`) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  const r = hot ? 2.6 : 1.7;
  for (let i = 0; i < n; i++) {
    const t = ((now * speed) / len + i / n + seed / 997) % 1;
    const [px, py] = bez(c, t);
    if (px < -10 || py < -10 || px > size.w + 10 || py > size.h + 10) continue;
    const fadeEnds = Math.min(1, t * 8, (1 - t) * 8);
    ctx.fillStyle = rgba(tone, 0.22 * fadeEnds);
    ctx.beginPath();
    ctx.arc(px, py, r * 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255, 255, 255, ${0.9 * fadeEnds})`;
    ctx.beginPath();
    ctx.arc(px, py, r * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(tone, fadeEnds);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function arrow(c, color, s) {
  const ang = Math.atan2(c[7] - c[5], c[6] - c[4]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(c[6], c[7]);
  ctx.lineTo(c[6] - s * Math.cos(ang - 0.4), c[7] - s * Math.sin(ang - 0.4));
  ctx.lineTo(c[6] - s * Math.cos(ang + 0.4), c[7] - s * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
}

function edgeLabel(x, c, tone, placed) {
  const [px, py] = bez(c, 0.5);
  const text = `${KINDS[x.kind]?.label || x.kind}${x.count > 1 ? ` ×${x.count}` : ''}${x.label ? ` · ${x.label}` : ''}`;
  font(11, colors.mono);
  const shown = fit(text, 280);
  const w = ctx.measureText(shown).width + 12;
  const box = { x: px - w / 2 - 4, y: py - 14, w: w + 8, h: 28 };
  if (placed.some((b) => box.x < b.x + b.w && b.x < box.x + box.w && box.y < b.y + b.h && b.y < box.y + box.h)) return;
  placed.push(box);
  ctx.fillStyle = `rgba(${colors.bg}, 0.92)`;
  ctx.strokeStyle = rgba(tone, 0.8);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(px - w / 2, py - 10, w, 20, 10);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = rgba(tone, 1);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(shown, px, py);
}

// ------------------------------------------------------------ moving around
// The legend floats over the top of the canvas; centering and fitting use the space below it.
const TOP = 64;
function setView(k, cx, cy) {
  view.k = k;
  view.x = availW() / 2 - cx * k;
  view.y = TOP + (size.h - TOP) / 2 - cy * k;
}
const availW = () => size.w - (panelMode ? Math.min(380, size.w * 0.42) + 16 : 0);
const minK = () => (map ? Math.min(availW() / map.bounds.w, size.h / map.bounds.h) * 0.4 : 0.01);

function targetFor(b, pad = 40) {
  const k = clamp(Math.min((availW() - pad * 2) / b.w, (size.h - TOP - pad * 2) / b.h), minK(), 6);
  return { k, cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
}

function flyTo(b, animate = true, pad) {
  if (!size.w) return;
  const to = targetFor(b, pad);
  // Diving into a part zooms at least far enough for its inside to show.
  if (OPEN_AT[b.level] && b.w) to.k = Math.min(6, Math.max(to.k, (OPEN_AT[b.level] * 1.12) / b.w));
  const from = { k: view.k, cx: (availW() / 2 - view.x) / view.k, cy: (TOP + (size.h - TOP) / 2 - view.y) / view.k };
  if (!animate || document.body.classList.contains('fx-still')) {
    setView(to.k, to.cx, to.cy);
    return draw();
  }
  fly = { from, to, start: performance.now(), ms: 650 };
  draw();
}

function step(now) {
  const p = clamp((now - fly.start) / fly.ms, 0, 1);
  const e = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
  const { from, to } = fly;
  // Zoom moves in log space so it feels even; the center follows in screen-sized steps.
  const k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
  setView(k, from.cx + (to.cx - from.cx) * e, from.cy + (to.cy - from.cy) * e);
  if (p >= 1) fly = null;
}

function fitAll(animate = true) {
  if (map) flyTo(map.bounds, animate, 30);
}

// Zoom by a factor around a screen point (that point stays put).
function zoomBy(sx, sy, factor) {
  const k = clamp(view.k * factor, minK(), 6);
  const wx = (sx - view.x) / view.k;
  const wy = (sy - view.y) / view.k;
  view.k = k;
  view.x = sx - wx * k;
  view.y = sy - wy * k;
}

// With motion on, the zoom eases toward its target over a few frames; otherwise it jumps.
function zoomAt(sx, sy, factor) {
  fly = null;
  glideV = null;
  if (!animated()) return zoomBy(sx, sy, factor), draw();
  zoomTo = { k: clamp((zoomTo?.k || view.k) * factor, minK(), 6), sx, sy };
  draw();
}

function zoomStep() {
  const ratio = zoomTo.k / view.k;
  if (Math.abs(Math.log(ratio)) < 0.003) return zoomBy(zoomTo.sx, zoomTo.sy, ratio), (zoomTo = null);
  zoomBy(zoomTo.sx, zoomTo.sy, ratio ** 0.25);
}

// Pan inertia: the map keeps sliding after a quick drag and slows down.
function glide() {
  view.x += glideV.vx;
  view.y += glideV.vy;
  glideV.vx *= 0.92;
  glideV.vy *= 0.92;
  if (Math.hypot(glideV.vx, glideV.vy) < 0.25) glideV = null;
}

function setupInput() {
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, trail: [] };
    fly = null;
    zoomTo = null;
    glideV = null;
  });
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    if (drag) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) {
        view.x = drag.vx + dx;
        view.y = drag.vy + dy;
        drag.trail.push({ x: e.clientX, y: e.clientY, t: performance.now() });
        if (drag.trail.length > 6) drag.trail.shift();
        canvas.classList.add('panning');
        tip(null);
        return draw();
      }
    }
    const n = pick(e.clientX - r.left, e.clientY - r.top);
    if (n !== hovered) {
      hovered = n;
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
        const v = { vx: ((t[t.length - 1].x - t[0].x) / dt) * 16, vy: ((t[t.length - 1].y - t[0].y) / dt) * 16 };
        if (Math.hypot(v.vx, v.vy) > 2) (glideV = v), draw();
      }
      return;
    }
    if (!d) return;
    const r = canvas.getBoundingClientRect();
    const n = pick(e.clientX - r.left, e.clientY - r.top);
    select(n);
  });
  canvas.addEventListener('pointerleave', () => {
    if (hovered) (hovered = null), draw();
    tip(null);
  });
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const n = pick(e.clientX - r.left, e.clientY - r.top);
    if (n) dive(n);
    else fitAll();
  });
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-clamp(dy, -120, 120) * 0.0018));
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
  else if (e.key === '+' || e.key === '=') zoomAt(availW() / 2, size.h / 2, 1.4);
  else if (e.key === '-') zoomAt(availW() / 2, size.h / 2, 1 / 1.4);
  else if (e.key.toLowerCase() === 'l') panelMode === 'learn' ? closePanel() : showLearn();
  else if (e.key === 'Escape') {
    // Up one level from where you are.
    const path = focusPath();
    const up = path.length > 1 ? path[path.length - 2] : null;
    if (panelMode) closePanel();
    if (up) dive(up);
    else fitAll();
  } else return;
  e.preventDefault();
}

// The open boxes around the middle of the screen: where you are.
function focusPath() {
  if (!map) return [];
  const cx = availW() / 2;
  const cy = TOP + (size.h - TOP) / 2;
  const path = [];
  let list = map.nodes.filter((n) => n.level === 'container');
  for (;;) {
    const n = list.find((x) => {
      const r = rect(x);
      return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
    });
    if (!n) break;
    path.push(n);
    if (!isOpen(n) && !(n.level === 'file')) break;
    list = kids.get(n.id) || [];
    if (!list.length) break;
  }
  return path;
}

function crumbs() {
  const path = focusPath();
  const sig = path.map((n) => n.id).join('>');
  if (sig === lastCrumbs) return;
  lastCrumbs = sig;
  const box = $('#archCrumbs');
  box.replaceChildren(el('button', { onclick: () => fitAll() }, 'Nexus'), ...path.flatMap((n) => [el('span', { class: 'sep' }, '›'), el('button', { class: `lvl-${n.level}`, title: LEVEL[n.level], onclick: () => dive(n) }, n.name)]));
}

// ------------------------------------------------------------ hover tip (only when the label is too small to read)
function tip(n, x, y) {
  const t = $('#archTip');
  if (!n) return t.classList.add('hidden');
  const r = rect(n);
  const legible = n.level === 'file' ? r.w * 0.052 >= 9 : isOpen(n) ? (n.head || 40) * view.k * 0.36 >= 9 : Math.min((r.w * 0.86) / (Math.max(6, n.name.length) * 0.62), r.h * 0.2) >= 10;
  if (legible) return t.classList.add('hidden');
  t.replaceChildren(el('b', {}, n.name), el('span', {}, `${KIND_LABEL[n.kind]}${n.about ? ` — ${n.about.slice(0, 120)}${n.about.length > 120 ? '…' : ''}` : ''}`));
  t.style.left = `${Math.min(x + 14, size.w - 280)}px`;
  t.style.top = `${y + 16}px`;
  t.classList.remove('hidden');
}

// ------------------------------------------------------------ minimap
function setupMini() {
  const m = $('#archMini');
  const jump = (e) => {
    if (!map) return;
    const r = m.getBoundingClientRect();
    const s = miniScale(r.width, r.height);
    const wx = (e.clientX - r.left - s.ox) / s.k + map.bounds.x;
    const wy = (e.clientY - r.top - s.oy) / s.k + map.bounds.y;
    fly = null;
    setView(view.k, wx, wy);
    draw();
  };
  let down = false;
  m.addEventListener('pointerdown', (e) => ((down = true), m.setPointerCapture(e.pointerId), jump(e)));
  m.addEventListener('pointermove', (e) => down && jump(e));
  m.addEventListener('pointerup', () => (down = false));
}

function miniScale(w, h) {
  const pad = 8;
  const k = Math.min((w - pad * 2) / map.bounds.w, (h - pad * 2) / map.bounds.h);
  return { k, ox: (w - map.bounds.w * k) / 2, oy: (h - map.bounds.h * k) / 2 };
}

function mini() {
  const m = $('#archMini');
  const r = m.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  if (m.width !== Math.round(r.width * dpr)) (m.width = Math.round(r.width * dpr)), (m.height = Math.round(r.height * dpr));
  const c = m.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, r.width, r.height);
  const s = miniScale(r.width, r.height);
  const X = (x) => (x - map.bounds.x) * s.k + s.ox;
  const Y = (y) => (y - map.bounds.y) * s.k + s.oy;
  for (const n of map.nodes.filter((x) => x.level === 'container')) {
    c.fillStyle = rgba(n.tone, selected && within(selected, n) ? 0.55 : 0.22);
    c.fillRect(X(n.x), Y(n.y), Math.max(1, n.w * s.k), Math.max(1, n.h * s.k));
  }
  const vx = -view.x / view.k;
  const vy = -view.y / view.k;
  const vw = (availW() / view.k) * s.k;
  const vh = (size.h / view.k) * s.k;
  c.fillStyle = rgba('c1', 0.08);
  c.fillRect(X(vx), Y(vy), vw, vh);
  c.strokeStyle = rgba('c1', 0.95);
  c.lineWidth = 1.5;
  if (fxLevel() !== 'off') (c.shadowColor = rgba('c1', 0.9)), (c.shadowBlur = 6);
  c.strokeRect(X(vx), Y(vy), vw, vh);
  c.shadowBlur = 0;
}

// ------------------------------------------------------------ legend and status
function legend() {
  const box = $('#archLegend');
  box.replaceChildren(
    ...Object.entries(KINDS)
      .filter(([k]) => map.edges.some((e) => e.kind === k))
      .map(([k, v]) =>
        el(
          'button',
          {
            class: `arch-kind${hidden.has(k) ? ' off' : ''}`,
            title: `${v.what} Click to ${hidden.has(k) ? 'show' : 'hide'}.`,
            onclick: () => {
              hidden.has(k) ? hidden.delete(k) : hidden.add(k);
              try {
                localStorage.setItem('arch.hidden', JSON.stringify([...hidden]));
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
  selected = n;
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

// What a part connects to, seen at its own level: other components in the same container, other
// containers outside it.
function connections(n) {
  const peerOf = (other) => {
    const chain = [...ancestors(other), other];
    const mine = [...ancestors(n), n];
    for (let i = 0; i < chain.length; i++) if (chain[i] !== mine[i]) return chain[i];
    return null;
  };
  const out = new Map();
  for (const e of map.edges) {
    if (hidden.has(e.kind) && e.kind === 'test') continue;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const ina = within(a, n);
    const inb = within(b, n);
    if (ina === inb) continue;
    const peer = peerOf(ina ? b : a);
    if (!peer) continue;
    const key = `${ina ? 'out' : 'in'}|${peer.id}|${e.kind}`;
    const x = out.get(key) || { dir: ina ? 'out' : 'in', peer, kind: e.kind, count: 0, labels: new Set() };
    x.count += e.count;
    e.labels.forEach((l) => x.labels.add(l));
    out.set(key, x);
  }
  return [...out.values()].sort((p, q) => q.count - p.count);
}

function showNode(n) {
  const path = ancestors(n);
  const conn = connections(n);
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
  const children = kids.get(n.id) || [];
  const c = counts(n);
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
    n.level !== 'file' && kids.has(n.id) ? el('div', { class: 'arch-stats' }, ...[[c.comps, 'components'], [c.files, 'files'], [c.lines, 'lines']].filter(([v]) => v).map(([v, l]) => el('div', {}, el('b', {}, v.toLocaleString()), el('span', {}, l)))) : '',
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
  const s = map?.stats;
  const byIdOrNull = (id) => byId.get(id);
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
        el('div', { class: 'arch-chips' }, ...p.where.map(byIdOrNull).filter(Boolean).map((n) => chip(n)), ...(p.evidence || []).slice(0, 12).map((f) => byId.get(`f:${f}`)).filter(Boolean).map((n) => chip(n))),
      ),
    ),
    s?.undescribed?.length ? el('div', { class: 'arch-note warn' }, `Not described yet: ${s.undescribed.join(', ')}. Click one on the map to ask Nexus to describe it.`) : '',
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
  if (!v || !map) return;
  const n = map.nodes.find((x) => (x.path || '').toLowerCase() === v) || map.nodes.find((x) => x.name.toLowerCase() === v) || map.nodes.find((x) => (x.path || x.name).toLowerCase().includes(v));
  if (!n) return toast('No part by that name.');
  $('#archSearch').value = '';
  $('#archSearch').blur();
  dive(n);
}
