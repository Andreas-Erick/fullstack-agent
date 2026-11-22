// Pairing this device (a code or the QR code's link), disconnecting it, and moving to the secure address.
import { DEADLINES } from './sync.js';
import { $, TOKEN_KEY, NAME_KEY, android, bridge, store, state } from './state.js';
import { el, icon, toast, AuthError, NetError, submitForm } from './ui.js';
import { fetchWithin, tunnelDown, answerError, api } from './net.js';
import { insecure } from './offline.js';
import { closeDrawer } from './conversations.js';
import { syncBack } from './nav.js';
import { start } from './boot.js';

export function show(screen) {
  $('#pair').classList.toggle('hidden', screen !== 'pair');
  $('#main').classList.toggle('hidden', screen !== 'main');
  syncBack();
}

// ------------------------------------------------------------------ pairing
// The pairing QR code opened in the phone's browser: open the Siren app with it (Chrome's intent: link,
// falling back to this page in the browser), and let the user choose if the browser held the jump back.
export function offerApp(secret) {
  const link = `${location.origin}/#pair=${secret}`;
  const web = `${location.origin}/?web=1#pair=${secret}`;
  const intent = `intent://pair?u=${encodeURIComponent(link)}#Intent;scheme=siren;package=com.nexusagent.android;S.browser_fallback_url=${encodeURIComponent(web)};end`;
  show('pair');
  $('#pairForm').classList.add('hidden');
  const box = el('div', { class: 'handoff' },
    el('p', {}, 'Open this pairing in the Siren app?'),
    el('a', { class: 'btn primary', href: intent }, 'Open in the Siren app'),
    el('a', { class: 'btn ghost', href: web }, 'Continue in the browser'),
  );
  $('#pairForm').after(box);
  location.href = intent; // may be held back without a tap; the buttons are then the way
}

export function unpair(message) {
  state.token = null;
  store.set(TOKEN_KEY, null);
  bridge('clearToken');
  state.stream?.abort();
  closeDrawer();
  show('pair');
  if (message) showPairError(message);
}

// Disconnecting deletes this device's token (the watch stops too): the first tap arms, a second one
// within 5 s disconnects; a double tap (under 0.4 s) counts once. The note above the button says why
// (empty until armed, so the live region exists before it speaks).
const unpairNote = el('p', { class: 'unpair-note', role: 'status' });
$('#unpairBtn').before(unpairNote);
let unpairArmedAt = 0;
let unpairTimer = 0;
export function disarmUnpair() {
  clearTimeout(unpairTimer);
  unpairArmedAt = 0;
  $('#unpairBtn').classList.remove('armed');
  $('#unpairBtn').textContent = 'Disconnect this device';
  unpairNote.textContent = '';
}
export function tapUnpair() {
  if (unpairArmedAt && Date.now() - unpairArmedAt >= 400) return unpair('Disconnected. To remove this device completely, remove it in the desktop app’s Settings too.');
  if (unpairArmedAt) return;
  unpairArmedAt = Date.now();
  $('#unpairBtn').classList.add('armed');
  $('#unpairBtn').textContent = 'Tap again to disconnect';
  unpairNote.textContent = 'You’ll need a new pairing code from the computer; the watch stops too.';
  unpairTimer = setTimeout(disarmUnpair, 5000);
}

function showPairError(msg) {
  const e = $('#pairError');
  e.textContent = msg;
  e.classList.toggle('hidden', !msg);
}

// { code } typed, or { secret } from the QR code's link.
export async function pair(proof) {
  const btn = $('#pairBtn');
  if (btn.disabled) return;
  showPairError('');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const res = await fetchWithin('/api/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...proof, name: $('#pairName').value.trim() || guessName() }),
    }, DEADLINES.pair);
    if (tunnelDown(res)) throw new NetError('Your computer isn’t answering right now.');
    if (!res.ok) {
      if (proof.secret && res.status === 403) throw new Error('This QR code has expired or was already used. Click “Pair a device” on the computer again.');
      throw await answerError(res);
    }
    const data = await res.json().catch(() => ({}));
    state.token = data.token;
    store.set(TOKEN_KEY, data.token);
    store.set(NAME_KEY, data.name);
    $('#pairCode').value = '';
    start();
  } catch (err) {
    showPairError(err.message);
    if (!proof.secret) $('#pairCode').select();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

$('#pairForm').addEventListener('submit', (e) => {
  e.preventDefault();
  pair({ code: $('#pairCode').value.trim() });
});
// Digits only; the sixth one connects.
$('#pairCode').addEventListener('input', (e) => {
  const v = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (v !== e.target.value) e.target.value = v;
  if (v.length === 6 && document.activeElement === e.target) submitForm($('#pairForm'));
});

function guessName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  if (/iPhone/i.test(ua)) return 'iPhone';
  // An iPad announces itself as a Mac (Safari's desktop mode), but a Mac has no touch screen.
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  return 'Browser';
}
// ------------------------------------------------------------------ secure address
// On the plain local address with a secure one set up on the computer: one tap moves this device
// there (same pairing, new token). See companion.js "moving to the secure address".
export async function moveToSecure() {
  const btn = $('#moveBtn');
  btn.disabled = true;
  try {
    const { url, secret } = await api('/api/move', { method: 'POST', body: {} });
    if (android?.moveTo) bridge('moveTo', url, secret);
    else location.assign(`${url}/#move=${secret}`);
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message);
  } finally {
    btn.disabled = false;
  }
}
$('#moveBtn').addEventListener('click', moveToSecure);

export async function finishMove(secret) {
  show('pair');
  showPairError('');
  $('#pairBtn').disabled = true;
  $('#pairBtn').textContent = 'Switching…';
  try {
    const res = await fetchWithin('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ move: secret }) }, DEADLINES.pair);
    if (tunnelDown(res)) throw new NetError('Your computer isn’t answering right now.');
    if (!res.ok) throw await answerError(res);
    const data = await res.json().catch(() => ({}));
    state.token = data.token;
    store.set(TOKEN_KEY, data.token);
    store.set(NAME_KEY, data.name);
    start();
    toast('Switched to the secure address 🔒');
  } catch (err) {
    showPairError(`${err.message} You can also pair again with a code.`);
  } finally {
    $('#pairBtn').disabled = false;
    $('#pairBtn').textContent = 'Connect';
  }
}

export function renderLinkInfo() {
  const secure = !insecure;
  const here = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  $('#linkInfo').replaceChildren(icon(secure ? 'lock' : 'lock-open'), el('div', {}, el('b', {}, here ? 'This computer' : secure ? 'Encrypted connection' : 'Local network, not encrypted'), el('small', {}, location.host)));
  $('#linkInfo').classList.toggle('secure', secure);
  $('#moveBtn').classList.toggle('hidden', !(insecure && state.secureUrl));
}
