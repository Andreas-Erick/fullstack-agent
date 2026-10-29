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

const STALE_HOURS = 6; // an older copy is not answered from as if it were current
const PER_DAY = 8; // tasks listed per day; the rest as a count

const ago = (ms) => (ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))} min ago` : ms < 48 * 3600000 ? `${Math.round(ms / 3600000)} h ago` : `${Math.round(ms / 86400000)} days ago`);
const line = (t) => `${t.time ? `${t.time} ` : ''}${t.title}${t.project ? ` (${t.project})` : ''}`;
const list = (tasks) => (tasks.length ? `${tasks.slice(0, PER_DAY).map(line).join('; ')}${tasks.length > PER_DAY ? `; and ${tasks.length - PER_DAY} more` : ''}` : 'nothing');

/**
 * The tasks saved from the user's task apps for the per-message notes (prompt.turnContext): today's,
 * tomorrow's and how many are overdue, with when they were fetched. Reading questions are answered
 * from it without a connector call; it says when the copy is too old for that. '' when nothing was
 * ever synced. state = tasks.read(); today/tomorrow = YYYY-MM-DD.
 */
function promptBlock(state, { today, tomorrow, now = Date.now(), canFetch = true } = {}) {
  const sources = Object.entries(state?.sources || {}).filter(([id, s]) => Object.hasOwn(SOURCES, id) && Number.isFinite(s?.at));
  if (!sources.length) return '';
  const out = [];
  for (const [id, s] of sources) {
    const mine = (state.tasks || []).filter((t) => t.source === id);
    const late = overdue(mine, today);
    const stale = now - s.at > STALE_HOURS * 3600000;
    out.push(
      `- ${SOURCES[id]}, fetched ${ago(now - s.at)}${stale ? (canFetch ? ' (old: fetch it again with the connector before answering about these)' : ' (old: say so when you answer from it)') : ''}: today ${list(onDay(mine, today))}. Tomorrow ${list(onDay(mine, tomorrow))}.${late.length ? ` Overdue: ${late.length} (oldest due ${late[0].date}).` : ''}`,
    );
  }
  const how = canFetch
    ? 'Answer questions about these tasks from this copy when it is recent, without the connector, and say when it was fetched if that matters. Use the connector to change a task, for other days or details, or when the user wants it fresh; then save what you fetched with tasks_save.'
    : 'Answer questions about these tasks from this copy and say when it was fetched. Changing a task or fetching fresh ones needs the Claude brain with the connector.';
  return `## Your task apps (saved copy)\n${out.join('\n')}\n${how}`;
}

module.exports = { SOURCES, MAX_TASKS, STALE_HOURS, connectedSources, clean, replace, onDay, overdue, syncPrompt, promptBlock };
