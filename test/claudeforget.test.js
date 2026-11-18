// Claude Code sessions when a message is run again (main/claudecode.js): a withdrawn exchange never stays
// in the context (forget: its session ids are never resumed, warm-ups read before it don't run), and a
// plan's limit that comes back as the reply is an error, not Siren's words.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

stub({
  './store': { getSettings: async () => ({}) },
  './bridge': {},
  './github': {},
  './logger': quietLog,
  './approvals': { gate: async () => ({ allow: true }), markTainted: () => {} },
});
const claudecode = load('main/claudecode.js');

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
function fakeCli() {
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
    const p = realSend.apply(this, a);
    setImmediate(() => this.onLine(result('ok')));
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
