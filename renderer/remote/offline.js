// The offline screen and the banner above the chat.
import { $, android, bridge, store, state } from './state.js';
import { el, icon, ago } from './ui.js';
import { moveToSecure } from './pairing.js';
import { retryNow } from './stream.js';
import { syncBack } from './nav.js';

// ------------------------------------------------------------------ can't reach the computer
// Instead of an empty screen: what is going on, what to check, when it tries again, and a button to try
// now. Shown once the link has been down for a moment (state.connected false after the banner's delay);
// "Continue offline" keeps the banner and whatever is already on the screen.
export const SEEN_KEY = 'nexus.lastSeen';
let offlineTick = null;
export function renderOffline() {
  let box = $('#offline');
  const down = state.token && state.connected === false && !state.offlineDismissed && $('#banner').classList.contains('offline');
  if (!down) {
    clearInterval(offlineTick);
    offlineTick = null;
    box?.remove();
    syncBack();
    return;
  }
  if (!box) {
    box = el('div', { id: 'offline', class: 'offline-screen', role: 'alertdialog', 'aria-labelledby': 'offlineTitle', 'aria-describedby': 'offlineText' });
    document.body.append(box);
  }
  const seen = Number(store.get(SEEN_KEY)) || 0;
  const lan = /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\.|\.local$|^localhost$/.test(location.hostname);
  const tips = [
    'Siren is open on your computer, and the computer is awake.',
    'Remote access is on there (Settings → Remote access).',
    lan ? 'This device is on the same Wi-Fi as the computer.' : /\.ts\.net$/.test(location.hostname) ? 'Tailscale is on, on this device and on the computer.' : 'The computer is online.',
  ];
  const when = el('span', { class: 'offline-when' });
  const tick = () => {
    const s = Math.max(0, Math.round(((state.retryAt || 0) - Date.now()) / 1000));
    when.textContent = s ? `Trying again in ${s} s` : 'Trying again…';
  };
  box.replaceChildren(
    el(
      'div',
      { class: 'offline-card' },
      el('div', { class: 'offline-orb', 'aria-hidden': 'true' }, el('span'), icon('unlink')),
      el('h2', { id: 'offlineTitle' }, 'Can’t reach your computer'),
      el('p', { id: 'offlineText', class: 'muted' }, `${state.name || 'Siren'} lives on your computer${location.host ? ` (${location.host})` : ''}, and it isn’t answering.${seen ? ` Last connected ${ago(seen)}.` : ''}`),
      el('ul', { class: 'offline-tips' }, ...tips.map((t) => el('li', {}, t))),
      el('div', { class: 'offline-status' }, el('span', { class: 'spin', 'aria-hidden': 'true' }), when),
      el(
        'div',
        { class: 'offline-actions' },
        el('button', { class: 'btn primary', type: 'button', onclick: () => (retryNow(), (state.retryAt = Date.now()), tick()) }, 'Try again now'),
        android ? el('button', { class: 'btn', type: 'button', onclick: () => bridge('changeServer') }, 'Change the address') : null,
        el('button', { class: 'btn ghost', type: 'button', onclick: () => ((state.offlineDismissed = true), renderOffline()) }, 'Continue offline'),
      ),
    ),
  );
  tick();
  clearInterval(offlineTick);
  offlineTick = setInterval(tick, 1000);
  syncBack();
}

// Plain http on another machine: the token and messages cross the network unencrypted.
export const insecure = !window.isSecureContext && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const INSECURE_KEY = 'nexus.insecureSeen';
const insecureSeen = () => {
  try {
    return Boolean(sessionStorage.getItem(INSECURE_KEY));
  } catch {
    return false;
  }
};

export function renderBanner() {
  const b = $('#banner');
  b.innerHTML = '';
  b.className = 'banner';
  if (state.token && state.connected === false) {
    b.classList.add('offline');
    b.append(el('span', { class: 'spin', 'aria-hidden': 'true' }), 'Can’t reach the computer. Retrying…');
  } else if (insecure && state.token && state.secureUrl) {
    b.classList.add('warn', 'offer');
    b.append(icon('lock-open'), el('span', {}, 'Not encrypted. A secure address is set up: switch once and it works away from home too.'), el('button', { class: 'banner-btn', type: 'button', onclick: moveToSecure }, 'Switch'));
  } else if (insecure && !insecureSeen()) {
    b.classList.add('warn');
    b.append(icon('lock-open'), el('span', {}, 'Not encrypted: local network only. Away from home, use the secure https address.'), el('button', { class: 'banner-x', 'aria-label': 'Dismiss', onclick: () => {
      try {
        sessionStorage.setItem(INSECURE_KEY, '1');
      } catch {
        /* private mode */
      }
      renderBanner();
    } }, icon('close')));
  } else b.classList.add('hidden');
  renderOffline();
}
