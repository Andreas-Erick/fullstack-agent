// The setup wizard's pure part. The face list: the face in use first (a fresh install's default,
// brand.FACE, is a custom face), then the custom faces, then the built-in ones. The face in use is
// always there, so the wizard can show what is selected and never offers only a way to lose it.
export function faceChoices(current, custom = [], builtIn = []) {
  const own = custom.map((f) => ({ value: f.id, title: f.title, desc: f.tagline || '' }));
  const taken = new Set(own.map((f) => f.title));
  const shipped = builtIn.map((f) => ({ value: f.id, title: taken.has(f.title) ? `${f.title} (built-in)` : f.title, desc: f.tagline || '' }));
  const all = [...own, ...shipped];
  const inUse = all.find((f) => f.value === current);
  if (inUse) return [inUse, ...all.filter((f) => f !== inUse)];
  return current ? [{ value: current, title: 'Your current face', desc: '' }, ...all] : all;
}

export const STEPS = ['welcome', 'privacy', 'hardware', 'brain', 'voice', 'vault', 'goals', 'connect', 'persona', 'tour', 'hello'];

// The ways through the wizard, each ending with its last step: the whole setup; "Quick start" (the
// welcome, the privacy step, then the brain finder, so a quick setup never ends in a failed first
// message); and the privacy step alone, for an install that was set up without accepting it. Every one
// passes the privacy step.
const PATHS = { full: STEPS, quick: ['welcome', 'privacy', 'brain'], missed: ['privacy'] };
export const stepsFor = (mode) => PATHS[mode] || STEPS;

// The brain finder: the wizard's brain step. Its cards, in words a newcomer can follow (product names only
// in the small print). 'openai' (FreeLLMAPI or another OpenAI-compatible server) stays for those who use it.
const BRAIN_CARDS = {
  'claude-code': { ico: '✦', title: 'My Claude plan', desc: 'Uses your paid Claude plan (Pro or Max) through Claude’s helper app, Claude Code. Best for tools, code and long tasks.' },
  local: { ico: '⌂', title: 'A model on this computer', desc: 'Private and free: nothing you say leaves this PC. Needs Ollama or LM Studio running with a model.' },
  gemini: { ico: '🆓', title: 'Free, nothing to install (Google Gemini)', desc: 'Google Gemini’s free tier. Takes about a minute: sign in with Google, copy a key, paste it here.', free: true },
  auto: { ico: '⇄', title: 'Several providers', desc: 'Gemini, Groq, Claude, DeepSeek… the best one for each message, switching when one hits a limit.' },
  anthropic: { ico: '🔑', title: 'Anthropic API key', desc: 'Claude, paid per use.' },
  openai: { ico: '🖧', title: 'Another server (advanced)', desc: 'FreeLLMAPI or any OpenAI-compatible address.' },
};
const ORDER = ['claude-code', 'local', 'gemini', 'auto', 'anthropic', 'openai'];
const NAMES = { 'claude-code': 'Your Claude plan', local: 'The model on this computer', gemini: 'Google Gemini', auto: 'Several providers', anthropic: 'The Anthropic key', openai: 'The server you set' };

// Is this brain set up, from what the finder found (not whether it answers: only a test says that)?
function works(id, detection, settings) {
  const d = detection || {};
  const keys = d.keys || {};
  const s = settings || {};
  if (id === 'claude-code') return d.claude === 'ready';
  if (id === 'local') return (d.local || []).length > 0 || Boolean(s.local?.baseUrl && s.local?.model);
  if (id === 'gemini') return Boolean(keys.gemini);
  if (id === 'anthropic') return Boolean(keys.anthropic);
  // Several providers works with a saved key; a signed-in Claude alone is offered as its own card.
  if (id === 'auto') return Boolean(keys.gemini || keys.groq || keys.anthropic);
  if (id === 'openai') return s.llm?.provider === 'openai' && Boolean(s.llm?.baseUrl);
  return false;
}

/**
 * What the brain step offers. detection = { claude: 'missing'|'unchecked'|'signedOut'|'ready',
 * local: [{ server, baseUrl, model }], keys: { gemini, groq, anthropic } } (true = a key is saved);
 * progress = { chosen, tested } (the card the user picked; the brain whose test answered).
 * Returns { preselect, cards: [{ id, ico, title, desc, works, free }], canStart, warn }:
 * preselect keeps a brain that is already set up (setup reopened from Settings), else what works here
 * (a signed-in Claude, a local model, a saved key), else the free card. cards: what works first, then
 * the free option, then the rest. canStart only once a test answered for the chosen brain; warn is the
 * plain sentence for going on without that ('' when the brain answered).
 */
