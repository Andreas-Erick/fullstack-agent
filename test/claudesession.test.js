// Claude Code sessions (main/claudecode.js): stopping a reply keeps the process warm (the CLI's interrupt
// request), its late end never ends the next turn, and a restart says what changed.
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
  const writes = [];
  sess.child = { exitCode: null, stdin: { write: (s) => writes.push(JSON.parse(s)) }, once() {}, pid: 1 };
  sess.dead = false;
  sess.spec = { idleMinutes: 20 };
  return { sess, writes };
}
const result = (text) => JSON.stringify({ type: 'result', subtype: 'success', result: text, session_id: 's1' });

test('stopping a reply interrupts the turn without killing the process', async () => {
  const { sess, writes } = session();
  const ac = new AbortController();
  const first = sess.send('long story', { emit() {}, signal: ac.signal, ctx: {} });
  ac.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.deepStrictEqual(writes.map((w) => w.type), ['user', 'control_request']);
  assert.strictEqual(writes[1].request.subtype, 'interrupt');
  assert.ok(sess.alive(), 'the process keeps running');
  assert.ok(sess.interrupting, 'the next turn waits for the interrupted one to end');

  // The interrupted turn's end arrives; it is swallowed, and the next turn gets its own answer.
  sess.onLine(result(''));
  await sess.interrupting;
  assert.strictEqual(sess.interrupting, null);
  const second = sess.send('hi', { emit() {}, signal: new AbortController().signal, ctx: {} });
  sess.onLine(result('second'));
  assert.strictEqual((await second).text, 'second');
  clearTimeout(sess.idleTimer);
});

test('an interrupt that is never confirmed releases the next turn when the process ends', async () => {
  const { sess } = session();
  const ac = new AbortController();
  const p = sess.send('x', { emit() {}, signal: ac.signal, ctx: {} });
  ac.abort();
  await assert.rejects(p);
  const waiting = sess.interrupting;
  sess.onExit(1);
  await waiting; // resolved, not hanging
  clearTimeout(sess.idleTimer);
});

test('a session restart names what changed', () => {
  const before = { config: 'a', tools: ['x', 'y'], effort: 'default' };
  assert.strictEqual(claudecode.changedParts(before, { config: 'a', tools: ['x', 'z'], effort: 'high' }), 'tools +z -y; effort');
  assert.strictEqual(claudecode.changedParts(before, before), '');
  // The config key names its fields, so a restart says which setting cost the prompt cache.
  const cfg = (o) => JSON.stringify({ name: 'Siren', personality: 'p', speaks: true, ...o });
  assert.strictEqual(claudecode.changedParts({ config: cfg() }, { config: cfg({ personality: 'q', speaks: false }) }), 'config (personality, speaks)');
  assert.strictEqual(claudecode.changedParts({ config: '["old"]' }, { config: cfg() }), 'config');
});

test('sessions leave out the repo’s CLAUDE.md and Claude Code’s own memory', () => {
  const spec = { connectors: false, builtins: ['Read', 'Grep'], allowed: ['mcp__nexus'], addDirs: ['C:/vault'], model: 'haiku', effort: 'default' };
  const args = claudecode.sessionArgs(spec, { sysFile: 's.md', mcpFile: 'm.json', settingsFile: 'set.json', resume: 'abc' });
  const value = (flag) => args[args.indexOf(flag) + 1];
  // No "project" source (the developer's CLAUDE.md, ~22k tokens) and no "local" one; the user's own
  // settings (their permission rules, extra folders) only when they want their plugins: the claude.ai
  // connectors load without them, and the plugins' skills were ~4k tokens per message.
  assert.strictEqual(value('--setting-sources'), '');
  const source = (s) => {
    const a = claudecode.sessionArgs(s, {});
    return a[a.indexOf('--setting-sources') + 1];
  };
  assert.strictEqual(source({ ...spec, connectors: true }), '', 'connectors alone: none of the user’s settings');
  assert.strictEqual(source({ ...spec, connectors: true, plugins: true }), 'user');
  assert.strictEqual(source({ ...spec, plugins: true }), '', 'plugins need connectors on');
  const s = (cc) => claudecode.sessionSpec({ settings: { claudeCode: cc, web: { enabled: false }, code: { allowSelfModify: false }, extensions: {}, perf: { mode: 'full' } }, configKey: 'k', activeTools: [], cwd: process.cwd() });
  assert.ok(!s({ connectors: true }).builtins.includes('Skill'), 'no plugin skills, no Skill tool');
  assert.ok(s({ connectors: true, plugins: true }).builtins.includes('Skill'));
  assert.notStrictEqual(s({ connectors: true }).key, s({ connectors: true, plugins: true }).key, 'switching plugins restarts the session');
  assert.strictEqual(value('--settings'), 'set.json');
  assert.strictEqual(value('--append-system-prompt-file'), 's.md');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.strictEqual(value('--add-dir'), 'C:/vault');
  assert.strictEqual(value('--resume'), 'abc');
  assert.ok(!claudecode.sessionArgs({ ...spec, connectors: true }, {}).includes('--strict-mcp-config'));
});

