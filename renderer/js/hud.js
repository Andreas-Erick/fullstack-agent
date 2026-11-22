// The futuristic HUD layer's behaviour (styles in renderer/hud.css): the effects level from
// Settings → Interface (ui.fx: hud | subtle | off), the agent state on <body> for the CSS, the clock in
// the command bar, timestamps on notifications, the "materialize" view transition and the cinematic layer.
import { $, $$, el, on } from './util.js';
import { state } from './state.js';
import { effectsLevel, profile } from './perfcore.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const startedAt = Date.now();

// The level in use: Balanced performance keeps the HUD's look without motion (perfcore.js).
export const fxLevel = () => effectsLevel(state.settings);
const balanced = () => profile(state.settings) === 'balanced';

function applyFx() {
  const fx = fxLevel();
  document.body.classList.toggle('fx-hud', fx === 'hud');
  document.body.classList.toggle('fx-subtle', fx === 'subtle');
  // At every level, "off" included: the plain look still has loops of its own (the typing cursor, blinking lights).
  document.body.classList.toggle('fx-still', reduceMotion.matches);
  // Balanced: no backdrop blur (styles.css), and animations rest while nobody is looking.
  document.body.classList.toggle('perf-lite', balanced());
  rest();
}

// Animations pause while the window is in the background or the agent is asleep.
function rest() {
  document.body.classList.toggle('fx-rest', !document.hasFocus() || document.hidden || document.body.dataset.agent === 'sleeping');
}

export function initHud() {
  applyFx();
  on('settings', applyFx);
  reduceMotion.addEventListener?.('change', applyFx);
  on('agent-state', (s) => ((document.body.dataset.agent = s), rest()));
  window.addEventListener('focus', rest);
  window.addEventListener('blur', rest);
  document.addEventListener('visibilitychange', rest);

  // Command bar, in the middle: the date, local time and how long this session has been running.
  const clock = el('span', { class: 'hud-clock', 'aria-hidden': 'true' }, el('i', {}), el('b', {}), el('span', {}));
  ($('#tbCenter') || $('.brand'))?.append(clock);
  const tick = () => {
    if (document.hidden || fxLevel() === 'off') return;
    const up = Math.floor((Date.now() - startedAt) / 1000);
    const now = new Date();
    clock.firstChild.textContent = now.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }).replace(/[.,]/g, '').toUpperCase();
    clock.children[1].textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    clock.lastChild.textContent = `UP ${String(Math.floor(up / 3600)).padStart(2, '0')}:${String(Math.floor(up / 60) % 60).padStart(2, '0')}`;
  };
  tick();
  setInterval(tick, 1000);

  // Notifications get the time they arrived (shown by the CSS as "SYS // 14:32:05").
  const toasts = document.getElementById('toasts');
  if (toasts) {
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && !n.dataset.time) n.dataset.time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }).observe(toasts, { childList: true });
  }

  // Views materialize smoothly when opened, with a beam, the title decoding and a quick card entrance;
  // while resting (the window in the background, or the agent asleep) the view just appears, and under
  // reduce motion only the materialize fade runs.
  on('view', ({ name }) => {
    const v = document.getElementById(`view-${name}`);
    if (!v || fxLevel() !== 'hud' || document.body.classList.contains('fx-rest')) return;
    v.classList.remove('materialize');
    void v.offsetWidth; // restart the animation
    v.classList.add('materialize');
    v.addEventListener('animationend', () => v.classList.remove('materialize'), { once: true });
    if (reduceMotion.matches || document.body.classList.contains('fx-still')) return;
    beam(v);
    const title = viewTitle(v);
    if (title) decode(title);
    cascade(v);
  });

  systemCodes();
  $('.views')?.prepend(el('div', { class: 'hud-motes', 'aria-hidden': 'true' }));
  reticle();
}

