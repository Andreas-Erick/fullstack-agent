// Flashcard decks as Markdown in the vault (Flashcards/<Deck>.md), pure: parsing and writing a deck,
// cloze and reversed cards, what a card shows, and the study queue with Anki's daily limits. The
// schedule of each card (ankicore.js) hides in an HTML comment, so the note reads well in Obsidian:
//
//   ---
//   type: flashcards
//   scheduler: sm2            (or fsrs; also new_per_day, reviews_per_day, retention, learn_steps…)
//   ---
//   # Biology
//
//   <!-- card {"id":"k3f9a1","type":"review","due":"2026-11-02","ivl":6,"ease":2.5,"reps":3} -->
//   What is ATP?
//   ?
//   The cell's energy currency.
//
//   <!-- card {"id":"p2x8c0","cloze":1} -->
//   Mitochondria are the {{c1::powerhouse}} of the {{c2::cell}}.
//
// Typed by hand: a block starting with `<!-- card -->` (the id and schedule are filled in on the next
// write), or a single line `Front :: Back` (`:::` makes a card each way). A block with {{c1::…}} and no
// cloze number becomes one card per cloze.
const anki = require('./ankicore');

const CARD_LINE = /^<!--\s*card\b\s*(\{.*\})?\s*-->\s*$/;
const ONE_LINE = /^(?![-*>#|]|<!--)(.+?)\s+(:{2,3})\s+(.+)$/;
const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;
const MAX_SIDE = 20000;

// Deck options in the frontmatter (snake_case there, ankicore's names here).
const OPTION_KEYS = {
  scheduler: 'scheduler',
  new_per_day: 'newPerDay',
  reviews_per_day: 'reviewsPerDay',
  retention: 'retention',
  learn_steps: 'learnSteps',
  relearn_steps: 'relearnSteps',
  graduating_interval: 'graduatingIvl',
  easy_interval: 'easyIvl',
  starting_ease: 'startingEase',
  easy_bonus: 'easyBonus',
  hard_interval: 'hardIvl',
  interval_modifier: 'ivlModifier',
  maximum_interval: 'maxIvl',
  leech_threshold: 'leechThreshold',
};
const SCHED_KEYS = ['type', 'step', 'dueAt', 'due', 'ivl', 'ease', 'reps', 'lapses', 'last', 's', 'd', 'leech', 'suspended'];

const randomId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 4);
/** An id from a card's text (and cloze number), the same on every read: "h" + 9 base-36 digits. */
function textId(c, k = 1) {
  let h1 = 5381;
  let h2 = 52711;
  for (const ch of `${c.front}\u0000${c.back}\u0000${c.cloze || 0}\u0000${k}`) {
    const x = ch.charCodeAt(0);
    h1 = ((h1 * 33) ^ x) >>> 0;
    h2 = ((h2 * 31) ^ x) >>> 0;
  }
  return `h${(h1 % 46656).toString(36).padStart(3, '0')}${h2.toString(36).padStart(6, '0').slice(-6)}`;
}
const clip = (s, n = MAX_SIDE) => String(s ?? '').replace(/\r\n?/g, '\n').trim().slice(0, n);
const keyOf = (s) => clip(s, 400).toLowerCase().replace(/\s+/g, ' ').normalize('NFC');
const clozeNumbers = (text) => [...new Set([...String(text).matchAll(CLOZE)].map((m) => Number(m[1])))].sort((a, b) => a - b);

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {}, body: text, raw: '' };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: text.slice(m[0].length), raw: m[1] };
}

/** The deck's options for ankicore from its frontmatter. */
function optionsOf(fm) {
  const out = {};
  for (const [k, name] of Object.entries(OPTION_KEYS)) if (fm[k] !== undefined && fm[k] !== '') out[name] = /steps$/.test(k) ? fm[k] : name === 'scheduler' ? fm[k] : Number(fm[k]);
  return out;
}

function splitSides(lines) {
  const i = lines.findIndex((l) => l.trim() === '?');
  if (i < 0) return { front: clip(lines.join('\n')), back: '' };
  return { front: clip(lines.slice(0, i).join('\n')), back: clip(lines.slice(i + 1).join('\n')) };
}

