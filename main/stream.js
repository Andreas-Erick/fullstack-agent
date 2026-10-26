// The memory stream in the vault (format, retrieval and reflection rules in streamcore.js).
// The user's stream is one note per month in Stream/ (what the assistant noticed, and the insights it
// drew); the inner world's residents each keep one in Inner World/Residents/ (innerworld.js).
// When a record was last recalled is kept in <userData>/stream-access.json, so recalling never
// rewrites the vault. Reflection runs in the background once enough has happened, one at a time.
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const log = require('./logger');
const obsidian = require('./obsidian');
const core = require('./streamcore');
const { withLock } = require('./notelock');

const MONTHS_READ = 12; // the user's stream: the last year of monthly notes
const REFLECT_LIMIT_MS = 90000;
const accessFile = () => path.join(store.dataDir(), 'stream-access.json');

// ------------------------------------------------------------------ locations
const month = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/** The user's stream: monthly notes, newest month last. */
const USER = {
  key: 'user',
  subject: 'the user',
  notes() {
    const now = new Date();
    return Array.from({ length: MONTHS_READ }, (_, i) => `Stream/${month(new Date(now.getFullYear(), now.getMonth() - (MONTHS_READ - 1 - i), 1))}.md`);
  },
  current: () => `Stream/${month(new Date())}.md`,
  title: (rel) => `Memory stream — ${new Date(`${path.basename(rel, '.md')}-01T12:00:00`).toLocaleDateString('en', { month: 'long', year: 'numeric' })}`,
  intro: "_What I noticed while working with you, and the insights I drew from it (one line each: when, how important ★1–10, what). It's yours: edit or delete any line._",
};

/** A single-note stream (an inner-world resident). */
function noteStream(rel, { subject, title, intro }) {
  return { key: rel, subject, notes: () => [rel], current: () => rel, title: () => title, intro };
}

// ------------------------------------------------------------------ reading and writing
async function readAll(loc) {
  const texts = await Promise.all(loc.notes().map((rel) => obsidian.readOptional(rel)));
  return texts.flatMap((t) => core.parse(t)).sort((a, b) => a.at - b.at);
}

const newId = () => `r-${crypto.randomBytes(4).toString('hex')}`;

/** Appends records ({ text, importance, kind?, evidence? }) to the location's current note. */
async function add(loc, items) {
  const rel = loc.current();
  const now = Date.now();
  const made = items.map((x, i) => core.make({ ...x, id: newId(), at: now + i }));
  if (!made.length) return [];
  await withLock(rel, async () => {
    const records = core.parse(await obsidian.readOptional(rel));
    const text = `---\ntype: memory-stream\n---\n${core.serialize([...records, ...made], { title: loc.title(rel), intro: loc.intro })}`;
    await obsidian.writeNote(rel, text, 'overwrite', { source: 'stream' });
  });
  return made;
}

// Access times: read once, written a moment after the last change.
let access = null;
let saveTimer = null;
async function accessMap() {
  access ||= await store.readJson(accessFile(), {});
  return access;
}
async function touch(ids) {
  const map = await accessMap();
  const now = Date.now();
  for (const id of ids) map[id] = now;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // Keep the newest 5000 entries; older ones only cost recency, never correctness.
    const kept = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5000);
    access = Object.fromEntries(kept);
    store.writeJsonAtomic(accessFile(), access).catch((err) => log.warn('stream access save failed', { error: err }));
  }, 2000);
  saveTimer.unref?.();
}

/** The records that matter most for `query` now (marks them as recalled). */
async function recall(loc, query, { k = 8, minRelevance = 0 } = {}) {
  const records = await readAll(loc);
  const top = core.retrieve(records, query, { access: await accessMap(), k, minRelevance });
  if (top.length) touch(top.map((r) => r.id));
  return top;
}

// ------------------------------------------------------------------ reflection
const reflecting = new Map(); // location key → running promise

/**
 * Draws insights from the observations since the last reflection, when they add up to enough
 * (or `force`). Returns the new reflections ([] when there was nothing to do). One at a time per stream.
 */
function reflect(loc, { force = false, who, threshold } = {}) {
  if (reflecting.has(loc.key)) return reflecting.get(loc.key);
  const run = (async () => {
    const records = await readAll(loc);
    const p = core.pending(records, threshold);
    if (!(p.due || (force && p.fresh.length >= 2))) return [];
    const settings = await store.getSettings();
    const llm = require('./llm');
    const prompt = core.reflectionPrompt(records, { subject: loc.subject, who: who || `${settings.agent.name || 'Siren'}, an AI assistant` });
    let timer;
    const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('Reflection took too long.')), REFLECT_LIMIT_MS)));
    try {
      const text = await Promise.race([llm.complete({ ...settings, llm: { ...settings.llm, modelMode: 'fast' } }, prompt), limit]);
      const insights = core.parseReflections(require('./persona').extractJson(text), records);
      const saved = await add(loc, insights.map((x) => ({ ...x, kind: 'reflection' })));
      log.info('stream reflected', { stream: loc.key, from: p.fresh.length, insights: saved.length });
      return saved;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => reflecting.delete(loc.key));
  reflecting.set(loc.key, run);
  return run;
}

// ------------------------------------------------------------------ the user's stream
async function enabled() {
  const s = await store.getSettings();
  return s.memory?.stream !== false && Boolean(await obsidian.vaultPath().catch(() => null));
}

/** Records what the assistant noticed; reflects in the background when enough has piled up. */
async function observe(items) {
  const list = (Array.isArray(items) ? items : [items]).filter((x) => x && String(x.text || '').trim()).slice(0, 8);
  if (!list.length) throw new Error('Nothing to record.');
  const saved = await add(USER, list.map((x) => ({ text: x.text, importance: x.importance })));
  const s = await store.getSettings();
  if (s.memory?.reflect !== false) reflect(USER).catch((err) => log.warn('stream reflection failed', { error: err }));
  return saved;
}

async function recent(n = 60) {
  const records = await readAll(USER);
  const p = core.pending(records);
  return { records: records.slice(-n).reverse(), total: records.length, sinceReflection: p.sum, reflectAt: core.REFLECT_AT, note: USER.current() };
}

/** For the agent's per-turn context: what the stream holds that matters for this message. */
async function promptBlock(query) {
  if (!(await enabled())) return '';
  const top = await recall(USER, query, { k: 6 });
  if (!top.length) return '';
  const line = (r) => `- ${core.stamp(r.at).slice(0, 10)} · ★${r.importance} · ${r.kind === 'reflection' ? 'insight: ' : ''}${r.text}`;
  return `## Recalled from your memory stream\n(what you noticed earlier and the insights you drew; most relevant to this message first; use what helps, never recite it)\n${top.map(line).join('\n')}`;
}

module.exports = { USER, noteStream, readAll, add, recall, reflect, enabled, observe, recent, promptBlock };
