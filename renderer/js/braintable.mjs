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

export const BRAINS = [
  { id: 'claude-code', name: 'Claude (account)', offer: 'Claude (your Claude account)', path: 'claude-code', section: 'claudeCode', route: 1, tools: true, vision: true, missing: 'Claude Code is not installed or not signed in (Settings → AI brain → Claude account)' },
  { id: 'anthropic', name: 'Claude (API key)', offer: 'Claude (API key)', path: 'anthropic', section: 'anthropic', route: 2, tools: true, vision: true, missing: 'no Anthropic API key (Settings → AI brain → Claude API key)' },
  { id: 'local', name: 'Local model (Ollama / LM Studio)', offer: 'A local model on this computer (Ollama / LM Studio)', path: 'openai', section: 'local', route: 8, tools: true, vision: false, local: true, missing: 'no local model picked yet: Ollama or LM Studio must be running with a model' },
  { id: 'gemini', name: 'Gemini', offer: 'Gemini', path: 'openai', section: 'gemini', route: 3, tools: true, vision: true, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'deepseek', name: 'DeepSeek', offer: 'DeepSeek', path: 'openai', section: 'deepseek', route: 4, tools: true, vision: false, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'groq', name: 'Groq', offer: 'Groq', path: 'openai', section: 'groq', route: 5, tools: true, vision: false, keyUrl: 'https://console.groq.com/keys' },
  { id: 'perplexity', name: 'Perplexity', offer: 'Perplexity (web answers, no tools)', path: 'openai', section: 'perplexity', route: 6, tools: false, vision: false, plain: true, keyUrl: 'https://www.perplexity.ai/account/api/keys', models: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro'] },
  { id: 'openai', name: 'FreeLLMAPI', offer: 'FreeLLMAPI', path: 'openai', section: 'llm', route: 7, tools: true, vision: false, missing: 'no FreeLLMAPI address (Settings → AI brain)' },
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