// ------------------------------------------------------------ cinematic view entrances
// An entrance that starts hidden (opacity 0), here or anywhere, must also be listed in styles.css's
// body.fx-rest :is(…) rule, or it stays hidden while the window rests (these are, via .hud-cascade *).
const CASCADE = '.mem-card, .skill-card, .routine-row, .note-item, .kb-item, .evo-item, .conv-item, .settings > .card, .docs-recent li, .cal-cell, .kb-note, .evo-detail, .doc-viewer, .kb-list, .evo-list, .docs-recent, .cal-side > *, .world-scene, .world-res, .stream-row';
const GLYPHS = '#%&@$*+=<>/\\|[]{}01ΔΣΞΛ';
const viewTitle = (v) => v.querySelector('.view-head h2, .arch-head h2, .world-head h2');

// Each view's title gets a system code from its place in the rail: "SYS.03 // MEMORY VAULT".
function systemCodes() {
  $$('.rail-btn').forEach((b, i) => {
    const title = viewTitle(document.getElementById(`view-${b.dataset.view}`) || document.createElement('div'));
    if (!title) return;
    const label = (b.title || b.dataset.view).split(/ [—(]/)[0];
    title.dataset.hudCode = `SYS.${String(i + 1).padStart(2, '0')} // ${label}`;
  });
}

// On the views' container, not the view: the view itself is still fading in while the beam runs.
function beam(v) {
  const b = el('div', { class: 'hud-beam', 'aria-hidden': 'true' });
  (v.parentElement || v).append(b);
  const done = () => b.remove();
  b.addEventListener('animationend', done, { once: true });
  setTimeout(done, 1500);
}

// The title decodes: random glyphs lock into the real letters, left to right. Stops if the app changes
// the text meanwhile (a conversation title, the vault's name).
// Screen readers get the real title meanwhile (aria-label), and the window going to rest ends it at once.
const decoding = new WeakMap(); // node → { raf, target, shown }
function decode(node) {
  const running = decoding.get(node);
  // Opened again mid-decode: the real title is the one being decoded, not the glyphs on screen.
  const target = running && node.textContent === running.shown ? running.target : node.textContent;
  if (running) (cancelAnimationFrame(running.raf), finish(node, running, running.target));
  if (node.children.length || !target.trim() || target.length > 40) return;
  const start = performance.now();
  const ms = 450 + target.length * 22;
  const job = { raf: 0, target, shown: target };
  node.setAttribute('aria-label', target);
  const tick = (now) => {
    if (node.textContent !== job.shown) return finish(node, job, null); // the app changed it: keep the app's text
    const p = document.body.classList.contains('fx-rest') ? 1 : Math.min(1, (now - start) / ms);
    const locked = Math.floor(p * target.length);
    job.shown = p >= 1 ? target : [...target].map((ch, i) => (i < locked || ch === ' ' ? ch : GLYPHS[Math.floor(Math.random() * GLYPHS.length)])).join('');
    node.textContent = job.shown;
    if (p < 1) job.raf = requestAnimationFrame(tick);
    else finish(node, job, null);
  };
  job.raf = requestAnimationFrame(tick);
  decoding.set(node, job);
  // Frames stop in a hidden or minimized window: the real title comes back regardless.
  setTimeout(() => (cancelAnimationFrame(job.raf), finish(node, job, target)), ms + 150);
}

// Ends a decode: the real text back (when it was still showing glyphs) and the label off.
function finish(node, job, text) {
  if (decoding.get(node) !== job) return;
  decoding.delete(node);
  if (text != null && node.textContent === job.shown) node.textContent = text;
  node.removeAttribute('aria-label');
}

// Cards and rows arrive one after another, including the ones a view renders a moment later.
const cascades = new WeakMap();
function cascade(v) {
  const prev = cascades.get(v);
  if (prev) (prev.mo.disconnect(), clearTimeout(prev.timer));
  let i = 0;
  const mark = (n) => i < 16 && n.style.setProperty('--hud-i', i++);
  v.querySelectorAll(CASCADE).forEach(mark);
  v.classList.add('hud-cascade');
  const mo = new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) (n.matches(CASCADE) && mark(n), n.querySelectorAll(CASCADE).forEach(mark));
  });
  mo.observe(v, { childList: true, subtree: true });
  const timer = setTimeout(() => {
    mo.disconnect();
    v.classList.remove('hud-cascade');
    v.querySelectorAll(CASCADE).forEach((n) => n.style.removeProperty('--hud-i'));
    cascades.delete(v);
  }, 450);
  cascades.set(v, { mo, timer });
}