// Regression: the prewarm and the first message both found no live process while the prompt was
// being built, and each started one (two "claude session started" for one conversation at once).
test('two callers at once start one process for a conversation, not two', async () => {
  let spawned = 0;
  const made = [];
  const realSpawn = claudecode.Session.prototype.spawn;
  claudecode.Session.prototype.spawn = async function (spec) {
    spawned++;
    await new Promise((r) => setTimeout(r, 20));
    // Fake processes: ended before cleanup, so endSession never signals (macOS) or taskkills (Windows) a real pid.
    this.child = { exitCode: null, stdin: { write() {} }, once() {}, kill() {}, pid: -1 };
    made.push(this.child);
    this.dead = false;
    this.spec = spec;
    this.key = spec.key;
  };
  try {
    const settings = { claudeCode: {}, web: { enabled: false }, code: { allowSelfModify: false }, extensions: {}, perf: { mode: 'full' } };
    const opts = { settings, configKey: 'k', activeTools: [], cwd: process.cwd(), model: 'haiku', buildPrompt: async () => (await new Promise((r) => setTimeout(r, 20)), { stable: 'p', memIds: [] }) };
    const conv = { id: 'race-1' };
    await Promise.all([claudecode.prewarm(conv, opts), claudecode.prewarm(conv, opts)]);
    assert.strictEqual(spawned, 1);
  } finally {
    claudecode.Session.prototype.spawn = realSpawn;
    for (const c of made) c.exitCode = 0;
    claudecode.endSession('race-1');
  }
});

test('a turn reports the session’s size: the biggest single call, not the sum', async () => {
  const { sess } = session();
  const turn = sess.send('hi', { emit() {}, signal: new AbortController().signal, ctx: {} });
  const call = (read, created) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '.' }], usage: { input_tokens: 3, cache_read_input_tokens: read, cache_creation_input_tokens: created } } });
  sess.onLine(call(300000, 1000));
  sess.onLine(call(301000, 500));
  sess.onLine(result('done'));
  const r = await turn;
  assert.strictEqual(r.contextTokens, 301503);
  assert.strictEqual(claudecode.needsRollover(r.contextTokens), true);
  assert.strictEqual(claudecode.needsRollover(40000), false);
  clearTimeout(sess.idleTimer);
});

test('a session that never answered is not resumed by its id; one that answered is', async () => {
  const { sess } = session();
  sess.onLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'never-used', model: 'haiku' }));
  assert.strictEqual(sess.sessionId, 'never-used');
  assert.strictEqual(sess.resumable, null, 'nothing saved under it: resuming it failed with "No conversation found"');
  const turn = sess.send('hi', { emit() {}, signal: new AbortController().signal, ctx: {} });
  sess.onLine(result('hello'));
  await turn;
  assert.strictEqual(sess.resumable, 's1', 'after a reply the CLI has it saved');
  clearTimeout(sess.idleTimer);
});

test('rollover is measured from how big a fresh session starts in this setup', () => {
  assert.strictEqual(claudecode.needsRollover(118694, 118694), false, 'a fresh 119k session does not roll over at once');
  assert.strictEqual(claudecode.needsRollover(165000, 118694), false);
  assert.strictEqual(claudecode.needsRollover(170000, 118694), true, 'fresh size + 50k');
  assert.strictEqual(claudecode.needsRollover(394371), true, 'an old session of unknown start');
  assert.strictEqual(claudecode.needsRollover(90000), false);
});

