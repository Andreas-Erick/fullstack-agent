// Flashcards (the Flashcards view, the phone's Flashcards screen, the flashcards_* tools): decks are
// Markdown notes in the vault (flashcore.js; Flashcards/<Deck>.md), scheduled like Anki (ankicore.js),
// and the vocabulary decks of language learning (Languages/<Language>.md, srs.js) appear and are
// studied here too, with the same scheduler. Deck ids: "f:<note name>" and "v:<language>".
// Studied-today counts (Anki's daily limits) are in <userData>/flashcards-days.json; the last answer per
// deck can be undone. Imports (flashimport.js) read only files the assistant may read and add cards,
// never overwriting a deck.
const path = require('path');
const fsp = require('fs').promises;
const store = require('./store');
const log = require('./logger');
const obsidian = require('./obsidian');
const anki = require('./ankicore');
const core = require('./flashcore');
const srs = require('./srs');
const { withLock } = require('./notelock');
const { resolveInside, toPosix } = require('./files');

const FOLDER = 'Flashcards';
const LANGUAGES = 'Languages';
const MEDIA_INLINE_MAX = 8 * 1024 * 1024; // per card side, as data URLs
const daysFile = () => path.join(store.dataDir(), 'flashcards-days.json');
const undo = new Map(); // deckId -> { cardId, before, counted }

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const relOf = (id) => {
  const [kind, name] = [id.slice(0, 1), id.slice(2)];
  if (!/^[fv]:/.test(id) || !safeName(name) || safeName(name) !== name) throw new Error(`Unknown deck "${id}".`);
  return kind === 'f' ? `${FOLDER}/${name}.md` : `${LANGUAGES}/${name}.md`;
};
const hashId = (s) => {
  let h = 5381;
  for (const ch of s) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `v${h.toString(36)}`;
};

async function requireVault() {
  const root = await obsidian.vaultPath();
  if (!root) throw new Error('Flashcards live in your vault; set one up first (Settings → Memory vault).');
  return root;
}

async function namesIn(folder) {
  const root = await obsidian.vaultPath();
  if (!root) return [];
  const list = await fsp.readdir(path.join(root, folder)).catch(() => []);
  return list.filter((f) => f.toLowerCase().endsWith('.md') && f.slice(0, -3) !== folder).map((f) => f.slice(0, -3)).sort((a, b) => a.localeCompare(b));
}

// ------------------------------------------------------------------ reading decks
/** A deck in flashcore's shape, whichever kind: { id, kind, rel, name, options, cards, raw }. */
async function load(id) {
  const rel = relOf(id);
  const text = await obsidian.readOptional(rel);
  if (!text) throw new Error(`No deck "${id.slice(2)}".`);
  if (id.startsWith('f:')) {
    const deck = core.parseDeck(text, id.slice(2));
    return { id, kind: 'flash', rel, ...deck };
  }
  // A vocabulary deck: its cards as flashcards (the example goes under the meaning).
  const raw = srs.parseDeck(text);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || '';
  const options = core.optionsOf(Object.fromEntries(fm.split(/\r?\n/).map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()])));
  const cards = raw.cards.map((c) => ({ id: hashId(srs.keyOf(c.front)), front: c.front, back: [c.back, c.example && `*${c.example}*`].filter(Boolean).join('\n\n'), cloze: 0, tags: [], sched: srs.toSched(c) }));
  return { id, kind: 'vocab', rel, name: id.slice(2), options, cards, raw };
}

async function save(deck) {
  const text = deck.kind === 'flash' ? core.serializeDeck(deck) : srs.serializeDeck(deck.raw);
  await obsidian.writeNote(deck.rel, text, 'overwrite', { source: 'flashcards' });
}

/** Changes a deck inside its note lock (habits, decks and topics never lose a write to a race). */
function change(id, fn) {
  return withLock(relOf(id), async () => {
    const deck = await load(id);
    const r = await fn(deck);
    if (r?.deck) await save(r.deck);
    return r;
  });
}

// ------------------------------------------------------------------ today's counts
async function days() {
  const d = await store.readJson(daysFile(), {});
  const today = anki.dayOf(Date.now());
  return d.day === today && d.decks && typeof d.decks === 'object' ? d : { day: today, decks: {} };
}
async function count(id, { isNew, isReview }, sign = 1) {
  const d = await days();
  const c = (d.decks[id] ||= { new: 0, review: 0, reviews: 0 });
  if (isNew) c.new = Math.max(0, c.new + sign);
  if (isReview) c.review = Math.max(0, c.review + sign);
  c.reviews = Math.max(0, (c.reviews || 0) + sign);
  await store.writeJsonAtomic(daysFile(), d);
}

