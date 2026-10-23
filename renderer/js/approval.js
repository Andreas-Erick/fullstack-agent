// Approval dialog for consequential actions (self-modification, settings changes, deletions, shell
// commands). Answer by clicking, or by voice: an exact "yes" approves, "details" reads what will
// happen, anything else is a no (and the words go back to the agent as the reason). No answer within
// the timeout counts as no. A spoken answer never starts a new turn or interrupts the paused task.
import { api, el, logEvent } from './util.js';
import { state, ttsActive } from './state.js';
import { speaker } from './voice.js';

const KIND_LABEL = { self_modify: 'Self-modification', settings: 'Settings change', delete: 'Deletion', command: 'Run a command' };
let current = null;

export function initApprovals() {
  api.on('approval:request', show);
  api.on('secret:request', showSecret);
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
  if (current.secret) return true; // secrets are typed, never spoken
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/g, '');
  if (/^(yes|yeah yes|yes please|yes do it)$/.test(t)) answer(true);
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

function answer(allow, reason) {
  if (!current) return;
  api.approval.respond(current.id, allow, reason || '').catch(() => {});
  close(allow, reason);
}

function close() {
  if (!current) return;
  clearInterval(current.timer);
  current = null;
  state.approvalPending = null;
  document.getElementById('modal').classList.add('hidden');
}
