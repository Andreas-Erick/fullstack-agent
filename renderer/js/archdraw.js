// The architecture map's drawing and geometry (pure: no DOM beyond the canvas context it is handed, no
// app imports), so the same map draws in the desktop's Architecture view (renderer/js/archmap.js, which
// adds the panels, legend, crumbs and keyboard) and on a phone or tablet (renderer/remote/screens.js,
// served by the companion server). The model comes from main/archcore.js: nodes (containers,
// components, files) with world positions, and edges between them.
//
// Semantic zoom, C4 style: from far away the containers (processes, apps, outside systems); zoom into
// one and its components appear, then their files, then each file's functions. Lines are the
// connections between whatever is visible at the current zoom.

export const KINDS = {
  call: { label: 'Calls', tone: 'text', what: 'One module uses another’s functions (import / require).' },
  ipc: { label: 'IPC request', tone: 'c1', what: 'The UI asks the main process to do something, through the preload bridge.' },
  event: { label: 'Event', tone: 'c2', what: 'The main process pushes news to the UI (a reply streaming in, a state change).' },
  http: { label: 'HTTP', tone: 'c3', what: 'A request over the network or a local port.' },
  process: { label: 'Process / window', tone: 'warn', what: 'Starts, hosts or opens another process or window.' },
  fs: { label: 'Files', tone: 'ok', what: 'Reads and writes files on disk.' },
  user: { label: 'Person', tone: 'text', what: 'You, using it.' },
  link: { label: 'Links', tone: 'c2', what: 'A note links to another note ([[wikilink]]; the vault map).' },
  test: { label: 'Tests', tone: 'muted', what: 'A test exercises the module (off by default: there are many).' },
};
export const LEVEL = { container: 'Container', component: 'Component', file: 'Code' };
export const KIND_LABEL = { actor: 'Person', external: 'External system', system: 'Container', component: 'Component', file: 'Code', virtual: 'Code (not ours)' };
const SYM_TONE = { ipc: 'c2', tool: 'warn', class: 'c3', 'export class': 'c3', section: 'c2' };
// Screen widths (px) at which a box opens up: containers show components, components files, files symbols.
export const OPEN_AT = { container: 500, component: 280, file: 220 };

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
const STORES = new Set(['c:ext-vault', 'c:ext-data']); // drawn as cylinders, the C4 shape for storage
// The far starfield behind the grid (moves slower than the map: parallax).
const STARS = Array.from({ length: 140 }, (_, i) => ({ x: (i * 0.6180339) % 1, y: (i * 0.7548776 + 0.31) % 1, r: 0.5 + ((i * 37) % 10) / 10, p: i * 1.7 }));

// Colors as "r, g, b" triplets (the host reads them from its theme) and font families.
export const DEFAULT_COLORS = { c1: '0, 229, 255', c2: '180, 90, 255', c3: '255, 60, 172', ok: '60, 255, 160', warn: '255, 190, 60', err: '255, 80, 100', text: '217, 244, 255', surface: '14, 18, 30', bg: '10, 10, 15', display: 'sans-serif', body: 'sans-serif', mono: 'monospace' };

