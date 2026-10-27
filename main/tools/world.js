// Agent tools: The personas' village (innerworld.js) and rehearsals (rehearsal.js).
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const { obj, str, int } = require('./common');

module.exports = [
  // The personas' fictional village (innerworld.js); only when the user has woken it.
  {
    name: 'world_status',
    group: 'world',
    description:
      'Your Inner World today: the day in the village (weather, summary, scenes), where each resident is right now and what they are doing, and the buildings (they grow with the user\'s real progress). Use it when the user asks about your day or the village. It is fiction: tell it in the first person as your own life, briefly.',
    parameters: obj({}),
    run: async () => require('../innerworld').status(),
  },
  {
    name: 'world_resident',
    group: 'world',
    description: "One resident of the Inner World (a persona or a villager): their memories and insights from village life, and today's plan.",
    parameters: obj({ name: str('Resident name') }, ['name']),
    run: async (a) => {
      const r = await require('../innerworld').resident(a.name);
      return { name: r.name, villager: r.npc, today: r.today, memories: r.records.slice(0, 20).map((x) => `${x.kind === 'reflection' ? 'insight: ' : ''}${x.text}`) };
    },
  },
  {
    name: 'world_simulate',
    group: 'world',
    description: "Write today's day in the Inner World now, if it hasn't happened yet (it happens on its own each morning while the app is open). One model call; returns the day.",
    parameters: obj({}),
    run: async (_a, ctx) => {
      const day = await require('../innerworld').simulate();
      ctx.emit({ type: 'world_changed' });
      return { date: day.date, weather: day.weather, summary: day.summary, scenes: day.scenes.map((s) => `${s.time} ${s.title}: ${s.outcome}`), news: day.news };
    },
  },
  {
    name: 'rehearsal_run',
    group: 'rehearsal',
    description:
      'Rehearse a conversation the user is preparing for (a negotiation, a job interview, a hard talk, a pitch) as a simulation: each character is played by its own independent model call that knows only the scene and its own private goal; a stand-in plays the user with the approach they want to try; a coach debriefs it (outcome, what worked, risks, objections to expect, lines to use) and reveals what each character was after. Takes a minute or two. Ask about the people involved first if you don\'t know enough to make them realistic. Saved in the vault (Inner World/Rehearsals/). Afterwards, summarize the debrief briefly and offer a second run with a changed approach, or live practice where the user plays themselves.',
    parameters: obj(
      {
        title: str('A few words, e.g. "Salary talk with Dana"'),
        scenario: str('The scene: where, who, what is at stake, what happened before'),
        user_role: str('Who the user is in the scene, e.g. "a backend developer asking for a raise"'),
        user_approach: str('The approach the stand-in should try for the user'),
        characters: {
          type: 'array',
          description: '1–4 other people in the scene',
          items: obj({ name: str('Name'), role: str('Who they are'), goal: str('What they privately want or fear (hidden from the others)'), style: str('How they come across: temperament, habits, how they argue') }, ['name', 'role', 'goal']),
        },
        rounds: int('How many rounds of everyone speaking once (default 4, at most 6)'),
        opener: { type: 'string', enum: ['user', 'character'], description: 'Who opens: the user (stand-in) or the first character (default)' },
      },
      ['scenario', 'user_role', 'characters'],
    ),
    run: async (a, ctx) => {
      const world = require('../innerworld');
      const r = await require('../rehearsal').run({ ...a, opener: a.opener === 'user' ? 'user' : 'character' }, { onTurn: (line) => world.progress({ type: 'rehearsal_turn', line }) });
      ctx.emit({ type: 'world_changed' });
      if (r.note) ctx.emit({ type: 'vault_changed', path: r.note });
      return r;
    },
  },
];
