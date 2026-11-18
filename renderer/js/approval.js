// Approval dialog for consequential actions (self-modification, settings changes, deletions, shell
// commands). Answer by clicking, or by voice: a yes on its own ("yes", "okay", "approve", "go ahead"…)
// approves, "details" reads what will happen, anything else is a no (and the words go back to the
// agent as the reason, so "no, put it in drafts" steers it). Main decides how a yes may come
// (`req.voice`, commandcore.approvalAnswer): any spoken yes, only through the talk key (never an open
// microphone), or only a click. Words said before the approval appeared are not its answer: they go
// into the message box. Each spoken answer is acknowledged ("Approved" / "Declined"). No answer within
// the timeout counts as no. A spoken answer never starts a new turn or interrupts the paused task.
import { api, el, logEvent, toast, holdFocus } from './util.js';
import { state, ttsActive } from './state.js';
import { speaker, recordClip, analyzeClip, utteranceInfo } from './voice.js';
import { approvalAnswer, approvalPrompt, approvalHint } from './commandcore.js';

const KIND_LABEL = {
  self_modify: 'Self-modification',
  settings: 'Settings change',
  endpoint: 'Change where the brain or voice connects',
  permissions: 'Give the assistant more access',
  delete: 'Deletion',
  command: 'Run a command',
  calendar: 'Calendar change',
  invite: 'Calendar change that emails other people',
  voice: 'New voice',
  voice_clone: 'Clone a voice',
  repo_change: 'Change a repository (local branch)',
  github_publish: 'Publish to GitHub',
  connector: 'Use a connected service',
  connector_trust: 'Let a connected service run without asking',
  browser: 'Act on a website (agent window)',
  web_outbound: 'Open a new web address after reading outside content',
};
let current = null;
// Requests that arrive while one is open wait here and are shown in turn. They used to decline the open
// one ("superseded by another request"), so parallel calls (Claude runs several searches at once)
// cancelled each other and only the last could run.
const waiting = [];
const later = (fn, req) => (current ? (waiting.push({ fn, req: { ...req, queuedAt: Date.now() } }), true) : false);

export function initApprovals() {
  api.on('approval:request', show);
  api.on('secret:request', showSecret);
  api.on('record:request', showRecording);
  api.on('approval:cancel', ({ id }) => {
    const i = waiting.findIndex((w) => w.req.id === id);
    if (i >= 0) waiting.splice(i, 1);
    if (current?.id === id) close(false, 'timed out');
  });
  // Esc answers no (Cancel for a secret or a recording). While the voice speaks, the first Esc only
  // silences it (app.js's window listener); the next one answers.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current || e.isComposing || state.playing) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (current.secret || current.recording) answer(false, '');
    else answer(false, 'The user pressed Esc.');
  }, true);
}

export function approvalPending() {
  return Boolean(current);
}

// Called for every transcript while a request is open; returns true when it was consumed.
export function handleSpokenAnswer(text) {
  if (!current) return false;
  if (current.secret || current.recording) return true; // secrets are typed, never spoken; recordings use the buttons
  const u = utteranceInfo();
  const r = approvalAnswer(text, { voice: current.voice || 'any', source: u.source, startedAt: u.startedAt, shownAt: current.shownAt || 0, canRemember: Boolean(current.remember?.length) });
  if (r !== 'yes' && r !== 'always' && r !== 'no') logEvent('info', 'spoken answer not taken', { kind: current.kind, why: r });
  if (r === 'early') return keepWords(text), true;
  if (r === 'details') return speaker.say(`${current.title}. ${String(current.detail || '').slice(0, 400)}`), true;
  if (r === 'needs-click') return tell('This one needs a click on the screen: it came after reading outside content.'), true;
  if (r === 'needs-key') return tell(`Hold ${state.settings?.stt?.pttKey || 'the talk key'} and say yes, or click Approve.`), true;
  const allow = r !== 'no';
  logEvent('info', 'approval answered by voice', { kind: current.kind, allow, always: r === 'always' || undefined, source: u.source || undefined });
  toast(`🎙 ${allow ? 'Approved' : 'Declined'}: ${current.title}`);
  if (ttsActive()) speaker.follow(allow ? 'Approved.' : 'Declined.', { remember: true });
  if (allow) answer(true, '', r === 'always' ? current.remember[0].level : undefined);
  else answer(false, text);
  return true;
}

// Words said before the approval appeared: they were meant for the chat, so they wait in the message box.
function keepWords(text) {
  const input = document.getElementById('input');
  if (input) {
    input.value = (input.value ? `${input.value} ` : '') + text;
    input.dispatchEvent(new Event('input', { bubbles: true })); // the box grows to fit
  }
  toast('Your words went into the message box: you said them before the question appeared. Answer it with yes or no.');
}

function tell(message) {
  toast(message);
  if (ttsActive()) speaker.say(message);
}