// ------------------------------------------------------------------ lists
/** Every deck with Anki's three numbers (new, learning, due) and how far along it is. */
async function decks() {
  if (!(await obsidian.vaultPath())) return { vault: false, decks: [] };
  const done = (await days()).decks;
  const now = Date.now();
  const ids = [...(await namesIn(FOLDER)).map((n) => `f:${n}`), ...(await namesIn(LANGUAGES)).map((n) => `v:${n}`)];
  const out = [];
  for (const id of ids) {
    try {
      const deck = await load(id);
      out.push({ id, kind: deck.kind, path: deck.rel, ...core.summary(deck, now, done[id]), studiedToday: done[id]?.reviews || 0 });
    } catch (err) {
      log.warn('flashcard deck unreadable', { deck: id, error: err });
    }
  }
  return { vault: true, decks: out };
}

/** One deck's cards for browsing (optionally matching `query`), newest-due first. */
async function browse(id, { query = '', limit = 500 } = {}) {
  const deck = await load(id);
  const now = Date.now();
  const q = String(query || '').toLowerCase().trim();
  const cards = deck.cards
    .filter((c) => !q || `${c.front}\n${c.back}\n${c.tags.join(' ')}`.toLowerCase().includes(q))
    .slice(0, Math.min(2000, limit))
    .map((c) => ({ id: c.id, front: core.render(c).front.slice(0, 300), back: c.back.slice(0, 300), tags: c.tags, cloze: c.cloze, status: anki.status(c.sched, now, deck.options), due: c.sched.due || (c.sched.dueAt ? new Date(c.sched.dueAt).toISOString() : ''), ivl: c.sched.ivl, ease: c.sched.ease, lapses: c.sched.lapses, reps: c.sched.reps, leech: Boolean(c.sched.leech), suspended: Boolean(c.sched.suspended) }));
  return { id, kind: deck.kind, name: deck.name, path: deck.rel, options: anki.config(deck.options), total: deck.cards.length, cards };
}

/** One card as written in the note, for editing. */
async function card(id, cardId) {
  const deck = await load(id);
  const c = deck.cards.find((x) => x.id === cardId);
  if (!c) throw new Error('That card is not in this deck any more.');
  return { id: c.id, front: c.front, back: c.back, tags: c.tags, cloze: c.cloze, sched: c.sched };
}

// ------------------------------------------------------------------ media in cards
// ![[file]] in a card: an image or a sound from the vault (Flashcards/media/… after an import), sent
// along as a data URL so the window and the phone show it without reaching into the vault.
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm' };
async function withMedia(md, root) {
  let budget = MEDIA_INLINE_MAX;
  const parts = [];
  let last = 0;
  for (const m of md.matchAll(/!\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g)) {
    parts.push(md.slice(last, m.index));
    last = m.index + m[0].length;
    const ref = m[1].trim();
    const ext = ref.split('.').pop().toLowerCase();
    const mime = MIME[ext];
    let out = `🖼 ${ref}`;
    try {
      if (!mime) throw new Error('not media');
      const full = resolveInside(root, ref.includes('/') ? ref : `${FOLDER}/media/${ref}`);
      const buf = await fsp.readFile(full);
      if (buf.length > budget) throw new Error('too large');
      budget -= buf.length;
      const url = `data:${mime};base64,${buf.toString('base64')}`;
      out = mime.startsWith('audio') ? `<audio controls src="${url}"></audio>` : `![${path.basename(ref)}](${url})`;
    } catch {
      out = mime?.startsWith('audio') ? `🔊 ${path.basename(ref)}` : `🖼 ${path.basename(ref)}`;
    }
    parts.push(out);
  }
  parts.push(md.slice(last));
  return parts.join('').replace(/^\\\?$/gm, '?');
}

// ------------------------------------------------------------------ studying
/** The next card of a deck (rendered, with what each button would do), or why there is none. */
async function next(id) {
  const deck = await load(id);
  const now = Date.now();
  const done = (await days()).decks[id];
  const q = core.queue(deck, now, done);
  const root = await requireVault();
  let card = null;
  if (q.next) {
    const side = core.render(q.next);
    card = { id: q.next.id, front: await withMedia(side.front, root), back: await withMedia(side.back, root), tags: q.next.tags, cloze: q.next.cloze, status: anki.status(q.next.sched, now, deck.options), preview: anki.preview(q.next.sched, now, deck.options, q.next.id), lapses: q.next.sched.lapses, leech: Boolean(q.next.sched.leech) };
  }
  return { id, name: deck.name, kind: deck.kind, card, counts: q.counts, laterAt: q.laterAt, scheduler: q.options.scheduler, canUndo: undo.has(id), studiedToday: done?.reviews || 0 };
}

