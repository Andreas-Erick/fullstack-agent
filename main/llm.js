// LLM providers + the agent tool loop.
//  - "openai": FreeLLMAPI or any OpenAI-compatible server (/v1/chat/completions streaming, /v1/models)
//  - "anthropic": Claude via the official Anthropic SDK (streaming Messages API + tool use)
//  - "claude-code": the user's Claude account via their Claude Code CLI (see claudecode.js)
//  - "auto": several of the above plus Gemini, DeepSeek, Groq and Perplexity, ranked by the user,
//    with per-task routing and automatic fallback (see router.js)
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const tools = require('./tools');
const prompt = require('./prompt');
const claudecode = require('./claudecode');
const codebase = require('./codebase');
const obsidian = require('./obsidian');
const github = require('./github');
const approvals = require('./approvals');
const router = require('./router');
const log = require('./logger');
const { isEngineeringTask, toolBudget, upgradeBudget, turnEffort } = require('./engineering');

const noToolSupport = new Set(); // `${baseUrl}|${model}` combos that rejected the tools parameter

function trimBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function openaiHeaders(key) {
  return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

// ---------------------------------------------------------------- models / test
const CLAUDE_CODE_MODELS = [
  { id: 'default', name: 'Account default' },
  { id: 'opus', name: 'Opus (latest)' },
  { id: 'sonnet', name: 'Sonnet (latest)' },
  { id: 'haiku', name: 'Haiku (latest, fastest)' },
  { id: 'fable', name: 'Fable (most capable)' },
];

// A cloud provider picked by id (gemini, groq…) runs as an OpenAI-compatible server with its own URL and key.
function narrow(settings) {
  const id = settings.llm.provider;
  return router.PROVIDERS[id]?.openai ? router.concrete(settings, id) : settings;
}

async function listModels(settings) {
  const id = settings.llm.provider;
  if (id === 'auto') throw new Error('Pick one provider to list its models.');
  settings = narrow(settings);
  if (settings.llm.provider === 'claude-code') return CLAUDE_CODE_MODELS;
  if (settings.llm.provider === 'anthropic') {
    const client = anthropicClient(settings);
    const out = [];
    for await (const m of client.models.list({ limit: 100 })) out.push({ id: m.id, name: m.display_name || m.id });
    return out;
  }
  const fixed = router.PROVIDERS[id]?.models; // providers without a /models endpoint
  if (fixed) return fixed.map((m) => ({ id: m, name: m }));
  const res = await fetch(`${trimBase(settings.llm.baseUrl)}/models`, {
    headers: openaiHeaders(settings.llm.apiKey),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GET /models failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  const arr = Array.isArray(json) ? json : json.data || json.models || [];
  return arr.map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.id || m.name, name: m.name || m.id })).filter((m) => m.id);
}

