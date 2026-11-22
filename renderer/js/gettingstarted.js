// The getting-started card in the empty chat (in place of the suggestion chips): four things to try once,
// ticked off as the user really does them. The rules are gettingstartedcore.js; this module keeps the state
// in this window's localStorage (every read and write in try/catch: without storage the card still works
// for the session), hears the signals (chat.js: a reply done, a tool call, a spoken message; notes.js: a
// note saved, through the util event bus) and draws the card. Try only fills the message box, never sends.
import { $, el, on, toast } from './util.js';
import { state } from './state.js';
import * as core from './gettingstartedcore.js';

const KEY = 'siren.gettingStarted';
let current = load();

function load() {
  try {
    return core.fromStored(JSON.parse(localStorage.getItem(KEY) || 'null'));
  } catch {
    return core.initial(); // storage blocked or the value damaged: a fresh card for this session
  }
}

function store() {
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // storage blocked (a private profile): the state lives in memory for this session
  }
}

/** Something the user did: 'reply-done', 'tool:calendar_add_event', 'note-saved', 'spoken-turn' or 'hide'. */
export function note(event) {
  const next = core.step(current, event, Date.now());
  if (next === current) return;
  current = next;
  store();
  document.querySelectorAll('.gs-card').forEach(redraw);
}

/** A finished tool call (chat.js tool_end): calendar_add_event, or the assistant writing a note. */
export function noteTool(name, ok) {
  const ev = core.eventForTool(name, ok);
  if (ev) note(ev);
}

/** Reads the stored state again (the launch check's scene, after it set the storage aside). */
export function reload() {
  current = load();
}

/** Whether the card shows in an empty chat now. */
export const showing = () => core.visible(current);

on('note-saved', () => note('note-saved'));

/**
 * The card for an empty chat, or null when it is done or hidden. prefill(text): the example into the
 * message box (chat.js, through the outbox). The chips next to it (`.suggestions`) come back when it goes.
 */
export function gettingStartedCard({ prefill }) {
  if (!core.visible(current)) return null;
  const card = el('section', { class: 'gs-card glass', 'aria-labelledby': 'gsTitle' });
  card._prefill = prefill;
  redraw(card);
  return card;
}

function redraw(card) {
  if (!core.visible(current)) return gone(card);
  const p = core.progress(current);
  const key = state.settings?.stt?.pttKey || 'F8';
  const list = el(
    'ol',
    { class: 'gs-steps' },
    p.steps.map((s) =>
      el(
        'li',
        { class: `gs-step${s.done ? ' done' : ''}` },
        el('span', { class: 'gs-tick', 'aria-hidden': 'true' }, s.done ? '✓' : ''),
        el(
          'div',
          { class: 'gs-text' },
          el('strong', {}, s.title),
          el('span', { class: 'gs-hint' }, s.done ? 'Done.' : s.id === 'voice' ? `Hold the mic button or ${key} and speak.` : s.text),
        ),
        s.done ? null : el('button', { class: 'chip-btn gs-try', type: 'button', 'aria-label': `Try: ${s.title}`, onclick: () => tryStep(card, s, key) }, 'Try'),
      ),
    ),
  );
  card.replaceChildren(
    el(
      'div',
      { class: 'gs-head' },
      el('h2', { class: 'gs-title', id: 'gsTitle' }, 'Getting started'),
      el('span', { class: 'gs-count' }, `${p.done} of ${p.total} done`),
      el('button', { class: 'chip-btn gs-hide', type: 'button', title: 'Hide these tips for good', onclick: () => note('hide') }, 'Hide'),
    ),
    list,
  );
  hideChips(card, true);
}

function tryStep(card, s, key) {
  if (s.example) return card._prefill?.(s.example);
  // Talking can't be typed in: point at the mic instead.
  const mic = $('#micBtn');
  mic?.classList.remove('gs-point');
  void mic?.offsetWidth; // restart the pulse
  mic?.classList.add('gs-point');
  setTimeout(() => mic?.classList.remove('gs-point'), 2400);
  toast(`Hold the mic button (or ${key}) and say: “What’s on my calendar today?”`);
}

function gone(card) {
  hideChips(card, false);
  card.remove();
}

// The suggestion chips stand aside while the card shows in the same empty state.
function hideChips(card, hide) {
  const chips = card.parentElement?.querySelector('.suggestions');
  if (chips) chips.classList.toggle('hidden', hide);
}
