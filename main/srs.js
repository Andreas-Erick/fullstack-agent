// Vocabulary decks with spaced repetition (Languages/<Language>.md in the vault). One card per line,
// readable and editable in Obsidian; the schedule hides in an HTML comment:
//   - **el desarrollo** — development · _El desarrollo es lento._ <!-- srs due=2026-10-26 ivl=1 ease=2.5 reps=1 lapses=0 -->
// Scheduling is Anki's (ankicore.js, the same as the Flashcards view: learning steps, then SM-2 days);
// a card in its learning steps also keeps type, step, at (when it is due, ms) and last in the comment,
// and FSRS's s and d when its deck uses FSRS. Pure: no I/O.
const anki = require('./ankicore');

const GRADES = anki.GRADES;
const EXTRA = ['type', 'step', 'at', 'last', 's', 'd'];
const CARD = /^\s*[-*]\s+\*\*(.+?)\*\*\s*(?:[—–-]\s*(.*?))?\s*(?:·\s*_(.*?)_)?\s*(?:<!--\s*srs\s+(.*?)\s*-->)?\s*$/;

const clean = (s, n = 200) => String(s ?? '').replace(/\s*\n\s*/g, ' ').replace(/\*\*|<!--|-->/g, '').trim().slice(0, n);
const keyOf = (front) => clean(front).toLowerCase().normalize('NFC');

function addDays(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A deck note → { cards: [{ front, back, example, due, ivl, ease, reps, lapses }], before, after }. */
function parseDeck(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cards = [];
  let first = -1;
  let last = -1;
  lines.forEach((line, i) => {
    const m = CARD.exec(line);
    if (!m) return;
    if (first < 0) first = i;
    last = i;
    const meta = Object.fromEntries((m[4] || '').split(/\s+/).filter(Boolean).map((kv) => kv.split('=')));
    cards.push({
      front: m[1].trim(),
      back: (m[2] || '').trim(),
      example: (m[3] || '').trim(),
      due: /^\d{4}-\d{2}-\d{2}$/.test(meta.due) ? meta.due : '',
      ivl: Number(meta.ivl) || 0,
      ease: Number(meta.ease) || 2.5,
      reps: Number(meta.reps) || 0,
      lapses: Number(meta.lapses) || 0,
      ...Object.fromEntries(EXTRA.filter((k) => meta[k] !== undefined && meta[k] !== '').map((k) => [k, ['type', 'last'].includes(k) ? meta[k] : Number(meta[k])])),
    });
  });
  return { cards, before: first < 0 ? lines.join('\n').trimEnd() : lines.slice(0, first).join('\n').trimEnd(), after: last < 0 ? '' : lines.slice(last + 1).join('\n').trim() };
}

function cardLine(c) {
  return `- **${clean(c.front)}**${c.back ? ` — ${clean(c.back, 300)}` : ''}${c.example ? ` · _${clean(c.example, 300).replace(/_/g, ' ')}_` : ''} <!-- srs due=${c.due || ''} ivl=${c.ivl} ease=${Number(c.ease).toFixed(2)} reps=${c.reps} lapses=${c.lapses}${extras(c)} -->`;
}

const extras = (c) =>
  EXTRA.filter((k) => c[k] !== undefined && c[k] !== '' && !(k === 'type' && c[k] === 'review') && !(k === 'step' && !c[k]))
    .map((k) => ` ${k}=${typeof c[k] === 'number' && !Number.isInteger(c[k]) ? c[k].toFixed(3) : c[k]}`)
    .join('');

/** A vocabulary card's schedule in ankicore's terms. */
function toSched(c) {
  const type = c.type || (c.due ? 'review' : 'new');
  return anki.normalize({ type, step: c.step, dueAt: c.at, due: type === 'review' ? c.due : undefined, ivl: c.ivl, ease: c.ease, reps: c.reps, lapses: c.lapses, last: c.last, s: c.s, d: c.d });
}

/** The card with a new schedule written back into its fields (a learning card is due today). */
function withSched(c, s, today) {
  const out = { front: c.front, back: c.back, example: c.example, ivl: s.ivl || 0, ease: s.ease || 2.5, reps: s.reps, lapses: s.lapses };
  out.due = s.type === 'review' ? s.due : s.type === 'new' ? '' : today;
  if (s.type !== 'review') out.type = s.type;
  if (s.step) out.step = s.step;
  if (s.dueAt) out.at = s.dueAt;
  if (s.last) out.last = s.last;
  if (s.s) Object.assign(out, { s: s.s, d: s.d });
  return out;
}

function serializeDeck(deck) {
  return `${[deck.before, deck.cards.map(cardLine).join('\n'), deck.after].filter((x) => x && x.trim()).join('\n\n')}\n`;
}

/** New cards (by front, case-insensitive): added unscheduled; existing ones get a missing meaning or example filled in. */
function addCards(deck, items) {
  const cards = deck.cards.map((c) => ({ ...c }));
  const added = [];
  for (const it of items || []) {
    const front = clean(it.front);
    if (!front) continue;
    const old = cards.find((c) => keyOf(c.front) === keyOf(front));
    if (old) {
      old.back ||= clean(it.back, 300);
      old.example ||= clean(it.example, 300);
      continue;
    }
    cards.push({ front, back: clean(it.back, 300), example: clean(it.example, 300), due: '', ivl: 0, ease: 2.5, reps: 0, lapses: 0 });
    added.push(front);
  }
  return { deck: { ...deck, cards }, added };
}

// A moment: ms, or a day ('YYYY-MM-DD', taken at noon).
const momentOf = (now) => (typeof now === 'number' ? now : Date.parse(`${now}T12:00:00`));

/** Anki's scheduler with four grades (ankicore.answer). opts: the deck's options (Flashcards view). */
function schedule(card, grade, now, opts = {}) {
  const ms = momentOf(now);
  const { card: s } = anki.answer(toSched(card), grade, ms, opts, keyOf(card.front));
  return withSched(card, s, anki.dayOf(ms));
}

/** Cards to review now: due ones first (oldest first), then new ones up to `newLimit`. */
function dueCards(deck, today, { limit = 10, newLimit = 5 } = {}) {
  const due = deck.cards.filter((c) => c.due && c.due <= today).sort((a, b) => a.due.localeCompare(b.due));
  const fresh = deck.cards.filter((c) => !c.due).slice(0, newLimit);
  return {
    cards: [...due, ...fresh].slice(0, limit),
    dueCount: due.length,
    newCount: deck.cards.filter((c) => !c.due).length,
    total: deck.cards.length,
    nextDue: deck.cards.filter((c) => c.due && c.due > today).map((c) => c.due).sort()[0] || null,
  };
}

function grade(deck, front, g, now, opts) {
  const i = deck.cards.findIndex((c) => keyOf(c.front) === keyOf(front));
  if (i < 0) throw new Error(`No card "${front}" in this deck.`);
  const cards = deck.cards.slice();
  cards[i] = schedule(cards[i], g, now, opts);
  return { deck: { ...deck, cards }, card: cards[i] };
}

module.exports = { GRADES, parseDeck, serializeDeck, addCards, schedule, dueCards, grade, addDays, toSched, withSched, keyOf };
