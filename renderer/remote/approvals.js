// Approval cards: Allow / Deny from the phone, or a note that one is answered on the computer.
import { $ } from './state.js';
import { el, toast, AuthError } from './ui.js';
import { api } from './net.js';

// ------------------------------------------------------------------ approvals
const KIND = { self_modify: 'Change its own code', settings: 'Change a setting', endpoint: 'Change where it connects', permissions: 'Get more access', delete: 'Delete something', command: 'Run a command', calendar: 'Change your calendar', invite: 'Send calendar invitations', voice: 'Change its voice', voice_clone: 'Clone a voice', repo_change: 'Change a repository', github_publish: 'Publish to GitHub', connector: 'Use a connected service', connector_trust: 'Stop asking for a service', browser: 'Act on a website', web_outbound: 'Open a web address' };

// The buttons wait a moment before they respond, so a tap meant for something else (the card pops in
// above the keyboard while typing) can't answer it.
const ARM_MS = 900;
const timers = new Map(); // approval id -> countdown interval

export function addApproval(a) {
  removeApproval(a.id);
  const sources = Array.isArray(a.sources) ? a.sources.slice(0, 5).map((s) => String(s).slice(0, 200)) : [];
  const left = el('span', { class: 'left' });
  const buttons = [
    el('button', { class: 'btn', type: 'button', disabled: '', onclick: () => answer(a.id, false) }, 'Deny'),
    el('button', { class: 'btn primary', type: 'button', disabled: '', onclick: () => answer(a.id, true) }, 'Allow'),
  ];
  const card = el('div', { class: 'approval', 'data-id': a.id, role: 'alertdialog', 'aria-label': a.title || 'Approval needed' },
    el('div', { class: 'kind' }, KIND[a.kind] || a.kind, left),
    el('b', {}, a.title || 'Approval needed'),
    a.detail ? el('pre', { class: 'detail' }, String(a.detail).slice(0, 1500)) : null,
    a.tainted ? el('div', { class: 'warn' }, '⚠ This turn read outside content (web pages or documents). Make sure this is what you asked for.', sources.length ? el('ul', { class: 'sources' }, sources.map((s) => el('li', {}, s))) : null) : null,
    // Self-changes and "stop asking for a service" are answered only on the computer (companion.js).
    a.desktopOnly ? el('div', { class: 'desktop-only' }, 'Approve or deny this one on your computer.') : el('div', { class: 'row' }, buttons),
  );
  $('#approvals').append(card);
  if (!a.desktopOnly) setTimeout(() => buttons.forEach((b) => b.removeAttribute('disabled')), ARM_MS);
  // Countdown to the automatic "no" on the computer.
  const ends = Date.now() + (a.expiresIn ?? a.timeoutSec ?? 0) * 1000;
  const tick = () => {
    const s = Math.round((ends - Date.now()) / 1000);
    if (s <= 0) return removeApproval(a.id);
    left.textContent = ` · ${s}s`;
  };
  if (a.expiresIn ?? a.timeoutSec) {
    tick();
    timers.set(a.id, setInterval(tick, 1000));
  }
  navigator.vibrate?.(80);
}

export function removeApproval(id) {
  clearInterval(timers.get(id));
  timers.delete(id);
  document.querySelector(`.approval[data-id="${CSS.escape(String(id))}"]`)?.remove();
}

async function answer(id, allow) {
  removeApproval(id);
  try {
    await api(`/api/approvals/${encodeURIComponent(id)}`, { method: 'POST', body: { allow } });
  } catch (err) {
    if (!(err instanceof AuthError)) toast(err.message.includes('No open approval') ? 'Already answered (or timed out).' : err.message);
  }
}
