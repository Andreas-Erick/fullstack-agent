// The skill tree in the vault (Skill Tree.md; format, progress and layout in skilltreecore.js), with
// its evidence gathered from the learning tracker, flashcard and vocabulary decks, and habits.
const obsidian = require('./obsidian');
const core = require('./skilltreecore');
const { withLock } = require('./notelock');

const NOTE = 'Skill Tree.md';

async function read() {
  return core.parse(await obsidian.readOptional(NOTE));
}

// Decks: every flashcard deck and vocabulary deck (flashcards.js), by name; a flashcard deck and a
// language deck with the same name count together.
async function evidence() {
  const learning = require('./learning');
  const [topics, cardDecks, habits] = await Promise.all([learning.topics().catch(() => []), require('./flashcards').evidence().catch(() => []), require('./habits').status().catch(() => ({ habits: [] }))]);
  const decks = new Map();
  for (const d of cardDecks) {
    const k = d.name.toLowerCase();
    const x = decks.get(k) || { language: d.name, mature: 0, total: 0 };
    decks.set(k, { ...x, mature: x.mature + d.mature, total: x.total + d.total });
  }
  return { learning: topics, decks: [...decks.values()], habits: habits.habits };
}

/** The tree with progress and states, the layout, and what can be linked as a source. */
async function view() {
  const [tree, ev] = await Promise.all([read(), evidence()]);
  const skills = core.compute(tree, ev);
  return {
    skills,
    layout: core.layout(skills),
    options: { learning: ev.learning.map((t) => t.topic), deck: ev.decks.map((d) => d.language), habit: ev.habits.filter((h) => !h.paused).map((h) => h.name) },
    thresholds: { unlock: core.UNLOCK_AT, mastered: core.MASTERED_AT },
  };
}

async function upsert(items) {
  const r = await withLock(NOTE, async () => {
    const changed = core.upsert(await read(), items);
    await obsidian.writeNote(NOTE, core.serialize(changed.tree), 'overwrite');
    return changed;
  });
  return { changed: r.changed, ...(await summary()) };
}

async function remove(name) {
  await withLock(NOTE, async () => obsidian.writeNote(NOTE, core.serialize(core.remove(await read(), name)), 'overwrite'));
  return { removed: name };
}

/** For the agent: every skill with its progress, and what is ready to work on next. */
async function summary() {
  const { skills } = await view();
  return {
    skills: skills.map((s) => ({ name: s.name, area: s.area, progress: `${Math.round(s.progress * 100)}%`, state: s.state, needs: s.needs, blockedBy: s.blockers, sources: s.sources.map((x) => `${x.type}: ${x.name} (${x.detail})`) })),
    next: skills.filter((s) => s.state === 'ready' || (s.state === 'growing' && !s.blockers.length)).sort((a, b) => b.progress - a.progress).slice(0, 5).map((s) => s.name),
  };
}

module.exports = { NOTE, view, upsert, remove, summary };
