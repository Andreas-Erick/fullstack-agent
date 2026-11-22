// Multi-provider brain (llm.provider = 'auto'): the user's ranked list of providers, an optional
// per-task preference ("smart routing"), and automatic fallback. A provider that hits a rate limit,
// a usage cap or runs out of credits is skipped for a while (its cooldown) and the next one answers.
// runTurn / complete run a turn on the best available provider: llm.js passes a per-provider runner
// and this module owns the order, the cooldowns, the fallback rule and the notices.
// Every provider except Claude speaks the OpenAI chat API, so they all run through llm.js's OpenAI
// path with their own URL, key and model.
const log = require('./logger');

const brains = require('./brains');

// The routable brains as the router reads them (names and abilities live once, in brains.js's table):
// openai = on the OpenAI path with its own section (concrete() narrows to it).
const PROVIDERS = Object.fromEntries(
  brains.ROUTED.map((b) => [b.id, { name: b.name, openai: brains.ownEndpoint(b.id), tools: b.tools, vision: b.vision, ...(b.plain ? { plain: true } : {}), ...(b.keyUrl ? { keyUrl: b.keyUrl } : {}), ...(b.models ? { models: b.models } : {}), ...(b.local ? { local: true } : {}) }]),
);
const IDS = Object.keys(PROVIDERS);

// Which providers suit which kind of task, best first. Only providers the user enabled are used,
// and the rest of their list follows in their own order.
const PREFER = {
  code: ['claude-code', 'anthropic', 'deepseek', 'gemini'],
  search: ['perplexity', 'gemini'],
  quick: ['local', 'groq', 'gemini', 'claude-code', 'anthropic'],
  long: ['gemini', 'anthropic', 'claude-code'],
  deep: ['anthropic', 'claude-code', 'gemini', 'deepseek'],
};
const TASK_LABEL = { code: 'code', search: 'a web question', quick: 'a quick spoken reply', long: 'a long input', deep: 'deep mode' };

const limits = new Map(); // provider id -> { until, reason }
let claudeStatus = { at: 0, st: null };

const label = (id) => PROVIDERS[id]?.name || id;

// The user's order, with providers added in later versions appended so they can be enabled.
function order(settings) {
  // Own keys only: "__proto__" or "constructor" in a saved order are not providers.
  const saved = (Array.isArray(settings.routing?.order) ? settings.routing.order : []).filter((id) => typeof id === 'string' && Object.hasOwn(PROVIDERS, id));
  return [...new Set([...saved, ...IDS])];
}

// Can this provider be used at all (signed in / has a key)? Not about limits.
async function configured(settings, id) {
  if (id === 'claude-code' && Date.now() - claudeStatus.at > 60000) {
    const st = await require('./claudecode').status().catch(() => null);
    claudeStatus = { at: Date.now(), st };
  }
  return brains.configured(settings, id, { claude: claudeStatus.st });
}

function cooling(id) {
  const l = limits.get(id);
  if (l && l.until > Date.now()) return l;
  if (l) limits.delete(id);
  return null;
}

