// Push-to-talk: the recording, sent to the computer to be written down, then sent like a typed message.
import { transcribeDeadline, micError, releasePlan } from './sync.js';
import { $, android, bridge, chat, state } from './state.js';
import { toast, NetError } from './ui.js';
import { fetchWithin, tunnelDown, answerError } from './net.js';
import { unpair } from './pairing.js';
import { send } from './chatview.js';
import { refreshFace } from './face.js';

// ------------------------------------------------------------------ push-to-talk
// Hold the mic, release to send. The recording (16 kHz mono WAV, at most two minutes) is transcribed on the
// computer with its usual speech-to-text, then sent like a typed message. Browsers allow the
// microphone only on secure pages, so the button shows on the HTTPS address only.
const MAX_REC_MS = 120000; // the server takes as much (main/companion.js MAX_AUDIO_SEC)
let rec = null;

// toggle: a tap (or the Talk tile, a shortcut, Enter): it stops on the next tap of the mic, not on release.
async function startRecording({ toggle = false } = {}) {
  if (rec || chat.own) return;
  const mine = { chunks: [], starting: true, toggle, asked: Date.now() };
  rec = mine;
  $('#micBtn').setAttribute('aria-pressed', 'true'); // live from the press on, also while the microphone starts
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    state.micBlocked = false;
    if (rec !== mine) {
      stream.getTracks().forEach((t) => t.stop());
      // The permission prompt took the touch away (pointercancel, blur): say it is ready now, instead of nothing.
      if (mine.lost && Date.now() - mine.asked > 600) toast('Microphone allowed. Tap or hold the mic to talk.');
      return;
    }
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      rec?.chunks.push(new Float32Array(data));
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      state.micLevel = Math.min(1, Math.sqrt(sum / data.length) * 5); // same scale as the desktop
    };
    src.connect(node);
    node.connect(ctx.destination);
    Object.assign(rec, { stream, ctx, node, rate: ctx.sampleRate, started: Date.now(), starting: false, limit: setTimeout(() => (toast('That’s the two-minute limit: sending what you said.'), stopRecording()), MAX_REC_MS) });
    $('#micBtn').classList.add('live');
    showRecBar(rec);
    state.recording = true;
    refreshFace();
    navigator.vibrate?.(30);
  } catch (err) {
    if (rec === mine) (rec = null), $('#micBtn').setAttribute('aria-pressed', 'false');
    // Refused for good in the Android app: the way back is its settings (nexusMicBlocked, below).
    if (android && state.micBlocked && err?.name === 'NotAllowedError') micBlockedNotice();
    else toast(micError(err, { app: Boolean(android) }));
  }
}

// Inside the Android app the microphone is the app's permission, not the page's: refused with "don't ask
// again" (MainActivity), only Android's settings can allow it.
function micBlockedNotice() {
  const settings = typeof android?.openAppSettings === 'function';
  toast('The microphone is off for Siren in Android settings.', settings ? { label: 'Open settings', run: () => bridge('openAppSettings', 'app') } : null);
}
window.nexusMicBlocked = () => {
  state.micBlocked = true;
  micBlockedNotice();
};

async function stopRecording() {
  const r = rec;
  rec = null;
  $('#micBtn').setAttribute('aria-pressed', 'false');
  if (!r || r.starting) return;
  clearTimeout(r.limit);
  r.node.disconnect();
  r.stream.getTracks().forEach((t) => t.stop());
  r.ctx.close().catch(() => {}); // already closed
  state.micLevel = 0;
  $('#micBtn').classList.remove('live');
  hideRecBar();
  state.recording = false;
  if (Date.now() - r.started < 400) return refreshFace(), toast('Too short to hear anything: tap the mic, speak, then tap it again.');
  const mic = $('#micBtn');
  mic.classList.add('busy');
  state.transcribing = true;
  refreshFace();
  $('#faceState').textContent = 'TRANSCRIBING';
  try {
    const wav = encodeWav(await to16k(r.chunks, r.rate));
    const res = await fetchWithin('/api/transcribe', { method: 'POST', headers: { Authorization: `Bearer ${state.token}`, 'Content-Type': 'audio/wav' }, body: wav }, transcribeDeadline(wav.byteLength));
    if (res.status === 401) return unpair('This device was disconnected from the assistant. Pair it again.');
    // A tunnel's error page for a computer that is off (as api() reads it): not the computer's own JSON.
    if (tunnelDown(res)) throw new NetError('Your computer isn’t answering right now.');
    if (!res.ok) throw await answerError(res, { recording: true });
    const data = await res.json().catch(() => ({}));
    state.transcribing = false;
    refreshFace();
    if (data.text?.trim()) send(data.text.trim());
    else toast('I didn’t catch that.');
  } catch (err) {
    state.transcribing = false;
    refreshFace();
    toast(err.message);
  } finally {
    mic.classList.remove('busy');
    if (state.transcribing) (state.transcribing = false), refreshFace(); // unpaired meanwhile
  }
}

