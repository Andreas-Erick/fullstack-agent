// Mixed learning (interleaving), pure: which deck the next card comes from, and the order of a
// shuffled practice round. Interleaving means the next card is usually from another deck than the one
// before, so each answer has to be found without the context of the last one (harder in the moment,
// better remembered: Bjork's "desirable difficulty"). flashcards.js runs the sessions over this.

/**
 * The deck for the next scheduled card: one of `candidates` ([{ id, weight }], weight = cards it has
 * left), never `last` while another has cards, otherwise at random weighted by what is left.
 */
function pickDeck(candidates, last = '', rand = Math.random) {
  const live = (candidates || []).filter((c) => c.weight > 0);
  const pool = live.length > 1 ? live.filter((c) => c.id !== last) : live;
  if (!pool.length) return null;
  const total = pool.reduce((n, c) => n + c.weight, 0);
  let r = rand() * total;
  for (const c of pool) if ((r -= c.weight) < 0) return c.id;
  return pool[pool.length - 1].id;
}

function shuffle(list, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * A practice round over every card ([{ deck, id }]): shuffled, then spread so that two neighbours come
 * from the same deck only when nothing else is left (a deck with most of the cards can't avoid it).
 */
function interleave(cards, rand = Math.random) {
  const byDeck = new Map();
  for (const c of shuffle(cards, rand)) (byDeck.get(c.deck) || byDeck.set(c.deck, []).get(c.deck)).push(c);
  const out = [];
  let last = '';
  while (out.length < cards.length) {
    const id = pickDeck([...byDeck].map(([deck, list]) => ({ id: deck, weight: list.length })), last, rand);
    out.push(byDeck.get(id).pop());
    last = id;
  }
  return out;
}

/** A card answered "again" in practice comes back a few cards later (3–7), not at once. */
function requeue(order, pos, item, rand = Math.random) {
  const at = Math.min(order.length, pos + 1 + 3 + Math.floor(rand() * 5));
  return [...order.slice(0, at), item, ...order.slice(at)];
}

module.exports = { pickDeck, shuffle, interleave, requeue };
