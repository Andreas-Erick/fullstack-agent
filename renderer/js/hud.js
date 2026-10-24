// The futuristic HUD layer's behaviour (styles in renderer/hud.css): the effects level from
// Settings → Interface (ui.fx: hud | subtle | off), the agent state on <body> for the CSS, the clock in
// the command bar, timestamps on notifications, the "materialize" view transition and the boot screen.
import { $, el, on } from './util.js';
import { state } from './state.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const startedAt = Date.now();

export const fxLevel = () => (['hud', 'subtle', 'off'].includes(state.settings?.ui?.fx) ? state.settings.ui.fx : 'hud');

function applyFx() {
  const fx = fxLevel();
  document.body.classList.toggle('fx-hud', fx === 'hud');
  document.body.classList.toggle('fx-subtle', fx === 'subtle');
  document.body.classList.toggle('fx-still', fx !== 'off' && reduceMotion.matches);
}

export function initHud() {
  applyFx();
  on('settings', applyFx);
  reduceMotion.addEventListener?.('change', applyFx);
  on('agent-state', (s) => (document.body.dataset.agent = s));

  // Command bar: local time and how long this session has been running.
  const clock = el('span', { class: 'hud-clock', 'aria-hidden': 'true' }, el('b', {}), el('span', {}));
  $('.brand')?.append(clock);
  const tick = () => {
    if (document.hidden || fxLevel() === 'off') return;
    const up = Math.floor((Date.now() - startedAt) / 1000);
    clock.firstChild.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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

  // Views materialize instead of just appearing.
  on('view', ({ name }) => {
    const v = document.getElementById(`view-${name}`);
    if (!v || fxLevel() !== 'hud') return;
    v.classList.remove('materialize');
    void v.offsetWidth; // restart the animation
    v.classList.add('materialize');
    v.addEventListener('animationend', () => v.classList.remove('materialize'), { once: true });
  });
}

// ------------------------------------------------------------ boot screen
// A short systems check while the app starts. It lists what is actually configured (not invented
// readings); real connectivity shows in the status pills right after. Click to skip.
const PROVIDERS = { 'claude-code': 'Claude account', anthropic: 'Claude API', auto: 'Multi-provider', openai: 'OpenAI-compatible' };

export function bootScreen() {
  const s = state.settings;
  if (!s?.onboarded || fxLevel() !== 'hud' || reduceMotion.matches) return { done() {} };
  const on_ = (v, yes = 'ENABLED') => [v ? yes : 'OFF', !v];
  const lines = [
    ['NEURAL CORE', [PROVIDERS[s.llm.provider] || s.llm.provider, false]],
    ['VOICE SYNTHESIS', on_(s.voice.ttsEnabled)],
    ['SPEECH INPUT', on_(s.stt.enabled, s.stt.engine === 'local' ? 'LOCAL WHISPER' : 'REMOTE')],
    ['MEMORY VAULT', on_(s.obsidian.enabled, 'MOUNTED')],
    ['CALENDAR LINK', on_(s.calendar.enabled)],
    ['REMOTE ACCESS', on_(s.remote?.enabled, 'ON')],
    ['SELF-IMPROVEMENT', on_(s.code.allowSelfModify, 'ARMED')],
  ];
  const bar = el('i');
  const rows = lines.map(([k, [v, off]]) => el('div', { class: 'hud-boot-line' }, el('span', {}, k), el('b', { class: off ? 'off' : '' }, String(v).toUpperCase())));
  const screen = el('div', { class: 'hud-boot', role: 'status', 'aria-label': 'Starting' },
    el('div', { class: 'hud-boot-box' },
      el('div', { class: 'hud-boot-title' }, String(s.agent?.name || 'Nexus').toUpperCase()),
      el('div', { class: 'hud-boot-sub' }, 'SYSTEMS CHECK // INITIALIZING'),
      rows,
      el('div', { class: 'hud-boot-bar' }, bar),
      el('div', { class: 'hud-boot-hint' }, 'CLICK TO SKIP'),
    ),
  );
  document.body.append(screen);
  let shown = 0;
  const reveal = setInterval(() => {
    rows[shown]?.classList.add('on');
    shown++;
    bar.style.transform = `scaleX(${Math.min(1, shown / rows.length)})`;
    if (shown >= rows.length) clearInterval(reveal);
  }, 140);
  const minUntil = Date.now() + 140 * rows.length + 350;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(reveal);
    screen.classList.add('out');
    setTimeout(() => screen.remove(), 500);
  };
  screen.addEventListener('click', close);
  setTimeout(close, 6000); // never stuck, whatever happens during startup
  return { done: () => setTimeout(close, Math.max(0, minUntil - Date.now())) };
}
