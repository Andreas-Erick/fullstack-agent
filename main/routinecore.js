// Routines: agent runs on a schedule ("every day at 8:00: check my Plaud recordings"). Pure: validating a
// routine, the next run time, whether one is due, and a label for people. Local time throughout.
//
// schedule: { kind: 'daily' | 'weekdays' | 'weekly' | 'interval', time: 'HH:MM', days: [0-6] (weekly;
// 0 = Sunday), hours: N (interval) }.

const KINDS = ['daily', 'weekdays', 'weekly', 'interval'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_INSTRUCTIONS = 4000;

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return [Number(m[1]), Number(m[2])];
}

/** A clean schedule, or an error saying what is wrong. */
function normalizeSchedule(s = {}) {
  const kind = String(s.kind || '').toLowerCase();
  if (!KINDS.includes(kind)) throw new Error(`schedule.kind must be one of: ${KINDS.join(', ')}`);
  if (kind === 'interval') {
    const hours = Number(s.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error('An interval routine needs hours between 1 and 168.');
    return { kind, hours: Math.round(hours) };
  }
  const time = parseTime(s.time);
  if (!time) throw new Error('schedule.time must be HH:MM (24-hour), e.g. "08:00".');
  const out = { kind, time: `${String(time[0]).padStart(2, '0')}:${String(time[1]).padStart(2, '0')}` };
  if (kind === 'weekly') {
    const days = [...new Set((Array.isArray(s.days) ? s.days : [s.days]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) throw new Error('A weekly routine needs days (0 = Sunday … 6 = Saturday).');
    out.days = days;
  }
  return out;
}

/** A routine from the user or the agent, validated. */
function normalize(r, { newId, now = Date.now() } = {}) {
  const name = String(r.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!name) throw new Error('Give the routine a short name.');
  const instructions = String(r.instructions || '').trim().slice(0, MAX_INSTRUCTIONS);
  if (!instructions) throw new Error('Say what the routine should do (instructions).');
  return {
    id: r.id || newId('rt-'),
    name,
    schedule: normalizeSchedule(r.schedule),
    instructions,
    enabled: r.enabled !== false,
    notify: r.notify !== false,
    createdAt: r.createdAt || now,
    lastRun: r.lastRun || 0,
    lastStatus: r.lastStatus || '',
    lastSummary: r.lastSummary || '',
    conversationId: r.conversationId || '',
  };
}

/** The first scheduled time strictly after `after` (a Date). */
function nextRun(schedule, after) {
  const s = schedule;
  if (s.kind === 'interval') return new Date(after.getTime() + s.hours * 3600000);
  const [h, m] = parseTime(s.time);
  const d = new Date(after.getFullYear(), after.getMonth(), after.getDate(), h, m, 0, 0);
  for (let i = 0; i < 8; i++) {
    const day = d.getDay();
    const ok = s.kind === 'daily' || (s.kind === 'weekdays' && day >= 1 && day <= 5) || (s.kind === 'weekly' && s.days.includes(day));
    if (ok && d > after) return d;
    d.setDate(d.getDate() + 1);
    d.setHours(h, m, 0, 0);
  }
  return null;
}

// How late a missed run may still happen (the app was closed at the time): daily things the same day.
const lateLimitMs = (s) => (s.kind === 'interval' ? s.hours * 3600000 : s.kind === 'weekly' ? 2 * 86400000 : 16 * 3600000);

/**
 * What to do with a routine now: 'run', 'skip' (missed by too much: move on to the next time without
 * running) or 'wait'. The reference point is the last run, or when it was created.
 */
function check(routine, now = new Date()) {
  if (!routine.enabled) return { action: 'wait', next: null };
  const from = new Date(routine.lastRun || routine.createdAt);
  const due = nextRun(routine.schedule, from);
  if (!due || due > now) return { action: 'wait', next: due };
  // Several missed occurrences count once; a run that is too late is skipped.
  let latest = due;
  for (let n = nextRun(routine.schedule, due); n && n <= now; n = nextRun(routine.schedule, n)) latest = n;
  return { action: now - latest <= lateLimitMs(routine.schedule) ? 'run' : 'skip', next: nextRun(routine.schedule, now), due: latest };
}

function describe(s) {
  if (s.kind === 'interval') return s.hours === 1 ? 'every hour' : `every ${s.hours} hours`;
  if (s.kind === 'daily') return `every day at ${s.time}`;
  if (s.kind === 'weekdays') return `weekdays at ${s.time}`;
  const names = s.days.map((d) => DAY_NAMES[d]);
  return `${names.length === 1 ? `every ${names[0]}` : names.join(', ')} at ${s.time}`;
}

/** The message the agent gets when a routine runs. */
// A routine often runs in a session started a moment ago, while the user's claude.ai connectors are
// still loading: their tools aren't listed yet. A run once reported TickTick "disconnected again"
// without looking (and one wrote a Plaud failure to the daily note, then found Plaud six seconds later).
const CONNECTOR_CHECK = 'If a service you need (a connector such as TickTick or Plaud) is not among your tools, it may still be loading: look it up with ToolSearch, and search once more if nothing comes back. Call it unreachable only when the searches find nothing or a call to it fails, and write nothing about a failure (daily note, saved tasks) before that. An earlier run that found it down says nothing about now.';

function prompt(routine, now = new Date()) {
  const last = routine.lastRun ? new Date(routine.lastRun).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never (this is the first run)';
  return `⏰ Routine "${routine.name}" (runs ${describe(routine.schedule)}). Now: ${now.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}. Last run: ${last}.

${routine.instructions}

This runs on a schedule, so I may not be at the computer. Look only at what is new since the last run when that makes sense. Read, summarize and write notes freely; don't take actions that would need my approval unless the instructions ask for them (an approval nobody answers is declined). ${CONNECTOR_CHECK} End with a short report: what you found or did, in a few lines, or "Nothing new." if there was nothing.`;
}

module.exports = { KINDS, normalize, normalizeSchedule, nextRun, check, describe, prompt, CONNECTOR_CHECK };
