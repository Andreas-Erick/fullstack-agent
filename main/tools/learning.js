// Agent tools: Learning: the understanding tracker, vocabulary decks, language practice.
// Registered in ../tools.js (TOOLS), which also filters them by group (activeTools).
const store = require('../store');
const { arr, obj, str, requireApproval } = require('./common');

module.exports = [
  {
    name: 'learning_update',
    group: 'learning',
    description:
      'Keep the user\'s understanding tracker for a topic (Learning/<Topic>.md in the vault) current while you teach or study with them. Record what they now genuinely understand (in their words when they explained it back), what is still shaky, misconceptions they had (with the correction), open questions, and a one-line log of the session. resolved moves concepts from shaky / open questions to understood. Use it without being asked at natural points (after an explanation lands, after an exercise, at the end of a study session); it is how you follow up next time.',
    parameters: obj(
      {
        topic: str('The subject, e.g. "Real Analysis", "Linear Algebra", "Rust ownership", "Spanish"'),
        understood: arr('Concepts they now understand, e.g. "Epsilon-delta limits — δ is how close x must be to keep f(x) within ε"'),
        shaky: arr('Concepts that are not solid yet'),
        misconceptions: arr('Wrong ideas they had, with the correction, e.g. "Thought every continuous function is differentiable → |x| at 0"'),
        questions: arr('Open questions to come back to'),
        resolved: arr('Shaky concepts or open questions that are now clear'),
        log: str('One line: what this session covered'),
      },
      ['topic'],
    ),
    run: async (a, ctx) => {
      const r = await require('../learning').update(a.topic, a);
      ctx.emit({ type: 'vault_changed', path: r.path });
      return r;
    },
  },
  {
    name: 'learning_overview',
    group: 'learning',
    description: 'The user\'s learning topics (most recent first) with what is shaky and still open, and their vocabulary decks with cards due. With a topic: that topic\'s full tracker note. Use it before a study session or when they ask how they are doing.',
    parameters: obj({ topic: str('Optional: one topic for its full note') }),
    run: async (a) => {
      const learning = require('../learning');
      if (a.topic) {
        const t = await learning.readTopic(a.topic);
        if (!t.exists) return { topic: a.topic, note: 'No tracker for this topic yet; learning_update creates it.' };
        return { path: t.rel, ...t.note };
      }
      const [topics, decks] = await Promise.all([learning.topics(), learning.deckSummaries()]);
      return { topics: topics.map(({ modified, line, ...t }) => ({ ...t, updated: new Date(modified).toISOString().slice(0, 10) })), decks };
    },
  },
  {
    name: 'vocab_add',
    group: 'learning',
    description:
      'Add words or phrases to the user\'s spaced-repetition deck for a language (Languages/<Language>.md). Add what they actually met or need (from a conversation, a text, a mistake), with a short meaning and, ideally, an example sentence in the target language. Phrases and collocations beat single words. Existing cards are not duplicated.',
    parameters: obj(
      {
        language: str('e.g. "Spanish", "Japanese"'),
        cards: { type: 'array', description: 'Cards to add', items: { type: 'object', properties: { front: str('The word or phrase in the target language'), back: str('Meaning in the user\'s language (short)'), example: str('An example sentence in the target language') }, required: ['front', 'back'], additionalProperties: false } },
      },
      ['language', 'cards'],
    ),
    run: async (a, ctx) => {
      const r = await require('../learning').addCards(a.language, a.cards || []);
      ctx.emit({ type: 'vault_changed', path: r.path });
      return r;
    },
  },
  {
    name: 'vocab_review',
    group: 'learning',
    description:
      'The cards to review now in a language deck: due ones first, then a few new ones. Quiz the user one card at a time (ask for the target-language word from the meaning, or use it in a sentence: production beats recognition), let them answer, then grade each card with vocab_grade.',
    parameters: obj({ language: str('e.g. "Spanish"'), limit: { type: 'number', description: 'How many cards (default 10)' } }, ['language']),
    run: async (a) => require('../learning').due(a.language, { limit: Math.max(1, Math.min(50, Number(a.limit) || 10)) }),
  },
  {
    name: 'vocab_grade',
    group: 'learning',
    description: 'Grade one reviewed card, which schedules its next review: again (didn\'t know it; comes back today), hard (got it with effort), good (knew it), easy (instant).',
    parameters: obj({ language: str('e.g. "Spanish"'), front: str('The card\'s front exactly as vocab_review gave it'), grade: { type: 'string', enum: ['again', 'hard', 'good', 'easy'], description: 'How well they knew it' } }, ['language', 'front', 'grade']),
    run: async (a) => require('../learning').gradeCard(a.language, a.front, a.grade),
  },
  {
    name: 'language_practice',
    group: 'practice',
    description:
      'Start or end a speaking practice in a language when the user asks ("let\'s practice Spanish", "stop practice"). While it is on, speech recognition listens for that language and your replies are spoken by a voice for it, so reply in that language at their level. language: an ISO code like es, fr, de, it, pt, ja, zh, ko, ru, nl, or "off".',
    parameters: obj({ language: str('ISO 639-1 code (es, fr, de, ja…) or "off"') }, ['language']),
    run: async (a, ctx) => {
      const code = String(a.language || '').trim().toLowerCase();
      if (code !== 'off' && !/^[a-z]{2,3}(-[a-z]{2})?$/.test(code)) throw new Error('Use an ISO language code like "es" or "ja", or "off".');
      if (ctx.turn?.tainted) await requireApproval(ctx, 'settings', code === 'off' ? 'End language practice' : `Start language practice (${code})`, 'Asked after reading external content.');
      await store.setSettings({ learning: { practiceLanguage: code === 'off' ? '' : code } });
      ctx.emit({ type: 'settings_changed' });
      return code === 'off' ? { practice: 'off' } : { practice: code, note: 'Speech recognition and your voice switch to this language from your next reply.' };
    },
  },
];
