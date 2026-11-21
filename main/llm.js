// LLM providers + the agent tool loop.
//  - "openai": FreeLLMAPI or any OpenAI-compatible server (/v1/chat/completions streaming, /v1/models)
//  - "anthropic": Claude via the official Anthropic SDK (streaming Messages API + tool use)
//  - "claude-code": the user's Claude account via their Claude Code CLI (see claudecode.js)
//  - "auto": several of the above plus Gemini, DeepSeek, Groq and Perplexity, ranked by the user,
//    with per-task routing and automatic fallback (see router.js)
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
// The Anthropic SDK takes ~125 ms to load: only the anthropic brain needs it (test/modules.test.js).
let sdk = null;
const Anthropic = () => (sdk ||= require('@anthropic-ai/sdk'));
const tools = require('./tools');
const prompt = require('./prompt');
const claudecode = require('./claudecode');
// A conversation's Claude Code session: turn, warm-up, rollover, the fields it keeps (claudesession.js).
const claudesession = require('./claudesession');
const approvals = require('./approvals');
const router = require('./router');
const log = require('./logger');
const { isEngineeringTask, toolBudget, upgradeBudget, turnEffort } = require('./engineering');
const pace = require('./pace');
const attachcore = require('./attachcore');
// A local brain's turn: the compact toolset, the nudges, the hand-over, the request quirks (localturn.js).
const localturn = require('./localturn');

// The answer a tool call of the round gets when Stop came before it ran.
const STOPPED_BEFORE = 'Stopped by the user before this ran.';

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
    for await (const m of client.models.list({ limit: 100 }, { timeout: 15000 })) out.push({ id: m.id, name: m.display_name || m.id });
    return out;
  }
  const fixed = router.PROVIDERS[id]?.models; // providers without a /models endpoint
  if (fixed) return fixed.map((m) => ({ id: m, name: m }));
  const res = await fetch(`${trimBase(settings.llm.baseUrl)}/models`, {
    headers: openaiHeaders(settings.llm.apiKey),
    signal: AbortSignal.timeout(10000),
  }).catch((err) => {
    // Nothing answered: say which server (localcore.unreachableMessage), and start FreeLLMAPI when
    // the settings use it (helperapps.onUnreachable, at most every two minutes).
    const plain = require('./localcore').unreachableMessage(settings.llm.baseUrl, err);
    if (!plain) throw err;
    const starting = id === 'openai' && require('./helperapps').onUnreachable('freellmapi', err, settings);
    throw Object.assign(new Error(starting ? `${plain.split(' Start')[0]} Starting it now; load the models again in a minute.` : plain), { cause: err });
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
    const st = await claudecode.status({ fresh: true });
    if (!st.installed) throw new Error(`Claude Code is not installed. Install it with:\n${claudecode.installHint()}`);
    if (st.checked === false) throw new Error(`Couldn't check the Claude account: ${st.error}`);
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
    }, { timeout: 30000 }); // the SDK's default is 10 minutes a try: "Testing…" would sit that long
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
// The model for this turn, honoring the fast/deep mode (switchable by voice) and "fast for voice";
// `mode` overrides both (the turn's pace, pace.js).
function effectiveModel(settings, { voice = false, mode: forced } = {}) {
  const mode = forced || (voice && settings.llm.voiceUsesFast ? 'fast' : settings.llm.modelMode || 'default');
  // 'normal' (pace.js, model mode Default only): the provider's normalModel if it has one, else its model.
  const pick = (cfg, base) => (mode === 'fast' && cfg.fastModel) || (mode === 'deep' && cfg.deepModel) || (mode === 'normal' && cfg.normalModel) || base;
  if (settings.llm.provider === 'claude-code') return pick(settings.claudeCode, settings.claudeCode.model);
  if (settings.llm.provider === 'anthropic') return pick(settings.anthropic, settings.anthropic.model);
  return pick(settings.llm, settings.llm.model);
}

// ------------------------------------------------------------------ hand-over
// A local brain hands a message it can't do well to the Claude brain: when, and to whom, is
// localturn.handOverPlan; here the text it already streamed is taken back and Claude answers.

// The names of the user's connectors ("TickTick"…), when the Claude brain may use them.
async function connectorNames(settings) {
  if (!settings.claudeCode?.connectors) return [];
  const cached = await claudecode.cachedConnectors().catch(() => null);
  return (cached?.list || []).filter((c) => c.source === 'connector').map((c) => c.name.replace(/^claude\.ai\s+/i, '').replace(/[®™]/g, '').trim()).filter(Boolean);
}

