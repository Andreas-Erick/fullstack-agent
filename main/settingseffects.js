// What a settings save sets in motion beyond the file, whoever saved: the Settings view, a tool
// (brain_switch, setup_configure, settings_update, setup_check_service), an approval's "Always allow…",
// a persona switch, a reset. One listener on store.onChange(settings, patch) and one table of which
// patch sections trigger which effect. A reset tells listeners with every section as the patch, so it
// triggers them all. A save the store refused (a persona-bound change dropped because another persona
// became active, a patch that computed to null) never reaches the listener, so it triggers nothing.
//
// Effects run one by one; one that throws (or rejects) is logged and the others still run. The async
// ones are kept until they settle: `settled()` is what settings:set and settings:reset await, so the
// window sees remote access started or stopped when its save resolves, as before.
const router = require('./router');

// Router provider id -> its settings section. FreeLLMAPI ('openai') lives in `llm`, beside fields that
// have nothing to do with routing (pace, model mode), so only its own fields count (ROUTER_LLM).
const sectionOf = (id) => (id === 'claude-code' ? 'claudeCode' : id === 'openai' ? null : id);
const ROUTER_SECTIONS = Object.keys(router.PROVIDERS).map(sectionOf).filter(Boolean);
const ROUTER_LLM = ['provider', 'baseUrl', 'apiKey'];
const CONNECTOR_LEVELS = ['connectorsAllowed', 'connectorsReadOnly', 'connectorsWrite'];
const SUMMARY_SETTLE_MS = 20000; // a persona being edited is not summarized on every keystroke
const SUMMARY_AFTER_START_MS = 60000;

const has = (patch, section, key) => {
  const v = patch?.[section];
  if (!v || typeof v !== 'object') return false;
  return key === undefined ? true : v[key] !== undefined;
};

// The table: [name, when(patch), run(settings, patch, deps)]. A run may return a promise.
const EFFECTS = [
  // registerShortcut logs a refused shortcut itself (accel and reason as data). Anything else it throws is
  // still about the user's value: data too, never an Error, whose stack would count against a self-change.
  [
    'voice shortcut',
    (p) => has(p, 'stt', 'globalShortcut'),
    (s, p, d) =>
      Promise.resolve()
        .then(() => d.registerShortcut())
        .catch((err) => d.log.warn('voice shortcut not registered', { accel: String(s.stt?.globalShortcut || ''), reason: String(err?.message || err) })),
  ],
  ['logging', (p) => has(p, 'logging'), (s, p, d) => d.log.setDebug(s.logging?.debug)],
  // Remote access: started, stopped or moved (port, LAN, tunnel). Serialized: the latest save wins in order.
  ['remote access', (p) => has(p, 'remote'), (s, p, d) => (remoteChain = remoteChain.catch(() => {}).then(() => d.companion.apply(s)))],
  // Paired phones (and through them the watch) hear of a persona switch or a changed look at once.
  ['devices', () => true, (s, p, d) => d.companion.settingsChanged(p)],
  // A newly used or re-enabled helper app (VoiceStudio, FreeLLMAPI) starts now; helperapps.js also keeps
  // these settings for a later "start it again" (onUnreachable) and for quitting.
  ['helper apps', (p) => ['voice', 'llm', 'routing', 'helperApps'].some((k) => has(p, k)), (s, p, d) => d.helperApps.ensureAll(s, 'settings')],
  // Another brain, a provider's key or model, or the routing list: no stale cooldowns or plan.
  ['router', (p) => has(p, 'routing') || ROUTER_LLM.some((k) => has(p, 'llm', k)) || ROUTER_SECTIONS.some((k) => has(p, k)), (s, p, d) => d.router.reset()],
  // Connector levels change outside the window too (an approval's "Always allow…", connector_permission):
  // the window gets the saved lists, so Settings shows and keeps them.
  [
    'connector levels',
    (p) => CONNECTOR_LEVELS.some((k) => has(p, 'claudeCode', k)),
    (s, p, d) => d.toWindow('claude:connectorLevels', Object.fromEntries(CONNECTOR_LEVELS.map((k) => [k, s.claudeCode?.[k]]))),
  ],
  // A long master prompt gets its short version for local models after the persona, its master prompt
  // or the brain changed (persona.ensureSummary).
  ['persona summary', (p) => has(p, 'agent', 'personality') || has(p, 'llm') || has(p, 'local'), (s, p, d) => summarizeSoon(SUMMARY_SETTLE_MS)],
];

let deps = null;
let unsubscribe = null;
let remoteChain = Promise.resolve();
let summaryTimer = null;
const pending = new Set();

function summarizeSoon(ms) {
  clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    Promise.resolve()
      .then(() => deps.persona.ensureSummary())
      .then((st) => deps.toWindow('persona:summary', st), (error) => deps.log.warn('persona summary failed', { error }));
  }, ms);
  summaryTimer.unref?.();
}

function failed(name, error) {
  deps.log.warn('settings effect failed', { effect: name, error });
}

function onSave(settings, patch) {
  for (const [name, when, run] of EFFECTS) {
    try {
      if (!when(patch)) continue;
      const r = run(settings, patch, deps);
      if (r && typeof r.then === 'function') {
        const p = Promise.resolve(r).catch((error) => failed(name, error));
        pending.add(p);
        p.finally(() => pending.delete(p));
      }
    } catch (error) {
      failed(name, error);
    }
  }
}

/**
 * deps: { store, log, companion, helperApps, router, registerShortcut, toWindow, persona }.
 * Subscribes once; also schedules the first persona summary a little after start (opts.summaryAfterStartMs).
 */
function init(d, { summaryAfterStartMs = SUMMARY_AFTER_START_MS } = {}) {
  stop();
  deps = { router, log: require('./logger'), ...d };
  unsubscribe = deps.store.onChange(onSave);
  if (summaryAfterStartMs != null) summarizeSoon(summaryAfterStartMs);
}

/** Resolves once every async effect started so far has settled (never rejects). */
async function settled() {
  while (pending.size) await Promise.all([...pending]);
}

// Tests: unsubscribe and drop the timers.
function stop() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  clearTimeout(summaryTimer);
  summaryTimer = null;
}

module.exports = { init, settled, stop, ROUTER_SECTIONS, _effects: EFFECTS.map(([name]) => name) };