async function testConnection(settings) {
  const started = Date.now();
  if (settings.llm.provider === 'auto') return testAll(settings, started);
  const fixedModels = router.PROVIDERS[settings.llm.provider]?.models;
  settings = narrow(settings);
  if (settings.llm.provider === 'claude-code') {
    const st = await claudecode.status();
    if (!st.installed) throw new Error(`Claude Code is not installed. Install it with:\n${claudecode.installHint()}`);
    if (!st.loggedIn) throw new Error('Claude Code is installed but not signed in. Click "Connect Claude account".');
    const reply = await claudecode.complete('Reply with the single word: online');
    return { ok: true, model: `${st.subscription ? `Claude ${st.subscription}` : 'Claude account'} · ${st.email || ''}`, reply: reply.trim(), ms: Date.now() - started };
  }
  if (settings.llm.provider === 'anthropic') {
    const client = anthropicClient(settings);
    const msg = await client.messages.create({
      model: settings.anthropic.model,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the single word: online' }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { ok: true, model: msg.model, reply: text.trim(), ms: Date.now() - started };
  }
  const models = fixedModels ? fixedModels.map((m) => ({ id: m })) : await listModels(settings).catch((e) => {
    throw new Error(`Could not reach ${settings.llm.baseUrl}: ${e.message}`);
  });
  const model = settings.llm.model || models[0]?.id;
  if (!model) throw new Error('Server reachable, but no models are available.');
  const res = await fetch(`${trimBase(settings.llm.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: openaiHeaders(settings.llm.apiKey),
    body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: 'user', content: 'Reply with the single word: online' }] }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Chat completion failed: ${res.status} ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  return { ok: true, model: json.model || model, reply: json.choices?.[0]?.message?.content?.trim() || '', models: models.length, ms: Date.now() - started };
}

// Multi-provider mode: tests every provider that is set up and switched on, in parallel.
async function testAll(settings, started) {
  const disabled = new Set(settings.routing?.disabled || []);
  const ids = router.order(settings).filter((id) => !disabled.has(id));
  const providers = await Promise.all(
    ids.map(async (id) => {
      const t0 = Date.now();
      try {
        const r = await testConnection({ ...settings, llm: { ...settings.llm, provider: id } });
        return { id, name: router.label(id), ok: true, model: r.model, ms: Date.now() - t0 };
      } catch (err) {
        return { id, name: router.label(id), ok: false, error: err.message.slice(0, 200) };
      }
    }),
  );
  if (!providers.some((p) => p.ok)) throw new Error(providers.map((p) => `${p.name}: ${p.error}`).join('\n'));
  router.reset();
  return { ok: true, providers, model: providers.filter((p) => p.ok).map((p) => p.name).join(', '), reply: 'online', ms: Date.now() - started };
}

// ---------------------------------------------------------------- agent turn
/**
 * Run one assistant turn (possibly several tool rounds).
 * @param {object} opts
 * @param {object} opts.settings
 * @param {Array} opts.history  stored conversation messages (incl. the new user message last)
 * @param {(ev: object) => void} opts.emit  streams events to the renderer
 * @param {AbortSignal} opts.signal
 * @returns {Promise<{ text: string, toolCalls: Array, raw: object|null, model: string }>}
 */
// The model for this turn, honoring the fast/deep mode (switchable by voice) and "fast for voice".
function effectiveModel(settings, { voice = false } = {}) {
  const mode = voice && settings.llm.voiceUsesFast ? 'fast' : settings.llm.modelMode || 'default';
  const pick = (cfg, base) => (mode === 'fast' && cfg.fastModel) || (mode === 'deep' && cfg.deepModel) || base;
  if (settings.llm.provider === 'claude-code') return pick(settings.claudeCode, settings.claudeCode.model);
  if (settings.llm.provider === 'anthropic') return pick(settings.anthropic, settings.anthropic.model);
  return pick(settings.llm, settings.llm.model);
}

// Fields that define a Claude Code session; changing any of them restarts it.
function sessionConfigKey(settings) {
  const { agent, appearance, voice, safety, code, web } = settings;
  return JSON.stringify([agent.name, agent.personality, agent.aesthetic, appearance.personaNotes, voice.ttsEnabled && voice.autoSpeak, safety.permissionMode, code.enabled, code.allowSelfModify, web.enabled, PROMPT_VERSION]);
}
const PROMPT_VERSION = 5;

async function claudeCodeOptions(settings, active, model) {
  const names = active.map((t) => t.name);
  const [cwd, vault] = await Promise.all([codebase.root(), obsidian.vaultPath()]);
  // With GitHub connected, Claude Code may also read and (on work branches) edit the cloned repos.
  let repos = null;
  if (names.includes('github_clone')) {
    repos = await github.workspace();
    await fsp.mkdir(repos, { recursive: true }).catch(() => {});
  }
  return {
    settings,
    configKey: sessionConfigKey(settings),
    buildPrompt: () => prompt.build(settings, names, { forSession: true }),
    activeTools: active,
    cwd,
    vault,
    repos,
    model,
  };
}

/**
 * One turn. `images` (data URLs, e.g. the shared screen) go with the newest user message only; they
 * are never stored in the conversation. In multi-provider mode the turn goes to the providers in
 * router order until one answers.
 */
async function runTurn(opts) {
  const { settings, conv, history, emit, signal, voice = false } = opts;
  if (settings.llm.provider !== 'auto') return { ...(await runOn(narrow(settings), opts)), provider: settings.llm.provider };
  const text = String(history[history.length - 1]?.content || '');
  const plan = await router.plan(settings, { text, voice, needsTools: Boolean(conv.setup) });
  if (!plan.length) throw new Error('No AI provider is ready. Connect your Claude account or add an API key in Settings → AI brain.');
  log.info('route', { order: plan.map((p) => p.id).join(' > '), reason: plan[0].reason });
  const failures = [];
  for (let i = 0; i < plan.length; i++) {
    const { id } = plan[i];
    // What this attempt already did: streamed text can be taken back, tool actions can't.
    const seen = { chars: 0, tools: 0 };
    const watch = (ev) => {
      if (ev.type === 'text') seen.chars += ev.delta.length;
      if (ev.type === 'retract') seen.chars -= ev.chars;
      if (ev.type === 'tool_start') seen.tools++;
      emit(ev);
    };
    try {
      const result = await runOn(router.concrete(settings, id), { ...opts, emit: watch });
      router.succeeded(id);
      return { ...result, provider: id };
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError') throw err;
      const why = router.failed(settings, id, err);
      failures.push(`${router.label(id)} ${why.label}`);
      const next = plan[i + 1];
      if (!next) break;
      if (seen.tools) {
        throw new Error(`${router.label(id)} ${why.label} after it had already used tools, so this reply was not repeated on another provider (no action should run twice). Your next message goes to ${router.label(next.id)}.`);
      }
      if (seen.chars > 0) emit({ type: 'retract', chars: seen.chars });
      emit({ type: 'notice', message: `${router.label(id)} ${why.label}${why.minutes ? ` (skipped for ${why.minutes} min)` : ''} — switching to ${router.label(next.id)}.` });
    }
  }
  throw new Error(`No provider could answer: ${failures.join('; ')}.`);
}

async function runOn(settings, { conv, history, emit, signal, voice = false, images = [] }) {
  const setup = Boolean(conv.setup);
  const active = setup || settings.llm.useTools ? await tools.activeTools(settings, { setup }) : [];
  const names = active.map((t) => t.name);
  // logTags: tool calls that arrive later through other channels (the MCP bridge, the Claude Code
  // process's output) are logged under this turn too.
  const lastText = String(history[history.length - 1]?.content || '');
  // Spoken turns stay quick unless they actually start engineering work (upgraded in runTool).
  const engineering = !setup && !voice && isEngineeringTask(lastText);
  const ctx = { emit, turn: approvals.newTurn(), logTags: log.context(), budget: toolBudget(settings, engineering) };
  // A screenshot can contain anything on screen (web pages, emails): it is external content.
  if (images.length) approvals.markTainted(ctx.turn, 'the shared screen');
  const model = effectiveModel(settings, { voice });
  log.info('turn', { provider: settings.llm.via || settings.llm.provider, model: model || 'default', voice, setup, engineering: engineering || undefined, images: images.length || undefined, conversation: conv.id, text: lastText.slice(0, 200) });
  if (settings.llm.provider === 'claude-code') {
    const opts = await claudeCodeOptions(settings, active, model);
    if (setup) {
      // The setup interview keeps one stable session even though the answers change the persona.
      opts.configKey = 'first-run-setup';
      opts.buildPrompt = async () => prompt.buildSetup(settings);
    }
    const buildContext = setup ? async () => prompt.buildSetup(await require('./store').getSettings()).context : (memIds) => prompt.turnContext(settings, names, memIds || []);
    return claudecode.runTurn({ ...opts, conv, history, emit, signal, ctx, buildContext, images });
  }
  const { system } = setup ? prompt.buildSetup(settings) : await prompt.build(settings, names);
  if (settings.llm.provider === 'anthropic') return runAnthropic({ settings: withModel(settings, 'anthropic', model), history, emit, signal, active, system, ctx, images });
  return runOpenAI({ settings: withModel(settings, 'llm', model), conv, history, emit, signal, active, system, ctx, images });
}

function withModel(settings, section, model) {
  return model ? { ...settings, [section]: { ...settings[section], model } } : settings;
}

// Pre-start the Claude Code session for a conversation (so the first turn after launch is warm).
async function prewarm(settings, conv) {
  // Multi-provider mode: warm the Claude session when Claude is the first choice.
  if (settings.llm.provider === 'auto') {
    const [first] = await router.plan(settings);
    if (first?.id !== 'claude-code') return;
    settings = router.concrete(settings, 'claude-code');
  }
  if (settings.llm.provider !== 'claude-code' || !conv) return;
  const active = settings.llm.useTools ? await tools.activeTools(settings) : [];
  await claudecode.prewarm(conv, await claudeCodeOptions(settings, active, effectiveModel(settings)));
}

// Single non-streaming completion with whichever provider is configured (used for persona/theme
// generation). `image` is an optional data URL the model may look at.
async function complete(settings, text, opts = {}) {
  if (settings.llm.provider !== 'auto') return completeOn(narrow(settings), text, opts);
  const plan = await router.plan(settings, { text });
  let lastErr = new Error('No AI provider is ready. Connect your Claude account or add an API key in Settings → AI brain.');
  for (const { id } of plan) {
    try {
      const out = await completeOn(router.concrete(settings, id), text, opts);
      router.succeeded(id);
      return out;
    } catch (err) {
      router.failed(settings, id, err);
      lastErr = err;
    }
  }
  throw lastErr;
}

async function completeOn(settings, text, { image } = {}) {
  const provider = settings.llm.provider;
  const model = effectiveModel(settings);
  if (model) settings = withModel(settings, provider === 'anthropic' ? 'anthropic' : provider === 'claude-code' ? 'claudeCode' : 'llm', model);
  if (provider === 'claude-code') {
    let imagePath;
    if (image) {
      const m = image.match(/^data:image\/(\w+);base64,(.+)$/);
      if (m) {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-img-'));
        imagePath = path.join(dir, `agent.${m[1].replace('jpeg', 'jpg')}`);
        await fsp.writeFile(imagePath, Buffer.from(m[2], 'base64'));
      }
    }
    return claudecode.complete(text, { imagePath, model: settings.claudeCode.model });
  }
  if (provider === 'anthropic') {
    const client = anthropicClient(settings);
    const content = [];
    const m = image?.match(/^data:(image\/\w+);base64,(.+)$/);
    if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    content.push({ type: 'text', text });
    const msg = await client.messages.create({
      model: settings.anthropic.model || 'claude-opus-5-5',
      max_tokens: 16000,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content }],
    });
    if (msg.stop_reason === 'refusal') throw new Error('The model declined this request.');
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const chatModel = settings.llm.model || (await listModels(settings).catch(() => []))[0]?.id;
  const res = await fetch(`${trimBase(settings.llm.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: openaiHeaders(settings.llm.apiKey),
    body: JSON.stringify({ model: chatModel, temperature: 0.8, max_tokens: 3000, messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(180000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LLM error ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body).choices?.[0]?.message?.content || '';
}

async function runTool(call, ctx, emit) {
  if (upgradeBudget(ctx, call.name)) log.info('engineering mode', { after: call.name, rounds: ctx.budget.rounds });
  emit({ type: 'tool_start', id: call.id, name: call.name, input: call.input });
  const { ok, result, image } = await tools.execute(call.name, call.input, ctx);
  const summary = tools.stringifyResult(result);
  emit({ type: 'tool_end', id: call.id, name: call.name, ok, preview: summary.slice(0, 600) });
  return { ok, content: summary, image, record: { name: call.name, input: call.input, ok, preview: summary.slice(0, 600) } };
}

const dataUrlParts = (url) => String(url || '').match(/^data:(image\/[\w+.-]+);base64,(.+)$/);

// ------------------------------------------------- OpenAI-compatible (FreeLLMAPI)
// plain: only text, strictly alternating (for providers without tool support, e.g. Perplexity).
function openaiHistory(history, limit, { plain = false } = {}) {
  const recent = history.slice(-Math.max(2, limit || 30));
  while (recent.length && recent[0].role !== 'user') recent.shift();
  const out = [];
  for (const m of recent) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (!plain && m.raw?.provider === 'openai' && Array.isArray(m.raw.messages) && m.raw.messages.length) out.push(...m.raw.messages);
      else if (m.content) out.push({ role: 'assistant', content: m.content });
    }
  }
  if (!plain) return out;
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev?.role === m.role) prev.content += `\n\n${m.content}`;
    else merged.push({ ...m });
  }
  return merged;
}

function withImages(messages, images) {
  const last = messages[messages.length - 1];
  if (!images.length || last?.role !== 'user') return messages;
  const content = [{ type: 'text', text: String(last.content || '') }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
  return [...messages.slice(0, -1), { role: 'user', content }];
}

async function* sseLines(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      yield line;
    }
  }
  if (buf.trim()) yield buf;
}

async function openaiStream({ base, key, payload, signal, emit }) {
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: openaiHeaders(key),
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`LLM error ${res.status}: ${detail.slice(0, 500)}`);
    err.status = res.status;
    err.retryAfter = res.headers.get('retry-after');
    throw err;
  }
  let text = '';
  const calls = [];
  let finish = null;
  let model = payload.model;
  const contentType = res.headers.get('content-type') || '';

  // Some servers ignore stream:true and return JSON.
  if (contentType.includes('application/json')) {
    const json = await res.json();
    const msg = json.choices?.[0]?.message || {};
    text = msg.content || '';
    if (text) emit({ type: 'text', delta: text });
    for (const tc of msg.tool_calls || []) calls.push({ id: tc.id, name: tc.function?.name, args: tc.function?.arguments || '' });
    return { text, calls, finish: json.choices?.[0]?.finish_reason, model: json.model || model };
  }

  for await (const line of sseLines(res.body)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error) throw new Error(`LLM error: ${json.error.message || JSON.stringify(json.error)}`);
    if (json.model) model = json.model;
    const choice = json.choices?.[0];
    if (!choice) continue;
    const d = choice.delta || {};
    if (d.reasoning_content || d.reasoning) emit({ type: 'thinking' });
    if (d.content) {
      text += d.content;
      emit({ type: 'text', delta: d.content });
    }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] ||= { id: '', name: '', args: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  return { text, calls: calls.filter(Boolean), finish, model };
}

