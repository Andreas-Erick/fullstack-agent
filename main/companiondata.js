// What a paired device sees of the user's data beyond chat (the phone app's Today, Learn, Memory, Notes,
// World and Skills screens). Read-only. Every function
// returns a trimmed copy: no file paths outside the vault, no settings, no secrets, no tool internals,
// and long texts clipped. companion.js serves these only while remote.shareData is on (the user's switch,
// never SETTABLE) and only to a paired device. Each reader is a stand-alone function so tests can call it.
const store = require('./store');

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const safe = (p, fallback = null) => Promise.resolve().then(p).catch(() => fallback);

/** Today at a glance: the schedule, priorities, decks due, notes written today, where we left off. */
async function today() {
  const obsidian = require('./obsidian');
  const day = obsidian.ymd();
  const s = await store.getSettings();
  const next = new Date(`${day}T12:00:00`);
  next.setDate(next.getDate() + 1);
  const [events, priorities, decks, handoff, topics, notes] = await Promise.all([
    s.calendar?.enabled ? safe(() => require('./calendar').events({ start: `${day}T00:00:00`, end: `${obsidian.ymd(next)}T00:00:00` }), []) : [],
    safe(() => obsidian.readPriorities(), ''),
    safe(() => require('./learning').deckSummaries(), []),
    safe(() => require('./handoff').read(), null),
    safe(() => require('./learning').topics(), []),
    safe(() => require('./notebook').summary(), null),
  ]);
  return {
    date: day,
    events: (events || []).map(({ title, location, allDay, start, end }) => ({ title: clip(title, 200), location: clip(location, 200), allDay, start, end })),
    priorities: clip(stripFrontmatter(priorities), 4000),
    decks: (decks || []).map(({ language, total, dueCount, newCount }) => ({ language, total, dueCount, newCount })),
    notesToday: notes?.today.length || 0,
    handoff: handoff && !handoff.dismissed ? { topic: clip(handoff.topic || handoff.title, 200), summary: clip(handoff.summary, 1200), nextSteps: (handoff.nextSteps || []).slice(0, 5).map((x) => clip(x, 200)), at: handoff.at } : null,
    shaky: (topics || []).flatMap((t) => (t.shaky || []).slice(0, 2).map((x) => ({ topic: t.topic, text: clip(x, 200) }))).slice(0, 5),
  };
}

const stripFrontmatter = (t) => String(t || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

async function learn() {
  const learning = require('./learning');
  const [topics, decks] = await Promise.all([safe(() => learning.topics(), []), safe(() => learning.deckSummaries(), [])]);
  const list = (a, n) => (Array.isArray(a) ? a.slice(-n).map((x) => clip(String(x).replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, ''), 300)) : []);
  const full = await Promise.all(topics.slice(0, 40).map((t) => safe(() => learning.readTopic(t.topic), null)));
  return {
    topics: topics.slice(0, 40).map((t, i) => {
      const s = full[i]?.note?.sections || {};
      return { topic: t.topic, understood: list(s.understood, 15), shaky: list(s.shaky, 8), misconceptions: list(s.misconceptions, 8), questions: list(s.questions, 8), modified: t.modified };
    }),
    decks: decks.map(({ language, total, dueCount, newCount, mature }) => ({ language, total, dueCount, newCount, mature })),
  };
}

async function memories(q = '') {
  const memory = require('./memory');
  const query = String(q || '').trim().slice(0, 200);
  const list = query ? await memory.search(query) : await memory.list();
  return { memories: (list || []).slice(0, 300).map((m) => ({ id: m.id, title: clip(m.title, 200), content: clip(m.content, 2000), category: m.category, updated: m.updated })) };
}

async function stream() {
  const st = require('./stream');
  if (!(await st.enabled())) return { records: [], off: true };
  const r = await st.recent(60);
  return { records: r.records.map((x) => ({ text: clip(x.text, 500), kind: x.kind, importance: x.importance, at: x.at })), total: r.total };
}