// While recording: elapsed time and the input level above the message box.
let recTimer = null;
function showRecBar(r) {
  $('#recHint').textContent = r.toggle ? 'Tap the mic to send' : 'Release to send';
  $('#recBar').classList.remove('hidden');
  const tick = () => {
    const s = Math.floor((Date.now() - r.started) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('#recLevel').style.transform = `scaleX(${Math.max(0.04, state.micLevel).toFixed(3)})`;
  };
  tick();
  clearInterval(recTimer);
  recTimer = setInterval(tick, 100);
}
function hideRecBar() {
  clearInterval(recTimer);
  $('#recBar').classList.add('hidden');
}

async function to16k(chunks, rate) {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const c of chunks) all.set(c, (o += c.length) - c.length);
  if (rate === 16000) return all;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil((n * 16000) / rate)), 16000);
  const buf = off.createBuffer(1, n, rate);
  buf.copyToChannel(all, 0);
  const s = off.createBufferSource();
  s.buffer = buf;
  s.connect(off.destination);
  s.start();
  return (await off.startRendering()).getChannelData(0);
}

function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return buf;
}

if (window.isSecureContext && navigator.mediaDevices?.getUserMedia) {
  // Hold and release to send, or tap to start and tap again to send (sync.js releasePlan): a quick touch,
  // TalkBack's double tap, Enter or Space all listen until the next tap.
  const mic = $('#micBtn');
  mic.classList.remove('hidden');
  let pressAt = 0; // the press in progress (0: none)
  let pointerAt = 0; // the last press by pointer: the click that follows it was handled already
  const toToggle = () => {
    rec.toggle = true;
    if (!rec.starting) $('#recHint').textContent = 'Tap the mic to send';
  };
  // The touch was taken away (the permission prompt, another app): a hold that recorded sends, one that
  // hadn't started is dropped (startRecording says when the microphone is ready).
  const lostPress = () => {
    if (!pressAt) return;
    pressAt = 0;
    pointerAt = Date.now();
    if (!rec || rec.toggle) return;
    if (rec.starting) (rec.lost = true), (rec = null), mic.setAttribute('aria-pressed', 'false');
    else stopRecording();
  };
  mic.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointerAt = Date.now();
    if (rec) return stopRecording(); // the second tap; or a hold whose release never arrived
    try {
      mic.setPointerCapture(e.pointerId); // keep the release even if the finger slides off
    } catch {
      /* not a real pointer */
    }
    pressAt = Date.now();
    startRecording();
  });
  mic.addEventListener('pointerup', () => {
    if (!pressAt) return;
    const heldMs = Date.now() - pressAt;
    pressAt = 0;
    pointerAt = Date.now();
    if (!rec || rec.toggle) return;
    if (releasePlan({ heldMs, starting: rec.starting }) === 'toggle') toToggle();
    else stopRecording();
  });
  mic.addEventListener('pointercancel', lostPress);
  window.addEventListener('blur', lostPress);
  mic.addEventListener('click', () => {
    if (Date.now() - pointerAt < 700) return; // the press above did it
    if (rec) return stopRecording();
    startRecording({ toggle: true });
  });
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
  // The Android Talk tile / shortcut: start listening; tap the mic to send.
  window.nexusTalk = () => {
    if (!state.token) return;
    startRecording({ toggle: true }).then(() => rec && toast('Listening… tap the mic to send.'));
  };
}