// Compaction for small-context models: older turns are folded into a rolling summary stored on the
// conversation (instead of silently dropping them); recent turns stay verbatim.
async function compactHistory(settings, conv, history) {
  const limit = Math.max(4, settings.llm.historyLimit || 30);
  if (!settings.llm.compaction || !conv || history.length <= limit) return { summary: conv?.summary || '', patch: null };
  const cutoff = history.length - limit; // messages before this index are summarized
  const doneUpTo = conv.summaryUpTo || 0;
  if (cutoff - doneUpTo < 6 && conv.summary) return { summary: conv.summary, patch: null }; // summarize in batches
  const chunk = history
    .slice(doneUpTo, cutoff)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 2000)}`)
    .join('\n\n');
  try {
    const summary = await complete(
      settings,
      `Update the running summary of a conversation between a user and their assistant. Keep every fact, decision, preference, open question and commitment that could matter later; drop pleasantries. Max ~400 words, bullet points.\n\nCURRENT SUMMARY:\n${conv.summary || '(none)'}\n\nNEW MESSAGES TO FOLD IN:\n${chunk}`,
    );
    log.info('compacted conversation', { conversation: conv.id, upTo: cutoff });
    return { summary: summary.trim(), patch: { summary: summary.trim(), summaryUpTo: cutoff } };
  } catch (err) {
    log.warn('compaction failed', err.message);
    return { summary: conv.summary || '', patch: null };
  }
}

async function runOpenAI({ settings, conv, history, emit, signal, active, system, ctx, images = [] }) {
  const base = trimBase(settings.llm.baseUrl);
  const plain = Boolean(settings.llm.plainHistory);
  if (plain) active = [];
  if (images.length && settings.llm.noVision) {
    emit({ type: 'notice', message: `${router.label(settings.llm.via)} can't see images, so the shared screen was left out of this message.` });
    images = [];
  }
  let model = settings.llm.model;
  if (!model) {
    const models = await listModels(settings).catch(() => []);
    model = models[0]?.id;
    if (!model) throw new Error('No model selected. Choose a model in Settings → AI Brain.');
  }
  const comboKey = `${base}|${model}`;
  let useTools = active.length > 0 && !noToolSupport.has(comboKey);
  const fnTools = active.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const compacted = await compactHistory(settings, conv, history);
  let messages = [{ role: 'system', content: compacted.summary ? `${system}\n\n## Earlier in this conversation (summary)\n${compacted.summary}` : system }, ...openaiHistory(history, settings.llm.historyLimit, { plain })];
  const textOnly = messages;
  messages = withImages(messages, images);
  const turnMessages = []; // what we append during this turn (for faithful replay later)
  const toolRecords = [];
  let fullText = '';
  let servedModel = model;

  for (let round = 0; round < ctx.budget.rounds + 1; round++) {
    const payload = {
      model,
      messages: [...messages, ...turnMessages],
      stream: true,
      temperature: Number(settings.llm.temperature),
      max_tokens: Number(settings.llm.maxTokens) || undefined,
    };
    if (useTools && round < ctx.budget.rounds) payload.tools = fnTools;

    if (fullText && !fullText.endsWith('\n')) {
      fullText += '\n\n';
      emit({ type: 'text', delta: '\n\n' });
    }
    let result;
    try {
      result = await openaiStream({ base, key: settings.llm.apiKey, payload, signal, emit });
    } catch (err) {
      // The model can't take images: retry once without the screenshot.
      if (messages !== textOnly && [400, 404, 415, 422].includes(err.status) && round === 0) {
        messages = textOnly;
        emit({ type: 'notice', message: `Model "${model}" can't see images — continuing without the shared screen.` });
        round--;
        continue;
      }
      // Model/provider doesn't support function calling: retry once without tools.
      if (payload.tools && [400, 404, 415, 422, 500].includes(err.status) && round === 0) {
        noToolSupport.add(comboKey);
        useTools = false;
        emit({ type: 'notice', message: `Model "${model}" rejected tool calls — continuing without tools (memory, calendar and notes are still in context).` });
        round--;
        continue;
      }
      throw err;
    }
    servedModel = result.model || servedModel;
    fullText += result.text;

    if (!result.calls.length) {
      turnMessages.push({ role: 'assistant', content: result.text });
      break;
    }

    const toolCalls = result.calls.map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }));
    turnMessages.push({ role: 'assistant', content: result.text || null, tool_calls: toolCalls });
    emit({ type: 'thinking' });

    const seen = []; // images from tools (look_at_screen): tool messages are text-only, so they follow as a user message
    for (const tc of toolCalls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'Arguments were not valid JSON. Please retry with valid JSON.' }) });
        continue;
      }
      const r = await runTool({ id: tc.id, name: tc.function.name, input }, ctx, emit);
      toolRecords.push(r.record);
      turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: r.content });
      if (r.image && !settings.llm.noVision) seen.push(r.image);
    }
    if (seen.length) turnMessages.push({ role: 'user', content: [{ type: 'text', text: '(The screenshot you asked for.)' }, ...seen.map((url) => ({ type: 'image_url', image_url: { url } }))] });
    if (signal.aborted) break;
  }

  return { text: fullText.trim(), toolCalls: toolRecords, raw: { provider: 'openai', messages: stripImages(turnMessages) }, model: servedModel, convPatch: compacted.patch };
}