async function runSingle(opts) {
  const { settings, conv, history, emit } = opts;
  const narrowed = narrow(settings);
  // The whole message (attached text included): a long attachment is "a long text"; a picture needs Claude's eyes.
  const text = String(history[history.length - 1]?.content || '');
  const plan = await localturn.handOverPlan(settings, narrowed, { setup: Boolean(conv.setup), routine: opts.routine, text, images: (opts.images || []).length, services: () => connectorNames(settings) });
  const target = plan.to;
  const handOver = async (why) => {
    log.info('handed over', { to: target, why });
    emit({ type: 'notice', message: `Handed to ${router.label(target)}: ${why}.` });
    return { ...(await runOn(router.concrete(settings, target), opts)), provider: target, handedOver: why };
  };
  if (plan.now) return handOver(plan.now);
  if (!plan.offer) return { ...(await runOn(narrowed, opts)), provider: settings.llm.provider };
  // What the local model already showed, to take back if it hands over.
  let shown = 0;
  const watch = (ev) => {
    if (ev.type === 'text') shown += ev.delta.length;
    if (ev.type === 'retract') shown -= ev.chars;
    emit(ev);
  };
  const result = await runOn(narrowed, { ...opts, emit: watch, handOverTo: target });
  if (result.handOver) {
    if (shown > 0) emit({ type: 'retract', chars: shown });
    return handOver(result.handOver);
  }
  return { ...result, provider: settings.llm.provider };
}

/**
 * One turn. `images` (data URLs, e.g. the shared screen) go with the newest user message only; they
 * are never stored in the conversation. In multi-provider mode router.runTurn runs it on the best
 * available provider (order, fallback, cooldowns, notices); runOn is its per-provider runner.
 */
async function runTurn(opts) {
  const { settings, conv, history, emit, signal, voice = false } = opts;
  if (settings.llm.provider !== 'auto') return runSingle(opts);
  // The user's words decide the kind of task; attached text makes it a long input, a picture needs a brain that sees.
  const content = String(history[history.length - 1]?.content || '');
  const task = { text: attachcore.withoutBlocks(content), voice, needsTools: Boolean(conv.setup), needsVision: (opts.images || []).length > 0, attachedChars: attachcore.attachedChars(content) };
  return router.runTurn(settings, { ...task, emit, signal }, (concrete, watch) => runOn(concrete, { ...opts, emit: watch }));
}

