// Agent tools: More tools on request, for a local model with the compact prompt (../localcore.js
// TOOLBOX). Never offered with the full prompt, which already has every tool (tools.js activeTools).
// Registered in ../tools.js (TOOLS).
const { TOOLBOX } = require('../localcore');

module.exports = [
  {
    name: 'tools_more',
    group: 'toolbox',
    description: `Get more tools for this conversation when the ones you have can't do what the user asked. Groups: ${Object.keys(TOOLBOX).join(', ')} (learning = flashcards, vocabulary and the understanding tracker; habits = habits and the skill tree; documents = PDFs, diagrams, charts, windows; looks = persona and theme; notes = the whole vault). The new tools can be used right after this call. Ask for one group at a time.`,
    parameters: { type: 'object', properties: { group: { type: 'string', enum: Object.keys(TOOLBOX), description: 'Which group' } }, required: ['group'], additionalProperties: false },
    run: async (a, ctx) => {
      if (!ctx.toolset) return { note: 'You already have every tool.' };
      const added = ctx.toolset.add(a.group);
      return added.length ? { added } : { note: `No new tools: the ${a.group} tools are already loaded, or turned off in Settings.` };
    },
  },
];
