// A conversation's Claude Code session, as one module. Callers say what: run a turn (runTurn), warm this
// conversation (warm, from the window; afterTurn, when a turn changed the session's settings), forget its
// session (a message run again), it was deleted. The module decides how: the session's identity, resume or
// fresh, rollover, the warm model, the cache warm-up, the epochs that make a stale warm-up do nothing, and
// which fields the conversation keeps (claudeSessionId, claudeTokens, claudeFreshTokens). Those come back as
// the turn's `convPatch` for the caller to store; no caller reads or writes them.
// The process side (one CLI process per conversation, resumes, the warm model, the forgotten ids, epochs)
// is claudecode.js, this module's adapter; tests fake the CLI process under it (Session.prototype).
const fsp = require('fs').promises;
const claudecode = require('./claudecode');
const turnprompt = require('./turnprompt');
const tools = require('./tools');
const codebase = require('./codebase');
const obsidian = require('./obsidian');
const github = require('./github');
const router = require('./router');
const pace = require('./pace');
const log = require('./logger');
// llm.js requires this module; its model rule (effectiveModel) is read when needed.
const llm = () => require('./llm');

// ---------------------------------------------------------------- identity
// Fields that define a Claude Code session; changing any of them restarts it (and costs the prompt
// cache), so each is named: the restart's log line says which one changed (claudecode.changedParts).
function configKey(settings) {
  const { agent, appearance, voice, safety, code, web } = settings;
  return JSON.stringify({
    name: agent.name,
    personality: agent.personality,
    aesthetic: agent.aesthetic,
    personaNotes: appearance.personaNotes,
    speaks: voice.ttsEnabled && voice.autoSpeak,
    permissionMode: safety.permissionMode,
    code: code.enabled,
    selfModify: code.allowSelfModify,
    web: web.enabled,
    prompt: PROMPT_VERSION,
  });
}
const PROMPT_VERSION = 19;

// What a session is started with: its configuration, prompt, tools and folders. `facts`: the turn's
// (turnprompt.facts), or none for a session warmed or measured without a turn (the persona's prompt).
async function options(settings, active, model, facts = null) {
  const names = active.map((t) => t.name);
  const [cwd, vault, prompts] = await Promise.all([codebase.root(), obsidian.vaultPath(), turnprompt.forBrain(settings, facts, 'claude-session', { tools: names })]);
  // With GitHub connected, Claude Code may also read and (on work branches) edit the cloned repos.
  let repos = null;
  if (names.includes('github_clone')) {
    repos = await github.workspace();
    await fsp.mkdir(repos, { recursive: true }).catch(() => {});
  }
  return {
    settings,
    configKey: configKey(settings),
    // The stable prompt once when the process starts, the turn's context with each message.
    buildPrompt: prompts.buildPrompt,
    buildContext: prompts.buildContext,
    activeTools: active,
    cwd,
    vault,
    repos,
    // The user's folders (workspace + the ones they added): the only other places Claude Code may read.
    folders: require('./documents').userFolders(settings),
    model,
  };
}

const activeFor = (settings) => (settings.llm.useTools ? tools.activeTools(settings) : []);

/** The session's whole identity (the persona's config key and the process's tools, folders, effort…): a change restarts it. */
async function identity(settings) {
  return claudecode.sessionSpec(await options(settings, await activeFor(settings), '')).key;
}

// The settings a Claude session runs on: the Claude brain itself, or multi-provider mode's Claude when it
// is the first choice (`plan`: asks the router; else taken as is). Null when Claude doesn't answer here.
async function claudeSettings(settings, { plan = true } = {}) {
  if (settings.llm.provider === 'auto') {
    if (plan) {
      const [first] = await router.plan(settings);
      if (first?.id !== 'claude-code') return null;
    }
    return router.concrete(settings, 'claude-code');
  }
  return settings.llm.provider === 'claude-code' ? settings : null;
}

// ---------------------------------------------------------------- saved state
/** Does the conversation have a Claude session to keep? (redo.js: Try again keeps it.) */
const hasSession = (conv) => Boolean(conv?.claudeSessionId);

