// Multi-provider brain (llm.provider = 'auto'): the user's ranked list of providers, an optional
// per-task preference ("smart routing"), and automatic fallback. A provider that hits a rate limit,
// a usage cap or runs out of credits is skipped for a while (its cooldown) and the next one answers.
// Every provider except Claude speaks the OpenAI chat API, so they all run through llm.js's OpenAI
// path with their own URL, key and model.
const log = require('./logger');

const PROVIDERS = {
  'claude-code': { name: 'Claude (account)', tools: true, vision: true },
  anthropic: { name: 'Claude (API key)', tools: true, vision: true },
  gemini: { name: 'Gemini', openai: true, tools: true, vision: true, keyUrl: 'https://aistudio.google.com/apikey' },
  deepseek: { name: 'DeepSeek', openai: true, tools: true, vision: false, keyUrl: 'https://platform.deepseek.com/api_keys' },
  groq: { name: 'Groq', openai: true, tools: true, vision: false, keyUrl: 'https://console.groq.com/keys' },
  perplexity: { name: 'Perplexity', openai: true, tools: false, vision: false, plain: true, keyUrl: 'https://www.perplexity.ai/account/api/keys', models: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro'] },
  openai: { name: 'FreeLLMAPI', tools: true, vision: false },
};
const IDS = Object.keys(PROVIDERS);

// Which providers suit which kind of task, best first. Only providers the user enabled are used,
// and the rest of their list follows in their own order.
const PREFER = {
  code: ['claude-code', 'anthropic', 'deepseek', 'gemini'],
  search: ['perplexity', 'gemini'],
  quick: ['groq', 'gemini', 'claude-code', 'anthropic'],
  long: ['gemini', 'anthropic', 'claude-code'],
  deep: ['anthropic', 'claude-code', 'gemini', 'deepseek'],
};
const TASK_LABEL = { code: 'code', search: 'a web question', quick: 'a quick spoken reply', long: 'a long input', deep: 'deep mode' };

const limits = new Map(); // provider id -> { until, reason }
let claudeStatus = { at: 0, ok: false };

const label = (id) => PROVIDERS[id]?.name || id;

// The user's order, with providers added in later versions appended so they can be enabled.
function order(settings) {
  const saved = (settings.routing?.order || []).filter((id) => PROVIDERS[id]);
  return [...new Set([...saved, ...IDS])];
}

// Can this provider be used at all (signed in / has a key)? Not about limits.
async function configured(settings, id) {
  if (id === 'claude-code') {
    if (Date.now() - claudeStatus.at > 60000) {
      const st = await require('./claudecode').status().catch(() => ({}));
      claudeStatus = { at: Date.now(), ok: Boolean(st.installed && st.loggedIn) };
    }
    return claudeStatus.ok;
  }
  if (id === 'anthropic') return Boolean(settings.anthropic.apiKey);
  if (id === 'openai') return Boolean(settings.llm.baseUrl);
  return Boolean(settings[id]?.apiKey);
}

function cooling(id) {
  const l = limits.get(id);
  if (l && l.until > Date.now()) return l;
  if (l) limits.delete(id);
  return null;
}

function classifyTask(text, { voice = false, mode = 'default' } = {}) {
  const t = String(text || '');
  if (mode === 'deep') return 'deep';
  if (/```|\b(code|coding|function|bug|debug|refactor|compile|stack ?trace|regex|script|typescript|javascript|python|sql|pull request)\b/i.test(t)) return 'code';
  const personal = /\b(calendar|schedule|meeting|appointment|my notes?|vault|memory|remember|document|pdf|file|monitor|window|skill)\b/i.test(t);
  if (!personal && /\b(latest|news|headlines|today'?s|this week|currently|right now|price of|stock|weather|score|who won|search (the )?(web|internet|online)|look (it |that )?up)\b/i.test(t)) return 'search';
  if (t.length > 6000) return 'long';
  if (voice) return 'quick';
  return 'general';
}

/**
 * Providers to try for one turn, in order: [{ id, reason }]. Unconfigured, disabled and cooling-down
 * providers are left out (a cooling one is still tried last if nothing else is left).
 */
async function plan(settings, { text = '', voice = false, needsTools = false } = {}) {
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
    const task = classifyTask(text, { voice, mode: settings.llm.modelMode });
    const prefer = (PREFER[task] || []).filter((id) => ready.includes(id));
    if (prefer.length && prefer[0] !== ready[0]) {
      picked = [...prefer, ...ready.filter((id) => !prefer.includes(id))];
      reason = `best for ${TASK_LABEL[task]}`;
    }
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
  if (status === 402 || /credit balance|insufficient[_ ](balance|credit|funds|quota)|billing|payment required|exceeded your current quota/i.test(msg)) return { kind: 'credits', label: 'is out of credits' };
  if (status === 429 || /rate.?limit|too many requests|resource.?exhausted|usage limit|limit reached|quota/i.test(msg)) return { kind: 'rate', label: 'hit its rate limit' };
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

module.exports = { PROVIDERS, label, order, plan, concrete, failed, succeeded, status, reset, classifyTask, classifyError };