// handOverTo: the Claude brain a local model may hand this message to (runTurn), or null.
// taint: the outside content this message carries (the shared screen, attached files and images), each a
// source the approval prompts name; imageNoun: how a notice names its pictures ('your image'…).
async function runOn(settings, { conv, history, emit, signal, voice = false, images = [], handOverTo = null, routine = false, again = null, taint = [], imageNoun = '' }) {
  const setup = Boolean(conv.setup);
  const active = setup || settings.llm.useTools ? await tools.activeTools(settings, { setup }) : [];
  const names = active.map((t) => t.name);
  // logTags: tool calls that arrive later through other channels (the MCP bridge, the Claude Code
  // process's output) are logged under this turn too.
  // The user's own words: pace, engineering, tool hints, recall and the log never read a whole attached PDF.
  const lastContent = String(history[history.length - 1]?.content || '');
  const lastText = attachcore.withoutBlocks(lastContent);
  const attached = attachcore.attachedChars(lastContent);
  // The persona that wrote the latest reply (stored on it since 2.7.10): a switch mid-conversation is named.
  const previousPersona = require('./personacore').lastPersona(history);
  // Spoken turns stay quick unless they actually start engineering work (upgraded in runTool).
  // A routine's own instructions ("fix the errors in…") are not a request for code work.
  const engineering = !setup && !voice && !routine && isEngineeringTask(lastText);
  // How much thinking this message needs (pace.js): a lookup gets the fast model at low effort.
  const base = settings.llm.provider === 'claude-code' ? settings.claudeCode.effort : settings.llm.provider === 'anthropic' ? settings.anthropic.effort : 'default';
  // A routine's long instructions read as "deep" and ran on Opus; syncing lists and briefings is everyday
  // work (the normal model, Sonnet with Claude), unless the user set a model mode themselves.
  const paced = routine && settings.llm?.autoPace !== false && (settings.llm?.modelMode || 'default') === 'default' ? { pace: 'routine', mode: 'normal', effort: base } : pace.plan(settings, { text: lastText, voice, setup, engineering, base, attached });
  const ctx = { emit, turn: approvals.newTurn({ signal, userText: lastText }), signal, logTags: log.context(), budget: toolBudget(settings, engineering), effort: paced.effort, pace: paced.pace };
  // A routine works on its own (a sync can take many steps): the larger number of rounds, not code work's effort.
  if (routine) ctx.budget.rounds = ctx.budget.deep;
  // A screenshot or an attached file can contain anything (web pages, emails): it is external content.
  for (const source of taint.length ? taint : images.length ? ['the shared screen'] : []) approvals.markTainted(ctx.turn, source);
  // Trying again in the same session: what the earlier attempt read is still in its context.
  if (again?.taint) approvals.markTainted(ctx.turn, 'the earlier attempt at this message');
  ctx.imageNoun = imageNoun || 'the shared screen';
  const model = effectiveModel(settings, { voice, mode: paced.mode });
  log.info('turn', { provider: settings.llm.via || settings.llm.provider, model: model || 'default', pace: paced.pace, effort: paced.effort, voice, setup, engineering: engineering || undefined, images: images.length || undefined, attachments: history[history.length - 1]?.attachments?.length || undefined, conversation: conv.id, chars: lastText.length });
  log.debug('turn text', { text: lastText.slice(0, 200) });
  if (settings.llm.provider === 'claude-code') {
    // The conversation's session (claudesession.js): resume or fresh, the warm model (a routine never moves
    // it), rollover, and the fields the conversation keeps (its convPatch).
    const buildContext = setup ? async () => prompt.buildSetup(await require('./store').getSettings()).context : (memIds) => prompt.turnContext(settings, names, memIds || [], { query: lastText, previousPersona, spoken: voice, again: again?.note || '' });
    return claudesession.runTurn(settings, { conv, history, active, model, effort: paced.effort, routine, buildContext, emit, signal, ctx, images });
  }
  // A local model gets the compact prompt, the everyday tools and more on request (localturn.js).
  if (!setup && localturn.wantsCompact(settings)) {
    const local = localturn.begin({ settings, conv, active, lastText, catalog: tools.TOOLS, handOverTo });
    ctx.localTurn = local; // tools_more and hand_over (tools/toolbox.js), and runOpenAI's hooks
    const built = await prompt.buildCompact(settings, local.promptTools, { query: lastText, previousPersona, spoken: voice, again: again?.note || '' });
    log.info('compact prompt', { model: model || settings.llm.model, tools: local.tools.length, groups: local.groups.join(',') || undefined, chars: built.system.length });
    const { system, turnNote } = local.prompt(built);
    return local.finish(await runOpenAI({ settings: withModel(settings, 'llm', model), conv, history, emit, signal, active: local.tools, system, turnNote, ctx, images }));
  }
  const { system, stable, context } = setup ? prompt.buildSetup(settings) : await prompt.build(settings, names, { query: lastText, previousPersona, spoken: voice, again: again?.note || '' });
  if (settings.llm.provider === 'anthropic') return runAnthropic({ settings: withModel(settings, 'anthropic', model), conv, history, emit, signal, active, system, stable, context, ctx, images });
  return runOpenAI({ settings: withModel(settings, 'llm', model), conv, history, emit, signal, active, system, ctx, images });
}

function withModel(settings, section, model) {
  return model ? { ...settings, [section]: { ...settings[section], model } } : settings;
}

// Single non-streaming completion with whichever provider is configured (used for persona/theme
// generation). `image` is an optional data URL the model may look at.
async function complete(settings, text, opts = {}) {
  if (settings.llm.provider !== 'auto') return completeOn(narrow(settings), text, opts);
  return router.complete(settings, text, (concrete) => completeOn(concrete, text, opts));
}