// What the conversation keeps after a turn: the session to resume (none after a rollover), how big a fresh
// session starts here (rollover is measured from it), and how big the session is now (a cold one well past
// a fresh one isn't resumed: claudecode.startFresh). Only what the turn reported.
function savedAfter({ sessionId, contextTokens, freshTokens }, rolled) {
  const patch = {};
  if (rolled) patch.claudeSessionId = null;
  else if (sessionId) patch.claudeSessionId = sessionId;
  if (freshTokens) patch.claudeFreshTokens = freshTokens;
  if (contextTokens) patch.claudeTokens = rolled ? 0 : contextTokens;
  return patch;
}

// ---------------------------------------------------------------- a turn
/**
 * One turn through the conversation's session (llm.runOn). `active` the tools, `model`/`effort` the pace's
 * choice (the warm model may keep another), `routine` background work (never moves the model, never warms
 * the next session), `facts` the turn's (turnprompt.facts; read from the turn when not given). Returns the
 * reply with `convPatch`, the fields the conversation keeps.
 */
async function runTurn(settings, { conv, history, active, model, effort, routine = false, facts = null, emit, signal, ctx, images = [] }) {
  const setup = Boolean(conv.setup);
  const opts = { ...(await options(settings, active, model, facts || turnprompt.facts({ conv, history, routine }))), effort, routine };
  // The setup interview keeps one stable session even though the answers change the persona.
  if (setup) opts.configKey = 'first-run-setup';
  const { sessionId, contextTokens, freshTokens, ...reply } = await claudecode.runTurn({ ...opts, conv, history, emit, signal, ctx, images });
  // A session grown too big (claudecode.ROLLOVER_TOKENS) is closed now and a fresh one started in the
  // background, so the next message is quick (not after a routine run: nobody writes there next); the
  // conversation then keeps no session id to resume.
  const rolled = !setup && claudecode.needsRollover(contextTokens, freshTokens || conv.claudeFreshTokens);
  if (rolled) {
    claudecode.rollover(conv.id, contextTokens);
    const next = [...history, { role: 'assistant', content: reply.text }];
    if (!routine) warmUp(settings, { id: conv.id, claudeSessionId: null }, opts, { history: next, last: conv.messages }).catch((error) => log.warn('prewarm failed', { error }));
  }
  const patch = { ...(reply.convPatch || {}), ...savedAfter({ sessionId, contextTokens, freshTokens }, rolled) };
  return { ...reply, ...(Object.keys(patch).length ? { convPatch: patch } : {}) };
}

// ---------------------------------------------------------------- warming
// The model and effort the conversation's next message will most likely use: after a spoken message
// the voice model, as for a short spoken greeting (pace.plan); after a typed one the everyday model.
function warmTarget(settings, messages = []) {
  const last = [...messages].reverse().find((m) => m.role === 'user' && !m.routine && !m.hidden);
  const voice = Boolean(last?.spoken);
  const plan = voice ? pace.plan(settings, { text: 'How are you?', voice }) : pace.plan(settings, { text: 'Could you look at this for me and add it?', voice });
  return { model: llm().effectiveModel(settings, { voice, mode: plan.mode }), effort: plan.effort };
}

// Starts the session (unless `started`) and fills its prompt cache (claudecode.warmCache).
// `last`: the messages to guess the next model from, when `history` already has the reply in it.
// epoch: when `history` was read (claudecode.epochOf); a message run again since then makes it stale.
async function warmUp(settings, conv, opts, { history = [], last = history, started = false, epoch = claudecode.epochOf(conv.id) } = {}) {
  if (!started) await claudecode.prewarm(conv, { ...opts, epoch });
  if (settings.claudeCode?.warmCache === false) return;
  await claudecode.warmCache(conv, opts, { ...warmTarget(settings, last), history, epoch });
}

let warmingFor = null;
const WARM_DELAY_MS = 1500;

