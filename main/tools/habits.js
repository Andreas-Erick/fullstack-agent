// Agent tools: Habits (habits.js, Habits.md in the vault).
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const { arr, obj, str, bool } = require('./common');

module.exports = [
  {
    name: 'habit_status',
    group: 'habits',
    description: 'The user\'s habits (Habits.md in the vault): which are done today, streaks, this week against the target, the last 7 days and the last four weeks. Use it for check-ins and reviews.',
    parameters: obj({}),
    run: async () => require('../habits').status(),
  },
  {
    name: 'habit_log',
    group: 'habits',
    description: 'Tick off habits the user did ("I meditated", "went for a run yesterday"), or undo one (done: false). Names must be tracked habits (habit_status). Say the streak back briefly; don\'t gush.',
    parameters: obj({ habits: arr('Habit names'), date: str('today (default), yesterday, or YYYY-MM-DD'), done: bool('false to undo') }, ['habits']),
    run: async (a, ctx) => {
      const r = await require('../habits').log(a.habits || [], { date: a.date, done: a.done !== false });
      ctx.emit({ type: 'habits_changed' });
      return r;
    },
  },
  {
    name: 'habit_add',
    group: 'habits',
    description: 'Start tracking a habit the user decided on (or change its target). Help them make it small and concrete first: a tiny version, an anchor ("after my morning coffee"), and how often. target = times per week (7 = daily).',
    parameters: obj({ name: str('Short name, e.g. "Meditate"'), target: { type: 'number', description: 'Times per week, 1–7 (7 = daily)' }, note: str('The plan in a few words: when, where, the tiny version') }, ['name']),
    run: async (a, ctx) => {
      const r = await require('../habits').add({ name: a.name, target: a.target ?? 7, note: a.note });
      ctx.emit({ type: 'habits_changed' });
      return r;
    },
  },
  {
    name: 'habit_pause',
    group: 'habits',
    description: 'Pause a habit (or resume it with paused: false). Its history stays. Use when the user drops or changes a habit; no guilt-tripping.',
    parameters: obj({ name: str('The habit'), paused: bool('false to resume') }, ['name']),
    run: async (a, ctx) => {
      const r = await require('../habits').setPaused(a.name, a.paused !== false);
      ctx.emit({ type: 'habits_changed' });
      return r;
    },
  },
];
