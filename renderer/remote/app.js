// Phone client for the companion server (main/companion.js, docs/ROADMAP-mobile.md step 2).
// Talks only to the server it was loaded from. The device token lives in this browser's storage.
// This file wires the client together and boots it; each part is its own module in this folder:
// state.js (shared state, the Android bridge: its key is asked for first, when state.js loads),
// ui.js, net.js, pairing.js, stream.js, offline.js, chatview.js, conversations.js, approvals.js,
// voiceout.js, talk.js, face.js, schedule.js, nav.js, hud.js and boot.js. The pure rules are in
// sync.js and the desktop's turnstate.js / chatcore.js; the screens beyond the chat in screens.js.
// Modules may import each other in a cycle: at load they only declare things and bind listeners (and
// may call another module's function declarations, which exist before any module runs), never read
// another module's constants, so the order they load in doesn't matter. state.js and ui.js import
// none of the others, so they load first.
import { initScreens } from './screens.js';
import { keyboardState } from './sync.js';
import { $, inputEl, android, bridge, state } from './state.js';
import { el, icon, markdown, toast, AuthError, NetError } from './ui.js';
import { api } from './net.js';
import { show, offerApp, pair, finishMove, renderLinkInfo } from './pairing.js';
import './stream.js';
import { insecure } from './offline.js';
import { send, autosize, prefill } from './chatview.js';
import './conversations.js';
import './approvals.js';
import './voiceout.js';
import './talk.js'; // defines window.nexusTalk on a secure page, before the fallback below
import { agentState } from './face.js';
import './schedule.js';
import { syncBack, showView, wide, applyWide } from './nav.js';
import './hud.js';
import { start } from './boot.js';

// ------------------------------------------------------------------ Android app
// Shared text (Share → Nexus) goes into the message box for the user to check and send.
window.nexusShare = (text) => {
  const input = inputEl;
  input.value = input.value ? `${input.value}\n${text}` : text;
  autosize();
  input.focus();
};
if (!window.nexusTalk) window.nexusTalk = () => toast('Push-to-talk needs the secure (https) address.');

if (android) {
  const sw = el('input', { type: 'checkbox', id: 'bgToggle' });
  sw.checked = android.backgroundEnabled();
  sw.addEventListener('change', () => bridge('setBackground', sw.checked));
  // `blocked`: off in Android's settings (refused for good, or switched off there), where only they can
  // turn them back on. The app checks again whenever it comes back to the front.
  window.nexusBackgroundChanged = (on, blocked = false) => {
    sw.checked = on;
    if (on) return;
    if (blocked && typeof android.openAppSettings === 'function') toast('Notifications are off for Siren in Android settings. Turn them on there to get approvals while the app is closed.', { label: 'Open settings', run: () => bridge('openAppSettings', 'notifications') });
    else toast('Notifications are off. Allow them in Android settings to get approvals while the app is closed.');
  };
  // The app lock (android AppLock): the phone's fingerprint, face or screen lock before anything shows.
  const lockSw = el('input', { type: 'checkbox', id: 'lockToggle' });
  const canLock = typeof android.lockAvailable === 'function' && android.lockAvailable();
  lockSw.checked = canLock && android.lockEnabled();
  lockSw.disabled = !canLock;
  lockSw.addEventListener('change', () => {
    const want = lockSw.checked;
    lockSw.checked = !want; // until the phone confirms it is you
    bridge('setLock', want);
  });
  window.nexusLockChanged = (on) => {
    lockSw.checked = on;
    toast(on ? 'Siren now asks for your fingerprint, face or screen lock when you open it.' : 'The app lock is off.');
  };
  $('#deviceBox').append(
    el('label', { class: 'switch-row' }, sw, el('span', {}, 'Notify me about approvals and replies while the app is closed')),
    el('label', { class: 'switch-row' }, lockSw, el('span', {}, canLock ? 'Lock Siren with fingerprint, face or screen lock' : 'Lock Siren with fingerprint, face or screen lock (set a screen lock on the phone first)')),
    el('button', { class: 'btn ghost', onclick: () => bridge('changeServer') }, 'Change the computer’s address'),
  );
}

wide.addEventListener('change', applyWide);
applyWide();

// The soft keyboard is up (sync.js keyboardState): the face and the tab bar step aside on a phone, so the
// conversation keeps more than a few lines (styles.css body.kbd).
let kbd = null;
function syncKeyboard() {
  const a = document.activeElement;
  const typing = Boolean(a?.matches?.('textarea, input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'));
  kbd = keyboardState(kbd, { width: innerWidth, height: innerHeight, typing });
  document.body.classList.toggle('kbd', kbd.up);
}
window.addEventListener('resize', syncKeyboard);
window.visualViewport?.addEventListener('resize', syncKeyboard);
// Focus moves before the keyboard opens or closes; the resize that follows decides again.
document.addEventListener('focusin', syncKeyboard);
document.addEventListener('focusout', () => setTimeout(syncKeyboard, 0));
syncKeyboard();

// Keyboard (tablet keyboards, DeX): Ctrl+1–5 the tabs, Ctrl+K a new chat, Esc back to the chat.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const n = Number(e.key);
  const tabs = [...document.querySelectorAll('#tabs button')].filter((b) => getComputedStyle(b).display !== 'none');
  if (n >= 1 && n <= tabs.length && !$('#tabs').classList.contains('hidden')) {
    e.preventDefault();
    tabs[n - 1].click();
  } else if (e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#newBtn').click();
  }
});

// The tab bar and the screens beyond the chat (screens.js).
for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => (navigator.vibrate?.(6), showView(b.dataset.tab)));
initScreens({ api, el, icon, markdown, toast, send, prefill, showView, AuthError, NetError, state, agentState, syncBack });

$('#pairInsecure').classList.toggle('hidden', !insecure);
// Offline app shell (needs HTTPS or localhost; on the plain local network the browser doesn't allow it).
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Opened from the pairing QR code (…/#pair=<secret>): take the secret out of the address bar and
// history at once, then pair with it.
const qr = /^#pair=([A-Za-z0-9_-]{43})$/.exec(location.hash);
const fromMove = /^#move=([A-Za-z0-9_-]{43})$/.exec(location.hash);
if (qr || fromMove) history.replaceState(null, '', location.pathname + location.search);
// Scanned with an Android phone's camera, the link opens in the browser. If the Siren app is installed,
// hand the link to it (siren://pair, android MainActivity); Chrome falls back to this page with ?web=1
// when it isn't, and the browser pairs as before. The one-time secret is used only once: either here or
// in the app, never both.
const handOff = qr && !android && /Android/i.test(navigator.userAgent) && !new URLSearchParams(location.search).has('web');
const fromQr = handOff ? null : qr;
renderLinkInfo();
if (handOff) offerApp(qr[1]);
else if (fromMove) finishMove(fromMove[1]);
else if (state.token) {
  start();
  if (fromQr) toast('This device is already connected.');
} else {
  show('pair');
  if (fromQr) pair({ secret: fromQr[1] });
}