// Pre-start the session for a conversation (so its next turn is warm) and fill its cache. `epoch`: when
// `conv` was read; a message run again from then on (forget) makes this warm-up stale.
async function prewarm(settings, conv, { epoch = claudecode.epochOf(conv?.id) } = {}) {
  if (!conv) return;
  // Multi-provider mode: warm the Claude session when Claude is the first choice.
  settings = await claudeSettings(settings);
  if (!settings) return;
  // A routine's conversation (or one the app started, `auto`) is only read: its next run comes long after
  // a warm session would have closed, so warming it would spend a hidden message on the plan for nothing.
  const last = [...(conv.messages || [])].reverse().find((m) => m.role === 'user' && !m.hidden);
  if (last?.routine || last?.auto) return;
  const opts = await options(settings, await activeFor(settings), llm().effectiveModel(settings));
  // Opening chats one after another warms only the one that stays open.
  const mine = (warmingFor = conv.id);
  await claudecode.prewarm(conv, { ...opts, epoch });
  await new Promise((r) => setTimeout(r, WARM_DELAY_MS));
  if (warmingFor === mine) await warmUp(settings, conv, opts, { history: conv.messages || [], started: true, epoch });
}

// Runs `fn` after `delayMs` unless a newer request comes first (that one replaces it; the replaced one
// resolves false); `now` runs at once, still replacing a waiting one. warm(): a chat merely opened is
// warmed only once the user stays on it, so browsing History starts one Claude process, not one per chat
// (each ~250–400 MB with its tool servers, and a cold warm-up on the plan).
function settler(delayMs) {
  let waiting = null; // { timer, resolve }
  return function request(fn, { now = false } = {}) {
    if (waiting) {
      clearTimeout(waiting.timer);
      waiting.resolve(false);
      waiting = null;
    }
    if (now) return Promise.resolve().then(fn);
    return new Promise((resolve) => {
      const mine = {
        resolve,
        timer: setTimeout(() => {
          if (waiting === mine) waiting = null;
          Promise.resolve().then(fn).then(resolve, () => resolve(false));
        }, delayMs),
      };
      mine.timer.unref?.();
      waiting = mine;
    });
  };
}
const PREWARM_SETTLE_MS = 4000;
const settle = settler(PREWARM_SETTLE_MS);

/**
 * Warm a conversation's session from the window (main.js llm:prewarm): at launch and after a persona switch
 * `now`; when a chat opens after PREWARM_SETTLE_MS, a newer request replacing a waiting one. Resolves
 * whether it warms. The conversation is read after the request's epoch is taken, so a message run again
 * meanwhile makes the copy stale.
 */
function warm(convId, { now = false } = {}) {
  if (!convId) return Promise.resolve(false);
  const epoch = claudecode.epochOf(convId);
  return settle(async () => {
    const store = require('./store');
    const s = await store.getSettings();
    if (!['claude-code', 'auto'].includes(s.llm.provider) || !s.claudeCode.warmOnLaunch) return false;
    const conv = await store.getConversation(convId);
    if (!conv || conv.setup) return false;
    prewarm(s, conv, { epoch }).catch((error) => log.warn('prewarm failed', { error }));
    return true;
  }, { now });
}

/**
 * After a turn (turns.js): when it changed the session's identity (a persona switch, a tool, a folder, the
 * effort…), the next session starts now, while the reply is read or heard, not when the user speaks again.
 * Resolves when that warm-up is done (or false when there is none).
 */
async function afterTurn(before, after, conv) {
  if (!conv || conv.setup || !after.claudeCode?.warmOnLaunch) return false;
  const target = await claudeSettings(after);
  if (!target) return false;
  if (configKey(after) === configKey(before)) {
    const was = await claudeSettings(before, { plan: false });
    if (was && (await identity(was)) === (await identity(target))) return false;
  }
  await prewarm(after, conv);
  return true;
}

// ---------------------------------------------------------------- forgetting
/** A message run again (Try again / Regenerate / Edit): the session that held the old exchange ends and is never resumed; warm-ups read before now do nothing. */
function forget(convId) {
  claudecode.forget(convId);
}

/** The conversation was deleted: the same (its session ends, a warm-up queued by opening it does nothing). */
const deleted = forget;

/** Takes the session out of a conversation whose exchange is withdrawn (redo.js): forgets it, saved id included, and returns the fields to store. */
function withdraw(conv) {
  claudecode.forget(conv.id, conv.claudeSessionId);
  return { claudeSessionId: null, claudeTokens: 0 };
}

module.exports = { runTurn, warm, afterTurn, forget, deleted, withdraw, hasSession, identity, configKey, prewarm, warmTarget, settler, PREWARM_SETTLE_MS, WARM_DELAY_MS };