// Screenshots are never kept in the stored conversation (size, privacy): replaced by a note.
function stripImages(messages) {
  const isImage = (b) => b?.type === 'image' || b?.type === 'image_url';
  const clean = (content) => {
    if (!Array.isArray(content)) return content;
    return content.map((b) => {
      if (isImage(b)) return { type: 'text', text: '(screenshot, not kept)' };
      if (b?.type === 'tool_result' && Array.isArray(b.content)) return { ...b, content: clean(b.content) };
      return b;
    });
  };
  return messages.map((m) => ({ ...m, content: clean(m.content) }));
}

// ------------------------------------------------------------------- Anthropic
function anthropicClient(settings) {
  if (!settings.anthropic.apiKey) throw new Error('Add your Anthropic API key in Settings → AI Brain.');
  return new Anthropic({ apiKey: settings.anthropic.apiKey, maxRetries: 2 });
}

function anthropicHistory(history) {
  const out = [];
  for (const m of history) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.messages) && m.raw.messages.length) out.push(...m.raw.messages);
      else if (m.content) out.push({ role: 'assistant', content: m.content });
    }
  }
  // Messages must alternate and start with a user turn.
  while (out.length && out[0].role !== 'user') out.shift();
  const merged = [];
  for (const m of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role && typeof prev.content === 'string' && typeof m.content === 'string') prev.content += `\n\n${m.content}`;
    else merged.push(m);
  }
  return merged;
}