function show(req) {
  if (later(show, req)) return;
  const wrap = document.getElementById('approvalModal');
  const card = document.getElementById('approvalCard');
  // The main process's time limit started when the request was sent, also while it waited in line.
  let left = Math.max(1, (req.timeoutSec || 75) - Math.round((Date.now() - (req.queuedAt || Date.now())) / 1000));
  const countdown = el('span', { class: 'muted' }, `${left}s`);
  const timer = setInterval(() => {
    left -= 1;
    countdown.textContent = `${Math.max(0, left)}s`;
  }, 1000);
  current = { ...req, timer };
  state.approvalPending = req;
  card.innerHTML = '';
  card.className = 'modal-card glass';
  card.style.cssText = '';
  card.append(
    el('h3', {}, `⚠ ${KIND_LABEL[req.kind] || 'Permission'} — approval needed`),
    el('div', { style: { fontSize: '16px' } }, `${state.settings.agent.name} wants to: `, el('b', {}, req.title)),
    req.tainted ? el('div', { class: 'evo-banner' }, `This turn read external content (${(req.sources || []).join(', ') || 'web/documents'}). Make sure this request is what you asked for — not something a web page, a document or a message in one of your services told the agent to do.`) : '',
    req.detail ? el('pre', { class: 'diff', style: { maxHeight: '260px', whiteSpace: 'pre-wrap', padding: '10px 12px' } }, req.detail) : '',
    el('div', { class: 'muted', style: { fontSize: '12px' } }, approvalHint(req, { pttKey: state.settings?.stt?.pttKey, handsFree: state.settings?.stt?.micMode === 'open' }), countdown),
    // "From now on" (connectors): approves and sets that service's level; changeable in Settings → AI brain.
    req.remember?.length
      ? el('div', { class: 'approval-remember' }, el('span', { class: 'hint' }, 'Approve, and don’t ask again:'), ...req.remember.map((c) => el('button', { class: 'chip-btn', title: 'Changeable any time in Settings → AI brain', onclick: () => answer(true, '', c.level) }, c.label)))
      : '',
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn danger', onclick: () => answer(false, 'The user clicked Deny.') }, 'Deny'), el('button', { class: 'btn primary', onclick: () => answer(true) }, 'Approve')),
  );
  wrap.classList.remove('hidden');
  current.release = holdFocus(wrap, card, { role: 'alertdialog', initial: card });
  current.shownAt = performance.now(); // speech that began before this isn't an answer to it
  if (ttsActive()) speaker.say(approvalPrompt(req));
  logEvent('info', 'approval requested', { kind: req.kind, title: req.title });
}

// Masked input for a token/key the agent needs (e.g. during setup). The value goes straight to the
// encrypted settings in the main process — it is never shown in the chat or sent to the model.
function showSecret(req) {
  if (later(showSecret, req)) return;
  const wrap = document.getElementById('approvalModal');
  const card = document.getElementById('approvalCard');
  const input = el('input', { class: 'input', type: 'password', placeholder: req.label, autocomplete: 'off' });
  current = { ...req, timer: null, secret: true };
  const submit = () => {
    const v = input.value.trim();
    if (!v) return input.focus();
    answer(true, v);
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  card.innerHTML = '';
  card.className = 'modal-card glass';
  card.style.cssText = '';
  card.append(
    el('h3', {}, `🔒 ${req.label}`),
    el('p', { class: 'muted' }, `${req.hint || ''} It is not shown in the chat and the agent never sees it.`),
    input,
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => answer(false, '') }, 'Cancel'), el('button', { class: 'btn primary', onclick: submit }, 'Save')),
  );
  wrap.classList.remove('hidden');
  current.release = holdFocus(wrap, card, { initial: input });
  logEvent('info', 'secret requested', req.label);
}

// The user reads a script aloud, then keeps the take, redoes it or cancels. For cloning the WAV goes
// to the main process (and on to VoiceStudio); for calibration ("calibrate") only the transcript and
// loudness levels do, the audio never leaves this window.
function showRecording(req) {
  if (later(showRecording, req)) return;
  const wrap = document.getElementById('approvalModal');
  const card = document.getElementById('approvalCard');
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
  card.className = 'modal-card glass';
  card.style.cssText = '';
  card.append(
    el('h3', {}, `🎙 ${req.title || 'Record a voice sample'}`),
    el('p', { class: 'muted' }, req.intro || 'This becomes a cloned voice in VoiceStudio. Read this aloud:'),
    el('blockquote', { class: 'test-result', style: { fontSize: '15px', lineHeight: '1.5' } }, req.script),
    status,
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => answer(false, '') }, 'Cancel'), recordBtn, useBtn),
  );
  wrap.classList.remove('hidden');
  current.release = holdFocus(wrap, card, { initial: recordBtn });
  logEvent('info', 'voice recording requested');
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function answer(allow, reason, remember) {
  if (!current) return;
  api.approval.respond(current.id, allow, reason || '', remember).catch(() => {});
  close(allow, reason);
}

function close() {
  if (!current) return;
  clearInterval(current.timer);
  current.cleanup?.();
  // Hidden and released before the next request in line is shown, so it remembers the right opener.
  document.getElementById('approvalModal').classList.add('hidden');
  current.release?.();
  current = null;
  state.approvalPending = null;
  // The next request in line, if any.
  const next = waiting.shift();
  if (next) next.fn(next.req);
}
