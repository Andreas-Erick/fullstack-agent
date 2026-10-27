// Agent tools: The skill tree (skilltree.js, Skill Tree.md in the vault).
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const { arr, obj, str } = require('./common');

module.exports = [
  {
    name: 'skilltree_view',
    group: 'skilltree',
    description: 'The user\'s skill tree (Skill Tree.md): every skill they are growing with its progress (from the learning tracker, flashcard and vocabulary decks, and habits), state (locked, ready, growing, mastered), prerequisites and what blocks it, plus what is ready to work on next.',
    parameters: obj({}),
    run: async () => require('../skilltree').summary(),
  },
  {
    name: 'skilltree_update',
    group: 'skilltree',
    description:
      'Add skills to the user\'s skill tree or change them. When they set a goal or start learning something, offer to map it: the skill, the 2–5 skills it builds on (needs), and where its progress comes from (from: a learning-tracker topic, a flashcard or vocabulary deck, or a habit, by their exact names). Link a flashcard deck the user studies to the skill it trains (type deck, the deck’s name): its cards maturing in reviews then grow that skill. Use manual (0–1) only for what they already know from before. Fields you leave out stay as they are.',
    parameters: obj(
      {
        skills: {
          type: 'array',
          description: 'Skills to add or change',
          items: {
            type: 'object',
            properties: {
              name: str('e.g. "Real Analysis", "Spanish B1", "Running a 10k", "Deep work"'),
              description: str('One short line'),
              area: str('A branch, e.g. Math, Languages, Body, Mind, Craft'),
              needs: arr('Names of the skills this builds on'),
              from: { type: 'array', description: 'Where progress comes from', items: { type: 'object', properties: { type: { type: 'string', enum: ['learning', 'deck', 'habit'] }, name: str('The learning topic, the deck name (a flashcard deck or a language) or the habit name'), target: { type: 'number', description: 'Optional: concepts understood (learning, default 12) or mature cards (deck, default: the deck size, at most 300) for 100%' } }, required: ['type', 'name'], additionalProperties: false } },
              manual: { type: 'number', description: 'Optional 0–1: how far along they already are, from before tracking' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      ['skills'],
    ),
    run: async (a, ctx) => {
      const r = await require('../skilltree').upsert(a.skills || []);
      ctx.emit({ type: 'skilltree_changed' });
      return r;
    },
  },
  {
    name: 'skilltree_remove',
    group: 'skilltree',
    description: 'Remove a skill from the tree (skills that needed it lose that prerequisite).',
    parameters: obj({ name: str('The skill') }, ['name']),
    run: async (a, ctx) => {
      const r = await require('../skilltree').remove(a.name);
      ctx.emit({ type: 'skilltree_changed' });
      return r;
    },
  },
];
