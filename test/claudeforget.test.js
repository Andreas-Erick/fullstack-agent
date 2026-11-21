// Claude Code sessions when a message is run again (main/claudecode.js): a withdrawn exchange never stays
// in the context (forget: its session ids are never resumed, warm-ups read before it don't run), and a
// plan's limit that comes back as the reply is an error, not Siren's words.
// Then a conversation's session through its own interface (main/claudesession.js: runTurn, warm, afterTurn,
// forget, withdraw) over the real claudecode.js with the CLI process faked.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

// What claudesession.warm reads: the settings and the conversation (a test may hold the read).
const storeStub = { getSettings: async () => ({}), getConversation: async () => null };
let routerFirst = 'claude-code';
stub({
  './store': storeStub,
  './bridge': {},
  './github': {},
  './logger': quietLog,
  './approvals': { gate: async () => ({ allow: true }), markTainted: () => {} },
  './prompt': { build: async () => ({ stable: 'p', memIds: [] }), buildSetup: () => ({ stable: 'setup', memIds: [] }) },
  './tools': { activeTools: async () => [] },
  './codebase': { root: async () => process.cwd() },
  './obsidian': { vaultPath: async () => null },
  './documents': { userFolders: () => [] },
  './router': { plan: async () => [{ id: routerFirst }], concrete: (s, id) => ({ ...s, llm: { ...s.llm, provider: id, via: id } }) },
  './llm': { effectiveModel: (s) => s.claudeCode.model },
});
const claudecode = load('main/claudecode.js');
const claudesession = load('main/claudesession.js'); // over the claudecode.js instance above

function session() {
  const sess = new claudecode.Session('c1');
  sess.child = { exitCode: null, stdin: { write() {} }, once() {}, pid: 1 };
  sess.dead = false;
  sess.spec = { idleMinutes: 20 };
  return sess;
}
const result = (text) => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's1' });

// Regression: "You've hit your limit · resets 5pm" came back as a successful result, was saved as the
// reply, and multi-provider mode never moved on to the next brain.
test('Claude’s "You’ve hit your limit" result is an error; ordinary words about limits are not', async () => {
  const sess = session();
  const turn = sess.send('hi', { emit() {}, signal: new AbortController().signal, ctx: {} });
  sess.onLine(result("You've hit your limit · resets 5pm (Europe/Berlin)"));
  await assert.rejects(turn, /hit your limit/);

  const ok = session();
  const fine = ok.send('how am I doing?', { emit() {}, signal: new AbortController().signal, ctx: {} });
  ok.onLine(result("You've hit your stride today!"));
  assert.strictEqual((await fine).text, "You've hit your stride today!");
  const limits = session();
  const words = limits.send('speed?', { emit() {}, signal: new AbortController().signal, ctx: {} });
  limits.onLine(result('You have hit your limit of three coffees, it seems.'));
  assert.match((await words).text, /three coffees/, 'no reset time: the user’s own topic');
  // A reply about another service's limit, with its reset time, but not in the CLI's own form.
  const weather = session();
  const api = weather.send('why no forecast?', { emit() {}, signal: new AbortController().signal, ctx: {} });
  weather.onLine(result("You've hit your daily limit on OpenWeather; it resets at midnight."));
  assert.match((await api).text, /OpenWeather/);
  // The older CLI's wording.
  const older = session();
  const five = older.send('hi', { emit() {}, signal: new AbortController().signal, ctx: {} });
  older.onLine(result('5-hour limit reached ∙ resets 3am'));
  await assert.rejects(five, /5-hour limit reached/);
  for (const s of [sess, ok, limits, weather, older]) clearTimeout(s.idleTimer); // a session's idle timer would keep the test running
});