// maxTokens: room for a long reply (a drawing) on the OpenAI-style path; the others already have it.
async function completeOn(settings, text, { image, maxTokens, timeoutMs } = {}) {
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
    return claudecode.complete(text, { imagePath, model: settings.claudeCode.model, timeoutMs });
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
    }, { timeout: Math.max(180000, Number(timeoutMs) || 0) }); // as the OpenAI path below
    if (msg.stop_reason === 'refusal') throw new Error('The model declined this request.');
    return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  const chatModel = settings.llm.model || (await listModels(settings).catch(() => []))[0]?.id;
  const res = await fetch(`${trimBase(settings.llm.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: openaiHeaders(settings.llm.apiKey),
    body: JSON.stringify({ model: chatModel, temperature: 0.8, max_tokens: Math.max(3000, Number(maxTokens) || 0), messages: [{ role: 'user', content: text }] }),
    signal: AbortSignal.timeout(Math.max(180000, Number(timeoutMs) || 0)),
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
// Attached files' text goes only with its own message (newestChars of it: a local model's small context);
// older messages keep the files' headers and saved paths (attachcore.headersOnly).
function openaiHistory(history, limit, { plain = false, newestChars = Infinity } = {}) {
  const recent = history.slice(-Math.max(2, limit || 30));
  while (recent.length && recent[0].role !== 'user') recent.shift();
  const out = [];
  for (const [i, m] of recent.entries()) {
    if (m.role === 'user') {
      const content = !m.attachments?.length ? m.content : i === recent.length - 1 ? attachcore.fitBlocks(m.content, newestChars) : attachcore.headersOnly(m.content);
      out.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
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
async function compactHistory(settings, conv, history, limit = Math.max(4, settings.llm.historyLimit || 30)) {
  if (!settings.llm.compaction || !conv || history.length <= limit) return { summary: conv?.summary || '', patch: null };
  const cutoff = history.length - limit; // messages before this index are summarized
  const doneUpTo = conv.summaryUpTo || 0;
  if (cutoff - doneUpTo < 6 && conv.summary) return { summary: conv.summary, patch: null }; // summarize in batches
  // A message with attachments counts as what was typed and the files' names and saved paths.
  const chunk = history
    .slice(doneUpTo, cutoff)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.role === 'user' && m.attachments?.length ? attachcore.summaryLine(m) : String(m.content || '')).slice(0, 2000)}`)
    .join('\n\n');
  try {
    const summary = await complete(
      settings,
      `Update the running summary of a conversation between a user and their assistant. Keep every fact, decision, preference, open question and commitment that could matter later; drop pleasantries. Max ~400 words, bullet points.\n\nCURRENT SUMMARY:\n${conv.summary || '(none)'}\n\nNEW MESSAGES TO FOLD IN:\n${chunk}`,
    );
    log.info('compacted conversation', { conversation: conv.id, upTo: cutoff });
    return { summary: summary.trim(), patch: { summary: summary.trim(), summaryUpTo: cutoff } };
  } catch (err) {
    log.warn('compaction failed', { error: err });
    return { summary: conv.summary || '', patch: null };
  }
}

