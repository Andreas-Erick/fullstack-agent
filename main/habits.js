// The habit tracker in the vault (Habits.md, format and stats in habitcore.js). Used by the agent's
// habit_* tools, the Habits view and the agent's per-turn context.
const obsidian = require('./obsidian');
const core = require('./habitcore');
const { withLock } = require('./notelock');

const NOTE = 'Habits.md';

async function read() {
  return core.parse(await obsidian.readOptional(NOTE));
}

async function write(h) {
  await obsidian.writeNote(NOTE, core.serialize(h), 'overwrite');
}

async function status() {
  const today = obsidian.ymd();
  const h = await read();
  return { today, habits: core.stats(h, today) };
}

async function add(habit) {
  await withLock(NOTE, async () => write(core.addHabit(await read(), habit, obsidian.ymd())));
  return status();
}

/** done=false undoes a check-off. date defaults to today (YYYY-MM-DD; "yesterday" works too). */
async function log(names, { date, done = true } = {}) {
  const today = obsidian.ymd();
  const day = !date || date === 'today' ? today : date === 'yesterday' ? core.addDays(today, -1) : String(date);
  // A real calendar day (not 2026-02-31), not in the future.
  const t = new Date(`${day}T12:00:00Z`);
  const real = /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === day;
  if (!real || day > today) throw new Error('date must be today, yesterday or a past YYYY-MM-DD.');
  const r = await withLock(NOTE, async () => {
    const changed = core.setDone(await read(), names, day, done);
    await write(changed.habits);
    return changed;
  });
  return { date: day, [done ? 'done' : 'undone']: r.changed, ...(await status()) };
}

async function setPaused(name, paused) {
  await withLock(NOTE, async () => write(core.setPaused(await read(), name, paused)));
  return status();
}

/** One line for the agent's context: what is done today and what is still open, with streaks. */
async function promptLine() {
  const { habits } = await status();
  const active = habits.filter((x) => !x.paused);
  if (!active.length) return '';
  const fmt = (x) => `${x.name}${x.streak ? ` (streak ${x.streak} ${x.streakUnit === 'days' ? 'd' : 'wk'})` : ''}`;
  const done = active.filter((x) => x.doneToday);
  const open = active.filter((x) => !x.doneToday && (x.target >= 7 || x.thisWeek < x.target));
  return `## Habits today\nDone: ${done.map(fmt).join(', ') || 'nothing yet'}. Still open: ${open.map((x) => (x.target >= 7 ? fmt(x) : `${fmt(x)} ${x.thisWeek}/${x.target} this week`)).join(', ') || 'nothing'}.`;
}

module.exports = { status, add, log, setPaused, promptLine, NOTE };
