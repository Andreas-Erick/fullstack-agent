// The Face layout's reply card (#replyCard): what it shows, decided from what happens. The Face layout hides
// the conversation, so the latest reply shows on a card over the face: as it is written when it isn't spoken
// (voice off or muted, or past voice.speakLimit: "the rest is on the screen"), else when it is done; a
// failure in the error colour. It goes away with the next message, a new conversation, ✕, Esc, "Open in
// chat" or another layout; put away by the user it stays away for the rest of that reply. A conversation
// opened in the layout shows one thing: the message History found, else a recent failure, else (from
// History) its latest reply.
//
// Pure (no DOM, no window): chat.js reports the events and paints the decisions. Each event returns a
// decision: { type: 'show', card } | { type: 'hide' } | null (leave the card as it is). A card is
// { kind, text, at, reply, kicker, plain, error, follow }:
//   kind 'live'    the reply being written (follow: keep the newest text in view)
//   kind 'reply'   a finished reply (reply: the stored message, for its buttons)
//   kind 'error'   a failure (error: the raw text, for chatcore.errorHelp), in the error colour
//   kind 'stopped' a stop, or a message that got no reply (Try again)
//   kind 'message' a message of the conversation opened (kicker: who and when; plain: the user's own text)
// `turn` is any value that names this window's reply being written (chat.js passes turnstate's own turn):
// the per-reply flags (not spoken, closed, behind) belong to it and start over with the next one.
import * as chatcore from './chatcore.js';

export const DEFAULT_KICKER = 'Latest reply';