test('a fresh session’s first turn reports its size once', async () => {
  const { sess } = session();
  const call = (n) => JSON.stringify({ type: 'assistant', message: { content: [], usage: { input_tokens: 1, cache_read_input_tokens: n, cache_creation_input_tokens: 0 } } });
  let turn = sess.send('a', { emit() {}, signal: new AbortController().signal, ctx: {} });
  sess.onLine(call(118693));
  sess.onLine(result('one'));
  assert.strictEqual((await turn).freshTokens, 118694);
  turn = sess.send('b', { emit() {}, signal: new AbortController().signal, ctx: {} });
  sess.onLine(call(121000));
  sess.onLine(result('two'));
  assert.strictEqual((await turn).freshTokens, 0, 'only the first turn');
  clearTimeout(sess.idleTimer);
});

// Each model has its own prompt cache: a warm session moved to a smaller model read ~110k tokens cold
// (3.4–7.4 s to the first word instead of ~1.8 s), and routines in the chat moved it to Opus.
test('a big warm session keeps its model; a routine never moves it; a new configuration starts fresh', async () => {
  const spawns = [];
  const writes = [];
  let sess;
  let tokens = 110000;
  const realSpawn = claudecode.Session.prototype.spawn;
  const realSend = claudecode.Session.prototype.send;
  claudecode.Session.prototype.spawn = async function (spec) {
    sess = this;
    spawns.push({ model: spec.model, resume: spec.resume || this.resumable || null });
    this.child = { exitCode: null, stdin: { write: (s) => writes.push(JSON.parse(s)) }, once() {}, kill() {}, pid: -1 };
    this.dead = false;
    this.spec = spec;
    this.key = spec.key;
    this.requestedModel = spec.model || 'default';
    this.resumed = Boolean(spec.resume);
  };
  // The fake CLI answers every message: one call of `tokens`, then the result.
  claudecode.Session.prototype.send = function (...a) {
    const p = realSend.apply(this, a);
    setImmediate(() => {
      this.onLine(JSON.stringify({ type: 'assistant', message: { model: `claude-${this.requestedModel}`, content: [], usage: { input_tokens: 1, cache_read_input_tokens: tokens - 1, cache_creation_input_tokens: 0 } } }));
      this.onLine(result('ok'));
    });
    return p;
  };
  const conv = { id: 'warm-1', claudeSessionId: 'old-session' };
  const settings = { claudeCode: {}, web: { enabled: false }, code: { allowSelfModify: false }, extensions: {}, perf: { mode: 'full' } };
  const opts = (model, extra = {}) => ({ settings, configKey: 'k', activeTools: [], cwd: process.cwd(), model, buildPrompt: async () => ({ stable: 'p', memIds: [] }), ...extra });
  const turn = (model, extra) => claudecode.runTurn({ conv, history: [{ role: 'user', content: 'hi' }], buildContext: async () => '', emit() {}, signal: new AbortController().signal, ctx: {}, ...opts(model, extra) });
  const models = () => writes.filter((w) => w.request?.subtype === 'set_model').map((w) => w.request.model);
  try {
    assert.strictEqual((await turn('sonnet')).model, 'claude-sonnet', 'the model the calls really ran on');
    await turn('haiku');
    assert.deepStrictEqual(models(), [], 'stays on the warm Sonnet instead of a cold Haiku');
    await turn('opus', { routine: true });
    assert.deepStrictEqual(models(), [], 'a routine keeps the chat’s model');
    // Opening a chat prewarms with the settings' model: a live session is left as it is.
    await claudecode.prewarm(conv, opts('default'));
    assert.deepStrictEqual(models(), []);
    await turn('opus');
    assert.deepStrictEqual(models(), ['opus'], 'deep work still moves up');

    // A persona switch changes the system prompt: nothing is cached, so the big old session is not
    // resumed; the prewarm right after starts it on the conversation's last model.
    tokens = 120000;
    await turn('opus');
    await claudecode.prewarm(conv, opts('default', { configKey: 'k2' }));
    assert.strictEqual(spawns.length, 2);
    assert.deepStrictEqual(spawns[1], { model: 'opus', resume: null });

    // A prewarm never restarts a session under a reply still being written.
    const busy = new AbortController();
    claudecode.Session.prototype.send = realSend;
    const running = claudecode.runTurn({ conv, history: [{ role: 'user', content: 'long' }], buildContext: async () => '', emit() {}, signal: busy.signal, ctx: {}, ...opts('opus', { configKey: 'k2' }) });
    await new Promise((r) => setImmediate(r));
    await claudecode.prewarm(conv, opts('default', { configKey: 'k3' }));
    assert.strictEqual(spawns.length, 2, 'not restarted mid-reply');
    sess.onLine(result('done'));
    await running;

    // Off in Settings: the pace's model, as before.
    const off = { ...settings, claudeCode: { keepModelWarm: false } };
    claudecode.Session.prototype.send = function (...a) {
      const p = realSend.apply(this, a);
      setImmediate(() => this.onLine(result('ok')));
      return p;
    };
    await turn('haiku', { configKey: 'k2', settings: off });
    assert.deepStrictEqual(models().slice(-1), ['haiku']);
  } finally {
    claudecode.Session.prototype.spawn = realSpawn;
    claudecode.Session.prototype.send = realSend;
    if (sess) sess.child.exitCode = 0;
    claudecode.endSession('warm-1');
  }
});

