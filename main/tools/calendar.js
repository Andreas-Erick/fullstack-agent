// Agent tools: The user's schedule in the vault (Schedule.md, calendar.js).
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const calendar = require('../calendar');
const schedule = require('../schedulecore');
const { obj, str, requireApproval } = require('./common');

module.exports = [
  // The user's schedule in the vault (Schedule.md). Adding and changing follow what the user said, like
  // vault notes; removing an entry asks according to the permission mode.
  {
    name: 'calendar_get_events',
    group: 'calendar',
    description:
      "The user's schedule for a date range: every occurrence of their repeating entries and single events, with entry ids. Today and the next days are already in your context; use this for other dates.",
    parameters: obj({ start: str('First day, YYYY-MM-DD'), end: str('Day after the last one, YYYY-MM-DD') }, ['start', 'end']),
    run: async ({ start, end }) => {
      const list = await calendar.events({ start: `${start}T00:00:00`, end: `${end}T00:00:00` });
      return { count: list.length, events: list.map((e) => `${calendar.fmtEvent(e)} (entry_id ${e.entryId})`).join('\n') || 'Nothing scheduled.' };
    },
  },
  {
    name: 'calendar_list_entries',
    group: 'calendar',
    description: "Every entry in the user's schedule: repeating rules (lectures, shifts, routines) and single events, with ids, plus lines in Schedule.md that couldn't be read. Use it to find an entry_id or to review the rules.",
    parameters: obj({ query: str('Only entries whose title, place or notes contain this (optional)') }),
    run: async ({ query }) => {
      const { entries, problems } = await calendar.entries();
      const q = String(query || '').toLowerCase();
      const shown = q ? entries.filter((e) => `${e.title} ${e.location} ${e.notes}`.toLowerCase().includes(q)) : entries;
      return {
        entries: shown.map((e) => `- ${e.description}: ${e.title}${e.location ? ` @ ${e.location}` : ''}${e.notes ? ` (${e.notes})` : ''} [entry_id ${e.id}; when "${e.when}"]`).join('\n') || 'No entries.',
        ...(problems.length ? { unreadableLines: problems.map((p) => `line ${p.line}: "${p.text}" (${p.error})`) } : {}),
      };
    },
  },
  {
    name: 'calendar_add_event',
    group: 'calendar',
    description: `Add to the user's schedule (Schedule.md in the vault) when they tell you about an appointment or something that repeats ("I have Linear Algebra every Monday at 10 in H1"). when: ${schedule.WHEN_HELP} Work out real dates yourself ("next Friday" → its date). For a rule that only runs for a while (a semester), set from/until. Read back the day and time in plain words when the user said it loosely.`,
    parameters: obj(
      {
        title: str('What it is, e.g. "Linear Algebra lecture"'),
        when: str('A date with optional times, or a repeat rule (see the description)'),
        location: str('Where (optional)'),
        notes: str('Anything else worth keeping (optional)'),
        from: str('Repeating only: first day it applies, YYYY-MM-DD (optional)'),
        until: str('Repeating only: last day it applies, YYYY-MM-DD (optional)'),
      },
      ['title', 'when'],
    ),
    run: async (a, ctx) => {
      const e = await calendar.add(a);
      ctx.emit({ type: 'calendar_changed' });
      return { added: `${e.description}: ${e.title}${e.location ? ` @ ${e.location}` : ''}`, entry_id: e.id };
    },
  },
  {
    name: 'calendar_update_event',
    group: 'calendar',
    description: 'Change a schedule entry (entry_id from calendar_get_events or calendar_list_entries). Pass only what changes; an empty string clears location, notes, from or until. Changing a repeating entry changes every occurrence; to drop a single day of it use calendar_delete_event with only_date.',
    parameters: obj(
      {
        entry_id: str('Entry id'),
        title: str('New title'),
        when: str(`New date/time or repeat rule. ${schedule.WHEN_HELP}`),
        location: str('New place'),
        notes: str('New notes'),
        from: str('Repeating only: first day, YYYY-MM-DD'),
        until: str('Repeating only: last day, YYYY-MM-DD'),
      },
      ['entry_id'],
    ),
    run: async ({ entry_id: id, ...patch }, ctx) => {
      const r = await calendar.update(id, patch);
      ctx.emit({ type: 'calendar_changed' });
      return { before: `${r.before.description}: ${r.before.title}`, after: `${r.after.description}: ${r.after.title}${r.after.location ? ` @ ${r.after.location}` : ''}` };
    },
  },
  {
    name: 'calendar_delete_event',
    group: 'calendar',
    description: 'Remove a schedule entry (entry_id from calendar_get_events or calendar_list_entries). For a repeating entry, only_date skips just that day (e.g. a cancelled lecture) and keeps the rest.',
    parameters: obj({ entry_id: str('Entry id'), only_date: str('Repeating only: the one day to skip, YYYY-MM-DD') }, ['entry_id']),
    run: async (a, ctx) => {
      if (!a.only_date) {
        const old = (await calendar.entries()).entries.find((e) => e.id === a.entry_id);
        if (old) await requireApproval(ctx, 'delete', `Remove "${old.title}" from your schedule`, `${old.description}${old.location ? `\nWhere: ${old.location}` : ''}`);
      }
      const r = await calendar.remove(a.entry_id, { onlyDate: a.only_date });
      ctx.emit({ type: 'calendar_changed' });
      return r.skipped ? { skipped: r.skipped, stillRepeats: r.entry.description } : { deleted: `${r.deleted.description}: ${r.deleted.title}` };
    },
  },
];
