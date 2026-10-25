// Vocabulary decks with spaced repetition (Languages/<Language>.md in the vault). One card per line,
// readable and editable in Obsidian; the schedule hides in an HTML comment:
//   - **el desarrollo** — development · _El desarrollo es lento._ <!-- srs due=2026-10-26 ivl=1 ease=2.5 reps=1 lapses=0 -->
// Scheduling is SM-2 (as in Anki's classic algorithm) with four grades. Pure: no I/O, dates as YYYY-MM-DD.

const GRADES = ['again', 'hard', 'good', 'easy'];
const MIN_EASE = 1.3;
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
    });
  });
  return { cards, before: first < 0 ? lines.join('\n').trimEnd() : lines.slice(0, first).join('\n').trimEnd(), after: last < 0 ? '' : lines.slice(last + 1).join('\n').trim() };
}

function cardLine(c) {
  return `- **${clean(c.front)}**${c.back ? ` — ${clean(c.back, 300)}` : ''}${c.example ? ` · _${clean(c.example, 300).replace(/_/g, ' ')}_` : ''} <!-- srs due=${c.due || ''} ivl=${c.ivl} ease=${Number(c.ease).toFixed(2)} reps=${c.reps} lapses=${c.lapses} -->`;
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

/** SM-2 with four grades. "again" brings the card back today; the others push it out. */
function schedule(card, grade, today) {
  if (!GRADES.includes(grade)) throw new Error(`Grade must be one of: ${GRADES.join(', ')}`);
  const c = { ...card };
  if (grade === 'again') {
    c.lapses += c.reps ? 1 : 0;
    c.reps = 0;
    c.ivl = 0;
    c.ease = Math.max(MIN_EASE, c.ease - 0.2);
    c.due = today;
    return c;
  }
  c.ease = Math.max(MIN_EASE, c.ease + { hard: -0.15, good: 0, easy: 0.15 }[grade]);
  if (c.reps === 0) c.ivl = { hard: 1, good: 1, easy: 4 }[grade];
  else if (c.reps === 1) c.ivl = { hard: 2, good: 3, easy: 6 }[grade];
  else c.ivl = Math.max(c.ivl + 1, Math.round(c.ivl * { hard: 1.2, good: c.ease, easy: c.ease * 1.3 }[grade]));
  c.reps += 1;
  c.due = addDays(today, c.ivl);
  return c;
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

function grade(deck, front, g, today) {
  const i = deck.cards.findIndex((c) => keyOf(c.front) === keyOf(front));
  if (i < 0) throw new Error(`No card "${front}" in this deck.`);
  const cards = deck.cards.slice();
  cards[i] = schedule(cards[i], g, today);
  return { deck: { ...deck, cards }, card: cards[i] };
}

module.exports = { GRADES, parseDeck, serializeDeck, addCards, schedule, dueCards, grade, addDays };
