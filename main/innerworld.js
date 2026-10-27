// The Inner World (rules, places and the narrator's prompt in worldcore.js). Once a day, while the app
// is open and the world is awake (innerWorld.enabled), one narrator call writes the residents' day;
// each resident keeps a memory stream in the vault (Inner World/Residents/<name>.md) and reflects on
// it now and then; the day goes into Inner World/Chronicle.md. The village's buildings are measured
// from the user's real progress every time. State (the last days, the levels, rehearsals) is in
// <userData>/innerworld.json. Never sent to paired devices (the window only).
const path = require('path');
const store = require('./store');
const log = require('./logger');
const obsidian = require('./obsidian');
const stream = require('./stream');
const core = require('./worldcore');
const { withLock } = require('./notelock');

const DAY_LIMIT_MS = 150000;
const CHECK_EVERY_MS = 20 * 60 * 1000;
const WAKE_HOUR = 7; // the day is written from this hour on
const KEEP_DAYS = 30;
const CHRONICLE = 'Inner World/Chronicle.md';
const file = () => path.join(store.dataDir(), 'innerworld.json');

let notify = () => {};
let running = null;
let timer = null;

async function state() {
  const s = await store.readJson(file(), {});
  return {
    days: Array.isArray(s.days) ? s.days : [],
    levels: Array.isArray(s.levels) ? s.levels : [],
    dayCount: Number(s.dayCount) || 0,
    rehearsals: Array.isArray(s.rehearsals) ? s.rehearsals : [],
    // The levels the view last showed ({ id: level }: level-ups are celebrated against them) and a
    // snapshot per day for the timelapse.
    seen: s.seen && typeof s.seen === 'object' ? s.seen : null,
    history: Array.isArray(s.history) ? s.history : [],
  };
}
// Read-modify-write of the state, one at a time (the view, the day and rehearsals all save it).
let saving = Promise.resolve();
function updateState(change) {
  const run = saving.then(async () => {
    const st = await state();
    if ((await change(st)) !== false) await store.writeJsonAtomic(file(), st);
    return st;
  });
  saving = run.catch(() => {});
  return run;
}

// ------------------------------------------------------------------ evidence and residents
// The assistant's work: every tool it uses is counted by place (worldcore.workFor) per day, in
// <userData>/innerworld-activity.json (counts only, never what the work was), and shown live.
const activityFile = () => path.join(store.dataDir(), 'innerworld-activity.json');
const KEEP_ACTIVITY_DAYS = 14;
let activity = null;
let activityTimer = null;

async function activityLog() {
  if (!activity) {
    const a = await store.readJson(activityFile(), {});
    activity = { days: a.days && typeof a.days === 'object' ? a.days : {}, total: a.total && typeof a.total === 'object' ? a.total : {} };
  }
  return activity;
}

/** A tool started in a turn: count it and tell the window where the active persona went. */
function noteTool(name) {
  const work = core.workFor(name);
  notify({ type: 'work', ...work, tool: String(name || '').slice(0, 80) });
  activityLog()
    .then((a) => {
      const day = (a.days[today()] ||= {});
      day[work.place] = (day[work.place] || 0) + 1;
      a.total[work.place] = (a.total[work.place] || 0) + 1;
      clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        const keep = Object.keys(a.days).sort().slice(-KEEP_ACTIVITY_DAYS);
        a.days = Object.fromEntries(keep.map((d) => [d, a.days[d]]));
        store.writeJsonAtomic(activityFile(), a).catch((err) => log.warn('inner world activity save failed', { error: err }));
      }, 3000);
      activityTimer.unref?.();
    })
    .catch(() => {}); // counting is a nicety; it must never disturb a turn
}

async function evidence(st, settings) {
  return (await gather(st, settings)).counts;
}