// ------------------------------------------------------------ the face: reticle and telemetry
// Rings around the face that turn faster while the agent thinks, and readouts of real state on both
// sides (nothing invented: the agent's state, time, this session, and what is configured).
const RETICLE = `<svg viewBox="-100 -100 200 200">
  <g class="r1"><circle r="97" pathLength="360" stroke-dasharray="0.6 1.4" /></g>
  <g class="r2"><circle r="90" pathLength="360" stroke-dasharray="70 12 6 12 40 30 4 30" /></g>
  <g class="r3"><circle r="84" pathLength="360" stroke-dasharray="2 43" /></g>
  <g class="r4"><path d="M-62 -46A77 77 0 0 1 -46 -62M62 -46A77 77 0 0 0 46 -62M-62 46A77 77 0 0 0 -46 62M62 46A77 77 0 0 1 46 62" /></g>
  <path class="cross" d="M0 -100v9M0 91v9M-100 0h9M91 0h9M-3 -94h6M-3 94h6" />
  <text x="91" y="-2">090°</text><text x="-99" y="-2">270°</text>
</svg>`;

function reticle() {
  const v = $('#view-face');
  const host = v?.querySelector('.face-host');
  if (!host) return;
  const left = el('div', { class: 'hud-readout left', 'aria-hidden': 'true' });
  const right = el('div', { class: 'hud-readout right', 'aria-hidden': 'true' });
  host.after(el('div', { class: 'hud-reticle', 'aria-hidden': 'true', html: RETICLE }), left, right);
  const row = (k, val) => el('div', {}, el('span', {}, k), el('b', {}, String(val)));
  const tick = () => {
    if (!v.classList.contains('active') || document.hidden || fxLevel() === 'off') return;
    const s = state.settings || {};
    const up = Math.floor((Date.now() - startedAt) / 1000);
    left.replaceChildren(
      el('i', {}, 'AGENT TELEMETRY'),
      row('DESIGNATION', s.agent?.name || 'Siren'),
      row('STATE', document.body.dataset.agent || 'idle'),
      row('LOCAL TIME', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      row('SESSION', `${String(Math.floor(up / 3600)).padStart(2, '0')}:${String(Math.floor(up / 60) % 60).padStart(2, '0')}:${String(up % 60).padStart(2, '0')}`),
    );
    right.replaceChildren(
      el('i', {}, 'SUBSYSTEMS'),
      row('CORE', PROVIDERS[s.llm?.provider] || s.llm?.provider || '—'),
      row('VOICE', s.voice?.ttsEnabled ? 'online' : 'off'),
      row('SPEECH IN', s.stt?.enabled ? 'online' : 'off'),
      row('VAULT', s.obsidian?.enabled ? 'mounted' : 'off'),
    );
  };
  on('view', ({ name }) => name === 'face' && tick());
  tick();
  setInterval(tick, 1000);
}

// The brain's name on the face's telemetry (what is configured, never an invented reading).
const PROVIDERS = { 'claude-code': 'Claude account', anthropic: 'Claude API', auto: 'Multi-provider', openai: 'OpenAI-compatible', local: 'Local model', gemini: 'Gemini', deepseek: 'DeepSeek', groq: 'Groq', perplexity: 'Perplexity' };