// Regression: after a launch or a persona switch the first message read the whole session cold
// (5.0 and 7.3 s to Haiku's first word); resuming a cold 64k session instead of a fresh ~37k one.
test('a cold session well past a fresh one starts fresh; a warm one is resumed', () => {
  const now = 1e9;
  const ttlMs = 55 * 60000;
  const f = (o) => claudecode.startFresh({ key: 'k', now, ttlMs, freshTokens: 37000, ...o });
  assert.strictEqual(f({ last: { key: 'k2', tokens: 64000, at: now - 1000 } }), 'new configuration');
  assert.strictEqual(f({ last: null, tokens: 72000 }), 'cold after a restart', 'the size the conversation saved');
  assert.strictEqual(f({ last: { key: 'k', tokens: 64000, at: now - ttlMs - 1 } }), 'cache expired');
  assert.strictEqual(f({ last: { key: 'k', tokens: 90000, at: now - 60000 } }), '', 'still cached: resumed');
  assert.strictEqual(f({ last: { key: 'k2', tokens: 45000, at: now } }), '', 'barely bigger than a fresh one: resumed');
  assert.strictEqual(f({ last: null, tokens: 0 }), '', 'size unknown: resumed');
  assert.strictEqual(claudecode.startFresh({ key: 'k', now, ttlMs, last: null, tokens: 50000 }), '', 'unmeasured fresh size: about 40k');
});

test('the cache warm-up: one tiny message on the target model, no tools, skipped while warm', async () => {
  const writes = [];
  let sess;
  const realSpawn = claudecode.Session.prototype.spawn;
  const realSend = claudecode.Session.prototype.send;
  claudecode.Session.prototype.spawn = async function (spec) {
    sess = this;
    this.child = { exitCode: null, stdin: { write: (s) => writes.push(JSON.parse(s)) }, once() {}, kill() {}, pid: -1 };
    this.dead = false;
    this.spec = spec;
    this.key = spec.key;
    this.requestedModel = spec.model || 'default';
    this.resumed = Boolean(spec.resume);
    this.sentAny = false;
  };
  claudecode.Session.prototype.send = function (...a) {
    const p = realSend.apply(this, a);
    setImmediate(() => {
      this.onLine(JSON.stringify({ type: 'assistant', message: { content: [], usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 36999 } } }));
      this.onLine(result('ok'));
    });
    return p;
  };
  const conv = { id: 'warmup-1' };
  const settings = { claudeCode: {}, web: { enabled: false }, code: { allowSelfModify: false }, extensions: {}, perf: { mode: 'full' } };
  const opts = { settings, configKey: 'k', activeTools: [], cwd: process.cwd(), model: 'default', buildPrompt: async () => ({ stable: 'p', memIds: [] }) };
  const history = [{ role: 'user', content: 'Remember the robotics lab' }, { role: 'assistant', content: 'Noted.' }];
  const users = () => writes.filter((w) => w.type === 'user');
  try {
    const r = await claudecode.warmCache(conv, opts, { model: 'haiku', effort: 'low', history });
    assert.strictEqual(r.text, 'ok');
    const set = writes.filter((w) => w.request?.subtype === 'set_model').map((w) => w.request.model);
    assert.deepStrictEqual(set, ['haiku'], 'warmed on the model the next message uses');
    const sent = users()[0].message.content;
    assert.match(sent, /warm-up/);
    assert.match(sent, /Remember the robotics lab/, 'a fresh session gets the recent conversation with it');
    assert.strictEqual(sess.warming, false);
    sess.warming = true;
    assert.strictEqual((await sess.approve({ tool_name: 'Write', input: { file_path: 'x' } })).behavior, 'deny', 'nothing runs during a warm-up');
    sess.warming = false;

    // Warm now: a second warm-up sends nothing.
    await claudecode.warmCache(conv, opts, { model: 'haiku', effort: 'low', history });
    assert.strictEqual(users().length, 1);

    // The user's message after it doesn't repeat the conversation, and reports the fresh size.
    const t = await claudecode.runTurn({ conv, history: [...history, { role: 'user', content: 'How are you?' }], buildContext: async () => '', emit() {}, signal: new AbortController().signal, ctx: {}, ...opts, model: 'haiku' });
    assert.doesNotMatch(users()[1].message.content, /robotics/);
    assert.strictEqual(t.freshTokens, 37000);
  } finally {
    claudecode.Session.prototype.spawn = realSpawn;
    claudecode.Session.prototype.send = realSend;
    if (sess) sess.child.exitCode = 0;
    claudecode.endSession('warmup-1');
  }
});

