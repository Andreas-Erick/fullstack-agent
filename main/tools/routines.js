// Agent tools: Routines (routines.js): scheduled runs of the agent.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const { obj, str, bool, requireApproval } = require('./common');

module.exports = [
  {
    name: 'routine_list',
    group: 'routines',
    description: 'The user\'s routines (scheduled runs of you: what, when, next run, last result).',
    parameters: obj({}),
    run: async () => ({ routines: (await require('../routines').list()).map(({ id, name, when, instructions, enabled, nextRun, lastRun, lastStatus, lastSummary }) => ({ id, name, when, instructions, enabled, nextRun: nextRun ? new Date(nextRun).toLocaleString() : null, lastRun: lastRun ? new Date(lastRun).toLocaleString() : 'never', lastStatus, lastSummary })) }),
  },
  {
    name: 'routine_save',
    group: 'routines',
    description:
      'Create or change a routine: something you do on a schedule without being asked ("every morning at 8, check my Plaud for new recordings and summarize them"; "Sundays at 19:00, my weekly review"). Write instructions you can follow later on your own: which tools or connectors to use, what to save where (e.g. a vault note), and what to report. Each run happens in the routine\'s own conversation and the user gets a notification. Asks the user first. Give id to change an existing one.',
    parameters: obj(
      {
        id: str('Only to change an existing routine (routine_list)'),
        name: str('Short name, e.g. "Check Plaud recordings"'),
        schedule: obj({ kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'interval'], description: 'How often' }, time: str('HH:MM, 24-hour (not for interval)'), days: { type: 'array', items: { type: 'number' }, description: 'weekly: 0 = Sunday … 6 = Saturday' }, hours: { type: 'number', description: 'interval: every N hours (1–168)' } }, ['kind']),
        instructions: str('What to do on each run, step by step'),
        enabled: bool('false to pause it'),
      },
      ['name', 'schedule', 'instructions'],
    ),
    run: async (a, ctx) => {
      const core = require('../routinecore');
      const schedule = core.normalizeSchedule(a.schedule);
      await requireApproval(ctx, 'settings', `${a.id ? 'Change' : 'Create'} the routine "${a.name}" (${core.describe(schedule)})`, String(a.instructions || '').slice(0, 1500));
      const r = await require('../routines').save({ ...a, schedule });
      return { saved: r.name, id: r.id, when: r.when, nextRun: r.nextRun ? new Date(r.nextRun).toLocaleString() : null };
    },
  },
  {
    name: 'routine_delete',
    group: 'routines',
    description: 'Delete a routine (asks the user first).',
    parameters: obj({ id: str('The routine id (routine_list)') }, ['id']),
    run: async (a, ctx) => {
      const r = (await require('../routines').list()).find((x) => x.id === a.id);
      if (!r) throw new Error(`No routine with id "${a.id}".`);
      await requireApproval(ctx, 'delete', `Delete the routine "${r.name}"`, `${r.when}: ${r.instructions.slice(0, 600)}`);
      return require('../routines').remove(a.id);
    },
  },
  {
    name: 'routine_run',
    group: 'routines',
    description: 'Run a routine now, when the user asks ("check my Plaud now"). It runs in its own conversation; you get its report.',
    parameters: obj({ id: str('The routine id (routine_list)') }, ['id']),
    run: async (a, ctx) => {
      if (ctx.turn?.tainted) await requireApproval(ctx, 'settings', 'Run a routine now', 'Asked after reading external content.');
      return require('../routines').runNow(a.id);
    },
  },
];
