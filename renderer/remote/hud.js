// The HUD layer: the effects level, decoding titles and the connecting splash.
import { store, state } from './state.js';
import { el } from './ui.js';

// ------------------------------------------------------------------ HUD layer
// The desktop's "Visual effects" setting: hud (with motion) | subtle (static) | off. Remembered, so
// the next start looks right before the computer answers.
const FX_KEY = 'nexus.fx';
const stillMedia = matchMedia('(prefers-reduced-motion: reduce)');

// The desktop's decoding titles (renderer/js/hud.js decode): glyphs settle into the text, left to right.
// Plain text when the HUD is off or motion is reduced; stops if the title changes meanwhile.
export function decode(node, text) {
  const GLYPHS = '#%&*+=<>/|01ABCDEFGHJKLMNPRSTUVXYZ';
  node.textContent = text;
  if (!document.body.classList.contains('fx-hud') || matchMedia('(prefers-reduced-motion: reduce)').matches || !text) return;
  const start = performance.now();
  let shown = text;
  const step = (now) => {
    // Stop when another decode took over or the app set the text itself meanwhile (Schedule, a conversation title).
    if (node.dataset.decoding !== text || node.textContent !== shown) return;
    const done = Math.floor(((now - start) / 420) * text.length);
    if (done >= text.length) return void ((node.textContent = text), delete node.dataset.decoding);
    shown = text.slice(0, done) + [...text.slice(done)].map((c) => (c === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join('');
    node.textContent = shown;
    requestAnimationFrame(step);
  };
  node.dataset.decoding = text;
  requestAnimationFrame(step);
}
export function setFx(fx) {
  const level = ['hud', 'subtle', 'off'].includes(fx) ? fx : 'hud';
  store.set(FX_KEY, level);
  document.body.classList.toggle('fx-hud', level === 'hud');
  document.body.classList.toggle('fx-subtle', level === 'subtle');
  // Reduce motion means still at every effects level (as the desktop's hud.js): the base loops run with effects off too.
  document.body.classList.toggle('fx-still', stillMedia.matches);
}
setFx(store.get(FX_KEY) || 'hud');

// While the phone connects: a short "establishing link" splash (until connected, at most 2.5 s).
let splash = null;
export function openSplash() {
  if (!document.body.classList.contains('fx-hud') || stillMedia.matches || splash) return;
  splash = el('div', { class: 'hud-splash', role: 'status', onclick: () => closeSplash() },
    el('div', { class: 'hud-splash-box' }, el('div', { class: 'hud-splash-ring' }), el('div', { class: 'hud-splash-title' }, state.name.toUpperCase()), el('div', { class: 'hud-splash-sub' }, 'ESTABLISHING LINK')),
  );
  document.body.append(splash);
  setTimeout(closeSplash, 2500);
}
export function closeSplash() {
  const s = splash;
  if (!s || s.classList.contains('out')) return;
  s.classList.add('out');
  setTimeout(() => (s.remove(), splash === s && (splash = null)), 450);
}