/** "#00e5ff" → "0, 229, 255" (the phone's theme gives hex colors). */
export function hexToTriplet(hex, fallback = '217, 244, 255') {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
  return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : fallback;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * One map on one canvas. The host owns the canvas, the input and the redraw timing: it calls render()
 * when something changed (and keeps calling it while render() reports motion), hands pointer positions
 * to pick(), moves the camera with flyTo / zoomAt / view, and reads selection details for its panels.
 */
export function createArchScene() {
  let map = null;
  let byId = new Map();
  let kids = new Map();
  const view = { x: 0, y: 0, k: 0.05 };
  const size = { w: 0, h: 0 };
  let colors = { ...DEFAULT_COLORS, muted: DEFAULT_COLORS.text };
  const hidden = new Set(['test']);
  let selected = null;
  let hovered = null;
  let fx = 'hud'; // hud | subtle | off: glows and brackets (off = plain lines)
  let anim = true; // packets flow, the selection breathes, containers materialize
  let panelW = 0; // a side panel on the right takes this much; the map centers in the rest
  let top = 64; // kept clear at the top (a legend floats there)
  let ctx = null;
  let fly = null;
  let zoomTo = null; // smooth wheel zoom: { k, sx, sy }
  let glideV = null; // pan inertia after a drag: { vx, vy } px per frame
  let intro = 0; // when the map materialized (with motion), 0 when done
  const paths = new Map();
  // A history replay (renderer/js/replay.js): which files exist at the replayed moment, how warm each
  // one is after its last change (1 → 0), its line count then; null when not replaying.
  let replay = null; // { present: Set<path>, heat: Map<path, 0..1>, lines: Map<path, n>, tone }
  let presentIds = null; // node ids with a present file inside (containers, components) or present (files)

  function load(next) {
    map = next;
    replay = null;
    presentIds = null;
    byId = new Map(map.nodes.map((n) => [n.id, n]));
    kids = new Map();
    const added = new Set(map.changes?.added || []);
    for (const n of map.nodes) {
      n.isNew = !map.changes?.first && added.has(n.id);
      if (n.parent) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n);
    }
    // Containers materialize top-left to bottom-right.
    [...map.nodes.filter((n) => n.level === 'container')].sort((a, b) => a.y - b.y || a.x - b.x).forEach((n, i) => (n.order = i));
    intro = anim ? performance.now() : 0;
    if (selected && !byId.has(selected.id)) selected = null;
    else if (selected) selected = byId.get(selected.id);
    hovered = null;
  }

  function setColors(c) {
    colors = { ...DEFAULT_COLORS, ...c };
    colors.muted = colors.text;
  }

  /** The replayed moment (see above), or null to show the map as it is. */
  function setReplay(r) {
    replay = r || null;
    presentIds = null;
    if (!replay || !map) return;
    presentIds = new Set();
    for (const n of map.nodes) {
      if (n.level !== 'file' || !replay.present.has(n.path)) continue;
      presentIds.add(n.id);
      for (const a of ancestors(n)) presentIds.add(a.id);
    }
  }
  const shown = (n) => !replay || presentIds.has(n.id);
  // What a box is called on its card and in its summary: the map may name its own (a vault's folders and notes).
  const noun = (level) => map?.nouns?.[level] || (level === 'file' ? 'file' : level);
  const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
  function setSize(w, h) {
    size.w = w;
    size.h = h;
  }

  const rgba = (tone, a) => `rgba(${colors[tone] || colors.text}, ${tone === 'muted' ? a * 0.45 : a})`;

  // ------------------------------------------------------------ geometry
  const rect = (n) => ({ x: n.x * view.k + view.x, y: n.y * view.k + view.y, w: n.w * view.k, h: n.h * view.k });
  const onScreen = (r) => r.x < size.w && r.y < size.h && r.x + r.w > 0 && r.y + r.h > 0;
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

  // Whether a box's own label is big enough to read (else the host shows a tip).
  function legible(n) {
    const r = rect(n);
    return n.level === 'file' ? r.w * 0.052 >= 9 : isOpen(n) ? (n.head || 40) * view.k * 0.36 >= 9 : Math.min((r.w * 0.86) / (Math.max(6, n.name.length) * 0.62), r.h * 0.2) >= 10;
  }

  // In a replay, only what exists at that moment is counted, with the line counts of that moment.
  const linesOf = (n) => (replay?.lines?.has(n.path) ? replay.lines.get(n.path) : n.lines || 0);
  function counts(n) {
    const all = [];
    const walk = (id) => (kids.get(id) || []).forEach((c) => (shown(c) && all.push(c), walk(c.id)));
    walk(n.id);
    const comps = all.filter((c) => c.level === 'component').length;
    const files = all.filter((c) => c.level === 'file' && c.kind === 'file').length;
    const lines = all.reduce((s, c) => s + (c.level === 'file' ? linesOf(c) : 0), 0) + (n.level === 'file' ? linesOf(n) : 0);
    return { comps, files, lines };
  }

  function metaOf(n) {
    if (n.level === 'file') {
      const l = linesOf(n);
      return `${l ? `${l.toLocaleString()} lines · ` : ''}${n.symbols.length} symbol${n.symbols.length === 1 ? '' : 's'}`;
    }
    const c = counts(n);
    if (n.level === 'component') return `${plural(c.files, noun('file'))} · ${c.lines.toLocaleString()} lines`;
    if (!kids.has(n.id)) return n.tech || '';
    return `${plural(c.comps, noun('component'))} · ${plural(c.files, noun('file'))}${n.tech ? ` · ${n.tech}` : ''}`;
  }

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

  // The open boxes around the middle of the screen: where you are.
  function focusPath() {
    if (!map) return [];
    const cx = availW() / 2;
    const cy = top + (size.h - top) / 2;
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

  // ------------------------------------------------------------ drawing
  /** Draws one frame; returns whether something is still moving (the host keeps drawing then). */
  function render(c, now) {
    ctx = c;
    if (fly) step(now);
    if (zoomTo) zoomStep();
    if (glideV) glide();
    ctx.clearRect(0, 0, size.w, size.h);
    if (!map || !size.w) return { moving: false };
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
    if (intro && now - intro > 2400) intro = 0;
    return { moving: Boolean(fly || zoomTo || glideV || intro) };
  }

  // How far a container has materialized (eased 0 → 1), staggered by its order.
  function appear(n, now) {
    if (!intro) return 1;
    const p = clamp((now - intro - (n.order || 0) * 70) / 520, 0, 1);
    return 1 - (1 - p) ** 3;
  }

  // Behind everything: a vignette, a slow starfield (parallax) and, with motion, a scan line.
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
    if (fx === 'off') return;
    const W = size.w + 40;
    const H = size.h + 40;
    for (const s of STARS) {
      const x = (((s.x * W * 3 + view.x * 0.12) % W) + W) % W - 20;
      const y = (((s.y * H * 3 + view.y * 0.12) % H) + H) % H - 20;
      const a = anim ? 0.25 + 0.25 * Math.sin(now * 0.0012 + s.p) : 0.35;
      ctx.fillStyle = rgba(s.r > 1.2 ? 'c2' : 'c1', a * 0.6);
      ctx.fillRect(x, y, s.r, s.r);
    }
    if (!anim) return;
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
    if (fx !== 'off') (ctx.shadowColor = rgba(tone, 0.8)), (ctx.shadowBlur = s * 0.25);
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

  function box(n, alpha) {
    const r = rect(n);
    if (!onScreen(r) || r.w < 2) return;
    // Replaying: a file that doesn't exist yet isn't there; a box with nothing in it yet is a faint outline.
    if (replay && !shown(n)) {
      if (n.level !== 'file') ghost(n, r, alpha);
      return;
    }
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
    if (n.level === 'file' && replay?.heat?.get(n.path) > 0.01) warm(n, r, replay.heat.get(n.path), replay.tone || 'c1');
    if (n.isNew) {
      if (anim) {
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
    } else if (n.auto && r.w > 90) badge(r, 'UNDESCRIBED', 'warn');
    ctx.globalAlpha = 1;
  }

  // A box whose files haven't appeared yet in the replay: a dashed outline and its name, no more.
  function ghost(n, r, alpha) {
    ctx.globalAlpha = alpha * 0.22;
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = rgba(n.tone || 'c1', 0.7);
    ctx.lineWidth = 1;
    cardPath(n, r);
    ctx.stroke();
    ctx.setLineDash([]);
    const fs = Math.min((r.w * 0.8) / (Math.max(6, n.name.length) * 0.62), r.h * 0.18, 40);
    if (fs >= 6) {
      font(fs, colors.display, 700);
      ctx.fillStyle = rgba('text', 0.8);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(fit(n.name, r.w * 0.9), r.x + r.w / 2, r.y + r.h / 2);
    }
    ctx.globalAlpha = 1;
  }

  // A file just changed in the replay: it glows in the commit's color and cools down.
  function warm(n, r, heat, tone) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, heat);
    ctx.beginPath();
    ctx.roundRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4, radiusFor(r) + 2);
    ctx.strokeStyle = rgba(tone, 0.95);
    ctx.lineWidth = 2 + heat * 2;
    if (fx !== 'off') (ctx.shadowColor = rgba(tone, 0.9)), (ctx.shadowBlur = 10 + 24 * heat);
    ctx.stroke();
    ctx.fillStyle = rgba(tone, 0.18 * heat);
    ctx.fill();
    ctx.restore();
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
    const glow = fx !== 'off';
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
        ctx.fillText((n.kindLabel || KIND_LABEL[n.kind]).toUpperCase().split('').join(' '), cx, y + h / 2);
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
    if (n.level === 'container' && fx !== 'off') brackets(r, tone);
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
      ctx.fillText(`+ ${n.symbols.length - maxRows} more (tap for all)`, r.x + pad + sfs, r.y + (fileHead + 6 + maxRows * symRow + symRow / 2) * k);
    }
    ctx.globalAlpha = base;
  }

  // Hover and selection rings; the selection breathes with motion on.
  function outline(n, tone, width, glow, now) {
    const r = rect(n);
    if (!onScreen(r)) return;
    const pulse = glow && anim ? 0.5 + 0.5 * Math.sin(now / 320) : 1;
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
      if (replay && !(shown(a) && shown(b))) continue; // neither end exists yet
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
      if (hot && fx !== 'off') (ctx.shadowColor = rgba(tone, 0.8)), (ctx.shadowBlur = 8);
      ctx.beginPath();
      ctx.moveTo(curve[0], curve[1]);
      ctx.bezierCurveTo(curve[2], curve[3], curve[4], curve[5], curve[6], curve[7]);
      ctx.stroke();
      ctx.shadowBlur = 0;
      arrow(curve, rgba(tone, alpha), 5 + width * 1.5);
      if (anim && fade >= 1 && (!focus || hot)) packets(curve, x, tone, hot, now);
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
  // A panel may float over the right side and a legend over the top: centering and fitting use the rest.
  function setView(k, cx, cy) {
    view.k = k;
    view.x = availW() / 2 - cx * k;
    view.y = top + (size.h - top) / 2 - cy * k;
  }
  const availW = () => size.w - panelW;
  const minK = () => (map ? Math.min(availW() / map.bounds.w, size.h / map.bounds.h) * 0.4 : 0.01);

  function targetFor(b, pad = 40) {
    const k = clamp(Math.min((availW() - pad * 2) / b.w, (size.h - top - pad * 2) / b.h), minK(), 6);
    return { k, cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
  }

  /** Flies to a box (a node or the map's bounds); animate: false jumps there. */
  function flyTo(b, animate = true, pad) {
    if (!size.w) return;
    const to = targetFor(b, pad);
    // Diving into a part zooms at least far enough for its inside to show.
    if (OPEN_AT[b.level] && b.w) to.k = Math.min(6, Math.max(to.k, (OPEN_AT[b.level] * 1.12) / b.w));
    const from = { k: view.k, cx: (availW() / 2 - view.x) / view.k, cy: (top + (size.h - top) / 2 - view.y) / view.k };
    if (!animate) {
      fly = null;
      setView(to.k, to.cx, to.cy);
      return;
    }
    fly = { from, to, start: performance.now(), ms: 650 };
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
    if (!anim) return zoomBy(sx, sy, factor);
    zoomTo = { k: clamp((zoomTo?.k || view.k) * factor, minK(), 6), sx, sy };
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

  /** The host's drag ended with speed v = { vx, vy } (px per frame): glide on. */
  function setGlide(v) {
    glideV = v && Math.hypot(v.vx, v.vy) > 2 ? { ...v } : null;
  }
  /** Any camera motion stops (the user took hold of the map). */
  function hold() {
    fly = null;
    zoomTo = null;
    glideV = null;
  }

  // ------------------------------------------------------------ minimap
  function miniScale(w, h) {
    const pad = 8;
    const k = Math.min((w - pad * 2) / map.bounds.w, (h - pad * 2) / map.bounds.h);
    return { k, ox: (w - map.bounds.w * k) / 2, oy: (h - map.bounds.h * k) / 2 };
  }

  /** The whole map small, with the camera's view on it, into context c of w × h CSS px. */
  function drawMini(c, w, h, dpr) {
    if (!map) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const s = miniScale(w, h);
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
    if (fx !== 'off') (c.shadowColor = rgba('c1', 0.9)), (c.shadowBlur = 6);
    c.strokeRect(X(vx), Y(vy), vw, vh);
    c.shadowBlur = 0;
  }

  return {
    load,
    setColors,
    setSize,
    setReplay,
    noun,
    setFx: (level) => (fx = level),
    setAnimated: (on) => (anim = Boolean(on)),
    setPanel: (w) => (panelW = Math.max(0, w || 0)),
    setTop: (px) => (top = Math.max(0, px || 0)),
    render,
    pick,
    legible,
    rect,
    isOpen,
    ancestors,
    within,
    counts,
    metaOf,
    connections,
    focusPath,
    setView,
    availW,
    minK,
    flyTo,
    fitAll,
    zoomBy,
    zoomAt,
    setGlide,
    hold,
    miniScale,
    drawMini,
    rgba,
    hidden,
    view,
    size,
    get map() {
      return map;
    },
    get byId() {
      return byId;
    },
    get kids() {
      return kids;
    },
    get selected() {
      return selected;
    },
    set selected(n) {
      selected = n;
    },
    get hovered() {
      return hovered;
    },
    set hovered(n) {
      hovered = n;
    },
    get moving() {
      return Boolean(fly || zoomTo || glideV || intro);
    },
  };
}
