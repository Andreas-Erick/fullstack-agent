// The Inner World: a small village where the user's personas (and two villagers of its own) live a
// fictional day. Its buildings grow with the user's real progress (the learning tracker, decks, habits,
// the skill tree, memory, rehearsals), so the village is a living picture of what they are building.
// A day is written by one "narrator" model call (the game-master pattern of DeepMind's Concordia):
// every resident's plan, a few scenes with dialogue, and what each resident remembers of it. The
// residents' memories are memory streams (streamcore.js), as in "Generative Agents".
// Pure (no Electron, no I/O): innerworld.js gathers the evidence, calls the model and stores the days.

const PLACES = [
  { id: 'garden', name: 'The Garden', icon: '🌿', x: 0.5, y: 0.5, about: 'The commons in the middle of the village.', base: () => true, value: (e) => e.days, steps: [7, 30], unit: 'days the world has lived' },
  { id: 'hearth', name: 'The Hearth', icon: '🏠', x: 0.5, y: 0.16, about: 'Where the residents live, eat and talk late into the evening.', base: () => true, value: (e) => e.personas, steps: [2, 4], unit: 'personas living here' },
  { id: 'library', name: 'The Library', icon: '📚', x: 0.17, y: 0.3, about: 'Shelves for everything you are coming to understand.', base: (e) => e.topics > 0, value: (e) => e.understood, steps: [10, 30], unit: 'concepts understood', start: 'Rises when you track a learning topic ("help me understand…").' },
  { id: 'cafe', name: 'The Language Café', icon: '☕', x: 0.83, y: 0.3, about: 'Small tables, many languages, strong coffee.', base: (e) => e.decks > 0, value: (e) => e.mature, steps: [50, 200], unit: 'mature vocabulary cards', start: 'Opens with your first vocabulary deck.' },
  { id: 'grounds', name: 'The Training Grounds', icon: '🏃', x: 0.17, y: 0.72, about: 'A track, a pull-up bar, a bench in the sun.', base: (e) => e.habits > 0, value: (e) => e.streak, steps: [7, 30], unit: 'days in your best habit streak', start: 'Laid out when you start tracking a habit.' },
  { id: 'observatory', name: 'The Observatory', icon: '🔭', x: 0.83, y: 0.72, about: 'Where the skill constellations are charted.', base: (e) => e.skills > 0, value: (e) => e.mastered, steps: [1, 5], unit: 'skills mastered', start: 'Built when you map a skill in the skill tree.' },
  { id: 'archive', name: 'The Archive', icon: '🗄', x: 0.33, y: 0.9, about: 'Every memory, filed and cross-referenced.', base: (e) => e.memories > 0, value: (e) => e.memories, steps: [25, 100], unit: 'memories kept', start: 'Starts with the first thing your assistant remembers about you.' },
  { id: 'stage', name: 'The Stage', icon: '🎭', x: 0.67, y: 0.9, about: 'Where rehearsals are played out before the real thing.', base: () => true, value: (e) => e.rehearsals, steps: [3, 10], unit: 'rehearsals' },
];
const PLACE_IDS = PLACES.map((p) => p.id);
const LEVEL_NAMES = ['foundation', 'built', 'growing', 'flourishing'];

// Villagers of the world's own, so it is never empty with a single persona. Colors come from the theme.
const TOWNSFOLK = [
  { id: 'npc-wren', name: 'Wren', npc: true, persona: 'The archivist. Keeps the Archive and lends a hand at the Library. Precise, dry humor, loves marginalia and old maps; secretly writes poetry.', color: null },
  { id: 'npc-bram', name: 'Bram', npc: true, persona: 'The gardener. Tends the Garden and fixes whatever breaks in the village. Slow-spoken and warm, reads the weather and everyone\'s moods, bakes on Sundays.', color: null },
];
const MAX_RESIDENTS = 8;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Each place's level (0 = foundation … 3 = flourishing) and what grows it, from the evidence counts. */
function places(evidence) {
  const e = Object.fromEntries(['days', 'personas', 'topics', 'understood', 'decks', 'mature', 'habits', 'streak', 'skills', 'mastered', 'memories', 'rehearsals'].map((k) => [k, num(evidence?.[k])]));
  return PLACES.map((p) => {
    const value = p.value(e);
    const level = p.base(e) ? 1 + p.steps.filter((s) => value >= s).length : 0;
    const hint = level === 0 ? p.start : level >= 3 ? `Flourishing: ${value} ${p.unit}.` : `${value} ${p.unit} · ${p.steps[level - 1]} for the next level.`;
    return { id: p.id, name: p.name, icon: p.icon, x: p.x, y: p.y, about: p.about, level, stage: LEVEL_NAMES[level], value, unit: p.unit, hint };
  });
}

