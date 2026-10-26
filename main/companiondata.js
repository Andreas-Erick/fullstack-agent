// What a paired device sees of the user's data beyond chat (the phone app's Today, Habits, Learn, Tree,
// Memory, Notes, World and Skills screens). Read-only, except checking a habit off. Every function
// returns a trimmed copy: no file paths outside the vault, no settings, no secrets, no tool internals,
// and long texts clipped. companion.js serves these only while remote.shareData is on (the user's switch,
// never SETTABLE) and only to a paired device. Each reader is a stand-alone function so tests can call it.
const store = require('./store');

const clip = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const safe = (p, fallback = null) => Promise.resolve().then(p).catch(() => fallback);

/** Today at a glance: the schedule, habits, priorities, decks due, where we left off. */
async function today() {
  const obsidian = require('./obsidian');
  const day = obsidian.ymd();
  const s = await store.getSettings();
  const next = new Date(`${day}T12:00:00`);
  next.setDate(next.getDate() + 1);
  const [events, habits, priorities, decks, handoff, topics] = await Promise.all([
    s.calendar?.enabled ? safe(() => require('./calendar').events({ start: `${day}T00:00:00`, end: `${obsidian.ymd(next)}T00:00:00` }), []) : [],
    safe(() => require('./habits').status(), null),
    safe(() => obsidian.readPriorities(), ''),
    safe(() => require('./learning').deckSummaries(), []),
    safe(() => require('./handoff').read(), null),
    safe(() => require('./learning').topics(), []),
  ]);
  return {
    date: day,
    events: (events || []).map(({ title, location, allDay, start, end }) => ({ title: clip(title, 200), location: clip(location, 200), allDay, start, end })),
    habits: habitList(habits),
    priorities: clip(stripFrontmatter(priorities), 4000),
    decks: (decks || []).map(({ language, total, dueCount, newCount }) => ({ language, total, dueCount, newCount })),
    handoff: handoff && !handoff.dismissed ? { topic: clip(handoff.topic || handoff.title, 200), summary: clip(handoff.summary, 1200), nextSteps: (handoff.nextSteps || []).slice(0, 5).map((x) => clip(x, 200)), at: handoff.at } : null,
    shaky: (topics || []).flatMap((t) => (t.shaky || []).slice(0, 2).map((x) => ({ topic: t.topic, text: clip(x, 200) }))).slice(0, 5),
  };
}

const stripFrontmatter = (t) => String(t || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

function habitList(status) {
  return (status?.habits || []).map((h) => ({ name: h.name, frequency: h.frequency, target: h.target, paused: Boolean(h.paused), doneToday: Boolean(h.doneToday), streak: h.streak || 0, streakUnit: h.streakUnit || 'days', thisWeek: h.thisWeek || 0, last7: h.last7 || [], rate28: h.rate28 || 0 }));
}

async function habits() {
  return { habits: habitList(await require('./habits').status()) };
}

/** Checking a habit off (or undoing it) for today or yesterday, from the phone. */
async function logHabit(name, done, date) {
  const n = String(name || '').trim().slice(0, 120);
  if (!n) throw Object.assign(new Error('Which habit?'), { status: 400 });
  const d = date === 'yesterday' ? 'yesterday' : 'today';
  const r = await require('./habits').log([n], { done: done !== false, date: d });
  return { habits: habitList(r) };
}

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

async function tree() {
  const v = await require('./skilltree').view();
  // The constellation as on the desktop: positions (0..1) and links between the skills.
  const names = new Set(v.skills.map((k) => k.name));
  const pos = {};
  for (const [n, p] of Object.entries(v.layout?.pos || {})) if (names.has(n)) pos[n] = { x: +p.x || 0, y: +p.y || 0, depth: +p.depth || 0 };
  const edges = (v.layout?.edges || []).filter((e) => names.has(e.from) && names.has(e.to)).map((e) => ({ from: e.from, to: e.to }));
  return { skills: v.skills.map((k) => ({ name: k.name, area: k.area, needs: k.needs || [], state: k.state, progress: k.progress })), thresholds: v.thresholds, layout: { pos, edges, depth: +v.layout?.depth || 0, areas: (v.layout?.areas || []).map(String) } };
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
  const all = await obsidian.listNotes();
  return { notes: all.slice(0, 200).map((n) => ({ path: n.path, title: n.title, folder: n.folder, modified: n.modified })) };
}

/** One note, by its vault path (obsidian.readNote checks it stays inside the vault). */
async function note(path) {
  const p = String(path || '');
  if (!p || p.length > 400 || /(^|\/)\.\.?(\/|$)|^\/|\\|\0/.test(p) || /^\.obsidian\b/i.test(p)) throw Object.assign(new Error('Not a note'), { status: 400 });
  const n = await require('./obsidian').readNote(p, 60000);
  return { path: n.path, title: n.title, modified: n.modified, content: n.content };
}

async function world() {
  const v = await require('./innerworld').view();
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

async function routines() {
  return { routines: (await require('./routines').list()).map((r) => ({ name: r.name, enabled: r.enabled, schedule: r.schedule, lastRun: r.lastRun || 0, lastStatus: r.lastStatus || '' })) };
}

module.exports = { today, habits, logHabit, learn, tree, memories, stream, notes, note, world, skills, routines };
