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

// A time from routines.json a Date can use (an edit by hand may leave it out or garble it).
const usableTime = (t) => Boolean(t) && !Number.isNaN(new Date(t).getTime());

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
    createdAt: usableTime(r.createdAt) ? r.createdAt : now,
    lastRun: usableTime(r.lastRun) ? r.lastRun : 0,
    lastStatus: r.lastStatus || '',
    lastSummary: r.lastSummary || '',
    conversationId: r.conversationId || '',
  };
}

/** Whether a save of routine `old` only pauses it (enabled false; name, schedule and steps as they are): it can only make less run. */
function onlyPauses(old, input) {
  if (!old || input?.enabled !== false) return false;
  try {
    const next = normalize({ ...old, ...input }, { newId: () => old.id });
    return next.name === old.name && next.instructions === old.instructions && JSON.stringify(next.schedule) === JSON.stringify(normalizeSchedule(old.schedule));
  } catch {
    return false; // not a valid routine: saving it fails anyway, after the usual question
  }
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
  const cut = routine.lastStatus === 'interrupted' ? ` The previous run (${last}) was cut off when the app closed before it finished: check what it already did (the schedule, notes, saved tasks) before doing anything again.` : '';
  return `⏰ Routine "${routine.name}" (runs ${describe(routine.schedule)}). Now: ${now.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })}. Last run: ${last}.${cut}

${routine.instructions}

This runs on a schedule, so I may not be at the computer. Look only at what is new since the last run when that makes sense. Read, summarize and write notes freely; don't take actions that would need my approval unless the instructions ask for them (an approval nobody answers is declined). ${CONNECTOR_CHECK} End with a short report: what you found or did, in a few lines, or "Nothing new." if there was nothing.`;
}

/**
 * Whether a routine's conversation has become the user's own chat: its first run made the
 * conversation, the user went on talking there, and every sync then ran in that chat (on its model,
 * its tool results in the context of every later message). Then the routine starts its own again.
 * A few replies to a briefing don't count: the user's own messages must be many and outnumber the
 * routine's runs two to one.
 */
function takenOver(conv, routineId) {
  const users = (conv?.messages || []).filter((m) => m.role === 'user');
  const runs = users.filter((m) => m.routine === routineId).length;
  const own = users.filter((m) => !m.routine).length;
  return own >= 6 && own > 2 * runs;
}

// A run that couldn't start because the brain isn't ready (a local model not chosen or not running,
// Claude not connected) waits and tries again, instead of failing silently: the daily briefing and the
// recordings check both failed on "No model selected" and nothing tried again. Not handed to Claude: for
// a local brain that would send the routine off the computer, which only the user's hand-over allows.
const RETRY_MIN = 10;
const MAX_RETRIES = 3;
const NOT_READY = /no model selected|no ai provider is ready|econnrefused|fetch failed|is not installed|connect your claude account|not logged in|log ?in to claude|helper app did not come up|server is not running/i;
const brainNotReady = (error) => NOT_READY.test(String(error?.message || error || ''));
// The network, not the brain: the CLI's own wording (2.1.327) and Node's codes. A certificate or proxy
// problem ("Unable to connect to API: SSL…", "…: Self-signed…", "Couldn't connect through your proxy")
// is not an outage, so it isn't waited out.
const OFFLINE = /enotfound|eai_again|enetunreach|enetdown|ehostunreach|ehostdown|etimedout|econnreset|connection error|connection dropped|no internet route|can['’]t reach the api server|unable to connect to api(?!:)/i;
const offline = (error) => OFFLINE.test(String(error?.message || error || ''));

/** What a failed run means: { retryAt, retries, summary, waitsFor: 'brain' | 'internet' } to wait, or null to fail as before. */
function retryPlan(routine, error, now = Date.now()) {
  const brain = brainNotReady(error);
  if (!brain && !offline(error)) return null;
  const retries = (Number(routine?.retries) || 0) + 1;
  if (retries > MAX_RETRIES) return null;
  const why = String(error?.message || error || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return { retryAt: now + RETRY_MIN * 60000, retries, waitsFor: brain ? 'brain' : 'internet', summary: `Waiting for ${brain ? 'the AI brain' : 'the internet connection'} (${why}). Tries again in ${RETRY_MIN} minutes (${retries} of ${MAX_RETRIES}).` };
}

module.exports = { KINDS, normalize, normalizeSchedule, onlyPauses, usableTime, nextRun, check, describe, prompt, CONNECTOR_CHECK, takenOver, brainNotReady, offline, retryPlan, RETRY_MIN, MAX_RETRIES };
