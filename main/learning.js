// Learning support in the vault: the understanding tracker (Learning/<Topic>.md, learningcore.js) and
// vocabulary decks with spaced repetition (Languages/<Language>.md, srs.js). Notes are plain Markdown,
// written through obsidian.writeNote so they are versioned like every other note.
const fsp = require('fs').promises;
const path = require('path');
const obsidian = require('./obsidian');
const core = require('./learningcore');
const srs = require('./srs');
const { withLock } = require('./notelock');

const LEARNING = 'Learning';
const LANGUAGES = 'Languages';
const PROMPT_TOPICS = 6; // topics in the agent's context
const RECENT_DAYS = 45;

async function listNames(folder) {
  const root = await obsidian.vaultPath().catch(() => null);
  if (!root) return [];
  const names = await fsp.readdir(path.join(root, folder)).catch(() => []);
  // Not the folder's own index note (<Folder>/<Folder>.md, kept by obsidian.js).
  return names.filter((n) => n.endsWith('.md') && !n.startsWith('_') && n !== `${folder}.md`);
}

async function stat(rel) {
  const root = await obsidian.vaultPath().catch(() => null);
  return root ? fsp.stat(path.join(root, rel)).catch(() => null) : null;
}

// ------------------------------------------------------- understanding tracker
async function readTopic(topic) {
  const rel = `${LEARNING}/${core.fileName(topic)}`;
  const text = await obsidian.readOptional(rel);
  return { rel, exists: Boolean(text), note: core.parse(text, text ? '' : String(topic).trim()) };
}

/** Records what the user understood, finds shaky, misunderstood or still asks about. */
async function update(topic, changes) {
  return withLock(`${LEARNING}/${core.fileName(topic)}`, async () => {
    const today = obsidian.ymd();
    const { rel, exists, note } = await readTopic(topic);
    const next = core.merge(note, changes, today);
    await obsidian.writeNote(rel, core.serialize(next, today), 'overwrite');
    return { path: rel, created: !exists, ...core.summary(next) };
  });
}

/** All topics, most recently worked on first. */
async function topics() {
  const names = await listNames(LEARNING);
  const out = await Promise.all(
    names.map(async (n) => {
      const rel = `${LEARNING}/${n}`;
      const [text, st] = await Promise.all([obsidian.readOptional(rel), stat(rel)]);
      return { ...core.summary(core.parse(text, n.slice(0, -3))), path: rel, modified: st?.mtimeMs || 0 };
    }),
  );
  return out.sort((a, b) => b.modified - a.modified);
}

/** For the agent's context: recent topics with what is still shaky or open. */
async function promptBlock() {
  const recent = (await topics().catch(() => [])).filter((t) => Date.now() - t.modified < RECENT_DAYS * 86400000).slice(0, PROMPT_TOPICS);
  const decks = await deckSummaries().catch(() => []);
  if (!recent.length && !decks.length) return '';
  const lines = ['### Learning (the user\'s tracker in Learning/ and decks in Languages/)'];
  for (const t of recent) lines.push(`- ${t.line}`);
  for (const d of decks) lines.push(`- ${d.language} deck: ${d.total} cards, ${d.dueCount} due today${d.newCount ? `, ${d.newCount} new` : ''}`);
  lines.push('Follow up on shaky concepts and open questions when the topic comes back, and offer a review when cards are due; don\'t lecture about it.');
  return lines.join('\n');
}

// ------------------------------------------------------------ vocabulary decks
function deckRel(language) {
  return `${LANGUAGES}/${core.fileName(language)}`;
}

async function readDeck(language) {
  const rel = deckRel(language);
  const text = await obsidian.readOptional(rel);
  const deck = srs.parseDeck(text);
  if (!text) deck.before = `---\ntype: deck\nlanguage: ${String(language).trim()}\n---\n# ${String(language).trim()}\n\nVocabulary and phrases with spaced repetition. Edit freely; keep the \`<!-- srs … -->\` comments.\n\n## Cards`;
  return { rel, deck, exists: Boolean(text) };
}

async function writeDeck(rel, deck) {
  await obsidian.writeNote(rel, srs.serializeDeck(deck), 'overwrite');
}

async function addCards(language, cards) {
  return withLock(deckRel(language), async () => {
    const { rel, deck } = await readDeck(language);
    const r = srs.addCards(deck, cards);
    if (r.added.length || cards.length) await writeDeck(rel, r.deck);
    return { path: rel, added: r.added, total: r.deck.cards.length };
  });
}

async function due(language, opts) {
  const { rel, deck, exists } = await readDeck(language);
  if (!exists) return { path: rel, cards: [], dueCount: 0, newCount: 0, total: 0, note: 'No deck for this language yet: add cards with vocab_add.' };
  return { path: rel, ...srs.dueCards(deck, obsidian.ymd(), opts) };
}

async function gradeCard(language, front, grade) {
  return withLock(deckRel(language), async () => {
    const { rel, deck, exists } = await readDeck(language);
    if (!exists) throw new Error(`No deck for ${language} yet.`);
    const r = srs.grade(deck, front, grade, obsidian.ymd());
    await writeDeck(rel, r.deck);
    return { front: r.card.front, nextReview: r.card.due, intervalDays: r.card.ivl };
  });
}

async function deckSummaries() {
  const names = await listNames(LANGUAGES);
  return Promise.all(
    names.map(async (n) => {
      const deck = srs.parseDeck(await obsidian.readOptional(`${LANGUAGES}/${n}`));
      const d = srs.dueCards(deck, obsidian.ymd(), { limit: 0 });
      // Mature: reviewed well enough to wait three weeks or more (the usual measure of a known card).
      return { language: n.slice(0, -3), total: d.total, dueCount: d.dueCount, newCount: d.newCount, mature: deck.cards.filter((c) => c.ivl >= 21).length };
    }),
  );
}

module.exports = { LEARNING, LANGUAGES, update, topics, readTopic, promptBlock, addCards, due, gradeCard, deckSummaries };
