// Agent tools for a local model with the compact prompt: more tools on request (../localcore.js
// TOOLBOX) and handing a message over to Claude (llm.js runTurn). Never offered with the full prompt,
// which already has every tool and is the stronger brain itself (tools.js activeTools).
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
  {
    // Offered only when the user turned on the hand-over and a Claude brain is ready (llm.js runOn).
    name: 'hand_over',
    group: 'toolbox',
    description:
      'Hand this message to the stronger brain (Claude), which then answers the user instead of you. Use it when the task needs several steps or careful reasoning, a long or polished text, code, a service you have no tool for, or when you are not sure you can do it right. Call it before doing anything else, and write nothing after it. Not for small talk, lookups or simple commands you can do yourself.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Why, in a few words (shown to the user)' } }, required: ['reason'], additionalProperties: false },
    run: async (a, ctx) => {
      if (!ctx.handOver) return { note: 'No stronger brain is set up: answer yourself.' };
      // Something this turn already changed would be done a second time by the other brain.
      if (ctx.wrote) return { note: 'You already changed something in this turn, so finish it yourself.' };
      ctx.handOver.requested = String(a.reason || 'a harder task').slice(0, 120);
      return { handedOver: true, note: 'Stop now and write nothing more: the stronger brain answers the user.' };
    },
  },
];
