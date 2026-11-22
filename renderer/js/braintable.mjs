// The brains Siren can answer with, once (pure data: no DOM, no Node; tests load it). One row per brain:
// its id (llm.provider), its name, the path its turns run through, where its settings live, what it can
// do and what is missing when it isn't set up. main/brains.js adds whether each one is ready (the main
// process requires this file: an .mjs is an ES module everywhere and Node can require() one); the window
// imports it for names (hud.js, app.js, settings.js) and chatcore.js, which the phone loads too
// (companion STATIC '/js/braintable.mjs').
//
// path: 'claude-code' (the Claude Code CLI, claudecode.js), 'anthropic' (the Claude API), 'openai'
// (llm.js's OpenAI chat path: FreeLLMAPI in `llm`, every other one with its own address in its own
// section), 'router' (multi-provider: router.js picks one of the others per message).
// name: the short name (notices, the title-bar light, the face's telemetry, Settings).
// offer: how brain_options offers it to the model and the user.
// route: its place in the multi-provider list for a user who never ordered it (none = not routed).
// missing: what isn't set up, said by brain_options / brain_switch (`missingFor` fills in the rest).
// vision: it sees pictures; visionByModel: that depends on the model (FreeLLMAPI), so it isn't promised
// either way (attachcore SEES_IMAGES null; the router still counts it as not seeing).
// blurb: its line in Settings → AI brain → Multi-provider.
// prefer: its rank per task in smart routing (router.js PREFER; 1 = tried first). A task it has no rank
// for leaves it to the user's order.
// defaults: its own section's defaults besides apiKey (store.js DEFAULTS), for the brains with their own
// section on the OpenAI path (`ownEndpoint`). Their apiKey is encrypted (store.js SECRET_FIELDS) and the
// agent may change their model keys (tools.js SETTABLE, `MODEL_KEYS`), never the address or the key;
// userPicksModel: not even those (a local model must be one that is installed: brain_switch checks it).

export const BRAINS = [
  {
    id: 'claude-code', name: 'Claude (account)', offer: 'Claude (your Claude account)', path: 'claude-code', section: 'claudeCode', route: 1, tools: true, vision: true,
    missing: 'Claude Code is not installed or not signed in (Settings → AI brain → Claude account)',
    blurb: 'Your Claude subscription through Claude Code. Best for tools, code and long tasks.',
    prefer: { code: 1, quick: 4, long: 3, deep: 2 },
  },
  {
    id: 'anthropic', name: 'Claude (API key)', offer: 'Claude (API key)', path: 'anthropic', section: 'anthropic', route: 2, tools: true, vision: true,
    missing: 'no Anthropic API key (Settings → AI brain → Claude API key)',
    blurb: 'Pay-per-use Claude API key.',
    prefer: { code: 2, quick: 5, long: 2, deep: 1 },
  },
  {
    id: 'local', name: 'Local model (Ollama / LM Studio)', offer: 'A local model on this computer (Ollama / LM Studio)', path: 'openai', section: 'local', route: 8, tools: true, vision: false, local: true,
    missing: 'no local model picked yet: Ollama or LM Studio must be running with a model',
    blurb: 'A model running on this computer with Ollama or LM Studio: private, free, and quick for short replies with a small model. Smart routing sends quick spoken replies here first.',
    prefer: { quick: 1 },
    userPicksModel: true,
    defaults: { baseUrl: 'http://localhost:11434/v1', model: '', fastModel: '', deepModel: '' }, // LM Studio's is http://localhost:1234/v1
  },
  {
    id: 'gemini', name: 'Gemini', offer: 'Gemini', path: 'openai', section: 'gemini', route: 3, tools: true, vision: true, keyUrl: 'https://aistudio.google.com/apikey',
    blurb: 'Google Gemini. Free tier available; very long context.',
    prefer: { code: 4, search: 2, quick: 3, long: 1, deep: 3 },
    defaults: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash', fastModel: '', deepModel: 'gemini-2.5-pro' },
  },
  {
    id: 'deepseek', name: 'DeepSeek', offer: 'DeepSeek', path: 'openai', section: 'deepseek', route: 4, tools: true, vision: false, keyUrl: 'https://platform.deepseek.com/api_keys',
    blurb: 'DeepSeek. Low-cost, strong at code.',
    prefer: { code: 3, deep: 4 },
    defaults: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', fastModel: '', deepModel: 'deepseek-reasoner' },
  },
  {
    id: 'groq', name: 'Groq', offer: 'Groq', path: 'openai', section: 'groq', route: 5, tools: true, vision: false, keyUrl: 'https://console.groq.com/keys',
    blurb: 'Groq. Very fast replies (good for voice); free tier available.',
    prefer: { quick: 2 },
    defaults: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', fastModel: '', deepModel: '' },
  },
  {
    id: 'perplexity', name: 'Perplexity', offer: 'Perplexity (web answers, no tools)', path: 'openai', section: 'perplexity', route: 6, tools: false, vision: false, plain: true,
    keyUrl: 'https://www.perplexity.ai/account/api/keys', models: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro'],
    blurb: 'Perplexity Sonar. Searches the web itself; no tools (calendar, notes…).',
    prefer: { search: 1 },
    defaults: { baseUrl: 'https://api.perplexity.ai', model: 'sonar', fastModel: '', deepModel: 'sonar-pro' },
  },
  {
    id: 'openai', name: 'FreeLLMAPI', offer: 'FreeLLMAPI', path: 'openai', section: 'llm', route: 7, tools: true, vision: false, visionByModel: true,
    missing: 'no FreeLLMAPI address (Settings → AI brain)',
    blurb: 'FreeLLMAPI or any OpenAI-compatible server.',
  },
  { id: 'auto', name: 'Multi-provider', offer: 'Multi-provider (the best ready brain for each message, falling back when one hits a limit)', path: 'router', section: null, missing: 'no brain is set up and switched on in the multi-provider list (Settings → AI brain → Multi-provider)' },
];

