// Agent tools: Long-term memory facts (memory.js): what is true about the user.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const memory = require('../memory');
const { obj, str } = require('./common');

module.exports = [
  {
    name: 'memory_save',
    group: 'memory',
    description:
      'Save a new long-term memory about the user or the world (preferences, facts, people, projects, decisions). Save proactively whenever the user shares something worth remembering. Keep each memory atomic and self-contained.',
    parameters: obj(
      {
        title: str('Short title, e.g. "Prefers dark roast coffee"'),
        content: str('The full memory text'),
        category: str('Category such as preference, person, project, fact, task, health, work'),
      },
      ['title', 'content'],
    ),
    run: async (a, ctx) => {
      const e = await memory.save(a);
      ctx.emit({ type: 'memory_changed' });
      return { saved: true, id: e.id, title: e.title };
    },
  },
  {
    name: 'memory_update',
    group: 'memory',
    description: 'Update an existing memory by id (ids are listed in the Memory vault section of the system prompt). Use when information changes.',
    parameters: obj({ id: str('Memory id'), title: str('New title (optional)'), content: str('New full content (optional)'), category: str('New category (optional)') }, ['id']),
    run: async (a, ctx) => {
      const e = await memory.update(a.id, a);
      ctx.emit({ type: 'memory_changed' });
      return { updated: true, id: e.id, title: e.title };
    },
  },
  {
    name: 'memory_delete',
    group: 'memory',
    description: 'Delete a memory by id when it is wrong, obsolete, or the user asks you to forget it.',
    parameters: obj({ id: str('Memory id') }, ['id']),
    run: async (a, ctx) => {
      const r = await memory.remove(a.id);
      ctx.emit({ type: 'memory_changed' });
      return r;
    },
  },
  {
    name: 'memory_search',
    group: 'memory',
    description: 'Search the memory vault by keywords. All memories are already in your system prompt; use this only to double-check.',
    parameters: obj({ query: str('Keywords') }, ['query']),
    run: async (a) => (await memory.search(a.query)).slice(0, 20).map((e) => ({ id: e.id, title: e.title, category: e.category, content: e.content })),
  },
];
