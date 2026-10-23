// Approval dialog for consequential actions (self-modification, settings changes, deletions, shell
// commands). Answer by clicking, or by voice: a yes on its own ("yes", "yeah", "okay", "go ahead"…)
// approves, "details" reads what will happen, anything else is a no (and the words go back to the
// agent as the reason, so "no, put it in drafts" steers it). No answer within
// the timeout counts as no. A spoken answer never starts a new turn or interrupts the paused task.
import { api, el, logEvent } from './util.js';
import { state, ttsActive } from './state.js';
import { speaker, recordClip, analyzeClip } from './voice.js';

const KIND_LABEL = {
  self_modify: 'Self-modification',
  settings: 'Settings change',
  delete: 'Deletion',
  command: 'Run a command',
  calendar: 'Calendar change',
  invite: 'Calendar change that emails other people',
  voice: 'New voice',
  voice_clone: 'Clone a voice',
  repo_change: 'Change a repository (local branch)',
  github_publish: 'Publish to GitHub',
};
let current = null;

// Spoken alone, these approve. Anything longer is a sentence, so it declines and goes back as the reason.
const YES = new Set(['yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'go ahead', 'do it', 'approved', 'yes please', 'yeah yes', 'yes do it', 'yes go ahead']);

export function initApprovals() {
  api.on('approval:request', show);
  api.on('secret:request', showSecret);
  api.on('record:request', showRecording);
  api.on('approval:cancel', ({ id }) => {
    if (current?.id === id) close(false, 'timed out');
  });
}

export function approvalPending() {
  return Boolean(current);
}

// Called for every transcript while a request is open; returns true when it was consumed.
export function handleSpokenAnswer(text) {
  if (!current) return false;
  if (current.secret || current.recording) return true; // secrets are typed, never spoken; recordings use the buttons
  // Whisper adds interior punctuation ("Yes, please."), so match on letters only.
  const t = text.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (YES.has(t)) answer(true);
  else if (/^(details|show details|what exactly)$/.test(t)) speaker.say(`${current.title}. ${current.detail.slice(0, 400)}`);
  else answer(false, text);
  return true;
}

function show(req) {
  if (current) answer(false, 'superseded by another request');
  const wrap = document.getElementById('modal');
  const card = document.getElementById('modalCard');
  let left = req.timeoutSec || 75;
  const countdown = el('span', { class: 'muted' }, `${left}s`);
  const timer = setInterval(() => {
    left -= 1;
    countdown.textContent = `${Math.max(0, left)}s`;
  }, 1000);
  current = { ...req, timer };
  state.approvalPending = req;
  card.innerHTML = '';
  card.append(
    el('h3', {}, `⚠ ${KIND_LABEL[req.kind] || 'Permission'} — approval needed`),
    el('div', { style: { fontSize: '16px' } }, `${state.settings.agent.name} wants to: `, el('b', {}, req.title)),
    req.tainted ? el('div', { class: 'evo-banner' }, `This turn read external content (${(req.sources || []).join(', ') || 'web/documents'}). Make sure this change is what you asked for — not something a web page or document told the agent to do.`) : '',
    req.detail ? el('pre', { class: 'diff', style: { maxHeight: '260px', whiteSpace: 'pre-wrap', padding: '10px 12px' } }, req.detail) : '',
    el('div', { class: 'muted', style: { fontSize: '12px' } }, 'Say “yes” to approve, “details” to hear more — anything else declines. ', countdown),
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn danger', onclick: () => answer(false, 'The user clicked Deny.') }, 'Deny'), el('button', { class: 'btn primary', onclick: () => answer(true) }, 'Approve')),
  );
  wrap.classList.remove('hidden');
  wrap.onclick = null;
  if (ttsActive()) speaker.say(`Permission needed: ${req.title}. Say yes or no.`);
  logEvent('info', 'approval requested', { kind: req.kind, title: req.title });
}

// Masked input for a token/key the agent needs (e.g. during setup). The value goes straight to the
// encrypted settings in the main process — it is never shown in the chat or sent to the model.
function showSecret(req) {
  if (current) answer(false, 'superseded by another request');
  const wrap = document.getElementById('modal');
  const card = document.getElementById('modalCard');
  const input = el('input', { class: 'input', type: 'password', placeholder: req.label, autocomplete: 'off' });
  current = { ...req, timer: null, secret: true };
  const submit = () => {
    const v = input.value.trim();
    if (!v) return input.focus();
    answer(true, v);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  card.innerHTML = '';
  card.append(
    el('h3', {}, `🔒 ${req.label}`),
    el('p', { class: 'muted' }, `${req.hint || ''} It is not shown in the chat and the agent never sees it.`),
    input,
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => answer(false, '') }, 'Cancel'), el('button', { class: 'btn primary', onclick: submit }, 'Save')),
  );
  wrap.classList.remove('hidden');
  wrap.onclick = null;
  setTimeout(() => input.focus(), 50);
  logEvent('info', 'secret requested', req.label);
}

