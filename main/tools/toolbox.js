// Agent tools for a local model with the compact prompt: more tools on request (../localcore.js
// TOOLBOX) and handing a message over to Claude. Never offered with the full prompt, which already has
// every tool and is the stronger brain itself (tools.js activeTools). What they do is the local turn's
// (../localturn.js begin, on the tool context as ctx.localTurn). Registered in ../tools.js (TOOLS).
const { TOOLBOX } = require('../localcore');

module.exports = [
  {
    name: 'tools_more',
    group: 'toolbox',
    description: `Get more tools for this conversation when the ones you have can't do what the user asked. Groups: ${Object.keys(TOOLBOX).join(', ')} (learning = vocabulary decks and the understanding tracker; documents = PDFs, diagrams, charts, windows; looks = persona and theme; notes = the whole vault). The new tools can be used right after this call. Ask for one group at a time.`,
    parameters: { type: 'object', properties: { group: { type: 'string', enum: Object.keys(TOOLBOX), description: 'Which group' } }, required: ['group'], additionalProperties: false },
    run: async (a, ctx) => (ctx.localTurn ? ctx.localTurn.loadGroup(a.group) : { note: 'You already have every tool.' }),
  },
  {
    // Offered only when the user turned on the hand-over and a Claude brain is ready (localturn.handOverPlan).
    name: 'hand_over',
    group: 'toolbox',
    description:
      'Hand this message to the stronger brain (Claude), which then answers the user instead of you. Use it when the task needs several steps or careful reasoning, a long or polished text, code, a service you have no tool for, or when you are not sure you can do it right. Call it before doing anything else, and write nothing after it. Not for small talk, lookups or simple commands you can do yourself.',
    parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Why, in a few words (shown to the user)' } }, required: ['reason'], additionalProperties: false },
    // Refused once the turn changed something: the other brain would do it a second time.
    run: async (a, ctx) => (ctx.localTurn ? ctx.localTurn.requestHandOver(a.reason) : { note: 'No stronger brain is set up: answer yourself.' }),
  },
];