const BY_ID = new Map(BRAINS.map((b) => [b.id, b]));

/** The brain's row, or null (own ids only: "__proto__" is no brain). */
export const brain = (id) => (typeof id === 'string' && BY_ID.get(id)) || null;

/** Its short name; an unknown id is shown as itself. */
export const name = (id) => brain(id)?.name || String(id ?? '');

/** The brains the multi-provider mode can route to, in their default order. */
export const ROUTED = BRAINS.filter((b) => b.route).sort((a, b) => a.route - b.route);

/**
 * On the OpenAI path with its own address in its own section (local, Gemini, DeepSeek, Groq, Perplexity):
 * the brains router.concrete narrows, and the ones that answer on their own besides the four modes.
 */
export const ownEndpoint = (id) => {
  const b = brain(id);
  return Boolean(b && b.path === 'openai' && b.section !== 'llm');
};

/** What isn't set up for it, in words. */
export const missingFor = (id) => brain(id)?.missing || `no ${brain(id)?.offer || id} API key (Settings → AI brain → Multi-provider)`;

/** Smart routing's brains for a task, best first (router.js PREFER), from the rows' `prefer` ranks. */
export const preferFor = (task) => ROUTED.filter((b) => b.prefer?.[task]).sort((a, b) => a.prefer[task] - b.prefer[task]).map((b) => b.id);

/** The multi-provider list of a new install (store.js DEFAULTS routing.order). A local model isn't in it:
 *  router.order() appends it at the end, as it does for a brain added in a later version. */
export const DEFAULT_ORDER = ROUTED.filter((b) => !b.local).map((b) => b.id);

// The brains with their own settings section (`ownEndpoint`, each with `defaults`).
const OWN = BRAINS.filter((b) => ownEndpoint(b.id));

/** Their sections for store.js DEFAULTS: { gemini: { apiKey: '', baseUrl, model, … }, … } (fresh objects). */
export const sectionDefaults = () => Object.fromEntries(OWN.map((b) => [b.section, { apiKey: '', ...b.defaults }]));

/** Their keys, encrypted at rest (store.js SECRET_FIELDS). */
export const SECRET_KEYS = OWN.map((b) => [b.section, 'apiKey']);

/** The keys of such a section the agent may change (tools.js SETTABLE): never baseUrl or apiKey. */
export const MODEL_KEYS = Object.freeze(['model', 'fastModel', 'deepModel']);

/** Their part of tools.js SETTABLE: the model keys, except where the user picks the model. */
export const agentSettable = () => Object.fromEntries(OWN.filter((b) => !b.userPicksModel).map((b) => [b.section, [...MODEL_KEYS]]));