// Fake processes (as in claudesession.test.js): each spawn is recorded with what it resumes, each message
// written is kept, and the fake CLI answers every message at once.
// `answer.tokens`: each answer reports one call of that size; `answer.fail`: the next message fails before
// any output, with that error (a process that never started the turn).
function fakeCli(answer = {}) {
  const spawns = [];
  const writes = [];
  const live = [];
  const realSpawn = claudecode.Session.prototype.spawn;
  const realSend = claudecode.Session.prototype.send;
  claudecode.Session.prototype.spawn = async function (spec) {
    spawns.push({ conv: this.convId, resume: spec.resume || this.resumable || null });
    this.child = { exitCode: null, stdin: { write: (s) => writes.push(JSON.parse(s)) }, once() {}, kill() {}, pid: -1 };
    live.push(this);
    this.dead = false;
    this.spec = spec;
    this.key = spec.key;
    this.requestedModel = spec.model || 'default';
    this.resumed = Boolean(spec.resume);
    this.sentAny = false;
  };
  claudecode.Session.prototype.send = function (...a) {
    if (answer.fail) {
      const err = new Error(answer.fail);
      answer.fail = '';
      return Promise.reject(err);
    }
    const p = realSend.apply(this, a);
    setImmediate(() => {
      if (answer.tokens) this.onLine(JSON.stringify({ type: 'assistant', message: { content: [], usage: { input_tokens: 1, cache_read_input_tokens: answer.tokens - 1, cache_creation_input_tokens: 0 } } }));
      this.onLine(result('ok'));
    });
    return p;
  };
  // Ended before the next step, so a kill never signals a real pid (and never waits for one).
  const settle = () => live.forEach((s) => ((s.child.exitCode = 0), clearTimeout(s.idleTimer)));
  const restore = () => {
    settle();
    claudecode.Session.prototype.spawn = realSpawn;
    claudecode.Session.prototype.send = realSend;
  };
  return { spawns, writes, settle, restore, users: () => writes.filter((w) => w.type === 'user') };
}

const settings = { claudeCode: {}, web: { enabled: false }, code: { allowSelfModify: false }, extensions: {}, perf: { mode: 'full' } };
const opts = (extra = {}) => ({ settings, configKey: 'k', activeTools: [], cwd: process.cwd(), model: 'haiku', buildPrompt: async () => ({ stable: 'p', memIds: [] }), ...extra });
const kept = [{ role: 'user', content: 'Remember the robotics lab' }, { role: 'assistant', content: 'Noted.' }];
const dropped = [...kept, { role: 'user', content: 'Add a DROPPED dentist' }, { role: 'assistant', content: 'Added the DROPPED dentist.' }];
const turn = (conv, history) => claudecode.runTurn({ conv, history, buildContext: async () => '', emit() {}, signal: new AbortController().signal, ctx: {}, ...opts() });