// attachedChars: the text of files attached to the message (llm.js runTurn): a long one is a long input,
// also when the message itself is a short spoken question.
function classifyTask(text, { voice = false, mode = 'default', attachedChars = 0 } = {}) {
  const t = String(text || '');
  if (mode === 'deep') return 'deep';
  if (/```|\b(code|coding|function|bug|debug|refactor|compile|stack ?trace|regex|script|typescript|javascript|python|sql|pull request)\b/i.test(t)) return 'code';
  const personal = /\b(calendar|schedule|meeting|appointment|my notes?|vault|memory|remember|document|pdf|file|monitor|window|skill)\b/i.test(t);
  if (!personal && /\b(latest|news|headlines|today'?s|this week|currently|right now|price of|stock|weather|score|who won|search (the )?(web|internet|online)|look (it |that )?up)\b/i.test(t)) return 'search';
  if (t.length > 6000 || attachedChars > 6000) return 'long';
  if (voice) return 'quick';
  return 'general';
}

/**
 * Providers to try for one turn, in order: [{ id, reason }]. Unconfigured, disabled and cooling-down
 * providers are left out (a cooling one is still tried last if nothing else is left). needsVision: the
 * message carries a picture, so the providers that see go first (in the same order among themselves).
 */
async function plan(settings, { text = '', voice = false, needsTools = false, needsVision = false, attachedChars = 0 } = {}) {
  const disabled = new Set(settings.routing?.disabled || []);
  const list = order(settings).filter((id) => !disabled.has(id));
  const ready = [];
  const resting = [];
  for (const id of list) {
    if (!(await configured(settings, id))) continue;
    if (needsTools && !PROVIDERS[id].tools) continue;
    (cooling(id) ? resting : ready).push(id);
  }
  let picked = ready;
  let reason = 'your priority order';
  if (settings.routing?.smart !== false) {
    const task = classifyTask(text, { voice, mode: settings.llm.modelMode, attachedChars });
    const prefer = (PREFER[task] || []).filter((id) => ready.includes(id));
    if (prefer.length && prefer[0] !== ready[0]) {
      picked = [...prefer, ...ready.filter((id) => !prefer.includes(id))];
      reason = `best for ${TASK_LABEL[task]}`;
    }
  }
  if (needsVision) {
    const sees = [...picked.filter((id) => PROVIDERS[id].vision), ...picked.filter((id) => !PROVIDERS[id].vision)];
    if (sees[0] !== picked[0]) reason = 'can see your image';
    picked = sees;
  }
  return [...picked.map((id, i) => ({ id, reason: i === 0 ? reason : 'fallback' })), ...resting.map((id) => ({ id, reason: 'every other provider is unavailable' }))];
}

// The settings one provider runs with: the multi-provider settings narrowed to that provider.
function concrete(settings, id) {
  if (id === 'claude-code' || id === 'anthropic' || id === 'openai') return { ...settings, llm: { ...settings.llm, provider: id, via: id } };
  const cfg = settings[id] || {};
  return {
    ...settings,
    llm: { ...settings.llm, provider: 'openai', via: id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, fastModel: cfg.fastModel, deepModel: cfg.deepModel, plainHistory: Boolean(PROVIDERS[id].plain), noVision: !PROVIDERS[id].vision },
  };
}

// Why a request failed, and how long to skip the provider for it.
function classifyError(err) {
  const status = err?.status ?? err?.statusCode;
  const msg = String(err?.message || err || '');
  if (status === 402 || /credit balance|insufficient[_ ](balance|credit|funds|quota)|billing|payment required|exceeded your current quota|spend limit|out of (usage )?credits/i.test(msg)) return { kind: 'credits', label: 'is out of credits' };
  if (status === 429 || /rate.?limit|too many requests|resource.?exhausted|usage limit|limit reached|quota|hit your (\w+ )?limit/i.test(msg)) return { kind: 'rate', label: 'hit its rate limit' };
  if (status === 401 || status === 403 || /api key|unauthori[sz]ed|invalid.{0,20}key|authentication|not signed in|not installed|not connected/i.test(msg)) return { kind: 'auth', label: 'is not signed in (or the key is wrong)' };
  if (status >= 500 || /overloaded|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up|network|timed out|unreachable/i.test(msg)) return { kind: 'down', label: 'is unavailable' };
  return { kind: 'other', label: `failed (${msg.slice(0, 120)})` };
}

// Retry-After header (seconds or a date), or the reset time Claude Code prints after "usage limit reached|<epoch>".
function retryAfterMs(err) {
  const header = err?.retryAfter ?? err?.headers?.get?.('retry-after') ?? err?.headers?.['retry-after'];
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) return secs * 1000;
    const at = Date.parse(header);
    if (at) return Math.max(0, at - Date.now());
  }
  const reset = String(err?.message || '').match(/limit reached\|(\d{10})/i);
  if (reset) return Math.max(0, Number(reset[1]) * 1000 - Date.now());
  return null;
}

/** Records a failure; returns { kind, label, minutes } (minutes = how long it is skipped, 0 = not). */
function failed(settings, id, err) {
  const why = classifyError(err);
  const base = Math.max(1, Number(settings.routing?.cooldownMin) || 15) * 60000;
  const ms = { rate: retryAfterMs(err) ?? base, credits: Math.max(base, 3600000), auth: 30 * 60000, down: 2 * 60000, other: 0 }[why.kind];
  if (ms > 0) limits.set(id, { until: Date.now() + ms, reason: why.label, kind: why.kind });
  log.warn('provider failed', { provider: id, kind: why.kind, skipMin: Math.round(ms / 60000), error: err });
  // FreeLLMAPI runs on this computer: if nothing answered, start it for the next time it is needed.
  if (id === 'openai' && why.kind === 'down') require('./helperapps').onUnreachable('freellmapi', err, settings);
  return { ...why, minutes: Math.round(ms / 60000) };
}

function succeeded(id) {
  limits.delete(id);
}

/** For the settings screen: every provider with whether it is configured, enabled and resting. */
async function status(settings) {
  const disabled = new Set(settings.routing?.disabled || []);
  return Promise.all(
    order(settings).map(async (id) => {
      const rest = cooling(id);
      return {
        id,
        name: label(id),
        configured: await configured(settings, id),
        enabled: !disabled.has(id),
        tools: PROVIDERS[id].tools,
        keyUrl: PROVIDERS[id].keyUrl || '',
        resting: rest ? { reason: rest.reason, minutes: Math.ceil((rest.until - Date.now()) / 60000) } : null,
      };
    }),
  );
}

function reset(id) {
  if (id) limits.delete(id);
  else limits.clear();
  claudeStatus.at = 0;
}

const NONE_READY = 'No AI provider is ready. Connect your Claude account or add an API key in Settings → AI brain.';

/**
 * One turn on the best available provider: the providers in plan order until one answers.
 * `run(providerSettings, emit)` runs the turn on one provider (settings narrowed by concrete()) and
 * streams through the `emit` it is given. A failed provider is cooled down (failed()) and the next one
 * answers, but only before any tool ran (no action runs twice): text it already streamed is retracted
 * and a notice names the switch. A stop (signal aborted, AbortError) never falls back.
 * task: { text, voice, needsTools, needsVision, attachedChars } as plan() reads them, plus emit, signal.
 * Returns the provider's result with `provider` (stored on the assistant message).
 */
async function runTurn(settings, { emit, signal, ...task }, run) {
  const providers = await plan(settings, task);
  if (!providers.length) throw new Error(NONE_READY);
  log.info('route', { order: providers.map((p) => p.id).join(' > '), reason: providers[0].reason });
  const failures = [];
  for (let i = 0; i < providers.length; i++) {
    const { id } = providers[i];
    // What this attempt already did: streamed text can be taken back, tool actions can't.
    const seen = { chars: 0, tools: 0 };
    const watch = (ev) => {
      if (ev.type === 'text') seen.chars += ev.delta.length;
      if (ev.type === 'retract') seen.chars -= ev.chars;
      if (ev.type === 'tool_start') seen.tools++;
      emit(ev);
    };
    try {
      const result = await run(concrete(settings, id), watch);
      succeeded(id);
      return { ...result, provider: id };
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
      const why = failed(settings, id, err);
      failures.push(`${label(id)} ${why.label}`);
      const next = providers[i + 1];
      if (!next) break;
      if (seen.tools) {
        throw new Error(`${label(id)} ${why.label} after it had already used tools, so this reply was not repeated on another provider (no action should run twice). Your next message goes to ${label(next.id)}.`);
      }
      if (seen.chars > 0) emit({ type: 'retract', chars: seen.chars });
      emit({ type: 'notice', message: `${label(id)} ${why.label}${why.minutes ? ` (skipped for ${why.minutes} min)` : ''} — switching to ${label(next.id)}.` });
    }
  }
  throw new Error(`No provider could answer: ${failures.join('; ')}.`);
}

/**
 * A single completion (no tools, no streaming) on the best available provider: `run(providerSettings)`
 * on each in plan order until one answers; every failure cools its provider down. Throws the last
 * provider's error (or "No AI provider is ready").
 */
async function complete(settings, text, run) {
  let lastErr = new Error(NONE_READY);
  for (const { id } of await plan(settings, { text })) {
    try {
      const out = await run(concrete(settings, id));
      succeeded(id);
      return out;
    } catch (err) {
      failed(settings, id, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = { PROVIDERS, label, order, plan, concrete, runTurn, complete, failed, succeeded, status, reset, classifyTask, classifyError };