// Light schema validation for tool inputs (eager input streaming means the server no longer validates).
function validateInput(tool, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'Input must be a JSON object';
  for (const req of tool.parameters.required || []) if (input[req] === undefined) return `Missing required field "${req}"`;
  for (const [k, v] of Object.entries(input)) {
    const spec = tool.parameters.properties[k];
    if (!spec) continue;
    if (spec.type === 'string' && typeof v !== 'string') return `Field "${k}" must be a string`;
    if (spec.type === 'integer' && !Number.isInteger(v)) return `Field "${k}" must be an integer`;
  }
  return null;
}

function imageBlock(url) {
  const m = dataUrlParts(url);
  return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : null;
}

async function runAnthropic({ settings, history, emit, signal, active, system, ctx, images = [] }) {
  const client = anthropicClient(settings);
  const a = settings.anthropic;
  const model = a.model || 'claude-opus-5-5';
  const isHaiku = model.includes('haiku');
  // The system prompt is rebuilt every turn (fresh memories, calendar, time), so let the API drop
  // replayed thinking blocks whose prefix changed instead of rejecting the request.
  const betas = ['thinking-binding-controls-2026-08-01'];
  if (a.fallbacks && !isHaiku) betas.push('server-side-fallback-2026-07-01');

  const apiTools = active.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true }));
  const messages = anthropicHistory(history);
  const last = messages[messages.length - 1];
  const pictures = images.map(imageBlock).filter(Boolean);
  if (pictures.length && last?.role === 'user' && typeof last.content === 'string') messages[messages.length - 1] = { role: 'user', content: [...pictures, { type: 'text', text: last.content }] };
  const turnMessages = [];
  const toolRecords = [];
  let fullText = '';
  let servedModel = model;
  let jsonRetries = 0;

  for (let round = 0; round < ctx.budget.rounds + 1; round++) {
    const params = {
      model,
      max_tokens: Number(a.maxTokens) || 64000,
      system,
      messages: [...messages, ...turnMessages],
      thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
      output_config: { effort: turnEffort(a.effort, ctx) },
      betas,
    };
    if (apiTools.length) params.tools = apiTools;
    if (a.fallbacks && !isHaiku) params.fallbacks = 'default';

    if (fullText && !fullText.endsWith('\n')) {
      fullText += '\n\n';
      emit({ type: 'text', delta: '\n\n' });
    }
    let roundText = '';
    const stream = client.beta.messages.stream(params, { signal });
    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start') {
        const t = event.content_block.type;
        if (t === 'fallback') {
          // A declined partial is discarded; the fallback model's answer follows.
          if (roundText) emit({ type: 'retract', chars: roundText.length });
          fullText = fullText.slice(0, fullText.length - roundText.length);
          roundText = '';
          emit({ type: 'notice', message: `Switched to ${event.content_block.to?.model || 'a fallback model'} for this reply.` });
        } else if (t === 'thinking' || t === 'redacted_thinking' || t === 'tool_use') emit({ type: 'thinking' });
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        roundText += event.delta.text;
        fullText += event.delta.text;
        emit({ type: 'text', delta: event.delta.text });
      }
    });

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      // Tool input JSON could not be parsed: discard this round and re-issue it.
      if (roundText) emit({ type: 'retract', chars: roundText.length });
      fullText = fullText.slice(0, fullText.length - roundText.length);
      round--;
      continue;
    }
    servedModel = message.model || servedModel;

    if (message.stop_reason === 'refusal') {
      const note = '\n\n*(This request was declined by the model\'s safety system.)*';
      fullText += note;
      emit({ type: 'text', delta: note });
      break;
    }

    const content = message.content.filter((b) => a.fallbacks || b.type !== 'fallback');
    if (content.length) turnMessages.push({ role: 'assistant', content });

    if (message.stop_reason === 'pause_turn') continue;
    const toolUses = message.content.filter((b) => b.type === 'tool_use');
    if (!toolUses.length) break;
    if (message.stop_reason === 'max_tokens') {
      emit({ type: 'notice', message: 'Reply hit the max token limit before a tool call finished.' });
      turnMessages.pop();
      break;
    }

    emit({ type: 'thinking' });
    const results = [];
    for (const tu of toolUses) {
      const def = active.find((t) => t.name === tu.name);
      const problem = def ? validateInput(def, tu.input) : `Unknown tool "${tu.name}"`;
      if (problem) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: JSON.stringify({ INVALID_INPUT: problem }) });
        continue;
      }
      const r = await runTool({ id: tu.id, name: tu.name, input: tu.input }, ctx, emit);
      toolRecords.push(r.record);
      const picture = r.image && imageBlock(r.image);
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: picture ? [{ type: 'text', text: r.content }, picture] : r.content, ...(r.ok ? {} : { is_error: true }) });
    }
    // All results for one assistant message go back in a single user message.
    turnMessages.push({ role: 'user', content: results });
    if (signal.aborted) break;
  }

  // Stored history must end on a complete assistant turn: drop a trailing tool_result turn and any
  // assistant turn whose tool calls never got results (aborted or out of rounds).
  const dangling = (m) => m.role === 'user' || (Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'));
  while (turnMessages.length && dangling(turnMessages[turnMessages.length - 1])) turnMessages.pop();
  return { text: fullText.trim(), toolCalls: toolRecords, raw: turnMessages.length ? { provider: 'anthropic', messages: stripImages(turnMessages) } : null, model: servedModel };
}

module.exports = { runTurn, listModels, testConnection, complete, prewarm, effectiveModel };