/** Answers a card (again | hard | good | easy) and returns the next one. */
async function answer(id, cardId, grade) {
  if (!anki.GRADES.includes(grade)) throw new Error(`Grade must be one of: ${anki.GRADES.join(', ')}`);
  const now = Date.now();
  const r = await change(id, async (deck) => {
    const g = core.grade(deck, String(cardId), grade, now);
    if (deck.kind === 'vocab') {
      const i = deck.raw.cards.findIndex((c) => hashId(srs.keyOf(c.front)) === cardId);
      deck.raw.cards[i] = srs.withSched(deck.raw.cards[i], g.card.sched, anki.dayOf(now));
      return { deck, g };
    }
    return { deck: g.deck, g };
  });
  undo.set(id, { cardId, before: r.g.before, counted: { isNew: r.g.wasNew, isReview: r.g.wasReview } });
  await count(id, { isNew: r.g.wasNew, isReview: r.g.wasReview });
  log.info('flashcard answered', { deck: id, grade, type: r.g.card.sched.type, ivl: r.g.card.sched.ivl });
  return next(id);
}

/** Takes back the last answer in a deck (Anki's Undo). */
async function undoLast(id) {
  const u = undo.get(id);
  if (!u) throw new Error('Nothing to undo.');
  await change(id, async (deck) => {
    const i = deck.cards.findIndex((c) => c.id === u.cardId);
    if (i < 0) return null;
    if (deck.kind === 'vocab') {
      const j = deck.raw.cards.findIndex((c) => hashId(srs.keyOf(c.front)) === u.cardId);
      deck.raw.cards[j] = srs.withSched(deck.raw.cards[j], u.before.sched, anki.dayOf(Date.now()));
      return { deck };
    }
    deck.cards[i] = u.before;
    return { deck };
  });
  undo.delete(id);
  await count(id, u.counted, -1);
  return next(id);
}

// ------------------------------------------------------------------ changing decks
async function createDeck(name, { scheduler } = {}) {
  await requireVault();
  const n = safeName(name);
  if (!n) throw new Error('A deck needs a name.');
  const rel = `${FOLDER}/${n}.md`;
  if (await obsidian.readOptional(rel)) return { id: `f:${n}`, created: false };
  const deck = { name: n, fm: scheduler === 'fsrs' ? { scheduler: 'fsrs' } : {}, before: `# ${n}`, cards: [] };
  await obsidian.writeNote(rel, core.serializeDeck(deck), 'create', { source: 'flashcards' });
  return { id: `f:${n}`, created: true };
}

/** Adds cards ([{ front, back, tags }]) to a deck by id or name (a new deck is created). */
async function addCards(idOrName, cards, { src } = {}) {
  let id = String(idOrName || '');
  if (!/^[fv]:/.test(id)) id = (await createDeck(id)).id;
  if (id.startsWith('v:')) {
    const r = await require('./learning').addCards(id.slice(2), (cards || []).map((c) => ({ front: c.front, back: c.back, example: c.example })));
    return { id, added: r.added.length, total: r.total };
  }
  const r = await change(id, async (deck) => {
    const a = core.addCards(deck, cards, { src });
    return { deck: a.deck, added: a.added.length, total: a.deck.cards.length };
  });
  return { id, added: r.added, total: r.total };
}

/** Edits a card's text or tags, suspends or unsuspends it, or (remove: true) deletes it. */
async function editCard(id, cardId, patch = {}) {
  return change(id, async (deck) => {
    const i = deck.cards.findIndex((c) => c.id === cardId);
    if (i < 0) throw new Error('That card is not in this deck any more.');
    if (deck.kind === 'vocab') throw new Error('Vocabulary cards are edited in their language note (Languages/).');
    const cards = deck.cards.slice();
    if (patch.remove) cards.splice(i, 1);
    else {
      const c = { ...cards[i], sched: { ...cards[i].sched } };
      if (typeof patch.front === 'string' && patch.front.trim()) c.front = patch.front.trim().slice(0, 20000);
      if (typeof patch.back === 'string') c.back = patch.back.trim().slice(0, 20000);
      if (Array.isArray(patch.tags)) c.tags = patch.tags.map(String).filter(Boolean).slice(0, 20);
      if (typeof patch.suspended === 'boolean') c.sched.suspended = patch.suspended;
      if (patch.reset) c.sched = anki.fresh();
      cards[i] = c;
    }
    return { deck: { ...deck, cards }, ok: true };
  });
}