// The user reads a script aloud, then keeps the take, redoes it or cancels. For cloning the WAV goes
// to the main process (and on to VoiceStudio); for calibration ("calibrate") only the transcript and
// loudness levels do, the audio never leaves this window.
function showRecording(req) {
  if (current) answer(false, 'superseded by another request');
  const wrap = document.getElementById('modal');
  const card = document.getElementById('modalCard');
  const max = Math.min(60, Math.max(8, Number(req.seconds) || 20));
  const status = el('div', { class: 'test-result' }, 'Press Record, then read the text aloud in your normal voice, in a quiet room.');
  const recordBtn = el('button', { class: 'btn primary' }, '● Record');
  const useBtn = el('button', { class: 'btn primary', style: { display: 'none' } }, 'Stop & use');
  let clip = null;
  let ticker = null;
  current = { ...req, timer: null, recording: true, cleanup: () => (clearInterval(ticker), clip?.cancel()) };

  const retry = (message) => {
    status.className = 'test-result err';
    status.textContent = message;
    recordBtn.textContent = '● Record again';
    recordBtn.style.display = '';
    useBtn.style.display = 'none';
  };
  const finish = async () => {
    clearInterval(ticker);
    const took = clip.seconds();
    const take = clip.stop();
    clip = null;
    if (took < 5) return retry('That was under 5 seconds. Read the whole text, then stop.');
    if (req.mode !== 'calibrate') return answer(true, toBase64(take.wav()));
    // Calibration only needs what speech-to-text heard and how loud it was; the audio stays here.
    useBtn.style.display = 'none';
    status.className = 'test-result';
    status.textContent = 'Listening back to how that came through…';
    try {
      const result = await analyzeClip(take.samples, take.rate);
      if (!result.transcript) return retry('I couldn’t make out any words. Check the microphone, then record again.');
      answer(true, JSON.stringify(result));
    } catch (err) {
      retry(`Speech-to-text failed: ${err.message}`);
    }
  };
  recordBtn.onclick = async () => {
    try {
      clip = await recordClip();
    } catch (err) {
      status.className = 'test-result err';
      status.textContent = `Microphone: ${err.message}`;
      return;
    }
    status.className = 'test-result ok';
    recordBtn.style.display = 'none';
    useBtn.style.display = '';
    ticker = setInterval(() => {
      const t = clip?.seconds() || 0;
      status.textContent = `● Recording… ${t.toFixed(0)} s (stops by itself at ${max} s)`;
      if (t >= max) finish();
    }, 250);
  };
  useBtn.onclick = finish;

  card.innerHTML = '';
  card.append(
    el('h3', {}, `🎙 ${req.title || 'Record a voice sample'}`),
    el('p', { class: 'muted' }, req.intro || 'This becomes a cloned voice in VoiceStudio. Read this aloud:'),
    el('blockquote', { class: 'test-result', style: { fontSize: '15px', lineHeight: '1.5' } }, req.script),
    status,
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => answer(false, '') }, 'Cancel'), recordBtn, useBtn),
  );
  wrap.classList.remove('hidden');
  wrap.onclick = null;
  logEvent('info', 'voice recording requested');
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function answer(allow, reason) {
  if (!current) return;
  api.approval.respond(current.id, allow, reason || '').catch(() => {});
  close(allow, reason);
}

function close() {
  if (!current) return;
  clearInterval(current.timer);
  current.cleanup?.();
  current = null;
  state.approvalPending = null;
  document.getElementById('modal').classList.add('hidden');
}
