// The vault's Growth replay (Vault view → 🌱 Growth): every note the vault ever had, laid out by
// folder as a map (main/replaycore.js vaultMap), and the vault's git history (main/vaultgit.js)
// played over it (renderer/js/replay.js): notes appear in their folders as they were written, glow
// when they change, and vanish when they were deleted. Drawn by the Architecture renderer
// (renderer/js/archdraw.js) in a window of its own: drag to move, wheel to zoom, double-click to fit.
import { api, el, modal, toast, toastError } from './util.js';
import { createArchScene } from './archdraw.js';
import { createReplay, replayBar } from './replay.js';
import { themeColors, animated } from './archmap.js';
import { fxLevel } from './hud.js';

export async function openGrowth() {
  let h;
  try {
    h = await api.obsidian.growth();
  } catch (err) {
    return toastError(err);
  }
  if (!h.map || !h.commits?.length) return toast(h.reason || 'The vault has no history yet: it grows from the first note the assistant writes.');
  await modal((card, close) => {
    card.classList.add('wide', 'growth-card');
    const canvas = el('canvas', { class: 'growth-canvas', 'aria-label': 'The vault growing, note by note' });
    const slot = el('div', { class: 'replay-slot' });
    const body = el('div', { class: 'growth-body' }, canvas, slot);
    card.append(
      el('div', { class: 'growth-head' }, el('h3', {}, 'Your vault, growing'), el('button', { class: 'btn', onclick: () => close(null) }, 'Close')),
      el('p', { class: 'growth-hint' }, `${h.map.stats.files.toLocaleString()} notes in ${h.map.stats.components} folders, over ${h.commits.length.toLocaleString()} recorded changes. Drag to move, scroll to zoom into a folder, double-click to see everything.`),
      body,
    );

    const scene = createArchScene();
    scene.setTop(8);
    scene.setColors(themeColors());
    scene.setFx(fxLevel());
    scene.setAnimated(animated());
    scene.load(h.map);
    const replay = createReplay(h.commits, { keep: (p) => scene.byId.has(`f:${p}`) });
    const ctx = canvas.getContext('2d');
    const wrap = document.getElementById('modal');
    let frame = 0;
    let last = performance.now();
    let sized = false;
    const draw = () => frame || (frame = requestAnimationFrame(render));
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.setSize(r.width, r.height);
      if (!sized) ((sized = true), scene.fitAll(false));
      return true;
    };
    const render = (now) => {
      frame = 0;
      if (wrap.classList.contains('hidden') || !canvas.isConnected) return; // the window closed
      if (!sized && !resize()) return void (frame = requestAnimationFrame(render));
      const dt = Math.min(100, now - last);
      last = now;
      if (replay.tick(dt)) {
        scene.setReplay(replay.overlay());
        bar.update();
      }
      const { moving } = scene.render(ctx, now);
      if (moving || replay.state.playing || replay.state.heat.size) frame = requestAnimationFrame(render);
    };
    const sync = () => (scene.setReplay(replay.overlay()), bar.update(), draw());
    const bar = replayBar(replay, { onChange: () => ((last = performance.now()), sync()), noun: 'note' });
    slot.append(bar);
    new ResizeObserver(() => resize() && draw()).observe(canvas);

    // Drag to move, wheel to zoom, double-click to fit.
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, vx: scene.view.x, vy: scene.view.y };
      scene.hold();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      scene.view.x = drag.vx + e.clientX - drag.x;
      scene.view.y = drag.vy + e.clientY - drag.y;
      draw();
    });
    const end = () => (drag = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('dblclick', () => (scene.fitAll(animated()), draw()));
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        scene.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-Math.max(-120, Math.min(120, dy)) * 0.0018));
        draw();
      },
      { passive: false },
    );
    card.addEventListener('keydown', (e) => {
      if (e.key !== ' ') return;
      e.preventDefault();
      replay.state.playing ? replay.pause() : replay.play();
      last = performance.now();
      sync();
    });

    replay.seek(-1);
    replay.play();
    sync();
  });
}
