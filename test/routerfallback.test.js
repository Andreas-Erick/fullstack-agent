// Multi-provider mode's fallback (main/router.js runTurn / complete), through the router's interface with
// fake per-provider runners: which provider answers, when a failure falls back (only before any tool ran),
// the retraction and notice, the cooldowns, and a stop that never falls back.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, quietLog } = require('./helpers');

stub({
  './logger': quietLog,
  './claudecode': { status: async () => ({ installed: true, loggedIn: true }) },
  './helperapps': { onUnreachable() {} },
});
const router = load('main/router.js');

const settings = (extra = {}) => ({
  llm: { provider: 'auto', baseUrl: '', modelMode: 'default' },
  anthropic: { apiKey: 'k' },
  gemini: { apiKey: 'k', model: 'gemini-x' },
  groq: { apiKey: '' },
  deepseek: { apiKey: '' },
  perplexity: { apiKey: '' },
  routing: { order: ['claude-code', 'anthropic', 'gemini'], disabled: [], smart: false, cooldownMin: 15, ...extra },
});
const rateLimit = () => Object.assign(new Error('429 Too Many Requests'), { status: 429 });

// A turn whose providers behave as `behave[id]` says: (emit) => result, or throw.
async function turn(behave, { s = settings(), signal = new AbortController().signal, task = {} } = {}) {
  const events = [];
  const tried = [];
  const run = async (concrete, emit) => {
    const id = concrete.llm.via;
    tried.push(id);
    const fn = behave[id];
    if (!fn) throw new Error(`unexpected provider ${id}`);
    return fn(emit, concrete);
  };
  let result;
  let error;
  try {
    result = await router.runTurn(s, { text: 'hello', ...task, emit: (e) => events.push(e), signal }, run);
  } catch (err) {
    error = err;
  }
  return { result, error, events, tried, notices: events.filter((e) => e.type === 'notice').map((e) => e.message) };
}

test('first provider rate-limited before any text: the second answers, the first is cooled down', async () => {
  router.reset();
  const { result, error, tried, notices, events } = await turn({
    'claude-code': () => { throw rateLimit(); },
    anthropic: (emit) => { emit({ type: 'text', delta: 'Hi' }); return { text: 'Hi', toolCalls: [] }; },
  });
  assert.ifError(error);
  assert.deepStrictEqual(tried, ['claude-code', 'anthropic']);
  assert.strictEqual(result.provider, 'anthropic', 'the provider is returned for the stored message');
  assert.strictEqual(result.text, 'Hi');
  assert.deepStrictEqual(notices, ['Claude (account) hit its rate limit (skipped for 15 min) — switching to Claude (API key).']);
  assert.ok(!events.some((e) => e.type === 'retract'), 'nothing was shown, nothing to take back');
  assert.deepStrictEqual(events.find((e) => e.type === 'text'), { type: 'text', delta: 'Hi' }, 'the answering provider streams through');
  const next = await router.plan(settings());
  assert.strictEqual(next[0].id, 'anthropic', 'the next turn skips the resting provider');
  assert.strictEqual(next.at(-1).id, 'claude-code');
});

test('the runner gets the provider\'s own settings (concrete)', async () => {
  router.reset();
  const { result } = await turn({ 'claude-code': () => { throw rateLimit(); }, anthropic: () => { throw rateLimit(); }, gemini: (_e, c) => ({ text: c.llm.model, provider: c.llm.provider }) });
  assert.strictEqual(result.text, 'gemini-x');
  assert.strictEqual(result.provider, 'gemini', 'the router id wins over the runner\'s own provider field');
});

test('a failure after a tool ran: no fallback, the error says why', async () => {
  router.reset();
  const { error, tried, notices } = await turn({
    'claude-code': (emit) => { emit({ type: 'tool_start', name: 'memory_save' }); throw rateLimit(); },
    anthropic: () => ({ text: 'should not run' }),
  });
  assert.deepStrictEqual(tried, ['claude-code'], 'no action runs twice');
  assert.match(error.message, /^Claude \(account\) hit its rate limit after it had already used tools, so this reply was not repeated on another provider \(no action should run twice\)\. Your next message goes to Claude \(API key\)\.$/);
  assert.deepStrictEqual(notices, []);
  assert.strictEqual((await router.plan(settings()))[0].id, 'anthropic', 'still cooled down');
});