/** What changed in the village since the last day, as plain news lines for the narrator and the chronicle. */
function news(before, after) {
  const prev = new Map((before || []).map((p) => [p.id, p.level]));
  const out = [];
  for (const p of after) {
    const was = prev.get(p.id);
    if (was === undefined || p.level <= was) continue;
    out.push(was === 0 ? `${p.name} was built (${p.value} ${p.unit}).` : `${p.name} grew: it is ${p.stage} now (${p.value} ${p.unit}).`);
  }
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** The residents: the user's personas (active first) plus the townsfolk, at most MAX_RESIDENTS, unique names. */
function residents(personas, { townsfolk = true } = {}) {
  const list = [...(personas?.list || [])].sort((a, b) => (b.id === personas?.active) - (a.id === personas?.active));
  const out = [];
  const seen = new Set();
  for (const p of list) {
    const name = clip(p.name, 40) || 'Unnamed';
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const color = p.theme?.colors?.accent;
    out.push({ id: String(p.id), name, npc: false, persona: clip(p.personality, 700), aesthetic: clip(p.aesthetic, 200), color: HEX.test(color || '') ? color : null });
  }
  if (townsfolk) for (const t of TOWNSFOLK) if (!seen.has(t.name.toLowerCase())) out.push({ ...t, aesthetic: '' });
  return out.slice(0, MAX_RESIDENTS);
}

// ------------------------------------------------------------------------------- one day
/**
 * The narrator's prompt for one day. ctx: { date (YYYY-MM-DD), weekday, residents (each with
 * memories: [text], reflections: [text]), places, news: [line], yesterday: summary }.
 */
function dayPrompt(ctx) {
  const placeLines = ctx.places.map((p) => `- ${p.id}: ${p.name} — ${p.stage}${p.level === 0 ? ' (only a foundation so far; nobody can use it yet)' : ''}. ${p.about}`).join('\n');
  const residentLines = ctx.residents
    .map((r) => {
      const mem = [...(r.reflections || []).map((x) => `insight: ${x}`), ...(r.memories || [])].slice(0, 8);
      return `### ${r.name}${r.npc ? ' (villager)' : ''}\n${r.persona || 'A thoughtful resident.'}${r.aesthetic ? `\nStyle: ${r.aesthetic}` : ''}${mem.length ? `\nRemembers:\n${mem.map((m) => `- ${m}`).join('\n')}` : ''}`;
    })
    .join('\n\n');
  return `You are the narrator of the Inner World, a small, cozy village where an AI assistant's personas live a quiet fictional life. Write ${ctx.weekday}, ${ctx.date}.

RULES
- It is fiction, slice-of-life: small stakes, warmth, curiosity, running jokes, friendships, little projects that continue from day to day. No violence, romance or melodrama.
- Every resident acts true to their personality and remembers what they remember. Continue threads from yesterday.
- The village is looked after by "the Keeper" (the user), who is never seen and never appears in a scene. Residents may notice the village's changes and credit the Keeper, but never invent anything about the Keeper beyond the news below.
- Use only these places (by id). A foundation can be looked at but not used.
- Times are HH:MM between 06:00 and 23:30, in order.

PLACES
${placeLines}

NEWS IN THE VILLAGE (real changes since yesterday)
${ctx.news.length ? ctx.news.map((n) => `- ${n}`).join('\n') : '- Nothing new was built.'}

YESTERDAY
${ctx.yesterday || 'This is the first day anyone remembers. The residents are just settling in.'}

RESIDENTS
${residentLines}

Respond with ONLY a JSON object:
{"weather": "a few words",
 "summary": "2-3 sentences: the day in the village",
 "residents": [{"name": "…", "mood": "one word", "plan": [{"start": "07:30", "place": "garden", "activity": "a few words"}]}],
 "scenes": [{"time": "10:15", "place": "cafe", "who": ["…", "…"], "title": "a few words", "lines": [{"who": "…", "text": "one or two sentences"}], "outcome": "one sentence"}],
 "memories": [{"who": "…", "text": "one sentence in the first person", "importance": 1-10}]}
Every resident gets a plan of 4-7 blocks covering the whole day. Write 2-4 scenes with 2-8 lines each, and 2-3 memories per resident.`;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (t) => {
  const m = String(t || '').match(TIME);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** The day from the narrator's JSON, validated against the residents and places. Throws when unusable. */
function parseDay(json, residentList) {
  if (!json || typeof json !== 'object') throw new Error('The narrator did not answer with a day.');
  const byName = new Map(residentList.map((r) => [r.name.toLowerCase(), r.name]));
  const who = (n) => byName.get(String(n || '').trim().toLowerCase()) || null;
  const place = (p) => (PLACE_IDS.includes(String(p || '').trim()) ? String(p).trim() : null);

  const plans = {};
  for (const r of Array.isArray(json.residents) ? json.residents : []) {
    const name = who(r?.name);
    if (!name || plans[name]) continue;
    const blocks = (Array.isArray(r.plan) ? r.plan : [])
      .map((b) => ({ start: String(b?.start || '').trim(), place: place(b?.place), activity: clip(b?.activity, 120) }))
      .filter((b) => minutes(b.start) !== null && minutes(b.start) >= 360 && b.place && b.activity)
      .sort((a, b) => minutes(a.start) - minutes(b.start))
      .slice(0, 8);
    plans[name] = { mood: clip(r.mood, 24), plan: blocks };
  }
  // Someone the narrator forgot still has a day.
  for (const r of residentList) if (!plans[r.name]?.plan.length) plans[r.name] = { mood: plans[r.name]?.mood || 'quiet', plan: [{ start: '08:00', place: r.npc && r.name === 'Wren' ? 'archive' : 'garden', activity: 'pottering about' }] };

  const scenes = (Array.isArray(json.scenes) ? json.scenes : [])
    .map((s) => {
      const lines = (Array.isArray(s?.lines) ? s.lines : []).map((l) => ({ who: who(l?.who), text: clip(l?.text, 300) })).filter((l) => l.who && l.text).slice(0, 10);
      const people = [...new Set([...(Array.isArray(s?.who) ? s.who.map(who) : []), ...lines.map((l) => l.who)].filter(Boolean))];
      return { time: String(s?.time || '').trim(), place: place(s?.place), who: people, title: clip(s?.title, 80), lines, outcome: clip(s?.outcome, 240) };
    })
    .filter((s) => minutes(s.time) !== null && s.place && s.lines.length)
    .sort((a, b) => minutes(a.time) - minutes(b.time))
    .slice(0, 5);

  const memories = (Array.isArray(json.memories) ? json.memories : [])
    .map((m) => ({ who: who(m?.who), text: clip(m?.text, 300), importance: Math.min(10, Math.max(1, Math.round(num(m?.importance) || 4))) }))
    .filter((m) => m.who && m.text)
    .slice(0, residentList.length * 4);

  const summary = clip(json.summary, 600);
  if (!summary && !scenes.length) throw new Error('The narrator\'s day was empty.');
  return { weather: clip(json.weather, 40), summary, residents: plans, scenes, memories };
}

/** Where a resident is at a time of day (minutes since midnight): the block that started last, and the next one. */
function whereAt(plan, at) {
  const blocks = (plan || []).filter((b) => minutes(b.start) !== null);
  if (!blocks.length) return null;
  let i = -1;
  for (let k = 0; k < blocks.length; k++) if (minutes(blocks[k].start) <= at) i = k;
  if (i < 0) return { place: 'hearth', activity: 'asleep', next: blocks[0] };
  const after = at >= 23 * 60 ? { place: 'hearth', activity: 'asleep' } : null;
  return after || { ...blocks[i], next: blocks[i + 1] || null };
}

/** The day as a chronicle entry in Markdown (Inner World/Chronicle.md, newest first). */
function chronicle(day) {
  const names = Object.fromEntries(PLACES.map((p) => [p.id, p.name]));
  const when = new Date(`${day.date}T12:00:00`).toLocaleDateString('en', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const out = [`## ${when}${day.weather ? ` · ${day.weather}` : ''}`, '', day.summary];
  if (day.news?.length) out.push('', ...day.news.map((n) => `- 🏗 ${n}`));
  for (const s of day.scenes) {
    out.push('', `### ${s.time} · ${names[s.place]} — ${s.title || 'A moment'}`, ...s.lines.map((l) => `> **${l.who}:** ${l.text}`), ...(s.outcome ? ['', `_${s.outcome}_`] : []));
  }
  return `${out.join('\n')}\n`;
}

module.exports = { PLACES, PLACE_IDS, TOWNSFOLK, MAX_RESIDENTS, places, news, residents, dayPrompt, parseDay, whereAt, minutes, chronicle };