/** The counts that level the buildings, and the details the village is painted from. */
async function gather(st, settings) {
  const safe = (p, fallback) => Promise.resolve().then(p).catch(() => fallback);
  const learning = require('./learning');
  const [topics, decks, habits, tree, mems, records] = await Promise.all([
    safe(() => learning.topics(), []),
    safe(() => learning.deckSummaries(), []),
    safe(() => require('./habits').status(), { habits: [] }),
    safe(() => require('./skilltree').view(), { skills: [] }),
    safe(() => require('./memory').list(), []),
    safe(() => stream.readAll(stream.USER), []),
  ]);
  const active = habits.habits.filter((h) => !h.paused);
  const work = await activityLog().catch(() => ({ days: {}, total: {} }));
  const counts = {
    crafting: work.total.workshop || 0,
    scouting: work.total.lookout || 0,
    days: st.dayCount,
    personas: settings.personas?.list?.length || 1,
    topics: topics.length,
    understood: topics.reduce((s, t) => s + (t.understood || 0), 0),
    decks: decks.length,
    mature: decks.reduce((s, d) => s + (d.mature || 0), 0),
    habits: active.length,
    streak: Math.max(0, ...active.map((h) => (h.streakUnit === 'days' ? h.streak : h.streak * 7) || 0)),
    skills: tree.skills.length,
    mastered: tree.skills.filter((s) => s.state === 'mastered').length,
    memories: mems.length + records.length,
    rehearsals: st.rehearsals.length,
  };
  const clip = (s, n = 40) => String(s || '').slice(0, n);
  const details = {
    topics: topics.slice(0, 12).map((t) => ({ name: clip(t.topic), understood: t.understood || 0, shaky: t.shakyCount || 0 })),
    decks: decks.slice(0, 8).map((d) => ({ name: clip(d.language), mature: d.mature || 0, total: d.total || 0, due: d.dueCount || 0 })),
    habits: active.slice(0, 10).map((h) => ({ name: clip(h.name), done: Boolean(h.doneToday), streak: h.streak || 0, unit: h.streakUnit === 'days' ? 'd' : 'wk' })),
    skills: tree.skills.slice(0, 40).map((s) => ({ name: clip(s.name), state: s.state, progress: s.progress || 0, area: clip(s.area, 24), needs: (s.needs || []).slice(0, 6) })),
    memories: mems.length,
    records: records.length,
    insights: records.filter((r) => r.kind === 'reflection').length,
    work: { today: work.days[today()] || {}, total: work.total },
  };
  return { counts, details };
}

const fileName = (name) => String(name).replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Resident';

/** A resident's memory stream (one note in the vault). */
function residentStream(r) {
  return stream.noteStream(`Inner World/Residents/${fileName(r.name)}.md`, {
    subject: `${r.name}'s own life in the village`,
    title: `${r.name} — memories from the Inner World`,
    intro: `_${r.name}'s memories of life in the village (fiction, written by the Inner World's narrator). Edit or delete lines freely._`,
  });
}

async function residentsNow(settings) {
  return core.residents(settings.personas, { townsfolk: settings.innerWorld?.townsfolk !== false });
}

// ------------------------------------------------------------------ one day
const today = () => obsidian.ymd();
const weekday = (date) => new Date(`${date}T12:00:00`).toLocaleDateString('en', { weekday: 'long' });

