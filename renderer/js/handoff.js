// "Where we left off" (main/handoff.js): the card on an empty chat that offers to continue the last
// conversation, and the note for the launch greeting. The note itself is written while the window is
// already hidden (main.js closeWithHandoff), so there is no closing screen.
import { api, el } from './util.js';

let note; // the note from the last close (null when none, or dismissed)
const loaded = api.handoff
  .get()
  .then((n) => (note = n && !n.dismissed ? n : null))
  .catch(() => (note = null));

export const handoffNote = () => loaded.then(() => note);

const ago = (t) => {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 60) return `${Math.max(1, min)} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
};

/** A slot for the empty chat; fills itself once the note is loaded. onContinue(conversationId). */
export function handoffSlot(onContinue) {
  const slot = el('div', { class: 'handoff-slot' });
  handoffNote().then((n) => {
    if (!n) return;
    const list = (title, items) => (items?.length ? el('div', { class: 'handoff-list' }, el('span', { class: 'handoff-label' }, title), el('ul', {}, items.map((x) => el('li', {}, x)))) : null);
    const card = el('div', { class: 'handoff-card glass' },
      el('div', { class: 'handoff-head' },
        el('span', { class: 'handoff-kicker' }, `Where we left off · ${ago(n.at)}`),
        el('button', { class: 'icon-btn handoff-x', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => dismiss(slot) }, '✕'),
      ),
      el('b', {}, n.topic || n.title),
      el('p', {}, n.summary),
      list('Next steps', n.nextSteps),
      list('Open', n.openThreads),
      el('div', { class: 'row' }, el('button', { class: 'btn primary small', onclick: () => onContinue(n.conversationId) }, `Continue “${n.title}”`)),
    );
    slot.replaceChildren(card);
  });
  return slot;
}

function dismiss(slot) {
  note = null;
  slot.replaceChildren();
  api.handoff.dismiss().catch(() => {}); // the card is gone either way; the note is replaced at the next close
}
