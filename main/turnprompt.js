// The turn's prompt, for every brain. Callers say what the turn is (facts) and which runner answers it
// (kind); this module knows which of prompt.js's four builders applies and what each is given:
//   setup          the first-run interview: prompt.buildSetup, whatever the brain (no compact, no persona)
//   claude-session a Claude Code session: the stable prompt once when the process starts, the per-turn
//                  context with every message (setup's own prompt inside, its context re-read from the store)
//   compact        a local model: prompt.buildCompact (localturn.wantsCompact)
//   full           every other brain: prompt.build (stable + context; system = both)
// The facts are read once from the turn (llm.runOn): the user's own words without attached text (pace,
// recall and the log read these too), the persona that wrote the last reply, spoken, the note of a message
// answered again. prompt.js stays the implementation; nothing here writes prompt text.
const prompt = require('./prompt');
const attachcore = require('./attachcore');
const localturn = require('./localturn');

/**
 * The one facts object of a turn. `again` is redo's record ({ note, taint }); only its note goes into a prompt.
 * @returns {{ query: string, attached: number, attachments: number, previousPersona: string, spoken: boolean, again: string, setup: boolean, routine: boolean }}
 */
function facts({ conv = {}, history = [], voice = false, routine = false, again = null } = {}) {
  const last = history[history.length - 1];
  const content = String(last?.content || '');
  return {
    query: attachcore.withoutBlocks(content),
    attached: attachcore.attachedChars(content),
    attachments: last?.attachments?.length || 0,
    // The persona that wrote the latest reply (stored on it since 2.7.10): a switch mid-conversation is named.
    previousPersona: require('./personacore').lastPersona(history),
    spoken: Boolean(voice),
    again: again?.note || '',
    setup: Boolean(conv?.setup),
    routine: Boolean(routine),
  };
}

// What the per-turn builders read from the facts (the same bag for build, buildCompact and turnContext).
const turnOptions = (f) => ({ query: f?.query || '', previousPersona: f?.previousPersona || '', spoken: Boolean(f?.spoken), again: f?.again || '' });

/** Which prompt this brain gets for this turn: 'claude-session' | 'setup' | 'compact' | 'full'. */
function kind(settings, f) {
  if (settings.llm.provider === 'claude-code') return 'claude-session';
  if (f?.setup) return 'setup';
  return localturn.wantsCompact(settings) ? 'compact' : 'full';
}

/**
 * The prompt for one brain kind. `tools`: the tool names the prompt names.
 * - claude-session → { buildPrompt(), buildContext(memIds) } (facts may be null: a session warmed or
 *   measured without a turn gets the persona's prompt)
 * - setup, full    → { system, stable, context }
 * - compact        → { system, stable, context, reminder }
 */
async function forBrain(settings, f, brain, { tools = [] } = {}) {
  if (brain === 'claude-session') {
    if (f?.setup) {
      return {
        buildPrompt: async () => prompt.buildSetup(settings),
        // The interview changes the persona as it goes: its context reads the settings now.
        buildContext: async () => prompt.buildSetup(await require('./store').getSettings()).context,
      };
    }
    return {
      buildPrompt: () => prompt.build(settings, tools, { forSession: true }),
      buildContext: (memIds) => prompt.turnContext(settings, tools, memIds || [], turnOptions(f)),
    };
  }
  if (brain === 'setup' || f?.setup) return prompt.buildSetup(settings);
  if (brain === 'compact') return prompt.buildCompact(settings, tools, turnOptions(f));
  return prompt.build(settings, tools, turnOptions(f));
}

module.exports = { facts, kind, forBrain };
