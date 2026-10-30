// Local brains (Ollama, LM Studio): reading what they list, how big a model is, which ones suit this
// computer, and when a model is small enough to get the compact prompt (prompt.buildCompact). Pure.
//
// Why a compact prompt: a 3–8B model follows a short, plain prompt far better than the full one
// (thousands of tokens of capabilities and dozens of tool schemas fill its context and blur what
// matters). What works for small models: the role first, a few numbered rules in plain words, the most
// important rule repeated at the end, one example of the answer's shape, and few tools.

const SERVERS = [
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', list: 'http://localhost:11434/api/tags' },
  { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', list: 'http://localhost:1234/v1/models' },
];

const SMALL_B = 14; // up to this many billion parameters a model gets the compact prompt (auto)

/** Billions of parameters from Ollama's details ("8.0B", "3.2B", "567M") or the name ("qwen3:4b", "phi-3-mini-4k"). */
function paramsOf(name, details = {}) {
  const fromSize = /^([\d.]+)\s*([BM])$/i.exec(String(details.parameter_size || '').trim());
  if (fromSize) return Number(fromSize[1]) / (fromSize[2].toUpperCase() === 'M' ? 1000 : 1);
  const m = /(?:^|[:\-_/ ])(\d+(?:\.\d+)?)\s*b(?:$|[\-_:. ])/i.exec(String(name || ''));
  if (m) return Number(m[1]);
  if (/\b(mini|tiny|small|nano)\b|phi-?\d/i.test(String(name || ''))) return 4;
  return null;
}

const isSmall = (name, details) => {
  const b = paramsOf(name, details);
  return b !== null && b <= SMALL_B;
};

/** Ollama's /api/tags → [{ id, name, params, bytes }]. */
function parseOllama(json) {
  return (Array.isArray(json?.models) ? json.models : [])
    .filter((m) => m && typeof m.name === 'string' && !/embed/i.test(m.name))
    .map((m) => ({ id: m.name, name: m.name, params: paramsOf(m.name, m.details), bytes: Number(m.size) || 0 }));
}

/** An OpenAI-style /v1/models (LM Studio) → the same shape. */
function parseOpenAIModels(json) {
  return (Array.isArray(json?.data) ? json.data : [])
    .filter((m) => m && typeof m.id === 'string' && !/embed/i.test(m.id))
    .map((m) => ({ id: m.id, name: m.id, params: paramsOf(m.id), bytes: 0 }));
}

// Small models that use tools well, by the memory they need (GB, at the usual 4-bit quantization).
const SUGGESTED = [
  { model: 'qwen3:4b', needGb: 4, why: 'Fast and good with tools for its size.' },
  { model: 'llama3.2:3b', needGb: 3, why: 'The quickest option; fine for short chats and lookups.' },
  { model: 'qwen3:8b', needGb: 7, why: 'Noticeably smarter, still quick on a mid-range graphics card.' },
  { model: 'gemma3:12b', needGb: 10, why: 'Strong answers when there is memory to spare.' },
  { model: 'qwen3:14b', needGb: 12, why: 'The largest that still counts as "small" here.' },
];

/** Suggestions for this computer: what fits in the graphics memory (or a third of the RAM without one). */
function suggest({ vramGb = 0, ramGb = 0 } = {}) {
  const room = vramGb > 0 ? vramGb : ramGb / 3;
  const fits = SUGGESTED.filter((s) => s.needGb <= room);
  return (fits.length ? fits : SUGGESTED.slice(0, 2)).sort((a, b) => b.needGb - a.needGb).slice(0, 3);
}

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

const isLocal = (settings) => settings?.llm?.via === 'local' || LOCAL_URL.test(String(settings?.llm?.baseUrl || ''));

/**
 * Does this turn get the compact prompt? llm.compactPrompt: 'on' | 'off' | 'auto' (every local model).
 * Not only small ones: every tool's description alone is ~25k tokens, which a local model re-reads on
 * each message (seconds to tens of seconds) and which overflows Ollama's usual 4–32k window, cutting off
 * the start of the prompt (the time, the persona). Measured with a 27B model: 32 s to the first word.
 */
function compactWanted(settings) {
  const mode = settings?.llm?.compactPrompt || 'auto';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return isLocal(settings);
}

/**
 * Extra request fields for a local server: the model stays loaded for 30 minutes (Ollama unloads it
 * after 5, and reloading a big one takes seconds), and no hidden thinking before the answer unless the
 * message needs it (pace 'deep'): a 27B thinking model spent 8 s thinking before a five-word reply,
 * 0.5 s without. Servers that don't know a field ignore it; llm.js retries without them on a 400.
 */
function requestExtras(settings, pace) {
  if (!isLocal(settings)) return {};
  return { keep_alive: '30m', ...(pace === 'deep' ? {} : { reasoning_effort: 'none' }) };
}

// The tools a small model gets: the everyday ones, each easy to call right. (A model this size
// calling a tool wrongly is worse than not having it; the user can switch to the full prompt.)
const COMPACT_TOOLS = [
  'memory_save', 'memory_search', 'calendar_get_events', 'calendar_add_event', 'habit_log', 'habit_status',
  'vault_search', 'vault_read_note', 'daily_note_log', 'web_search', 'web_fetch', 'history_search', 'app_guide',
  'priorities_update', 'learning_overview', 'brain_switch',
];

// More tools on request (tool tools_more): what a local model may add to the everyday ones, by the
// name it asks for → the tool groups (main/tools/*.js). Code changes, self-changes and connectors are
// not offered: they need the Claude brain. A loaded group stays for the rest of the conversation
// (conv.toolGroups) and is added after the others, so the start of the request stays the same and
// the local server keeps reusing what it already read.
const TOOLBOX = {
  memory: ['memory', 'stream'],
  calendar: ['calendar'],
  notes: ['vault'],
  learning: ['learning', 'practice'],
  habits: ['habits', 'skilltree'],
  routines: ['routines'],
  documents: ['documents'],
  browser: ['browser'],
  skills: ['skills'],
  looks: ['appearance'],
  voice: ['voice', 'listening'],
  github: ['github'],
  world: ['world', 'rehearsal'],
  diagnostics: ['mechanic'],
};

// Words that make a group's need obvious, so it is there from the first round (it only ever adds).
const HINTS = [
  ['learning', /\b(flash ?cards?|decks?|vocab\w*|study|studying|quiz|anki|learn(ing)?|lernen|karteikarten)\b/i],
  ['routines', /\b(routines?|automatically|every (morning|evening|night|day|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|each (morning|evening|day|week))\b/i],
  ['documents', /\b(pdf|documents?|diagrams?|charts?|graph|plot|monitors?|windows?|full ?screen)\b/i],
  ['habits', /\b(habits?|streaks?|skill ?tree|goals?)\b/i],
  ['browser', /\b(website|web ?page|browser|open (the )?(site|page))\b/i],
  ['looks', /\b(persona|theme|colou?rs?|look and feel|appearance)\b/i],
  ['github', /\b(github|repo(sitory)?|pull request|issues?)\b/i],
  ['skills', /\b(skills?)\b/i],
  ['diagnostics', /\b(diagnos\w*|not working|broken|error|log)\b/i],
  ['notes', /\b(notes?|vault|obsidian|journal|daily note)\b/i],
  // Up to two words between ("move my dentist appointment"), and the shorter "reschedule/postpone".
  ['calendar', /\b(reschedule|postpone|move|cancel|delete|remove|change|shift)\b(\s+\S+){0,2}\s+(events?|meetings?|appointments?|lectures?|class(es)?|dates?|party|lunch|dinner)\b|\b(reschedule|postpone)\b/i],
  ['memory', /\b(forget|what do you (know|remember))\b/i],
];

/** The groups a message obviously needs (word hints, no model call). */
function hintGroups(text, { personas = [] } = {}) {
  const t = String(text || '');
  const groups = HINTS.filter(([, re]) => re.test(t)).map(([g]) => g);
  // One of the user's personas by name ("switch to Captain Vega"): the persona tools, not the brain switch.
  if (!groups.includes('looks') && personas.some((n) => n && neededService(t, [n]))) groups.push('looks');
  return groups;
}

/**
 * The tool names a local model gets: the everyday ones in their fixed order, then each loaded group's
 * tools in the order the groups were loaded. Only tools in `active` (what the settings allow) count.
 */
function compactTools(active, loaded = []) {
  const byName = new Map(active.map((t) => [t.name, t]));
  const out = COMPACT_TOOLS.filter((n) => byName.has(n));
  for (const g of loaded) for (const t of active) if ((TOOLBOX[g] || []).includes(t.group) && !out.includes(t.name)) out.push(t.name);
  return out.map((n) => byName.get(n));
}

/**
 * This message's notes (time, schedule, recalled memories) just before the newest user message, so a
 * local server reuses everything in front of them. As a system message: put inside the user's message,
 * models answered "Based on the context you provided…" (measured with glm4). asSystem false is the
 * fallback for templates that refuse a system message after the first.
 */
function placeNote(messages, note, { asSystem = true } = {}) {
  const last = messages[messages.length - 1];
  if (!note || last?.role !== 'user' || typeof last.content !== 'string') return messages;
  const head = 'Notes for this message, from the app (not written by the user; use them, never mention them):';
  if (asSystem) return [...messages.slice(0, -1), { role: 'system', content: `${head}\n${note}` }, last];
  return [...messages.slice(0, -1), { ...last, content: `(${head}\n${note}\nEnd of notes. The user's message:)\n\n${last.content}` }];
}

// A short first reply that gives up ("I don't have that information") before any lookup. Small models
// do this despite the rule (measured: qwen3:8b on "When is the Project Atlas deadline?"); the loop then
// asks once to look it up (LOOK_FIRST) instead of showing it. A persona says it in its own words ("I do
// not possess that information", "I do not recall") or offers to look instead of looking ("Would you like
// me to search your notes?", "Let me confirm that"): measured with a 28k-character persona.
const GAVE_UP = /\b(I (do not|don['’]t|can['’]t|cannot) (have|know|find|see|access|possess|recall|remember)\b|I have no (information|record|details|notes?|recollection)\b|I(['’]m| am) not aware\b|I['’]m not sure (what|when|who|where|which)\b|no information (about|on|regarding)\b|(have|has) not (yet )?(mentioned|told|shared)\b|(would you like me|shall I|let me|I (can|could)) (to )?(look|search|check|confirm)\b)/i;
const gaveUpUnlooked = (text) => String(text || '').length < 400 && GAVE_UP.test(String(text || ''));
const LOOK_FIRST = 'Before you say you don’t know: look it up now with memory_search, then vault_search (and calendar_get_events for dates). Answer from what they find; only if both find nothing, say you don’t know.';

// A reply that says it did something ("I've added…", "Icelandic practice done.", "Noted:") in a turn in
// which no tool changed anything: the scenario suite caught a local model claiming a logged habit and a
// second calendar entry that were never made. First person or a short "X done/logged" only, so a plain
// answer like "your dentist is scheduled for 10:00" is not taken for a claim.
const CLAIM = /\bI(['’]ve| have|['’]ll| will)?\s+(just\s+|also\s+)?(added|logged|saved|scheduled|booked|created|set up|put|marked|checked off|ticked off|updated|moved|rescheduled|deleted|removed|recorded|noted|stored)\b|^\s*(done|logged|noted|saved|added|booked|scheduled)\b|\b(practice|habit|workout|session|it|that|this)\s+(is\s+)?(now\s+)?(done|logged|checked off|ticked off|recorded)\b/im;
const claimsAction = (text) => CLAIM.test(String(text || ''));
const CLAIM_CHECK = 'Your reply says you did something (added, logged, saved, scheduled…), but no tool changed anything in this turn. If the user asked for it, do it now with the tool, one call per item; if a tool failed, say so. If the user only asked a question, answer it without claiming any action.';

// A question about the user's own situation ("Can I fit a gym session in on Sunday?", "Do I have time
// for…?"), not a request ("Can you add…?"): a local model booked the gym session over a brunch instead
// of answering. Such a turn changes nothing (llm.js refuses its write tools).
const ASKING = /^\s*(can|could|should|shall|do|does|did|is|are|am|will|would|have|has)\s+(i|we|there|my)\b[^]*\?\s*$/i;
const questionOnly = (text) => ASKING.test(String(text || '').trim());
const NOT_FOR_A_QUESTION = 'Not done: the user asked a question, not for a change. Answer it (look things up if you need to) and offer to make the change.';

// ------------------------------------------------------------------ hand-over to Claude
// (llm.handOver, user-only): a local brain passes a message it can't do well to the Claude brain.

// Tools that only look things up. Once a turn ran any other tool (it saved, added, changed
// something), it is never handed over: the stronger brain would do it again.
const READ_TOOL = /(^|_)(get|search|read|list|status|overview|decks|browse|options|recall|view|links|history|next)(_|$)|^(tools_more|app_guide|capabilities_for|web_search|web_fetch|look_at_screen)$/;
const isReadTool = (name) => READ_TOOL.test(String(name || ''));

/**
 * Why a message should go to Claude without asking the local model, or ''. Only the obvious: code
 * work, a connected service by name (the local brain has no connectors), a very long text.
 * services = the names of the user's connectors ("TickTick", "Google Calendar"…).
 */
function handOverHint(text, { services = [], engineering = false } = {}) {
  const t = String(text || '');
  if (engineering) return 'code work';
  if (t.length > 4000) return 'a long text';
  const named = neededService(t, services);
  return named ? `it needs ${named}` : '';
}

/** The first of the user's connected services the text names as a whole word ("TickTick"), or ''. */
function neededService(text, services = []) {
  const t = String(text || '');
  return services.find((s) => s.length > 2 && new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}\\b`, 'i').test(t)) || '';
}

module.exports = { SERVERS, SMALL_B, SUGGESTED, COMPACT_TOOLS, TOOLBOX, hintGroups, compactTools, placeNote, isReadTool, handOverHint, neededService, gaveUpUnlooked, LOOK_FIRST, claimsAction, CLAIM_CHECK, questionOnly, NOT_FOR_A_QUESTION, paramsOf, isSmall, parseOllama, parseOpenAIModels, suggest, isLocal, compactWanted, requestExtras };
