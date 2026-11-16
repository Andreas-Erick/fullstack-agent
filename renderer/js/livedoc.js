// Live documents in the viewer (docview.js), with nothing the model wrote ever running:
//  - a chart with parameters (chart_create params, saved by diagrams.chartPage) becomes sliders and a
//    ▶ play button; the app's own engine (chartcore.mjs) redraws it as they move.
//  - a diagram whose parts are marked data-step="1", "2"… is revealed a step at a time (Back / Next /
//    Play): the app restyles the sandboxed page for each step; the page itself still runs nothing.
// The parts without a DOM (reading a page, the step styles) are pure and tested (test/livedoc.test.js).
import { render, params } from './chartcore.mjs';

// ------------------------------------------------------------------ pure

/** The chart description embedded in a saved page (base64 JSON), or null. */
export function chartSpecFrom(html) {
  const m = String(html || '').match(/data-nexus-chart="([A-Za-z0-9+/=]{4,2000000})"/);
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    const spec = JSON.parse(new TextDecoder().decode(bytes));
    return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  } catch {
    return null;
  }
}

export const MAX_STEPS = 30;

/** How many steps a diagram has: the highest data-step number (at most MAX_STEPS), else 0. */
export function stepCount(html) {
  let n = 0;
  for (const m of String(html || '').matchAll(/data-step\s*=\s*["']?(\d{1,3})/g)) n = Math.max(n, Number(m[1]));
  return Math.min(n, MAX_STEPS);
}

/** The page showing steps 1…k (the newest fading in), the later ones hidden. */
export function withStep(html, k, n) {
  const shown = Array.from({ length: Math.max(0, k) }, (_, i) => `[data-step="${i + 1}"]`).join(',');
  const css = `<style id="nexus-steps">[data-step]{opacity:0}${shown ? `${shown}{opacity:1}` : ''}${k > 0 && k <= n ? `[data-step="${k}"]{animation:nexus-step .7s ease both}` : ''}@keyframes nexus-step{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:reduce){[data-step]{animation:none!important}}</style>`;
  const page = String(html || '');
  return /<head\b[^>]*>/i.test(page) ? page.replace(/<head\b[^>]*>/i, (h) => `${h}${css}`) : `${css}${page}`;
}

/** A parameter's value while playing: back and forth across its range, `periodMs` per round trip. */
export function playValue(p, ms, periodMs = 6000) {
  const phase = (1 - Math.cos((2 * Math.PI * ms) / periodMs)) / 2;
  return p.min + (p.max - p.min) * phase;
}

const fmt = (v, step) => {
  const digits = Math.min(4, Math.max(0, -Math.floor(Math.log10(step || 1))));
  return Number(v).toFixed(digits);
};

// ------------------------------------------------------------------ DOM
const still = () => document.body.classList.contains('fx-still') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const h = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick' || k === 'oninput') n[k] = v;
    else if (v != null) n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
};

/** A chart with sliders. Returns the node; stops its animation when removed from the page. */
export function liveChart(spec) {
  const ps = params(spec);
  const values = Object.fromEntries(ps.map((p) => [p.name, p.value]));
  const plot = h('div', { class: 'live-plot' });
  // 3D: drag to turn it (or the arrow keys when it has focus); the view goes to the engine with the values.
  const view = spec.kind === '3d' ? { azimuth: Number(spec.view?.azimuth ?? -55), elevation: Number(spec.view?.elevation ?? 25) } : null;
  if (view) {
    plot.classList.add('live-3d');
    plot.tabIndex = 0;
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', `${spec.title || '3D chart'}: drag or use the arrow keys to turn it`);
    let from = null;
    plot.addEventListener('pointerdown', (e) => {
      from = [e.clientX, e.clientY, view.azimuth, view.elevation];
      plot.setPointerCapture(e.pointerId);
    });
    plot.addEventListener('pointermove', (e) => {
      if (!from) return;
      view.azimuth = from[2] - (e.clientX - from[0]) * 0.5;
      view.elevation = Math.max(-89, Math.min(89, from[3] + (e.clientY - from[1]) * 0.5));
      draw();
    });
    plot.addEventListener('pointerup', () => (from = null));
    plot.addEventListener('keydown', (e) => {
      const d = { ArrowLeft: [5, 0], ArrowRight: [-5, 0], ArrowUp: [0, 5], ArrowDown: [0, -5] }[e.key];
      if (!d) return;
      e.preventDefault();
      view.azimuth += d[0];
      view.elevation = Math.max(-89, Math.min(89, view.elevation + d[1]));
      draw();
    });
  }
  const error = h('p', { class: 'live-error hidden', role: 'alert' });
  let queued = false;
  const draw = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      try {
        plot.innerHTML = render({ ...spec, values, ...(view ? { view } : {}) }); // the app's engine; labels escaped there
        error.classList.add('hidden');
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
      }
    });
  };
  let playing = null;
  let started = 0;
  const rows = ps.map((p) => {
    const out = h('output', { class: 'live-val' }, fmt(p.value, p.step));
    const range = h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: p.value, 'aria-label': p.label });
    const btn = h('button', { class: 'btn small live-play', type: 'button', 'aria-label': `Play ${p.label}`, title: `Animate ${p.label}` }, '▶');
    const set = (v) => {
      values[p.name] = v;
      range.value = v;
      out.textContent = fmt(v, p.step);
      draw();
    };
    range.oninput = () => {
      if (playing === p) stop();
      set(Number(range.value));
    };
    btn.onclick = () => (playing === p ? stop() : start(p));
    return { p, set, btn, row: h('label', { class: 'live-row' }, h('span', { class: 'live-name' }, p.label === p.name ? p.name : `${p.label} (${p.name})`), range, out, btn) };
  });
  const tick = (now) => {
    if (!playing) return;
    if (!plot.isConnected && started && now - started > 1000) return stop();
    const r = rows.find((x) => x.p === playing);
    // Starts from where the slider is: the phase that gives its current value.
    r.set(playValue(playing, now - started + r.offset));
    requestAnimationFrame(tick);
  };
  function start(p) {
    stop();
    playing = p;
    const r = rows.find((x) => x.p === p);
    const frac = (values[p.name] - p.min) / (p.max - p.min || 1);
    r.offset = (Math.acos(1 - 2 * Math.min(1, Math.max(0, frac))) / (2 * Math.PI)) * 6000;
    r.btn.textContent = '⏸';
    r.btn.setAttribute('aria-label', `Pause ${p.label}`);
    started = performance.now();
    requestAnimationFrame(tick);
  }
  function stop() {
    const r = rows.find((x) => x.p === playing);
    if (r) {
      r.btn.textContent = '▶';
      r.btn.setAttribute('aria-label', `Play ${r.p.label}`);
    }
    playing = null;
  }
  draw();
  const auto = ps.find((p) => p.name === String(spec.play || '').toLowerCase());
  if (auto && !still()) start(auto);
  const panel = rows.length ? h('div', { class: 'live-controls', role: 'group', 'aria-label': 'Parameters' }, ...rows.map((r) => r.row)) : '';
  return h('div', { class: 'live-chart' }, plot, error, panel);
}

