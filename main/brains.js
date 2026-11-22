// The brain catalogue: which brain, is it ready, what fixes it. The rows (names, path, section, what
// each can do, what is missing) are renderer/js/braintable.mjs, shared with the window and the phone;
// this module adds readiness, once, for everything that asks: router.js (which providers can answer),
// tools/brain.js (brain_options / brain_switch), diagnostics.js (Health) and the window (IPC llm:brains:
// the title-bar light and Settings → AI brain).
//
// The core is pure: list(settings, probes) / entry / current take what was probed. probes:
//   claude:  claudecode.status()'s answer ({ installed, checked, loggedIn, version, email, … }) or null
//   routing: router.status()'s list ([{ id, enabled, configured, resting }]) or null
// live(settings) gathers them with the calls that already exist (both cached), for the IPC and the tools.
const table = require('../renderer/js/braintable.mjs');

const { BRAINS, ROUTED, brain, name, ownEndpoint, missingFor } = table;
const IDS = BRAINS.map((b) => b.id);

/**
 * Where the Claude account stands, from claudecode.status(): 'missing' (the CLI isn't found), 'unchecked'
 * (the sign-in check itself failed: a timeout, a crash; says nothing about the sign-in), 'signedOut',
 * 'ready'; 'unknown' when it wasn't probed.
 */
function claudeState(st) {
  if (!st || typeof st !== 'object') return 'unknown';
  if (!st.installed) return 'missing';
  if (st.checked === false) return 'unchecked';
  if (!st.loggedIn) return 'signedOut';
  return 'ready';
}

// How to fix the Claude account, per state (Health shows it; the window words its own buttons).
const CLAUDE_FIX = {
  missing: (hint) => (hint ? `Install: ${hint}, or set its path in Settings → AI brain.` : 'Install Claude Code, or set its path in Settings → AI brain.'),
  unchecked: () => 'Try again in a moment (Settings → AI brain → Refresh).',
  signedOut: () => 'Settings → AI brain → Connect Claude account.',
  unknown: () => 'Settings → AI brain → Connect Claude account.',
};

/** Is this one brain set up (signed in / has a key / a model picked)? Not about limits. Not for 'auto'. */
function configured(settings, id, { claude } = {}) {
  const s = settings || {};
  if (id === 'claude-code') return claudeState(claude) === 'ready';
  if (id === 'anthropic') return Boolean(s.anthropic?.apiKey);
  if (id === 'openai') return Boolean(s.llm?.baseUrl);
  if (id === 'local') return Boolean(s.local?.baseUrl && s.local?.model); // no key: a model picked
  return Boolean(brain(id) && s[id]?.apiKey);
}

/** The model a brain runs now ('' = its default). */
function modelOf(settings, id) {
  const b = brain(id);
  return b?.section ? String(settings?.[b.section]?.model || '') : '';
}

// Multi-provider is ready when a brain in its list is switched on, set up and not resting. Without the
// router's list, the switched-on brains that are set up (limits unknown).
function autoReady(settings, probes) {
  if (Array.isArray(probes.routing)) return probes.routing.some((p) => p.enabled && p.configured && !p.resting);
  const disabled = new Set(settings?.routing?.disabled || []);
  return ROUTED.some((b) => !disabled.has(b.id) && configured(settings, b.id, probes));
}

/**
 * One brain as the catalogue shows it: { id, name, offer, path, section, local, model, ready, state,
 * missing, fix }. state: 'ready' | 'notSetUp', for the Claude account its claudeState. missing and fix
 * are '' when it is ready. An unknown id comes back with its id as name and ready false.
 */
function entry(settings, id, probes = {}) {
  const b = brain(id);
  if (!b) return { id: String(id ?? ''), name: name(id), offer: name(id), path: '', section: null, local: false, model: '', ready: false, state: 'unknown', missing: `Unknown brain "${id}".`, fix: 'Pick a brain in Settings → AI brain.' };
  const ready = id === 'auto' ? autoReady(settings, probes) : configured(settings, id, probes);
  let state = ready ? 'ready' : 'notSetUp';
  let fix = '';
  if (id === 'claude-code') {
    state = claudeState(probes.claude);
    if (!ready) fix = (CLAUDE_FIX[state] || CLAUDE_FIX.unknown)(probes.installHint);
  } else if (!ready) {
    fix = {
      anthropic: 'Add it in Settings → AI brain.',
      openai: 'Add its address in Settings → AI brain.',
      local: 'Start Ollama or LM Studio and pick a model in Settings → AI brain.',
      auto: 'Connect your Claude account or add an API key in Settings → AI brain.',
    }[id] || 'Add its API key in Settings → AI brain → Multi-provider.';
  }
  const out = { id: b.id, name: b.name, offer: b.offer, path: b.path, section: b.section, local: Boolean(b.local), model: modelOf(settings, id), ready, state, missing: ready ? '' : missingFor(id), fix };
  if (id === 'claude-code' && probes.claude) out.claude = probes.claude;
  return out;
}

/** Every brain, in the order they are offered. */
const list = (settings, probes = {}) => IDS.map((id) => entry(settings, id, probes));

/** The brain that answers now (settings.llm.provider). */
const current = (settings, probes = {}) => entry(settings, settings?.llm?.provider, probes);

/**
 * The catalogue with live probes, for the window (llm:brains) and the tools: { current, brains, routing }.
 * Probes only what the answer needs, through the cached calls that already existed: claudecode.status()
 * when the brain is the Claude account (or `all`), router.status() in multi-provider mode (or `all`;
 * it asks the Claude status through its own minute's cache). fresh: Settings' check of the account.
 */
async function live(settings, { fresh = false, all = false } = {}) {
  const provider = settings?.llm?.provider;
  const probes = {};
  const jobs = [];
  if (all || provider === 'claude-code') {
    const claudecode = require('./claudecode');
    jobs.push(
      claudecode
        .status({ fresh })
        // A check that failed (timed out, crashed) says nothing about the sign-in: it isn't "not installed".
        .catch((err) => ({ installed: true, checked: false, error: String(err?.message || err) }))
        .then((st) => {
          probes.claude = st;
          if (!st.installed) probes.installHint = claudecode.installHint();
        }),
    );
  }
  if (all || provider === 'auto') jobs.push(require('./router').status(settings).then((r) => (probes.routing = r)));
  await Promise.all(jobs);
  // Multi-provider's list already knows whether the Claude account answers.
  if (!probes.claude && probes.routing) {
    const c = probes.routing.find((p) => p.id === 'claude-code');
    if (c) probes.claude = c.configured ? { installed: true, loggedIn: true } : null;
  }
  return { current: current(settings, probes), brains: list(settings, probes), routing: probes.routing || null };
}

module.exports = { BRAINS, ROUTED, IDS, brain, name, ownEndpoint, missingFor, claudeState, configured, modelOf, entry, list, current, live };