test('after forget, the old session is never resumed, also from a stale copy of the conversation', async () => {
  const cli = fakeCli();
  try {
    const stale = { id: 'f1', claudeSessionId: 'old' };
    await turn(stale, [...dropped.slice(0, 3)]);
    assert.deepStrictEqual(cli.spawns[0], { conv: 'f1', resume: 'old' }, 'before: resumed as usual');
    cli.settle();
    claudecode.forget('f1', 'old');
    // A prewarm that read the conversation before it was saved still names the old session.
    await claudecode.prewarm(stale, opts());
    assert.deepStrictEqual(cli.spawns[1], { conv: 'f1', resume: null });
    cli.settle();
    claudecode.endSession('f1');
    // The turn that runs the message again: a fresh session whose first message carries the kept history only.
    await turn(stale, [...kept, { role: 'user', content: 'Add the dentist at noon' }]);
    assert.deepStrictEqual(cli.spawns[2], { conv: 'f1', resume: null });
    const first = cli.users().at(-1).message.content;
    assert.match(first, /^\[Earlier in this conversation/);
    assert.match(first, /robotics lab/);
    assert.doesNotMatch(first, /DROPPED/);
    // The ids the live session had are forgotten too, without being named: the conversation stored
    // the one its turn answered under (s1, main.js result.sessionId).
    cli.settle();
    await turn({ id: 'f2', claudeSessionId: 'live-a' }, kept);
    cli.settle();
    claudecode.forget('f2');
    await turn({ id: 'f2', claudeSessionId: 's1' }, kept);
    assert.strictEqual(cli.spawns.at(-1).resume, null);
  } finally {
    cli.restore();
    for (const id of ['f1', 'f2']) claudecode.endSession(id);
  }
});

test('a warm-up read before forget does nothing: queued, or still starting its session', async () => {
  const cli = fakeCli();
  try {
    const conv = { id: 'f3' };
    const before = claudecode.epochOf('f3');
    claudecode.forget('f3');
    assert.strictEqual(claudecode.epochOf('f3'), before + 1);
    assert.strictEqual(await claudecode.warmCache(conv, opts(), { model: 'haiku', history: dropped, epoch: before }), null);
    await claudecode.prewarm(conv, opts({ epoch: before }));
    assert.strictEqual(cli.spawns.length, 0, 'no process for the old messages');
    assert.strictEqual(cli.writes.length, 0, 'nothing written');

    // Starting its session (the prompt takes a moment) when the message is run again: it sends nothing.
    const epoch = claudecode.epochOf('f4');
    const slow = opts({ buildPrompt: () => new Promise((r) => setTimeout(() => r({ stable: 'p', memIds: [] }), 40)) });
    const warm = claudecode.warmCache({ id: 'f4' }, slow, { model: 'haiku', history: dropped, epoch });
    await new Promise((r) => setTimeout(r, 10));
    claudecode.forget('f4');
    assert.strictEqual(await warm, null);
    assert.strictEqual(cli.users().length, 0, 'the old messages never reach a session');

    // The current epoch warms as before.
    const ok = await claudecode.warmCache({ id: 'f5' }, opts(), { model: 'haiku', history: kept, epoch: claudecode.epochOf('f5') });
    assert.strictEqual(ok.text, 'ok');
    assert.match(cli.users().at(-1).message.content, /robotics lab/);
  } finally {
    cli.restore();
    for (const id of ['f3', 'f4', 'f5']) claudecode.endSession(id);
  }
});

// ------------------------------------------------------------ claudesession.js, through its interface
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CC = { model: 'sonnet', effort: 'default', warmOnLaunch: true, warmCache: true };
const full = (extra = {}) => ({
  agent: { name: 'Siren', personality: 'p', aesthetic: '' },
  appearance: { personaNotes: '' },
  voice: { ttsEnabled: false, autoSpeak: false },
  safety: { permissionMode: 'ask' },
  code: { enabled: false, allowSelfModify: false },
  web: { enabled: false },
  extensions: {},
  perf: { mode: 'full' },
  llm: { provider: 'claude-code', useTools: true },
  claudeCode: { ...CC },
  ...extra,
});
const quiet = { claudeCode: { ...CC, warmCache: false } }; // the session starts, no warm-up message
const runOf = (settings, conv) => (history, extra = {}) => claudesession.runTurn(settings, { conv, history, active: [], model: 'sonnet', effort: 'default', buildContext: async () => '', emit() {}, signal: new AbortController().signal, ctx: {}, ...extra });

// Regression: the warm-up's epoch was taken after the conversation was read, so a read that began before a
// Regenerate's save and ended after its forget passed both checks with the withdrawn messages. The order is
// warm()'s own now (main.js llm:prewarm only asks).
test('a warm-up asked for before a message is run again does nothing, even when its read ends after the forget', async () => {
  const cli = fakeCli();
  try {
    storeStub.getSettings = async () => full();
    let release;
    const held = new Promise((r) => (release = r));
    storeStub.getConversation = async (id) => (await held, { id, messages: dropped });
    const asked = claudesession.warm('w1', { now: true });
    await sleep(5);
    claudesession.forget('w1'); // Regenerate's forget lands while the window's read is still out
    release();
    assert.strictEqual(await asked, true);
    await sleep(claudesession.WARM_DELAY_MS + 200);
    assert.strictEqual(cli.spawns.length, 0, 'no process for the old messages');
    assert.strictEqual(cli.users().length, 0, 'nothing sent');

    // Asked after the forget: warmed with what the conversation holds now.
    storeStub.getConversation = async (id) => ({ id, messages: kept });
    assert.strictEqual(await claudesession.warm('w1', { now: true }), true);
    await sleep(claudesession.WARM_DELAY_MS + 200);
    assert.strictEqual(cli.spawns.length, 1);
    const sent = cli.users().at(-1).message.content;
    assert.match(sent, /warm-up/);
    assert.match(sent, /robotics lab/);
    assert.doesNotMatch(sent, /DROPPED/);
  } finally {
    cli.restore();
    claudecode.endSession('w1');
  }
});

// Regression (architecture review): main.js refused to warm unless the brain was 'claude-code', while the
// prewarm itself handled multi-provider mode, so a chat opened in 'auto' was never warmed.
test('warm: in multi-provider mode a chat is warmed when Claude is the router’s first choice, else nothing', async () => {
  const cli = fakeCli();
  try {
    storeStub.getConversation = async (id) => ({ id, messages: kept });
    storeStub.getSettings = async () => full({ ...quiet, llm: { provider: 'auto', useTools: true } });
    routerFirst = 'claude-code';
    assert.strictEqual(await claudesession.warm('a1', { now: true }), true);
    await sleep(50);
    assert.deepStrictEqual(cli.spawns.map((s) => s.conv), ['a1']);
    routerFirst = 'gemini';
    await claudesession.warm('a2', { now: true });
    await sleep(50);
    assert.deepStrictEqual(cli.spawns.map((s) => s.conv), ['a1'], 'Claude isn’t first: no session');
    // Another brain, warming off in Settings, the setup conversation, no conversation id: false at once.
    storeStub.getSettings = async () => full({ llm: { provider: 'openai', useTools: true } });
    assert.strictEqual(await claudesession.warm('a3', { now: true }), false);
    storeStub.getSettings = async () => full({ claudeCode: { ...CC, warmOnLaunch: false } });
    assert.strictEqual(await claudesession.warm('a3', { now: true }), false);
    storeStub.getSettings = async () => full();
    storeStub.getConversation = async (id) => ({ id, setup: true, messages: [] });
    assert.strictEqual(await claudesession.warm('a3', { now: true }), false);
    assert.strictEqual(await claudesession.warm('', { now: true }), false);
    assert.strictEqual(cli.spawns.length, 1);
  } finally {
    routerFirst = 'claude-code';
    await sleep(claudesession.WARM_DELAY_MS + 100); // a1's delayed step finds warmCache off and sends nothing
    cli.restore();
    for (const id of ['a1', 'a2', 'a3']) claudecode.endSession(id);
  }
});

// Regression (architecture review): after a turn the next session was warmed only when the persona's half of
// the key changed; a turn that changed the effort, a tool or a folder restarted the session cold at the next message.
test('afterTurn warms the next session when any part of its identity changed, not only the persona', async () => {
  const cli = fakeCli();
  try {
    const conv = { id: 'p1', messages: kept };
    const before = full(quiet);
    assert.strictEqual(await claudesession.afterTurn(before, before, conv), false, 'nothing changed');
    assert.strictEqual(cli.spawns.length, 0);
    // A settings change in the turn: the same persona, another session (claudecode keyParts' effort).
    const effort = { ...before, claudeCode: { ...before.claudeCode, effort: 'high' } };
    assert.notStrictEqual(await claudesession.identity(before), await claudesession.identity(effort));
    assert.strictEqual(await claudesession.afterTurn(before, effort, conv), true);
    assert.strictEqual(cli.spawns.length, 1);
    // A persona switch.
    const persona = { ...effort, agent: { ...effort.agent, name: 'Hastur' } };
    assert.strictEqual(await claudesession.afterTurn(effort, persona, { id: 'p2', messages: kept }), true);
    assert.deepStrictEqual(cli.spawns.map((s) => s.conv), ['p1', 'p2']);
    // Warming off, or the setup conversation: never.
    assert.strictEqual(await claudesession.afterTurn(before, { ...persona, claudeCode: { ...persona.claudeCode, warmOnLaunch: false } }, conv), false);
    assert.strictEqual(await claudesession.afterTurn(before, persona, { ...conv, setup: true }), false);
    assert.strictEqual(cli.spawns.length, 2);
  } finally {
    cli.restore();
    for (const id of ['p1', 'p2']) claudecode.endSession(id);
  }
});

test('a turn hands back the fields the conversation keeps; a session that outgrew itself keeps none, and a fresh one starts', async () => {
  const answer = { tokens: 52000 };
  const cli = fakeCli(answer);
  try {
    const conv = { id: 'r1', messages: [] };
    const run = runOf(full(quiet), conv);
    let r = await run([{ role: 'user', content: 'hi' }]);
    assert.deepStrictEqual(r.convPatch, { claudeSessionId: 's1', claudeFreshTokens: 52000, claudeTokens: 52000 });
    assert.ok(!('sessionId' in r) && !('contextTokens' in r) && !('freshTokens' in r), 'the numbers stay inside the module');
    Object.assign(conv, r.convPatch); // as turns.js stores it
    answer.tokens = 200000;
    r = await run([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'more' }]);
    assert.deepStrictEqual(r.convPatch, { claudeSessionId: null, claudeTokens: 0 }, 'rolled over: nothing to resume');
    await sleep(30);
    assert.deepStrictEqual(cli.spawns.map((s) => s.resume), [null, null], 'a fresh session is started for the next message');

    // A routine run that outgrows its session closes it without starting the next one.
    const routine = { id: 'r2', messages: [] };
    const sync = runOf(full(quiet), routine);
    answer.tokens = 40000;
    Object.assign(routine, (await sync([{ role: 'user', content: 'sync' }], { routine: true })).convPatch);
    answer.tokens = 300000;
    r = await sync([{ role: 'user', content: 'sync again' }], { routine: true });
    assert.deepStrictEqual(r.convPatch, { claudeSessionId: null, claudeTokens: 0 });
    await sleep(30);
    assert.strictEqual(cli.spawns.filter((s) => s.conv === 'r2').length, 1, 'only the run’s own');
  } finally {
    cli.restore();
    for (const id of ['r1', 'r2']) claudecode.endSession(id);
  }
});