/** A diagram revealed a step at a time in its sandboxed frame. */
export function steppedDiagram(html, title) {
  const n = stepCount(html);
  let k = 1;
  let timer = null;
  // Two frames, one shown: the next step loads in the hidden one and they swap when it is ready, so a
  // step never flashes an empty page while the frame reloads.
  const frames = [0, 1].map((i) => h('iframe', { class: `doc-frame live-frame${i ? ' live-back' : ''}`, sandbox: '', referrerpolicy: 'no-referrer', title, 'aria-hidden': i ? 'true' : null }));
  let front = 0;
  const label = h('span', { class: 'live-step', 'aria-live': 'polite' });
  const prev = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Previous step' }, '◀ Back');
  const next = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Next step' }, 'Next ▶');
  const play = h('button', { class: 'btn small', type: 'button' }, '▶ Play');
  const all = h('button', { class: 'btn small', type: 'button' }, 'Show all');
  const show = (to) => {
    k = Math.max(1, Math.min(n, to));
    const back = frames[1 - front];
    const shown = frames[front];
    back.onload = () => {
      back.onload = null;
      back.classList.remove('live-back');
      back.removeAttribute('aria-hidden');
      shown.classList.add('live-back');
      shown.setAttribute('aria-hidden', 'true');
      front = 1 - front;
    };
    back.srcdoc = withStep(html, k, n);
    label.textContent = `Step ${k} of ${n}`;
    prev.disabled = k <= 1;
    next.disabled = k >= n;
  };
  const stop = () => {
    clearInterval(timer);
    timer = null;
    play.textContent = '▶ Play';
  };
  prev.onclick = () => (stop(), show(k - 1));
  next.onclick = () => (stop(), show(k + 1));
  all.onclick = () => (stop(), show(n));
  play.onclick = () => {
    if (timer) return stop();
    if (k >= n) show(1);
    play.textContent = '⏸ Pause';
    timer = setInterval(() => (k >= n || !frames[0].isConnected ? stop() : show(k + 1)), 2200);
  };
  const bar = h('div', { class: 'live-steps', role: 'group', 'aria-label': 'Steps' }, prev, label, next, play, all);
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') (e.preventDefault(), stop(), show(k + 1));
    if (e.key === 'ArrowLeft') (e.preventDefault(), stop(), show(k - 1));
  });
  show(1);
  return h('div', { class: 'live-stepped' }, bar, h('div', { class: 'live-frames' }, ...frames));
}