export function brainPlan(detection, settings, progress = {}) {
  const current = settings?.llm?.provider;
  const ids = ORDER.filter((id) => id !== 'openai' || current === 'openai');
  const ok = (id) => works(id, detection, settings);
  let preselect;
  if (ids.includes(current) && ok(current)) preselect = current;
  else if (ok('claude-code')) preselect = 'claude-code';
  else if ((detection?.local || []).length) preselect = 'local';
  else if (detection?.keys?.gemini) preselect = 'gemini';
  else if (detection?.keys?.anthropic) preselect = 'anthropic';
  else if (detection?.keys?.groq) preselect = 'auto';
  else preselect = 'gemini';
  const rank = (id) => (ok(id) ? 0 : BRAIN_CARDS[id].free ? 1 : 2);
  const cards = ids
    .map((id, i) => ({ id, i, ...BRAIN_CARDS[id], free: Boolean(BRAIN_CARDS[id].free), works: ok(id) }))
    .sort((a, b) => rank(a.id) - rank(b.id) || a.i - b.i)
    .map(({ i, ...card }) => card);
  const chosen = ids.includes(progress.chosen) ? progress.chosen : preselect;
  const canStart = Boolean(progress.tested) && progress.tested === chosen;
  let warn = '';
  if (!canStart) {
    warn = ok(chosen)
      ? `${NAMES[chosen]} is set up but hasn’t answered a test yet. If it doesn’t work, Siren can’t answer until you fix it in Settings → AI brain.`
      : 'Siren can’t answer yet: no brain is working. You can set one up later in Settings → AI brain.';
  }
  return { preselect, chosen, cards, canStart, warn };
}

/**
 * The finder's detection from what the app already checks (no new probing): the brain catalogue
 * (llm:brains with fresh, all: the Claude sign-in state and each brain's readiness) and the local servers
 * (llm:localModels: Ollama and LM Studio).
 */
export function detectionFrom(catalogue, servers = []) {
  const rows = Array.isArray(catalogue?.brains) ? catalogue.brains : [];
  const row = (id) => rows.find((b) => b.id === id);
  const claude = row('claude-code')?.state;
  return {
    claude: ['missing', 'unchecked', 'signedOut', 'ready'].includes(claude) ? claude : 'unchecked',
    local: (Array.isArray(servers) ? servers : [])
      .filter((s) => s?.running)
      .flatMap((s) => (s.models || []).map((m) => ({ server: s.name, baseUrl: s.baseUrl, model: m.id, name: m.name || m.id }))),
    keys: { gemini: Boolean(row('gemini')?.ready), groq: Boolean(row('groq')?.ready), anthropic: Boolean(row('anthropic')?.ready) },
  };
}

/**
 * The settings a brain card writes, by the brain-switch rules (main/braincore.js patchFor): llm.provider,
 * plus the key typed for it, or a detected local model and its server's address (never one the user typed).
 */
export function brainPatch(id, { key, local } = {}) {
  const patch = { llm: { provider: id } };
  const k = typeof key === 'string' ? key.trim() : '';
  if (k && (id === 'gemini' || id === 'anthropic')) patch[id] = { apiKey: k };
  if (id === 'local' && local?.model && local?.baseUrl) patch.local = { model: local.model, baseUrl: local.baseUrl };
  return patch;
}

/** The free card's guided steps: where to click, what to copy, where to paste. */
export const FREE_KEY_URL = 'https://aistudio.google.com/apikey';
export const FREE_KEY_STEPS = ['Click “Get my free key”. Google’s AI Studio opens in your browser.', 'Sign in with your Google account and click “Create API key”.', 'Copy the key it shows and paste it below. It is stored encrypted on this computer.'];

/** Claude Code in one plain line, and where to get it (the official page; no terminal needed to read it). */
export const CLAUDE_CODE_URL = 'https://claude.com/product/claude-code';
export const CLAUDE_CODE_LINE = 'To use your Claude plan, Siren needs Claude’s helper app, Claude Code. It needs a paid Claude plan (Pro or Max).';

/** First hello's failed brain row, in plain words. */
export const HELLO_BRAIN_FAILED = 'She can’t answer yet: no brain is connected.';

export const accepted = (settings) => Number(settings?.privacy?.acceptedAt) > 0;

/** What finishing the wizard saves: never `onboarded` without the privacy acceptance (null then). */
export function finishPatch(settings) {
  return accepted(settings) ? { onboarded: true } : null;
}

/** At launch: 'full' (first run), 'missed' (set up, the privacy notice never accepted) or '' (nothing). */
export function launchMode(settings) {
  if (!settings?.onboarded) return 'full';
  return accepted(settings) ? '' : 'missed';
}
