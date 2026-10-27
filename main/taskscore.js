// Tasks from the user's to-do apps (Todoist, TickTick) in the Calendar view, pure. The app can't reach
// those services itself: they are claude.ai connectors, so the assistant fetches the tasks with the
// connector and hands them over with the tool tasks_save (tasks.js keeps them). This part cleans what
// it hands over, keeps one list per service, and answers "which tasks fall on this day".

const SOURCES = { todoist: 'Todoist', ticktick: 'TickTick' };
const MAX_TASKS = 500;
const DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/;

/** Which task connectors the user has connected, from the last connector check ([{ name, status }]). */
function connectedSources(list) {
  const out = [];
  for (const c of list || []) {
    if (c?.status !== 'connected') continue;
    const n = String(c.name || '').toLowerCase();
    for (const id of Object.keys(SOURCES)) if (n.includes(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const realDay = (d) => {
  const t = new Date(`${d}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

/** One task as the assistant gave it → { id, title, date, time, done, project, priority, url } or null. */
function cleanTask(t, i) {
  if (!t || typeof t !== 'object') return null;
  const title = clip(t.title ?? t.content, 200);
  if (!title) return null;
  let date = '';
  let time = '';
  const m = DATE.exec(String(t.due ?? t.date ?? '').trim());
  if (m && realDay(m[1])) {
    date = m[1];
    time = m[2] && /^([01]\d|2[0-3]):[0-5]\d$/.test(m[2]) ? m[2] : '';
  }
  const url = /^https:\/\/[^\s"<>]+$/i.test(String(t.url || '')) ? String(t.url).slice(0, 300) : '';
  const p = Math.round(Number(t.priority));
  return {
    id: clip(t.id, 80) || `t${i}`,
    title,
    date,
    time,
    done: t.done === true || t.completed === true,
    project: clip(t.project, 80),
    priority: p >= 1 && p <= 4 ? p : 0,
    url,
  };
}

/** The tasks the assistant handed over for one service, cleaned: { tasks, skipped }. */
function clean(list) {
  const raw = Array.isArray(list) ? list.slice(0, MAX_TASKS * 2) : [];
  const tasks = [];
  const seen = new Set();
  let skipped = 0;
  raw.forEach((t, i) => {
    const c = cleanTask(t, i);
    if (!c || seen.has(c.id)) return skipped++;
    seen.add(c.id);
    if (tasks.length < MAX_TASKS) tasks.push(c);
    else skipped++;
  });
  return { tasks, skipped };
}

/** The stored state with one service's list replaced: { sources: { id: { at, count } }, tasks: [...] }. */
function replace(state, source, tasks, now = Date.now()) {
  if (!Object.hasOwn(SOURCES, source)) throw new Error(`source must be one of: ${Object.keys(SOURCES).join(', ')}`);
  const prev = state && Array.isArray(state.tasks) ? state : { sources: {}, tasks: [] };
  return {
    ...prev,
    sources: { ...prev.sources, [source]: { at: now, count: tasks.length } },
    tasks: [...prev.tasks.filter((t) => t.source !== source), ...tasks.map((t) => ({ ...t, source }))],
  };
}

const byTime = (a, b) => (a.time || '99').localeCompare(b.time || '99') || (b.priority || 0) - (a.priority || 0) || a.title.localeCompare(b.title);

/** Open tasks due on a day (YYYY-MM-DD), timed ones first by time. */
function onDay(tasks, day) {
  return (tasks || []).filter((t) => t.date === day && !t.done).sort(byTime);
}

/** Open tasks due before today, oldest first. */
function overdue(tasks, today) {
  return (tasks || []).filter((t) => t.date && t.date < today && !t.done).sort((a, b) => a.date.localeCompare(b.date) || byTime(a, b));
}

/** What the assistant is asked to do when the user presses "Sync tasks" in the calendar. */
function syncPrompt(sources, today) {
  const names = sources.map((s) => SOURCES[s]).join(' and ');
  return [
    `Sync my tasks for the calendar (today is ${today}). For each of ${names}:`,
    `1. With its connector, get my open tasks that have a due date from ${today} back 14 days through the next 45 days (and overdue ones), with their project, priority and link.`,
    '2. Save them with tasks_save (the source, and every task: id, title, due as YYYY-MM-DD or YYYY-MM-DDTHH:MM, project, priority 1-4 where 4 is most urgent, url, done).',
    'Do not change anything in my task apps. Reply in one short line: how many tasks you saved from each.',
  ].join('\n');
}

module.exports = { SOURCES, MAX_TASKS, connectedSources, clean, replace, onDay, overdue, syncPrompt };