/** isFace(): whether the chat shows the Face layout now (chat.js reads its view's class). */
export function createReplyCard({ isFace = () => false } = {}) {
  let card = null; // the card shown, or null when hidden
  let turn = null;
  let live = false; // the reply isn't spoken: read on the card as it is written
  let closed = false; // put away by the user: away for the rest of the reply
  let behind = false; // the Face layout left its bubble empty while it streamed

  const own = (t) => {
    if (t === turn) return;
    turn = t;
    live = closed = behind = false;
  };
  const show = (c) => {
    card = { kind: 'reply', text: '', at: null, reply: null, kicker: DEFAULT_KICKER, plain: false, error: '', follow: false, ...c };
    if (!card.at) card.at = card.reply?.id || null;
    return { type: 'show', card };
  };
  const hide = () => {
    card = null;
    return { type: 'hide' };
  };
  const failureCard = (f) => (f.failed ? show({ kind: 'error', error: f.error || '' }) : show({ kind: 'stopped', text: f.text || '' }));

  return {
    /** The card shown (read it, don't change it), or null. */
    get card() {
      return card;
    },
    get shown() {
      return Boolean(card);
    },
    /** The message the card shows, for "Open in chat". */
    get at() {
      return card?.at || null;
    },

    /** Hidden, nothing more: a message sent, the latest exchange dropped, a conversation being opened. */
    hide,

    /** ✕, Esc on the card, a new conversation: hidden, and it stays away for the rest of this reply. */
    close(t) {
      own(t);
      if (t) closed = true;
      return hide();
    },

    /** "Open in chat": hidden; `at` is the message the chat should open at (else its latest reply). */
    openInChat() {
      const at = card?.at || null;
      return { ...hide(), at };
    },

    /** Text arrived for this window's reply; spoken: it went to the voice (else it is read on the card). */
    text(t, { spoken = false } = {}) {
      own(t);
      if (!spoken) live = true;
    },

    /**
     * A frame of the reply being written. render: 'card' (the decision shows it, follow), 'bubble' (the list
     * shows it) or null (nothing shows it: render nothing). Once up, the card follows the text, also after a
     * retract (whose speaker.stop() clears capped). capped: the voice reached its speakLimit.
     */
    frame(t, { text = '', capped = false } = {}) {
      own(t);
      const face = isFace();
      behind = face;
      if (!face) return { render: 'bubble', decision: null };
      if (closed || !(live || capped || card)) return { render: null, decision: null };
      return { render: 'card', decision: show({ kind: 'live', text, follow: true }) };
    },

    /**
     * This window's reply ended. outcome 'done' (message: the stored reply), 'failed' (error), 'stopped'.
     * onScreen: whether the end is in view where the chat is (not on a card the user closed).
     */
    ended(t, { outcome, text = '', message = null, error = '' } = {}) {
      own(t);
      const face = isFace();
      const onScreen = !face || !closed;
      let decision = null;
      if (face && !closed) {
        if (outcome === 'done') {
          const m = message || { role: 'assistant', content: text };
          // A turn that only used tools has nothing to read: no empty card.
          decision = (m.content || '').trim() ? show({ kind: 'reply', text: m.content, reply: m }) : hide();
        } else if (outcome === 'failed') decision = show({ kind: 'error', text, error }); // the layout shows nothing else
        else if (card) decision = show({ kind: 'stopped', text: text || '*(stopped)*' }); // only where it was being read
      }
      return { decision, onScreen };
    },

    /**
     * The layout setting changed. Leaving the Face layout puts the card away (it comes back with the next
     * reply, not with the layout); fill: the reply's bubble was left empty and must be filled now.
     */
    layout(face, t) {
      if (face) return null;
      const fill = Boolean(t) && t === turn && behind;
      if (fill) behind = false;
      return { ...hide(), fill };
    },

    /**
     * A conversation was opened (and its messages drawn). fromHistory: chosen in History; found: the id of
     * the message History's search found, when the chat could show it; failed: turnstate's failedCard() (a
     * failure of the last 24 h); agent: the persona's name.
     */
    opened({ messages = [], fromHistory = false, found = null, failed = null, agent = '' } = {}) {
      if (!isFace()) return null;
      if (fromHistory && found) return messageCard(messages, found, agent);
      if (failed) return failureCard(failed);
      if (fromHistory) return messageCard(messages, null, agent);
      return null;
    },

    /**
     * The card's buttons, from turnstate's actions() (drawn after it ended the reply, so a finished one
     * offers its own): Copy, Regenerate and Edit on a finished reply (the latter two when it is the latest);
     * Try again and Edit after a stop. None while live; a failure's are in its own box.
     */
    buttons(actions = {}) {
      if (!card || card.follow || card.kind === 'error') return [];
      const out = [];
      if (card.reply) {
        out.push({ action: 'copy' });
        if (actions.reply === card.reply.id) {
          out.push({ action: 'again', label: 'regenerate', id: actions.again });
          if (actions.edit) out.push({ action: 'edit', id: actions.edit });
        }
      } else if (card.kind === 'stopped' && actions.again) {
        out.push({ action: 'again', label: 'try', id: actions.again });
        if (actions.edit) out.push({ action: 'edit', id: actions.edit });
      }
      return out;
    },
  };

  // The message found (or, without one, the latest reply with words), with who said it and when.
  function messageCard(messages, at, agent) {
    const list = messages.filter((m) => m && !m.hidden);
    const m = at ? list.find((x) => x.id === at) : list.findLast((x) => x.role === 'assistant' && (x.content || '').trim());
    if (!m) return null;
    const d = chatcore.describeMessage(m);
    if (!d.text.trim()) return null;
    const who = m.role === 'user' ? 'You' : m.persona || agent;
    const when = new Date(Number(m.createdAt) || NaN);
    const date = Number.isFinite(when.getTime()) ? when.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    const kicker = at ? `${who}${date ? ` · ${date}` : ''}` : `${DEFAULT_KICKER}${date ? ` · ${date}` : ''}`;
    // A reply gets the card's buttons (Copy; Regenerate and Edit when it is the latest), as after 'done'.
    return show({ kind: 'message', text: d.text, plain: !d.markdown, kicker, at: m.id || null, reply: m.role === 'assistant' ? m : null });
  }
}

/**
 * Where the card's text scrolls when painted: 'top' for a card that just appeared, 'end' for a live card
 * whose reader was at the end, else null (the user scrolled up to read).
 */
export function scrollFor({ wasShown = false, follow = false, atEnd = false } = {}) {
  if (!wasShown) return 'top';
  return follow && atEnd ? 'end' : null;
}