/** Writes today's day (once; `force` writes it again). Returns the day. One at a time. */
function simulate({ force = false } = {}) {
  if (running) return running;
  running = (async () => {
    const settings = await store.getSettings();
    if (!settings.innerWorld?.enabled) throw new Error('The Inner World is asleep. Wake it in the Inner World view (or Settings → Memory & history).');
    if (!(await obsidian.vaultPath())) throw new Error('The Inner World lives in your vault; set one up first.');
    const st = await state();
    const date = today();
    const existing = st.days.find((d) => d.date === date);
    if (existing && !force) return existing;

    const started = Date.now();
    notify({ type: 'simulating' });
    const places = core.places(await evidence(st, settings));
    const news = core.news(st.levels.length ? st.levels : null, places);
    const residents = await residentsNow(settings);
    const yesterday = [...st.days].reverse().find((d) => d.date < date);
    const withMemories = await Promise.all(
      residents.map(async (r) => {
        const loc = residentStream(r);
        const records = await stream.readAll(loc).catch(() => []);
        const top = await stream.recall(loc, `${yesterday?.summary || ''} plans friends projects today`, { k: 6 }).catch(() => []);
        return { ...r, memories: top.filter((x) => x.kind !== 'reflection').map((x) => x.text), reflections: records.filter((x) => x.kind === 'reflection').slice(-2).map((x) => x.text) };
      }),
    );
    const work = await activityLog().catch(() => ({ days: {} }));
    const lastWorkDay = Object.keys(work.days).filter((d) => d < date).sort().pop();
    const activeName = residents.find((r) => r.id === settings.personas?.active)?.name || residents[0]?.name || 'the assistant';
    const prompt = core.dayPrompt({ date, weekday: weekday(date), residents: withMemories, places, news, work: lastWorkDay ? core.workLines(work.days[lastWorkDay], activeName) : [], yesterday: yesterday ? `${yesterday.date}: ${yesterday.summary}` : '' });

    const llm = require('./llm');
    let limitTimer;
    const limit = new Promise((_, reject) => (limitTimer = setTimeout(() => reject(new Error('The narrator took too long; try again later.')), DAY_LIMIT_MS)));
    let parsed;
    try {
      const text = await Promise.race([llm.complete(settings, prompt), limit]);
      parsed = core.parseDay(require('./persona').extractJson(text), residents);
    } finally {
      clearTimeout(limitTimer);
    }
    const day = { date, weekday: weekday(date), at: Date.now(), ...parsed, news };

    // Saved on the latest state: a rehearsal may have been recorded meanwhile.
    await updateState((fresh) => {
      fresh.days = [...fresh.days.filter((d) => d.date !== date), day].slice(-KEEP_DAYS);
      fresh.levels = places.map((p) => ({ id: p.id, level: p.level }));
      if (!existing) fresh.dayCount += 1;
    });
    await writeChronicle(day).catch((err) => log.warn('inner world chronicle failed', { error: err }));
    await remember(residents, day).catch((err) => log.warn('inner world memories failed', { error: err }));
    log.info('inner world day', { date, ms: Date.now() - started, scenes: day.scenes.length, residents: residents.length, news: news.length });
    notify({ type: 'day', date });
    reflectAll(residents); // in the background
    return day;
  })()
    .catch((err) => {
      notify({ type: 'failed', message: err.message });
      throw err;
    })
    .finally(() => (running = null));
  return running;
}

async function remember(residents, day) {
  for (const r of residents) {
    const mine = day.memories.filter((m) => m.who === r.name);
    if (mine.length) await stream.add(residentStream(r), mine.map((m) => ({ text: m.text, importance: m.importance })));
  }
}

// Each resident reflects when enough has happened to them (a smaller threshold than the user's stream).
async function reflectAll(residents) {
  for (const r of residents) {
    await stream.reflect(residentStream(r), { who: `${r.name}, a resident of a small fictional village. ${r.persona}`, threshold: 30 }).catch((err) => log.warn('inner world reflection failed', { resident: r.name, error: err }));
  }
}