async function notes(q = '') {
  const obsidian = require('./obsidian');
  const query = String(q || '').trim().slice(0, 200);
  if (query) return { notes: (await obsidian.search(query, 40)).map((n) => ({ path: n.path, title: n.title, snippet: clip(n.snippet, 300) })) };
  // The user's own notes first, as in the Notes view (notebook.js); the whole vault when they have none yet.
  const mine = await safe(() => require('./notebook').list(), null);
  if (mine?.notes.length) return { notes: mine.notes.slice(0, 200).map((n) => ({ path: n.path, title: n.title, folder: n.folder || 'Notes', modified: n.mtime, snippet: clip(n.snippet, 200), pinned: n.pinned, tags: n.tags.slice(0, 4) })), own: true };
  const all = await obsidian.listNotes();
  return { notes: all.slice(0, 200).map((n) => ({ path: n.path, title: n.title, folder: n.folder, modified: n.modified })) };
}

/** One note, by its vault path (obsidian.readNote checks it stays inside the vault). */
async function note(path) {
  const p = String(path || '');
  if (!p || p.length > 400 || /(^|\/)\.\.?(\/|$)|^\/|\\|\0/.test(p) || /(^|\/)\.(obsidian|trash|git)\b/i.test(p)) throw Object.assign(new Error('Not a note'), { status: 400 }); // nor deleted notes (.trash), anywhere in the path
  const n = await require('./obsidian').readNote(p, 60000);
  return { path: n.path, title: n.title, modified: n.modified, content: n.content };
}

async function world() {
  const v = await require('./innerworld').view({ track: false }); // looking from the phone writes nothing
  return {
    enabled: v.enabled,
    vault: v.vault,
    date: v.date,
    day: v.day ? { weekday: v.day.weekday, weather: v.day.weather, summary: clip(v.day.summary, 2000), news: (v.day.news || []).slice(0, 8), scenes: (v.day.scenes || []).slice(0, 12).map((s) => ({ time: s.time, place: s.place, title: clip(s.title, 120), lines: (s.lines || []).slice(0, 16).map((l) => ({ who: l.who, text: clip(l.text, 400) })), outcome: clip(s.outcome, 300) })) } : null,
    places: v.places,
    residents: v.residents.map((r) => ({ id: r.id, name: r.name, npc: r.npc, color: r.color, active: r.active, mood: r.mood, plan: r.plan })),
    details: v.details,
  };
}

async function skills() {
  return { skills: (await require('./skills').list()).map((k) => ({ slug: k.slug, name: k.name, description: clip(k.description, 300) })) };
}

/**
 * The architecture map (main/archmap.js: the app's own code, not the user's data) for the phone's
 * Architecture screen: the cached map as the desktop shows it, with each file's symbol list cut short.
 */
async function arch() {
  const path = require('path');
  const m = await require('./archmap').get(path.join(__dirname, '..'));
  const nodes = m.nodes.map(({ id, parent, level, kind, name, tech, about, lesson, tone, auto, x, y, w, h, head, lines, path: p, symbols }) => ({
    id, parent, level, kind, name, tech, about: clip(about, 400), lesson: clip(lesson, 600), tone, auto: Boolean(auto), x, y, w, h, head, lines, path: p,
    symbols: (symbols || []).slice(0, 60).map((s) => ({ kind: s.kind, name: clip(s.name, 80), line: s.line, exported: Boolean(s.exported), detail: clip(s.detail, 60) })),
  }));
  return { nodes, edges: m.edges, bounds: m.bounds, stats: m.stats, principles: m.principles, sizes: m.sizes, builtAt: m.builtAt, stale: Boolean(m.stale) };
}

async function routines() {
  // `when` is the desktop's own wording ('schedule needs fixing' for a broken record); `schedule` stays for an
  // older cached phone client.
  return { routines: (await require('./routines').list()).map((r) => ({ name: r.name, enabled: r.enabled, when: r.when, schedule: r.schedule, lastRun: r.lastRun || 0, lastStatus: r.lastStatus || '' })) };
}

module.exports = { today, learn, memories, stream, notes, note, world, skills, routines, arch };
