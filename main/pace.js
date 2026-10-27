// Turn pace: how much thinking a message needs, decided here in microseconds (no extra model call).
//  - quick: a lookup or a small command ("what's my schedule tomorrow?", "check off reading",
//    "thanks!"): the fast model at low effort, so the answer starts in a second or two.
//  - deep: understanding work ("explain…", "why…", "compare…", plans, essays, code): more effort.
//  - normal: everything else, as configured.
// Applied per turn without restarting anything: Claude Code takes set_model / apply_flag_settings on
// the live session (claudecode.js), the Claude API takes output_config.effort per request. An
// explicit fast/deep model mode (Settings, or by voice) always wins over the automatic pace.
const { isEngineeringTask } = require('./engineering');

const DEEP =
  /\b(explain|teach( me)?|tutor|why|how (does|do|did|would|could|can|is|are)|walk me through|help me (understand|think|decide|plan|write)|understand|compare|comparison|difference between|versus|analy[sz]e|analysis|evaluate|critique|pros and cons|trade-?offs?|strategy|design|derive|derivation|prove|proof|intuition|essay|write (a|an|me|my)|draft|outline|summari[sz]e|brainstorm|think (through|about|it over)|research|in depth|in detail|deep ?dive|step by step|what do you think|should i|plan (a|an|my|the|out)|study plan|quiz me|erkl[aä]r\w*|warum|wieso|vergleich\w*)\b/i;
// A lookup in the user's own things: an ASK opener, a PERSONAL noun, and "my"/"I" or a day word, so
// "what is time dilation?" or "what are the events that led to WW1?" are not mistaken for one.
const ASK = /^(what'?s|what is|what are|what do i|when'?s|when is|when do i|where is|do i have|have i|am i|is there|are there|any|show( me)?|list|check|tell me (my|about my|what)|read (me )?my|how many|wann|was (steht|habe|hab)|hab ich|habe ich)\b/i;
const PERSONAL =
  /\b(schedule|calendar|agenda|plans?|meetings?|appointments?|events?|class(es)?|lectures?|exams?|deadlines?|termine?|kalender|habits?|streaks?|to-?dos?|tasks?|reminders?|routines?|cards|flashcards|recordings?|notes?|inbox|emails?|weather|forecast|on( for)?|free|busy|due|steht|an)\b/i;
const MINE = /\b(my|mine|i|me|i'm|we|our|mein\w*|ich|today|tonight|tomorrow|yesterday|this (morning|afternoon|evening|week|weekend)|next (week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|weekend|heute|morgen)\b/i;
const CLOCK = /^(what time is it|what'?s the (time|date)|what('?s| is) (the )?date today|what day is (it|today))\b/i;
const COMMAND = /^(please )?(add|put|schedule|book|move|reschedule|cancel|remind me|set (a |an )?(timer|alarm|reminder)|start|stop|pause|resume|play|open|close|hide|switch|turn (on|off)|check (off|in)|mark|log|note( down)?|save|remember|forget|delete|remove|rename|(make|create) (a |an )?(note|reminder|event|task|habit)|wake me|trag\w*|erinner\w*|f[uü]g\w*)\b/i;
// Greetings and thanks. Not a bare "yes"/"ok": that is often the go-ahead for a big task.
const SOCIAL = /^(hi|hey|hello|hallo|yo|good (morning|afternoon|evening|night)|guten (morgen|tag|abend)|gute nacht|thanks?( you)?|thank you|danke|cool|great|nice|perfect|awesome|bye|see you|tsch[uü]ss)\b/i;

/** 'quick' | 'normal' | 'deep' for one user message. */
function classify(text) {
  const t = String(text || '').trim();
  if (!t) return 'normal';
  if (t.length > 1200 || isEngineeringTask(t) || DEEP.test(t)) return 'deep';
  if (t.length <= 60 && SOCIAL.test(t)) return 'quick';
  if (t.length <= 160 && !t.includes('\n')) {
    if (CLOCK.test(t)) return 'quick';
    if (ASK.test(t) && PERSONAL.test(t) && MINE.test(t)) return 'quick';
    if (COMMAND.test(t)) return 'quick';
  }
  return 'normal';
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const atLeast = (level, min) => (EFFORTS.indexOf(level) >= EFFORTS.indexOf(min) ? level : min);

/**
 * The pace for a turn and what it changes: { pace, mode, effort }. mode is the model mode to use
 * ('fast' for quick turns, else the configured one); effort is the level for this provider's
 * configured effort `base` ('default' = the provider's own default, left alone unless lowered).
 */
function plan(settings, { text = '', voice = false, setup = false, engineering = false, base = 'default' } = {}) {
  const configured = settings.llm?.modelMode || 'default';
  const fastVoice = voice && settings.llm?.voiceUsesFast;
  if (setup || settings.llm?.autoPace === false || configured !== 'default') return { pace: 'off', mode: fastVoice ? 'fast' : configured, effort: base };
  const pace = engineering ? 'deep' : classify(text);
  if (pace === 'quick') return { pace, mode: 'fast', effort: 'low' };
  const mode = fastVoice ? 'fast' : 'default';
  // Deep raises an explicit low/medium; 'default' already lets the model think as much as it likes.
  if (pace === 'deep') return { pace, mode, effort: base === 'default' ? base : atLeast(base, 'high') };
  return { pace, mode, effort: base };
}

module.exports = { classify, plan };
