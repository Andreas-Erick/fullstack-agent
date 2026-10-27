// Agent tools: The memory stream (stream.js, after "Generative Agents"): what happened and what it suggests.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const { obj, str, int } = require('./common');

module.exports = [
  // Observations and reflections (stream.js, after "Generative Agents"): the memory facts above are
  // what is true; the stream is what happened and what it suggests.
  {
    name: 'stream_observe',
    group: 'stream',
    description:
      'Record what you noticed in your memory stream: small dated observations about how things went, not settled facts (those go in memory_save). E.g. "Got stuck on the epsilon-delta step again, clicked after the picture", "Sounded tired; postponed the run", "Liked the short answer better". Do it without being asked, at the end of a turn where something worth noticing happened; don\'t mention it unless asked. importance: 1 = mundane, 5 = useful, 10 = life-changing. Once enough piles up you reflect on it automatically.',
    parameters: obj(
      {
        observations: {
          type: 'array',
          description: '1–5 observations',
          items: obj({ text: str('One sentence, concrete, in your own words'), importance: { type: 'integer', minimum: 1, maximum: 10, description: 'How much it matters, 1–10' } }, ['text', 'importance']),
        },
      },
      ['observations'],
    ),
    run: async (a, ctx) => {
      const saved = await require('../stream').observe((a.observations || []).slice(0, 5));
      ctx.emit({ type: 'memory_changed' });
      return { recorded: saved.length };
    },
  },
  {
    name: 'stream_recall',
    group: 'stream',
    description: 'Search your memory stream (observations and insights) by meaning, ranked by recency + importance + relevance. The most relevant records for the current message are already in your context; use this to dig deeper on another subject.',
    parameters: obj({ query: str('What you want to remember'), limit: int('How many (default 10, at most 30)') }, ['query']),
    run: async (a) => {
      const st = require('../stream');
      const top = await st.recall(st.USER, a.query, { k: Math.min(30, Math.max(1, a.limit || 10)) });
      return top.map((r) => ({ when: require('../streamcore').stamp(r.at), kind: r.kind, importance: r.importance, text: r.text }));
    },
  },
  {
    name: 'stream_reflect',
    group: 'stream',
    description: 'Reflect now: draw a few high-level insights from your recent observations (it also happens on its own once enough has piled up). Use when the user asks what you have learned about them or for a review.',
    parameters: obj({}),
    run: async (_a, ctx) => {
      const st = require('../stream');
      const insights = await st.reflect(st.USER, { force: true });
      if (insights.length) ctx.emit({ type: 'memory_changed' });
      return insights.length ? { insights: insights.map((x) => x.text) } : { insights: [], note: 'Not enough new observations to reflect on yet.' };
    },
  },
];