test('the warm-up guesses the next model: spoken chats the voice model, typed ones the everyday one', () => {
  stub({ './claudecode': claudecode });
  const llm = load('main/llm.js');
  const s = { llm: { provider: 'claude-code', voiceUsesFast: true, autoPace: true, modelMode: 'default' }, claudeCode: { model: 'default', fastModel: 'haiku', normalModel: 'sonnet', deepModel: 'opus' } };
  assert.deepStrictEqual(llm.warmTarget(s, [{ role: 'user', content: 'hi', spoken: true }, { role: 'assistant', content: 'hello' }]), { model: 'haiku', effort: 'low' });
  assert.deepStrictEqual(llm.warmTarget(s, [{ role: 'user', content: 'hi' }]), { model: 'sonnet', effort: 'default' });
  assert.deepStrictEqual(llm.warmTarget(s, [{ role: 'user', content: 'hi', spoken: true }, { role: 'user', content: 'Sync', routine: 'x' }]).model, 'haiku', 'a routine run is not the user talking');
  assert.strictEqual(llm.warmTarget(s, []).model, 'sonnet');
});

// Regression: every failed own tool was logged twice (tools.js with its stack, then here from the
// result), and a call the user declined was a WARN "tool failed", so error analysis counted faults
// that weren't.
test('a failed tool is logged once, and a declined one is not a fault', async () => {
  const lines = [];
  const saved = { info: quietLog.info, warn: quietLog.warn };
  quietLog.info = (event, data) => lines.push({ level: 'info', event, data });
  quietLog.warn = (event, data) => lines.push({ level: 'warn', event, data });
  const { sess } = session();
  try {
    const turn = sess.send('do things', { emit() {}, signal: new AbortController().signal, ctx: {} });
    const calls = [
      ['t1', 'mcp__nexus__calendar_add_event', '{\n "error": "\\"19:00-24:00\\" is not a time"\n}'],
      ['t2', 'mcp__nexus__persona_switch', '<tool_use_error>Error: No such tool available: mcp__nexus__persona_switch</tool_use_error>'],
      ['t3', 'mcp__nexus_more__skill_run', 'Error: This tool session has ended.'],
      ['t4', 'mcp__claude_ai_Consensus__search', 'User did not approve: declined'],
      ['t5', 'mcp__claude_ai_Consensus__search', 'Rate limit exceeded. Please wait a moment.'],
    ];
    sess.onLine(JSON.stringify({ type: 'assistant', message: { content: calls.map(([id, name]) => ({ type: 'tool_use', id, name, input: { q: 1 } })) } }));
    sess.onLine(JSON.stringify({ type: 'user', message: { content: calls.map(([id, , text]) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: [{ type: 'text', text }] })) } }));
    sess.onLine(result('done'));
    await turn;
  } finally {
    Object.assign(quietLog, saved);
    clearTimeout(sess.idleTimer);
  }
  const failures = lines.filter((l) => /^tool (failed|declined)$/.test(l.event)).map((l) => `${l.level} ${l.event} ${l.data.name}`);
  assert.deepStrictEqual(failures, [
    'warn tool failed persona_switch', // the CLI refused it: tools.js never saw the call
    'warn tool failed skill_run', // the bridge failed before tools.js
    'info tool declined mcp__claude_ai_Consensus__search',
    'warn tool failed mcp__claude_ai_Consensus__search',
  ]);
});
