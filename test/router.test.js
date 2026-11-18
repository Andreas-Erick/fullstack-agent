// Multi-provider mode (main/router.js): which brain answers, falling back when one is out of credits,
// rate-limited or down, and odd settings (unknown providers, everything disabled, a broken order).
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
  gemini: { apiKey: 'k' },
  groq: { apiKey: 'k' },
  deepseek: { apiKey: '' },
  perplexity: { apiKey: 'k' },
  routing: { order: ['claude-code', 'anthropic', 'gemini', 'groq', 'perplexity', 'deepseek', 'openai'], disabled: [], smart: true, cooldownMin: 15, ...extra },
});
const ids = async (s, opts) => (await router.plan(s, opts)).map((p) => p.id);

test('the user\'s order, without providers that are not set up', async () => {
  router.reset();
  assert.deepStrictEqual(await ids(settings({ smart: false })), ['claude-code', 'anthropic', 'gemini', 'groq', 'perplexity']);
});

test('odd orders: unknown ids dropped, duplicates once, missing ones appended', async () => {
  router.reset();
  const order = router.order({ routing: { order: ['gemini', 'nope', 'gemini', '__proto__', 'constructor', 7, null, 'groq'] } });
  assert.deepStrictEqual(order.slice(0, 2), ['gemini', 'groq']);
  assert.strictEqual(new Set(order).size, order.length);
  assert.ok(order.includes('claude-code') && !order.includes('nope'));
  assert.deepStrictEqual(router.order({}).length, Object.keys(router.PROVIDERS).length, 'no routing settings at all');
  assert.deepStrictEqual(router.order({ routing: { order: 'gemini' } }).length, Object.keys(router.PROVIDERS).length, 'not a list');
});

test('everything disabled: an empty plan, not a crash', async () => {
  router.reset();
  assert.deepStrictEqual(await ids(settings({ disabled: Object.keys(router.PROVIDERS) })), []);
});

test('smart routing: code to Claude, web questions to Perplexity, but personal questions stay', async () => {
  router.reset();
  assert.strictEqual((await ids(settings({ order: ['gemini', 'claude-code'] }), { text: 'fix this bug in my python script' }))[0], 'claude-code');
  assert.strictEqual((await ids(settings(), { text: 'latest news about the election' }))[0], 'perplexity');
  assert.strictEqual((await ids(settings(), { text: 'what is on my calendar today' }))[0], 'claude-code', 'today\'s calendar is personal, not a web search');
  assert.ok(!(await ids(settings(), { text: 'hi', needsTools: true })).includes('perplexity'), 'no tools: left out when tools are needed');
});

test('a rate-limited provider rests, then comes back; the next one answers meanwhile', async () => {
  router.reset();
  const s = settings({ smart: false });
  const why = router.failed(s, 'claude-code', Object.assign(new Error('429 Too Many Requests'), { status: 429 }));
  assert.strictEqual(why.kind, 'rate');
  assert.strictEqual(why.minutes, 15);
  const plan = await router.plan(s);
  assert.strictEqual(plan[0].id, 'anthropic');
  assert.strictEqual(plan.at(-1).id, 'claude-code', 'still tried last if everything else fails');
  router.succeeded('claude-code');
  assert.strictEqual((await router.plan(s))[0].id, 'claude-code');
});

test('Retry-After and Claude\'s own reset time decide how long a provider rests', () => {
  router.reset();
  const s = settings();
  assert.strictEqual(router.failed(s, 'gemini', { status: 429, message: 'slow down', headers: { 'retry-after': '120' } }).minutes, 2);
  const in3h = Math.floor(Date.now() / 1000) + 3 * 3600;
  assert.strictEqual(router.failed(s, 'claude-code', new Error(`Claude AI usage limit reached|${in3h}`)).minutes, 180);
  assert.strictEqual(router.failed(s, 'groq', { status: 429, message: 'x', headers: { 'retry-after': 'garbage' } }).minutes, 15, 'unreadable: the usual cooldown');
});

test('errors are told apart: credits, rate, auth, down, other', () => {
  const k = (e) => router.classifyError(e).kind;
  assert.strictEqual(k({ status: 402 }), 'credits');
  assert.strictEqual(k(new Error('Your credit balance is too low')), 'credits');
  assert.strictEqual(k({ status: 429 }), 'rate');
  assert.strictEqual(k(new Error('RESOURCE_EXHAUSTED')), 'rate');
  assert.strictEqual(k({ status: 401 }), 'auth');
  assert.strictEqual(k(new Error('Invalid API key provided')), 'auth');
  assert.strictEqual(k({ status: 503 }), 'down');
  assert.strictEqual(k(new Error('fetch failed')), 'down');
  assert.strictEqual(k(new Error('connect ECONNREFUSED 127.0.0.1:3001')), 'down');
  assert.strictEqual(k(new Error('Something odd')), 'other');
  for (const odd of [null, undefined, '', 42, {}]) assert.doesNotThrow(() => router.classifyError(odd));
});

test('an unknown error does not bench a provider', async () => {
  router.reset();
  const s = settings({ smart: false });
  assert.strictEqual(router.failed(s, 'claude-code', new Error('weird')).minutes, 0);
  assert.strictEqual((await router.plan(s))[0].id, 'claude-code');
});

// Regression: Claude's newer limit messages were not recognized, so multi-provider mode didn't move on.
test('Claude’s "You’ve hit your limit" is a rate limit; a spend limit is out of credits', () => {
  assert.strictEqual(router.classifyError(new Error("You've hit your session limit · resets 3pm")).kind, 'rate');
  assert.strictEqual(router.classifyError(new Error("You've hit your limit · resets 5pm (Europe/Berlin)")).kind, 'rate');
  assert.strictEqual(router.classifyError(new Error("You've hit your monthly spend limit")).kind, 'credits');
  assert.strictEqual(router.classifyError(new Error('You are out of usage credits')).kind, 'credits');
});

// A message with a picture or a long attached file (main/llm.js runTurn, main/attachments.js).
test('a picture goes to a provider that sees it; a long attachment is a long input, even spoken', async () => {
  router.reset();
  const s = settings({ order: ['groq', 'deepseek', 'gemini', 'claude-code', 'anthropic'] });
  s.deepseek.apiKey = 'k';
  const quick = await router.plan(s, { text: 'what is this?', voice: true });
  assert.strictEqual(quick[0].id, 'groq', 'a quick spoken reply');
  const seen = await router.plan(s, { text: 'what is this?', voice: true, needsVision: true });
  assert.deepStrictEqual(seen.map((p) => p.id).slice(0, 5), ['gemini', 'claude-code', 'anthropic', 'groq', 'deepseek'], 'the ones that see first, each group in its order');
  assert.strictEqual(seen[0].reason, 'can see your image');
  const already = await router.plan(settings({ smart: false }), { text: 'x', needsVision: true });
  assert.strictEqual(already[0].reason, 'your priority order', 'first choice already sees');

  assert.strictEqual(router.classifyTask('summarize this', { voice: true, attachedChars: 30000 }), 'long');
  assert.strictEqual(router.classifyTask('summarize this', { voice: true, attachedChars: 300 }), 'quick');
  s.local = { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' };
  s.routing.order = ['local', 'groq', 'gemini', 'claude-code'];
  const long = (await router.plan(s, { text: 'summarize this', voice: true, attachedChars: 30000 })).map((p) => p.id);
  assert.ok(['gemini', 'claude-code'].includes(long[0]), long.join(' > '));
  assert.ok(long.indexOf('local') > long.indexOf('gemini') && long.indexOf('groq') > long.indexOf('gemini'));
});