async function writeChronicle(day) {
  await withLock(CHRONICLE, async () => {
    const entry = core.chronicle(day);
    const heading = entry.split('\n')[0].split(' · ')[0];
    // The earlier days (sections starting with "## "), without an older version of this one.
    const old = await obsidian.readOptional(CHRONICLE);
    const earlier = old
      .split(/^(?=## )/m)
      .filter((s) => s.startsWith('## ') && s.split('\n')[0].split(' · ')[0] !== heading)
      .join('')
      .trim();
    const text = `---\ntype: inner-world\n---\n# Chronicle of the Inner World\n_The village's days, newest first. Fiction, written by the narrator; the buildings grow with your real progress._\n\n${entry}\n${earlier}\n`;
    await obsidian.writeNote(CHRONICLE, text, 'overwrite', { source: 'inner world' });
  });
}

// ------------------------------------------------------------------ reading
const nowMinutes = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

// The levels as the view sees them now: today's snapshot for the timelapse, and any place that rose
// since the last look, told to the window once (world:event levelup).
async function track(places, date) {
  let levelups = [];
  const st = await updateState((s) => {
    levelups = core.levelUps(s.seen, places);
    const seen = Object.fromEntries(places.map((p) => [p.id, p.level]));
    const history = core.snapshot(s.history, date, places);
    if (history === s.history && JSON.stringify(seen) === JSON.stringify(s.seen)) return false;
    Object.assign(s, { seen, history });
  });
  if (levelups.length) {
    log.info('inner world level up', { places: levelups.map((l) => `${l.id}:${l.from}->${l.to}`) });
    notify({ type: 'levelup', places: levelups });
  }
  return { levelups, history: st.history };
}

/** Everything the Inner World view draws. */
async function view() {
  const settings = await store.getSettings();
  const st = await state();
  const vault = Boolean(await obsidian.vaultPath().catch(() => null));
  const { counts, details } = await gather(st, settings);
  const places = core.places(counts);
  const residents = await residentsNow(settings);
  const date = today();
  const day = [...st.days].reverse().find((d) => d.date === date) || null;
  const { levelups, history } = settings.innerWorld?.enabled ? await track(places, date) : { levelups: [], history: st.history };
  return {
    levelups,
    timelapse: core.timelapse(history, Object.fromEntries(places.map((p) => [p.id, p.name]))),
    details,
    enabled: Boolean(settings.innerWorld?.enabled),
    vault,
    date,
    simulating: Boolean(running),
    canSimulate: new Date().getHours() >= WAKE_HOUR,
    day,
    lastDay: day || st.days[st.days.length - 1] || null,
    days: st.days.slice(-7).reverse().map((d) => ({ date: d.date, weekday: d.weekday, weather: d.weather, summary: d.summary, scenes: d.scenes.length })),
    places,
    residents: residents.map((r) => ({ id: r.id, name: r.name, npc: r.npc, color: r.color, persona: r.persona.slice(0, 240), active: r.id === settings.personas?.active, ...(day?.residents?.[r.name] || {}) })),
    rehearsals: st.rehearsals.slice(-10).reverse(),
    chronicle: CHRONICLE,
  };
}

/** One resident: their memories and insights, and today's plan. */
async function resident(name) {
  const settings = await store.getSettings();
  const r = (await residentsNow(settings)).find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase());
  if (!r) throw new Error(`Nobody called "${name}" lives in the Inner World.`);
  const loc = residentStream(r);
  const records = await stream.readAll(loc).catch(() => []);
  const st = await state();
  const day = [...st.days].reverse().find((d) => d.residents?.[r.name]);
  return { name: r.name, npc: r.npc, persona: r.persona, today: day?.date === today() ? day.residents[r.name] : null, records: records.slice(-40).reverse(), note: loc.current() };
}

/** For the agent: today in the village, where everyone is now, and the buildings. */
async function status() {
  const v = await view();
  if (!v.enabled) return { enabled: false, note: 'The Inner World is asleep (the user wakes it in the Inner World view).' };
  const names = Object.fromEntries(core.PLACES.map((p) => [p.id, p.name]));
  const at = nowMinutes();
  return {
    date: v.date,
    written: Boolean(v.day),
    weather: v.day?.weather,
    summary: v.day?.summary || (v.lastDay ? `(today isn't written yet; last day ${v.lastDay.date}) ${v.lastDay.summary}` : 'Nothing has happened yet.'),
    scenes: (v.day?.scenes || []).map((s) => `${s.time} at ${names[s.place]}: ${s.title} (${s.who.join(', ')}) — ${s.outcome}`),
    residents: v.residents.map((r) => {
      const w = core.whereAt(r.plan, at);
      return `${r.name}${r.active ? ' (you, the active persona)' : ''}${r.npc ? ' (villager)' : ''}: ${r.mood ? `${r.mood}; ` : ''}${w ? `now at ${names[w.place]}, ${w.activity}` : 'no plan yet'}`;
    }),
    buildings: v.places.map((p) => `${p.name}: ${p.stage} — ${p.hint}`),
    rehearsals: v.rehearsals.length,
  };
}

/** Progress from a running rehearsal, for the Stage in the view. */
function progress(ev) {
  notify(ev);
}

async function recordRehearsal(entry) {
  await updateState((st) => {
    st.rehearsals = [...st.rehearsals, entry].slice(-50);
  });
  notify({ type: 'rehearsal', title: entry.title });
}

// ------------------------------------------------------------------ the daily check
async function check() {
  const settings = await store.getSettings();
  if (!settings.innerWorld?.enabled || new Date().getHours() < WAKE_HOUR) return;
  if (!(await obsidian.vaultPath().catch(() => null))) return;
  const st = await state();
  if (st.days.some((d) => d.date === today())) return;
  await simulate().catch((err) => log.warn('inner world day failed', { error: err }));
}

function start(opts = {}) {
  notify = opts.notify || notify;
  clearInterval(timer);
  timer = setInterval(() => check().catch(() => {}), CHECK_EVERY_MS);
  timer.unref?.();
  // A little after launch, so the first day never competes with the app's start.
  setTimeout(() => check().catch(() => {}), 90000).unref?.();
}

module.exports = { start, simulate, view, resident, status, recordRehearsal, progress, noteTool, residentStream, CHRONICLE };