test('streamed text, then a failure: the text is retracted and a notice names the switch', async () => {
  router.reset();
  const { result, events } = await turn({
    'claude-code': (emit) => {
      emit({ type: 'text', delta: 'Hello ' });
      emit({ type: 'text', delta: 'there' });
      emit({ type: 'retract', chars: 2 });
      throw Object.assign(new Error('Service overloaded'), { status: 503 });
    },
    anthropic: () => ({ text: 'Again' }),
  });
  assert.strictEqual(result.provider, 'anthropic');
  const types = events.map((e) => e.type);
  assert.deepStrictEqual(types, ['text', 'text', 'retract', 'retract', 'notice']);
  assert.deepStrictEqual(events[3], { type: 'retract', chars: 9 }, 'what is still shown (11 streamed, 2 already taken back)');
  assert.strictEqual(events[4].message, 'Claude (account) is unavailable (skipped for 2 min) — switching to Claude (API key).');
});

test('a stop mid-turn never falls back, and the provider is not benched', async () => {
  router.reset();
  const stop = new AbortController();
  const { error, tried, notices } = await turn({
    'claude-code': (emit) => { emit({ type: 'text', delta: 'Hal' }); stop.abort(); throw rateLimit(); },
    anthropic: () => ({ text: 'no' }),
  }, { signal: stop.signal });
  assert.strictEqual(error.status, 429, 'the provider\'s own error surfaces');
  assert.deepStrictEqual(tried, ['claude-code']);
  assert.deepStrictEqual(notices, []);
  assert.strictEqual((await router.plan(settings()))[0].id, 'claude-code');

  router.reset();
  const aborted = await turn({ 'claude-code': () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }, anthropic: () => ({ text: 'no' }) });
  assert.strictEqual(aborted.error.name, 'AbortError');
  assert.deepStrictEqual(aborted.tried, ['claude-code']);
});

test('every provider fails: one error naming each; an empty plan says none is ready', async () => {
  router.reset();
  const { error, tried, notices } = await turn({
    'claude-code': () => { throw rateLimit(); },
    anthropic: () => { throw Object.assign(new Error('Your credit balance is too low'), { status: 400 }); },
    gemini: () => { throw new Error('weird'); },
  });
  assert.deepStrictEqual(tried, ['claude-code', 'anthropic', 'gemini']);
  assert.strictEqual(error.message, 'No provider could answer: Claude (account) hit its rate limit; Claude (API key) is out of credits; Gemini failed (weird).');
  assert.strictEqual(notices.length, 2, 'a notice for each switch, none after the last');
  assert.match(notices[1], /is out of credits \(skipped for 60 min\)/);

  router.reset();
  const none = await turn({}, { s: settings({ disabled: Object.keys(router.PROVIDERS) }) });
  assert.match(none.error.message, /^No AI provider is ready\./);
  assert.deepStrictEqual(none.tried, []);
});

test('a picture goes to a provider that sees first; the task reaches the plan', async () => {
  router.reset();
  const s = settings({ order: ['groq', 'gemini'] });
  s.groq.apiKey = 'k';
  const answer = (emit, c) => ({ text: c.llm.via });
  const seen = await turn({ groq: answer, gemini: answer, 'claude-code': answer, anthropic: answer }, { s, task: { needsVision: true } });
  assert.strictEqual(seen.result.provider, 'gemini');
  const plain = await turn({ groq: answer, gemini: answer }, { s });
  assert.strictEqual(plain.result.provider, 'groq');
});

test('complete() falls back the same way, cooling down the failed provider', async () => {
  router.reset();
  const tried = [];
  const out = await router.complete(settings(), 'write a theme', async (c) => {
    tried.push(c.llm.via);
    if (c.llm.via === 'claude-code') throw rateLimit();
    return `from ${c.llm.via}`;
  });
  assert.strictEqual(out, 'from anthropic', 'the runner\'s output as it is');
  assert.deepStrictEqual(tried, ['claude-code', 'anthropic']);
  assert.strictEqual((await router.plan(settings()))[0].id, 'anthropic');

  router.reset();
  const last = new Error('weird last');
  await assert.rejects(router.complete(settings(), 'x', async (c) => { throw c.llm.via === 'gemini' ? last : rateLimit(); }), (err) => err === last, 'the last provider\'s error');
  await assert.rejects(router.complete(settings({ disabled: Object.keys(router.PROVIDERS) }), 'x', async () => 'no'), /No AI provider is ready/);
});