test('a session that fails to start is retried fresh, and the caller’s conversation is left as it was', async () => {
  const cli = fakeCli({ fail: 'No conversation found with session ID: gone' });
  try {
    const conv = { id: 'e1', claudeSessionId: 'gone', messages: [] };
    const r = await runOf(full(), conv)([...kept, { role: 'user', content: 'hi' }]);
    assert.deepStrictEqual(cli.spawns.map((s) => s.resume), ['gone', null]);
    assert.strictEqual(conv.claudeSessionId, 'gone', 'never written into the caller’s copy');
    assert.strictEqual(r.convPatch.claudeSessionId, 's1', 'the new session comes back to store');
    assert.match(cli.users().at(-1).message.content, /robotics lab/, 'the fresh one gets the recent conversation');
  } finally {
    cli.restore();
    claudecode.endSession('e1');
  }
});

test('withdraw forgets the conversation’s session, its saved id included, and says what to store', async () => {
  const cli = fakeCli();
  try {
    const conv = { id: 'x1', claudeSessionId: 'held', claudeTokens: 90000 };
    assert.strictEqual(claudesession.hasSession(conv), true);
    assert.deepStrictEqual(claudesession.withdraw(conv), { claudeSessionId: null, claudeTokens: 0 });
    assert.strictEqual(conv.claudeSessionId, 'held', 'the caller stores the patch');
    await runOf(full(), conv)([{ role: 'user', content: 'x' }]); // a stale copy still names it
    assert.strictEqual(cli.spawns[0].resume, null);
    assert.strictEqual(claudesession.hasSession({ id: 'x2' }), false);
  } finally {
    cli.restore();
    claudecode.endSession('x1');
  }
});