// turnNote: this message's context, placed just before the newest user message instead of in the
// system prompt (local servers, see runOn; localcore.placeNote), so the unchanged start is reused.
async function runOpenAI({ settings, conv, history, emit, signal, active, system, turnNote = '', ctx, images = [] }) {
  const base = trimBase(settings.llm.baseUrl);
  const plain = Boolean(settings.llm.plainHistory);
  if (plain) active = [];
  // toast: the Face layout hides the message list, so the notice also shows as a toast (chat.js).
  if (images.length && settings.llm.noVision) {
    emit({ type: 'notice', message: `${router.label(settings.llm.via)} can't see images, so ${ctx.imageNoun || 'the shared screen'} was left out of this message. Switch to Claude to ask about it.`, toast: true });
    images = [];
  }
  let model = settings.llm.model;
  if (!model) {
    const models = await listModels(settings).catch(() => []);
    model = models[0]?.id;
    if (!model) throw new Error('No model selected. Choose a model in Settings → AI Brain.');
  }
  // What this server refused before, and which retry a refusal now gets (localturn.requestQuirks).
  const quirks = localturn.requestQuirks({ settings, base, model, tools: active.length > 0, note: turnNote });
  // The compact prompt's turn (runOn): its tools, nudges, refusals and hand-over; null on any other turn.
  const local = ctx.localTurn || null;
  // Built per round: tools_more (a local model's toolset) can add tools mid-turn.
  const fnTools = () => (plain ? [] : local?.tools || active).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

  const compacted = await compactHistory(settings, conv, history);
  const plainMessages = [{ role: 'system', content: compacted.summary ? `${system}\n\n## Earlier in this conversation (summary)\n${compacted.summary}` : system }, ...openaiHistory(history, settings.llm.historyLimit, { plain, newestChars: localturn.isLocalBrain(settings) ? attachcore.LIMITS.localChars : Infinity })];
  const { placeNote } = require('./localcore');
  let textOnly = placeNote(plainMessages, turnNote, { asSystem: quirks.noteAsSystem });
  let messages = withImages(textOnly, images);
  const turnMessages = []; // what we append during this turn (for faithful replay later)
  const toolRecords = [];
  let fullText = '';
  let servedModel = model;
  const unstored = new WeakSet(); // a local turn's nudges (below): in the turn, not in the stored conversation

  for (let round = 0; round < ctx.budget.rounds + 1; round++) {
    const payload = {
      model,
      messages: [...messages, ...turnMessages],
      stream: true,
      temperature: Number(settings.llm.temperature),
      max_tokens: Number(settings.llm.maxTokens) || undefined,
    };
    if (quirks.useTools && round < ctx.budget.rounds) payload.tools = fnTools();
    Object.assign(payload, quirks.extras(ctx.pace));

    if (fullText && !fullText.endsWith('\n')) {
      fullText += '\n\n';
      emit({ type: 'text', delta: '\n\n' });
    }
    let result;
    try {
      result = await openaiStream({ base, key: settings.llm.apiKey, payload, signal, emit });
    } catch (err) {
      const retry = quirks.retry(err, { round, payload, imaged: messages !== textOnly });
      if (!retry) throw err;
      // The model can't take images: once more without the screenshot.
      if (retry === 'images') {
        messages = textOnly;
        emit({ type: 'notice', message: `Model "${model}" can't see images — continuing without ${ctx.imageNoun || 'the shared screen'}.`, toast: true });
      }
      // A template that refuses a system message after the first: the notes go into the user's message.
      if (retry === 'note') {
        const imaged = messages !== textOnly;
        textOnly = placeNote(plainMessages, turnNote, { asSystem: false });
        messages = imaged ? withImages(textOnly, images) : textOnly;
      }
      // 'extras': the next payload leaves keep_alive and reasoning_effort out (quirks.extras).
      // Model/provider doesn't support function calling: once more without tools (quirks.useTools).
      if (retry === 'tools') emit({ type: 'notice', message: `Model "${model}" rejected tool calls — continuing without tools (memory, calendar and notes are still in context).` });
      round--;
      continue;
    }
    servedModel = result.model || servedModel;

    // A local model's reply that gave up unlooked or claimed an action no tool did: taken back, and the
    // model asked once (localturn afterReply). Sent, never stored.
    const nudge = local?.afterReply(result, { round, rounds: ctx.budget.rounds, useTools: quirks.useTools, noteRole: quirks.noteRole, model });
    if (nudge) {
      if (result.text) emit({ type: 'retract', chars: result.text.length });
      for (const m of nudge) unstored.add(m);
      turnMessages.push(...nudge);
      continue;
    }
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
      // Stopped: nothing more runs, and every call still gets an answer (the stored history stays valid).
      if (signal.aborted) {
        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: STOPPED_BEFORE }) });
        continue;
      }
      let input;
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch {
        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: 'Arguments were not valid JSON. Please retry with valid JSON.' }) });
        continue;
      }
      // A local model asked a question ("Can I fit a gym session in?") changes nothing: it answers.
      const refusal = local?.beforeTool(tc.function.name);
      if (refusal) {
        turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: refusal }) });
        continue;
      }
      const r = await runTool({ id: tc.id, name: tc.function.name, input }, ctx, emit);
      toolRecords.push(r.record);
      turnMessages.push({ role: 'tool', tool_call_id: tc.id, content: r.content });
      if (r.image && !settings.llm.noVision) seen.push(r.image);
      // A tool that changed something: no claim check, and this turn is never handed over.
      local?.afterTool(r.record);
    }
    if (seen.length) turnMessages.push({ role: 'user', content: [{ type: 'text', text: '(The screenshot you asked for.)' }, ...seen.map((url) => ({ type: 'image_url', image_url: { url } }))] });
    if (signal.aborted) break;
    // Handed over (tool hand_over): the other brain answers; nothing more from this one.
    if (local?.handedOver) break;
  }

  return { text: fullText.trim(), toolCalls: toolRecords, raw: { provider: 'openai', messages: stripImages(turnMessages.filter((m) => !unstored.has(m))) }, model: servedModel, convPatch: compacted.patch };
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
  return new (Anthropic())({ apiKey: settings.anthropic.apiKey, maxRetries: 2 });
}

// The Claude API conversation: the last `limit` messages (older ones live in the rolling summary), and
// the full tool exchanges (tool calls, results, thinking) only for the last `rawReplies` replies; older
// replies are sent as their text. Keeps long conversations inside the context window and cheaper.
const API_HISTORY = 60;
const API_RAW_REPLIES = 6;