function metaOf(json) {
  if (!json) return {};
  try {
    const m = JSON.parse(json);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

function cardFrom(meta, front, back) {
  const sched = {};
  for (const k of SCHED_KEYS) if (meta[k] !== undefined) sched[k] = meta[k];
  return {
    id: /^[\w-]{3,40}$/.test(meta.id || '') ? meta.id : '',
    front,
    back,
    cloze: Number.isInteger(meta.cloze) && meta.cloze > 0 ? meta.cloze : 0,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String).filter(Boolean).slice(0, 20) : [],
    ...(meta.src ? { src: String(meta.src).slice(0, 60) } : {}),
    sched: anki.normalize(sched),
  };
}

/**
 * A deck note → { name, fm, options, before, cards }. Hand-typed cards (one-line, cloze blocks without
 * a number, blocks without an id) come out complete; `changed` says the note should be written back.
 */
function parseDeck(text, name = 'Deck') {
  const { fm, body } = parseFrontmatter(String(text || ''));
  const lines = body.split(/\r?\n/);
  const before = [];
  const cards = [];
  let changed = false;
  let i = 0;
  // Before the first card block: notes, and one-line cards.
  for (; i < lines.length && !CARD_LINE.test(lines[i].trim()); i++) {
    const m = ONE_LINE.exec(lines[i]);
    if (m && !/`/.test(lines[i])) {
      cards.push(cardFrom({}, clip(m[1]), clip(m[3])));
      if (m[2] === ':::') cards.push(cardFrom({}, clip(m[3]), clip(m[1])));
      changed = true;
    } else before.push(lines[i]);
  }
  while (i < lines.length) {
    const meta = metaOf(CARD_LINE.exec(lines[i].trim())[1]);
    let j = i + 1;
    while (j < lines.length && !CARD_LINE.test(lines[j].trim())) j++;
    const { front, back } = splitSides(lines.slice(i + 1, j));
    i = j;
    if (!front) continue;
    const nums = clozeNumbers(front);
    if (nums.length && !meta.cloze) {
      // A cloze block typed by hand: one card per cloze number.
      for (const n of nums) cards.push(cardFrom({ ...meta, id: nums.length > 1 ? '' : meta.id, cloze: n }, front, back));
      changed = true;
      continue;
    }
    cards.push(cardFrom(meta, front, back));
  }
  // A card typed by hand has no id until the deck is next written: derive one from its text, so every
  // read of the unchanged note gives the same ids (a study session reloads the deck between showing a
  // card and answering it; a random id would no longer be found).
  for (const c of cards) if (!c.id) (c.id = textId(c)), (changed = true);
  // Two cards can't share an id (a block copied by hand): the second gets one derived from the first.
  const seen = new Set();
  for (const c of cards) {
    for (let k = 2; seen.has(c.id); k++) (c.id = textId(c, k)), (changed = true);
    seen.add(c.id);
  }
  const title = (before.find((l) => /^#\s+/.test(l)) || '').replace(/^#\s+/, '').trim();
  return { name: fm.deck || title || name, fm, options: optionsOf(fm), before: before.join('\n').trim(), cards, changed };
}

function commentOf(card) {
  const meta = { id: card.id };
  if (card.cloze) meta.cloze = card.cloze;
  if (card.tags?.length) meta.tags = card.tags;
  if (card.src) meta.src = card.src;
  const s = anki.normalize(card.sched);
  for (const k of SCHED_KEYS) {
    const v = s[k];
    if (v === undefined || v === '' || v === false || (k === 'step' && !v) || (k === 'ease' && !v)) continue;
    if (s.type === 'new' && ['ivl', 'reps', 'lapses'].includes(k) && !v) continue;
    meta[k] = typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v;
  }
  return `<!-- card ${JSON.stringify(meta).replace(/--/g, '- -')} -->`;
}

// A side can't contain a line that would start a new card or split it.
const safeSide = (s) => clip(s).split('\n').map((l) => (CARD_LINE.test(l.trim()) ? l.replace('<!--', '&lt;!--') : l.trim() === '?' ? '\\?' : l)).join('\n');

function serializeDeck(deck) {
  const fm = { type: 'flashcards', ...deck.fm };
  delete fm.deck;
  const head = `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n`;
  const before = deck.before?.trim() || `# ${deck.name}`;
  const blocks = deck.cards.map((c) => `${commentOf(c)}\n${safeSide(c.front)}${c.back ? `\n?\n${safeSide(c.back)}` : ''}`);
  return `${head}${before}\n\n${blocks.join('\n\n')}\n`;
}

/** What a card shows: { front, back } in Markdown. Clozes: the card's own is hidden on the front. */
function render(card) {
  if (!card.cloze) return { front: card.front, back: card.back };
  const side = (reveal) =>
    card.front.replace(CLOZE, (_m, n, text, hint) => (Number(n) !== card.cloze ? text : reveal ? `**[${text}]**` : `**[${hint ? hint : '…'}]**`));
  return { front: side(false), back: [side(true), card.back].filter(Boolean).join('\n\n') };
}

/** New cards (basic ones skip a front the deck already has). items: [{ front, back, tags, cloze }]. */
function addCards(deck, items, { src } = {}) {
  const have = new Set(deck.cards.filter((c) => !c.cloze).map((c) => keyOf(c.front)));
  const added = [];
  for (const it of items || []) {
    const front = clip(it.front);
    if (!front) continue;
    const tags = Array.isArray(it.tags) ? it.tags.map(String).filter(Boolean).slice(0, 20) : [];
    const nums = it.cloze ? [Number(it.cloze)] : clozeNumbers(front);
    if (nums.length) {
      for (const n of nums) added.push({ id: randomId(), front, back: clip(it.back), cloze: n, tags, ...(src ? { src } : {}), sched: anki.normalize(it.sched || anki.fresh()) });
      continue;
    }
    if (have.has(keyOf(front))) continue;
    have.add(keyOf(front));
    added.push({ id: randomId(), front, back: clip(it.back), cloze: 0, tags, ...(src ? { src } : {}), sched: anki.normalize(it.sched || anki.fresh()) });
  }
  return { deck: { ...deck, cards: [...deck.cards, ...added] }, added };
}

// ------------------------------------------------------------------ studying
const LEARN_AHEAD_MS = 20 * 60000; // Anki shows a learning card up to 20 minutes early when nothing else is left

/**
 * The deck's counts and the next card to study: learning cards due now first, then reviews due today
 * (up to the daily limit), then new cards (up to the daily limit), the way Anki's queues work.
 * done: { new, review } studied today (flashcards.js keeps it). Returns { next, counts, laterAt }.
 */
function queue(deck, now, done = {}) {
  const cfg = anki.config(deck.options);
  const today = anki.dayOf(now, cfg.rolloverHour);
  const end = anki.dayEnd(now, cfg.rolloverHour);
  const learn = [];
  const due = [];
  const fresh = [];
  for (const c of deck.cards) {
    const s = c.sched;
    if (s.suspended) continue;
    if (s.type === 'new') fresh.push(c);
    else if (anki.isLearning(s)) {
      if (!s.dueAt || s.dueAt <= end) learn.push(c);
    } else if (s.due && s.due <= today) due.push(c);
  }
  learn.sort((a, b) => (a.sched.dueAt || 0) - (b.sched.dueAt || 0));
  due.sort((a, b) => a.sched.due.localeCompare(b.sched.due) || a.sched.ivl - b.sched.ivl);
  const reviewLeft = Math.max(0, cfg.reviewsPerDay - (done.review || 0));
  const newLeft = Math.max(0, Math.min(fresh.length, cfg.newPerDay - (done.new || 0)));
  const counts = { new: newLeft, learn: learn.length, review: Math.min(due.length, reviewLeft), total: deck.cards.length, suspended: deck.cards.filter((c) => c.sched.suspended).length };
  const learnNow = learn.filter((c) => !c.sched.dueAt || c.sched.dueAt <= now);
  let next = learnNow[0] || (counts.review ? due[0] : null) || (newLeft ? fresh[0] : null);
  // Nothing else left today: a learning card coming up within 20 minutes is shown now (Anki's learn-ahead).
  if (!next && learn[0] && learn[0].sched.dueAt - now <= LEARN_AHEAD_MS) next = learn[0];
  const laterAt = !next && learn.length ? learn[0].sched.dueAt : null;
  return { next, counts, laterAt, options: cfg };
}

/** Answers a card in the deck: { deck, card, before } (before = the old card, for undo). */
function grade(deck, id, g, now) {
  const i = deck.cards.findIndex((c) => c.id === id);
  if (i < 0) throw new Error('That card is not in this deck any more.');
  const old = deck.cards[i];
  const { card: sched, lapsed } = anki.answer(old.sched, g, now, deck.options, old.id);
  const card = { ...old, sched, tags: sched.leech && !old.tags.includes('leech') ? [...old.tags, 'leech'] : old.tags };
  const cards = deck.cards.slice();
  cards[i] = card;
  return { deck: { ...deck, cards }, card, before: old, wasNew: old.sched.type === 'new', wasReview: old.sched.type === 'review', lapsed: Boolean(lapsed) };
}

/** The deck at a glance for lists: counts, how many are mature (21 days or more), when the next is due. */
function summary(deck, now, done) {
  const q = queue(deck, now, done);
  const review = deck.cards.filter((c) => c.sched.type === 'review');
  const upcoming = deck.cards.map((c) => c.sched).filter((s) => s.type === 'review' && s.due && s.due > anki.dayOf(now)).map((s) => s.due).sort()[0] || null;
  return {
    name: deck.name,
    scheduler: anki.config(deck.options).scheduler,
    ...q.counts,
    dueNow: q.counts.new + q.counts.learn + q.counts.review,
    young: review.filter((c) => c.sched.ivl < 21).length,
    mature: review.filter((c) => c.sched.ivl >= 21).length,
    unseen: deck.cards.filter((c) => c.sched.type === 'new').length,
    nextDue: upcoming,
    laterAt: q.laterAt,
  };
}

module.exports = { parseDeck, serializeDeck, render, addCards, queue, grade, summary, optionsOf, clozeNumbers, randomId, OPTION_KEYS, LEARN_AHEAD_MS };