const OPTION_NAMES = Object.fromEntries(Object.entries(core.OPTION_KEYS).map(([k, v]) => [v, k]));
/** Deck options (scheduler sm2 | fsrs, new_per_day, reviews_per_day, retention, steps…), in the frontmatter. */
async function setOptions(id, opts = {}) {
  if (!id.startsWith('f:')) throw new Error('Options are set on flashcard decks (vocabulary decks use the defaults).');
  return change(id, async (deck) => {
    const fm = { ...deck.fm };
    for (const [k, v] of Object.entries(opts)) {
      const key = OPTION_NAMES[k] || (core.OPTION_KEYS[k] ? k : null);
      if (!key) continue;
      if (v === null || v === '') delete fm[key];
      else fm[key] = Array.isArray(v) ? v.join(' ') : String(v).replace(/[\r\n]/g, ' ').slice(0, 60);
    }
    const next = { ...deck, fm, options: core.optionsOf(fm) };
    return { deck: next, options: anki.config(next.options) };
  });
}

async function deleteDeck(id) {
  if (!id.startsWith('f:')) throw new Error('Vocabulary decks are removed from the Languages folder in the vault.');
  return obsidian.deleteNote(relOf(id));
}

// ------------------------------------------------------------------ importing
/**
 * Imports a CSV / TSV / Anki text / .apkg / .colpkg file (a path the assistant may read: the workspace
 * folder and the folders the user allowed; fromUser: the user picked it in a dialog) into a deck: an
 * existing one gets the new cards added, otherwise a deck named after the file. Media go to
 * Flashcards/media/<Deck>/.
 */
async function importFile(file, { deck: deckName = '', fromUser = false } = {}) {
  const root = await requireVault();
  const full = await require('./documents').resolveAllowed(file, { fromUser });
  const started = Date.now();
  const r = await require('./flashimport').read(full);
  if (!r.cards.length) throw new Error('No cards found in that file.');
  const name = safeName(deckName) || r.deckName;
  // Media files first, then the cards that point at them.
  const mediaDir = `${FOLDER}/media/${name}`;
  let mediaCount = 0;
  if (r.media.size) {
    await fsp.mkdir(resolveInside(root, mediaDir), { recursive: true });
    for (const [file, bytes] of r.media) {
      const clean = path.basename(file).replace(/[\\/:*?"<>|]/g, '_');
      await fsp.writeFile(resolveInside(root, `${mediaDir}/${clean}`), bytes);
      mediaCount++;
    }
  }
  const point = (s) => String(s || '').replace(/!\[\[([^\]/|]+?)\]\]/g, (m, f) => (r.media.has(f) ? `![[${mediaDir}/${path.basename(f).replace(/[\\/:*?"<>|]/g, '_')}]]` : m));
  const cards = r.cards.map((c) => ({ ...c, front: point(c.front), back: point(c.back) }));
  const id = /^[fv]:/.test(deckName) ? deckName : (await createDeck(name)).id;
  const res = await addCards(id, cards);
  log.info('flashcards imported', { format: r.format, cards: r.cards.length, added: res.added, media: mediaCount, ms: Date.now() - started });
  return { deck: id, name: id.slice(2), format: r.format, found: r.cards.length, added: res.added, skipped: r.skipped + (r.cards.length - res.added), media: mediaCount, total: res.total, ...(r.decks?.length > 1 ? { note: `The package had ${r.decks.length} decks (${r.decks.slice(0, 5).join(', ')}…); they were imported together.` } : {}) };
}

/** Import files waiting in the workspace folder (for "import my flashcards"): name, size, kind. */
async function importable() {
  const s = await store.getSettings();
  const out = [];
  for (const dir of require('./documents').userFolders(s)) {
    const list = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of list) {
      if (!e.isFile() || !/\.(csv|tsv|txt|apkg|colpkg)$/i.test(e.name)) continue;
      const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
      if (st) out.push({ path: toPosix(path.join(dir, e.name)), name: e.name, size: st.size, modified: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.modified - a.modified).slice(0, 50);
}

// ------------------------------------------------------------------ for others
/** For the Today screens and the prompt: what is due across all decks. */
async function dueToday() {
  const { decks: list } = await decks();
  return list.filter((d) => d.dueNow > 0).map(({ id, name, kind, new: n, learn, review, dueNow }) => ({ id, name, kind, new: n, learn, review, dueNow }));
}

/** For the skill tree (skilltree.js): each deck's size, mature cards and reviews. */
async function evidence() {
  const { decks: list } = await decks();
  return list.map((d) => ({ id: d.id, name: d.name, kind: d.kind, total: d.total, mature: d.mature, young: d.young, unseen: d.unseen }));
}

module.exports = { decks, browse, card, next, answer, undoLast, createDeck, addCards, editCard, setOptions, deleteDeck, importFile, importable, dueToday, evidence, FOLDER };