// Attached files' text is sent again only for the newest `fullAttachments` messages that carry files; older
// ones keep the headers with the saved paths (attachcore.headersOnly), so a long chat doesn't resend every PDF.
function anthropicHistory(history, { limit = API_HISTORY, rawReplies = API_RAW_REPLIES, fullAttachments = attachcore.LIMITS.fullAttachmentMessages } = {}) {
  const recent = history.slice(-limit);
  const replies = recent.filter((m) => m.role === 'assistant');
  const rawFrom = replies.length - rawReplies;
  const withFiles = recent.filter((m) => m.role === 'user' && m.attachments?.length);
  const full = new Set(fullAttachments > 0 ? withFiles.slice(-fullAttachments) : []);
  let reply = 0;
  const out = [];
  for (const m of recent) {
    if (m.role === 'user') out.push({ role: 'user', content: m.attachments?.length && !full.has(m) ? attachcore.headersOnly(m.content) : m.content });
    else if (m.role === 'assistant') {
      const keepRaw = reply++ >= rawFrom;
      if (keepRaw && m.raw?.provider === 'anthropic' && Array.isArray(m.raw.messages) && m.raw.messages.length) out.push(...m.raw.messages);
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

// Prompt caching: the tools, the stable system prompt and the conversation so far are cache prefixes
// (they are the same on every tool round of a turn, and the stable prompt across turns).
const CACHE = { type: 'ephemeral' };

function withCacheMark(message) {
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : [...message.content];
  if (!content.length) return message;
  content[content.length - 1] = { ...content[content.length - 1], cache_control: CACHE };
  return { ...message, content };
}

// The images go first in the newest user message, whatever shape its content has: withCacheMark has made
// it a block list by now (a check for a string here once dropped every image on this brain), and the cache
// mark stays on its last text block.
function withPictures(messages, pictures) {
  const last = messages[messages.length - 1];
  if (!pictures.length || last?.role !== 'user') return messages;
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  return [...messages.slice(0, -1), { ...last, content: [...pictures, ...blocks] }];
}

async function runAnthropic({ settings, conv, history, emit, signal, active, system, stable, context, ctx, images = [] }) {
  const client = anthropicClient(settings);
  const a = settings.anthropic;
  const model = a.model || 'claude-opus-5-5';
  const isHaiku = model.includes('haiku');
  // The system prompt is rebuilt every turn (fresh memories, calendar, time), so let the API drop
  // replayed thinking blocks whose prefix changed instead of rejecting the request.
  const betas = ['thinking-binding-controls-2026-08-01'];
  if (a.fallbacks && !isHaiku) betas.push('server-side-fallback-2026-07-01');

  const apiTools = active.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true }));
  if (apiTools.length) apiTools[apiTools.length - 1] = { ...apiTools[apiTools.length - 1], cache_control: CACHE };
  // Older turns beyond the window are folded into a rolling summary (stored on the conversation).
  const compacted = await compactHistory(settings, conv, history, API_HISTORY);
  const summary = compacted.summary ? `## Earlier in this conversation (summary)\n${compacted.summary}\n\n` : '';
  const systemBlocks = stable != null ? [{ type: 'text', text: stable, cache_control: CACHE }, { type: 'text', text: `${summary}${context || ''}` }] : [{ type: 'text', text: `${system}${summary ? `\n\n${summary}` : ''}` }];
  let messages = anthropicHistory(history);
  if (messages.length) messages[messages.length - 1] = withCacheMark(messages[messages.length - 1]);
  messages = withPictures(messages, images.map(imageBlock).filter(Boolean));
  const turnMessages = [];
  const toolRecords = [];
  let fullText = '';
  let servedModel = model;
  let jsonRetries = 0;

  for (let round = 0; round < ctx.budget.rounds + 1; round++) {
    const params = {
      model,
      max_tokens: Number(a.maxTokens) || 64000,
      system: systemBlocks,
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
      if (err instanceof Anthropic().APIError || jsonRetries++ >= 2) throw err;
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
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: STOPPED_BEFORE });
        continue;
      }
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
  return { text: fullText.trim(), toolCalls: toolRecords, raw: turnMessages.length ? { provider: 'anthropic', messages: stripImages(turnMessages) } : null, model: servedModel, convPatch: compacted.patch };
}

module.exports = {
  anthropicHistory, openaiHistory, withPictures, withCacheMark, runTurn, listModels, testConnection, complete, effectiveModel };
