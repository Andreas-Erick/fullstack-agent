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
